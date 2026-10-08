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

// Black lines on a transparent background, sized in inches, coordinates in points. Lines are
// projected in UTM, so the square is true to scale and north is up (grid north).
// o: { sizeIn, strokePt, indexBold, frame, unit, title, desc }
export function buildSvg(levels, area, o) {
  const pt = o.sizeIn * 72;
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
  const pathEl = lv => `    <path id="${levelId(lv.level, o.unit)}" d="${path(lv.lines)}"/>`;
  const group = (id, list, width) => list.length
    ? `  <g id="${id}" stroke-width="${width}">\n${list.map(pathEl).join('\n')}\n  </g>`
    : '';

  const body = o.indexBold
    ? [group('intermediate', levels.filter(l => !l.index), o.strokePt),
       group('index', levels.filter(l => l.index), r2(o.strokePt * 2))].filter(Boolean).join('\n')
    : group('contours', levels, o.strokePt);
  const frame = o.frame
    ? `\n  <rect id="frame" x="0" y="0" width="${pt}" height="${pt}" stroke-width="${o.strokePt}"/>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${o.sizeIn}in" height="${o.sizeIn}in" viewBox="0 0 ${pt} ${pt}">
  <title>${esc(o.title)}</title>
  <desc>${esc(o.desc)}</desc>
<g fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round">
${body}${frame}
</g>
</svg>
`;
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
