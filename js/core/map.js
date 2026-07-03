// Deterministic procedural map generation. Rotationally symmetric (180deg)
// so both players face an identical, balanced battlefield. Produces the
// passability grid, terrain height field, spawn layout (starts + minerals),
// visual theme, and non-blocking decorations.
//
// INTEGER-ONLY. Everything that lands in rock/height/starts/minerals is driven
// exclusively by makeRng(seed). Two calls with the same seed are byte-identical
// (both multiplayer clients generate the map independently from a shared seed).
import { makeRng, tileToFp } from "./fixed.js";
import { MAP_W, MAP_H } from "./data.js";

// Visual themes. Shared with the renderer (palette, decoration tint, fog tint).
// Colors are plain integers (0xRRGGBB); the renderer owns their interpretation.
export const THEMES = [
  {
    name: "verdant",
    ground: [40, 68, 42], groundHi: [58, 90, 58], patch: [18, 13, 0],
    rock: 0x555e6b, cliff: 0x3a4048, cliffTop: [70, 78, 66],
    fog: 0x070a10, sky: 0x070a10,
    deco: [0x74d68a, 0x9fe6b0, 0x4f9e63], // flora greens
  },
  {
    name: "ashen",
    ground: [58, 44, 34], groundHi: [86, 62, 40], patch: [30, 10, 0],
    rock: 0x5c4a3a, cliff: 0x40342a, cliffTop: [92, 66, 44],
    fog: 0x140b08, sky: 0x140b08,
    deco: [0xff8a3c, 0xffb066, 0xd15a24], // embers / hot rock
  },
  {
    name: "frozen",
    ground: [58, 74, 92], groundHi: [92, 112, 132], patch: [10, 18, 30],
    rock: 0x6a7686, cliff: 0x4a5666, cliffTop: [120, 140, 160],
    fog: 0x0a1018, sky: 0x0a1018,
    deco: [0x9fd8ff, 0xcaeaff, 0x6fa8d8], // ice shards
  },
];

// Decoration kinds (renderer maps these to primitive-geometry props):
// 0 = crystal shard cluster, 1 = small rock pile, 2 = glowing flora tuft.

export function generateMap(seed) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const s = (seed + attempt * 1000003) | 0;
    const map = buildCandidate(s);
    if (validate(map)) {
      map.theme = ((seed >>> 0) % THEMES.length);   // theme fixed by base seed
      map.themeName = THEMES[map.theme].name;
      return map;
    }
  }
  // Never fail to start a match: hand back a known-good simple layout.
  const fb = fallbackMap();
  fb.theme = ((seed >>> 0) % THEMES.length);
  fb.themeName = THEMES[fb.theme].name;
  return fb;
}

// ---------------------------------------------------------------------------
// Candidate construction
// ---------------------------------------------------------------------------

function buildCandidate(seed) {
  const rng = makeRng(seed);
  const W = MAP_W, H = MAP_H;
  const rock = new Uint8Array(W * H);
  const height = new Uint8Array(W * H);
  const decos = [];

  const idx = (x, y) => y * W + x;
  const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  // 180-degree rotational partner of a tile.
  const mx = (x) => W - 1 - x;
  const my = (y) => H - 1 - y;

  // Symmetric writers: set a tile and its rotational partner together so the
  // whole map is guaranteed balanced by construction.
  const setRock = (x, y, v) => {
    if (!inb(x, y)) return;
    rock[idx(x, y)] = v;
    rock[idx(mx(x), my(y))] = v;
  };
  const setHeight = (x, y, v) => {
    if (!inb(x, y)) return;
    height[idx(x, y)] = v;
    height[idx(mx(x), my(y))] = v;
  };
  const addDeco = (x, y, kind) => {
    if (!inb(x, y)) return;
    decos.push({ x, y, kind });
    decos.push({ x: mx(x), y: my(y), kind });
  };

  // ---- seed-driven layout choices ------------------------------------------
  // Corner pair: 0 = NW/SE, 1 = NE/SW. Determines player-0 start corner.
  const cornerNE = (rng() & 1) === 1;
  const margin = 8;                                   // start inset from edge
  const start0 = cornerNE
    ? { x: W - 1 - margin, y: margin }                // NE
    : { x: margin, y: margin };                       // NW
  const start1 = { x: mx(start0.x), y: my(start0.y) }; // rotational partner
  const starts = [start0, start1];

  // Direction from a main toward map center (for placing ramps / expansions).
  const toCenter = (s) => ({
    dx: Math.sign((W >> 1) - s.x),
    dy: Math.sign((H >> 1) - s.y),
  });

  // ---- 1. main plateau + cliff ring + single ramp --------------------------
  // Raise a square plateau around the start to height 1, wrap it in a cliff
  // (blocked) ring, then carve exactly one ramp opening toward center.
  const plateauR = 4;                                 // plateau half-extent
  const mainHeight = 1 + (rng() & 1) * 1;             // main at level 1 or 2
  raisePlateau(start0, plateauR, mainHeight);

  // Ramp: 3-wide opening on the center-facing side of the plateau.
  const c0 = toCenter(start0);
  const rampMain = carveRamp(start0, plateauR, c0, 3, mainHeight);

  // ---- 2. natural expansion (just outside the main ramp) -------------------
  // Sits one plateau-width down the ramp lane, at lowland height, ringed on
  // three sides with a WIDER (4-5 tile) opening — partially defensible.
  const natWidth = 4 + (rng() & 1);                   // 4 or 5 wide opening
  const nat0 = {
    x: clampTile(start0.x + c0.dx * (plateauR + 5), W),
    y: clampTile(start0.y + c0.dy * (plateauR + 5), H),
  };
  ringExpansion(nat0, 3, c0, natWidth);

  // ---- 3. additional expansions (open territory) ---------------------------
  // 1 or 2 more mirrored pairs, marching further toward mid-map. Barely
  // defensible: just cleared ground with a mineral cluster and light scatter.
  const extraPairs = 1 + (rng() & 1);                 // 1 or 2 extra pairs
  const expansions = [nat0];
  for (let e = 0; e < extraPairs; e++) {
    const reach = plateauR + 12 + e * 8 + (rng() % 4);
    // fan the extra expansions off the straight center lane so they occupy
    // distinct territory rather than stacking on the diagonal
    const perp = perpOffset(c0, (e & 1) ? 6 : -6, rng);
    const ex = {
      x: clampTile(start0.x + c0.dx * reach + perp.x, W),
      y: clampTile(start0.y + c0.dy * reach + perp.y, H),
    };
    clearArea3(ex, 3);
    expansions.push(ex);
  }

  // ---- 4. center terrain feature -------------------------------------------
  // Seed picks the mid-map character: open, a cliff ridge with gaps, or a
  // decorative unwalkable level-2 mesa pair.
  const centerKind = rng() % 3;
  if (centerKind === 1) carveCenterRidge(rng);
  else if (centerKind === 2) raiseCenterMesas(rng);

  // ---- 5. rock scatter ------------------------------------------------------
  // Blobs in one half, mirrored. Kept clear of starts, expansions and the
  // main connecting lane by the clearing passes below.
  const blobs = 6 + (rng() % 6);
  for (let i = 0; i < blobs; i++) {
    const bx = 4 + (rng() % (W - 8));
    const by = 4 + (rng() % ((H >> 1) - 4));
    const size = 2 + (rng() % 3);
    for (let j = 0; j < size * 3; j++) {
      const x = bx + (rng() % (size * 2)) - size;
      const y = by + (rng() % (size * 2)) - size;
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
      // never scatter rock onto a plateau/cliff we placed deliberately
      if (height[idx(x, y)] !== 0) continue;
      setRock(x, y, 1);
    }
  }

  // ---- 6. guarantee connectivity: clear the main lane ----------------------
  // A soft corridor between the two naturals keeps the map traversable even
  // when scatter is dense; ramps already connect mains to naturals.
  clearLane(nat0, { x: mx(nat0.x), y: my(nat0.y) }, 2);

  // Re-clear the immediate build areas (scatter/lane may have intruded).
  clearArea3(start0, plateauR - 1);                   // interior of the main
  for (const ex of expansions) clearArea3(ex, 3);
  // keep the ramp tiles open
  for (const t of rampMain) setRock(t.x, t.y, 0);

  // ---- 7. minerals ----------------------------------------------------------
  // Main: 7 patches arced BEHIND the start (away from center). Natural &
  // extras: 5-patch clusters. All placed symmetrically, on clear tiles.
  const minerals = [];
  const pushPatch = (tx, ty) => {
    if (!inb(tx, ty)) return;
    setRock(tx, ty, 0);
    minerals.push({ x: tileToFp(tx), y: tileToFp(ty) });
    minerals.push({ x: tileToFp(mx(tx)), y: tileToFp(my(ty)) });
  };
  // arc behind main: opposite the center direction
  const bx = -c0.dx, by = -c0.dy;                     // "behind" unit vector
  const mainArc = arcOffsets(bx, by, 7);
  for (const [ox, oy] of mainArc) pushPatch(start0.x + ox, start0.y + oy);

  for (const ex of expansions) {
    const dir = { dx: Math.sign((W >> 1) - ex.x) || 1, dy: Math.sign((H >> 1) - ex.y) || 1 };
    const cluster = arcOffsets(-dir.dx, -dir.dy, 5);
    for (const [ox, oy] of cluster) pushPatch(ex.x + ox, ex.y + oy);
  }

  // ---- 8. decorations (non-blocking, sparse near bases/lanes) --------------
  scatterDecos(rng, addDeco, rock, height, W, H, starts, expansions);

  return {
    w: W, h: H, rock, height, starts, minerals, decos,
    ramps: [{ tiles: rampMain }],
    // theme filled in by generateMap()
  };

  // ---- local terrain-shaping helpers (close over rock/height writers) ------

  function raisePlateau(s, r, lvl) {
    // plateau top at `lvl`, ringed by a one-tile cliff (blocked). The cliff
    // ring sits just outside the top so units on top have room.
    for (let y = s.y - r; y <= s.y + r; y++)
      for (let x = s.x - r; x <= s.x + r; x++) setHeight(x, y, lvl);
    for (let y = s.y - r - 1; y <= s.y + r + 1; y++)
      for (let x = s.x - r - 1; x <= s.x + r + 1; x++) {
        const edge = (x < s.x - r || x > s.x + r || y < s.y - r || y > s.y + r);
        if (edge && inb(x, y)) { setHeight(x, y, lvl); setRock(x, y, 1); }
      }
  }

  // Carve a `width`-wide ramp through the cliff ring on the side facing `dir`.
  // Returns the list of ramp tiles (so callers can keep them passable).
  function carveRamp(s, r, dir, width, lvl) {
    const tiles = [];
    const half = width >> 1;
    // ramp centered on the cliff edge in the primary axis of `dir`
    if (Math.abs(dir.dx) >= Math.abs(dir.dy)) {
      const rx = s.x + dir.dx * (r + 1);              // cliff-ring column
      for (let k = -half; k <= half; k++) {
        const y = s.y + k;
        // open the cliff column AND the tile just inside/outside so the ramp
        // is a real corridor, sloping from plateau down to lowland.
        setRock(rx, y, 0); setHeight(rx, y, lvl);       // top of ramp
        setRock(rx + dir.dx, y, 0); setHeight(rx + dir.dx, y, 0); // foot
        tiles.push({ x: rx, y }, { x: rx + dir.dx, y });
      }
    } else {
      const ry = s.y + dir.dy * (r + 1);
      for (let k = -half; k <= half; k++) {
        const x = s.x + k;
        setRock(x, ry, 0); setHeight(x, ry, lvl);
        setRock(x, ry + dir.dy, 0); setHeight(x, ry + dir.dy, 0);
        tiles.push({ x, y: ry }, { x, y: ry + dir.dy });
      }
    }
    return tiles;
  }

  // Ring a lowland expansion on three sides, leaving a wide gap toward `dir`.
  function ringExpansion(s, r, dir, gapWidth) {
    clearArea3(s, r);
    const half = gapWidth >> 1;
    for (let y = s.y - r - 1; y <= s.y + r + 1; y++)
      for (let x = s.x - r - 1; x <= s.x + r + 1; x++) {
        const edge = (x < s.x - r || x > s.x + r || y < s.y - r || y > s.y + r);
        if (!edge || !inb(x, y)) continue;
        // leave the opening on the center-facing side
        let inGap;
        if (Math.abs(dir.dx) >= Math.abs(dir.dy)) {
          inGap = Math.sign(x - s.x) === dir.dx && Math.abs(y - s.y) <= half;
        } else {
          inGap = Math.sign(y - s.y) === dir.dy && Math.abs(x - s.x) <= half;
        }
        if (!inGap) setRock(x, y, 1);
      }
  }

  function carveCenterRidge(r) {
    // A cliff wall across mid-map, perpendicular to the start-to-start
    // diagonal, with 2-3 gaps. Height 1 with blocked cliff faces.
    const cx = W >> 1, cy = H >> 1;
    const horizontal = (r() & 1) === 0;
    const span = (W >> 1) - 4;
    const gaps = 2 + (r() & 1);
    const gapAt = [];
    for (let g = 0; g < gaps; g++) gapAt.push(-span + ((r() % (span * 2)) | 0));
    const isGap = (p) => gapAt.some((c) => Math.abs(p - c) <= 2);
    for (let d = -span; d <= span; d++) {
      if (isGap(d)) continue;
      if (horizontal) { setRock(cx + d, cy, 1); setRock(cx + d, cy - 1, 1); }
      else { setRock(cx, cy + d, 1); setRock(cx - 1, cy + d, 1); }
    }
  }

  function raiseCenterMesas(r) {
    // Two decorative unwalkable level-2 mesas flanking center (blocked all
    // over — pure obstacle + visual interest). Symmetric by the writers.
    const cx = W >> 1, cy = H >> 1;
    const off = 5 + (r() % 4);
    const size = 2 + (r() % 2);
    const mesa = (mxc, myc) => {
      for (let y = myc - size; y <= myc + size; y++)
        for (let x = mxc - size; x <= mxc + size; x++) {
          setHeight(x, y, 2); setRock(x, y, 1);
        }
    };
    mesa(cx - off, cy - off);
    // its rotational partner is written automatically by the symmetric setters
  }

  function clearArea3(s, r) {
    for (let y = s.y - r; y <= s.y + r; y++)
      for (let x = s.x - r; x <= s.x + r; x++) setRock(x, y, 0);
  }

  function clearLane(a, b, halfWidth) {
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 2 || 1;
    for (let i = 0; i <= steps; i++) {
      const x = a.x + (((b.x - a.x) * i / steps) | 0);
      const y = a.y + (((b.y - a.y) * i / steps) | 0);
      for (let dy = -halfWidth; dy <= halfWidth; dy++)
        for (let dx = -halfWidth; dx <= halfWidth; dx++) {
          const tx = x + dx, ty = y + dy;
          // don't punch through a deliberate cliff wall/ramp face into a
          // plateau; only clear lowland scatter along the lane
          if (inb(tx, ty) && height[idx(tx, ty)] === 0) setRock(tx, ty, 0);
        }
    }
  }

  function clampTile(v, n) { return Math.max(2, Math.min(n - 3, v)); }

  function perpOffset(dir, mag, r) {
    // a vector perpendicular to `dir`, scaled by mag (integer)
    const px = -dir.dy, py = dir.dx;
    const jitter = (r() % 3) - 1;
    return { x: (px * mag) + jitter, y: (py * mag) - jitter };
  }
}

// ---------------------------------------------------------------------------
// Shared offset tables (module-level, deterministic)
// ---------------------------------------------------------------------------

// An arc of `n` patch offsets fanned toward direction (dx,dy). Hand-tuned
// integer offsets forming a shallow crescent 3-5 tiles out from the center.
function arcOffsets(dx, dy, n) {
  // base crescent in "behind" space: rows at distance 3 and 4
  const base = [
    [3, -2], [3, 0], [3, 2], [2, 3], [0, 3], [-2, 3], [4, 1],
  ];
  const out = [];
  for (let i = 0; i < n && i < base.length; i++) {
    const [a, b] = base[i];
    // rotate the crescent so its bulk points along (dx,dy). We only ever pass
    // axis or diagonal unit directions, so integer rotation is exact.
    out.push(rotateOffset(a, b, dx, dy));
  }
  return out;
}

// Map a canonical offset (pointing toward +x/+y quadrant) onto the quadrant
// indicated by sign(dx),sign(dy). Integer, exact.
function rotateOffset(a, b, dx, dy) {
  const sx = dx === 0 ? 1 : Math.sign(dx);
  const sy = dy === 0 ? 1 : Math.sign(dy);
  return [a * sx, b * sy];
}

function scatterDecos(rng, addDeco, rock, height, W, H, starts, expansions) {
  const idx = (x, y) => y * W + x;
  const nearBaseOrLane = (x, y) => {
    for (const s of starts) if (Math.abs(x - s.x) + Math.abs(y - s.y) < 6) return true;
    for (const e of expansions) if (Math.abs(x - e.x) + Math.abs(y - e.y) < 5) return true;
    // keep the straight center diagonal (the main lane) fairly clear
    return false;
  };
  // Only place in ONE half (y < H/2); addDeco mirrors to the other half, so
  // decorations are symmetric like everything else.
  const count = 40 + (rng() % 20);
  for (let i = 0; i < count; i++) {
    const x = 2 + (rng() % (W - 4));
    const y = 2 + (rng() % ((H >> 1) - 2));
    if (rock[idx(x, y)]) continue;                    // no props on cliffs/rock
    if (height[idx(x, y)] === 2) continue;            // not on high mesas
    if (nearBaseOrLane(x, y)) continue;
    const kind = rng() % 3;
    addDeco(x, y, kind);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(map) { return validateVerbose(map) === null; }

// Returns null if valid, else a short reason string (used by debug tooling).
function validateVerbose(map) {
  const { w, h, rock, starts, minerals } = map;
  const idx = (x, y) => y * w + x;
  const inb = (x, y) => x >= 0 && y >= 0 && x < w && y < h;

  // start tiles themselves must be clear
  for (const s of starts) {
    if (!inb(s.x, s.y) || rock[idx(s.x, s.y)]) return "start blocked";
  }

  // (a) start A reaches start B
  const reach0 = bfs(rock, w, h, starts[0].x, starts[0].y);
  if (!reach0[idx(starts[1].x, starts[1].y)]) return "A cannot reach B";

  // (b) 3x3 clear + >=40 free tiles within radius 8 of each start
  for (const s of starts) {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = s.x + dx, y = s.y + dy;
        if (!inb(x, y) || rock[idx(x, y)]) return "3x3 not clear";
      }
    let free = 0;
    for (let dy = -8; dy <= 8; dy++)
      for (let dx = -8; dx <= 8; dx++) {
        const x = s.x + dx, y = s.y + dy;
        if (inb(x, y) && !rock[idx(x, y)]) free++;
      }
    if (free < 40) return "insufficient build space (" + free + ")";
  }

  // (c) every mineral patch has a reachable adjacent tile from its own side.
  const reach1 = bfs(rock, w, h, starts[1].x, starts[1].y);
  for (const m of minerals) {
    const tx = (m.x / 256) | 0, ty = (m.y / 256) | 0;
    let ok = false, reachableFrom0 = false, reachableFrom1 = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = tx + dx, y = ty + dy;
      if (!inb(x, y) || rock[idx(x, y)]) continue;
      ok = true;
      if (reach0[idx(x, y)]) reachableFrom0 = true;
      if (reach1[idx(x, y)]) reachableFrom1 = true;
    }
    if (!ok) return "patch walled in @" + tx + "," + ty;
    if (!reachableFrom0 && !reachableFrom1) return "patch unreachable @" + tx + "," + ty;
  }

  // (d) main ramp choke width <= 3
  if (map.ramps && map.ramps[0]) {
    const width = measureChoke(map.ramps[0].tiles, rock, w, h);
    if (width > 3) return "choke width " + width;
  }

  return null;
}

// BFS flood over passable tiles (4-connected matches how a chokepoint gates
// movement; A* is 8-connected but a 4-connected component is a subset, so a
// 4-connected reach guarantees an 8-connected reach).
function bfs(rock, w, h, sx, sy) {
  const seen = new Uint8Array(w * h);
  const idx = (x, y) => y * w + x;
  if (rock[idx(sx, sy)]) return seen;
  const q = [idx(sx, sy)];
  seen[idx(sx, sy)] = 1;
  let head = 0;
  while (head < q.length) {
    const n = q[head++];
    const x = n % w, y = (n / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const m = idx(nx, ny);
      if (seen[m] || rock[m]) continue;
      seen[m] = 1;
      q.push(m);
    }
  }
  return seen;
}

// Measure the ramp's chokepoint width: the passable cross-section at the
// tightest slice of the corridor. Travel runs along the axis with the SMALLER
// ramp-tile spread; the perpendicular (cross) axis carries the width. We scan
// each travel slice, measure its open cross-run centered on the ramp, and take
// the MINIMUM — the narrowest point a defender holds.
function measureChoke(tiles, rock, w, h) {
  const idx = (x, y) => y * w + x;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const t of tiles) {
    if (t.x < minX) minX = t.x; if (t.x > maxX) maxX = t.x;
    if (t.y < minY) minY = t.y; if (t.y > maxY) maxY = t.y;
  }
  const travelAlongX = (maxX - minX) <= (maxY - minY); // smaller spread = travel axis
  let narrowest = Infinity;
  const openRun = (cells) => {
    // longest run of open tiles that overlaps the ramp span (so a wide lowland
    // beside the ramp foot doesn't count unless it touches the choke)
    let run = 0, best = 0;
    for (const open of cells) { if (open) { run++; best = Math.max(best, run); } else run = 0; }
    return best;
  };
  if (travelAlongX) {
    // slices are columns x = minX..maxX; cross axis is Y, centered on ramp rows
    const cy0 = minY, cy1 = maxY;
    for (let x = minX; x <= maxX; x++) {
      const cells = [];
      for (let y = cy0 - 1; y <= cy1 + 1; y++)
        cells.push(y >= 0 && y < h && x >= 0 && x < w && !rock[idx(x, y)]);
      narrowest = Math.min(narrowest, openRun(cells));
    }
  } else {
    for (let y = minY; y <= maxY; y++) {
      const cells = [];
      for (let x = minX - 1; x <= maxX + 1; x++)
        cells.push(x >= 0 && x < w && y >= 0 && y < h && !rock[idx(x, y)]);
      narrowest = Math.min(narrowest, openRun(cells));
    }
  }
  return narrowest === Infinity ? 0 : narrowest;
}

// ---------------------------------------------------------------------------
// Hardcoded fallback (guaranteed to validate) — the original simple layout,
// with a flat height field so the renderer never sees an undefined array.
// ---------------------------------------------------------------------------

function fallbackMap() {
  const W = MAP_W, H = MAP_H;
  const rock = new Uint8Array(W * H);
  const height = new Uint8Array(W * H);
  const starts = [{ x: 8, y: 8 }, { x: W - 9, y: H - 9 }];
  const idx = (x, y) => y * W + x;
  const clear = (cx, cy, r) => {
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++)
        if (x >= 0 && y >= 0 && x < W && y < H) rock[idx(x, y)] = 0;
  };
  for (const s of starts) clear(s.x, s.y, 7);
  // straight connecting lane
  const a = starts[0], b = starts[1];
  const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 2;
  for (let i = 0; i <= steps; i++) {
    clear(a.x + (((b.x - a.x) * i / steps) | 0), a.y + (((b.y - a.y) * i / steps) | 0), 2);
  }
  const minerals = [];
  const arc = [[-4, -2], [-4, 0], [-4, 2], [-2, -4], [0, -4], [2, -4]];
  for (const [dx, dy] of arc) {
    minerals.push({ x: tileToFp(starts[0].x + dx), y: tileToFp(starts[0].y + dy) });
    minerals.push({ x: tileToFp(starts[1].x - dx), y: tileToFp(starts[1].y - dy) });
  }
  // one expansion pair, mirrored rotationally so minerals stay balanced
  const e = { x: 14, y: H - 15 };                  // player-0 side expansion
  const em = { x: W - 1 - e.x, y: H - 1 - e.y };   // rotational partner
  clear(e.x, e.y, 4); clear(em.x, em.y, 4);
  for (const [dx, dy] of [[-2, -1], [-2, 1], [-1, -2], [1, -2]]) {
    minerals.push({ x: tileToFp(e.x + dx), y: tileToFp(e.y + dy) });
    minerals.push({ x: tileToFp(W - 1 - (e.x + dx)), y: tileToFp(H - 1 - (e.y + dy)) });
  }
  return { w: W, h: H, rock, height, starts, minerals, decos: [], ramps: [] };
}
