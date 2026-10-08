// Elevation grid -> contour lines in UTM (clipped to the square) with lat/lon alongside.
import { FT_PER_M, TILE, worldXToLon, worldYToLat } from './geo.js';
import { isolines, simplify, clipPolyline } from './contour.js';

export const MAX_LEVELS = 3000;
const SIMPLIFY_PX = 0.2; // grid pixels; well below what the 1 pt output stroke can show
export const INDEX_EVERY = 5;

// grid: elevations in metres over `win` (a pixelWindow at zoom z). area: squareArea().
// o: { interval, intervalUnit: 'ft' | 'm', skipBelowSea }.
// Returns { levels: [{ level, index, lines }], ... } where each line is a Float64Array of
// [easting, northing, lon, lat] per vertex and `level` is in the interval's unit.
export function traceContours(grid, win, area, o) {
  const { w, h, px0, py0, z } = win;
  const factor = o.intervalUnit === 'ft' ? FT_PER_M : 1;
  const ivl = o.interval;

  let min = Infinity, max = -Infinity;
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!(max >= min)) throw new Error('No elevation data in this area.');

  const k0 = Math.floor((min * factor) / ivl), k1 = Math.ceil((max * factor) / ivl);
  const count = k1 - k0 + 1;
  if (count > MAX_LEVELS) {
    throw new Error(`That interval gives ${count.toLocaleString()} contour levels here. Try a larger interval.`);
  }
  const raw = isolines(grid, w, h, (k0 * ivl) / factor, ivl / factor, count);

  const n = TILE * 2 ** z;
  const { conv, xmin, ymin, xmax, ymax } = area;
  const levels = [];
  let vertices = 0, paths = 0;
  for (let k = 0; k < count; k++) {
    if (!raw[k].length) continue;
    const kk = k0 + k;
    const level = Math.round(kk * ivl * 1e6) / 1e6;
    if (o.skipBelowSea && level < 0) continue;
    const lines = [];
    for (const line of raw[k]) {
      const s = simplify(line, SIMPLIFY_PX);
      const m = s.length / 2;
      const pts = new Float64Array(m * 4);
      for (let j = 0; j < m; j++) {
        // Samples are tile pixel centres.
        const lon = worldXToLon((px0 + s[2 * j] + 0.5) / n);
        const lat = worldYToLat((py0 + s[2 * j + 1] + 0.5) / n);
        const [e, nn] = conv.forward([lon, lat]);
        pts[4 * j] = e; pts[4 * j + 1] = nn; pts[4 * j + 2] = lon; pts[4 * j + 3] = lat;
      }
      for (const piece of clipPolyline(pts, 4, xmin, ymin, xmax, ymax)) {
        lines.push(piece);
        vertices += piece.length / 4;
      }
    }
    if (!lines.length) continue;
    paths += lines.length;
    levels.push({ level, index: kk % INDEX_EVERY === 0, lines });
  }
  return { levels, vertices, paths };
}
