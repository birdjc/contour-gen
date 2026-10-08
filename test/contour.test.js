import { describe, it, expect } from 'vitest';
import { isolines, simplify, clipPolyline } from '../src/lib/contour.js';

const makeGrid = (w, h, f) => {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = f(x, y);
  return g;
};
const points = line => Array.from({ length: line.length / 2 }, (_, i) => [line[2 * i], line[2 * i + 1]]);

describe('isolines', () => {
  it('traces one closed ring per level around a cone', () => {
    const w = 41, h = 41;
    const g = makeGrid(w, h, (x, y) => 100 - Math.hypot(x - 20, y - 20)); // peak 100 at the centre
    const levels = isolines(g, w, h, 85, 5, 3); // 85, 90, 95 -> radii 15, 10, 5
    expect(levels.map(l => l.length)).toEqual([1, 1, 1]);
    levels.forEach((lines, k) => {
      const pts = points(lines[0]);
      expect(pts[0]).toEqual(pts[pts.length - 1]); // closed
      const radius = 15 - 5 * k;
      for (const [x, y] of pts) expect(Math.hypot(x - 20, y - 20)).toBeCloseTo(radius, 0);
    });
  });

  it('traces a single open line across a slope', () => {
    const w = 20, h = 10;
    const g = makeGrid(w, h, x => x * 10);
    const [lines] = isolines(g, w, h, 55, 10, 1);
    expect(lines).toHaveLength(1);
    const pts = points(lines[0]);
    expect(pts).toHaveLength(h);
    for (const [x] of pts) expect(x).toBeCloseTo(5.5, 9);
    const ys = pts.map(p => p[1]).sort((a, b) => a - b);
    expect(ys).toEqual(Array.from({ length: h }, (_, i) => i));
  });

  it('resolves saddles without dropping or duplicating segments', () => {
    // Two peaks joined by a saddle: the level below the saddle is one ring, above it two.
    const w = 61, h = 31;
    const g = makeGrid(w, h, (x, y) =>
      Math.max(100 - Math.hypot(x - 18, y - 15) * 4, 100 - Math.hypot(x - 42, y - 15) * 4));
    const [low, high] = isolines(g, w, h, 40, 50, 2); // saddle is at 52
    expect(low).toHaveLength(1);
    expect(high).toHaveLength(2);
    for (const line of [...low, ...high]) {
      const pts = points(line);
      expect(pts[0]).toEqual(pts[pts.length - 1]);
    }
  });

  it('skips cells with no data and levels outside the range', () => {
    const w = 10, h = 10;
    const g = makeGrid(w, h, x => (x < 5 ? NaN : x));
    const [inside, outside] = isolines(g, w, h, 7.5, 100, 2);
    expect(inside).toHaveLength(1);
    expect(outside).toHaveLength(0);
  });
});

describe('simplify', () => {
  it('collapses collinear points and keeps corners', () => {
    expect(simplify([0, 0, 1, 0, 2, 0, 3, 0], 0.1)).toEqual([0, 0, 3, 0]);
    expect(simplify([0, 0, 1, 0, 2, 0, 2, 1, 2, 2], 0.1)).toEqual([0, 0, 2, 0, 2, 2]);
  });
  it('keeps closed rings as rings', () => {
    const ring = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0];
    const s = simplify(ring, 0.1);
    expect(s.slice(0, 2)).toEqual(s.slice(-2));
    expect(s.length).toBe(10);
  });
});

describe('clipPolyline', () => {
  it('clips to the rectangle and interpolates extra values', () => {
    // stride 3: x, y, and a value that should be interpolated along
    const pieces = clipPolyline([-1, 0.5, 0, 2, 0.5, 30], 3, 0, 0, 1, 1);
    expect(pieces).toHaveLength(1);
    const p = Array.from(pieces[0]);
    expect(p[0]).toBeCloseTo(0); expect(p[2]).toBeCloseTo(10);
    expect(p[3]).toBeCloseTo(1); expect(p[5]).toBeCloseTo(20);
  });
  it('splits a line that leaves and re-enters', () => {
    const pieces = clipPolyline([0.2, 0.5, 2, 0.5, 2, 0.8, 0.2, 0.8], 2, 0, 0, 1, 1);
    expect(pieces).toHaveLength(2);
  });
  it('drops lines entirely outside', () => {
    expect(clipPolyline([2, 2, 3, 3], 2, 0, 0, 1, 1)).toHaveLength(0);
  });
  it('keeps a line entirely inside as one piece', () => {
    const pieces = clipPolyline([0.1, 0.1, 0.5, 0.5, 0.9, 0.1], 2, 0, 0, 1, 1);
    expect(Array.from(pieces[0])).toEqual([0.1, 0.1, 0.5, 0.5, 0.9, 0.1]);
  });
});
