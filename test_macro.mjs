// Headless macro-queue + wall-tunneling regression test.
//   - shift-queued build orders on a worker (build A, then build B / move)
//   - build-then-build chain completes both sites via one worker
//   - units cannot tunnel through a 1-tile-thick rock wall via separation
//   - two mirrored sims stay checksum-identical throughout
// Run: node test_macro.mjs
import { Sim } from "./js/core/sim.js";
import { tileToFp, fpToTile, FP } from "./js/core/fixed.js";

let fail = 0;
const check = (name, ok) => {
  console.log(`  ${ok ? "ok" : "FAIL"}: ${name}`);
  if (!ok) fail++;
};

// ---- lockstep twin sims -----------------------------------------------------
const opts = { factions: ["cogs", "cogs"] };
const a = new Sim(777, opts);
const b = new Sim(777, opts);
a.noGameOver = b.noGameOver = true;
const step = (cmds = []) => { a.step(cmds); b.step(cmds); };
const both = (fn) => { fn(a); fn(b); };

// Find an open area (flat, unblocked, clear of minerals/geysers) on the map so
// tests don't fight terrain. Returns a tile origin with `span` free tiles in
// each direction, or null. `avoid` is a list of prior region origins to keep a
// wide berth from so multiple test regions don't overlap. The 56x56 map is
// cramped, so keep spans small.
function openRegion(s, span, avoid = []) {
  const { w, h } = s.map;
  for (let ty = span + 2; ty < h - span - 2; ty++) {
    for (let tx = span + 2; tx < w - span - 2; tx++) {
      let ok = true;
      for (const p of avoid) if (Math.abs(p.tx - tx) < span * 2 + 3 && Math.abs(p.ty - ty) < span * 2 + 3) ok = false;
      for (let dy = -span; dy <= span && ok; dy++)
        for (let dx = -span; dx <= span && ok; dx++) {
          const x = tx + dx, y = ty + dy;
          if (s.blocked[y * w + x]) ok = false;
          if (s.map.rampTiles && s.map.rampTiles[y * w + x]) ok = false;
          if (s.map.height && s.map.height[y * w + x] !== s.map.height[ty * w + tx]) ok = false;
        }
      // also require no mineral/geyser too close (canPlace clearance)
      if (ok) {
        for (const e of s.entities) {
          if (e.type === "mineral" || e.type === "geyser") {
            if (Math.abs(fpToTile(e.x) - tx) <= span + 2 && Math.abs(fpToTile(e.y) - ty) <= span + 2) { ok = false; break; }
          }
        }
      }
      if (ok) return { tx, ty };
    }
  }
  return null;
}

const region = openRegion(a, 4);
check("found an open test region", !!region);

// ---- TASK 1: macro queue ----------------------------------------------------
// Spawn a fresh worker in the open region on BOTH sims, give it plenty of
// resources, and queue: build Battery @ site1, then MOVE to a far point.
const { tx: rx, ty: ry } = region;
const wStart = { x: tileToFp(rx), y: tileToFp(ry) };
const w1a = a.spawnUnit(0, "worker", wStart.x, wStart.y);
const w1b = b.spawnUnit(0, "worker", wStart.x, wStart.y);
check("worker ids mirror", w1a.id === w1b.id);
both((s) => { s.minerals[0] = 2000; s.gas[0] = 2000; });

// Battery is size 2, cogs faction, no requires. Place two non-overlapping sites
// inside the ±4-tile free window around the region origin.
const site1 = { tx: rx + 2, ty: ry - 1 };   // to the right
const site2 = { tx: rx - 3, ty: ry - 1 };   // to the left
const moveTo = { x: tileToFp(rx), y: tileToFp(ry + 3) };

check("site1 placeable", a.canPlace("depot", site1.tx, site1.ty, 0));
check("site2 placeable", a.canPlace("depot", site2.tx, site2.ty, 0));

// Issue: build site1 (q:0 — replaces idle order, starts now),
// then shift-move to moveTo (q:1 — queued behind the build).
step([{ pid: 0, cmds: [
  { t: "build", workerId: w1a.id, building: "depot", tx: site1.tx, ty: site1.ty, q: 0 },
  { t: "move", ids: [w1a.id], x: moveTo.x, y: moveTo.y, q: 1 },
] }]);

check("worker took the build order first", w1a.order.kind === "build");
check("move order is queued in u.next", w1a.next.length === 1 && w1a.next[0].kind === "move");

// Run until the build finishes and the worker reaches the move target.
let builtSite1 = false, reachedMove = false;
for (let t = 0; t < 3000; t++) {
  step();
  const s1 = a.entities.find((e) => e.building && e.tx === site1.tx && e.ty === site1.ty);
  if (s1 && s1.done) builtSite1 = true;
  if (builtSite1 && Math.abs(w1a.x - moveTo.x) < FP && Math.abs(w1a.y - moveTo.y) < FP) { reachedMove = true; break; }
  if (a.checksum() !== b.checksum()) { check(`desync during build+move at tick ${t}`, false); break; }
}
check("queued build completed", builtSite1);
check("worker then walked to the move target (order chain ran in sequence)", reachedMove);
check("checksum identical after build+move chain", a.checksum() === b.checksum());

// ---- build-then-build chain -------------------------------------------------
// Fresh worker: shift-queue TWO builds; assert both sites complete via one worker.
const region2 = openRegion(a, 4, [region]);
check("found a second open region", !!region2);
const w2a = a.spawnUnit(0, "worker", tileToFp(region2.tx), tileToFp(region2.ty));
const w2b = b.spawnUnit(0, "worker", tileToFp(region2.tx), tileToFp(region2.ty));
both((s) => { s.minerals[0] = 2000; s.gas[0] = 2000; });
const c1 = { tx: region2.tx + 2, ty: region2.ty - 1 };
const c2 = { tx: region2.tx - 3, ty: region2.ty - 1 };
check("chain sites placeable", a.canPlace("depot", c1.tx, c1.ty, 0) && a.canPlace("depot", c2.tx, c2.ty, 0));

step([{ pid: 0, cmds: [
  { t: "build", workerId: w2a.id, building: "depot", tx: c1.tx, ty: c1.ty, q: 0 },
  { t: "build", workerId: w2a.id, building: "depot", tx: c2.tx, ty: c2.ty, q: 1 },
] }]);
check("second build queued behind first", w2a.order.kind === "build" && w2a.next.length === 1 && w2a.next[0].kind === "build");

let done1 = false, done2 = false;
for (let t = 0; t < 5000; t++) {
  step();
  const s1 = a.entities.find((e) => e.building && e.tx === c1.tx && e.ty === c1.ty);
  const s2 = a.entities.find((e) => e.building && e.tx === c2.tx && e.ty === c2.ty);
  if (s1 && s1.done) done1 = true;
  if (s2 && s2.done) done2 = true;
  if (done1 && done2) break;
  if (a.checksum() !== b.checksum()) { check(`desync during build+build at tick ${t}`, false); break; }
}
check("first site of chain completed", done1);
check("second site of chain completed (one worker built both)", done2);
check("checksum identical after build+build chain", a.checksum() === b.checksum());

// ---- TASK 2: thin-wall tunneling --------------------------------------------
// Reproduce the reported "units teleport through thin rock barriers" bug and
// prove it's fixed. Two identical sims. Geometry: a full-height 1-tile-thick
// wall at column wallX, plus a near-side blocker column at wallX-1 across a
// band of rows with a single entry gap. Units funnelled into that pocket get
// crushed by the crowd behind them and shoved onto the wall tile; the OLD
// outward-ring ejection would then pop them out on the FAR side (the only free
// tiles at radius 1 in the pocket), tunneling through solid rock. The fix keeps
// ejection on the near (previous-position) side, so nobody crosses.
const c = new Sim(31337, opts);
const d = new Sim(31337, opts);
c.noGameOver = d.noGameOver = true;
const step2 = (cmds = []) => { c.step(cmds); d.step(cmds); };

const wallRegion = openRegion(c, 3);
check("found region for wall test", !!wallRegion);
const wallX = wallRegion.tx;               // solid wall column (full height)
const wy0 = wallRegion.ty - 2, wy1 = wallRegion.ty + 2;   // pocket band rows
const gapRow = wallRegion.ty;              // the single opening into the pocket
const stampWall = (s) => {
  const { w, h } = s.map;
  // full-height solid wall — NO way around, so far side == tunneled
  for (let y = 0; y < h; y++) { s.blocked[y * w + wallX] = 1; s.map.rock[y * w + wallX] = 1; }
  // near-side pocket wall at wallX-1 across the band, leaving one entry row
  for (let y = wy0; y <= wy1; y++) {
    if (y === gapRow) continue;
    s.blocked[y * w + (wallX - 1)] = 1; s.map.rock[y * w + (wallX - 1)] = 1;
  }
};
stampWall(c); stampWall(d);
check("wall stamped identically", c.blocked.join(",") === d.blocked.join(","));

// Spawn a crowd on the near side, then reproduce the crush deterministically:
// each tick we drive them at the pocket AND force the worst case the fix must
// survive — a unit whose separation push has landed it ON the wall tile with
// its previous position on the near side. The ejection pass must put it back on
// the NEAR side, never across the wall. (Under the old outward-ring ejection
// this pocket pops units out on the far side — a wall teleport.)
const crowd = [];
for (let i = 0; i < 20; i++) {
  const ox = (wallX - 2) - (i % 3);
  const oy = gapRow - 2 + ((i / 3) | 0);
  const u = c.spawnUnit(0, "marine", tileToFp(ox), tileToFp(oy));
  d.spawnUnit(0, "marine", tileToFp(ox), tileToFp(oy));
  crowd.push(u.id);
}
step2([{ pid: 0, cmds: [{ t: "move", ids: crowd, x: tileToFp(wallX - 1), y: tileToFp(gapRow), q: 0 }] }]);

// Directly stage the mid-tick overshoot on BOTH sims identically: shove every
// crowd unit that is near the gap onto the wall tile (px/py stay on the near
// side, x/y move onto wallX), then run separate() and check ejection. This is
// the exact condition that produced the reported teleport. Do it repeatedly
// while the crowd churns so we cover many push directions.
const shoveOntoWall = (s) => {
  for (const id of crowd) {
    const u = s.byId.get(id);
    if (!u) continue;
    if (Math.abs(fpToTile(u.y) - gapRow) <= 2 && fpToTile(u.x) >= wallX - 2) {
      // legit near-side previous position: the gap tile, which is always free
      // (a unit reaches the pocket through the gap). This is a realistic pre-
      // push state — a unit that just walked in and got shoved onto the wall.
      u.px = tileToFp(wallX - 1); u.py = tileToFp(gapRow);
      u.x = tileToFp(wallX);                // overshoot ONTO the solid wall tile
      u.y = tileToFp(fpToTile(u.y));        // at some band row (near-neighbor blocked)
    }
  }
  s.separate();
};

let tunneled = false, tunnelInfo = "", maxNearX = 0;
for (let t = 0; t < 400; t++) {
  step2();
  shoveOntoWall(c); shoveOntoWall(d);       // identical on both -> deterministic
  for (const id of crowd) {
    const u = c.byId.get(id);
    if (!u) continue;
    const utx = fpToTile(u.x);
    if (utx > wallX) {
      tunneled = true;
      tunnelInfo = `unit ${id} at tile (${utx},${fpToTile(u.y)}), wallX=${wallX}, tick ${t}`;
      break;
    }
    if (utx > maxNearX) maxNearX = utx;
  }
  if (tunneled) break;
  if (c.checksum() !== d.checksum()) { check(`wall-test desync at tick ${t}`, false); break; }
}
if (tunneled) console.log("    tunnel detail:", tunnelInfo);
// sanity: the crowd really did reach the wall (else the test proves nothing)
check("crowd actually reached the wall (exercises ejection path)", maxNearX >= wallX - 1);
check("NO unit tunneled through the thin wall", !tunneled);
check("wall-test sims checksum-identical", c.checksum() === d.checksum());

// also assert the wall is still fully intact (units never destroyed it)
let intact = true;
for (let y = wy0; y <= wy1; y++) if (!c.blocked[y * c.map.w + wallX]) intact = false;
check("wall remained solid", intact);

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL MACRO CHECKS PASSED.");
process.exit(fail ? 1 : 0);
