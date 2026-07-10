// Deterministic procedural map generation. Supports TWO symmetry modes so that
// spawns can be cross-map (180-degree rotational) OR same-edge/close
// (reflection across a center axis). Every tile that lands in rock/height/
// starts/minerals/geysers/losBlock/rampTiles/barrierKind is written through
// paired symmetric setters, so the battlefield is balanced BY CONSTRUCTION
// regardless of mode.
//
// The primary separation between areas is ELEVATION (cliff-walled height
// changes with ramps), not rock blobs — barriers are now organic, themed
// clumps that FRAME lanes and region borders rather than a uniform scatter.
//
// ELEVATION uses FOUR levels (0..3): lowland 0, naturals/mid-plateaus 1, mains
// 1-3 (varies by seed), decorative mesas up to 3. Every playable area stays
// reachable: ramps step through ONE level at a time (L <-> L+1, never skipping),
// cliff faces between different levels stay blocked, and the sim's LoS compares
// heights numerically so arbitrary levels "just work". The per-seed vertical
// PROFILE varies: some maps are mostly flat with one dramatic tier, some are
// terraced (0->1->2 toward each main), some inverted (high rim / low center).
//
// INTEGER-ONLY. Everything is driven exclusively by makeRng(seed) (+ resolved
// opts). Two calls with the same (seed, opts) are byte-identical (both
// multiplayer clients generate the map independently from a shared seed).
import { makeRng, tileToFp } from "./fixed.js";
import { MAP_W, MAP_H } from "./data.js";

// Visual themes. Shared with the renderer (palette, decoration tint, fog tint).
// Colors are plain integers (0xRRGGBB); the renderer owns their interpretation.
// "Chibi Sci-Fi" palette: bright, candy-saturated biomes under airy daytime
// skies. Internal names ("verdant"/"ashen"/"frozen") are UNCHANGED — barrier
// growth + terrain painting branch on these strings — only the colors moved to
// the new sunny identity. sky/fog are now light so distant terrain fades into a
// soft horizon instead of the old near-black void.
export const THEMES = [
  {
    name: "verdant",                                  // Meadow
    // Tones sit a step below full brightness so units, buildings and order
    // lines pop against the ground (playtest: max-bright washed everything out).
    ground: [86, 152, 88], groundHi: [128, 186, 118], patch: [24, 20, 6],
    rock: 0x8a929d, cliff: 0x68737f, cliffTop: [156, 162, 148],
    fog: 0xc4dcf2, sky: 0xaed6f2,
    deco: [0x7cd88c, 0xa8e8b2, 0x4fae63], // fresh flora greens
  },
  {
    name: "ashen",                                    // Sunbaked canyon
    ground: [178, 110, 70], groundHi: [206, 152, 96], patch: [40, 22, 10],
    rock: 0xa87048, cliff: 0x855436, cliffTop: [196, 142, 94],
    fog: 0xf2d2b2, sky: 0xf5c496,
    deco: [0xf0a058, 0xf5c47c, 0xd06c32], // warm blooms / hot rock
  },
  {
    name: "frozen",                                    // Glacier
    ground: [146, 180, 208], groundHi: [184, 210, 234], patch: [30, 42, 58],
    rock: 0x92a2b6, cliff: 0x748498, cliffTop: [178, 198, 220],
    fog: 0xdceefc, sky: 0xc6e4f8,
    deco: [0x8cd4f8, 0xc0e8fc, 0x64b4e2], // ice shards
  },
];

// Decoration kinds (renderer maps these to primitive-geometry props):
// 0 = crystal shard cluster, 1 = small rock pile, 2 = glowing flora tuft,
// 3 = tall shrub (LoS blocker marker — passable, blocks vision).
//
// Barrier kinds (renderer maps these to organic obstacle geometry). Set in the
// `barrierKind` array on every BLOCKED tile that is NOT a cliff face (cliffs are
// implied by height edges and get barrierKind 0):
//   1 = forest stand, 2 = lava fissure / basalt, 3 = ice spires, 4 = rock outcrop.
// Theme -> palette of kinds used (see barrierPaletteFor).
export const BARRIER_FOREST = 1, BARRIER_LAVA = 2, BARRIER_ICE = 3, BARRIER_ROCK = 4;

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
//
// Output map fields (shapes):
//   w, h            : ints (MAP_W, MAP_H)
//   rock            : Uint8Array(w*h)  nonzero = blocked (cliff face OR barrier)
//   height          : Uint8Array(w*h)  0..3 elevation level
//   rampTiles       : Uint8Array(w*h)  nonzero on passable level-transition tiles;
//                                       value = the HIGHER level it connects (1..3)
//   barrierKind     : Uint8Array(w*h)  1..4 on non-cliff blocked tiles, else 0
//   losBlock        : Uint8Array(w*h)  nonzero = blocks line of sight (passable)
//   starts          : [{x,y}, {x,y}]   tile coords of the two mains
//   minerals        : [{x,y}...]       fp tile-center coords
//   geysers         : [{x,y}...]       fp tile-center coords
//   decos           : [{x,y,kind}...]  kinds 0..3
//   naturals        : [{x,y}...]       tile coords (internal validation aid)
//   clusters        : [...]            resource clusters (internal validation aid)
//   ramps           : [{tiles:[...]}]  main-ramp tiles (internal choke check)
//   theme, themeName
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
  // Vertical PROFILE is resolved from this STABLE per-seed stream (not the
  // per-attempt build rng), so each seed keeps a consistent elevation character
  // across the 24 validation retries — this gives an even spread of profiles
  // over seeds instead of the retry loop biasing everything toward the easiest
  // (flat) profile. 0 flat, 1 terraced, 2 inverted, 3 mesa.
  const vProfile = r() % 4;
  return { spawns, expansions, losBlockers, theme, vProfile };
}

// Which barrier kinds a theme prefers, as a weighted bag (index 0 dominates).
// verdant: mostly forest + a little rock. ashen: mostly lava + rock.
// frozen: mostly ice + rock. Theme is resolved AFTER build, so we derive it the
// same way generateMap() will (seed-random unless pinned) to keep barriers
// theme-appropriate by construction.
function barrierPaletteFor(seed, resolvedTheme) {
  const t = resolvedTheme < 0 ? ((seed >>> 0) % THEMES.length) : (resolvedTheme % THEMES.length);
  if (t === 1) return { primary: BARRIER_LAVA, secondary: BARRIER_ROCK, secondaryChance: 4 }; // ashen
  if (t === 2) return { primary: BARRIER_ICE, secondary: BARRIER_ROCK, secondaryChance: 4 };  // frozen
  return { primary: BARRIER_FOREST, secondary: BARRIER_ROCK, secondaryChance: 5 };            // verdant
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
  const rampTiles = new Uint8Array(W * H);
  const barrierKind = new Uint8Array(W * H);
  const decos = [];

  const idx = (x, y) => y * W + x;
  const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

  const palette = barrierPaletteFor(seed, opts.theme);

  // ---- symmetry mode --------------------------------------------------------
  // "cross"  -> 180-degree rotational partner (opposite corners).
  // "close"  -> reflection across a center axis (same-edge spawns), which is
  //             the ONLY way to keep two same-edge spawns balanced.
  const mode = opts.spawns === "close" ? "reflect" : "rotate";
  const reflectAxis = mode === "reflect" ? (rng() & 1) : 0;

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
    if (!v) { barrierKind[idx(x, y)] = 0; barrierKind[idx(px, py)] = 0; } // clearing a tile clears its barrier tag
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
  const setRamp = (x, y, hi) => {
    if (!inb(x, y)) return;
    rampTiles[idx(x, y)] = hi;
    const [px, py] = partner(x, y);
    rampTiles[idx(px, py)] = hi;
  };
  // Mark a BLOCKED tile as a barrier of kind k (cliff faces call setRock only).
  const setBarrier = (x, y, k) => {
    if (!inb(x, y)) return;
    rock[idx(x, y)] = 1;
    barrierKind[idx(x, y)] = k;
    const [px, py] = partner(x, y);
    rock[idx(px, py)] = 1;
    barrierKind[idx(px, py)] = k;
  };
  const addDeco = (x, y, kind) => {
    if (!inb(x, y)) return;
    // Never place a deco on a ramp tile. Callers already check the primary
    // tile, but the symmetric mirror tile was previously pushed unchecked and
    // could land on the partner base's ramp — guard BOTH tiles here at source.
    if (rampTiles[idx(x, y)]) return;
    const [px, py] = partner(x, y);
    if (rampTiles[idx(px, py)]) return;
    decos.push({ x, y, kind });
    decos.push({ x: px, y: py, kind });
  };

  // ---- base placement style (variation axis #1) -----------------------------
  // Left at 6..11: with the enlarged plateauR=7, only the outermost cliff-ring
  // row can clip off a low-inset edge and the step-6 re-flatten keeps the top
  // uniform, so no extra inset is needed. Kept small so close spawns and the
  // center feature still fit; a base collision just fails validation and the
  // attempt loop retries deterministically with a fresh sub-seed.
  const inset = 6 + (rng() % 6);                    // 6..11 tiles from the edge
  let start0;
  if (mode === "reflect") {
    if (reflectAxis === 0) {
      const topEdge = (rng() & 1) === 0;
      const y = topEdge ? inset : H - 1 - inset;
      const x = Math.min((W >> 1) - 3, inset + (rng() % 4));
      start0 = { x, y };
    } else {
      const leftEdge = (rng() & 1) === 0;
      const x = leftEdge ? inset : W - 1 - inset;
      const y = Math.min((H >> 1) - 3, inset + (rng() % 4));
      start0 = { x, y };
    }
  } else {
    const style = rng() % 3;                         // 0 corner, 1/2 edge-middle
    if (style === 0) {
      const ne = (rng() & 1) === 1;
      start0 = ne ? { x: W - 1 - inset, y: inset } : { x: inset, y: inset };
    } else if (style === 1) {
      const topSide = (rng() & 1) === 0;
      start0 = { x: (W >> 2) + (rng() % 5) - 2, y: topSide ? inset : H - 1 - inset };
    } else {
      const leftSide = (rng() & 1) === 0;
      start0 = { x: leftSide ? inset : W - 1 - inset, y: (H >> 2) + (rng() % 5) - 2 };
    }
  }
  start0.x = clampTile(start0.x, W);
  start0.y = clampTile(start0.y, H);
  const [p1x, p1y] = partner(start0.x, start0.y);
  const start1 = { x: p1x, y: p1y };
  const starts = [start0, start1];

  const toCenter = (s) => {
    let dx = Math.sign((W >> 1) - s.x);
    let dy = Math.sign((H >> 1) - s.y);
    if (dx === 0 && dy === 0) { dx = 1; dy = 1; }
    if (dx === 0) dx = (s.x < (W >> 1)) ? 1 : -1;
    if (dy === 0) dy = (s.y < (H >> 1)) ? 1 : -1;
    return { dx, dy };
  };

  // ---- vertical PROFILE (variation axis #3, replaces old elevChar) ----------
  // Selects the whole-map elevation character so seeds feel distinct:
  //   0 "flat"     : mostly lowland, main is one modest tier (lvl 1), gentle
  //                  center rise. One dramatic mesa somewhere for flavour.
  //   1 "terraced" : the classic 0->1->2 climb toward each main; main high
  //                  (lvl 2-3), center a mid band. Lots of tiers.
  //   2 "inverted" : high rim toward the map edges, LOW center bowl. Mains high
  //                  (lvl 2), center band LOW so fights happen down in the pit.
  //   3 "mesa"     : mostly flat playfield but one or two tall decorative mesas
  //                  (lvl 3) framing the middle; main modest (lvl 1-2).
  // Resolved once per seed (stable across retries) — see resolveOpts.
  const vProfile = opts.vProfile;
  // main plateau level varies by profile AND seed within the allowed range.
  let mainHeight;
  if (vProfile === 0) mainHeight = 1;                       // flat: modest main
  else if (vProfile === 1) mainHeight = 2 + (rng() & 1);   // terraced: 2 or 3
  else if (vProfile === 2) mainHeight = 2;                 // inverted: high main
  else mainHeight = 1 + (rng() & 1);                       // mesa: 1 or 2

  // ---- 1. main plateau + cliff ring + stepped ramp --------------------------
  // Enlarged from 6 -> 7 so a maxed tech tree (Command Post + 2 depots + 3
  // barracks + factory + starport + 2 turrets + refineries, ~70 tiles of
  // footprint PLUS worker-pathing gaps) fits with room to spare. A 15x15 top
  // (225 tiles) leaves ~115+ genuinely-free build tiles after the mineral line,
  // geysers and ramp are counted out (see validate()).
  const plateauR = 7;                               // plateau half-extent (15x15 top)
  raisePlateau(start0, plateauR, mainHeight);

  const c0 = toCenter(start0);
  const laneCount = 1 + (rng() % 3);                // 1, 2 or 3 routes

  // Main ramp: 3-wide, STEPPED from the plateau top (mainHeight) down to lowland
  // one level at a time so it never skips a level. rampTiles marks each band.
  const rampMain = carveStepRamp(start0, plateauR, c0, 3, mainHeight, 0);

  // ---- 2. natural expansion (just outside the main ramp) --------------------
  // The natural sits at level 1 for terraced/inverted profiles (a mid step down
  // from a high main), else lowland 0. A ramp links it to the ramp foot.
  const natR = 4;                                   // natural half-extent (9x9); its r6 validation window already yields ~113 free tiles, comfortably matching the bigger main
  const natWidth = 4 + (rng() & 1);                 // 4 or 5 wide opening
  const natLvl = (vProfile === 1 || vProfile === 2) ? 1 : 0;
  const nat0 = {
    x: clampTile(start0.x + c0.dx * (plateauR + 6), W),
    y: clampTile(start0.y + c0.dy * (plateauR + 6), H),
  };
  ringExpansion(nat0, natR, c0, natWidth, natLvl);
  // If the natural is a tier above lowland, link its OUTWARD side to lowland
  // with a wide ramp so the lane onward stays traversable one level at a time.
  if (natLvl > 0) carveStepRamp(nat0, natR, c0, natWidth, natLvl, 0);

  // ---- 3. additional expansions (route-first: spread around the RIM) --------
  // Instead of marching expansions straight down the toward-center vector (which
  // dumped them into a single lane and read as "crammed"), place each extra
  // expansion on the map RIM, at a distinct ANGULAR position spread between this
  // main and its partner. We walk inward from a rim point until we find an open
  // pocket, so an expansion always sits in a sensible edge/pocket location — never
  // floating in the open middle of a lane. Player-0 owns placement; the partner()
  // setters mirror everything so both players get equivalent expansions.
  const extraPairs = opts.expansions;               // resolved 0/1/2
  const expansions = [nat0];
  {
    // Candidate rim anchors: points along the two map edges NOT occupied by the
    // mains, biased to player-0's half. We generate a deterministic ordered fan
    // of rim points and pick the first `extraPairs` that yield a clear pocket
    // sufficiently far from every other base and its own partner.
    const rimCandidates = rimAnchorFan(start0, c0, rng);
    let placed = 0;
    for (const rc of rimCandidates) {
      if (placed >= extraPairs) break;
      const ex = findExpansionPocket(rc, starts, nat0, expansions, plateauR, natR, partner, rng);
      if (!ex) continue;
      // extra expansions sit on lowland (flatten a pocket) so their CP is easy.
      for (let dy = -5; dy <= 5; dy++)
        for (let dx = -5; dx <= 5; dx++) { setHeight(ex.x + dx, ex.y + dy, 0); setRamp(ex.x + dx, ex.y + dy, 0); }
      clearArea3(ex, 3);
      expansions.push(ex);
      placed++;
    }
    // Fallback: if the rim fan couldn't seat enough pockets (tight geometry),
    // fill the remainder with the old perpendicular-offset placement so the
    // requested expansion count is still honoured and the attempt can validate.
    for (let e = placed; e < extraPairs; e++) {
      const reach = plateauR + 13 + e * 8 + (rng() % 4);
      const perp = perpOffset(c0, (e & 1) ? 6 : -6, rng);
      const ex = {
        x: clampTile(start0.x + c0.dx * reach + perp.x, W),
        y: clampTile(start0.y + c0.dy * reach + perp.y, H),
      };
      for (let dy = -5; dy <= 5; dy++)
        for (let dx = -5; dx <= 5; dx++) { setHeight(ex.x + dx, ex.y + dy, 0); setRamp(ex.x + dx, ex.y + dy, 0); }
      clearArea3(ex, 3);
      expansions.push(ex);
    }
  }

  // ---- 3b. RESERVE THE LANES (route-first core) -----------------------------
  // Before any center elevation or barrier growth, plan the pathways that join
  // every base and BOTH players, and reserve their tiles. Terrain features grow
  // AROUND this reserve so the routes stay clear and readable by construction.
  //   * spine     : nat0 -> map center -> nat1 (the direct central route).
  //   * flanks    : laneCount-1 spine copies offset perpendicular, so 2-3 lanes
  //                 you can trace by eye converge on the contested center.
  //   * spokes    : each extra expansion is linked to the nearest spine point so
  //                 no base is stranded off the lane network.
  // reserved[i] != 0 marks a lane tile; laneClear() later carves them open.
  const reserved = new Uint8Array(W * H);
  const [nat1x, nat1y] = partner(nat0.x, nat0.y);
  const cx0 = W >> 1, cy0 = H >> 1;
  const laneHalf = 2 + (rng() & 1);                 // 2 or 3 -> 5..7-wide lanes
  const reserveSeg = (ax, ay, bx, by, hw) => {
    const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2 || 1;
    for (let i = 0; i <= steps; i++) {
      const x = ax + (((bx - ax) * i / steps) | 0);
      const y = ay + (((by - ay) * i / steps) | 0);
      for (let dy = -hw; dy <= hw; dy++)
        for (let dx = -hw; dx <= hw; dx++) {
          const tx = x + dx, ty = y + dy;
          if (inb(tx, ty)) {
            reserved[idx(tx, ty)] = 1;
            const [px, py] = partner(tx, ty);
            reserved[idx(px, py)] = 1;
          }
        }
    }
  };
  // central spine (nat0 -> center -> nat1), plus perpendicular flanking copies.
  // Each half-spine BENDS through a waypoint pushed off the straight line so
  // routes read as gentle S-curves instead of ruler-straight corridors. The
  // l=0 bend waypoints are remembered as anchors for the enforced chokes.
  const spinePerp = { x: -c0.dy, y: c0.dx };
  const bendPts = [];
  const reserveBent = (ax, ay, bx, by, hw, record) => {
    const mx = (ax + bx) >> 1, my = (ay + by) >> 1;
    const pxs = -Math.sign(by - ay) || 1, pys = Math.sign(bx - ax) || 0;
    const amp = (3 + (rng() % 3)) * ((rng() & 1) ? 1 : -1);   // ±3..5 tiles
    const wx = clampTile(mx + pxs * amp, W), wy = clampTile(my + pys * amp, H);
    reserveSeg(ax, ay, wx, wy, hw);
    reserveSeg(wx, wy, bx, by, hw);
    if (record) bendPts.push({
      x: wx, y: wy,
      dir: { x: Math.sign(bx - ax), y: Math.sign(by - ay) },
    });
  };
  for (let l = 0; l < laneCount; l++) {
    // flank offset: 0, +sep, -sep, ... so lanes fan out symmetrically.
    const k = (l + 1) >> 1;
    const sgn = (l & 1) ? -1 : 1;
    const off = l === 0 ? 0 : sgn * k * (laneHalf * 2 + 3);
    const ox = spinePerp.x * off, oy = spinePerp.y * off;
    reserveBent(nat0.x + ox, nat0.y + oy, cx0 + ox, cy0 + oy, laneHalf, true);
    reserveBent(cx0 + ox, cy0 + oy, nat1x + ox, nat1y + oy, laneHalf, true);
  }
  // spokes: connect each extra expansion to the nearest point on the spine so it
  // is never stranded. We link toward the map center (a spine point always on it).
  for (const ex of expansions) {
    if (ex === nat0) continue;
    reserveSeg(ex.x, ex.y, cx0, cy0, laneHalf);
  }

  // ---- 4. center elevation feature (cliff-based separation) -----------------
  // A central high-ground ISLAND, cliff-walled, with `laneCount` STEPPED ramps.
  // Clamped to stay clear of protected base/natural zones so it always terraces
  // cleanly to lowland. The profile decides the island top level.
  const protectedNear = (x, y) => {
    if (!inb(x, y)) return true;
    for (const s of starts) if (Math.abs(x - s.x) <= plateauR + 2 && Math.abs(y - s.y) <= plateauR + 2) return true;
    if (Math.abs(x - nat0.x) <= natR + 2 && Math.abs(y - nat0.y) <= natR + 2) return true;
    const [pnx, pny] = partner(nat0.x, nat0.y);
    if (Math.abs(x - pnx) <= natR + 2 && Math.abs(y - pny) <= natR + 2) return true;
    for (const ex of expansions) if (ex !== nat0 && Math.abs(x - ex.x) <= 4 && Math.abs(y - ex.y) <= 4) return true;
    return false;
  };
  // Route-first: the center feature grows AROUND the reserved lanes. Its ramp
  // gaps are aligned to the lane directions and any cliff face that would fall on
  // a reserved tile is left as passable lowland, so the planned routes cross the
  // center as clear ground / stepped ramps rather than being walled off.
  const centerGaps = carveCenterElevation(rng, vProfile, laneCount, c0, protectedNear, reserved);

  // (decorative mesas are stamped AFTER resources are placed — see step 8b —
  // so raiseMesa can avoid burying any mineral/geyser tile.)

  // ---- 6. guarantee connectivity: CARVE every reserved lane -----------------
  // Open all reserved LOWLAND tiles so each planned route (central spine, flanks,
  // expansion spokes) is a clear, traceable path. Only lowland (height 0) tiles
  // are cleared — reserved tiles that coincide with a cliff face keep their wall
  // unless a ramp/gap already opened them, so elevation drama survives while the
  // routes stay connected. This generalizes the old single nat0<->nat1 clearLane.
  laneClear(reserved);

  // Re-assert build areas (later steps may have intruded).
  // Re-flatten the ENTIRE plateau top (full radius plateauR) to mainHeight (not
  // just clear rock): a neighbouring terrace/mesa/center-skirt can otherwise
  // leave a wedge of the 15x15 top at the wrong elevation, which the radius-7
  // validator counts OUT and can drop the guaranteed build area below 115.
  // Restamping the FULL top keeps it uniform and level with the start, and — by
  // covering the whole ±plateauR window — avoids introducing a passable
  // level-step at the top's own edge. rampTiles inside the top are cleared (the
  // ramp proper is re-cut just below via rampMain); the cliff ring at ±(plateauR+1)
  // is re-stamped in step 8c.
  for (let dy = -plateauR; dy <= plateauR; dy++)
    for (let dx = -plateauR; dx <= plateauR; dx++) {
      setHeight(start0.x + dx, start0.y + dy, mainHeight);
      setRamp(start0.x + dx, start0.y + dy, 0);
    }
  clearArea3(start0, plateauR - 1);
  ringExpansion(nat0, natR, c0, natWidth, natLvl);
  if (natLvl > 0) carveStepRamp(nat0, natR, c0, natWidth, natLvl, 0);
  for (const ex of expansions) if (ex !== nat0) clearArea3(ex, 3);
  for (const t of rampMain) { setRock(t.x, t.y, 0); }
  for (const g of centerGaps) setRock(g.x, g.y, 0); // keep center gaps open

  // ---- 7. geysers -----------------------------------------------------------
  const geysers = [];
  const geyserTiles = [];
  const placeGeyser = (tx, ty, ix, iy) => {
    if (!inb(tx, ty) || !inb(tx + ix, ty + iy)) return false;
    // Edge margin guard: keep 2x2 geyser at least 3 tiles from each border so
    // geysers never appear in corners or hard against the map edge. Nudge the
    // entire footprint inward if it violates the margin, then re-check inb.
    const GMARGIN = 3;
    const gMinX = Math.min(tx, tx + ix), gMaxX = Math.max(tx, tx + ix);
    const gMinY = Math.min(ty, ty + iy), gMaxY = Math.max(ty, ty + iy);
    let gdx = 0, gdy = 0;
    if (gMinX < GMARGIN) gdx = GMARGIN - gMinX;
    if (gMaxX >= W - GMARGIN) gdx = -(gMaxX - (W - 1 - GMARGIN));
    if (gMinY < GMARGIN) gdy = GMARGIN - gMinY;
    if (gMaxY >= H - GMARGIN) gdy = -(gMaxY - (H - 1 - GMARGIN));
    tx += gdx; ty += gdy;
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
    for (const gx of xs) for (const gy of ys) {
      geyserTiles.push({ x: gx, y: gy });
      const [ppx, ppy] = partner(gx, gy);
      geyserTiles.push({ x: ppx, y: ppy });
    }
    return { x: tx, y: ty };
  };

  const perpU = { x: -c0.dy, y: c0.dx };
  const gA = { x: start0.x + perpU.x * 4, y: start0.y + perpU.y * 4 };
  const gB = { x: start0.x - perpU.x * 4, y: start0.y - perpU.y * 4 };
  const mainGeyserA = placeGeyser(gA.x, gA.y, -perpU.x || c0.dx, -perpU.y || c0.dy) || null;
  const mainGeyserB = placeGeyser(gB.x, gB.y, perpU.x || c0.dx, perpU.y || c0.dy) || null;

  const ng = { x: clampTile(nat0.x - c0.dx * 4, W), y: clampTile(nat0.y - c0.dy * 4, H) };
  for (let dy = -1; dy <= 2; dy++)
    for (let dx = -1; dx <= 2; dx++) {
      const x = ng.x + dx, y = ng.y + dy;
      if (inb(x, y)) { setRock(x, y, 0); setHeight(x, y, natLvl); }
    }
  const natGeyser = placeGeyser(ng.x, ng.y, c0.dx || 1, c0.dy || 1) || null;

  // ---- 8. minerals ----------------------------------------------------------
  const minerals = [];
  const nearGeyser = (tx, ty) => {
    for (const gt of geyserTiles) {
      if (Math.abs(tx - gt.x) <= 1 && Math.abs(ty - gt.y) <= 1) return true;
    }
    return false;
  };
  const tdist2 = (ax, ay, bx2, by2) => { const dx = ax - bx2, dy = ay - by2; return dx * dx + dy * dy; };
  const clusters = [];
  const pushPatch = (tx, ty, base, cluster) => {
    if (!inb(tx, ty)) return;
    if (nearGeyser(tx, ty)) return;
    if (rampTiles[idx(tx, ty)]) return;              // never on a ramp
    const d2 = tdist2(tx, ty, base.x, base.y);
    if (d2 < 4 * 4 || d2 > 7 * 7) return;            // 4..7 tile band (inside plateau)
    if (rock[idx(tx, ty)] && height[idx(tx, ty)]) return; // don't punch cliffs
    // Ensure mineral sits on the same elevation as its base (fixes expansion
    // minerals landing on a cliff edge or different level than the base)
    const baseLvl = height[idx(base.x, base.y)] || 0;
    if (height[idx(tx, ty)] !== baseLvl) { setHeight(tx, ty, baseLvl); setRamp(tx, ty, 0); }
    setRock(tx, ty, 0);
    minerals.push({ x: tileToFp(tx), y: tileToFp(ty) });
    const [px, py] = partner(tx, ty);
    minerals.push({ x: tileToFp(px), y: tileToFp(py) });
    if (cluster) cluster.res.push({ x: tx, y: ty });
  };
  const bx = -c0.dx, by = -c0.dy;
  const arcStyle = rng() % 3;
  const mainArc = arcOffsets(bx, by, 7, arcStyle);
  const mainCluster = { center: { x: start0.x, y: start0.y }, res: [], isMain: true };
  clusters.push(mainCluster);
  for (const [ox, oy] of mainArc) pushPatch(start0.x + ox, start0.y + oy, start0, mainCluster);
  if (mainGeyserA) mainCluster.res.push(mainGeyserA);
  if (mainGeyserB) mainCluster.res.push(mainGeyserB);

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
    if (ei === 0 && natGeyser) exCluster.res.push(natGeyser);
  }

  // ---- 8c. re-assert main plateau cliff ring ------------------------------
  // Resource clearing (geysers/minerals) may have punched holes in the cliff
  // ring, creating alternate entrances. Re-stamp the ring to seal the base
  // perimeter, preserving only ramp tiles and resource tiles.
  for (let y = start0.y - plateauR - 1; y <= start0.y + plateauR + 1; y++)
    for (let x = start0.x - plateauR - 1; x <= start0.x + plateauR + 1; x++) {
      const edge = (x < start0.x - plateauR || x > start0.x + plateauR ||
                    y < start0.y - plateauR || y > start0.y + plateauR);
      if (!edge || !inb(x, y)) continue;
      if (rampTiles[idx(x, y)]) continue;             // keep ramp opening
      const hasRes = geyserTiles.some(gt => gt.x === x && gt.y === y) ||
                     minerals.some(m => ((m.x / 256) | 0) === x && ((m.y / 256) | 0) === y);
      if (hasRes) continue;
      setRock(x, y, 1); setHeight(x, y, mainHeight);
    }

  // ---- 8d. GOLD expansion pair (contested rich minerals mid-map) -------------
  // One symmetric pair of "gold" clusters: 4 rich patches in an open mid-map
  // pocket, far from every base, sitting on the lane network so the new chokes
  // make them fights. Sim spawns these with a bigger payout; skipped cleanly
  // when the geometry offers no safe pocket (rare — validated by stats).
  const golds = [];
  {
    const goldCandidates = [];
    for (const side of [1, -1])
      for (let r = 9; r <= 18; r += 3)
        goldCandidates.push({ x: cx0 + spinePerp.x * side * r, y: cy0 + spinePerp.y * side * r });
    for (let k = 8; k <= 14; k += 3)
      goldCandidates.push({ x: cx0 - c0.dx * k, y: cy0 - c0.dy * k });
    // only consider pockets reachable from the mains RIGHT NOW — a rim pocket
    // behind the center island's cliffs is a dead pocket no corridor can save
    const reachableNow = bfs(rock, W, H, start0.x, start0.y);
    for (const c of goldCandidates) {
      if (!inb(c.x, c.y)) continue;
      if (!reachableNow[idx(c.x, c.y)]) continue;
      // flat open lowland pocket (9x9) with room for a CP next to the patches
      let ok = true;
      for (let dy = -4; dy <= 4 && ok; dy++)
        for (let dx = -4; dx <= 4 && ok; dx++) {
          const x = c.x + dx, y = c.y + dy;
          if (!inb(x, y) || rock[idx(x, y)] || height[idx(x, y)] !== 0 || rampTiles[idx(x, y)]) ok = false;
        }
      if (!ok) continue;
      for (const s of starts) if (tdist2(c.x, c.y, s.x, s.y) < 14 * 14) ok = false;
      const [pn2x, pn2y] = partner(nat0.x, nat0.y);
      if (tdist2(c.x, c.y, nat0.x, nat0.y) < 11 * 11 || tdist2(c.x, c.y, pn2x, pn2y) < 11 * 11) ok = false;
      for (const ex of expansions) if (ex !== nat0 && tdist2(c.x, c.y, ex.x, ex.y) < 11 * 11) ok = false;
      const [gpx, gpy] = partner(c.x, c.y);
      if (tdist2(c.x, c.y, gpx, gpy) < 10 * 10) ok = false;   // clear of own mirror
      if (!ok) continue;
      const awx = Math.sign(c.x - cx0) || 1, awy = Math.sign(c.y - cy0) || 1;
      let placedPatches = 0;
      for (const [ox, oy] of arcOffsets(awx, awy, 5, arcStyle)) {
        if (placedPatches >= 4) break;
        const tx = c.x + ox, ty = c.y + oy;
        if (!inb(tx, ty) || rock[idx(tx, ty)] || rampTiles[idx(tx, ty)] ||
            height[idx(tx, ty)] !== 0 || nearGeyser(tx, ty)) continue;
        golds.push({ x: tileToFp(tx), y: tileToFp(ty) });
        const [px2, py2] = partner(tx, ty);
        golds.push({ x: tileToFp(px2), y: tileToFp(py2) });
        placedPatches++;
      }
      if (placedPatches < 3) { golds.length = 0; continue; }   // too cramped, try next pocket
      // reserve a corridor from the pocket to the lane network so barrier
      // growth (step 9) never seals the golds into a dead pocket
      reserveSeg(c.x, c.y, cx0, cy0, laneHalf);
      break;
    }
  }

  // ---- 8b. decorative mesas (extra vertical drama, per profile) -------------
  // flat/mesa profiles drop a tall standalone mesa pair off a flank so the
  // skyline isn't monotone. Purely decorative high ground (walled, no ramp) — it
  // never gates a lane, so it needs no reachability. Placed AFTER resources so
  // raiseMesa can refuse any footprint that would bury a mineral/geyser tile.
  if (vProfile === 0 || vProfile === 3) {
    const mesaCount = vProfile === 3 ? (1 + (rng() & 1)) : 1;
    for (let mi = 0; mi < mesaCount; mi++) {
      const mr = 3 + (rng() % 2);                    // radius 3..4
      const along = plateauR + 8 + (rng() % 6);
      const side = mi & 1 ? 1 : -1;
      const perpM = { x: -c0.dy, y: c0.dx };
      const mx = clampTile(start0.x + c0.dx * along + perpM.x * side * (7 + (rng() % 3)), W);
      const my = clampTile(start0.y + c0.dy * along + perpM.y * side * (7 + (rng() % 3)), H);
      // Keep the mesa's FULL footprint (its top radius mr + 1 cliff ring) clear of
      // the main plateau's radius-7 validation window and the natural. Guard on
      // EITHER axis (box overlap), and account for the mesa radius — a
      // clampTile() near a map edge can otherwise pull a mesa's skirt back onto
      // the enlarged plateau top and shave the guaranteed build area below 115.
      const mesaReach = mr + 1;
      if (Math.abs(mx - start0.x) <= plateauR + 1 + mesaReach &&
          Math.abs(my - start0.y) <= plateauR + 1 + mesaReach) continue;
      if (Math.abs(mx - nat0.x) <= natR + 1 + mesaReach &&
          Math.abs(my - nat0.y) <= natR + 1 + mesaReach) continue;
      raiseMesa({ x: mx, y: my }, mr, 3, minerals.concat(golds), geyserTiles); // tall level-3 mesa
    }
  }

  // ---- 9. ORGANIC THEMED BARRIERS (the aesthetic fix) -----------------------
  // Grow blobs by random-walk / cellular growth from seed points, 6-20 tiles
  // (forests up to 30), smooth away 1-tile freckles/holes, and place them along
  // region borders & lane edges (framing paths) rather than uniformly. Never
  // inside mining areas / CP spots / ramps. Sets barrierKind (+ rock via the
  // paired setter). This also RE-STAMPS the old "rock scatter" role: everything
  // that used to be a loose rock is now an organic outcrop (kind 4) or a themed
  // clump, so the renderer can retire the dodecahedron look everywhere.
  growBarriers(rng, palette, {
    W, H, idx, inb, partner, rock, height, rampTiles, losBlock,
    setBarrier, starts, expansions, naturalsR: natR, plateauR,
    geyserTiles, c0, minerals: minerals.concat(golds), addDeco, reserved,
  });

  // ---- 9b. ENFORCED CHOKES ---------------------------------------------------
  // Pinch the primary route at its bend waypoints down to a 3-4 tile corridor
  // with organic barrier walls on both flanks, so armies actually have to
  // funnel somewhere between the naturals and the center. partner() mirroring
  // keeps it balanced; the connectivity validator + retry loop guard against
  // an overzealous pinch. Only open flat lowland gets pinched — never ramps,
  // bases, or resource pockets.
  const chokes = [];
  {
    const nearRes = (x, y, r) => {
      for (const gt of geyserTiles) if (Math.abs(x - gt.x) <= r && Math.abs(y - gt.y) <= r) return true;
      for (const m of minerals.concat(golds)) {
        if (Math.abs(x - ((m.x / 256) | 0)) <= r && Math.abs(y - ((m.y / 256) | 0)) <= r) return true;
      }
      return false;
    };
    const [pnat0x, pnat0y] = partner(nat0.x, nat0.y);
    // pad=0 keeps walls out of the bases' inner build room only; the corridor
    // uses a bigger pad so the open lane never hugs a base edge.
    const baseClear = (x, y, pad) => {
      for (const s of starts) if (Math.abs(x - s.x) <= plateauR + 1 + pad && Math.abs(y - s.y) <= plateauR + 1 + pad) return false;
      if (Math.abs(x - nat0.x) <= natR - 1 + pad && Math.abs(y - nat0.y) <= natR - 1 + pad) return false;
      if (Math.abs(x - pnat0x) <= natR - 1 + pad && Math.abs(y - pnat0y) <= natR - 1 + pad) return false;
      for (const ex of expansions) if (ex !== nat0 && Math.abs(x - ex.x) <= 4 + pad && Math.abs(y - ex.y) <= 4 + pad) return false;
      return true;
    };
    const flatOpen = (x, y) =>
      inb(x, y) && height[idx(x, y)] === 0 && !rampTiles[idx(x, y)] && !nearRes(x, y, 2);
    const corridorOk = (x, y) => flatOpen(x, y) && baseClear(x, y, 1);
    const wallOk = (x, y) => flatOpen(x, y) && baseClear(x, y, 0);
    let stamped = 0;
    for (const bp of bendPts) {
      if (stamped >= 2) break;
      const d = bp.dir;
      const p = { x: -d.y, y: d.x };                  // route-perpendicular
      if (!p.x && !p.y) continue;
      const diag = p.x !== 0 && p.y !== 0;
      const chokeW = 3 + (rng() & 1);                 // 3 or 4 wide corridor
      const clearA = (chokeW - 1) >> 1, clearB = chokeW - 1 - clearA;
      const wallDepth = 3;
      // slide along the route to find a spot where corridor AND wall tiles are
      // all stampable open lowland
      let anchor = null;
      for (const k of [0, 2, -2, 4, -4, 6, -6, 8, -8, 10, -10]) {
        const px0 = bp.x + d.x * k, py0 = bp.y + d.y * k;
        let ok = true;
        for (let a = -1; a <= 1 && ok; a++) {
          for (let t = -clearA; t <= clearB && ok; t++)
            if (!corridorOk(px0 + p.x * t + d.x * a, py0 + p.y * t + d.y * a)) ok = false;
          for (let t = 1; t <= wallDepth && ok; t++) {
            if (!wallOk(px0 + p.x * (clearB + t) + d.x * a, py0 + p.y * (clearB + t) + d.y * a)) ok = false;
            if (!wallOk(px0 - p.x * (clearA + t) + d.x * a, py0 - p.y * (clearA + t) + d.y * a)) ok = false;
          }
        }
        if (ok) { anchor = { x: px0, y: py0 }; break; }
      }
      if (!anchor) continue;
      // snapshot so a pinch that severs anything can be rolled back wholesale
      const rockBackup = rock.slice(), bkBackup = barrierKind.slice();
      // stamp: clear the corridor, wall the flanks. For diagonal routes the
      // p-steps skip lattice cells, so each wall tile also stamps a filler
      // neighbor — otherwise units zigzag straight through the "wall".
      const stampWall = (x, y) => {
        if (!wallOk(x, y)) return;
        const kind = (rng() % palette.secondaryChance) === 0 ? palette.secondary : palette.primary;
        setBarrier(x, y, kind);
        if (diag && wallOk(x + p.x, y)) setBarrier(x + p.x, y, kind);
      };
      for (let a = -1; a <= 1; a++) {
        for (let t = -clearA; t <= clearB; t++) {
          const x = anchor.x + p.x * t + d.x * a, y = anchor.y + p.y * t + d.y * a;
          setRock(x, y, 0);
          if (diag) setRock(x + p.x, y, 0);
        }
        for (let t = 1; t <= wallDepth; t++) {
          stampWall(anchor.x + p.x * (clearB + t) + d.x * a, anchor.y + p.y * (clearB + t) + d.y * a);
          stampWall(anchor.x - p.x * (clearA + t) + d.x * a, anchor.y - p.y * (clearA + t) + d.y * a);
        }
      }
      // the pinch must not sever ANYTHING: both mains, every expansion pocket
      // and every gold patch must stay mutually reachable, or we roll back
      const reach = bfs(rock, W, H, start0.x, start0.y);
      let intact = reach[idx(start1.x, start1.y)] !== 0;
      for (const g of golds) if (intact && !reach[idx((g.x / 256) | 0, (g.y / 256) | 0)]) intact = false;
      for (const ex of expansions) if (intact && !reach[idx(ex.x, ex.y)]) intact = false;
      if (!intact) { rock.set(rockBackup); barrierKind.set(bkBackup); continue; }
      const [cpx, cpy] = partner(anchor.x, anchor.y);
      // partner perp must mirror with the map so validation scans along the
      // mirrored corridor, not across its walls
      const mp = mode === "rotate" ? p
               : reflectAxis === 0 ? { x: -p.x, y: p.y }
               :                     { x: p.x, y: -p.y };
      chokes.push({ x: anchor.x, y: anchor.y, px: p.x, py: p.y, w: chokeW });
      chokes.push({ x: cpx, y: cpy, px: mp.x, py: mp.y, w: chokeW });
      stamped++;
    }
  }

  // ---- 10. line-of-sight blockers -------------------------------------------
  if (opts.losBlockers) {
    placeLosBlockers(rng, setLos, addDeco, rock, height, losBlock, rampTiles, W, H,
      starts, expansions, geyserTiles, c0, plateauR, natR, partner);
  }

  // ---- 11. decorations (non-blocking, sparse near bases/lanes) --------------
  const decoDensity = rng() % 3;
  scatterDecos(rng, addDeco, rock, height, losBlock, barrierKind, rampTiles, W, H, starts, expansions, decoDensity);

  const [natPx, natPy] = partner(nat0.x, nat0.y);
  const naturals = [{ x: nat0.x, y: nat0.y }, { x: natPx, y: natPy }];

  // Final gold sweep: if any later feature (mesa, barrier blob, choke wall)
  // sealed the gold pockets off after placement, drop the golds entirely —
  // a missing bonus beats an unreachable one.
  if (golds.length) {
    const finalReach = bfs(rock, W, H, start0.x, start0.y);
    for (const g of golds) {
      if (!finalReach[idx((g.x / 256) | 0, (g.y / 256) | 0)]) { golds.length = 0; break; }
    }
  }

  return {
    w: W, h: H, rock, height, rampTiles, barrierKind,
    starts, minerals, geysers, losBlock, decos,
    golds,                                           // rich contested patches (fp coords)
    chokes,                                          // enforced route pinches (validation)
    naturals, clusters,                              // clusters/naturals: internal only
    ramps: [{ tiles: rampMain, alongX: Math.abs(c0.dx) >= Math.abs(c0.dy) }],
    vProfile,                                        // internal: variety logging
    // theme filled in by generateMap()
  };

  // ---- local terrain-shaping helpers (close over rock/height writers) ------

  function raisePlateau(s, r, lvl) {
    for (let y = s.y - r; y <= s.y + r; y++)
      for (let x = s.x - r; x <= s.x + r; x++) setHeight(x, y, lvl);
    for (let y = s.y - r - 1; y <= s.y + r + 1; y++)
      for (let x = s.x - r - 1; x <= s.x + r + 1; x++) {
        const edge = (x < s.x - r || x > s.x + r || y < s.y - r || y > s.y + r);
        if (edge && inb(x, y)) { setHeight(x, y, lvl); setRock(x, y, 1); }
      }
    // ---- organic edge jitter (medium strength) ----
    // Parameter-derived seed so no rng advance; fold coords for symmetry.
    const jSeed = ((s.x * 374761393 + s.y * 668265263 + r * 295075153 + lvl * 1276523) | 0) >>> 0;
    for (let y = s.y - r - 1; y <= s.y + r + 1; y++)
      for (let x = s.x - r - 1; x <= s.x + r + 1; x++) {
        const dx = x - s.x, dy = y - s.y;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (dist !== r + 1) continue;          // ring tiles only
        if (!inb(x, y)) continue;
        if (!rock[idx(x, y)]) continue;         // already passable (ramp corridor)
        // Fold to canonical half — same hash for both symmetric partners.
        let sx = x, sy = y;
        if (mode === "rotate") { sx = Math.min(x, W - 1 - x); sy = Math.min(y, H - 1 - y); }
        else if (reflectAxis === 0) { sx = Math.min(x, W - 1 - x); }
        else { sy = Math.min(y, H - 1 - y); }
        const h = (((sx + 500) * 374761393 + (sy + 500) * 668265263 + jSeed) | 0) >>> 0;
        const roll = h % 100;
        // Dominant-axis outward normal for protrusions.
        const ax = Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : 0;
        const ay = Math.abs(dy) > Math.abs(dx) ? Math.sign(dy) : 0;
        if (roll < 14) {
          // outward protrusion: extend cliff face one tile outward
          const px = x + (ax || Math.sign(dx)), py = y + (ay || Math.sign(dy));
          if (inb(px, py) && !rock[idx(px, py)] && !rampTiles[idx(px, py)]) {
            setHeight(px, py, lvl); setRock(px, py, 1);
          }
        } else if (roll < 28) {
          // inward erosion: open ring tile (only safe for single-level step)
          if (lvl === 1) { setRock(x, y, 0); }
          else {
            // For lvl>=2, check if any outward 4-neighbour is passable at lvl-1.
            for (const [sdx, sdy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx2 = x + sdx, ny2 = y + sdy;
              if (!inb(nx2, ny2) || rock[idx(nx2, ny2)]) continue;
              if (height[idx(nx2, ny2)] === lvl - 1) { setRock(x, y, 0); break; }
            }
          }
        } else if (roll < 35) {
          // corner softening: at corner-adjacent positions, step down or open
          const cornerish = Math.abs(dx) >= r - 1 && Math.abs(dy) >= r - 1;
          if (cornerish) {
            if (lvl === 1) { setRock(x, y, 0); }
            else if (lvl >= 2) { setHeight(x, y, lvl - 1); /* keep rock=1 — stepped corner */ }
          }
        }
      }
  }

  // A standalone decorative mesa: level `lvl` top, cliff-ringed, NO ramp (it is
  // pure scenery and never needs to be reachable). Only stamps where it won't
  // collide with resources so it never walls a patch in.
  function raiseMesa(s, r, lvl, minerals, geyserTiles) {
    // bail if any resource sits under the mesa footprint (incl. cliff ring)
    for (let y = s.y - r - 1; y <= s.y + r + 1; y++)
      for (let x = s.x - r - 1; x <= s.x + r + 1; x++) {
        if (!inb(x, y)) continue;
        for (const m of minerals) if (((m.x / 256) | 0) === x && ((m.y / 256) | 0) === y) return;
        for (const g of geyserTiles) if (g.x === x && g.y === y) return;
      }
    for (let y = s.y - r; y <= s.y + r; y++)
      for (let x = s.x - r; x <= s.x + r; x++) setHeight(x, y, lvl);
    for (let y = s.y - r - 1; y <= s.y + r + 1; y++)
      for (let x = s.x - r - 1; x <= s.x + r + 1; x++) {
        const edge = (x < s.x - r || x > s.x + r || y < s.y - r || y > s.y + r);
        if (edge && inb(x, y)) { setHeight(x, y, lvl); setRock(x, y, 1); }
      }
    // ---- organic edge jitter (medium strength, mesa-safe: NO inward erosion) ----
    // Mesas sit at lvl=3 on lowland; opening a cliff face would skip 3 levels.
    // Only outward protrusions + corner height-lowering are safe.
    {
      const jSeed = ((s.x * 374761393 + s.y * 668265263 + r * 295075153 + lvl * 1276523 + 0x1e5a) | 0) >>> 0;
      for (let y = s.y - r - 1; y <= s.y + r + 1; y++)
        for (let x = s.x - r - 1; x <= s.x + r + 1; x++) {
          const dx = x - s.x, dy = y - s.y;
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          if (dist !== r + 1) continue;
          if (!inb(x, y)) continue;
          if (!rock[idx(x, y)]) continue;
          // Skip near ramp tiles (mesas are placed away from ramps, but be safe).
          if (rampTiles[idx(x, y)]) continue;
          // Symmetric hash.
          let sx = x, sy = y;
          if (mode === "rotate") { sx = Math.min(x, W - 1 - x); sy = Math.min(y, H - 1 - y); }
          else if (reflectAxis === 0) { sx = Math.min(x, W - 1 - x); }
          else { sy = Math.min(y, H - 1 - y); }
          const h = (((sx + 500) * 374761393 + (sy + 500) * 668265263 + jSeed) | 0) >>> 0;
          const roll = h % 100;
          const ax = Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : 0;
          const ay = Math.abs(dy) > Math.abs(dx) ? Math.sign(dy) : 0;
          if (roll < 14) {
            // outward protrusion — always safe, just extends the cliff one tile
            const px = x + (ax || Math.sign(dx)), py = y + (ay || Math.sign(dy));
            if (inb(px, py) && !rock[idx(px, py)] && !rampTiles[idx(px, py)]) {
              // Also check the protrusion won't bury a resource.
              let hitsRes = false;
              for (const m of minerals) if (((m.x / 256) | 0) === px && ((m.y / 256) | 0) === py) { hitsRes = true; break; }
              if (!hitsRes) for (const g of geyserTiles) if (g.x === px && g.y === py) { hitsRes = true; break; }
              if (!hitsRes) { setHeight(px, py, lvl); setRock(px, py, 1); }
            }
          } else if (roll < 30) {
            // corner softening: lower height on corner-adjacent cliff faces
            const cornerish = Math.abs(dx) >= r - 1 && Math.abs(dy) >= r - 1;
            if (cornerish && lvl >= 2) {
              // Step the corner down by one level (still impassable cliff).
              setHeight(x, y, lvl - 1);
              // For lvl==2 corners, opening at lvl-1 (=1) may be safe if outside is 0.
              // But we stay conservative: keep rock=1, just lower the height.
            }
          }
          // NO inward erosion branch — never open a mesa cliff face to lowland.
        }
    }
  }

  // Carve a `width`-wide STEPPED ramp through the cliff ring on the side facing
  // `dir`, descending one level per band from `topLvl` down to `botLvl`. Returns
  // all passable ramp tiles. rampTiles is tagged with the HIGHER level of each
  // adjacent transition so the renderer can stripe every step. Cliff shoulders
  // pinch the mouth so the corridor reads exactly `width` wide.
  //
  // Band layout (travelling outward along `dir`):
  //   band k (k = topLvl-1 .. botLvl) is 2 tiles deep at level (k) ... but to
  //   keep the choke measurement simple and guarantee adjacency we lay ONE tile
  //   per intermediate level plus a 2-tile foot, all at `width`.
  function carveStepRamp(s, r, dir, width, topLvl, botLvl) {
    const tiles = [];
    const half = width >> 1;
    const alongX = Math.abs(dir.dx) >= Math.abs(dir.dy);
    // sequence of levels from the ring outward: topLvl-1, topLvl-2, ... botLvl
    const levels = [];
    for (let l = topLvl - 1; l >= botLvl; l--) levels.push(l);
    if (!levels.length) levels.push(botLvl);        // topLvl==botLvl: single foot
    // step 0 is the ring column/row itself, cut to topLvl (top-of-ramp lip).
    if (alongX) {
      const rx = s.x + dir.dx * (r + 1);
      // shoulders block just beyond the ramp so the choke reads `width`. They are
      // set to the ramp lip's level so they read as CLIFF FACES (raised ground),
      // not floating lowland walls.
      setRock(rx, s.y - (half + 1), 1); setHeight(rx, s.y - (half + 1), topLvl);
      setRock(rx, s.y + (half + 1), 1); setHeight(rx, s.y + (half + 1), topLvl);
      // ring lip at topLvl (top of the ramp, walkable)
      for (let k = -half; k <= half; k++) {
        const y = s.y + k;
        setRock(rx, y, 0); setHeight(rx, y, topLvl); setRamp(rx, y, topLvl);
        tiles.push({ x: rx, y });
      }
      // each successive column outward drops one level; tag the transition with
      // the higher of the two adjacent levels. Shoulders take the step's level.
      let col = rx;
      let prevLvl = topLvl;
      for (const lvl of levels) {
        col += dir.dx;
        for (let k = -half; k <= half; k++) {
          const y = s.y + k;
          setRock(col, y, 0); setHeight(col, y, lvl); setRamp(col, y, Math.max(prevLvl, lvl));
          tiles.push({ x: col, y });
        }
        if (lvl > 0) {                                 // shoulder is a cliff face at this level
          setRock(col, s.y - (half + 1), 1); setHeight(col, s.y - (half + 1), lvl);
          setRock(col, s.y + (half + 1), 1); setHeight(col, s.y + (half + 1), lvl);
        }
        prevLvl = lvl;
      }
      // a final 2-tile foot at botLvl to blend into the lowland (extra depth so
      // units have room to queue at the ramp base).
      col += dir.dx;
      for (let k = -half; k <= half; k++) {
        const y = s.y + k;
        setRock(col, y, 0); setHeight(col, y, botLvl);
        tiles.push({ x: col, y });
      }
    } else {
      const ry = s.y + dir.dy * (r + 1);
      setRock(s.x - (half + 1), ry, 1); setHeight(s.x - (half + 1), ry, topLvl);
      setRock(s.x + (half + 1), ry, 1); setHeight(s.x + (half + 1), ry, topLvl);
      for (let k = -half; k <= half; k++) {
        const x = s.x + k;
        setRock(x, ry, 0); setHeight(x, ry, topLvl); setRamp(x, ry, topLvl);
        tiles.push({ x, y: ry });
      }
      let row = ry;
      let prevLvl = topLvl;
      for (const lvl of levels) {
        row += dir.dy;
        for (let k = -half; k <= half; k++) {
          const x = s.x + k;
          setRock(x, row, 0); setHeight(x, row, lvl); setRamp(x, row, Math.max(prevLvl, lvl));
          tiles.push({ x, y: row });
        }
        if (lvl > 0) {
          setRock(s.x - (half + 1), row, 1); setHeight(s.x - (half + 1), row, lvl);
          setRock(s.x + (half + 1), row, 1); setHeight(s.x + (half + 1), row, lvl);
        }
        prevLvl = lvl;
      }
      row += dir.dy;
      for (let k = -half; k <= half; k++) {
        const x = s.x + k;
        setRock(x, row, 0); setHeight(x, row, botLvl);
        tiles.push({ x, y: row });
      }
    }
    return tiles;
  }

  // Ring a lowland/mid expansion on three sides, leaving a wide gap toward
  // `dir`. `lvl` sets the interior elevation (0 lowland, 1 mid step). When the
  // natural is LOWLAND (lvl 0) the ring can't be a cliff (no height edge), so its
  // wall tiles are tagged rock-outcrop BARRIERS (kind 4) that frame the natural.
  // When lvl>0 the ring is a genuine cliff face (raised interior vs lowland).
  function ringExpansion(s, r, dir, gapWidth, lvl) {
    clearArea3(s, r);
    for (let y = s.y - r; y <= s.y + r; y++)
      for (let x = s.x - r; x <= s.x + r; x++) setHeight(x, y, lvl);
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
        if (inGap) continue;
        if (lvl > 0) { setHeight(x, y, lvl); setRock(x, y, 1); }   // cliff face
        else { setHeight(x, y, 0); setBarrier(x, y, 4); }           // outcrop wall
      }
    // ---- organic edge jitter (medium strength) — only on cliff-face rings (lvl>0) ----
    if (lvl > 0) {
      const jSeed = ((s.x * 374761393 + s.y * 668265263 + r * 295075153 + lvl * 1276523 + 0x0ff1) | 0) >>> 0;
      for (let y = s.y - r - 1; y <= s.y + r + 1; y++)
        for (let x = s.x - r - 1; x <= s.x + r + 1; x++) {
          const dx = x - s.x, dy = y - s.y;
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          if (dist !== r + 1) continue;
          if (!inb(x, y)) continue;
          if (!rock[idx(x, y)]) continue;         // already passable (gap / ramp)
          // In-gap check (mirrors the gap test above).
          let inGap;
          if (Math.abs(dir.dx) >= Math.abs(dir.dy)) {
            inGap = Math.sign(x - s.x) === dir.dx && Math.abs(y - s.y) <= half;
          } else {
            inGap = Math.sign(y - s.y) === dir.dy && Math.abs(x - s.x) <= half;
          }
          if (inGap) continue;
          // Skip tiles 4-adjacent to the gap so the corridor stays crisp.
          let nearGap = false;
          for (const [sdx, sdy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            let ng;
            const nx = x + sdx, ny = y + sdy;
            if (Math.abs(dir.dx) >= Math.abs(dir.dy)) {
              ng = Math.sign(nx - s.x) === dir.dx && Math.abs(ny - s.y) <= half;
            } else {
              ng = Math.sign(ny - s.y) === dir.dy && Math.abs(nx - s.x) <= half;
            }
            if (ng) { nearGap = true; break; }
          }
          if (nearGap) continue;
          // Symmetric hash.
          let sx = x, sy = y;
          if (mode === "rotate") { sx = Math.min(x, W - 1 - x); sy = Math.min(y, H - 1 - y); }
          else if (reflectAxis === 0) { sx = Math.min(x, W - 1 - x); }
          else { sy = Math.min(y, H - 1 - y); }
          const h = (((sx + 500) * 374761393 + (sy + 500) * 668265263 + jSeed) | 0) >>> 0;
          const roll = h % 100;
          const ax = Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : 0;
          const ay = Math.abs(dy) > Math.abs(dx) ? Math.sign(dy) : 0;
          if (roll < 14) {
            // outward protrusion
            const px = x + (ax || Math.sign(dx)), py = y + (ay || Math.sign(dy));
            if (inb(px, py) && !rock[idx(px, py)] && !rampTiles[idx(px, py)]) {
              setHeight(px, py, lvl); setRock(px, py, 1);
            }
          } else if (roll < 28) {
            // inward erosion: only for lvl==1; for lvl>=2 check neighbour
            if (lvl === 1) { setRock(x, y, 0); }
            else {
              for (const [sdx, sdy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx2 = x + sdx, ny2 = y + sdy;
                if (!inb(nx2, ny2) || rock[idx(nx2, ny2)]) continue;
                if (height[idx(nx2, ny2)] === lvl - 1) { setRock(x, y, 0); break; }
              }
            }
          } else if (roll < 35) {
            // corner softening
            const cornerish = Math.abs(dx) >= r - 1 && Math.abs(dy) >= r - 1;
            if (cornerish) {
              if (lvl === 1) { setRock(x, y, 0); }
              else if (lvl >= 2) { setHeight(x, y, lvl - 1); }
            }
          }
        }
    }
  }

  // Raise a central high-ground ISLAND (a square plateau centred on the map),
  // walled by proper CLIFF FACES and reachable via `lanes` STEPPED ramps. This
  // separates the halves by ELEVATION, not by rock walls, and gives the mid-map
  // a dramatic tier without spilling into base/natural territory.
  //
  // The island top is a square (Chebyshev radius `topR`); level steps down by
  // the Chebyshev distance out of that square, terracing to lowland on every
  // side. Non-gap staircase tiles are CLIFF FACES (blocked, one level apart from
  // the passable tile just outside them). Gap tiles are a passable stepped ramp.
  // The whole footprint is CLAMPED to stay clear of protected zones (bases,
  // naturals) so its terraced skirt always reaches level 0 in open ground — this
  // guarantees no abrupt level jump anywhere on the passable graph.
  function carveCenterElevation(r, prof, lanes, cdir, protectedNear, reserved) {
    const cx = W >> 1, cy = H >> 1;
    const gaps = [];
    const isReserved = (x, y) => reserved && inb(x, y) && reserved[idx(x, y)];
    // top level varies by profile: flat modest (1), else a dramatic (2..3).
    const bandLvl = prof === 0 ? 1 : (prof === 1 ? 2 + (r() & 1) : 2);
    const faceDepth = bandLvl;                        // staircase rows per side
    // largest half-extent that keeps the FULL terraced footprint clear of any
    // protected zone and inside the map. Shrink until safe.
    let topR = 5;
    const footFits = (R) => {
      const ext = R + faceDepth;
      if (cx - ext < 2 || cx + ext > W - 3 || cy - ext < 2 || cy + ext > H - 3) return false;
      for (let dy = -ext; dy <= ext; dy++)
        for (let dx = -ext; dx <= ext; dx++)
          if (protectedNear(cx + dx, cy + dy)) return false;
      return true;
    };
    while (topR >= 2 && !footFits(topR)) topR--;
    if (topR < 2) return gaps;                        // no room: skip the feature (rare)
    const outer = topR + faceDepth;

    // ramp directions: pick `lanes` of the 4 cardinal sides to punch ramps.
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    // rotate the side list deterministically so the chosen sides vary per seed.
    const rot = r() % 4;
    const chosen = [];
    for (let i = 0; i < lanes && i < 4; i++) chosen.push(sides[(rot + i) % 4]);
    const gapHalfW = [];
    for (let i = 0; i < chosen.length; i++) gapHalfW.push(1 + (r() % 2)); // 2..5 wide

    // is (dx,dy) offset-from-center inside a ramp corridor? corridor runs along
    // the chosen side axis, centred on that axis, `gapHalfW` wide on the cross.
    const inGap = (dx, dy) => {
      for (let i = 0; i < chosen.length; i++) {
        const [sx, sy] = chosen[i];
        if (sx !== 0) {                                // ramp on left/right side
          if (Math.sign(dx) === sx && Math.abs(dy) <= gapHalfW[i]) return true;
        } else {                                       // ramp on top/bottom side
          if (Math.sign(dy) === sy && Math.abs(dx) <= gapHalfW[i]) return true;
        }
      }
      return false;
    };

    const outDist = (dx, dy) => Math.max(
      Math.max(0, Math.abs(dx) - topR),
      Math.max(0, Math.abs(dy) - topR),
    );

    for (let dy = -outer; dy <= outer; dy++)
      for (let dx = -outer; dx <= outer; dx++) {
        const x = cx + dx, y = cy + dy;
        if (!inb(x, y)) continue;
        const step = outDist(dx, dy);                  // 0 = top, 1.. = staircase
        const lvl = Math.max(0, bandLvl - step);
        setHeight(x, y, lvl);
        const onTop = step === 0;
        const onStair = step >= 1 && lvl > 0;
        if (inGap(dx, dy) || isReserved(x, y)) {
          // ramp gap OR a reserved lane tile: keep it PASSABLE so the planned
          // route crosses the center as a stepped ramp (never walled). Bands step
          // one level at a time, so the corridor stays skip-free.
          setRock(x, y, 0);
          if (lvl > 0) setRamp(x, y, lvl);
          if (onTop || onStair) gaps.push({ x, y });
        } else if (onTop) {
          setRock(x, y, 0);                            // island top: walkable
        } else if (onStair) {
          setRock(x, y, 1);                            // cliff face: blocked
        } else {
          setRock(x, y, 0);                            // lowland skirt
        }
      }

    // ---- edge jitter: organically open some staircase cliff faces to soften
    //      the perfectly-Chebyshev look. Only tiles on the stair bands (NOT the
    //      top plateau, NOT the lowland skirt, NOT ramp gaps or any tile 4-
    //      adjacent to a ramp gap) are eligible. The level bands step one level
    //      at a time so opening a cliff face never creates a level skip.
    //      Magnitude: ~1 tile of boundary wobble, deterministic per position. ----
    const jitterSeed = (r() ^ 0xbe1f) | 0;
    for (let dy = -outer; dy <= outer; dy++)
      for (let dx = -outer; dx <= outer; dx++) {
        const x = cx + dx, y = cy + dy;
        if (!inb(x, y)) continue;
        if (!rock[idx(x, y)]) continue;              // already passable (ramp or top)
        const step = outDist(dx, dy);
        if (step < 1) continue;                      // not a stair tile
        const lvl = Math.max(0, bandLvl - step);
        if (lvl <= 0) continue;                      // lowland skirt (not a cliff face)
        // Never touch ramp corridors or tiles beside them (keep ramps crisp).
        if (inGap(dx, dy)) continue;
        let nearGap = false;
        for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (inGap(dx + sx, dy + sy)) { nearGap = true; break; }
        }
        if (nearGap) continue;
        // Deterministic per-tile jitter: ~25 % of cliff faces become passable.
        const h = (((dx + 500) * 374761393 + (dy + 500) * 668265263 + jitterSeed) | 0) >>> 0;
        if ((h % 100) < 25) {
          setRock(x, y, 0);
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
          if (inb(tx, ty) && height[idx(tx, ty)] === 0) setRock(tx, ty, 0);
        }
    }
  }

  // Route-first lane carver: open every reserved LOWLAND tile so the planned
  // pathways are clear ground. Elevated reserved tiles are left alone (a ramp/gap
  // already opened the ones that must be passable), so cliffs framing the lane
  // survive. Deterministic: iterates the mask in a fixed order.
  function laneClear(reserved) {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (!reserved[idx(x, y)]) continue;
        if (height[idx(x, y)] === 0) setRock(x, y, 0);
      }
  }

  // Deterministic fan of RIM anchor points, biased to the arc "between" this main
  // and the map center, for seating extra expansions around the edges. Returns
  // ordered {x,y} rim tiles (player-0 side); the caller mirrors via partner().
  function rimAnchorFan(s, dir, r) {
    const cands = [];
    const M = 5;                                     // edge margin
    // Base the fan on the perpendicular-to-center direction so anchors spread
    // across the flanks rather than piling behind the main.
    const perp = { x: -dir.dy, y: dir.dx };
    // Two seed rim points: perpendicular flanks projected to the nearest edges,
    // plus the far mid-edges. We enumerate a handful of rim tiles and jitter.
    const push = (x, y) => {
      const cx = clampTile(x, W), cy = clampTile(y, H);
      cands.push({ x: cx, y: cy });
    };
    // flank rim points: from the main, go perpendicular toward each edge.
    push(s.x + perp.x * 20 + dir.dx * 6, s.y + perp.y * 20 + dir.dy * 6);
    push(s.x - perp.x * 20 + dir.dx * 6, s.y - perp.y * 20 + dir.dy * 6);
    // mid-edge rim points near the center band (good "side" expansions).
    push((W >> 1) + perp.x * 22, (H >> 1) + perp.y * 22);
    push((W >> 1) - perp.x * 22, (H >> 1) - perp.y * 22);
    // a deterministic jittered ordering so seeds differ but stay reproducible.
    const rot = r() % cands.length;
    const ordered = [];
    for (let i = 0; i < cands.length; i++) ordered.push(cands[(rot + i) % cands.length]);
    // clamp all into the playable interior with the edge margin.
    for (const c of ordered) {
      c.x = Math.max(M, Math.min(W - 1 - M, c.x));
      c.y = Math.max(M, Math.min(H - 1 - M, c.y));
    }
    return ordered;
  }

  // Walk inward from a rim anchor until we find a pocket whose 11x11 footprint is
  // far enough from every base (and the anchor's own partner) to seat an
  // expansion. Returns {x,y} or null. Deterministic (fixed inward stepping).
  function findExpansionPocket(rc, starts, nat0, expansions, plateauR, natR, partner, r) {
    const toCx = Math.sign((W >> 1) - rc.x), toCy = Math.sign((H >> 1) - rc.y);
    const jx = (r() % 3) - 1, jy = (r() % 3) - 1;
    for (let step = 0; step <= 10; step++) {
      const x = clampTile(rc.x + toCx * step + jx, W);
      const y = clampTile(rc.y + toCy * step + jy, H);
      let ok = true;
      // clear of both mains
      for (const s of starts) if (Math.abs(x - s.x) <= plateauR + 6 && Math.abs(y - s.y) <= plateauR + 6) { ok = false; break; }
      if (ok) {
        // clear of the natural and its partner
        const [pnx, pny] = partner(nat0.x, nat0.y);
        if ((Math.abs(x - nat0.x) <= natR + 9 && Math.abs(y - nat0.y) <= natR + 9) ||
            (Math.abs(x - pnx) <= natR + 9 && Math.abs(y - pny) <= natR + 9)) ok = false;
      }
      if (ok) {
        // clear of already-placed expansions and their partners
        for (const e of expansions) {
          if (e === nat0) continue;
          const [pex, pey] = partner(e.x, e.y);
          if ((Math.abs(x - e.x) <= 12 && Math.abs(y - e.y) <= 12) ||
              (Math.abs(x - pex) <= 12 && Math.abs(y - pey) <= 12)) { ok = false; break; }
        }
      }
      if (ok) {
        // clear of this pocket's OWN partner (close spawns can fold it back).
        const [px, py] = partner(x, y);
        if (Math.abs(x - px) <= 12 && Math.abs(y - py) <= 12) ok = false;
      }
      if (ok) return { x, y };
    }
    return null;
  }

  function clampTile(v, n) { return Math.max(2, Math.min(n - 3, v)); }

  function perpOffset(dir, mag, r) {
    const px = -dir.dy, py = dir.dx;
    const jitter = (r() % 3) - 1;
    return { x: (px * mag) + jitter, y: (py * mag) - jitter };
  }
}

// ---------------------------------------------------------------------------
// Organic themed barriers
// ---------------------------------------------------------------------------

// Grow organic barrier blobs and stamp them into rock/barrierKind. Strategy:
//   * pick SEED points that frame lanes / region borders (biased to the gaps
//     between protected zones), in player-0's half only (partner mirrors).
//   * grow each seed by cellular random-walk to 6..20 tiles (forests up to 30).
//   * smooth: fill 1-tile holes, remove 1-tile freckles (isolated single tiles).
//   * refuse any tile inside a PROTECTED zone (bases, naturals, expansions,
//     mining arcs, CP search windows, ramps, geyser pads) or on an existing
//     cliff/height (barriers live on LOWLAND borders, framing the flat routes).
// Forest stands (kind 1) may run larger and double as soft walls.
function growBarriers(rng, palette, ctx) {
  const {
    W, H, idx, inb, partner, rock, height, rampTiles, losBlock,
    setBarrier, starts, expansions, naturalsR, plateauR, geyserTiles,
    minerals, addDeco, reserved,
  } = ctx;

  // Protected: no barrier tile may land here. Generous margins so blobs frame
  // (not block) the economy. Mining arcs reach ~9 tiles from a base center.
  const mineralSet = new Set(minerals.map((m) => ((m.y / 256) | 0) * W + ((m.x / 256) | 0)));
  const protectedAt = (x, y) => {
    if (!inb(x, y)) return true;
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return true;
    const i = idx(x, y);
    if (rampTiles[i]) return true;                    // never on a ramp
    if (rock[i]) return true;                         // already blocked (cliff)
    if (reserved && reserved[i]) return true;         // never ON a reserved lane (keep routes clear)
    if (mineralSet.has(i)) return true;
    // keep clear of every base main (mining arc radius) and expansion. The main
    // margin is plateauR+4 (not +3): the cliff ring outer face sits at plateauR+1,
    // so this leaves a >=2-tile clean lowland gap around the enlarged plateau and
    // avoids a 1-tile buildable sliver pinched between the plateau edge and a barrier.
    for (const s of starts) if (Math.abs(x - s.x) <= plateauR + 4 && Math.abs(y - s.y) <= plateauR + 4) return true;
    for (const e of expansions) if (Math.abs(x - e.x) <= naturalsR + 4 && Math.abs(y - e.y) <= naturalsR + 4) return true;
    for (const g of geyserTiles) if (Math.abs(x - g.x) <= 2 && Math.abs(y - g.y) <= 2) return true;
    return false;
  };

  // A barrier tile must sit on LOWLAND (height 0) AND must not 4-touch a passable
  // tile of a different height — otherwise it would read as (and be validated as)
  // a CLIFF face rather than an organic wall. It MAY sit beside a blocked cliff
  // face (height>0, impassable), which is exactly how barriers frame a region
  // border. This keeps the cliff/barrier distinction crisp.
  const touchesRaisedPassable = (x, y) => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!inb(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (!rock[ni] && height[ni] !== 0) return true;
    }
    return false;
  };
  const canGrow = (x, y) => !protectedAt(x, y) && height[idx(x, y)] === 0 && !touchesRaisedPassable(x, y);

  // Seed anchors: bias toward the mid-band region borders and lane EDGES. We
  // scan player-0's half for lowland tiles adjacent to a cliff/height edge or
  // near the vertical center — those are natural "framing" spots — then pick a
  // deterministic subset. Fall back to open lowland if few edges exist.
  // A lane-adjacent lowland tile is the BEST framing spot: it lines a route
  // without blocking it. We rank anchors: laneEdge (touches a reserved tile) >
  // cliffEdge (touches raised terrain) > open.
  const laneEdgeAnchors = [];
  const edgeAnchors = [];
  const openAnchors = [];
  const halfH = H >> 1;
  const touchesReserved = (x, y) => {
    if (!reserved) return false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (inb(nx, ny) && reserved[idx(nx, ny)]) return true;
    }
    return false;
  };
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      if (!canGrow(x, y)) continue;
      // player-0 side only (roughly): take the lexically-first half so the
      // partner setter fills the mirror. Use a diagonal split that works for
      // both rotate and reflect modes: keep y in the top half OR (y==mid & left).
      if (y > halfH) continue;
      if (touchesReserved(x, y)) { laneEdgeAnchors.push({ x, y }); continue; }
      // is this tile beside a height edge? (a border to frame)
      let edge = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (inb(nx, ny) && height[idx(nx, ny)] > 0) { edge = true; break; }
      }
      (edge ? edgeAnchors : openAnchors).push({ x, y });
    }
  }

  // How many blobs. Framed layout: enough to line the routes without clogging.
  const blobCount = 7 + (rng() % 6);                  // 7..12 blob pairs
  const pick = (arr) => arr.length ? arr[rng() % arr.length] : null;

  for (let b = 0; b < blobCount; b++) {
    // Route-first framing priority: lane-edge anchors first (line the routes),
    // then cliff-edge (frame region borders), then open. ~55% lane-edge when
    // available, ~30% cliff-edge, remainder open — so barriers read as framing
    // the readable lanes rather than a uniform scatter.
    const roll = rng() % 10;
    let anchor = null;
    if (laneEdgeAnchors.length && roll < 6) anchor = pick(laneEdgeAnchors);
    else if (edgeAnchors.length && roll < 9) anchor = pick(edgeAnchors);
    else anchor = pick(openAnchors) || pick(edgeAnchors) || pick(laneEdgeAnchors);
    if (!anchor) break;

    // kind: mostly the theme primary, occasionally the secondary (rock).
    const useSecondary = (rng() % 10) < (10 - palette.secondaryChance) ? false : true;
    const kind = useSecondary ? palette.secondary : palette.primary;
    // forests can be larger and double as soft walls.
    const maxTiles = kind === 1 ? (12 + (rng() % 19)) : (6 + (rng() % 10)); // forest 12..30, else 6..15
    const targetTiles = Math.max(6, maxTiles);

    // Grow via cellular random-walk. Keep an explicit member set; each step add
    // a lowland neighbour of a current member. Stop at targetTiles or stall.
    const members = [];
    const memberSet = new Set();
    const tryAdd = (x, y) => {
      if (memberSet.has(idx(x, y))) return false;
      if (!canGrow(x, y)) return false;
      // don't merge into the partner half prematurely (keep player-0 side); the
      // setter mirrors. Allow crossing the mid line a little for organic shape,
      // but skip a tile whose partner is already a member (avoid double count).
      const [px, py] = partner(x, y);
      if (memberSet.has(idx(px, py))) return false;
      members.push({ x, y });
      memberSet.add(idx(x, y));
      return true;
    };
    if (!tryAdd(anchor.x, anchor.y)) continue;

    let guard = targetTiles * 12;
    while (members.length < targetTiles && guard-- > 0) {
      const m = members[rng() % members.length];
      // weighted 4-neighbour walk (organic, slightly directional per blob)
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const d = dirs[rng() % 4];
      tryAdd(m.x + d[0], m.y + d[1]);
    }
    if (members.length < 6) continue;                 // too small; skip (avoids freckles)

    // ---- smoothing: build a local mask, fill 1-tile holes, drop freckles ----
    // Bounding box of the blob (+1 margin) for a local grid.
    let minX = W, minY = H, maxX = 0, maxY = 0;
    for (const m of members) {
      if (m.x < minX) minX = m.x; if (m.x > maxX) maxX = m.x;
      if (m.y < minY) minY = m.y; if (m.y > maxY) maxY = m.y;
    }
    minX = Math.max(1, minX - 1); minY = Math.max(1, minY - 1);
    maxX = Math.min(W - 2, maxX + 1); maxY = Math.min(H - 2, maxY + 1);
    const gw = maxX - minX + 1, gh = maxY - minY + 1;
    const mask = new Uint8Array(gw * gh);
    const li = (x, y) => (y - minY) * gw + (x - minX);
    for (const m of members) mask[li(m.x, m.y)] = 1;
    const occ = (x, y) => (x >= minX && y >= minY && x <= maxX && y <= maxY) ? mask[li(x, y)] : 0;
    // fill 1-tile holes: an empty growable tile with >=3 occupied 4-neighbours.
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        if (occ(x, y)) continue;
        if (!canGrow(x, y)) continue;
        let n = occ(x + 1, y) + occ(x - 1, y) + occ(x, y + 1) + occ(x, y - 1);
        if (n >= 3) mask[li(x, y)] = 1;
      }
    // drop freckles: occupied tile with 0 occupied 4-neighbours -> remove.
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        if (!occ(x, y)) continue;
        let n = occ(x + 1, y) + occ(x - 1, y) + occ(x, y + 1) + occ(x, y - 1);
        if (n === 0) mask[li(x, y)] = 0;
      }

    // ---- stamp the smoothed blob ----
    let stamped = 0;
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        if (!occ(x, y)) continue;
        if (!canGrow(x, y)) continue;                 // re-check (protection is authoritative)
        setBarrier(x, y, kind);
        stamped++;
      }
    // (stamped forests double as soft walls; no extra losBlock is added here so
    // the LoS layer stays owned entirely by the shrub blockers in step 10.)
  }
}

// ---------------------------------------------------------------------------
// LoS blockers
// ---------------------------------------------------------------------------

// Place 2-4 symmetric passable shrub patches (3-6 tiles each) near lanes /
// expansion approaches, never inside main/natural mining areas. Writes losBlock
// (via setLos) and one deco kind 3 per tile.
function placeLosBlockers(rng, setLos, addDeco, rock, height, losBlock, rampTiles, W, H,
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
  const nat = expansions[0];
  const cx = W >> 1, cy = H >> 1;
  let placed = 0;
  for (let attempt = 0; attempt < patchCount * 12 && placed < patchCount; attempt++) {
    const t = 20 + (rng() % 60);
    let ax = nat.x + (((cx - nat.x) * t / 100) | 0);
    let ay = nat.y + (((cy - nat.y) * t / 100) | 0);
    ax += (rng() % 9) - 4;
    ay += (rng() % 9) - 4;
    if (ax < 3 || ay < 3 || ax >= W - 3 || ay >= H - 3) continue;
    const size = 3 + (rng() % 4);
    const tiles = [];
    const seen = new Set();
    for (let k = 0; k < size; k++) {
      const px = ax + (rng() % 3) - 1;
      const py = ay + (rng() % 3) - 1;
      if (px < 2 || py < 2 || px >= W - 2 || py >= H - 2) continue;
      if (rock[idx(px, py)]) continue;                // must be passable
      if (rampTiles[idx(px, py)]) continue;           // never on a ramp
      if (height[idx(px, py)] >= 2) continue;         // not on high mesa
      if (nearMineOrBase(px, py)) continue;
      if (losBlock[idx(px, py)]) continue;
      if (onAxis(px, py)) continue;
      if (seen.has(idx(px, py))) continue;
      seen.add(idx(px, py));
      tiles.push({ x: px, y: py });
    }
    if (!tiles.length) continue;
    for (const tl of tiles) {
      if (losBlock[idx(tl.x, tl.y)]) continue;
      setLos(tl.x, tl.y, 1);
      addDeco(tl.x, tl.y, 3);
    }
    placed++;
  }
}

// ---------------------------------------------------------------------------
// Shared offset tables (module-level, deterministic)
// ---------------------------------------------------------------------------

function arcOffsets(dx, dy, n, style = 0) {
  const bases = [
    [[5, -3], [5, -1], [5, 1], [5, 3], [4, -4], [4, 4], [5, 0]],
    [[5, -2], [5, 0], [5, 2], [4, -3], [4, 3], [4, 4], [3, 5]],
    [[4, -4], [4, 4], [5, -2], [5, 2], [4, 3], [3, 4], [5, 0]],
  ];
  const base = bases[style % bases.length];
  const out = [];
  for (let i = 0; i < n && i < base.length; i++) {
    const [a, b] = base[i];
    out.push(rotateOffset(a, b, dx, dy));
  }
  return out;
}

function rotateOffset(a, b, dx, dy) {
  const sx = dx === 0 ? 1 : Math.sign(dx);
  const sy = dy === 0 ? 1 : Math.sign(dy);
  return [a * sx, b * sy];
}

function scatterDecos(rng, addDeco, rock, height, losBlock, barrierKind, rampTiles, W, H, starts, expansions, density) {
  const idx = (x, y) => y * W + x;
  const nearBaseOrLane = (x, y) => {
    for (const s of starts) if (Math.abs(x - s.x) + Math.abs(y - s.y) < 6) return true;
    for (const e of expansions) if (Math.abs(x - e.x) + Math.abs(y - e.y) < 5) return true;
    return false;
  };
  const base = density === 0 ? 24 : (density === 1 ? 40 : 60);
  const count = base + (rng() % 16);
  for (let i = 0; i < count; i++) {
    const x = 2 + (rng() % (W - 4));
    const y = 2 + (rng() % ((H >> 1) - 2));
    if (rock[idx(x, y)]) continue;                    // no props on cliffs/rock/barriers
    if (barrierKind[idx(x, y)]) continue;             // never inside a barrier
    if (rampTiles[idx(x, y)]) continue;               // never on a ramp
    if (height[idx(x, y)] >= 2) continue;             // not on high mesas
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
  const { w, h, rock, height, rampTiles, barrierKind, starts, minerals, geysers } = map;
  const idx = (x, y) => y * w + x;
  const inb = (x, y) => x >= 0 && y >= 0 && x < w && y < h;

  for (const s of starts) {
    if (!inb(s.x, s.y) || rock[idx(s.x, s.y)]) return "start blocked";
  }

  const reach0 = bfs(rock, w, h, starts[0].x, starts[0].y);
  if (!reach0[idx(starts[1].x, starts[1].y)]) return "A cannot reach B";
  const reach1 = bfs(rock, w, h, starts[1].x, starts[1].y);

  const mineralTiles = new Set(minerals.map((m) => ((m.y / 256) | 0) * w + ((m.x / 256) | 0)));
  const geyserTiles = new Set((geysers || []).map((g) => ((g.y / 256) | 0) * w + ((g.x / 256) | 0)));
  for (const s of starts) {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = s.x + dx, y = s.y + dy;
        if (!inb(x, y) || rock[idx(x, y)]) return "3x3 not clear";
      }
    const lvl = height ? height[idx(s.x, s.y)] : 0;
    let plateauFree = 0;
    for (let dy = -7; dy <= 7; dy++)
      for (let dx = -7; dx <= 7; dx++) {
        const x = s.x + dx, y = s.y + dy;
        if (!inb(x, y) || rock[idx(x, y)]) continue;
        if (height && height[idx(x, y)] !== lvl) continue;
        const id = idx(x, y);
        if (mineralTiles.has(id) || geyserTiles.has(id)) continue;
        if (!reach0[id] && !reach1[id]) continue;
        plateauFree++;
      }
    // Raised 70 -> 115: a maxed tech tree (~70 tiles of footprint) plus the
    // worker-pathing gaps and build-grid slack between structures needs this much
    // genuinely-free room. The radius-7 window matches the enlarged plateauR=7
    // top (15x15) exactly, and minerals/geysers/ramp/off-level tiles are all
    // counted OUT above, so this is real building space.
    if (plateauFree < 115) return "main plateau too small (" + plateauFree + ")";
  }

  if (map.naturals) {
    for (const n of map.naturals) {
      let free = 0, reachable = false;
      for (let dy = -6; dy <= 6; dy++)
        for (let dx = -6; dx <= 6; dx++) {
          const x = n.x + dx, y = n.y + dy;
          if (!inb(x, y) || rock[idx(x, y)]) continue;
          const id = idx(x, y);
          // the natural's interior must connect to the main passable graph so
          // both players can expand there (barriers/rings must never seal it).
          if (reach0[id] || reach1[id]) reachable = true;
          if (mineralTiles.has(id) || geyserTiles.has(id)) continue;
          free++;
        }
      // Raised 50 -> 80: the natural now needs room for a Command Post plus a
      // handful of production/defense structures, not just a deposit. The r6
      // window (13x13) around a natR=4 ring already yields ~113 free, so this is
      // comfortably satisfied without enlarging the ring.
      if (free < 80) return "natural too small (" + free + ")";
      if (!reachable) return "natural walled off @" + n.x + "," + n.y;
    }
  }

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

  const cdist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
  for (const s of starts) {
    let nearest2 = Infinity, cnt = 0;
    for (const m of minerals) {
      const tx = (m.x / 256) | 0, ty = (m.y / 256) | 0;
      const d2 = cdist2(tx, ty, s.x, s.y);
      if (d2 <= 11 * 11) {
        cnt++;
        if (d2 < 4 * 4) return "patch too close to start @" + tx + "," + ty + " (d2=" + d2 + ")";
        if (d2 < nearest2) nearest2 = d2;
      }
    }
    if (cnt === 0 || nearest2 > 9 * 9) return "no patch within 9 of start";
  }
  for (const g of geysers) {
    const tx = (g.x / 256) | 0, ty = (g.y / 256) | 0;
    for (const s of starts) {
      const d2 = cdist2(tx, ty, s.x, s.y);
      if (d2 <= 11 * 11 && d2 < 4 * 4) return "geyser too close to start @" + tx + "," + ty;
    }
  }

  if (!geysers || geysers.length === 0) return "no geysers";
  for (const g of geysers) {
    const tx = (g.x / 256) | 0, ty = (g.y / 256) | 0;
    if (!inb(tx, ty) || rock[idx(tx, ty)]) return "geyser on rock @" + tx + "," + ty;
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
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = tx + dx, y = ty + dy;
        if (inb(x, y) && mineralTiles.has(idx(x, y))) return "mineral abuts geyser @" + tx + "," + ty;
      }
    if (!reach0[idx(tx, ty)] && !reach1[idx(tx, ty)]) return "geyser unreachable @" + tx + "," + ty;
  }

  if (map.losBlock) {
    for (let i = 0; i < map.losBlock.length; i++) {
      if (map.losBlock[i] && rock[i]) return "losBlock on rock @" + (i % w) + "," + ((i / w) | 0);
    }
  }

  // ---- NEW: height range 0..3 ----
  if (height) {
    for (let i = 0; i < height.length; i++) {
      if (height[i] > 3) return "height >3 @" + (i % w) + "," + ((i / w) | 0);
    }
  }

  // ---- NEW: ramp tiles are passable, adjacent-level-only, tagged correctly ---
  // Every rampTiles>0 tile must be passable (not rock). Its value must equal a
  // level in 1..3. And every passable height transition between two DIFFERENT
  // levels must be a single step (|dh|==1) — enforcing "ramps never skip a
  // level" over the whole passable graph.
  if (rampTiles) {
    for (let i = 0; i < rampTiles.length; i++) {
      if (!rampTiles[i]) continue;
      if (rock[i]) return "ramp on rock @" + (i % w) + "," + ((i / w) | 0);
      if (rampTiles[i] > 3) return "ramp value >3 @" + (i % w) + "," + ((i / w) | 0);
    }
  }
  // passable adjacency step check: any two 4-adjacent PASSABLE tiles differ by
  // at most 1 level (a bigger jump would be an un-ramped skip). Cliff faces are
  // rock=1 (impassable) so they are excluded — those are legitimate walls.
  if (height) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (rock[idx(x, y)]) continue;
        const hh = height[idx(x, y)];
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const nx = x + dx, ny = y + dy;
          if (!inb(nx, ny) || rock[idx(nx, ny)]) continue;
          if (Math.abs(hh - height[idx(nx, ny)]) > 1) return "level skip @" + x + "," + y + "->" + nx + "," + ny;
        }
      }
  }

  // ---- NEW: barrierKind exactly on non-cliff blocked tiles, no freckles ------
  // Classification (consistent with the generator, which tags organic blobs via
  // setBarrier and leaves structural walls untagged):
  //   * passable tile        -> barrierKind must be 0.
  //   * blocked, kind != 0   -> a BARRIER: must be lowland (height 0), kind 1..4,
  //                             and have >=1 barrier neighbour (no freckles).
  //   * blocked, kind == 0   -> a CLIFF FACE: must be genuine raised-terrain wall
  //                             (height > 0) OR border a different-height passable
  //                             tile. A lowland wall bordering only same-height
  //                             passable ground would be an untagged barrier (bug).
  if (barrierKind) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = idx(x, y);
        if (!rock[i]) {
          if (barrierKind[i]) return "barrierKind on passable @" + x + "," + y;
          continue;
        }
        if (barrierKind[i]) {
          // BARRIER
          if (barrierKind[i] > 4) return "barrierKind >4 @" + x + "," + y;
          if (height && height[i] !== 0) return "barrier not on lowland @" + x + "," + y;
          let bn = 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy;
            if (inb(nx, ny) && barrierKind[idx(nx, ny)]) bn++;
          }
          if (bn === 0) return "barrier freckle @" + x + "," + y;
        } else {
          // CLIFF FACE — must be structural (raised or bordering a height edge).
          const myLvl = height ? height[i] : 0;
          if (myLvl > 0) continue;
          let edge = false;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy;
            if (!inb(nx, ny)) continue;
            const ni = idx(nx, ny);
            if (!rock[ni] && height && height[ni] !== myLvl) { edge = true; break; }
          }
          if (!edge) return "untagged lowland wall @" + x + "," + y;
        }
      }
  }

  // ---- NEW: no barrier inside mining areas / CP spots / ramps ----
  if (barrierKind) {
    // mineral/geyser tiles must never be barriers (they are cleared) — and no
    // barrier may sit ON a mineral/geyser or on a ramp tile.
    for (let i = 0; i < barrierKind.length; i++) {
      if (!barrierKind[i]) continue;
      if (mineralTiles.has(i) || geyserTiles.has(i)) return "barrier on resource @" + (i % w);
      if (rampTiles && rampTiles[i]) return "barrier on ramp @" + (i % w) + "," + ((i / w) | 0);
    }
  }

  // (g) EXPANSION CP SPOTS.
  if (map.clusters) {
    const decoTiles = new Set((map.decos || []).map((d) => idx(d.x, d.y)));
    const losSet = map.losBlock;
    for (const cl of map.clusters) {
      if (!cl.res.length) continue;
      let found = cl.isMain;
      if (!found) {
        outerCP:
        for (let cyy = cl.center.y - 9; cyy <= cl.center.y + 9 && !found; cyy++)
          for (let cxx = cl.center.x - 9; cxx <= cl.center.x + 9; cxx++) {
            if (!inb(cxx, cyy)) continue;
            const lvl = height ? height[idx(cxx, cyy)] : 0;
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
                if (barrierKind && barrierKind[id]) { clear = false; break; }
              }
            if (!clear) continue;
            if (!reach0[idx(cxx, cyy)] && !reach1[idx(cxx, cyy)]) continue;
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

  // (f) main ramp choke width. The main ramp is carved 3-wide; STEPPED ramps for
  // taller plateaus can measure marginally wider, so the ceiling is the permitted
  // <= 4. The travel axis is passed explicitly (the stepped corridor's along
  // extent would otherwise fool the extent heuristic).
  if (map.ramps && map.ramps[0] && map.ramps[0].tiles.length) {
    const width = measureChoke(map.ramps[0].tiles, rock, w, h, map.ramps[0].alongX);
    if (width > 4) return "choke width " + width;      // hard ceiling widened to 4
  }

  // (g) enforced route chokes: the corridor at every recorded pinch must be
  // open and 2..6 tiles wide along its perpendicular (3-4 by construction;
  // slack tolerates a neighboring blob merging into a wall).
  if (map.chokes) {
    for (const c of map.chokes) {
      if (!inb(c.x, c.y) || rock[idx(c.x, c.y)]) return "choke center blocked @" + c.x + "," + c.y;
      let wdt = 1;
      for (let t = 1; t <= 8; t++) {
        const x = c.x + c.px * t, y = c.y + c.py * t;
        if (!inb(x, y) || rock[idx(x, y)]) break;
        wdt++;
      }
      for (let t = 1; t <= 8; t++) {
        const x = c.x - c.px * t, y = c.y - c.py * t;
        if (!inb(x, y) || rock[idx(x, y)]) break;
        wdt++;
      }
      if (wdt < 2 || wdt > 6) return "route choke width " + wdt + " @" + c.x + "," + c.y;
    }
  }

  // (h) gold patches must sit on open passable ground
  if (map.golds) {
    for (const g of map.golds) {
      const gx = (g.x / 256) | 0, gy = (g.y / 256) | 0;
      if (!inb(gx, gy) || rock[idx(gx, gy)]) return "gold patch blocked @" + gx + "," + gy;
    }
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

// Measure the ramp's chokepoint width. `travelHint` (true = corridor runs along
// X) is passed explicitly for STEPPED ramps whose along-travel extent exceeds
// their width — the old extent-based heuristic mis-detects those. When absent we
// fall back to the original heuristic (shallow ramps).
function measureChoke(tiles, rock, w, h, travelHint) {
  const idx = (x, y) => y * w + x;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const t of tiles) {
    if (t.x < minX) minX = t.x; if (t.x > maxX) maxX = t.x;
    if (t.y < minY) minY = t.y; if (t.y > maxY) maxY = t.y;
  }
  const travelAlongX = travelHint === undefined ? ((maxX - minX) <= (maxY - minY)) : travelHint;
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
// layout, now including geysers, losBlock, rampTiles, and barrierKind so the
// contract holds even on the fallback path.
// ---------------------------------------------------------------------------

function fallbackMap() {
  const W = MAP_W, H = MAP_H;
  const rock = new Uint8Array(W * H);
  const height = new Uint8Array(W * H);
  const losBlock = new Uint8Array(W * H);
  const rampTiles = new Uint8Array(W * H);
  const barrierKind = new Uint8Array(W * H);
  const starts = [{ x: 8, y: 8 }, { x: W - 9, y: H - 9 }];
  const idx = (x, y) => y * W + x;
  const clear = (cx, cy, r) => {
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++)
        if (x >= 0 && y >= 0 && x < W && y < H) rock[idx(x, y)] = 0;
  };
  for (const s of starts) clear(s.x, s.y, 9);
  const a = starts[0], b = starts[1];
  const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 2;
  for (let i = 0; i <= steps; i++) {
    clear(a.x + (((b.x - a.x) * i / steps) | 0), a.y + (((b.y - a.y) * i / steps) | 0), 2);
  }
  const minerals = [];
  const arc = [[-7, -2], [-7, 0], [-7, 2], [-2, -7], [0, -7], [2, -7]];
  for (const [dx, dy] of arc) {
    minerals.push({ x: tileToFp(starts[0].x + dx), y: tileToFp(starts[0].y + dy) });
    minerals.push({ x: tileToFp(starts[1].x - dx), y: tileToFp(starts[1].y - dy) });
  }
  const e = { x: 18, y: H - 19 };
  const em = { x: W - 1 - e.x, y: H - 1 - e.y };
  clear(e.x, e.y, 9); clear(em.x, em.y, 9);
  for (const [dx, dy] of [[-7, -1], [-7, 1], [-1, -7], [1, -7], [-5, -5]]) {
    minerals.push({ x: tileToFp(e.x + dx), y: tileToFp(e.y + dy) });
    minerals.push({ x: tileToFp(W - 1 - (e.x + dx)), y: tileToFp(H - 1 - (e.y + dy)) });
  }
  const geysers = [];
  const g = (tx, ty) => {
    for (let dy = 0; dy <= 1; dy++)
      for (let dx = 0; dx <= 1; dx++)
        if (tx + dx >= 0 && ty + dy >= 0 && tx + dx < W && ty + dy < H) rock[idx(tx + dx, ty + dy)] = 0;
    geysers.push({ x: tileToFp(tx), y: tileToFp(ty) });
    geysers.push({ x: tileToFp(W - 1 - tx), y: tileToFp(H - 1 - ty) });
  };
  g(starts[0].x + 6, starts[0].y + 2);
  g(starts[0].x + 2, starts[0].y + 6);
  g(e.x + 6, e.y + 3);
  const naturals = [{ x: e.x, y: e.y }, { x: em.x, y: em.y }];
  return {
    w: W, h: H, rock, height, rampTiles, barrierKind,
    starts, minerals, geysers, losBlock, decos: [], naturals, clusters: [], ramps: [],
  };
}
