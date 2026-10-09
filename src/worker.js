// Runs the geometry pipeline off the main thread: tile download -> grid -> smoothing -> contours
// -> GeoJSON. Keeps the last elevation grid so changing the interval or smoothing is near-instant.
import { squareArea, pixelWindow, groundResolution, FT_PER_M } from './lib/geo.js';
import { terrariumUrl, decodeTerrarium, mosaic, despike, gaussianBlur, gridRange } from './lib/dem.js';
import { traceContours } from './lib/pipeline.js';
import { buildGeoJson } from './lib/export.js';

const PAD = 16;            // extra pixels around the area so smoothing has real data at the edges
const CONCURRENCY = 8;
const TILE_CACHE_MAX = 400;
const MIN_ZOOM = 8;

class TileMissing extends Error {}

const tileCache = new Map(); // "z/x/y" -> Float32Array, insertion order = age
let dem = null;              // { keys, z, win, grid }
let smoothed = null;         // { dem, sigma, grid }

self.onmessage = async ({ data }) => {
  const { id, params } = data;
  const progress = (frac, msg) => self.postMessage({ id, type: 'progress', frac, msg });
  try {
    const result = await run(params, progress);
    const transfer = result.levels.flatMap(l => l.lines.map(a => a.buffer));
    self.postMessage({ id, type: 'result', result }, transfer);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message || String(err) });
  }
};

async function run(p, progress) {
  const area = squareArea(p.lat, p.lon, p.sizeM);
  const d = await loadDem(area, p, progress);

  if (!smoothed || smoothed.dem !== d || smoothed.sigma !== p.sigma) {
    if (p.sigma > 0) progress(0.82, 'Smoothing terrain…');
    smoothed = { dem: d, sigma: p.sigma, grid: gaussianBlur(d.grid, d.win.w, d.win.h, p.sigma) };
  }

  progress(0.86, 'Tracing contours…');
  const { levels, vertices, paths } = traceContours(smoothed.grid, d.win, area, p);

  progress(0.95, 'Writing GeoJSON…');
  const factor = p.intervalUnit === 'ft' ? FT_PER_M : 1;
  const range = gridRange(d.grid, d.win.w, d.win.inner);
  const res = groundResolution(p.lat, d.z);
  const geojson = buildGeoJson(levels, p.intervalUnit);

  // SVG and PNG are styled on the main thread from `levels` and these extents, so style changes
  // never need the worker.
  const { xmin, xmax, ymin, ymax, sizeM } = area;
  return {
    params: p,
    levels,
    area: { xmin, xmax, ymin, ymax, sizeM },
    geojson,
    stats: {
      levels: levels.length,
      paths,
      vertices,
      z: d.z,
      zoomFellBack: d.z !== p.z,
      resolution: res,
      tiles: d.win.tiles,
      elevMin: range.min * factor,
      elevMax: range.max * factor,
      zone: area.zone,
      hemisphere: area.hemisphere,
      epsg: area.epsg
    }
  };
}

const demKey = (p, z) => `${p.lat},${p.lon},${p.sizeM},${z}`;

async function loadDem(area, p, progress) {
  if (dem?.keys.includes(demKey(p, p.z))) {
    progress(0.8, 'Using cached elevation…');
    return dem;
  }
  for (let z = p.z; ; z--) {
    const win = pixelWindow(area.bbox, z, PAD);
    try {
      const tiles = await fetchTiles(win, z, (done, total) =>
        progress(0.04 + 0.72 * (done / total), `Downloading elevation tiles ${done}/${total} (z${z})…`));
      progress(0.78, 'Stitching tiles…');
      const grid = mosaic(win, (tx, ty) => tiles.get(`${tx},${ty}`));
      // Real terrain rarely jumps more than ~1 pixel-width in height between neighbours.
      despike(grid, win.w, win.h, Math.max(150, groundResolution(p.lat, z)));
      dem = { keys: [demKey(p, p.z), demKey(p, z)], z, win, grid };
      return dem;
    } catch (err) {
      if (err instanceof TileMissing && p.autoZoom && z > MIN_ZOOM) {
        progress(0.04, `z${z} unavailable here, trying z${z - 1}…`);
        continue;
      }
      if (err instanceof TileMissing) throw new Error(`Elevation tiles are not available at z${z} for this location.`);
      throw err;
    }
  }
}

async function fetchTiles(win, z, onProgress) {
  const n = 2 ** z;
  const jobs = [];
  for (let ty = win.ty0; ty <= win.ty1; ty++) {
    for (let tx = win.tx0; tx <= win.tx1; tx++) jobs.push([tx, ty]);
  }
  const out = new Map();
  let next = 0, done = 0;
  onProgress(0, jobs.length);
  const workerLoop = async () => {
    while (next < jobs.length) {
      const [tx, ty] = jobs[next++];
      out.set(`${tx},${ty}`, await getTile(z, ((tx % n) + n) % n, ty));
      onProgress(++done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, workerLoop));
  return out;
}

const canvas = new OffscreenCanvas(256, 256);
const ctx = canvas.getContext('2d', { willReadFrequently: true });

async function getTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) {
    tileCache.delete(key); // refresh its age
    tileCache.set(key, cached);
    return cached;
  }
  let res;
  try {
    res = await fetch(terrariumUrl(z, x, y));
  } catch {
    throw new Error('Could not reach the elevation tile server. Check your connection and try again.');
  }
  // S3 answers 403 for keys that don't exist.
  if (res.status === 404 || res.status === 403) throw new TileMissing(key);
  if (!res.ok) throw new Error(`Elevation tile server returned ${res.status}.`);
  // No colour management or premultiplication: the RGB bytes are data, not colour.
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  ctx.clearRect(0, 0, 256, 256);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const tile = decodeTerrarium(ctx.getImageData(0, 0, 256, 256).data);
  tileCache.set(key, tile);
  if (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  return tile;
}
