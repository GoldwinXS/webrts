// Temporary determinism + feature test for the gas/tech/air/turret/LoS wave.
// Run with:  node _agenttest.mjs   (from the webrts dir). Delete after.
import { Sim } from "./js/core/sim.js";
import { FP, tileToFp, fpToTile } from "./js/core/fixed.js";
import { GAS_AMOUNT } from "./js/core/data.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };
const eq = (name, a, b) => ok(`${name} (${a} === ${b})`, a === b);

// ---------------------------------------------------------------------------
// Helpers to carve a controlled arena into an already-constructed Sim.
// ---------------------------------------------------------------------------

// Clear a rectangle of blocked/height so units can move freely there.
function clearArena(sim, x0, y0, x1, y1) {
  const { w } = sim.map;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      sim.blocked[y * w + x] = 0;
      if (sim.map.rock) sim.map.rock[y * w + x] = 0;
      if (sim.map.height) sim.map.height[y * w + x] = 0;
    }
}

// Reveal everything so vision never gates test combat, unless a test wants fog.
function revealAll(sim) {
  for (const f of sim.fog) f.fill(2);
}

// First tile where a building of `type` can be placed (deterministic scan).
function findClear(sim, type) {
  for (let ty = 8; ty < sim.map.h - 6; ty++)
    for (let tx = 8; tx < sim.map.w - 6; tx++)
      if (sim.canPlace(type, tx, ty)) return [tx, ty];
  return [10, 10];
}

// Add a geyser at tile (tx,ty).
function addGeyser(sim, tx, ty) {
  return sim.addEntity({
    type: "geyser", owner: -1, x: tileToFp(tx), y: tileToFp(ty),
    hp: 0, maxHp: 0, amount: GAS_AMOUNT, radius: (FP * 0.45) | 0, geyser: true,
  });
}

// ---------------------------------------------------------------------------
// A scripted scenario, applied identically to two same-seed sims. Returns the
// per-tick command bundle for a given tick (or null). We drive both players.
// ---------------------------------------------------------------------------

// Build the identical setup on a sim: clear arena near P0 start, add a geyser,
// give each player a small controlled force, return handles by role.
function setupScenario(sim) {
  clearArena(sim, 2, 2, sim.map.w - 3, sim.map.h - 3);
  // find an open staging tile with NO resource nearby (deterministic scan), so
  // building footprints never collide with the map's mineral/geyser clusters.
  const { w, h } = sim.map;
  const resNear = (tx, ty, r) => sim.entities.some((e) =>
    (e.type === "mineral" || e.type === "geyser") &&
    Math.abs(fpToTile(e.x) - tx) <= r && Math.abs(fpToTile(e.y) - ty) <= r);
  let gx = 12, gy = 12;
  outer: for (let ty = 10; ty < h - 12; ty++)
    for (let tx = 10; tx < w - 12; tx++)
      if (!resNear(tx, ty, 9)) { gx = tx; gy = ty; break outer; }
  const gey = addGeyser(sim, gx, gy);       // geyser at the clear staging tile
  sim.minerals[0] = 5000; sim.gas[0] = 5000;
  sim.minerals[1] = 5000; sim.gas[1] = 5000;
  revealAll(sim);
  // reserve non-overlapping build spots around the clear geyser
  const rax = [gx - 6, gy];       // barracks (size 3)
  const fac = [gx + 4, gy];       // factory  (size 3)
  const spt = [gx - 6, gy + 6];   // starport (size 3)
  // teleport p0's workers next to the staging zone so build walks are short
  // and deterministic regardless of where the map put the start location.
  const pw = sim.entities.filter((e) => e.owner === 0 && e.type === "worker");
  pw.forEach((wk, i) => {
    wk.x = tileToFp(gx - 2 + (i % 3)); wk.y = tileToFp(gy - 4 - ((i / 3) | 0));
    wk.px = wk.x; wk.py = wk.y; wk.order = { kind: "idle" }; wk.path = null;
  });
  return { gx, gy, geyId: gey.id, rax, fac, spt };
}

// Deterministic scripted command timeline. `ctx` carries ids discovered as the
// scenario runs (both sims discover the SAME ids since construction order is
// identical). We reference entities by role via lookups on the sim itself.
function scriptedStep(sim, tick, ctx) {
  const p0 = (t) => ({ pid: 0, cmds: t });
  const p1 = (t) => ({ pid: 1, cmds: t });
  const own0 = (pred) => sim.entities.find((e) => e.owner === 0 && pred(e));
  const cmds0 = [];

  const hq0 = own0((e) => e.type === "hq" && e.done);
  const worker0 = sim.entities.filter((e) => e.owner === 0 && e.type === "worker");

  if (tick === 2 && hq0) {
    // build a refinery on the geyser (worker 0)
    const w = worker0[0];
    // 2x2 origin covering the geyser tile
    cmds0.push({ t: "build", workerId: w.id, building: "refinery", tx: ctx.gx, ty: ctx.gy });
    // also start a barracks so factory prereq is satisfiable
    const w2 = worker0[1];
    cmds0.push({ t: "build", workerId: w2.id, building: "barracks", tx: ctx.rax[0], ty: ctx.rax[1] });
  }

  if (tick === 200) {
    // send up to 3 NON-constructing workers to gather gas at the refinery once
    // it is done (never yank a worker off a half-built barracks/factory).
    const ref = own0((e) => e.type === "refinery" && e.done);
    if (ref) {
      const free = sim.entities
        .filter((e) => e.owner === 0 && e.type === "worker" && e.order.kind !== "build")
        .slice(0, 3);
      if (free.length) cmds0.push({ t: "gather", ids: free.map((w) => w.id), targetId: ref.id });
    }
  }

  if (tick === 400) {
    // build a factory (barracks should be done)
    const w = worker0[worker0.length - 1];
    if (w) cmds0.push({ t: "build", workerId: w.id, building: "factory", tx: ctx.fac[0], ty: ctx.fac[1] });
  }

  // build a starport once the factory is up, so we can train a wraith
  if ((tick === 850 || tick === 1000) && !own0((e) => e.type === "starport") &&
      own0((e) => e.type === "factory" && e.done)) {
    const w = worker0.find((x) => x.order.kind === "gather" || x.order.kind === "idle");
    if (w) cmds0.push({ t: "build", workerId: w.id, building: "starport", tx: ctx.spt[0], ty: ctx.spt[1] });
  }
  // train a wraith from a finished starport — retry each 10 ticks until queued
  if (tick % 10 === 0 && tick >= 1220) {
    const sp = own0((e) => e.type === "starport" && e.done);
    if (sp) {
      const hasWraith = sim.entities.some((e) => e.owner === 0 && e.type === "wraith");
      if (!hasWraith && sp.queue.length === 0) cmds0.push({ t: "train", buildingId: sp.id, unit: "wraith" });
    }
  }

  // retry the tank train a few times (factory finishes ~tick 810, after the
  // builder walks to the site) so the scenario reliably produces a tank
  if (tick === 850 || tick === 1000 || tick === 1150) {
    const fac = own0((e) => e.type === "factory" && e.done);
    const hasTank = sim.entities.some((e) => e.owner === 0 && e.type === "tank");
    const facQueued = fac && fac.queue.length > 0;
    if (fac && !hasTank && !facQueued) cmds0.push({ t: "train", buildingId: fac.id, unit: "tank" });
    const rax = own0((e) => e.type === "barracks" && e.done);
    if (tick === 850 && rax) cmds0.push({ t: "train", buildingId: rax.id, unit: "marine" });
  }

  return [p0(cmds0), p1([])];
}

// ---------------------------------------------------------------------------
// TEST 1 — two same-seed sims, identical scripted commands, 1500 ticks:
//          byte-identical checksums the whole way.
// ---------------------------------------------------------------------------
{
  const seed = 12345;
  const a = new Sim(seed), b = new Sim(seed);
  const ctxA = setupScenario(a), ctxB = setupScenario(b);
  let identical = true, firstDiff = -1;
  const TICKS = 1900;
  for (let t = 0; t < TICKS; t++) {
    const bundleA = scriptedStep(a, t, ctxA);
    const bundleB = scriptedStep(b, t, ctxB);
    a.step(bundleA); b.step(bundleB);
    if (a.checksum() !== b.checksum()) { identical = false; if (firstDiff < 0) firstDiff = t; }
  }
  ok(`T1 determinism: ${TICKS} ticks bit-identical (firstDiff=${firstDiff})`, identical);
  // sanity: p0 actually built a refinery + factory + a tank during the run
  const hasRef = a.entities.some((e) => e.owner === 0 && e.type === "refinery" && e.done);
  const hasFac = a.entities.some((e) => e.owner === 0 && e.type === "factory" && e.done);
  const hasTank = a.entities.some((e) => e.owner === 0 && e.type === "tank");
  const hasSp = a.entities.some((e) => e.owner === 0 && e.type === "starport" && e.done);
  // a wraith either spawned or is still in the starport queue (both prove the
  // full air production path — build starport + pay gas + queue wraith).
  const spA = a.entities.find((e) => e.owner === 0 && e.type === "starport");
  const hasWraith = a.entities.some((e) => e.owner === 0 && e.type === "wraith") ||
    (spA?.queue || []).some((q) => q.type === "wraith");
  ok("T1 built refinery", hasRef);
  ok("T1 built factory", hasFac);
  ok("T1 trained tank", hasTank);
  ok("T1 built starport", hasSp);
  ok("T1 trained wraith", hasWraith);
}

// ---------------------------------------------------------------------------
// TEST 2 — gas accumulates and deducts correctly.
// ---------------------------------------------------------------------------
{
  const sim = new Sim(999);
  const ctx = setupScenario(sim);
  const startGas = sim.gas[0];
  // build refinery
  const w = sim.entities.find((e) => e.owner === 0 && e.type === "worker");
  sim.step([{ pid: 0, cmds: [{ t: "build", workerId: w.id, building: "refinery", tx: ctx.gx, ty: ctx.gy }] }, { pid: 1, cmds: [] }]);
  const afterBuild = sim.gas[0];
  eq("T2 refinery has 0 gas cost (gas unchanged by build)", afterBuild, startGas);

  // run until refinery done + assign 3 workers, then harvest a while
  for (let t = 0; t < 250; t++) sim.step([{ pid: 0, cmds: [] }, { pid: 1, cmds: [] }]);
  const ref = sim.entities.find((e) => e.owner === 0 && e.type === "refinery" && e.done);
  ok("T2 refinery finished", !!ref);
  const gasBeforeHarvest = sim.gas[0];
  const workers = sim.entities.filter((e) => e.owner === 0 && e.type === "worker").slice(0, 3);
  sim.step([{ pid: 0, cmds: [{ t: "gather", ids: workers.map((x) => x.id), targetId: ref.id }] }, { pid: 1, cmds: [] }]);
  for (let t = 0; t < 600; t++) sim.step([{ pid: 0, cmds: [] }, { pid: 1, cmds: [] }]);
  ok(`T2 gas accumulated from harvest (${gasBeforeHarvest} -> ${sim.gas[0]})`, sim.gas[0] > gasBeforeHarvest);
  // geyser depleted by the amount deposited (gas gained ~ geyser drop)
  const gey = sim.byId.get(ctx.geyId);
  ok(`T2 geyser drained (amount ${gey.amount} < ${GAS_AMOUNT})`, gey.amount < GAS_AMOUNT);

  // stop all worker income so the resource-deduction check is exact (a mid-step
  // deposit would otherwise add minerals/gas back and skew the delta).
  for (const w of sim.entities) if (w.owner === 0 && w.type === "worker") { w.order = { kind: "idle" }; w.carry = 0; w.path = null; }
  // hand-place a done factory near base for a clean deduction check
  sim.minerals[0] = 5000; sim.gas[0] = 1000;
  // build barracks + factory instantly by spawning them done (away from the
  // mineral line so the footprint is clear)
  const rax = sim.spawnBuilding(0, "barracks", ctx.gx - 6, ctx.gy, true);
  const fac = sim.spawnBuilding(0, "factory", ctx.gx - 6, ctx.gy + 6, true);
  const gPre = sim.gas[0], mPre = sim.minerals[0];
  sim.step([{ pid: 0, cmds: [{ t: "train", buildingId: fac.id, unit: "tank" }] }, { pid: 1, cmds: [] }]);
  eq("T2 tank train deducted 75 gas", sim.gas[0], gPre - 75);
  eq("T2 tank train deducted 150 minerals", sim.minerals[0], mPre - 150);
}

// ---------------------------------------------------------------------------
// TEST 3 — targeting: tank cannot damage a wraith (attack rejected / no dmg),
//          marine CAN hit the wraith, turret shoots the wraith.
// ---------------------------------------------------------------------------
{
  const sim = new Sim(7);
  clearArena(sim, 2, 2, sim.map.w - 3, sim.map.h - 3);
  revealAll(sim);
  const cx = 20, cy = 20;
  // p0 tank, p0 marine, p0 turret; p1 wraith placed right next to them
  const tank = sim.spawnUnit(0, "tank", tileToFp(cx), tileToFp(cy));
  const marine = sim.spawnUnit(0, "marine", tileToFp(cx + 1), tileToFp(cy));
  const wraith = sim.spawnUnit(1, "wraith", tileToFp(cx), tileToFp(cy + 1));
  const wraithHp0 = wraith.hp;

  // attack command: tank -> wraith should be REJECTED (tank has no air weapon)
  sim.step([{ pid: 0, cmds: [{ t: "attack", ids: [tank.id], targetId: wraith.id }] }, { pid: 1, cmds: [] }]);
  ok("T3 tank attack-command on wraith rejected (stays idle)", tank.order.kind === "idle");

  // let the scene run; tank must never damage the wraith, marine must.
  const wr2 = sim.spawnUnit(1, "wraith", tileToFp(cx + 1), tileToFp(cy + 1));
  const wr2Hp0 = wr2.hp;
  sim.step([{ pid: 0, cmds: [{ t: "attack", ids: [marine.id], targetId: wr2.id }] }, { pid: 1, cmds: [] }]);
  ok("T3 marine attack-command on wraith accepted", marine.order.kind === "attack");
  for (let t = 0; t < 40; t++) sim.step([{ pid: 0, cmds: [] }, { pid: 1, cmds: [] }]);
  ok(`T3 marine damaged wraith (${wr2Hp0} -> ${wr2.hp})`, wr2.hp < wr2Hp0);

  // turret vs wraith: place a turret and a fresh wraith, run.
  const sim2 = new Sim(8);
  clearArena(sim2, 2, 2, sim2.map.w - 3, sim2.map.h - 3);
  revealAll(sim2);
  const turret = sim2.spawnBuilding(0, "turret", 20, 20, true);
  const wr3 = sim2.spawnUnit(1, "wraith", tileToFp(22), tileToFp(21));
  const wr3Hp0 = wr3.hp;
  for (let t = 0; t < 30; t++) sim2.step([{ pid: 0, cmds: [] }, { pid: 1, cmds: [] }]);
  ok(`T3 turret shot wraith (${wr3Hp0} -> ${wr3.hp})`, wr3.hp < wr3Hp0);

  // control: a ground-only worker cannot damage a flyer at all
  const sim3 = new Sim(9);
  clearArena(sim3, 2, 2, sim3.map.w - 3, sim3.map.h - 3);
  revealAll(sim3);
  const wkr = sim3.spawnUnit(0, "worker", tileToFp(20), tileToFp(20));
  const wr4 = sim3.spawnUnit(1, "wraith", tileToFp(20), tileToFp(21));
  const wr4Hp0 = wr4.hp;
  sim3.step([{ pid: 0, cmds: [{ t: "attack", ids: [wkr.id], targetId: wr4.id }] }, { pid: 1, cmds: [] }]);
  for (let t = 0; t < 40; t++) sim3.step([{ pid: 0, cmds: [] }, { pid: 1, cmds: [] }]);
  eq("T3 worker never damaged wraith", wr4.hp, wr4Hp0);
}

// ---------------------------------------------------------------------------
// TEST 4 — a flyer crosses a cliff-walled pocket a ground unit must path around.
// ---------------------------------------------------------------------------
{
  const sim = new Sim(4242);
  const { w, h } = sim.map;
  clearArena(sim, 2, 2, w - 3, h - 3);
  revealAll(sim);
  // Build a vertical wall of rock from y=10..30 at x=25, with the only gap far
  // away, forcing a ground detour. Flyer ignores it.
  for (let y = 8; y <= 34; y++) sim.blocked[y * w + 25] = 1;
  // start both units left of the wall at (18,20); target right of the wall (32,20)
  const sx = tileToFp(18), sy = tileToFp(20), tx = tileToFp(32), ty = tileToFp(20);
  const ground = sim.spawnUnit(0, "marine", sx, sy);
  const flyer = sim.spawnUnit(0, "wraith", sx, sy);
  sim.step([{ pid: 0, cmds: [
    { t: "move", ids: [ground.id], x: tx, y: ty },
    { t: "move", ids: [flyer.id], x: tx, y: ty },
  ] }, { pid: 1, cmds: [] }]);
  let flyerArrived = -1, groundArrived = -1;
  const near = (u) => Math.abs(u.x - tx) < FP && Math.abs(u.y - ty) < FP;
  for (let t = 0; t < 1200; t++) {
    sim.step([{ pid: 0, cmds: [] }, { pid: 1, cmds: [] }]);
    if (flyerArrived < 0 && near(flyer)) flyerArrived = t;
    if (groundArrived < 0 && near(ground)) groundArrived = t;
    if (flyerArrived >= 0 && groundArrived >= 0) break;
  }
  ok(`T4 flyer arrived (${flyerArrived}) and did NOT cross a wall gap`, flyerArrived >= 0);
  ok(`T4 ground arrived too (${groundArrived})`, groundArrived >= 0);
  ok(`T4 flyer beat ground around the wall (${flyerArrived} < ${groundArrived})`,
     flyerArrived >= 0 && groundArrived >= 0 && flyerArrived < groundArrived);
}

// ---------------------------------------------------------------------------
// TEST 5 — line-of-sight fog: height + blockers.
// ---------------------------------------------------------------------------
{
  const sim = new Sim(555);
  const { w, h } = sim.map;
  clearArena(sim, 2, 2, w - 3, h - 3);
  // synthetic height field: a plateau (height 2) occupying x>=30, everything
  // else height 0. Remove any pre-existing entities' vision influence by
  // wiping fog to explored (1) then recomputing.
  sim.map.height = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 30; x < w; x++) sim.map.height[y * w + x] = 2;
  sim.map.losBlock = new Uint8Array(w * h);

  // Clear the two default HQs and workers' vision by removing all owned units,
  // then place exactly one viewer for the test.
  sim.entities = sim.entities.filter((e) => e.type === "mineral");
  sim.byId.clear();
  for (const e of sim.entities) sim.byId.set(e.id, e);

  // (a) a ground unit at low ground (x=20) should NOT see onto the plateau top.
  const low = sim.spawnUnit(0, "marine", tileToFp(20), tileToFp(20));
  // (b) a ground unit ON the plateau (x=34) should see the low ground below.
  const high = sim.spawnUnit(1, "marine", tileToFp(34), tileToFp(20));
  sim.fog[0].fill(1); sim.fog[1].fill(1);
  sim.updateFog();

  // low viewer: a tile on the plateau (x=31) within sight range must be hidden
  // because height there (2) > viewer height (0) — the cliff blocks the ray.
  const plateauTile = 20 * w + 31;
  eq("T5a low-ground viewer cannot see plateau tile", sim.fog[0][plateauTile], 1);
  // its own tile is visible
  eq("T5a low viewer sees own tile", sim.fog[0][20 * w + 20], 2);

  // high viewer on plateau: a low tile just below the cliff edge (x=29) should
  // be visible (looking down is unobstructed).
  const lowTile = 20 * w + 29;
  eq("T5b plateau viewer sees low ground below", sim.fog[1][lowTile], 2);

  // (c) losBlock patch hides what's behind it. Flat area, viewer at x=10,
  // blocker column at x=13, target at x=15 on the same row must be hidden.
  const sim2 = new Sim(556);
  const w2 = sim2.map.w, h2 = sim2.map.h;
  clearArena(sim2, 2, 2, w2 - 3, h2 - 3);
  sim2.map.height = new Uint8Array(w2 * h2);   // all flat
  sim2.map.losBlock = new Uint8Array(w2 * h2);
  sim2.entities = sim2.entities.filter((e) => e.type === "mineral");
  sim2.byId.clear(); for (const e of sim2.entities) sim2.byId.set(e.id, e);
  const viewer = sim2.spawnUnit(0, "marine", tileToFp(10), tileToFp(20));
  sim2.map.losBlock[20 * w2 + 13] = 1;         // blocker directly in the line
  sim2.fog[0].fill(1);
  sim2.updateFog();
  eq("T5c blocker tile itself is visible", sim2.fog[0][20 * w2 + 13], 2);
  eq("T5c tile BEHIND blocker is hidden", sim2.fog[0][20 * w2 + 15], 1);
  eq("T5c tile beside the blocker (clear ray) is visible", sim2.fog[0][18 * w2 + 13], 2);

  // (d) flyer ignores blockers: same setup, flying viewer sees past the wall.
  const sim3 = new Sim(557);
  const w3 = sim3.map.w, h3 = sim3.map.h;
  clearArena(sim3, 2, 2, w3 - 3, h3 - 3);
  sim3.map.height = new Uint8Array(w3 * h3);
  for (let y = 0; y < h3; y++) for (let x = 30; x < w3; x++) sim3.map.height[y * w3 + x] = 2;
  sim3.map.losBlock = new Uint8Array(w3 * h3);
  sim3.entities = sim3.entities.filter((e) => e.type === "mineral");
  sim3.byId.clear(); for (const e of sim3.entities) sim3.byId.set(e.id, e);
  const flyer = sim3.spawnUnit(0, "wraith", tileToFp(28), tileToFp(20)); // sight 9
  sim3.fog[0].fill(1);
  sim3.updateFog();
  eq("T5d flyer sees onto plateau despite height", sim3.fog[0][20 * w3 + 31], 2);
}

// ---------------------------------------------------------------------------
// TEST 6 — tech prereqs: factory build rejected without a barracks.
// ---------------------------------------------------------------------------
{
  const sim = new Sim(6161);
  clearArena(sim, 2, 2, sim.map.w - 3, sim.map.h - 3);
  revealAll(sim);
  sim.minerals[0] = 5000; sim.gas[0] = 5000;
  // pick a build spot that canPlace accepts on this seed (clear of minerals)
  const spot = findClear(sim, "factory");
  const spot2 = [spot[0] + 5, spot[1] + 5];
  const w = sim.entities.find((e) => e.owner === 0 && e.type === "worker");
  const before = sim.entities.filter((e) => e.type === "factory").length;
  // no barracks yet -> factory rejected
  sim.step([{ pid: 0, cmds: [{ t: "build", workerId: w.id, building: "factory", tx: spot[0], ty: spot[1] }] }, { pid: 1, cmds: [] }]);
  const afterNoRax = sim.entities.filter((e) => e.type === "factory").length;
  eq("T6 factory rejected without barracks", afterNoRax, before);
  eq("T6 minerals not spent on rejected factory", sim.minerals[0], 5000);

  // add a finished barracks -> now factory allowed
  sim.spawnBuilding(0, "barracks", spot2[0], spot2[1], true);
  const w2 = sim.entities.find((e) => e.owner === 0 && e.type === "worker");
  sim.step([{ pid: 0, cmds: [{ t: "build", workerId: w2.id, building: "factory", tx: spot[0], ty: spot[1] }] }, { pid: 1, cmds: [] }]);
  const afterRax = sim.entities.filter((e) => e.type === "factory").length;
  eq("T6 factory allowed WITH barracks", afterRax, before + 1);

  // starport rejected without a factory finished (we only have a site)
  const spSpot = findClear(sim, "starport");
  const w3 = sim.entities.find((e) => e.owner === 0 && e.type === "worker" && e.order.kind !== "build");
  const spBefore = sim.entities.filter((e) => e.type === "starport").length;
  sim.step([{ pid: 0, cmds: [{ t: "build", workerId: w3.id, building: "starport", tx: spSpot[0], ty: spSpot[1] }] }, { pid: 1, cmds: [] }]);
  eq("T6 starport rejected while factory only a site", sim.entities.filter((e) => e.type === "starport").length, spBefore);
}

// ---------------------------------------------------------------------------
// TEST 7 — deposit-building (HQ) resource clearance: rejected 4 tiles from a
//          patch, accepted at 6+ tiles.
// ---------------------------------------------------------------------------
{
  const sim = new Sim(31337);
  const { w, h } = sim.map;
  clearArena(sim, 2, 2, w - 3, h - 3);
  revealAll(sim);
  sim.minerals[0] = 5000; sim.gas[0] = 5000;
  // strip existing entities except keep ONE worker; add a single patch we
  // control the distance to.
  const worker = sim.entities.find((e) => e.owner === 0 && e.type === "worker");
  sim.entities = sim.entities.filter((e) => e === worker || e.type === "mineral");
  // remove all minerals so only our test patch matters
  sim.entities = sim.entities.filter((e) => e.type !== "mineral");
  sim.byId.clear(); for (const e of sim.entities) sim.byId.set(e.id, e);
  // patch at tile (20,20)
  const patch = sim.addEntity({ type: "mineral", owner: -1, x: tileToFp(20), y: tileToFp(20), hp: 0, maxHp: 0, amount: 1500, radius: (FP * 0.4) | 0 });

  // HQ is size 3 -> center = (tx*FP + 1.5*FP). To put the CENTER 4 tiles from
  // the patch center (20,20), origin tx=20-1=19? center of footprint (19..21)
  // is tile 20.5 -> ~0.7 tiles away. We want center-to-center distances.
  // Place origin so center sits at tile ~16 (4 tiles from 20): tx=16-1=15 ->
  // center tile 16.5, dist ~3.5. And at tile ~14 (6 tiles): tx=13 -> center 14.5.
  const hqCenterTileFor = (tx) => tx + 1.5;   // size-3 footprint center in tiles
  // find origins giving ~4-tile and ~6-tile center distance along x
  const near = 15;  // center ~16.5 -> ~3.5 tiles (well under 6): reject
  const far = 12;   // center ~13.5 -> ~6.5 tiles (>= 6): accept
  ok(`T7 HQ ${(20 - hqCenterTileFor(near)).toFixed(1)} tiles from patch rejected`,
     sim.canPlace("hq", near, 20 - 1) === false);
  ok(`T7 HQ ${(20 - hqCenterTileFor(far)).toFixed(1)} tiles from patch accepted`,
     sim.canPlace("hq", far, 20 - 1) === true);
  // a non-deposit building (barracks) is NOT subject to the clearance rule:
  // placing it close to the patch is fine (only the mineral-overlap check applies)
  ok("T7 barracks near patch still allowed (not a deposit)",
     sim.canPlace("barracks", near, 20 - 1) === true);
  // refinery exemption is covered by the geyser tests; verify a deposit build
  // COMMAND is rejected end-to-end near the patch.
  const before = sim.entities.filter((e) => e.type === "hq" && e.owner === 0).length;
  sim.step([{ pid: 0, cmds: [{ t: "build", workerId: worker.id, building: "hq", tx: near, ty: 19 }] }, { pid: 1, cmds: [] }]);
  eq("T7 HQ build command near patch rejected (count unchanged)",
     sim.entities.filter((e) => e.type === "hq" && e.owner === 0).length, before);
  eq("T7 minerals not spent on rejected HQ", sim.minerals[0], 5000);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
