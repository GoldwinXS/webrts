// ASCII mission maps for the campaign. Turns a hand-authored multiline grid
// string into a map object with EVERY field generateMap() emits, so a mission
// can hand it to the Sim as opts.customMap and skip procedural generation
// entirely (see campaign.js / main.js — mapSeed then only seeds sim randomness).
//
// This is ADDITIVE: it never touches core/map.js. It reproduces the same return
// shape (w,h,rock,height,rampTiles,barrierKind,starts,minerals,geysers,losBlock,
// decos,golds,chokes,watchtowers,naturals,clusters,ramps,vProfile,theme,themeName)
// plus one NEW field `markers` (tile-coord named points) that nothing else in the
// engine reads, so it is safe.
//
// Coordinate conventions (matched to core/map.js exactly):
//   - starts / naturals / watchtowers / decos: TILE coords {x,y} (+ kind on decos)
//   - minerals / geysers / golds: FIXED-POINT tile-CENTER coords (tileToFp)
//   - geysers emit the MIN corner of their 2x2 footprint as fp
//
// Char legend is FROZEN (see the contract in campaign notes). Custom maps are
// TRUSTED — there is no validate() loop; we only assert both starts exist.

import { tileToFp } from "../core/fixed.js";

// Theme metadata mirrors generateMap(): map.theme is 0..2, map.themeName is the
// internal name. We import THEMES to derive the name identically.
import { THEMES } from "../core/map.js";

// Barrier kinds (match core/map.js): forest/lava/ice/rock = 1/2/3/4.
const BARRIER = { F: 1, L: 2, I: 3, R: 4 };

// ---------------------------------------------------------------------------
// buildMissionMap(def) -> map object (opts.customMap-ready)
//   def = { theme: 0|1|2, grid: `multiline template string` }
// ---------------------------------------------------------------------------
export function buildMissionMap(def) {
  if (!def || typeof def.grid !== "string") {
    throw new Error("buildMissionMap: def.grid (multiline string) is required");
  }

  // ---- 1. normalize the grid into a rectangular char matrix -----------------
  // Split on newlines, drop empty leading/trailing lines, width = longest line,
  // right-pad short lines with '.' so every row is `W` wide.
  let lines = def.grid.replace(/\r\n?/g, "\n").split("\n");
  // drop leading blank lines
  while (lines.length && lines[0].trim() === "") lines.shift();
  // drop trailing blank lines
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (!lines.length) throw new Error("buildMissionMap: grid is empty");

  const H = lines.length;
  let W = 0;
  for (const ln of lines) if (ln.length > W) W = ln.length;
  if (W < 3 || H < 3) throw new Error(`buildMissionMap: grid too small (${W}x${H})`);
  // right-pad every row to W with '.'
  const rows = lines.map((ln) => ln.padEnd(W, "."));

  const N = W * H;
  const idx = (x, y) => y * W + x;
  const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

  const rock = new Uint8Array(N);
  const height = new Uint8Array(N);
  const rampTiles = new Uint8Array(N);
  const barrierKind = new Uint8Array(N);
  const losBlock = new Uint8Array(N);
  const decos = [];
  const minerals = [];
  const geysers = [];
  const starts = [null, null];        // filled from '@' / '!'
  const markers = {};                 // NEW: named marker points, tile coords

  // char at (x,y) — beyond a padded row is '.'
  const at = (x, y) => (inb(x, y) ? rows[y][x] : ".");

  // Classify a char as "passable ground" (so height can propagate off it) and
  // return its explicit level, or -1 if it is not an explicit-height passable
  // tile. Passable ground chars: '.', ' ', '1','2','3', ramps '/', markers,
  // starts, shrubs 's', and resource GROUND ('M','G'). Their height defaults to
  // 0 unless a raised neighbor overrides (resolved in the smoothing pass).
  const explicitLevel = (ch) => {
    if (ch === ".") return 0;
    if (ch === " ") return 0;      // padding == lowland
    if (ch === "1") return 1;
    if (ch === "2") return 2;
    if (ch === "3") return 3;
    return -1;                     // not an explicit-height tile
  };

  // Is this char a passable tile (units can stand on it)?
  const isPassableChar = (ch) => {
    if (ch === "#") return false;
    if (BARRIER[ch]) return false;      // F L I R blocked barriers
    return true;                        // everything else is passable ground
  };

  // ---- 2. first pass: place explicit-height ground, resources, markers ------
  // We record geyser TOP-LEFT corners and mineral tiles for a second pass (so
  // their ground height can inherit a raised neighbor if the author placed them
  // on a plateau — the contract treats their ground as '.'-equivalent at the max
  // passable neighbor height).
  const mineralTiles = [];
  const geyserCorners = [];
  const shrubTiles = [];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ch = rows[y][x];
      const i = idx(x, y);

      const lvl = explicitLevel(ch);
      if (lvl >= 0) { height[i] = lvl; continue; }

      switch (ch) {
        case "#":                       // solid rock wall (height resolved later)
          rock[i] = 1;
          break;
        case "F": case "L": case "I": case "R": {   // blocked barrier
          rock[i] = 1;
          barrierKind[i] = BARRIER[ch];
          break;
        }
        case "/":                       // ramp tile (passable; level resolved later)
          rampTiles[i] = 1;             // provisional; final = higher connected level
          break;
        case "s":                       // LoS shrub (passable, blocks vision + deco)
          losBlock[i] = 1;
          shrubTiles.push({ x, y });
          break;
        case "M":                       // mineral patch (ground '.')
          mineralTiles.push({ x, y });
          break;
        case "G":                       // geyser TOP-LEFT of its 2x2
          geyserCorners.push({ x, y });
          break;
        case "@":                       // player-0 start
          starts[0] = { x, y };
          break;
        case "!":                       // player-1 start
          starts[1] = { x, y };
          break;
        default:
          // A..K named markers -> passable lowland + exported marker point.
          if (ch >= "A" && ch <= "K") {
            markers[ch] = { x, y };
          }
          // any other char (unknown) is treated as '.' lowland (height already 0).
          break;
      }
    }
  }

  // ---- 3. resolve heights for special passable/blocked tiles ----------------
  // Helper: max height among passable 4-neighbors (explicit-height ground only,
  // i.e. tiles that already carry a meaningful height). Used for ramps, rock
  // walls, resources, shrubs, markers, and starts.
  const maxPassableNeighborH = (x, y) => {
    let m = 0;
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of nb) {
      const nx = x + dx, ny = y + dy;
      if (!inb(nx, ny)) continue;
      const nch = rows[ny][nx];
      if (!isPassableChar(nch)) continue;
      const h = height[idx(nx, ny)];
      if (h > m) m = h;
    }
    return m;
  };

  // Ramps: height = max neighboring passable level (a '/' bridges two bands).
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (rows[y][x] !== "/") continue;
      const h = maxPassableNeighborH(x, y);
      const i = idx(x, y);
      height[i] = h;
      rampTiles[i] = h > 0 ? h : 1;     // value = HIGHER level it connects (>=1)
    }

  // Rock walls: height = max of passable 4-neighbors, else 1.
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (rows[y][x] !== "#") continue;
      const h = maxPassableNeighborH(x, y);
      height[idx(x, y)] = h > 0 ? h : 1;
    }
  // Barrier tiles (F/L/I/R): they are blocked; give them the neighbor height too
  // so cliff-height comparisons behave (author's problem if adjacent to a skip).
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const ch = rows[y][x];
      if (!BARRIER[ch]) continue;
      const h = maxPassableNeighborH(x, y);
      height[idx(x, y)] = h;            // 0 is fine for a lowland barrier
    }

  // Markers / starts / shrubs sit on passable ground; inherit a raised neighbor
  // height so a marker on a plateau reads at the plateau level.
  const inheritGroundH = (x, y) => {
    const i = idx(x, y);
    const h = maxPassableNeighborH(x, y);
    if (h > height[i]) height[i] = h;
  };
  for (const s of shrubTiles) inheritGroundH(s.x, s.y);
  for (const name in markers) inheritGroundH(markers[name].x, markers[name].y);
  if (starts[0]) inheritGroundH(starts[0].x, starts[0].y);
  if (starts[1]) inheritGroundH(starts[1].x, starts[1].y);

  // ---- 4. resources (emit fp tile-center like generateMap) ------------------
  // Minerals: ground under 'M' is '.'-equivalent at the max passable neighbor
  // height (treat as lowland unless raised). Emit fp tile-center.
  for (const m of mineralTiles) {
    const i = idx(m.x, m.y);
    const h = maxPassableNeighborH(m.x, m.y);
    height[i] = h;                        // ground level under the patch
    minerals.push({ x: tileToFp(m.x), y: tileToFp(m.y) });
  }

  // Geysers: 'G' is the TOP-LEFT of a 2x2; emit the fp MIN corner (matches
  // commitGeyser2x2's contract). Level the 2x2 to the corner's ground height.
  for (const g of geyserCorners) {
    const h = maxPassableNeighborH(g.x, g.y);
    for (let gy = g.y; gy <= g.y + 1; gy++)
      for (let gx = g.x; gx <= g.x + 1; gx++) {
        if (inb(gx, gy)) { height[idx(gx, gy)] = h; }
      }
    geysers.push({ x: tileToFp(g.x), y: tileToFp(g.y) });
  }

  // Shrubs also push a decos kind-3 entry (tall shrub / LoS blocker marker).
  for (const s of shrubTiles) decos.push({ x: s.x, y: s.y, kind: 3 });

  // ---- 5. height smoothing: fix trivial >1-level skips between passable tiles
  // The author is responsible for sane ramp bands; we only make a cheap, local
  // repair: when two horizontally/vertically adjacent PASSABLE tiles differ by
  // more than one level, raise the LOWER tile by one step IF that trivially
  // closes the gap (i.e. the higher side is exactly lower+2). We do a couple of
  // bounded passes. We never touch resource ground (already fixed) beyond this.
  // This is a "don't crash / don't ship an obviously illegal 1-tile skip"
  // guard, NOT a full terrain fixer.
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const chA = rows[y][x];
        if (!isPassableChar(chA)) continue;
        const i = idx(x, y);
        const ha = height[i];
        const nb = [[1, 0], [0, 1]];
        for (const [dx, dy] of nb) {
          const nx = x + dx, ny = y + dy;
          if (!inb(nx, ny)) continue;
          if (!isPassableChar(rows[ny][nx])) continue;
          const j = idx(nx, ny);
          const hb = height[j];
          const diff = Math.abs(ha - hb);
          if (diff > 1) {
            // raise the lower side by one step toward the higher.
            if (ha < hb) { height[i] = ha + 1; }
            else { height[j] = hb + 1; }
            changed = true;
          }
        }
      }
    if (!changed) break;
  }

  // ---- 6. sanity assert (custom maps are trusted, but a player start is
  // mandatory). '!' is OPTIONAL: scripted missions (enemy = spawned waves, no
  // enemy base) omit it, and the Sim still needs starts[1] to boot — default
  // it to the passable tile farthest from '@' (the mission's setup typically
  // clears player 1's starting entities anyway). Deterministic scan order.
  if (!starts[0]) {
    throw new Error("buildMissionMap: grid must contain a '@' (player 0 start)");
  }
  if (!starts[1]) {
    let best = null, bestD = -1;
    for (let y = 1; y < H - 3; y++)
      for (let x = 1; x < W - 3; x++) {
        if (rock[y * W + x]) continue;
        const dx = x - starts[0].x, dy = y - starts[0].y;
        const d = dx * dx + dy * dy;
        if (d > bestD) { bestD = d; best = { x, y }; }
      }
    starts[1] = best || { x: W - 4, y: H - 4 };
  }

  // ---- 7. derived / empty-but-present fields --------------------------------
  // naturals default to a copy of starts (the generator emits [main, partner];
  // for a hand map the mains double as their own naturals — nothing critical
  // reads naturals for campaign play). clusters/golds/chokes/watchtowers empty.
  const naturals = [{ x: starts[0].x, y: starts[0].y }, { x: starts[1].x, y: starts[1].y }];

  // ramps: derive a single entry from all '/' tiles found (empty tiles array is
  // legal). alongX is a cheap heuristic (wider spread on X => alongX true).
  const rampTileList = [];
  let minX = W, maxX = 0, minY = H, maxY = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (rampTiles[idx(x, y)]) {
        rampTileList.push({ x, y });
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
  const alongX = (maxX - minX) >= (maxY - minY);
  const ramps = [{ tiles: rampTileList, alongX }];

  // theme + themeName exactly like generateMap() (default theme 0).
  const theme = ((def.theme | 0) % THEMES.length + THEMES.length) % THEMES.length;
  const themeName = THEMES[theme].name;

  return {
    w: W, h: H,
    rock, height, rampTiles, barrierKind, losBlock,
    starts, minerals, geysers, decos,
    golds: [],
    chokes: [],
    watchtowers: [],
    naturals,
    clusters: [],
    ramps,
    vProfile: 0,
    theme, themeName,
    markers,                 // NEW additive field: { A:{x,y}, ... } tile coords
  };
}
