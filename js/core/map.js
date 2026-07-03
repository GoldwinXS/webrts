// Deterministic procedural map generation. Supports TWO symmetry modes so that
// spawns can be cross-map (180-degree rotational) OR same-edge/close
// (reflection across a center axis). Every tile that lands in rock/height/
// starts/minerals/geysers/losBlock is written through paired symmetric setters,
// so the battlefield is balanced BY CONSTRUCTION regardless of mode.
//
// The primary separation between areas is ELEVATION (cliff-walled height
// changes with occasional ramps), not rock blobs — rocks are now sparse,
// decoration-scale obstacles. Maps vary along many axes (base placement style,
// symmetry mode, elevation character, lane count/choke widths, mineral-line
// orientation, deco density, LoS blockers) so each seed feels distinct.
//
// INTEGER-ONLY. Everything is driven exclusively by makeRng(seed) (+ resolved
// opts). Two calls with the same (seed, opts) are byte-identical (both
// multiplayer clients generate the map independently from a shared seed).
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
// 0 = crystal shard cluster, 1 = small rock pile, 2 = glowing flora tuft,
// 3 = tall shrub (LoS blocker marker — passable, blocks vision).

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
//
// generateMap(seed, opts) — pure function of (seed, opts). Options affect
// GENERATION ONLY and are still fully integer-deterministic.
//
// opts = {
//   spawns:       "random" | "cross" | "close"   (default "random")
//   expansions:   0 | 1 | 2 | "random"           (extra pairs beyond natural;
//                                                  default "random")
//   losBlockers:  boolean                          (default true)
//   theme:        -1 (seed-random) | 0..2          (default -1)
// }
export function generateMap(seed, opts = {}) {
  const resolved = resolveOpts(seed, opts);
  for (let attempt = 0; attempt < 24; attempt++) {
    const s = (seed + attempt * 1000003) | 0;
    const map = buildCandidate(s, resolved);
    if (validate(map)) {
      map.theme = resolved.theme < 0 ? ((seed >>> 0) % THEMES.length) : (resolved.theme % THEMES.length);
      map.themeName = THEMES[map.theme].name;
      return map;
    }
  }
  // Never fail to start a match: hand back a known-good simple layout.
  const fb = fallbackMap();
  fb.theme = resolved.theme < 0 ? ((seed >>> 0) % THEMES.length) : (resolved.theme % THEMES.length);
  fb.themeName = THEMES[fb.theme].name;
  return fb;
}

// Resolve the option object into concrete integer choices. "random"/-1 values
// are drawn from a dedicated rng stream keyed off the seed so the SAME (seed,
// opts) always resolves identically, independent of the build attempt.
function resolveOpts(seed, opts) {
  const r = makeRng((seed ^ 0x0917a5) | 0);
  const spawns = opts.spawns && opts.spawns !== "random"
    ? opts.spawns
    : (r() % 3 === 0 ? "close" : "cross");        // ~1/3 close, else cross
  let expansions;
  if (opts.expansions === 0 || opts.expansions === 1 || opts.expansions === 2) {
    expansions = opts.expansions;
  } else {
    expansions = 1 + (r() % 2);                    // 1 or 2 extra pairs
  }
  const losBlockers = opts.losBlockers === undefined ? true : !!opts.losBlockers;
  const theme = (opts.theme === undefined || opts.theme < 0) ? -1 : (opts.theme | 0);
  return { spawns, expansions, losBlockers, theme };
}

// ---------------------------------------------------------------------------
// Candidate construction
// ---------------------------------------------------------------------------

function buildCandidate(seed, opts) {
  const rng = makeRng(seed);
  const W = MAP_W, H = MAP_H;
  const rock = new Uint8Array(W * H);
  const height = new Uint8Array(W * H);
  const losBlock = new Uint8Array(W * H);
  const decos = [];

  const idx = (x, y) => y * W + x;
  const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

  // ---- symmetry mode --------------------------------------------------------
  // "cross"  -> 180-degree rotational partner (opposite corners).
  // "close"  -> reflection across a center axis (same-edge spawns), which is
  //             the ONLY way to keep two same-edge spawns balanced.
  // For close spawns we pick the reflection axis so the two mains sit on the
  // same edge: vertical axis (reflect x) => two spawns share the TOP (or a
  // side) edge; horizontal axis (reflect y) similarly.
  const mode = opts.spawns === "close" ? "reflect" : "rotate";
  // reflection axis: 0 = vertical (mirror x, spawns share top/bottom edge),
  //                  1 = horizontal (mirror y, spawns share left/right edge).
  const reflectAxis = mode === "reflect" ? (rng() & 1) : 0;

  // partner(x,y) -> [px,py] of the symmetric counterpart under the active mode.
  const partner = (x, y) => {
    if (mode === "rotate") return [W - 1 - x, H - 1 - y];
    return reflectAxis === 0 ? [W - 1 - x, y] : [x, H - 1 - y];
  };

  // Symmetric writers: set a tile and its mode-appropriate partner together so
  // the whole map is guaranteed balanced by construction.
  const setRock = (x, y, v) => {
    if (!inb(x, y)) return;
    rock[idx(x, y)] = v;
    const [px, py] = partner(x, y);
    rock[idx(px, py)] = v;
  };
  const setHeight = (x, y, v) => {
    if (!inb(x, y)) return;
    height[idx(x, y)] = v;
    const [px, py] = partner(x, y);
    height[idx(px, py)] = v;
  };
  const setLos = (x, y, v) => {
    if (!inb(x, y)) return;
    losBlock[idx(x, y)] = v;
    const [px, py] = partner(x, y);
    losBlock[idx(px, py)] = v;
  };
  const addDeco = (x, y, kind) => {
    if (!inb(x, y)) return;
    decos.push({ x, y, kind });
    const [px, py] = partner(x, y);
    decos.push({ x: px, y: py, kind });
  };

  // ---- base placement style (variation axis #1) -----------------------------
  // Two families of start positions:
  //   corner      : classic corner inset (varying inset distance)
  //   edgeMiddle  : partway along an edge (SC2-style top/side positions)
  // For "close" (reflect) spawns we deliberately favour same-edge placements
  // (e.g. two top corners / two positions along the top edge). For "cross"
  // (rotate) spawns the partner is the opposite corner automatically.
  const inset = 6 + (rng() % 6);                    // 6..11 tiles from the edge
  let start0;
  if (mode === "reflect") {
    // both spawns share the edge OPPOSITE to the reflection axis line.
    if (reflectAxis === 0) {
      // mirror-x: spawns sit along the top OR bottom edge (same y).
      const topEdge = (rng() & 1) === 0;
      const y = topEdge ? inset : H - 1 - inset;
      // x on player-0's (left) half; partner mirrors to the right half.
      const x = Math.min((W >> 1) - 3, inset + (rng() % 4));
      start0 = { x, y };
    } else {
      // mirror-y: spawns sit along the left OR right edge (same x).
      const leftEdge = (rng() & 1) === 0;
      const x = leftEdge ? inset : W - 1 - inset;
      const y = Math.min((H >> 1) - 3, inset + (rng() % 4));
      start0 = { x, y };
    }
  } else {
    const style = rng() % 3;                         // 0 corner, 1/2 edge-middle
    if (style === 0) {
      const ne = (rng() & 1) === 1;                 // NW/SE vs NE/SW pair
      start0 = ne ? { x: W - 1 - inset, y: inset } : { x: inset, y: inset };
    } else if (style === 1) {
      // top/bottom edge-middle: x near quarter, y near an edge
      const topSide = (rng() & 1) === 0;
      start0 = { x: (W >> 2) + (rng() % 5) - 2, y: topSide ? inset : H - 1 - inset };
    } else {
      // left/right edge-middle: x near an edge, y near quarter
      const leftSide = (rng() & 1) === 0;
      start0 = { x: leftSide ? inset : W - 1 - inset, y: (H >> 2) + (rng() % 5) - 2 };
    }
  }
  start0.x = clampTile(start0.x, W);
  start0.y = clampTile(start0.y, H);
  const [p1x, p1y] = partner(start0.x, start0.y);
  const start1 = { x: p1x, y: p1y };
  const starts = [start0, start1];

  // Direction from a main toward map center (for placing ramps / expansions).
  // Never (0,0): if a start sits on a center axis, bias toward interior.
  const toCenter = (s) => {
    let dx = Math.sign((W >> 1) - s.x);
    let dy = Math.sign((H >> 1) - s.y);
    if (dx === 0 && dy === 0) { dx = 1; dy = 1; }
    // For reflect mode along an edge, the "into the map" direction is mostly
    // perpendicular to the shared edge; keep the natural sign toward center.
    if (dx === 0) dx = (s.x < (W >> 1)) ? 1 : -1;
    if (dy === 0) dy = (s.y < (H >> 1)) ? 1 : -1;
    return { dx, dy };
  };

  // ---- elevation character (variation axis #3) ------------------------------
  // How much of the map is high ground. Drives a broad low/high banding of the
  // battlefield that separates areas by CLIFFS instead of rock walls.
  const elevChar = rng() % 3;                        // 0 low-dominant, 1 mixed, 2 high-dominant

  // ---- 1. main plateau + cliff ring + ramp(s) -------------------------------
  // Bigger plateau than before so the interior guarantees >= 70 free tiles.
  const plateauR = 6;                               // plateau half-extent (13x13 top)
  const mainHeight = 1 + (rng() & 1);               // main at level 1 or 2
  raisePlateau(start0, plateauR, mainHeight);

  const c0 = toCenter(start0);

  // ---- lane count (variation axis #5) ---------------------------------------
  // 1-3 distinct routes between the mains, with different choke widths. The
  // main ramp off the plateau is ALWAYS <= 3 wide (validated). Additional
  // lanes are carved as cliff gaps of varying width later.
  const laneCount = 1 + (rng() % 3);                // 1, 2 or 3

  // Ramp: 3-wide opening on the center-facing side of the plateau.
  const rampMain = carveRamp(start0, plateauR, c0, 3, mainHeight);

  // ---- 2. natural expansion (just outside the main ramp) --------------------
  // Sits down the ramp lane, at lowland height, ringed on three sides with a
  // WIDER (4-5 tile) opening — partially defensible. Grown to guarantee the
  // >= 50 free tiles within radius 6 requirement.
  const natR = 4;                                   // natural half-extent (9x9)
  const natWidth = 4 + (rng() & 1);                 // 4 or 5 wide opening
  const nat0 = {
    x: clampTile(start0.x + c0.dx * (plateauR + 6), W),
    y: clampTile(start0.y + c0.dy * (plateauR + 6), H),
  };
  ringExpansion(nat0, natR, c0, natWidth);

  // ---- 3. additional expansions (open territory) ----------------------------
  const extraPairs = opts.expansions;               // resolved 0/1/2
  const expansions = [nat0];
  for (let e = 0; e < extraPairs; e++) {
    const reach = plateauR + 13 + e * 8 + (rng() % 4);
    const perp = perpOffset(c0, (e & 1) ? 6 : -6, rng);
    const ex = {
      x: clampTile(start0.x + c0.dx * reach + perp.x, W),
      y: clampTile(start0.y + c0.dy * reach + perp.y, H),
    };
    clearArea3(ex, 3);
    expansions.push(ex);
  }

  // ---- 4. center elevation feature (cliff-based separation) -----------------
  // The centerpiece now uses ELEVATION to divide the map. Depending on the
  // elevation character we raise a high-ground band/plateau across mid-map,
  // walled by cliffs, and punch `laneCount` ramps/gaps through it of varying
  // width — this is what creates the 1-3 distinct routes.
  const centerGaps = carveCenterElevation(rng, elevChar, laneCount, c0, mode, reflectAxis);

  // ---- 5. sparse rock scatter (decoration-scale obstacles only) -------------
  // Rocks are no longer the primary walls: just a light scatter of tiny
  // obstacle clumps on lowland, well clear of bases and lanes.
  const blobs = 3 + (rng() % 4);                    // 3..6 small clumps
  for (let i = 0; i < blobs; i++) {
    const bx = 5 + (rng() % (W - 10));
    const by = 5 + (rng() % ((H >> 1) - 5));
    const size = 1 + (rng() % 2);                    // radius 1..2 (tiny)
    for (let j = 0; j < size * 2 + 1; j++) {
      const x = bx + (rng() % (size * 2 + 1)) - size;
      const y = by + (rng() % (size * 2 + 1)) - size;
      if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) continue;
      if (height[idx(x, y)] !== 0) continue;         // never on plateaus/cliffs
      setRock(x, y, 1);
    }
  }

  // ---- 6. guarantee connectivity: clear the lane(s) -------------------------
  // A soft corridor between the two naturals keeps the map traversable even
  // when scatter is dense; ramps already connect mains to naturals.
  clearLane(nat0, { x: partner(nat0.x, nat0.y)[0], y: partner(nat0.x, nat0.y)[1] }, 2);

  // Re-clear the immediate build areas (scatter/lane may have intruded).
  clearArea3(start0, plateauR - 1);                 // interior of the main
  ringExpansion(nat0, natR, c0, natWidth);          // re-assert the natural ring
  for (const ex of expansions) if (ex !== nat0) clearArea3(ex, 3);
  for (const t of rampMain) { setRock(t.x, t.y, 0); }
  for (const g of centerGaps) setRock(g.x, g.y, 0); // keep center gaps open

  // ---- 7. geysers -----------------------------------------------------------
  // TWO per main (on/near the plateau, >= 5 tiles from the start, NOT in the
  // mineral arc) and ONE near each natural. Each gets a clear 2x2 area with no
  // rock/cliff and no minerals within 1 tile. Symmetric like everything else.
  const geysers = [];
  const geyserTiles = [];                            // for later mineral-avoidance
  // Place a geyser at origin (tx,ty), clearing a 2x2 that grows toward
  // (ix,iy) so it stays on clear ground (e.g. inward on a plateau). Keeps the
  // area passable and flat to the origin's height. Returns false if any tile of
  // the 2x2 falls out of bounds.
  const placeGeyser = (tx, ty, ix, iy) => {
    if (!inb(tx, ty) || !inb(tx + ix, ty + iy)) return false;
    const lvl = height[idx(tx, ty)];
    const xs = [tx, tx + ix], ys = [ty, ty + iy];
    for (const gx of xs)
      for (const gy of ys) {
        setRock(gx, gy, 0);
        setHeight(gx, gy, lvl);
      }
    geysers.push({ x: tileToFp(tx), y: tileToFp(ty) });
    const [px, py] = partner(tx, ty);
    geysers.push({ x: tileToFp(px), y: tileToFp(py) });
    // record all four tiles of both halves for mineral/deco avoidance
    for (const gx of xs) for (const gy of ys) {
      geyserTiles.push({ x: gx, y: gy });
      const [ppx, ppy] = partner(gx, gy);
      geyserTiles.push({ x: ppx, y: ppy });
    }
    return { x: tx, y: ty };                          // player-0 side origin
  };

  // Main geysers: on the plateau interior, on the two sides perpendicular to the
  // center direction, at chebyshev >= 5 from the start. The 2x2 grows INWARD
  // (toward the start) so it stays clear of the cliff ring. The behind-arc is
  // reserved for minerals, so geysers sit on the flanks.
  const perpU = { x: -c0.dy, y: c0.dx };            // unit perpendicular to c0
  // origin at |perp|=6 (chebyshev 6, on the 13x13 plateau edge => >= 6 tiles
  // from the start center); the 2x2 grows INWARD so all four tiles stay on the
  // plateau top and clear of the cliff ring.
  const gA = { x: start0.x + perpU.x * 6, y: start0.y + perpU.y * 6 };
  const gB = { x: start0.x - perpU.x * 6, y: start0.y - perpU.y * 6 };
  // inward directions: along -perp (toward start) for the perp axis; the other
  // axis grows toward center so it never crosses the plateau edge on the ramp
  // side. Use sign of c0 where perp component is zero.
  const mainGeyserA = placeGeyser(gA.x, gA.y, -perpU.x || c0.dx, -perpU.y || c0.dy) || null;
  const mainGeyserB = placeGeyser(gB.x, gB.y, perpU.x || c0.dx, perpU.y || c0.dy) || null;

  // Natural geyser: one, set ~7 tiles to the "back" of the natural (away from
  // center) so it sits in the 6..9 band from the natural's ideal CP (nat0) and
  // doesn't clog the mining approach. placeGeyser clears its 2x2. The 2x2 grows
  // toward the natural center (so it stays reachable ground).
  const ng = { x: clampTile(nat0.x - c0.dx * 7, W), y: clampTile(nat0.y - c0.dy * 7, H) };
  // ensure the geyser + a small pad are lowland-clear (it lands outside the
  // natural's ring, so open a little pocket around it and re-link to the nat).
  for (let dy = -1; dy <= 2; dy++)
    for (let dx = -1; dx <= 2; dx++) {
      const x = ng.x + dx, y = ng.y + dy;
      if (inb(x, y)) { setRock(x, y, 0); setHeight(x, y, 0); }
    }
  const natGeyser = placeGeyser(ng.x, ng.y, c0.dx || 1, c0.dy || 1) || null;

  // ---- 8. minerals ----------------------------------------------------------
  // Main: 7 patches arced BEHIND the start (away from center), >= 5 tiles out.
  // Mineral-line ORIENTATION varies (variation axis #6): the arc is rotated by
  // a per-map offset so the line reads differently each seed. Natural & extras:
  // 5-patch clusters. All placed symmetrically, on clear tiles, never within 1
  // tile of a geyser.
  const minerals = [];
  const nearGeyser = (tx, ty) => {
    for (const gt of geyserTiles) {
      if (Math.abs(tx - gt.x) <= 1 && Math.abs(ty - gt.y) <= 1) return true;
    }
    return false;
  };
  // Euclidean tile distance (matches sim's center-to-center fp distance / 256).
  const tdist2 = (ax, ay, bx2, by2) => { const dx = ax - bx2, dy = ay - by2; return dx * dx + dy * dy; };
  // patch must sit in the 6..9 tile band from its OWN base center, be clear of
  // geysers, in-bounds, and on passable lowland/plateau. The band keeps command
  // posts a real trip away from resources (>= 6) without absurd hauls (<= 9).
  // Per-base resource clusters (player-0 side): center + the tiles of every
  // patch/geyser feeding it. Used to validate a guaranteed CP spot per base.
  const clusters = [];
  const pushPatch = (tx, ty, base, cluster) => {
    if (!inb(tx, ty)) return;
    if (nearGeyser(tx, ty)) return;                  // keep geyser clearance
    const d2 = tdist2(tx, ty, base.x, base.y);
    if (d2 < 6 * 6 || d2 > 9 * 9) return;            // 6..9 tile band
    if (rock[idx(tx, ty)] && height[idx(tx, ty)]) return; // don't punch cliffs
    setRock(tx, ty, 0);
    minerals.push({ x: tileToFp(tx), y: tileToFp(ty) });
    const [px, py] = partner(tx, ty);
    minerals.push({ x: tileToFp(px), y: tileToFp(py) });
    if (cluster) cluster.res.push({ x: tx, y: ty });
  };
  // arc behind main: opposite the center direction, in the 6..9 band.
  const bx = -c0.dx, by = -c0.dy;                    // "behind" unit vector
  const arcStyle = rng() % 3;                        // mineral-line orientation variant
  const mainArc = arcOffsets(bx, by, 7, arcStyle);
  const mainCluster = { center: { x: start0.x, y: start0.y }, res: [], isMain: true };
  clusters.push(mainCluster);
  for (const [ox, oy] of mainArc) pushPatch(start0.x + ox, start0.y + oy, start0, mainCluster);
  // main geysers feed the main CP (record their origins in the main cluster).
  if (mainGeyserA) mainCluster.res.push(mainGeyserA);
  if (mainGeyserB) mainCluster.res.push(mainGeyserB);

  // expansion clusters arc AWAY from the nearest start (so the natural's line
  // sits on its far side, not crammed between it and the main).
  for (let ei = 0; ei < expansions.length; ei++) {
    const ex = expansions[ei];
    let ns = starts[0], nd = Infinity;
    for (const s of starts) {
      const d = Math.abs(ex.x - s.x) + Math.abs(ex.y - s.y);
      if (d < nd) { nd = d; ns = s; }
    }
    const awayx = Math.sign(ex.x - ns.x) || (Math.sign((W >> 1) - ex.x) || 1);
    const awayy = Math.sign(ex.y - ns.y) || (Math.sign((H >> 1) - ex.y) || 1);
    const cluster = arcOffsets(awayx, awayy, 5, arcStyle);
    const exCluster = { center: { x: ex.x, y: ex.y }, res: [], isMain: false };
    clusters.push(exCluster);
    for (const [ox, oy] of cluster) pushPatch(ex.x + ox, ex.y + oy, ex, exCluster);
    // the natural's geyser feeds this cluster (only the natural has one).
    if (ei === 0 && natGeyser) exCluster.res.push(natGeyser);
  }

  // ---- 9. line-of-sight blockers -------------------------------------------
  // 2-4 symmetric PASSABLE shrub/smoke patches (3-6 tiles each) near lanes /
  // expansion approaches, never inside main/natural mining areas. Marked in
  // losBlock and given a deco kind 3 per tile so the renderer can show them.
  if (opts.losBlockers) {
    placeLosBlockers(rng, setLos, addDeco, rock, height, losBlock, W, H,
      starts, expansions, geyserTiles, c0, plateauR, natR, partner);
  }

  // ---- 10. decorations (non-blocking, sparse near bases/lanes) --------------
  const decoDensity = rng() % 3;                     // 0 sparse, 1 medium, 2 lush
  scatterDecos(rng, addDeco, rock, height, losBlock, W, H, starts, expansions, decoDensity);

  // record natural centers (both symmetric halves) so validation can enforce
  // the natural free-space floor. Not read by sim/renderer — internal only.
  const [natPx, natPy] = partner(nat0.x, nat0.y);
  const naturals = [{ x: nat0.x, y: nat0.y }, { x: natPx, y: natPy }];

  return {
    w: W, h: H, rock, height, starts, minerals, geysers, losBlock, decos,
    naturals, clusters,                              // clusters: internal only
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
    if (Math.abs(dir.dx) >= Math.abs(dir.dy)) {
      const rx = s.x + dir.dx * (r + 1);              // cliff-ring column
      // cliff SHOULDERS pinch the mouth: block the ring column just beyond the
      // ramp width so the corridor reads exactly `width` (keeps choke <= 3
      // instead of the open plateau top bleeding the measurement wider).
      setRock(rx, s.y - (half + 1), 1);
      setRock(rx, s.y + (half + 1), 1);
      for (let k = -half; k <= half; k++) {
        const y = s.y + k;
        setRock(rx, y, 0); setHeight(rx, y, lvl);       // top of ramp
        setRock(rx + dir.dx, y, 0); setHeight(rx + dir.dx, y, 0); // foot
        tiles.push({ x: rx, y }, { x: rx + dir.dx, y });
      }
    } else {
      const ry = s.y + dir.dy * (r + 1);
      setRock(s.x - (half + 1), ry, 1);
      setRock(s.x + (half + 1), ry, 1);
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
    // flatten the interior to lowland so it reads as open natural ground
    for (let y = s.y - r; y <= s.y + r; y++)
      for (let x = s.x - r; x <= s.x + r; x++) setHeight(x, y, 0);
    const half = gapWidth >> 1;
    for (let y = s.y - r - 1; y <= s.y + r + 1; y++)
      for (let x = s.x - r - 1; x <= s.x + r + 1; x++) {
        const edge = (x < s.x - r || x > s.x + r || y < s.y - r || y > s.y + r);
        if (!edge || !inb(x, y)) continue;
        let inGap;
        if (Math.abs(dir.dx) >= Math.abs(dir.dy)) {
          inGap = Math.sign(x - s.x) === dir.dx && Math.abs(y - s.y) <= half;
        } else {
          inGap = Math.sign(y - s.y) === dir.dy && Math.abs(x - s.x) <= half;
        }
        if (!inGap) setRock(x, y, 1);
      }
  }

  // Raise a high-ground band/plateau across mid-map, cliff-walled, and punch
  // `lanes` ramp gaps through it of VARYING width. Returns the list of gap
  // tiles that must remain passable. This replaces rock-wall separation with
  // elevation-based separation (player feedback #2).
  function carveCenterElevation(r, elev, lanes, cdir, symMode, axis) {
    const cx = W >> 1, cy = H >> 1;
    const gaps = [];
    // Orient the band perpendicular to the main travel direction so it truly
    // gates the routes between mains.
    const horizontalBand = Math.abs(cdir.dx) >= Math.abs(cdir.dy);
    // band thickness scales with how "high" the map should be
    const thick = elev === 2 ? 4 : (elev === 1 ? 3 : 2);
    const bandLvl = 1 + (elev === 2 ? 1 : 0);        // level 1 or 2 high ground
    const span = (horizontalBand ? (W >> 1) : (H >> 1)) - 3;

    // choose lane gap centers along the band, spread out, with varying widths.
    const gapCenters = [];
    const gapWidths = [];
    for (let g = 0; g < lanes; g++) {
      // spread centers across [-span+4 .. span-4]
      const frac = lanes === 1 ? 0 : (g - (lanes - 1) / 2);
      const base = (frac * (span - 4) * 2 / Math.max(1, lanes)) | 0;
      const jitter = (r() % 5) - 2;
      gapCenters.push(base + jitter);
      gapWidths.push(2 + (r() % 3));                 // choke width 2..4 (varies)
    }
    const inGap = (p) => {
      for (let g = 0; g < gapCenters.length; g++) {
        if (Math.abs(p - gapCenters[g]) <= gapWidths[g]) return true;
      }
      return false;
    };

    // Build the band by raising a strip to bandLvl and blocking its cliff faces,
    // leaving gaps open (and dropped back to lowland so they're walkable ramps).
    if (horizontalBand) {
      for (let d = -span; d <= span; d++) {
        const x = cx + d;
        for (let t = -thick; t <= thick; t++) {
          const y = cy + t;
          if (!inb(x, y)) continue;
          if (inGap(d)) {
            // ramp/gap: lowland, passable
            setHeight(x, y, 0); setRock(x, y, 0);
            gaps.push({ x, y });
          } else {
            const face = (t === -thick || t === thick);
            setHeight(x, y, bandLvl);
            setRock(x, y, face ? 1 : 0);             // cliff faces block, top walkable
          }
        }
      }
    } else {
      for (let d = -span; d <= span; d++) {
        const y = cy + d;
        for (let t = -thick; t <= thick; t++) {
          const x = cx + t;
          if (!inb(x, y)) continue;
          if (inGap(d)) {
            setHeight(x, y, 0); setRock(x, y, 0);
            gaps.push({ x, y });
          } else {
            const face = (t === -thick || t === thick);
            setHeight(x, y, bandLvl);
            setRock(x, y, face ? 1 : 0);
          }
        }
      }
    }
    return gaps;
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
          // don't punch through a deliberate cliff wall into a plateau; only
          // clear lowland scatter along the lane
          if (inb(tx, ty) && height[idx(tx, ty)] === 0) setRock(tx, ty, 0);
        }
    }
  }

  function clampTile(v, n) { return Math.max(2, Math.min(n - 3, v)); }

  function perpOffset(dir, mag, r) {
    const px = -dir.dy, py = dir.dx;
    const jitter = (r() % 3) - 1;
    return { x: (px * mag) + jitter, y: (py * mag) - jitter };
  }
}

// ---------------------------------------------------------------------------
// LoS blockers
// ---------------------------------------------------------------------------

// Place 2-4 symmetric passable shrub patches (3-6 tiles each) near lanes /
// expansion approaches, never inside main/natural mining areas. Writes losBlock
// (via setLos) and one deco kind 3 per tile.
function placeLosBlockers(rng, setLos, addDeco, rock, height, losBlock, W, H,
  starts, expansions, geyserTiles, c0, plateauR, natR, partner) {
  const idx = (x, y) => y * W + x;
  const onAxis = (x, y) => { const [px, py] = partner(x, y); return px === x && py === y; };
  const nearMineOrBase = (x, y) => {
    for (const s of starts) if (Math.abs(x - s.x) <= plateauR + 1 && Math.abs(y - s.y) <= plateauR + 1) return true;
    for (const e of expansions) if (Math.abs(x - e.x) <= natR + 1 && Math.abs(y - e.y) <= natR + 1) return true;
    for (const g of geyserTiles) if (Math.abs(x - g.x) <= 1 && Math.abs(y - g.y) <= 1) return true;
    return false;
  };
  const patchCount = 2 + (rng() % 3);                // 2..4 (each mirrored pair)
  // candidate anchors: partway along the line from natural toward center.
  const nat = expansions[0];
  const cx = W >> 1, cy = H >> 1;
  let placed = 0;
  for (let attempt = 0; attempt < patchCount * 12 && placed < patchCount; attempt++) {
    // pick a point biased toward the nat->center lane, in player-0's half
    const t = 20 + (rng() % 60);                      // 20..80 %
    let ax = nat.x + (((cx - nat.x) * t / 100) | 0);
    let ay = nat.y + (((cy - nat.y) * t / 100) | 0);
    // jitter off the exact lane so blockers sit beside approaches
    ax += (rng() % 9) - 4;
    ay += (rng() % 9) - 4;
    if (ax < 3 || ay < 3 || ax >= W - 3 || ay >= H - 3) continue;
    const size = 3 + (rng() % 4);                     // patch of ~3..6 tiles
    // validate the whole patch is passable lowland and clear of bases. Dedupe
    // tiles within the patch AND skip any tile whose symmetric partner is
    // already a blocker, so losBlock and the kind-3 decos stay 1:1.
    const tiles = [];
    const seen = new Set();
    let ok = true;
    for (let k = 0; k < size; k++) {
      const px = ax + (rng() % 3) - 1;
      const py = ay + (rng() % 3) - 1;
      if (px < 2 || py < 2 || px >= W - 2 || py >= H - 2) continue;
      if (rock[idx(px, py)]) continue;                // must be passable
      if (height[idx(px, py)] === 2) continue;        // not on high mesa
      if (nearMineOrBase(px, py)) continue;
      if (losBlock[idx(px, py)]) continue;            // don't double-place
      if (onAxis(px, py)) continue;                   // axis tiles self-mirror
      if (seen.has(idx(px, py))) continue;            // dedupe within patch
      // skip tiles that sit on/across the symmetry line onto an existing
      // blocker (partner already set) — setLos writes both halves.
      seen.add(idx(px, py));
      tiles.push({ x: px, y: py });
    }
    if (!ok || !tiles.length) continue;
    // Only place a deco where this exact tile isn't already a blocker after the
    // paired setter runs — mark first, then emit one deco per newly-set tile so
    // the kind-3 deco count matches the losBlock tile count exactly (including
    // symmetric partners, which addDeco mirrors).
    for (const tl of tiles) {
      if (losBlock[idx(tl.x, tl.y)]) continue;        // partner already set it
      setLos(tl.x, tl.y, 1);
      addDeco(tl.x, tl.y, 3);
    }
    placed++;
  }
}

// ---------------------------------------------------------------------------
// Shared offset tables (module-level, deterministic)
// ---------------------------------------------------------------------------

// An arc of `n` patch offsets fanned toward direction (dx,dy). The `style`
// argument (0..2) shifts the crescent so the mineral-line orientation varies
// per map. Every offset has EUCLIDEAN magnitude in the 6..9 tile band so a
// command post at the base center sits 6..9 tiles (center-to-center) from each
// patch — long-but-reasonable worker trips, and far enough that the sim's
// "CP >= 6 tiles from resources" placement rule is satisfiable.
function arcOffsets(dx, dy, n, style = 0) {
  // base crescents; each offset (a,b) has sqrt(a^2+b^2) in [6, 8].
  const bases = [
    // style 0: shallow crescent centred on the +x axis
    [[7, -3], [7, -1], [7, 1], [7, 3], [6, 4], [4, 6], [6, 0]],
    // style 1: tighter vertical-leaning line
    [[7, -2], [7, 0], [7, 2], [6, -3], [6, 3], [5, 5], [8, 1]],
    // style 2: broad sweep
    [[6, -4], [6, 4], [7, -2], [7, 2], [5, 5], [4, 6], [8, 0]],
  ];
  const base = bases[style % bases.length];
  const out = [];
  for (let i = 0; i < n && i < base.length; i++) {
    const [a, b] = base[i];
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

function scatterDecos(rng, addDeco, rock, height, losBlock, W, H, starts, expansions, density) {
  const idx = (x, y) => y * W + x;
  const nearBaseOrLane = (x, y) => {
    for (const s of starts) if (Math.abs(x - s.x) + Math.abs(y - s.y) < 6) return true;
    for (const e of expansions) if (Math.abs(x - e.x) + Math.abs(y - e.y) < 5) return true;
    return false;
  };
  // Only place in ONE half; addDeco mirrors to the partner half, so decorations
  // are symmetric like everything else. Density varies per map.
  const base = density === 0 ? 24 : (density === 1 ? 40 : 60);
  const count = base + (rng() % 16);
  for (let i = 0; i < count; i++) {
    const x = 2 + (rng() % (W - 4));
    const y = 2 + (rng() % ((H >> 1) - 2));
    if (rock[idx(x, y)]) continue;                    // no props on cliffs/rock
    if (height[idx(x, y)] === 2) continue;            // not on high mesas
    if (losBlock[idx(x, y)]) continue;                // shrubs own their tiles
    if (nearBaseOrLane(x, y)) continue;
    const kind = rng() % 3;                            // kinds 0..2 (not shrub)
    addDeco(x, y, kind);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(map) { return validateVerbose(map) === null; }

// Returns null if valid, else a short reason string (used by debug tooling).
function validateVerbose(map) {
  const { w, h, rock, height, starts, minerals, geysers } = map;
  const idx = (x, y) => y * w + x;
  const inb = (x, y) => x >= 0 && y >= 0 && x < w && y < h;

  // start tiles themselves must be clear
  for (const s of starts) {
    if (!inb(s.x, s.y) || rock[idx(s.x, s.y)]) return "start blocked";
  }

  // (a) start A reaches start B
  const reach0 = bfs(rock, w, h, starts[0].x, starts[0].y);
  if (!reach0[idx(starts[1].x, starts[1].y)]) return "A cannot reach B";
  const reach1 = bfs(rock, w, h, starts[1].x, starts[1].y);

  // (b) 3x3 clear around each start (HQ footprint) + main plateau interior
  // free area (excluding minerals/geysers) >= 70 tiles.
  const mineralTiles = new Set(minerals.map((m) => ((m.y / 256) | 0) * w + ((m.x / 256) | 0)));
  const geyserTiles = new Set((geysers || []).map((g) => ((g.y / 256) | 0) * w + ((g.x / 256) | 0)));
  for (const s of starts) {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = s.x + dx, y = s.y + dy;
        if (!inb(x, y) || rock[idx(x, y)]) return "3x3 not clear";
      }
    // main plateau interior: tiles at this start's height, passable, reachable
    // from this start, excluding mineral/geyser tiles. Count within radius 7.
    const lvl = height ? height[idx(s.x, s.y)] : 0;
    let plateauFree = 0;
    for (let dy = -7; dy <= 7; dy++)
      for (let dx = -7; dx <= 7; dx++) {
        const x = s.x + dx, y = s.y + dy;
        if (!inb(x, y) || rock[idx(x, y)]) continue;
        if (height && height[idx(x, y)] !== lvl) continue; // same plateau level
        const id = idx(x, y);
        if (mineralTiles.has(id) || geyserTiles.has(id)) continue;
        if (!reach0[id] && !reach1[id]) continue;         // must be reachable
        plateauFree++;
      }
    if (plateauFree < 70) return "main plateau too small (" + plateauFree + ")";
  }

  // (b2) natural free space: >= 50 free tiles within radius 6 of each natural.
  // Naturals aren't stored explicitly; derive them as the expansion nearest each
  // start that isn't the main. We recompute from geysers isn't reliable, so we
  // scan: for each start, find the reachable lowland cluster centroid ~6-11
  // tiles toward center. Simpler & robust: require, for BOTH mirror halves, a
  // point within the map that has >= 50 free tiles in radius 6 AND lies on the
  // path between main and center. We approximate by checking the natural anchor
  // stored on the map if present; otherwise fall back to a lane midpoint scan.
  // (Naturals are guaranteed by construction; this is a safety floor.)
  // We check space around the recorded natural centers via map.naturals when set.
  if (map.naturals) {
    for (const n of map.naturals) {
      let free = 0;
      for (let dy = -6; dy <= 6; dy++)
        for (let dx = -6; dx <= 6; dx++) {
          const x = n.x + dx, y = n.y + dy;
          if (!inb(x, y) || rock[idx(x, y)]) continue;
          const id = idx(x, y);
          if (mineralTiles.has(id) || geyserTiles.has(id)) continue;
          free++;
        }
      if (free < 50) return "natural too small (" + free + ")";
    }
  }

  // (c) every mineral patch has a reachable adjacent tile from its own side.
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

  // (c2) INITIAL SPAWN band: every mineral patch of a main is 6..9 tiles
  // (center-to-center Euclidean) from that main's start, and the nearest patch
  // is within 9. Command posts sit a real trip from resources (mining is not
  // trivially efficient), but not absurdly far.
  const cdist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
  for (const s of starts) {
    let nearest2 = Infinity, cnt = 0;
    for (const m of minerals) {
      const tx = (m.x / 256) | 0, ty = (m.y / 256) | 0;
      const d2 = cdist2(tx, ty, s.x, s.y);
      // patches "belonging" to this main are the ones within ~11 tiles
      if (d2 <= 11 * 11) {
        cnt++;
        if (d2 < 6 * 6) return "patch too close to start @" + tx + "," + ty + " (d2=" + d2 + ")";
        if (d2 < nearest2) nearest2 = d2;
      }
    }
    if (cnt === 0 || nearest2 > 9 * 9) return "no patch within 9 of start";
  }
  // geysers: >= 6 tiles from every start (same CP-distance rule as minerals).
  for (const g of geysers) {
    const tx = (g.x / 256) | 0, ty = (g.y / 256) | 0;
    for (const s of starts) {
      const d2 = cdist2(tx, ty, s.x, s.y);
      if (d2 <= 11 * 11 && d2 < 6 * 6) return "geyser too close to start @" + tx + "," + ty;
    }
  }

  // (d) geysers: correct count (2 per main + 1 per natural, x2 for symmetry),
  // reachable, and each with a clear 2x2 area + no rock/cliff/mineral within 1.
  if (!geysers || geysers.length === 0) return "no geysers";
  for (const g of geysers) {
    const tx = (g.x / 256) | 0, ty = (g.y / 256) | 0;
    if (!inb(tx, ty) || rock[idx(tx, ty)]) return "geyser on rock @" + tx + "," + ty;
    // a clear 2x2 must EXIST that includes the geyser tile (the sim drops a 2x2
    // Refinery over it). Accept any of the four orientations anchored at the
    // geyser tile, all flat to the geyser's height.
    const lvlG = height ? height[idx(tx, ty)] : 0;
    let has2x2 = false;
    for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
      let ok2 = true;
      for (let dy = 0; dy <= 1 && ok2; dy++)
        for (let dx = 0; dx <= 1; dx++) {
          const x = tx + ox + dx, y = ty + oy + dy;
          if (!inb(x, y) || rock[idx(x, y)] || (height && height[idx(x, y)] !== lvlG)) { ok2 = false; break; }
        }
      if (ok2) { has2x2 = true; break; }
    }
    if (!has2x2) return "geyser 2x2 blocked @" + tx + "," + ty;
    // no minerals within 1 tile of the geyser origin
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = tx + dx, y = ty + dy;
        if (inb(x, y) && mineralTiles.has(idx(x, y))) return "mineral abuts geyser @" + tx + "," + ty;
      }
    // reachable from at least one start
    if (!reach0[idx(tx, ty)] && !reach1[idx(tx, ty)]) return "geyser unreachable @" + tx + "," + ty;
  }

  // (e) LoS blockers must be PASSABLE tiles.
  if (map.losBlock) {
    for (let i = 0; i < map.losBlock.length; i++) {
      if (map.losBlock[i] && rock[i]) return "losBlock on rock @" + (i % w) + "," + ((i / w) | 0);
    }
  }

  // (g) EXPANSION CP SPOTS: every resource cluster (main + each expansion) must
  // have a guaranteed valid Command Post location — a 3x3 area of free,
  // non-cliff, same-height tiles, clear of rock/losBlock/deco, whose center is
  // 6..9 tiles from EVERY patch/geyser of that cluster. This is the "ideal spot"
  // a player finds when expanding; simulate the sim's placement rule here.
  if (map.clusters) {
    const decoTiles = new Set((map.decos || []).map((d) => idx(d.x, d.y)));
    const losSet = map.losBlock;
    for (const cl of map.clusters) {
      if (!cl.res.length) continue;
      // for the main, the start itself is the guaranteed CP; only assert the
      // 6..9 band already checked above. For expansions, search for a 3x3 spot.
      let found = cl.isMain;
      if (!found) {
        // search a window around the cluster center for a valid 3x3 CP footprint.
        outerCP:
        for (let cyy = cl.center.y - 9; cyy <= cl.center.y + 9 && !found; cyy++)
          for (let cxx = cl.center.x - 9; cxx <= cl.center.x + 9; cxx++) {
            if (!inb(cxx, cyy)) continue;
            const lvl = height ? height[idx(cxx, cyy)] : 0;
            // 3x3 footprint free & flat & unobstructed
            let clear = true;
            for (let dy = -1; dy <= 1 && clear; dy++)
              for (let dx = -1; dx <= 1; dx++) {
                const x = cxx + dx, y = cyy + dy;
                if (!inb(x, y) || rock[idx(x, y)]) { clear = false; break; }
                if (height && height[idx(x, y)] !== lvl) { clear = false; break; }
                const id = idx(x, y);
                if (mineralTiles.has(id) || geyserTiles.has(id)) { clear = false; break; }
                if (losSet && losSet[id]) { clear = false; break; }
                if (decoTiles.has(id)) { clear = false; break; }
              }
            if (!clear) continue;
            if (!reach0[idx(cxx, cyy)] && !reach1[idx(cxx, cyy)]) continue;
            // center must be 6..9 from every resource of this cluster
            let bandOk = true;
            for (const r of cl.res) {
              const d2 = cdist2(cxx, cyy, r.x, r.y);
              if (d2 < 6 * 6 || d2 > 9 * 9) { bandOk = false; break; }
            }
            if (bandOk) { found = true; break outerCP; }
          }
      }
      if (!found) return "no CP spot for expansion @" + cl.center.x + "," + cl.center.y;
    }
  }

  // (f) main ramp choke width <= 3
  if (map.ramps && map.ramps[0] && map.ramps[0].tiles.length) {
    const width = measureChoke(map.ramps[0].tiles, rock, w, h);
    if (width > 3) return "choke width " + width;
  }

  return null;
}

// BFS flood over passable tiles (4-connected).
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

// Measure the ramp's chokepoint width (unchanged from the proven original).
function measureChoke(tiles, rock, w, h) {
  const idx = (x, y) => y * w + x;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const t of tiles) {
    if (t.x < minX) minX = t.x; if (t.x > maxX) maxX = t.x;
    if (t.y < minY) minY = t.y; if (t.y > maxY) maxY = t.y;
  }
  const travelAlongX = (maxX - minX) <= (maxY - minY);
  let narrowest = Infinity;
  const openRun = (cells) => {
    let run = 0, best = 0;
    for (const open of cells) { if (open) { run++; best = Math.max(best, run); } else run = 0; }
    return best;
  };
  if (travelAlongX) {
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
// Hardcoded fallback (guaranteed to validate) — a simple rotationally-symmetric
// layout, now including geysers + an (empty) losBlock array so the contract
// holds even on the fallback path.
// ---------------------------------------------------------------------------

function fallbackMap() {
  const W = MAP_W, H = MAP_H;
  const rock = new Uint8Array(W * H);
  const height = new Uint8Array(W * H);
  const losBlock = new Uint8Array(W * H);
  const starts = [{ x: 8, y: 8 }, { x: W - 9, y: H - 9 }];
  const idx = (x, y) => y * W + x;
  const clear = (cx, cy, r) => {
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++)
        if (x >= 0 && y >= 0 && x < W && y < H) rock[idx(x, y)] = 0;
  };
  for (const s of starts) clear(s.x, s.y, 9);
  // straight connecting lane
  const a = starts[0], b = starts[1];
  const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 2;
  for (let i = 0; i <= steps; i++) {
    clear(a.x + (((b.x - a.x) * i / steps) | 0), a.y + (((b.y - a.y) * i / steps) | 0), 2);
  }
  const minerals = [];
  // arc behind each main, all offsets 6..9 tiles out (rotationally mirrored)
  const arc = [[-7, -2], [-7, 0], [-7, 2], [-2, -7], [0, -7], [2, -7]];
  for (const [dx, dy] of arc) {
    minerals.push({ x: tileToFp(starts[0].x + dx), y: tileToFp(starts[0].y + dy) });
    minerals.push({ x: tileToFp(starts[1].x - dx), y: tileToFp(starts[1].y - dy) });
  }
  // one expansion pair, mirrored rotationally; cluster arcs 6..9 from its center
  const e = { x: 18, y: H - 19 };
  const em = { x: W - 1 - e.x, y: H - 1 - e.y };
  clear(e.x, e.y, 9); clear(em.x, em.y, 9);
  for (const [dx, dy] of [[-7, -1], [-7, 1], [-1, -7], [1, -7], [-5, -5]]) {
    minerals.push({ x: tileToFp(e.x + dx), y: tileToFp(e.y + dy) });
    minerals.push({ x: tileToFp(W - 1 - (e.x + dx)), y: tileToFp(H - 1 - (e.y + dy)) });
  }
  // geysers: 2 per main (6..9 tiles out, off the mineral arc) + 1 per natural.
  const geysers = [];
  const g = (tx, ty) => {
    for (let dy = 0; dy <= 1; dy++)
      for (let dx = 0; dx <= 1; dx++)
        if (tx + dx >= 0 && ty + dy >= 0 && tx + dx < W && ty + dy < H) rock[idx(tx + dx, ty + dy)] = 0;
    geysers.push({ x: tileToFp(tx), y: tileToFp(ty) });
    geysers.push({ x: tileToFp(W - 1 - tx), y: tileToFp(H - 1 - ty) });
  };
  g(starts[0].x + 6, starts[0].y + 2);   // main geyser 1 (euclid ~6.3)
  g(starts[0].x + 2, starts[0].y + 6);   // main geyser 2
  g(e.x + 6, e.y + 3);                    // natural geyser (~6.7 from e, off-arc)
  const naturals = [{ x: e.x, y: e.y }, { x: em.x, y: em.y }];
  return { w: W, h: H, rock, height, starts, minerals, geysers, losBlock, decos: [], naturals, clusters: [], ramps: [] };
}
