import 'leaflet/dist/leaflet.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './styles.css';
import L from 'leaflet';
import {
  squareArea, resolveZoom, groundResolution, sizeToMeters, normalizeLon, LAT_MIN, LAT_MAX
} from './lib/geo.js';
import { fileStem, buildSvg, drawContours, setPngDpi } from './lib/export.js';

const ACCENT = '#FF6700';
const MAX_TILES = 300;
const SMOOTHING = { off: 0, light: 1, medium: 2, heavy: 3.5 }; // Gaussian sigma in tile pixels
const SPLASH_KEY = 'contourgen.splash.hidden';
const MAX_PNG_PX = 16384; // largest canvas side most browsers allow
const COLOR_PRESETS = [
  ['#000000', 'Black'], ['#ffffff', 'White'], ['#9a6a3a', 'Topo brown'], ['#ff6700', 'Orange'], ['#1f4e8c', 'Blue']
];

const $ = id => document.getElementById(id);
const els = {
  search: $('search'), searchForm: $('search-form'), cpill: $('cpill'),
  size: $('area-size'), sizeUnit: $('area-unit'), est: $('area-est'),
  interval: $('interval'), intervalUnit: $('interval-unit'), skipSea: $('skip-sea'),
  stroke: $('stroke'), svgSize: $('svg-size'), indexBold: $('index-bold'), frame: $('frame'), zoom: $('zoom'),
  lineColor: $('line-color'), indexColor: $('index-color'), indexColorField: $('index-color-field'),
  pngDpi: $('png-dpi'), dlPng: $('dl-png'), pngDims: $('png-dims'),
  gen: $('gen-btn'), progress: $('progress'), progressBar: $('progress-bar'), progressMsg: $('progress-msg'),
  results: $('results'), stale: $('stale'), previewBtn: $('preview-btn'), previewImg: $('preview-img'),
  dialog: $('preview-dialog'), previewBig: $('preview-big'),
  dlSvg: $('dl-svg'), dlGeo: $('dl-geojson'), copyLink: $('copy-link'),
  foot: $('foot'), mapMsg: $('map-msg'), toasts: $('toasts')
};

const state = {
  point: null,      // { lat, lon }
  area: null,       // squareArea() for the current point and size
  zoom: null,       // resolveZoom() result
  result: null,     // last worker result
  busy: false,
  rerun: false,
  overlay: null,    // result lines as Leaflet lat/lng arrays, per level
  geoUrl: null,     // object URLs, revoked when replaced
  svgUrl: null,
  indexColorTouched: false // until the user picks an index colour, it follows the line colour
};

/* ---------------- map ---------------- */

const CARTO_KEY = (import.meta.env.VITE_CARTO_KEY ?? '').trim();
const map = L.map('map', { preferCanvas: true, worldCopyJump: true, zoomControl: true }).setView([38, -96], 4);
if (CARTO_KEY) {
  L.tileLayer(`https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png?key=${encodeURIComponent(CARTO_KEY)}`, {
    maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, &copy; <a href="https://carto.com/attributions">CARTO</a>'
  }).addTo(map);
} else {
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'osm-dark',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
}
map.attributionControl.addAttribution('Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>');
L.control.scale({ position: 'bottomright', imperial: true, metric: true }).addTo(map);

const contourLayer = L.layerGroup().addTo(map);
const squareLayer = L.polygon([], { color: ACCENT, weight: 1.5, fill: false, dashArray: '5 4', opacity: 0.6, interactive: false }).addTo(map);
const pin = L.circleMarker([0, 0], { radius: 4.5, weight: 0, fillColor: ACCENT, fillOpacity: 1, interactive: false });

map.on('click', e => setPoint(e.latlng.lat, e.latlng.lng));

/* ---------------- worker ---------------- */

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let requestId = 0;
worker.onmessage = ({ data }) => {
  if (data.id !== requestId) return;
  if (data.type === 'progress') return setProgress(data.frac, data.msg);
  state.busy = false;
  setBusy(false);
  if (data.type === 'result') showResult(data.result);
  else toast(data.message, 'error');
  if (state.rerun) {
    state.rerun = false;
    generate();
  }
};
worker.onerror = e => {
  state.busy = false;
  setBusy(false);
  toast(`Worker error: ${e.message || 'unknown'}`, 'error');
};

/* ---------------- inputs ---------------- */

const num = (el, fallback) => {
  const v = parseFloat(el.value);
  return Number.isFinite(v) && el.checkValidity() ? v : fallback;
};
const smoothing = () => document.querySelector('input[name=smoothing]:checked').value;

function params() {
  const { lat, lon } = state.point;
  const size = num(els.size, NaN), sizeUnit = els.sizeUnit.value;
  return {
    lat, lon, size, sizeUnit, sizeM: sizeToMeters(size, sizeUnit),
    z: state.zoom.z, autoZoom: state.zoom.auto,
    interval: num(els.interval, NaN), intervalUnit: els.intervalUnit.value,
    smoothing: smoothing(), sigma: SMOOTHING[smoothing()],
    skipBelowSea: els.skipSea.checked
  };
}

// Output style, shared by SVG and PNG. Changing it never needs the worker.
const style = () => ({
  sizeIn: num(els.svgSize, 10), strokePt: num(els.stroke, 1), lineColor: els.lineColor.value,
  indexBold: els.indexBold.checked, indexColor: els.indexColor.value, frame: els.frame.checked
});

// Inputs that need a new download, ones the cached grid can answer, and pure styling.
const areaInputs = [els.size, els.sizeUnit, els.zoom];
const contourInputs = [els.interval, els.intervalUnit, els.skipSea, ...document.querySelectorAll('input[name=smoothing]')];
const styleInputs = [els.stroke, els.svgSize, els.indexBold, els.frame, els.lineColor, els.indexColor, els.pngDpi];

for (const el of areaInputs) el.addEventListener('input', () => { updateArea(); markStale(); });
for (const el of contourInputs) el.addEventListener('input', () => scheduleRecompute());
for (const el of styleInputs) el.addEventListener('input', () => scheduleRestyle());
els.indexColor.addEventListener('input', () => { state.indexColorTouched = true; });
for (const el of [els.size, els.interval]) {
  el.addEventListener('keydown', e => { if (e.key === 'Enter' && !els.gen.disabled) generate(); });
}
els.gen.addEventListener('click', () => generate());

let recomputeTimer;
function scheduleRecompute() {
  if (!state.result) return;
  if (!sameArea(state.result.params)) return markStale();
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(() => generate(), 250);
}

const sameArea = p => state.point && p.lat === state.point.lat && p.lon === state.point.lon &&
  p.size === num(els.size, NaN) && p.sizeUnit === els.sizeUnit.value && p.z === state.zoom?.z;

function markStale() {
  if (!state.result) return;
  const stale = !sameArea(state.result.params);
  els.results.classList.toggle('is-stale', stale);
  els.stale.hidden = !stale;
}

/* ---------------- point + area ---------------- */

function setPoint(lat, lon, { fit = false } = {}) {
  lon = normalizeLon(lon);
  if (lat < LAT_MIN || lat > LAT_MAX) {
    toast(`Pick a point between ${-LAT_MIN}°S and ${LAT_MAX}°N (the UTM limits).`, 'error');
    return false;
  }
  state.point = { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
  els.cpill.textContent = `${state.point.lat.toFixed(5)}, ${state.point.lon.toFixed(5)}`;
  els.cpill.classList.add('on');
  els.mapMsg.hidden = true;
  pin.addTo(map).setLatLng([state.point.lat, state.point.lon]);
  updateArea();
  markStale();
  if (fit) fitArea();
  return true;
}

function updateArea() {
  if (!state.point) return;
  const size = num(els.size, NaN);
  if (!(size > 0)) {
    els.est.textContent = 'Enter a size between 0.25 and 100.';
    els.est.classList.add('warn');
    els.gen.disabled = true;
    return;
  }
  state.area = squareArea(state.point.lat, state.point.lon, sizeToMeters(size, els.sizeUnit.value));
  state.zoom = resolveZoom(state.area, size, els.sizeUnit.value, els.zoom.value, MAX_TILES);
  squareLayer.setLatLngs(state.area.outline);

  const { z, tiles, auto } = state.zoom;
  const res = groundResolution(state.point.lat, z);
  const tooMany = tiles > MAX_TILES;
  els.est.classList.toggle('warn', tooMany);
  els.est.textContent = tooMany
    ? `${tiles} tiles at z${z} is too many (max ${MAX_TILES}). Lower the zoom or the area.`
    : `z${z}${auto ? ' (auto)' : ''} · ${tiles} tile${tiles === 1 ? '' : 's'} · ~${fmtRes(res)}/px`;
  els.gen.disabled = tooMany || state.busy;
  updateFooter();
}

const fitArea = () => state.area && map.fitBounds(squareLayer.getBounds(), { padding: [40, 40], maxZoom: 15 });

/* ---------------- search ---------------- */

els.searchForm.addEventListener('submit', async e => {
  e.preventDefault();
  const q = els.search.value.trim();
  if (!q) return;
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) {
    const lat = +m[1], lon = +m[2];
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return toast('Those coordinates are out of range.', 'error');
    setPoint(lat, lon, { fit: true });
    return;
  }
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`, {
      headers: { 'Accept-Language': navigator.language || 'en' }
    });
    if (!res.ok) throw new Error(res.status);
    const [hit] = await res.json();
    if (!hit) return toast(`No place found for “${q}”.`, 'error');
    if (setPoint(+hit.lat, +hit.lon, { fit: true })) toast(hit.display_name);
  } catch {
    toast('Place search is unavailable right now. You can paste coordinates instead.', 'error');
  }
});

/* ---------------- generate ---------------- */

function generate() {
  if (!state.point || !state.zoom) return;
  const p = params();
  if (!(p.size > 0) || !(p.interval > 0)) return toast('Check the area size and contour interval.', 'error');
  if (state.zoom.tiles > MAX_TILES) return toast(els.est.textContent, 'error');
  clearTimeout(recomputeTimer);
  if (state.busy) {
    state.rerun = true;
    return;
  }
  state.busy = true;
  setBusy(true);
  setProgress(0, 'Starting…');
  worker.postMessage({ id: ++requestId, params: p });
}

function setBusy(busy) {
  els.gen.disabled = busy || !state.point || (state.zoom?.tiles ?? 0) > MAX_TILES;
  els.gen.textContent = busy ? 'Working…' : 'Generate contours';
  els.progress.hidden = !busy;
}

function setProgress(frac, msg) {
  els.progressBar.style.width = `${Math.round(frac * 100)}%`;
  if (msg) els.progressMsg.textContent = msg;
}

function showResult(r) {
  const firstForArea = !state.result || !sameAreaParams(state.result.params, r.params);
  state.result = r;
  const { stats: s, params: p } = r;

  state.overlay = r.levels.map(lv => ({
    index: lv.index,
    lines: lv.lines.map(l => {
      const ll = new Array(l.length / 4);
      for (let j = 0; j < ll.length; j++) ll[j] = [l[4 * j + 3], l[4 * j + 2]];
      return ll;
    })
  }));
  if (firstForArea) fitArea();

  // Stats
  const u = p.intervalUnit;
  $('st-levels').textContent = s.levels.toLocaleString();
  $('st-interval').textContent = `${fmtNum(p.interval)} ${u}`;
  $('st-zoom').textContent = `z${s.z}${s.zoomFellBack ? ' ↓' : ''}`;
  $('st-zoom').title = s.zoomFellBack ? `z${p.z} was unavailable here, so z${s.z} was used.` : '';
  $('st-res').textContent = `~${fmtRes(s.resolution)}/px`;
  $('st-range').textContent = `${fmtNum(Math.round(s.elevMin))} – ${fmtNum(Math.round(s.elevMax))} ${u}`;
  if (s.zoomFellBack) toast(`z${p.z} tiles were unavailable here; used z${s.z} instead.`);
  if (!s.levels) toast('No contour lines at this interval. The area may be flat; try a smaller interval.');

  // GeoJSON doesn't depend on style; SVG, preview and the map overlay are built by restyle().
  if (state.geoUrl) URL.revokeObjectURL(state.geoUrl);
  const geoBlob = new Blob([r.geojson], { type: 'application/geo+json' });
  state.geoUrl = URL.createObjectURL(geoBlob);
  Object.assign(els.dlGeo, { href: state.geoUrl, download: `${fileStem(p)}.geojson` });
  els.dlGeo.querySelector('small').textContent = fmtBytes(geoBlob.size);

  els.results.hidden = false;
  markStale();
  restyle();
}

/* ---------------- style: SVG, preview, overlay, PNG ---------------- */

// Coalesces bursts (dragging the colour picker, typing a stroke) into one rebuild.
let restyleTimer;
function scheduleRestyle() {
  clearTimeout(restyleTimer);
  restyleTimer = setTimeout(restyle, 40);
}

function restyle() {
  const s = style();
  syncStyleControls(s);
  updateFooter();
  const r = state.result;
  if (!r) return;
  const p = r.params, st = r.stats;

  const where = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
  const svg = buildSvg(r.levels, r.area, s, {
    unit: p.intervalUnit,
    title: `Contours ${where}`,
    desc: `Centre ${where}; ${p.size} ${p.sizeUnit} square; ${p.interval} ${p.intervalUnit} interval; ` +
      `WGS 84 / UTM zone ${st.zone}${st.hemisphere} (EPSG:${st.epsg}), north up; ` +
      `elevation: AWS Terrain Tiles (Terrarium) z${st.z}, ~${st.resolution.toFixed(1)} m/px.`
  });
  if (state.svgUrl) URL.revokeObjectURL(state.svgUrl);
  const svgBlob = new Blob([svg], { type: 'image/svg+xml' });
  state.svgUrl = URL.createObjectURL(svgBlob);
  Object.assign(els.dlSvg, { href: state.svgUrl, download: `${fileStem(p)}.svg` });
  els.dlSvg.querySelector('small').textContent = fmtBytes(svgBlob.size);
  els.previewImg.src = state.svgUrl;
  els.previewBig.src = state.svgUrl;
  // Light lines get a dark checkerboard so they stay visible.
  const onDark = luminance(s.lineColor) > 0.6;
  els.previewBtn.classList.toggle('on-dark', onDark);
  els.dialog.classList.toggle('on-dark', onDark);

  // The map overlay stays in the accent colour (black would vanish on the dark basemap); only
  // the index emphasis follows the style.
  contourLayer.clearLayers();
  const regular = [], index = [];
  for (const lv of state.overlay) (lv.index && s.indexBold ? index : regular).push(...lv.lines);
  if (regular.length) L.polyline(regular, { color: ACCENT, weight: 0.9, opacity: 0.65, interactive: false }).addTo(contourLayer);
  if (index.length) L.polyline(index, { color: ACCENT, weight: 1.8, opacity: 0.85, interactive: false }).addTo(contourLayer);

  writeHash(p);
}

// Swatch highlights, hex labels, the index colour row and the PNG resolution options.
function syncStyleControls(s) {
  if (!state.indexColorTouched) els.indexColor.value = s.lineColor;
  for (const input of [els.lineColor, els.indexColor]) {
    $(`${input.id}-hex`).textContent = input.value;
    for (const b of input.closest('.colors').querySelectorAll('button.sw')) {
      b.setAttribute('aria-pressed', String(b.dataset.c === input.value));
    }
  }
  els.indexColorField.hidden = !s.indexBold;
  for (const o of els.pngDpi.options) o.disabled = Math.round(s.sizeIn * +o.value) > MAX_PNG_PX;
  if (els.pngDpi.selectedOptions[0]?.disabled) {
    els.pngDpi.value = [...els.pngDpi.options].reverse().find(o => !o.disabled)?.value ?? '150';
  }
  const px = Math.round(s.sizeIn * +els.pngDpi.value);
  els.pngDims.textContent = `${px.toLocaleString()} px`;
  els.dlPng.disabled = px > MAX_PNG_PX;
}

// Preset swatches in front of each custom colour picker.
function buildColorSwatches() {
  for (const box of document.querySelectorAll('.colors')) {
    const input = $(box.dataset.for);
    const what = box.dataset.for === 'index-color' ? 'index lines' : 'lines';
    for (const [c, name] of COLOR_PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sw';
      b.dataset.c = c;
      b.style.setProperty('--c', c);
      b.title = name;
      b.setAttribute('aria-label', `${name} ${what}`);
      b.addEventListener('click', () => {
        input.value = c;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      box.insertBefore(b, box.querySelector('.sw.custom'));
    }
  }
}

els.dlPng.addEventListener('click', async () => {
  const r = state.result;
  if (!r) return;
  const s = style(), dpi = +els.pngDpi.value;
  const px = Math.round(s.sizeIn * dpi);
  if (px > MAX_PNG_PX) return toast(`A ${px.toLocaleString()} px PNG is too large. Lower the dpi or the size.`, 'error');
  els.dlPng.disabled = true;
  const label = els.pngDims.textContent;
  els.pngDims.textContent = 'rendering…';
  try {
    await new Promise(res => setTimeout(res, 30)); // let the label paint before the heavy draw
    const canvas = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(px, px)
      : Object.assign(document.createElement('canvas'), { width: px, height: px });
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2D context');
    drawContours(ctx, r.levels, r.area, s, px);
    const blob = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise(res => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('no blob');
    const png = new Blob([setPngDpi(new Uint8Array(await blob.arrayBuffer()), dpi)], { type: 'image/png' });
    saveBlob(png, `${fileStem(r.params)}_${dpi}dpi.png`);
    toast(`PNG saved: ${px.toLocaleString()} × ${px.toLocaleString()} px at ${dpi} dpi, ${fmtBytes(png.size)}.`);
  } catch {
    toast('This browser could not render a PNG that large. Try a lower dpi or a smaller size.', 'error');
  } finally {
    els.pngDims.textContent = label;
    els.dlPng.disabled = false;
  }
});

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Relative luminance of a #rrggbb colour, 0..1.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const sameAreaParams = (a, b) => a.lat === b.lat && a.lon === b.lon && a.sizeM === b.sizeM;

els.previewBtn.addEventListener('click', () => els.dialog.showModal());
els.dialog.addEventListener('click', e => { if (e.target === els.dialog) els.dialog.close(); });

els.copyLink.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied.');
  } catch {
    toast('Could not copy. The link is in the address bar.', 'error');
  }
});

/* ---------------- share links (#lat=..&lon=..) ---------------- */

function writeHash(p) {
  const q = new URLSearchParams({
    lat: p.lat, lon: p.lon, size: p.size, su: p.sizeUnit, iv: p.interval, iu: p.intervalUnit, sm: p.smoothing
  });
  if (els.zoom.value !== 'auto') q.set('z', els.zoom.value);
  if (p.skipBelowSea) q.set('sea', '1');
  const s = style();
  if (s.lineColor !== '#000000') q.set('lc', s.lineColor.slice(1));
  if (s.indexBold) q.set('idx', '1');
  if (s.indexBold && s.indexColor !== s.lineColor) q.set('ic', s.indexColor.slice(1));
  if (s.frame) q.set('frame', '1');
  if (s.strokePt !== 1) q.set('pt', s.strokePt);
  if (s.sizeIn !== 10) q.set('in', s.sizeIn);
  if (els.pngDpi.value !== '300') q.set('dpi', els.pngDpi.value);
  history.replaceState(null, '', `#${q}`);
}

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  const lat = parseFloat(q.get('lat')), lon = parseFloat(q.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const set = (el, key) => { if (q.has(key)) el.value = q.get(key); };
  set(els.size, 'size'); set(els.interval, 'iv'); set(els.stroke, 'pt'); set(els.svgSize, 'in');
  if (['mi', 'km'].includes(q.get('su'))) els.sizeUnit.value = q.get('su');
  if (['ft', 'm'].includes(q.get('iu'))) els.intervalUnit.value = q.get('iu');
  if ([...els.zoom.options].some(o => o.value === q.get('z'))) els.zoom.value = q.get('z');
  const sm = document.querySelector(`input[name=smoothing][value="${q.get('sm')}"]`);
  if (sm) sm.checked = true;
  els.skipSea.checked = q.get('sea') === '1';
  els.indexBold.checked = q.get('idx') === '1';
  els.frame.checked = q.get('frame') === '1';
  const hex = key => (/^[0-9a-f]{6}$/i.test(q.get(key) ?? '') ? `#${q.get(key).toLowerCase()}` : null);
  els.lineColor.value = hex('lc') ?? '#000000';
  state.indexColorTouched = Boolean(hex('ic'));
  els.indexColor.value = hex('ic') ?? els.lineColor.value;
  if ([...els.pngDpi.options].some(o => o.value === q.get('dpi'))) els.pngDpi.value = q.get('dpi');
  restyle();
  return setPoint(lat, lon, { fit: true });
}

/* ---------------- footer, toasts, formatting ---------------- */

function updateFooter() {
  const a = state.area;
  const crs = a ? `UTM zone ${a.zone}${a.hemisphere} (EPSG:${a.epsg})` : 'UTM zone: select a point';
  els.foot.innerHTML = `Elevation: AWS Terrain Tiles<br>${crs}<br>SVG / PNG: transparent background`;
}

function toast(msg, kind = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  els.toasts.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 9000 : 4500);
}

const fmtNum = v => v.toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtRes = m => (m < 100 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`);
const fmtBytes = b => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);

/* ---------------- splash ---------------- */

function initSplash() {
  let hidden = false;
  try { hidden = localStorage.getItem(SPLASH_KEY) === '1'; } catch {}
  if (hidden) return;
  const splash = $('splash');
  splash.hidden = false;
  $('splash-btn').focus();
  $('splash-btn').addEventListener('click', () => {
    if ($('splash-hide').checked) { try { localStorage.setItem(SPLASH_KEY, '1'); } catch {} }
    splash.classList.add('leaving');
    setTimeout(() => { splash.hidden = true; }, 300);
  });
}

/* ---------------- start ---------------- */

initSplash();
buildColorSwatches();
restyle();
if (readHash()) generate();
// A pasted share link only changes the hash, which doesn't reload the page.
window.addEventListener('hashchange', () => {
  const p = state.result?.params;
  const q = new URLSearchParams(location.hash.slice(1));
  if (p && +q.get('lat') === p.lat && +q.get('lon') === p.lon) return; // our own replaceState echo
  if (readHash()) generate();
});
