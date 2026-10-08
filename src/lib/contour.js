// Marching-squares isolines, Douglas-Peucker simplification and rectangle clipping.
// Polylines are flat number arrays: [x0, y0, x1, y1, ...] (or `stride` values per vertex).

// Isolines of a row-major grid for the uniform levels base + k * step, k = 0 .. count - 1.
// Returns one array of polylines per level, in grid coordinates (x = column, y = row; samples sit
// on integer coordinates). Closed rings repeat their first vertex at the end. Cells touching a NaN
// are skipped.
export function isolines(grid, w, h, base, step, count) {
  // Each segment joins two cell edges. Edge ids: 2 * i is the horizontal edge from sample i to
  // i + 1, 2 * i + 1 the vertical edge from i to i + w. Neighbouring cells share edge ids, which is
  // what lets segments be stitched into lines afterwards.
  const segs = Array.from({ length: count }, () => []);
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      const tl = grid[i], tr = grid[i + 1], bl = grid[i + w], br = grid[i + w + 1];
      const mn = Math.min(tl, tr, bl, br), mx = Math.max(tl, tr, bl, br);
      if (!(mx > mn)) continue; // flat or NaN
      const k0 = Math.max(0, Math.ceil((mn - base) / step) - 1);
      const k1 = Math.min(count - 1, Math.floor((mx - base) / step) + 1);
      const T = 2 * i, B = 2 * (i + w), Lf = 2 * i + 1, R = 2 * (i + 1) + 1;
      for (let k = k0; k <= k1; k++) {
        const L = base + k * step;
        if (L < mn || L >= mx) continue;
        const s = segs[k];
        switch ((tl > L ? 8 : 0) | (tr > L ? 4 : 0) | (br > L ? 2 : 0) | (bl > L ? 1 : 0)) {
          case 1: case 14: s.push(Lf, B); break;
          case 2: case 13: s.push(B, R); break;
          case 3: case 12: s.push(Lf, R); break;
          case 4: case 11: s.push(T, R); break;
          case 6: case 9: s.push(T, B); break;
          case 7: case 8: s.push(Lf, T); break;
          case 5: // tr + bl above: saddle, resolved by the cell centre
            if ((tl + tr + bl + br) / 4 > L) s.push(Lf, T, B, R);
            else s.push(Lf, B, T, R);
            break;
          case 10: // tl + br above
            if ((tl + tr + bl + br) / 4 > L) s.push(T, R, Lf, B);
            else s.push(Lf, T, B, R);
            break;
        }
      }
    }
  }
  return segs.map((s, k) => stitch(s, grid, w, base + k * step));
}

// Chain segments (pairs of edge ids) that share edges into polylines.
function stitch(segs, grid, w, level) {
  const n = segs.length / 2;
  if (!n) return [];
  // Each edge belongs to at most two segments (one per adjacent cell).
  const first = new Map(), second = new Map();
  for (let s = 0; s < n; s++) {
    for (const e of [segs[2 * s], segs[2 * s + 1]]) {
      if (first.has(e)) second.set(e, s);
      else first.set(e, s);
    }
  }
  const neighbour = (edge, from) => {
    const a = first.get(edge);
    return a !== from ? a : second.get(edge);
  };
  const otherEnd = (s, edge) => (segs[2 * s] === edge ? segs[2 * s + 1] : segs[2 * s]);

  const used = new Uint8Array(n);
  const lines = [];
  for (let s = 0; s < n; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const fwd = [segs[2 * s], segs[2 * s + 1]];
    const back = [];
    for (const [list, startEdge] of [[fwd, segs[2 * s + 1]], [back, segs[2 * s]]]) {
      let edge = startEdge, seg = s;
      for (;;) {
        const next = neighbour(edge, seg);
        // A ring ends when the walk reaches the start segment again; its first edge was already
        // pushed as the last segment's far end, so the line closes on itself.
        if (next === undefined || used[next]) break;
        used[next] = 1;
        edge = otherEnd(next, edge);
        seg = next;
        list.push(edge);
      }
    }
    const edges = back.reverse().concat(fwd);
    const pts = new Array(edges.length * 2);
    for (let j = 0; j < edges.length; j++) edgePoint(grid, w, edges[j], level, pts, 2 * j);
    lines.push(pts);
  }
  return lines;
}

// Interpolated crossing point of `level` on an edge.
function edgePoint(grid, w, id, level, out, o) {
  const i = Math.floor(id / 2);
  const x = i % w, y = (i - x) / w;
  const vertical = id % 2 === 1;
  const a = grid[i], b = vertical ? grid[i + w] : grid[i + 1];
  const t = (level - a) / (b - a);
  out[o] = vertical ? x : x + t;
  out[o + 1] = vertical ? y + t : y;
}

// Douglas-Peucker on a flat [x, y, ...] polyline. Endpoints are always kept.
export function simplify(pts, tolerance) {
  const n = pts.length / 2;
  if (n <= 2 || !(tolerance > 0)) return pts;
  const tol2 = tolerance * tolerance;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    const ax = pts[2 * a], ay = pts[2 * a + 1];
    const dx = pts[2 * b] - ax, dy = pts[2 * b + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      let px = pts[2 * i] - ax, py = pts[2 * i + 1] - ay;
      if (len2 > 0) {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        px -= t * dx;
        py -= t * dy;
      }
      const d = px * px + py * py;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2) {
      keep[idx] = 1;
      stack.push(a, idx, idx, b);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}

// Clip a polyline to the rectangle [x0, x1] x [y0, y1] (Liang-Barsky per segment). The first two
// values of each vertex are the clip coordinates; the rest are interpolated along. Returns the
// pieces that lie inside, as Float64Arrays.
export function clipPolyline(p, stride, x0, y0, x1, y1) {
  const n = p.length / stride;
  const pieces = [];
  let cur = null;
  const finish = () => {
    if (cur && cur.length >= 2 * stride) pieces.push(Float64Array.from(cur));
    cur = null;
  };
  const emit = (a, b, t) => {
    // Unclipped vertices are copied exactly so rings still close bit-for-bit.
    if (t === 0 || t === 1) for (let c = 0; c < stride; c++) cur.push(p[(t ? b : a) + c]);
    else for (let c = 0; c < stride; c++) cur.push(p[a + c] + (p[b + c] - p[a + c]) * t);
  };
  for (let i = 0; i < n - 1; i++) {
    const a = i * stride, b = a + stride;
    const ax = p[a], ay = p[a + 1], dx = p[b] - ax, dy = p[b + 1] - ay;
    let t0 = 0, t1 = 1, inside = true;
    const edge = (q, r) => {
      if (q === 0) { if (r < 0) inside = false; return; }
      const t = r / q;
      if (q < 0) { if (t > t1) inside = false; else if (t > t0) t0 = t; }
      else { if (t < t0) inside = false; else if (t < t1) t1 = t; }
    };
    edge(-dx, ax - x0);
    if (inside) edge(dx, x1 - ax);
    if (inside) edge(-dy, ay - y0);
    if (inside) edge(dy, y1 - ay);
    if (!inside || t1 <= t0) { finish(); continue; }
    if (cur && t0 > 1e-12) finish();
    if (!cur) { cur = []; emit(a, b, t0); }
    emit(a, b, t1);
    if (t1 < 1) finish();
  }
  finish();
  return pieces;
}
