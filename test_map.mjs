// Map generator validation harness. Extended to assert the enlarged-base
// spacing contract: MAIN >= 115 free flat build tiles, NATURAL >= 80, single
// ~3-wide main ramp choke (<=4), determinism (byte-identical regen), symmetry
// (rotate for cross spawns, reflect for close), heights 0..3, single-level
// ramp steps, no barrier inside a base interior, no plateau overlap on close
// spawns, and zero fallbacks. Run: `node test_map.mjs`.
import { generateMap } from "./js/core/map.js";
import { MAP_W, MAP_H } from "./js/core/data.js";

const W = MAP_W, H = MAP_H;
const idx = (x, y) => y * W + x;
const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

function bfs(rock, sx, sy) {
  const seen = new Uint8Array(W * H);
  if (rock[idx(sx, sy)]) return seen;
  const q = [idx(sx, sy)]; seen[idx(sx, sy)] = 1; let head = 0;
  while (head < q.length) {
    const n = q[head++]; const x = n % W, y = (n / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!inb(nx, ny)) continue;
      const m = idx(nx, ny);
      if (seen[m] || rock[m]) continue;
      seen[m] = 1; q.push(m);
    }
  }
  return seen;
}

// MAIN free flat build tiles within radius 7 (matches the plateauR=7 top and the
// validator window): passable, same level as the start, not mineral/geyser, reachable.
function mainFree(map, s) {
  const { rock, height, minerals, geysers } = map;
  const mt = new Set(minerals.map((m) => ((m.y / 256) | 0) * W + ((m.x / 256) | 0)));
  const gt = new Set((geysers || []).map((g) => ((g.y / 256) | 0) * W + ((g.x / 256) | 0)));
  const reach = bfs(rock, s.x, s.y);
  const lvl = height[idx(s.x, s.y)];
  let free = 0;
  for (let dy = -7; dy <= 7; dy++)
    for (let dx = -7; dx <= 7; dx++) {
      const x = s.x + dx, y = s.y + dy;
      if (!inb(x, y) || rock[idx(x, y)]) continue;
      if (height[idx(x, y)] !== lvl) continue;
      const id = idx(x, y);
      if (mt.has(id) || gt.has(id)) continue;
      if (!reach[id]) continue;
      free++;
    }
  return free;
}
// NATURAL free tiles within radius 6 (matches the validator window).
function natFree(map, n) {
  const { rock, minerals, geysers } = map;
  const mt = new Set(minerals.map((m) => ((m.y / 256) | 0) * W + ((m.x / 256) | 0)));
  const gt = new Set((geysers || []).map((g) => ((g.y / 256) | 0) * W + ((g.x / 256) | 0)));
  let free = 0;
  for (let dy = -6; dy <= 6; dy++)
    for (let dx = -6; dx <= 6; dx++) {
      const x = n.x + dx, y = n.y + dy;
      if (!inb(x, y) || rock[idx(x, y)]) continue;
      const id = idx(x, y);
      if (mt.has(id) || gt.has(id)) continue;
      free++;
    }
  return free;
}

// BFS distance field (steps) from (sx,sy) over passable tiles; -1 = unreachable.
function bfsDist(rock, sx, sy) {
  const dist = new Int32Array(W * H).fill(-1);
  if (rock[idx(sx, sy)]) return dist;
  dist[idx(sx, sy)] = 0;
  const q = [idx(sx, sy)]; let head = 0;
  while (head < q.length) {
    const n = q[head++]; const x = n % W, y = (n / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!inb(nx, ny)) continue;
      const m = idx(nx, ny);
      if (dist[m] !== -1 || rock[m]) continue;
      dist[m] = dist[n] + 1; q.push(m);
    }
  }
  return dist;
}

// One shortest 4-connected path (list of {x,y}) from a->b, or null. Fixed
// neighbour order -> deterministic reconstruction.
function shortestPath(rock, ax, ay, bx, by) {
  const dist = bfsDist(rock, ax, ay);
  if (dist[idx(bx, by)] < 0) return null;
  const path = []; let x = bx, y = by;
  path.push({ x, y });
  while (!(x === ax && y === ay)) {
    const d = dist[idx(x, y)]; let moved = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (inb(nx, ny) && dist[idx(nx, ny)] === d - 1) { x = nx; y = ny; path.push({ x, y }); moved = true; break; }
    }
    if (!moved) break;
  }
  return path.reverse();
}

// CONSISTENCY METRIC 1 — path clarity. Returns {ratio, pinch} where ratio is the
// main->main route length / straight-line distance (>~2.4 = winding mess) and
// pinch is the minimum corridor width along the route OUTSIDE registered chokes/
// ramps AND caused by a lowland BARRIER (an accidental barrier squeeze; genuine
// cliff pinches are legit elevation drama and excluded).
function pathClarity(map) {
  const s0 = map.starts[0], s1 = map.starts[1];
  const path = shortestPath(map.rock, s0.x, s0.y, s1.x, s1.y);
  const straight = Math.hypot(s1.x - s0.x, s1.y - s0.y) || 1;
  if (!path) return { ratio: Infinity, pinch: 0, pinchAt: null };
  const ratio = (path.length - 1) / straight;
  // legit-narrow tiles: ramps, registered chokes, main ramp (+1 collar).
  const legit = new Set();
  const addC = (x, y) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (inb(X, Y)) legit.add(idx(X, Y)); } };
  for (let i = 0; i < map.rampTiles.length; i++) if (map.rampTiles[i]) addC(i % W, (i / W) | 0);
  for (const c of map.chokes || []) addC(c.x, c.y);
  for (const r of map.ramps || []) for (const t of r.tiles || []) addC(t.x, t.y);
  const bases = [s0, s1, ...(map.naturals || [])];
  for (const cl of map.clusters || []) if (!cl.isMain) bases.push(cl.center);
  const barrierNear = (x, y) => {   // a lowland barrier within 2 tiles on a cardinal?
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
      for (let t = 1; t <= 2; t++) { const X = x + dx * t, Y = y + dy * t; if (!inb(X, Y)) break; if (map.rock[idx(X, Y)]) { if (map.barrierKind[idx(X, Y)]) return true; break; } }
    return false;
  };
  let minW = 99, minAt = null;
  for (let i = 2; i < path.length - 2; i++) {
    const t = path[i];
    if (legit.has(idx(t.x, t.y))) continue;
    let nearBase = false;
    for (const b of bases) if (Math.abs(t.x - b.x) <= 9 && Math.abs(t.y - b.y) <= 9) { nearBase = true; break; }
    if (nearBase) continue;
    if (!barrierNear(t.x, t.y)) continue;   // only judge barrier-caused pinches
    // measure perpendicular corridor width (both cardinal normals if diagonal).
    const a = path[i - 1], b = path[i + 1];
    const tvx = Math.sign(b.x - a.x), tvy = Math.sign(b.y - a.y);
    const normals = (tvx !== 0 && tvy !== 0) ? [[-tvy, 0], [0, tvx]] : [[-tvy, tvx]];
    for (const [nx, ny] of normals) {
      if (!nx && !ny) continue;
      let w = 1;
      for (let s = 1; s < 20; s++) { const X = t.x + nx * s, Y = t.y + ny * s; if (!inb(X, Y) || map.rock[idx(X, Y)]) break; w++; }
      for (let s = 1; s < 20; s++) { const X = t.x - nx * s, Y = t.y - ny * s; if (!inb(X, Y) || map.rock[idx(X, Y)]) break; w++; }
      if (w < minW) { minW = w; minAt = { x: t.x, y: t.y }; }
    }
  }
  return { ratio, pinch: minW, pinchAt: minAt };
}

// CONSISTENCY METRIC 2 — spawn siting. For each EXTRA expansion (not a natural),
// returns {edge, detour, open}: distance to the nearest map border, BFS-travel /
// euclidean detour ratio to the nearest main, and local openness (free tiles in
// radius 4, out of 81). Weird spawns (corner-jammed / behind detour walls /
// cramped pockets) show up as low edge, high detour, or low openness.
function expansionSiting(map) {
  const s0 = map.starts[0], s1 = map.starts[1];
  const d0 = bfsDist(map.rock, s0.x, s0.y), d1 = bfsDist(map.rock, s1.x, s1.y);
  const out = [];
  for (const cl of map.clusters || []) {
    if (cl.isMain) continue;
    const c = cl.center;
    if ((map.naturals || []).some((n) => Math.abs(n.x - c.x) <= 1 && Math.abs(n.y - c.y) <= 1)) continue; // naturals sited by ramp geometry
    const edge = Math.min(c.x, c.y, W - 1 - c.x, H - 1 - c.y);
    const e0 = Math.hypot(c.x - s0.x, c.y - s0.y), e1 = Math.hypot(c.x - s1.x, c.y - s1.y);
    const near0 = e0 <= e1;
    const travel = near0 ? d0[idx(c.x, c.y)] : d1[idx(c.x, c.y)];
    const euclid = near0 ? e0 : e1;
    const detour = travel > 0 && euclid > 0 ? travel / euclid : Infinity;
    let open = 0;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = c.x + dx, y = c.y + dy; if (inb(x, y) && !map.rock[idx(x, y)]) open++; }
    out.push({ x: c.x, y: c.y, edge, detour, open });
  }
  return out;
}

function serialize(map) {
  const p = [];
  for (const k of ["rock", "height", "rampTiles", "barrierKind", "losBlock"]) p.push(k + ":" + map[k].join(""));
  p.push("s:" + JSON.stringify(map.starts), "m:" + JSON.stringify(map.minerals),
    "g:" + JSON.stringify(map.geysers), "d:" + JSON.stringify(map.decos));
  return p.join("|");
}

function symmetryError(map, mode) {
  const { rock, height } = map;
  const s0 = map.starts[0], s1 = map.starts[1];
  let part;
  if (mode === "rotate") part = (x, y) => [W - 1 - x, H - 1 - y];
  else if (s1.x === W - 1 - s0.x && s1.y === s0.y) part = (x, y) => [W - 1 - x, y];
  else if (s1.y === H - 1 - s0.y && s1.x === s0.x) part = (x, y) => [x, H - 1 - y];
  else return "no reflect axis";
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [px, py] = part(x, y);
      if (rock[idx(x, y)] !== rock[idx(px, py)]) return `rock asym @${x},${y}`;
      if (height[idx(x, y)] !== height[idx(px, py)]) return `height asym @${x},${y}`;
    }
  return null;
}

// Chokepoint width of the main ramp corridor (same measurement as the validator).
function choke(tiles, rock, alongX) {
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const t of tiles) { if (t.x < minX) minX = t.x; if (t.x > maxX) maxX = t.x; if (t.y < minY) minY = t.y; if (t.y > maxY) maxY = t.y; }
  const run = (c) => { let r = 0, b = 0; for (const o of c) { if (o) { r++; b = Math.max(b, r); } else r = 0; } return b; };
  let narrow = 1e9;
  if (alongX) {
    for (let x = minX; x <= maxX; x++) { const c = []; for (let y = minY - 1; y <= maxY + 1; y++) c.push(inb(x, y) && !rock[idx(x, y)]); narrow = Math.min(narrow, run(c)); }
  } else {
    for (let y = minY; y <= maxY; y++) { const c = []; for (let x = minX - 1; x <= maxX + 1; x++) c.push(inb(x, y) && !rock[idx(x, y)]); narrow = Math.min(narrow, run(c)); }
  }
  return narrow === 1e9 ? 0 : narrow;
}

// Any two 4-adjacent PASSABLE tiles differ by <=1 level (ramps never skip).
function levelSkip(map) {
  const { rock, height } = map;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (rock[idx(x, y)]) continue;
      const hh = height[idx(x, y)];
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nx = x + dx, ny = y + dy;
        if (!inb(nx, ny) || rock[idx(nx, ny)]) continue;
        if (Math.abs(hh - height[idx(nx, ny)]) > 1) return `${x},${y}->${nx},${ny}`;
      }
    }
  return null;
}

// No organic barrier inside the enlarged base interior (radius 7 around a main).
function barrierInInterior(map) {
  for (const s of map.starts)
    for (let dy = -7; dy <= 7; dy++)
      for (let dx = -7; dx <= 7; dx++) {
        const x = s.x + dx, y = s.y + dy;
        if (inb(x, y) && map.barrierKind[idx(x, y)]) return `${x},${y}`;
      }
  return null;
}

// Geyser placement quality (the fix under test): every geyser 2x2 must sit on
// flat ground at the level of its OWNING base (nearest main/natural center), with
// NO rock tile inside a 1-tile Chebyshev collar around the footprint (i.e. not
// hugging a cliff), and at least 3 tiles from the map border. The fp coord is the
// 2x2's MIN corner, so the footprint is (tx..tx+1, ty..ty+1).
function geyserPlacementError(map) {
  const { rock, height, geysers, starts, naturals } = map;
  const bases = [...starts, ...(naturals || [])];
  for (const g of geysers) {
    const tx = (g.x / 256) | 0, ty = (g.y / 256) | 0;
    // border margin
    if (tx < 3 || ty < 3 || tx + 1 > W - 4 || ty + 1 > H - 4)
      return `border @${tx},${ty}`;
    // owning base = nearest center; its level is the expected pad level
    let best = bases[0], bd = Infinity;
    for (const b of bases) { const d = (b.x - tx) ** 2 + (b.y - ty) ** 2; if (d < bd) { bd = d; best = b; } }
    const baseLvl = height[idx(best.x, best.y)];
    // 2x2 flat at base level, passable
    for (let dy = 0; dy <= 1; dy++)
      for (let dx = 0; dx <= 1; dx++) {
        const x = tx + dx, y = ty + dy;
        if (!inb(x, y)) return `oob @${x},${y}`;
        if (rock[idx(x, y)]) return `pad-rock @${x},${y}`;
        if (height[idx(x, y)] !== baseLvl) return `pad-level ${height[idx(x, y)]}!=${baseLvl} @${x},${y}`;
      }
    // 1-tile Chebyshev collar clear of rock/cliff
    for (let dy = -1; dy <= 2; dy++)
      for (let dx = -1; dx <= 2; dx++) {
        const x = tx + dx, y = ty + dy;
        if (!inb(x, y)) return `collar-oob @${x},${y}`;
        if (rock[idx(x, y)]) return `cliff-hug @${x},${y}`;
      }
  }
  return null;
}

const isFallback = (m) => m.vProfile === undefined && (!m.ramps || m.ramps.length === 0);

// ---- run the matrix: 40 seeds x {cross,close} x {0,1,2} extra expansions ----
const seeds = [];
for (let i = 0; i < 40; i++) seeds.push(i * 7919 + 42);
const modes = ["cross", "close"];
const expOpts = [0, 1, 2];

let configs = 0, fallbacks = 0;
const fails = [];
const mainDist = [], natDist = [];
let detOk = true, chokeMax = 0;
let withChokes = 0, withGolds = 0, withTowers = 0;
// consistency-pass metric distributions (locked-in bar):
const ratioDist = [], expEdgeDist = [], expDetourDist = [], expOpenDist = [];
let routePinchMin = 99;

for (const seed of seeds)
  for (const spawns of modes)
    for (const expansions of expOpts) {
      configs++;
      const map = generateMap(seed, { spawns, expansions });
      if (isFallback(map)) { fallbacks++; fails.push(`FALLBACK seed${seed} ${spawns} exp${expansions}`); continue; }

      if (serialize(map) !== serialize(generateMap(seed, { spawns, expansions }))) { detOk = false; fails.push(`NON-DETERMINISTIC seed${seed} ${spawns} exp${expansions}`); }

      const mode = spawns === "close" ? "reflect" : "rotate";
      const se = symmetryError(map, mode);
      if (se) fails.push(`SYMMETRY seed${seed} ${spawns}: ${se}`);

      // connectivity + natural reachability
      const reach = bfs(map.rock, map.starts[0].x, map.starts[0].y);
      if (!reach[idx(map.starts[1].x, map.starts[1].y)]) fails.push(`DISCONNECTED seed${seed} ${spawns} exp${expansions}`);
      for (const n of map.naturals) {
        let ok = false;
        for (let dy = -6; dy <= 6 && !ok; dy++) for (let dx = -6; dx <= 6; dx++) { const x = n.x + dx, y = n.y + dy; if (inb(x, y) && reach[idx(x, y)]) { ok = true; break; } }
        if (!ok) fails.push(`NAT-UNREACHABLE seed${seed} ${spawns} @${n.x},${n.y}`);
      }

      const mf = Math.min(mainFree(map, map.starts[0]), mainFree(map, map.starts[1]));
      mainDist.push(mf);
      if (mf < 115) fails.push(`MAINFREE ${mf}<115 seed${seed} ${spawns} exp${expansions}`);

      let nf = Infinity;
      for (const n of map.naturals) nf = Math.min(nf, natFree(map, n));
      natDist.push(nf);
      if (nf < 80) fails.push(`NATFREE ${nf}<80 seed${seed} ${spawns} exp${expansions}`);

      for (let i = 0; i < map.height.length; i++) if (map.height[i] > 3) { fails.push(`HEIGHT>3 seed${seed}`); break; }

      const ls = levelSkip(map);
      if (ls) fails.push(`LEVEL-SKIP seed${seed} ${spawns} exp${expansions} @${ls}`);

      if (map.ramps && map.ramps[0] && map.ramps[0].tiles.length) {
        const c = choke(map.ramps[0].tiles, map.rock, map.ramps[0].alongX);
        chokeMax = Math.max(chokeMax, c);
        if (c > 4) fails.push(`CHOKE ${c}>4 seed${seed} ${spawns} exp${expansions}`);
      }

      const bi = barrierInInterior(map);
      if (bi) fails.push(`BARRIER-INTERIOR seed${seed} ${spawns} exp${expansions} @${bi}`);

      const ge = geyserPlacementError(map);
      if (ge) fails.push(`GEYSER-PLACEMENT seed${seed} ${spawns} exp${expansions} ${ge}`);

      // enforced route chokes: corridor open and 2..6 wide at every pinch
      if (map.chokes?.length) {
        withChokes++;
        for (const c of map.chokes) {
          if (map.rock[idx(c.x, c.y)]) { fails.push(`CHOKE-BLOCKED seed${seed} ${spawns} @${c.x},${c.y}`); continue; }
          let wdt = 1;
          for (let t = 1; t <= 8; t++) { const x = c.x + c.px * t, y = c.y + c.py * t; if (!inb(x, y) || map.rock[idx(x, y)]) break; wdt++; }
          for (let t = 1; t <= 8; t++) { const x = c.x - c.px * t, y = c.y - c.py * t; if (!inb(x, y) || map.rock[idx(x, y)]) break; wdt++; }
          if (wdt < 2 || wdt > 6) fails.push(`ROUTE-CHOKE ${wdt} seed${seed} ${spawns} exp${expansions} @${c.x},${c.y}`);
        }
      }
      // watchtowers: symmetric pair on open reachable ground
      if (map.watchtowers?.length) {
        withTowers++;
        for (const t of map.watchtowers) {
          if (map.rock[idx(t.x, t.y)]) fails.push(`TOWER-BLOCKED seed${seed} ${spawns} @${t.x},${t.y}`);
          else if (!reach[idx(t.x, t.y)]) fails.push(`TOWER-UNREACHABLE seed${seed} ${spawns} @${t.x},${t.y}`);
        }
        if (map.watchtowers.length % 2) fails.push(`TOWER-UNPAIRED seed${seed} ${spawns}`);
      }
      // gold patches: open ground, reachable from both mains
      if (map.golds?.length) {
        withGolds++;
        for (const g of map.golds) {
          const gx = (g.x / 256) | 0, gy = (g.y / 256) | 0;
          if (map.rock[idx(gx, gy)]) fails.push(`GOLD-BLOCKED seed${seed} ${spawns} @${gx},${gy}`);
          else if (!reach[idx(gx, gy)]) fails.push(`GOLD-UNREACHABLE seed${seed} ${spawns} @${gx},${gy}`);
        }
      }

      if (spawns === "close") {
        const s0 = map.starts[0], s1 = map.starts[1];
        if (Math.abs(s0.x - s1.x) <= 14 && Math.abs(s0.y - s1.y) <= 14) fails.push(`PLATEAU-OVERLAP seed${seed} close exp${expansions}`);
      }

      // ---- CONSISTENCY BAR (locked in after the tuning pass) ----------------
      // 1. PATH CLARITY: the main->main route must not be a winding mess, and must
      //    never be pinched to a 1-wide SLIT by an accidental barrier squeeze
      //    outside the registered chokes/ramps (a 1-tile gap through a barrier clump
      //    is the "unclear path" defect; the generator's map-wide slit eroder widens
      //    every such slit to >= 2, ordering-independently). Ratio ceiling 2.4
      //    carries margin over the matrix (max ~2.19) plus a wide-seed sweep.
      const pc = pathClarity(map);
      ratioDist.push(pc.ratio);
      if (pc.ratio > 2.4) fails.push(`PATH-RATIO ${pc.ratio.toFixed(2)}>2.4 seed${seed} ${spawns} exp${expansions}`);
      routePinchMin = Math.min(routePinchMin, pc.pinch);
      if (pc.pinch < 2) fails.push(`ROUTE-PINCH ${pc.pinch}<2 seed${seed} ${spawns} exp${expansions} @${pc.pinchAt?.x},${pc.pinchAt?.y}`);

      // 2. SPAWN SITING: every EXTRA expansion sits >= 6 tiles off the map border
      //    (never corner-jammed), reaches its nearest main without an absurd detour
      //    (travel/euclid <= 3.5 — an expansion tucked behind the center island runs
      //    naturally high; the bar just rejects a genuinely walled-off pocket), and
      //    has an open local pocket (>= 50 free tiles in a 9x9 window, out of 81).
      for (const e of expansionSiting(map)) {
        expEdgeDist.push(e.edge); expDetourDist.push(e.detour); expOpenDist.push(e.open);
        if (e.edge < 6) fails.push(`EXP-EDGE ${e.edge}<6 seed${seed} ${spawns} exp${expansions} @${e.x},${e.y}`);
        if (e.detour > 3.5) fails.push(`EXP-DETOUR ${e.detour.toFixed(2)}>3.5 seed${seed} ${spawns} exp${expansions} @${e.x},${e.y}`);
        if (e.open < 50) fails.push(`EXP-OPENNESS ${e.open}<50 seed${seed} ${spawns} exp${expansions} @${e.x},${e.y}`);
      }
    }

const stat = (a) => { a = a.slice().sort((x, y) => x - y); return `min=${a[0]} median=${a[(a.length / 2) | 0]} max=${a[a.length - 1]}`; };
const statF = (a) => { a = a.filter((x) => isFinite(x)).slice().sort((x, y) => x - y); return `min=${a[0]?.toFixed(2)} median=${a[(a.length / 2) | 0]?.toFixed(2)} max=${a[a.length - 1]?.toFixed(2)}`; };
console.log(`Tested ${configs} configs (${seeds.length} seeds x ${modes.length} modes x ${expOpts.length} expansion counts).`);
console.log(`  fallbacks:            ${fallbacks}`);
console.log(`  MAIN free @r7:        ${stat(mainDist)}   (require >= 115)`);
console.log(`  NATURAL free @r6:     ${stat(natDist)}   (require >= 80)`);
console.log(`  determinism ok:       ${detOk}`);
console.log(`  max main-ramp choke:  ${chokeMax}   (require <= 4)`);
console.log(`  route chokes present: ${withChokes}/${configs} configs`);
console.log(`  gold pair present:    ${withGolds}/${configs} configs`);
console.log(`  watchtowers present:  ${withTowers}/${configs} configs`);
console.log(`  --- consistency bar ---`);
console.log(`  main->main path ratio: ${statF(ratioDist)}   (require <= 2.4)`);
console.log(`  route pinch off-choke: min=${routePinchMin}   (require >= 2)`);
console.log(`  expansion edge dist:   ${stat(expEdgeDist)}   (require >= 6)`);
console.log(`  expansion detour:      ${statF(expDetourDist)}   (require <= 3.5)`);
console.log(`  expansion openness/81: ${stat(expOpenDist)}   (require >= 50)`);
console.log(`  assertion failures:   ${fails.length}`);
for (const f of fails.slice(0, 30)) console.log("    " + f);
if (fails.length === 0 && fallbacks === 0) console.log("ALL CHECKS PASSED.");
process.exit(fails.length === 0 && fallbacks === 0 ? 0 : 1);
