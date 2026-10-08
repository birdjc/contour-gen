// Elevation grid helpers: Terrarium decoding, tile mosaicking, smoothing.
import { TILE } from './geo.js';

// AWS Terrain Tiles (Mapzen Terrarium encoding) - the same source as elevatr's src = "aws".
export const terrariumUrl = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

// RGBA bytes -> elevation in metres: (R * 256 + G + B / 256) - 32768.
export function decodeTerrarium(rgba, out = new Float32Array(rgba.length / 4)) {
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = rgba[j] * 256 + rgba[j + 1] + rgba[j + 2] / 256 - 32768;
  }
  return out;
}

// Copy decoded tiles into one row-major grid covering `win`. getTile(tx, ty) returns a
// 256 x 256 Float32Array (tx is unwrapped; the caller handles the antimeridian).
export function mosaic(win, getTile) {
  const { px0, py0, w, h } = win;
  const grid = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const py = py0 + y;
    const ty = Math.floor(py / TILE), oy = py - ty * TILE;
    for (let x = 0; x < w;) {
      const px = px0 + x;
      const tx = Math.floor(px / TILE), ox = px - tx * TILE;
      const run = Math.min(TILE - ox, w - x);
      const start = oy * TILE + ox;
      grid.set(getTile(tx, ty).subarray(start, start + run), y * w + x);
      x += run;
    }
  }
  return grid;
}

// The Terrarium tiles contain scattered bad pixels (e.g. thousands of metres below their
// neighbours in Puget Sound), which would each become a stack of tiny rings. Replace any pixel
// further than `threshold` metres from the median of its 8 neighbours with that median.
// Returns the number of pixels fixed; edits the grid in place.
export function despike(grid, w, h, threshold) {
  const src = grid.slice();
  const nb = new Float32Array(8);
  let fixed = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      nb[0] = src[i - w - 1]; nb[1] = src[i - w]; nb[2] = src[i - w + 1]; nb[3] = src[i - 1];
      nb[4] = src[i + 1]; nb[5] = src[i + w - 1]; nb[6] = src[i + w]; nb[7] = src[i + w + 1];
      // Quick reject: inside the neighbours' range (padded) can't be a spike.
      let mn = nb[0], mx = nb[0];
      for (let k = 1; k < 8; k++) { if (nb[k] < mn) mn = nb[k]; if (nb[k] > mx) mx = nb[k]; }
      const v = src[i];
      if (v >= mn - threshold && v <= mx + threshold && mx - mn <= threshold) continue;
      nb.sort();
      const med = (nb[3] + nb[4]) / 2;
      if (Math.abs(v - med) > threshold) { grid[i] = med; fixed++; }
    }
  }
  return fixed;
}

// Separable Gaussian blur (edges clamped). sigma in pixels; 0 returns the input unchanged.
export function gaussianBlur(src, w, h, sigma) {
  if (!(sigma > 0)) return src;
  const r = Math.ceil(sigma * 3);
  const kernel = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += kernel[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k < 0 ? 0 : x + k >= w ? w - 1 : x + k;
        acc += src[row + xx] * kernel[k + r];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k < 0 ? 0 : y + k >= h ? h - 1 : y + k;
        acc += tmp[yy * w + x] * kernel[k + r];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

// Min / max of a rectangular part of the grid (NaN ignored).
export function gridRange(grid, w, { x0, y0, x1, y1 }) {
  let min = Infinity, max = -Infinity;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = grid[y * w + x];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { min, max };
}
