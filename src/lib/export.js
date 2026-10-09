// SVG and GeoJSON writers.

const r2 = v => Math.round(v * 100) / 100;
const r6 = v => Math.round(v * 1e6) / 1e6;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// "contours_40.01500_-105.27050_4mi_50ft"
export const fileStem = p =>
  `contours_${p.lat.toFixed(5)}_${p.lon.toFixed(5)}_${p.size}${p.sizeUnit}_${p.interval}${p.intervalUnit}`;

// SVG id for a level: ids can't start with a digit, and "-" is ambiguous, so 1200 -> c_1200ft,
// -50 -> c_m50ft.
export const levelId = (level, unit) => `c_${level < 0 ? 'm' : ''}${Math.abs(level)}${unit}`;

// Style shared by the SVG and PNG exports.
// { sizeIn, strokePt, lineColor, indexBold, indexColor, frame }
// With indexBold, every 5th level is drawn at twice the stroke in indexColor.
export const INDEX_WEIGHT = 2;

// The groups both exports draw, in paint order: [{ id, levels, width (pt), color }].
export function styleGroups(levels, s) {
  if (!s.indexBold) return [{ id: 'contours', levels, width: s.strokePt, color: s.lineColor }];
  return [
    { id: 'intermediate', levels: levels.filter(l => !l.index), width: s.strokePt, color: s.lineColor },
    { id: 'index', levels: levels.filter(l => l.index), width: r2(s.strokePt * INDEX_WEIGHT), color: s.indexColor }
  ].filter(g => g.levels.length);
}

// Lines on a transparent background, sized in inches, coordinates in points. Lines are
// projected in UTM, so the square is true to scale and north is up (grid north).
// area: { xmin, ymax, sizeM }. s: style (above). meta: { unit, title, desc }.
export function buildSvg(levels, area, s, meta) {
  const pt = s.sizeIn * 72;
  const scale = pt / area.sizeM;
  const path = lines => {
    let d = '';
    for (const l of lines) {
      for (let j = 0; j < l.length; j += 4) {
        d += `${j === 0 ? 'M' : j === 4 ? 'L' : ' '}${r2((l[j] - area.xmin) * scale)},${r2((area.ymax - l[j + 1]) * scale)}`;
      }
    }
    return d;
  };
  const pathEl = lv => `    <path id="${levelId(lv.level, meta.unit)}" d="${path(lv.lines)}"/>`;
  const body = styleGroups(levels, s)
    .map(g => `  <g id="${g.id}" stroke="${esc(g.color)}" stroke-width="${g.width}">\n${g.levels.map(pathEl).join('\n')}\n  </g>`)
    .join('\n');
  // The frame is inset by half a stroke so its full width stays inside the page.
  const h = s.strokePt / 2;
  const frame = s.frame
    ? `\n  <rect id="frame" x="${r2(h)}" y="${r2(h)}" width="${r2(pt - 2 * h)}" height="${r2(pt - 2 * h)}" stroke="${esc(s.lineColor)}" stroke-width="${s.strokePt}"/>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${s.sizeIn}in" height="${s.sizeIn}in" viewBox="0 0 ${pt} ${pt}">
  <title>${esc(meta.title)}</title>
  <desc>${esc(meta.desc)}</desc>
<g fill="none" stroke-linecap="round" stroke-linejoin="round">
${body}${frame}
</g>
</svg>
`;
}

// Draw the same picture onto a 2D canvas context of `px` x `px` pixels (left transparent).
export function drawContours(ctx, levels, area, s, px) {
  const scale = px / area.sizeM;
  const pxPerPt = px / (s.sizeIn * 72);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const g of styleGroups(levels, s)) {
    ctx.strokeStyle = g.color;
    ctx.lineWidth = g.width * pxPerPt;
    ctx.beginPath();
    for (const lv of g.levels) {
      for (const l of lv.lines) {
        ctx.moveTo((l[0] - area.xmin) * scale, (area.ymax - l[1]) * scale);
        for (let j = 4; j < l.length; j += 4) ctx.lineTo((l[j] - area.xmin) * scale, (area.ymax - l[j + 1]) * scale);
      }
    }
    ctx.stroke();
  }
  if (s.frame) {
    const w = s.strokePt * pxPerPt; // inset by half a stroke, as in the SVG
    ctx.strokeStyle = s.lineColor;
    ctx.lineWidth = w;
    ctx.strokeRect(w / 2, w / 2, px - w, px - w);
  }
}

// Write the resolution into a PNG (pHYs chunk) so print and layout apps open it at the right
// physical size. Replaces an existing pHYs chunk, otherwise inserts one after IHDR.
export function setPngDpi(png, dpi) {
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  view.setUint32(8, ppm);
  view.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  view.setUint32(17, crc32(chunk.subarray(4, 17)));

  const src = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let o = 8; o + 8 <= png.length;) {
    const len = src.getUint32(o);
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    if (type === 'pHYs' || type === 'IDAT' || type === 'IEND') {
      const skip = type === 'pHYs' ? len + 12 : 0;
      const out = new Uint8Array(png.length - skip + 21);
      out.set(png.subarray(0, o));
      out.set(chunk, o);
      out.set(png.subarray(o + skip), o + 21);
      return out;
    }
    o += len + 12;
  }
  return png;
}

let crcTable;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// One MultiLineString feature per level, WGS 84 lon/lat.
export function buildGeoJson(levels, unit) {
  const toFt = unit === 'ft' ? 1 : 3.28084, toM = unit === 'm' ? 1 : 1 / 3.28084;
  const features = levels.map(lv => ({
    type: 'Feature',
    properties: {
      elevation: lv.level,
      unit,
      elevation_ft: Math.round(lv.level * toFt * 100) / 100,
      elevation_m: Math.round(lv.level * toM * 100) / 100,
      index: lv.index
    },
    geometry: {
      type: 'MultiLineString',
      coordinates: lv.lines.map(l => {
        const c = [];
        for (let j = 0; j < l.length; j += 4) c.push([r6(l[j + 2]), r6(l[j + 3])]);
        return c;
      })
    }
  }));
  return JSON.stringify({ type: 'FeatureCollection', features });
}
