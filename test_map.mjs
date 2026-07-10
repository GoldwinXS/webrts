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
let withChokes = 0, withGolds = 0;

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
    }

const stat = (a) => { a = a.slice().sort((x, y) => x - y); return `min=${a[0]} median=${a[(a.length / 2) | 0]} max=${a[a.length - 1]}`; };
console.log(`Tested ${configs} configs (${seeds.length} seeds x ${modes.length} modes x ${expOpts.length} expansion counts).`);
console.log(`  fallbacks:            ${fallbacks}`);
console.log(`  MAIN free @r7:        ${stat(mainDist)}   (require >= 115)`);
console.log(`  NATURAL free @r6:     ${stat(natDist)}   (require >= 80)`);
console.log(`  determinism ok:       ${detOk}`);
console.log(`  max main-ramp choke:  ${chokeMax}   (require <= 4)`);
console.log(`  route chokes present: ${withChokes}/${configs} configs`);
console.log(`  gold pair present:    ${withGolds}/${configs} configs`);
console.log(`  assertion failures:   ${fails.length}`);
for (const f of fails.slice(0, 30)) console.log("    " + f);
if (fails.length === 0 && fallbacks === 0) console.log("ALL CHECKS PASSED.");
process.exit(fails.length === 0 && fallbacks === 0 ? 0 : 1);
