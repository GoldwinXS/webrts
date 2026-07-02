// A* pathfinding on the tile grid, 8-directional with no corner cutting.
// Integer costs only (10 straight / 14 diagonal), ties broken by node index,
// so results are deterministic. Includes a line-of-sight smoother.
import { FP, HALF, tileToFp, fpToTile } from "./fixed.js";

const DIRS = [
  [1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10],
  [1, 1, 14], [1, -1, 14], [-1, 1, 14], [-1, -1, 14],
];

// blocked: Uint8Array(w*h), nonzero = impassable.
export function findPath(blocked, w, h, sxFp, syFp, txFp, tyFp) {
  const sx = fpToTile(sxFp), sy = fpToTile(syFp);
  let tx = fpToTile(txFp), ty = fpToTile(tyFp);
  if (sx === tx && sy === ty) return [{ x: txFp, y: tyFp }];

  // If the destination tile is blocked, walk it toward the start until free.
  if (blocked[ty * w + tx]) {
    const free = nearestFree(blocked, w, h, tx, ty);
    if (!free) return null;
    tx = free.x; ty = free.y;
    txFp = tileToFp(tx); tyFp = tileToFp(ty);
  }

  const size = w * h;
  const g = new Int32Array(size).fill(0x7fffffff);
  const parent = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const start = sy * w + sx, goal = ty * w + tx;
  g[start] = 0;

  // Binary heap keyed by f = g + heuristic, tie-break by node index.
  const heap = [];
  const push = (f, n) => {
    heap.push([f, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] < heap[i][0] || (heap[p][0] === heap[i][0] && heap[p][1] <= heap[i][1])) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && (heap[l][0] < heap[m][0] || (heap[l][0] === heap[m][0] && heap[l][1] < heap[m][1]))) m = l;
        if (r < heap.length && (heap[r][0] < heap[m][0] || (heap[r][0] === heap[m][0] && heap[r][1] < heap[m][1]))) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const hOf = (n) => {
    const nx = n % w, ny = (n / w) | 0;
    const dx = Math.abs(nx - tx), dy = Math.abs(ny - ty);
    return dx > dy ? dx * 10 + dy * 4 : dy * 10 + dx * 4; // octile-ish, admissible-enough
  };

  push(hOf(start), start);
  let found = false;
  let expansions = 0;
  while (heap.length) {
    const [, n] = pop();
    if (closed[n]) continue;
    closed[n] = 1;
    if (n === goal) { found = true; break; }
    if (++expansions > 6000) break; // safety valve; grid is 48x48
    const nx = n % w, ny = (n / w) | 0;
    for (const [dx, dy, cost] of DIRS) {
      const mx = nx + dx, my = ny + dy;
      if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
      const m = my * w + mx;
      if (blocked[m] || closed[m]) continue;
      // no cutting corners diagonally past a blocked tile
      if (dx && dy && (blocked[ny * w + mx] || blocked[my * w + nx])) continue;
      const ng = g[n] + cost;
      if (ng < g[m]) {
        g[m] = ng;
        parent[m] = n;
        push(ng + hOf(m), m);
      }
    }
  }
  if (!found) return null;

  // Reconstruct tile path, then smooth with LOS skips, then convert to fp.
  const tiles = [];
  for (let n = goal; n !== -1; n = parent[n]) tiles.push(n);
  tiles.reverse();

  const pts = [];
  let anchor = 0;
  for (let i = 2; i < tiles.length; i++) {
    if (!los(blocked, w, tiles[anchor], tiles[i])) {
      pts.push(tiles[i - 1]);
      anchor = i - 1;
    }
  }
  const out = pts.map((n) => ({ x: tileToFp(n % w), y: tileToFp((n / w) | 0) }));
  out.push({ x: txFp, y: tyFp }); // exact destination
  return out;
}

// Integer-sampled line of sight between two tile indices.
function los(blocked, w, a, b) {
  const ax = tileToFp(a % w), ay = tileToFp((a / w) | 0);
  const bx = tileToFp(b % w), by = tileToFp((b / w) | 0);
  const steps = ((Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 4) / FP | 0) + 1;
  for (let i = 1; i < steps; i++) {
    const x = ax + (((bx - ax) * i / steps) | 0);
    const y = ay + (((by - ay) * i / steps) | 0);
    if (blocked[fpToTile(y) * w + fpToTile(x)]) return false;
  }
  return true;
}

export function nearestFree(blocked, w, h, tx, ty) {
  if (tx >= 0 && ty >= 0 && tx < w && ty < h && !blocked[ty * w + tx]) return { x: tx, y: ty };
  for (let r = 1; r < 10; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx, y = ty + dy;
        if (x >= 0 && y >= 0 && x < w && y < h && !blocked[y * w + x]) return { x, y };
      }
    }
  }
  return null;
}
