import { describe, it, expect } from 'vitest';
import { squareArea, pixelWindow, M_PER_MI } from '../src/lib/geo.js';
import { decodeTerrarium, mosaic, despike, gaussianBlur } from '../src/lib/dem.js';
import { traceContours } from '../src/lib/pipeline.js';
import { buildSvg, buildGeoJson, levelId, fileStem } from '../src/lib/export.js';

describe('Terrarium decoding', () => {
  it('decodes RGB to metres', () => {
    const rgba = new Uint8Array([128, 0, 0, 255, 128, 100, 128, 255, 127, 255, 0, 255]);
    expect(Array.from(decodeTerrarium(rgba))).toEqual([0, 100.5, -1]);
  });
});

describe('mosaic', () => {
  it('stitches tiles at an arbitrary pixel offset', () => {
    const tile = (tx, ty) => Float32Array.from({ length: 65536 }, (_, i) => tx * 1000 + ty * 100 + (i % 256) / 1000);
    const grid = mosaic({ px0: 250, py0: 10, w: 12, h: 2 }, tile);
    expect(grid[0]).toBeCloseTo(0.25);
    expect(grid[5]).toBeCloseTo(0.255);
    expect(grid[6]).toBeCloseTo(1000); // next tile, column 0
    expect(grid[11]).toBeCloseTo(1000.005);
  });
});

describe('despike', () => {
  it('fixes isolated bad pixels and leaves steep real slopes alone', () => {
    const w = 20, h = 20;
    const g = Float32Array.from({ length: w * h }, (_, i) => (i % w) * 60); // 60 m per pixel slope
    const before = g.slice();
    g[5 * w + 5] = -3000; g[5 * w + 6] = -2500; g[12 * w + 12] += 900;
    expect(despike(g, w, h, 150)).toBe(3);
    expect(Math.abs(g[5 * w + 5] - before[5 * w + 5])).toBeLessThanOrEqual(60); // within one slope step
    expect(Math.abs(g[5 * w + 6] - before[5 * w + 6])).toBeLessThanOrEqual(60);
    expect(g[12 * w + 12]).toBeCloseTo(before[12 * w + 12], 0);
    const clean = before.slice();
    expect(despike(clean, w, h, 150)).toBe(0);
  });
});

describe('gaussianBlur', () => {
  it('preserves a constant field and the mean of a spike', () => {
    const flat = new Float32Array(100).fill(7);
    expect(Array.from(gaussianBlur(flat, 10, 10, 1.5)).every(v => Math.abs(v - 7) < 1e-5)).toBe(true);
    const spike = new Float32Array(441); spike[220] = 441;
    const s = gaussianBlur(spike, 21, 21, 1);
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(441, 2);
    expect(s[220]).toBeLessThan(441);
  });
});

describe('traceContours (synthetic hill in Boulder)', () => {
  const lat = 40.015, lon = -105.27;
  const area = squareArea(lat, lon, 2 * M_PER_MI);
  const win = pixelWindow(area.bbox, 14, 12);
  // A round hill centred on the point: 1600 m at the top, falling 0.5 m per pixel.
  const cx = win.w / 2, cy = win.h / 2;
  const grid = Float32Array.from({ length: win.w * win.h }, (_, i) =>
    1600 - 0.5 * Math.hypot((i % win.w) - cx, Math.floor(i / win.w) - cy));

  it('produces closed rings inside the square and clipped lines at its edge', () => {
    const { levels } = traceContours(grid, { ...win, z: 14 }, area, { interval: 10, intervalUnit: 'm' });
    expect(levels.length).toBeGreaterThan(3);
    const top = levels[levels.length - 1];
    expect(top.level).toBe(1590);
    for (const lv of levels) {
      for (const l of lv.lines) {
        for (let j = 0; j < l.length; j += 4) {
          expect(l[j]).toBeGreaterThanOrEqual(area.xmin - 1e-6);
          expect(l[j]).toBeLessThanOrEqual(area.xmax + 1e-6);
          expect(l[j + 1]).toBeGreaterThanOrEqual(area.ymin - 1e-6);
          expect(l[j + 1]).toBeLessThanOrEqual(area.ymax + 1e-6);
        }
      }
    }
    // The 1590 m ring sits 20 px from the centre: ~20 * 7.3 m ground resolution at z14.
    const ring = top.lines[0];
    expect(top.lines).toHaveLength(1);
    expect(ring.slice(0, 2)).toEqual(ring.slice(-4, -2)); // closed
    const r = Math.hypot(ring[0] - (area.xmin + area.xmax) / 2, ring[1] - (area.ymin + area.ymax) / 2);
    expect(r).toBeGreaterThan(120);
    expect(r).toBeLessThan(175);
    // Low levels run off the square and come back clipped into open lines.
    const low = levels[0].lines[0];
    expect(low.slice(0, 2)).not.toEqual(low.slice(-4, -2));
    expect(levels.find(l => l.level === 1550).index).toBe(true);
    expect(levels.find(l => l.level === 1560).index).toBe(false);
  });

  it('works in feet and rejects intervals that are too small', () => {
    const { levels } = traceContours(grid, { ...win, z: 14 }, area, { interval: 50, intervalUnit: 'ft' });
    expect(levels.every(l => l.level % 50 === 0)).toBe(true);
    expect(() => traceContours(grid, { ...win, z: 14 }, area, { interval: 0.001, intervalUnit: 'm' })).toThrow(/interval/);
  });

  it('exports SVG and GeoJSON', () => {
    const { levels } = traceContours(grid, { ...win, z: 14 }, area, { interval: 10, intervalUnit: 'm' });
    const svg = buildSvg(levels, area, { sizeIn: 10, strokePt: 1, indexBold: true, frame: true, unit: 'm', title: 't', desc: 'd & <e>' });
    expect(svg).toContain('width="10in"');
    expect(svg).toContain('viewBox="0 0 720 720"');
    expect(svg).toContain('<g id="index" stroke-width="2">');
    expect(svg).toContain('id="c_1590m"');
    expect(svg).toContain('d &amp; &lt;e&gt;');
    expect(svg).toContain('<rect id="frame"');
    const coords = [...svg.matchAll(/[ML ](-?[\d.]+),(-?[\d.]+)/g)].map(m => [+m[1], +m[2]]);
    expect(coords.length).toBeGreaterThan(100);
    expect(coords.every(([x, y]) => x >= -0.01 && x <= 720.01 && y >= -0.01 && y <= 720.01)).toBe(true);

    const gj = JSON.parse(buildGeoJson(levels, 'm'));
    expect(gj.features).toHaveLength(levels.length);
    const f = gj.features.find(x => x.properties.elevation === 1550);
    expect(f.properties).toMatchObject({ unit: 'm', elevation_m: 1550, index: true });
    expect(f.properties.elevation_ft).toBeCloseTo(5085.3, 1);
    const [lo, la] = f.geometry.coordinates[0][0];
    expect(Math.abs(lo - lon)).toBeLessThan(0.05);
    expect(Math.abs(la - lat)).toBeLessThan(0.05);
  });
});

describe('names', () => {
  it('builds ids and file names', () => {
    expect(levelId(1200, 'ft')).toBe('c_1200ft');
    expect(levelId(-50, 'm')).toBe('c_m50m');
    expect(fileStem({ lat: 40.015, lon: -105.27, size: 4, sizeUnit: 'mi', interval: 50, intervalUnit: 'ft' }))
      .toBe('contours_40.01500_-105.27000_4mi_50ft');
  });
});
