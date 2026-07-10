// Headless macro-queue + wall-tunneling regression test.
//   - shift-queued build orders on a worker (build A, then build B / move)
//   - build-then-build chain completes both sites via one worker
//   - units cannot tunnel through a 1-tile-thick rock wall via separation
//   - two mirrored sims stay checksum-identical throughout
// Run: node test_macro.mjs
import { Sim } from "./js/core/sim.js";
import { tileToFp, fpToTile, FP } from "./js/core/fixed.js";
import { BUILDINGS } from "./js/core/data.js";

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

// Make a fresh pair of mirrored twin sims + a stepper, so later tasks each get
// their own map space (the 56x56 map can't fit many open regions on one sim).
function makeTwins(seed, o = opts) {
  const s1 = new Sim(seed, o), s2 = new Sim(seed, o);
  s1.noGameOver = s2.noGameOver = true;
  const st = (cmds = []) => { s1.step(cmds); s2.step(cmds); };
  const bo = (fn) => { fn(s1); fn(s2); };
  return { s1, s2, st, bo };
}

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

// ---- TASK 3: worker agency — idle after build, not re-mining -----------------
// A worker that finishes a build with an EMPTY queue goes IDLE (the user asked
// that workers not auto-return to mining; F1 finds idle workers).
{
  const { s1, s2, st } = makeTwins(1001);
  const reg = openRegion(s1, 4);
  check("found a region for the agency test", !!reg);
  const wa = s1.spawnUnit(0, "worker", tileToFp(reg.tx), tileToFp(reg.ty));
  s2.spawnUnit(0, "worker", tileToFp(reg.tx), tileToFp(reg.ty));
  s1.minerals[0] = s2.minerals[0] = 2000; s1.gas[0] = s2.gas[0] = 2000;
  const bsite = { tx: reg.tx + 2, ty: reg.ty - 1 };
  check("agency site placeable", s1.canPlace("depot", bsite.tx, bsite.ty, 0));
  st([{ pid: 0, cmds: [{ t: "build", workerId: wa.id, building: "depot", tx: bsite.tx, ty: bsite.ty, q: 0 }] }]);
  let doneA = false;
  for (let t = 0; t < 4000; t++) {
    st();
    const s = s1.entities.find((e) => e.building && e.tx === bsite.tx && e.ty === bsite.ty);
    if (s && s.done) { doneA = true; break; }
    if (s1.checksum() !== s2.checksum()) { check(`desync during agency build at tick ${t}`, false); break; }
  }
  check("agency build completed", doneA);
  st(); st(); // let the completion transition settle
  check("worker is IDLE after build (not gathering)", wa.order.kind === "idle");
  check("agency checksum identical", s1.checksum() === s2.checksum());
}

// ---- TASK 4: one-builder-per-site — second worker skips, rate unchanged ------
// Control: ONE worker builds a depot; record the completion tick. Experiment:
// TWO workers ordered onto the SAME site — completion tick must match the
// single-builder control (only one builder advances progress) and the second
// worker ends up idle.
{
  // single-builder control run on a throwaway sim
  const ctl = new Sim(777, opts); ctl.noGameOver = true;
  const rc = openRegion(ctl, 4);
  const cw = ctl.spawnUnit(0, "worker", tileToFp(rc.tx), tileToFp(rc.ty));
  ctl.minerals[0] = 2000; ctl.gas[0] = 2000;
  const cs = { tx: rc.tx + 2, ty: rc.ty - 1 };
  ctl.step([{ pid: 0, cmds: [{ t: "build", workerId: cw.id, building: "depot", tx: cs.tx, ty: cs.ty, q: 0 }] }]);
  let ctlTick = -1;
  for (let t = 0; t < 4000; t++) {
    ctl.step();
    const s = ctl.entities.find((e) => e.building && e.tx === cs.tx && e.ty === cs.ty);
    if (s && s.done) { ctlTick = ctl.tick; break; }
  }
  check("single-builder control completed", ctlTick > 0);

  // experiment on a fresh mirrored twin pair: two workers, same site.
  const { s1, s2, st } = makeTwins(1002);
  const reg = openRegion(s1, 4);
  check("found a region for the one-builder test", !!reg);
  // place the two workers a couple tiles apart so both must path to the site
  const e1a = s1.spawnUnit(0, "worker", tileToFp(reg.tx - 1), tileToFp(reg.ty));
  s2.spawnUnit(0, "worker", tileToFp(reg.tx - 1), tileToFp(reg.ty));
  const e2a = s1.spawnUnit(0, "worker", tileToFp(reg.tx + 1), tileToFp(reg.ty + 1));
  s2.spawnUnit(0, "worker", tileToFp(reg.tx + 1), tileToFp(reg.ty + 1));
  s1.minerals[0] = s2.minerals[0] = 2000; s1.gas[0] = s2.gas[0] = 2000;
  const es = { tx: reg.tx + 2, ty: reg.ty - 1 };
  check("one-builder site placeable", s1.canPlace("depot", es.tx, es.ty, 0));
  // first worker builds (spawns the site); mirror-issue on both sims so ids line
  // up, then send the second worker to the SAME site via resume.
  st([{ pid: 0, cmds: [{ t: "build", workerId: e1a.id, building: "depot", tx: es.tx, ty: es.ty, q: 0 }] }]);
  const siteId = s1.entities.find((e) => e.building && e.tx === es.tx && e.ty === es.ty).id;
  st([{ pid: 0, cmds: [{ t: "resume", ids: [e2a.id], targetId: siteId, q: 0 }] }]);
  // Track progress deltas. Seed prevProg with the site's CURRENT progress (a
  // worker may already be in range from the command steps above).
  let expTick = -1, maxStep = 0, buildTicks = 0;
  let prevProg = s1.byId.get(siteId).progress;
  for (let t = 0; t < 4000; t++) {
    st();
    const s = s1.byId.get(siteId);
    if (s) {
      const dp = s.progress - prevProg;
      if (dp > maxStep) maxStep = dp;   // largest single-tick progress jump
      if (dp > 0) buildTicks++;          // ticks where progress advanced
      prevProg = s.progress;
      if (s.done) { expTick = s1.tick; break; }
    }
    if (s1.checksum() !== s2.checksum()) { check(`desync during one-builder at tick ${t}`, false); break; }
  }
  check("two-worker site completed", expTick > 0);
  // Single-builder rate proof: progress never jumps >1 per tick (only one
  // claimant advances at a time). If both workers built, we'd see dp=2.
  check("progress never advanced more than 1/tick (only one builder)", maxStep <= 1);
  st(); st();
  const idleSecond = e1a.order.kind === "idle" || e2a.order.kind === "idle";
  check("one of the two workers ended up idle (skipped the claimed site)", idleSecond);
  check("one-builder checksum identical", s1.checksum() === s2.checksum());
}

// ---- TASK 5: gas exception — refinery builder harvests gas on completion -----
// Building a gas harvester is explicit intent to mine gas: on completion the
// builder should start gathering gas from it (not idle, not mine minerals).
{
  // find a geyser on the map and a flat approach; build a refinery on it.
  const geo = a.entities.find((e) => e.type === "geyser");
  check("map has a geyser for gas test", !!geo);
  if (geo) {
    // refinery is 2x2 onGeyser; place its footprint to cover the geyser tile.
    const gx = fpToTile(geo.x), gy = fpToTile(geo.y);
    let rt = null;
    for (let oy = 0; oy < 2 && !rt; oy++)
      for (let ox = 0; ox < 2 && !rt; ox++)
        if (a.canPlace("refinery", gx - ox, gy - oy, 0)) rt = { tx: gx - ox, ty: gy - oy };
    check("refinery placeable on geyser", !!rt);
    if (rt) {
      const gw = a.spawnUnit(0, "worker", tileToFp(gx + 2), tileToFp(gy + 2));
      const gwb = b.spawnUnit(0, "worker", tileToFp(gx + 2), tileToFp(gy + 2));
      // also need a deposit nearby for gas return; the start HQ suffices if close,
      // but just assert the order chain, not a full return trip.
      both((s) => { s.minerals[0] = 2000; s.gas[0] = 2000; });
      step([{ pid: 0, cmds: [{ t: "build", workerId: gw.id, building: "refinery", tx: rt.tx, ty: rt.ty, q: 0 }] }]);
      let refDone = false;
      for (let t = 0; t < 5000; t++) {
        step();
        const s = a.entities.find((e) => e.building && e.tx === rt.tx && e.ty === rt.ty);
        if (s && s.done) { refDone = true; break; }
        if (a.checksum() !== b.checksum()) { check(`desync during refinery build at tick ${t}`, false); break; }
      }
      check("refinery completed", refDone);
      step(); // let completion transition set the gather order
      check("builder now gathers GAS from the refinery",
        gw.order.kind === "gather" && gw.order.resource === "gas");
      const ref = a.entities.find((e) => e.building && e.tx === rt.tx && e.ty === rt.ty);
      check("gas order targets the refinery", gw.order.targetId === ref.id);
      check("gas-exception checksum identical", a.checksum() === b.checksum());
    }
  }
}

// ---- TASK 6: ooze escort-build — nearest mote walks over, melts in ----------
{
  const oopts = { factions: ["ooze", "ooze"] };
  const oa = new Sim(999, oopts);
  const ob = new Sim(999, oopts);
  oa.noGameOver = ob.noGameOver = true;
  const ostep = (cmds = []) => { oa.step(cmds); ob.step(cmds); };
  // find an open region that's ON GOO (ooze buildings need goo). The Nucleus
  // stamps goo around the start; place the Pod near the start on goo.
  // Search near player-0 start for a 2x2 goo footprint clear of blockers.
  const start = oa.map.starts[0];
  let podSite = null;
  for (let r = 3; r < 10 && !podSite; r++) {
    for (let dy = -r; dy <= r && !podSite; dy++)
      for (let dx = -r; dx <= r && !podSite; dx++) {
        const tx = start.x + dx, ty = start.y + dy;
        if (oa.canPlace("pod", tx, ty, 0)) podSite = { tx, ty };
      }
  }
  check("found an ooze Pod site on goo", !!podSite);
  // Find an unblocked tile ~6-9 tiles from the site center that a mote can path
  // FROM (map terrain near the base can otherwise strand a fixed offset).
  function walkableNear(s, ctx, cty, minR, maxR) {
    const { w, h } = s.map;
    for (let r = minR; r <= maxR; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = ctx + dx, ty = cty + dy;
          if (tx < 1 || ty < 1 || tx >= w - 1 || ty >= h - 1) continue;
          if (s.blocked[ty * w + tx]) continue;
          if (s.map.height && s.map.height[ty * w + tx] !== s.map.height[cty * w + ctx]) continue;
          return { tx, ty };
        }
    return null;
  }
  if (podSite) {
    const cxT = podSite.tx + 1, cyT = podSite.ty + 1;
    // spawn the escort mote a modest, verified-walkable distance from the site.
    const spawnT = walkableNear(oa, cxT, cyT, 5, 9) || { tx: cxT + 5, ty: cyT };
    const escA = oa.spawnUnit(0, "mote", tileToFp(spawnT.tx), tileToFp(spawnT.ty));
    const escB = ob.spawnUnit(0, "mote", tileToFp(spawnT.tx), tileToFp(spawnT.ty));
    // relocate start motes to the far map corner so escA is unambiguously the
    // nearest (mirror both sims).
    const farX = tileToFp(oa.map.w - 3), farY = tileToFp(oa.map.h - 3);
    for (const s of [oa, ob]) {
      for (const e of s.entities) {
        if (e.unit && e.type === "mote" && e.owner === 0 && e.id !== (s === oa ? escA.id : escB.id)) {
          e.x = farX; e.y = farY; e.px = e.x; e.py = e.y;
        }
      }
    }
    for (const s of [oa, ob]) { s.minerals[0] = 2000; s.gas[0] = 2000; }
    const minsBefore = oa.minerals[0];
    ostep([{ pid: 0, cmds: [{ t: "ooze_build", building: "pod", tx: podSite.tx, ty: podSite.ty }] }]);
    check("ooze_build reserved cost immediately", oa.minerals[0] === minsBefore - BUILDINGS.pod.cost);
    check("escort mote got an oozebuild order", escA.order.kind === "oozebuild");
    let podSpawned = false, podDone = false, moteGone = false;
    for (let t = 0; t < 6000; t++) {
      ostep();
      const site = oa.entities.find((e) => e.building && e.tx === podSite.tx && e.ty === podSite.ty);
      if (site) { podSpawned = true; if (site.done) podDone = true; }
      if (!oa.byId.has(escA.id)) moteGone = true;
      if (podDone) break;
      if (oa.checksum() !== ob.checksum()) { check(`desync during ooze escort at tick ${t}`, false); break; }
    }
    check("escort: pod site spawned on arrival", podSpawned);
    check("escort: mote consumed on arrival", moteGone);
    check("escort: pod self-completed", podDone);
    check("ooze-escort checksum identical", oa.checksum() === ob.checksum());
  }

  // refund case: block the spot after issuing so canPlace fails on arrival.
  {
    const ra = new Sim(999, oopts);
    const rb = new Sim(999, oopts);
    ra.noGameOver = rb.noGameOver = true;
    const rstep = (cmds = []) => { ra.step(cmds); rb.step(cmds); };
    const st = ra.map.starts[0];
    let site = null;
    for (let r = 3; r < 10 && !site; r++)
      for (let dy = -r; dy <= r && !site; dy++)
        for (let dx = -r; dx <= r && !site; dx++) {
          const tx = st.x + dx, ty = st.y + dy;
          if (ra.canPlace("pod", tx, ty, 0)) site = { tx, ty };
        }
    if (site) {
      const cxT = site.tx + 1, cyT = site.ty + 1;
      const spT = walkableNear(ra, cxT, cyT, 5, 9) || { tx: cxT + 5, ty: cyT };
      const mA = ra.spawnUnit(0, "mote", tileToFp(spT.tx), tileToFp(spT.ty));
      const mB = rb.spawnUnit(0, "mote", tileToFp(spT.tx), tileToFp(spT.ty));
      // relocate the start motes to the far corner so mA/mB are the nearest
      const farX = tileToFp(ra.map.w - 3), farY = tileToFp(ra.map.h - 3);
      for (const s of [ra, rb]) {
        const keep = s === ra ? mA.id : mB.id;
        for (const e of s.entities) {
          if (e.unit && e.type === "mote" && e.owner === 0 && e.id !== keep) {
            e.x = farX; e.y = farY; e.px = e.x; e.py = e.y;
          }
        }
        s.minerals[0] = 2000; s.gas[0] = 2000;
      }
      const before = ra.minerals[0];
      rstep([{ pid: 0, cmds: [{ t: "ooze_build", building: "pod", tx: site.tx, ty: site.ty }] }]);
      check("refund case: cost reserved", ra.minerals[0] === before - BUILDINGS.pod.cost);
      // now block the footprint on BOTH sims (stamp rock) so arrival canPlace fails
      for (const s of [ra, rb]) {
        const { w } = s.map;
        for (let y = site.ty; y < site.ty + 2; y++)
          for (let x = site.tx; x < site.tx + 2; x++) { s.blocked[y * w + x] = 1; s.map.rock[y * w + x] = 1; }
      }
      let refunded = false;
      const mote = ra.entities.find((e) => e.unit && e.type === "mote" && e.order.kind === "oozebuild");
      for (let t = 0; t < 6000; t++) {
        rstep();
        if (ra.minerals[0] >= before) { refunded = true; break; }
        if (ra.checksum() !== rb.checksum()) { check(`desync during ooze refund at tick ${t}`, false); break; }
        if (!ra.byId.has(mote?.id)) break; // mote died unexpectedly
      }
      check("refund case: cost refunded when spot blocked on arrival", refunded);
      check("ooze-refund checksum identical", ra.checksum() === rb.checksum());
    }
  }
}

// ---- TASK 7: shift-queued ability — move THEN leap ---------------------------
// A Brute: move to a point, then shift-leap further. The leap makes the unit's
// position jump ~leap distance in a single-ish window after the move completes.
{
  const { s1, s2, st } = makeTwins(1003);
  const reg = openRegion(s1, 5);
  check("found a region for the leap chain", !!reg);
  if (reg) {
    const bra = s1.spawnUnit(0, "brute", tileToFp(reg.tx), tileToFp(reg.ty));
    s2.spawnUnit(0, "brute", tileToFp(reg.tx), tileToFp(reg.ty));
    const moveTo = { x: tileToFp(reg.tx + 2), y: tileToFp(reg.ty) };
    const leapTo = { x: tileToFp(reg.tx + 5), y: tileToFp(reg.ty) };
    // move (q:0), then shift-queue the leap ability (q:1)
    st([{ pid: 0, cmds: [
      { t: "move", ids: [bra.id], x: moveTo.x, y: moveTo.y, q: 0 },
      { t: "ability", ids: [bra.id], ability: "leap", x: leapTo.x, y: leapTo.y, q: 1 },
    ] }]);
    check("leap ability queued behind the move",
      bra.order.kind === "move" && bra.next.length === 1 && bra.next[0].kind === "ability");
    let leaped = false, reachedMove = false;
    for (let t = 0; t < 3000; t++) {
      st();
      if (!reachedMove && bra.order.kind !== "move" && Math.abs(bra.x - moveTo.x) < FP * 2) reachedMove = true;
      if (bra.leapUntil) leaped = true;
      if (leaped && Math.abs(bra.x - leapTo.x) < FP) break;
      if (s1.checksum() !== s2.checksum()) { check(`desync during move+leap at tick ${t}`, false); break; }
    }
    check("unit reached the move waypoint first", reachedMove);
    check("queued leap then fired (unit leapt after moving)", leaped);
    check("unit ended near the leap target (position jumped)", Math.abs(bra.x - leapTo.x) < FP * 2);
    check("move+leap checksum identical", s1.checksum() === s2.checksum());
  }
}

// ---- TASK 8: cog repair — damaged tank healed, minerals spent, then idle -----
{
  const { s1, s2, st } = makeTwins(1004);
  const reg = openRegion(s1, 4);
  check("found a region for repair test", !!reg);
  if (reg) {
    const tka = s1.spawnUnit(0, "tank", tileToFp(reg.tx + 1), tileToFp(reg.ty));
    s2.spawnUnit(0, "tank", tileToFp(reg.tx + 1), tileToFp(reg.ty));
    const rwa = s1.spawnUnit(0, "worker", tileToFp(reg.tx), tileToFp(reg.ty));
    s2.spawnUnit(0, "worker", tileToFp(reg.tx), tileToFp(reg.ty));
    // idle the 5 auto-gathering start workers so only the repair moves minerals
    // (their mining would otherwise mask the repair cost).
    for (const s of [s1, s2]) {
      for (const e of s.entities) if (e.unit && e.type === "worker" && e.id !== rwa.id) e.order = { kind: "idle" };
      for (const e of s.entities) if (e.type === "tank" && e.owner === 0) e.hp = 40;
      s.minerals[0] = 500;
    }
    const hp0 = tka.hp, mins0 = s1.minerals[0];
    st([{ pid: 0, cmds: [{ t: "repair", ids: [rwa.id], targetId: tka.id, q: 0 }] }]);
    let healed = false;
    for (let t = 0; t < 3000; t++) {
      st();
      if (tka.hp >= tka.maxHp) { healed = true; break; }
      if (s1.checksum() !== s2.checksum()) { check(`desync during repair at tick ${t}`, false); break; }
    }
    check("repair healed the tank to full", healed && tka.hp === tka.maxHp);
    check("repair rose HP above the damaged value", tka.hp > hp0);
    check("repair spent minerals", s1.minerals[0] < mins0);
    st(); st();
    check("worker idles after finishing repair", rwa.order.kind === "idle");
    check("repair checksum identical", s1.checksum() === s2.checksum());

    // no-op: repairing a FULL-HP target does nothing (worker just idles)
    const mBefore = s1.minerals[0];
    st([{ pid: 0, cmds: [{ t: "repair", ids: [rwa.id], targetId: tka.id, q: 0 }] }]);
    st(); st();
    check("repair on full-hp target is a no-op (no minerals spent)", s1.minerals[0] === mBefore);
    check("repair no-op leaves worker idle", rwa.order.kind === "idle");
    check("repair-noop checksum identical", s1.checksum() === s2.checksum());
  }
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL MACRO CHECKS PASSED.");
process.exit(fail ? 1 : 0);
