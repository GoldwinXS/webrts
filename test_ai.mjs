// Headless skirmish-AI regression: expansions, army, aggression, difficulty
// tiers, and lockstep determinism. The AI (js/core/ai.js) issues commands as
// player 1 through the same pipeline a human uses; player 0 stays idle.
// Run: node test_ai.mjs
import { Sim } from "./js/core/sim.js";
import { AI } from "./js/core/ai.js";
import { FACTIONS } from "./js/core/data.js";
import { fpToTile } from "./js/core/fixed.js";

let fail = 0;
const check = (name, ok) => {
  console.log(`  ${ok ? "ok" : "FAIL"}: ${name}`);
  if (!ok) fail++;
};

// Drive a Sim + AI headlessly for `ticks` ticks vs an idle player 0.
function run(faction, difficulty, ticks, seed = 777) {
  const sim = new Sim(seed, { factions: ["cogs", faction] });
  const ai = new AI(1, difficulty);
  for (let t = 0; t < ticks; t++) {
    const cmds = ai.update(sim);
    sim.step(cmds.length ? [{ pid: 1, cmds }] : []);
    if (sim.winner >= 0) break;
  }
  const depositType = FACTIONS[faction].start; // hq / nucleus / core
  const deposits = sim.entities.filter(
    (e) => e.owner === 1 && e.building && e.done && e.type === depositType).length;
  const army = sim.entities.filter(
    (e) => e.owner === 1 && e.unit &&
      e.type !== "worker" && e.type !== "mote" && e.type !== "ion").length;
  return { sim, deposits, army, winner: sim.winner };
}

// -- HARD: each faction expands (>=2 deposits), fields an army, and wins vs an
//    idle opponent. -----------------------------------------------------------
for (const faction of ["cogs", "ooze", "storm"]) {
  const r = run(faction, "hard", 6000);
  check(`hard ${faction}: expanded (>=2 deposits, got ${r.deposits})`, r.deposits >= 2);
  check(`hard ${faction}: fielded an army (${r.army} units)`, r.army > 0);
  check(`hard ${faction}: won vs idle player 0 (winner=${r.winner})`, r.winner === 1);
}

// -- EASY: no expansion by tick 6000 (single deposit) but still builds an army.
for (const faction of ["cogs", "ooze", "storm"]) {
  const r = run(faction, "easy", 6000);
  check(`easy ${faction}: did NOT expand (1 deposit, got ${r.deposits})`, r.deposits === 1);
  check(`easy ${faction}: still built an army (${r.army} units)`, r.army > 0);
}

// -- DETERMINISM: two mirrored Sim+AI runs stay checksum-identical throughout.
for (const faction of ["cogs", "ooze", "storm"]) {
  const simA = new Sim(4321, { factions: ["cogs", faction] });
  const simB = new Sim(4321, { factions: ["cogs", faction] });
  const aiA = new AI(1, "hard");
  const aiB = new AI(1, "hard");
  let desync = false;
  for (let t = 0; t < 3000; t++) {
    const ca = aiA.update(simA);
    const cb = aiB.update(simB);
    simA.step(ca.length ? [{ pid: 1, cmds: ca }] : []);
    simB.step(cb.length ? [{ pid: 1, cmds: cb }] : []);
    if (t % 100 === 0 && simA.checksum() !== simB.checksum()) { desync = true; break; }
  }
  check(`determinism ${faction}: mirrored AI runs stay checksum-identical`,
    !desync && simA.checksum() === simB.checksum());
}

// -- SELF-BLOCKING BASE (spacing): the AI's building-site pickers (tryBuild /
// tryBuildOoze / findExpansionSite in js/core/ai.js) must leave a margin
// around what they build instead of packing structures edge-to-edge into
// walls that trap the AI's own units. Run a Normal cogs AI for ~4000 ticks,
// then measure how blocked the 1-tile ring around each finished non-deposit
// building is, and confirm no ground unit is sealed into a pocket.
//
// Baseline measured BEFORE the margin fix (old first-fit ring scan, no
// margin requirement), averaged over 3 seeds (777/1001/2002): 45.6%-54.2%
// ring blockage (mean ~51%), with 1-3 trapped units per run. AFTER the fix
// (js/core/ai.js hasClearMargin + two-pass strict-then-fallback scan): the
// same 3 seeds measure 1.0%-6.9% (mean ~4.9%). 45% cleanly separates the two
// regimes, so it's used as the regression threshold below.
function measureBuildingMargin(sim, pid) {
  const { w, h } = sim.map;
  const blocked = sim.blocked;
  const buildings = sim.entities.filter((e) =>
    e.owner === pid && e.building && e.done &&
    e.type !== "hq" && e.type !== "nucleus" && e.type !== "core" &&
    e.tx !== undefined && e.ty !== undefined);
  let totalRatio = 0;
  for (const b of buildings) {
    const tx = b.tx, ty = b.ty, sz = b.size || 1;
    let ring = 0, blockedCount = 0;
    for (let y = ty - 1; y <= ty + sz; y++) {
      for (let x = tx - 1; x <= tx + sz; x++) {
        const onRing = (x === tx - 1 || x === tx + sz || y === ty - 1 || y === ty + sz);
        if (!onRing) continue;
        ring++;
        if (x < 0 || y < 0 || x >= w || y >= h || blocked[y * w + x]) blockedCount++;
      }
    }
    totalRatio += ring ? blockedCount / ring : 0;
  }
  return { avg: buildings.length ? totalRatio / buildings.length : 0, n: buildings.length };
}

// Cheap trapped-unit detector: BFS the passable tile graph from the map
// center; a live ground unit that can't reach at least 50 tiles from where
// it stands is sealed into a pocket by its own base. Skips units mid-leap
// (leapUntil) or mid-transform (transformUntil, e.g. siege/burrow) since
// those aren't standing on a normal walkable tile at that instant.
function findTrappedUnits(sim, pid) {
  const { w, h } = sim.map;
  const blocked = sim.blocked;
  const cx = w >> 1, cy = h >> 1;
  const reach = new Uint8Array(w * h);
  const stack = [];
  if (!blocked[cy * w + cx]) { const s = cy * w + cx; reach[s] = 1; stack.push(s); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    if (x > 0 && !reach[i - 1] && !blocked[i - 1]) { reach[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && !reach[i + 1] && !blocked[i + 1]) { reach[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && !reach[i - w] && !blocked[i - w]) { reach[i - w] = 1; stack.push(i - w); }
    if (y < h - 1 && !reach[i + w] && !blocked[i + w]) { reach[i + w] = 1; stack.push(i + w); }
  }
  let trapped = 0, total = 0;
  for (const e of sim.entities) {
    if (e.owner !== pid || !e.unit || e.fly) continue;
    if (e.leapUntil && sim.tick < e.leapUntil) continue;
    if (e.transformUntil && sim.tick < e.transformUntil) continue;
    total++;
    const idx = fpToTile(e.y) * w + fpToTile(e.x);
    if (!reach[idx]) trapped++;
  }
  return { trapped, total };
}

{
  const spacingSim = new Sim(777, { factions: ["cogs", "cogs"] });
  const spacingAi = new AI(1, "normal");
  for (let t = 0; t < 4000; t++) {
    const cmds = spacingAi.update(spacingSim);
    spacingSim.step(cmds.length ? [{ pid: 1, cmds }] : []);
    if (spacingSim.winner >= 0) break;
  }
  const margin = measureBuildingMargin(spacingSim, 1);
  const trap = findTrappedUnits(spacingSim, 1);
  check(`spacing: avg building-margin blockage stays under 45% (got ${(margin.avg * 100).toFixed(1)}% over ${margin.n} buildings)`,
    margin.n === 0 || margin.avg < 0.45);
  check(`spacing: no own unit fully enclosed (${trap.trapped}/${trap.total} trapped)`,
    trap.trapped === 0);
}

// -- LOGISTICS (a): during a Normal cogs run, no OWN worker stays idle for more
//    than 600 consecutive ticks WHILE a patch near an own deposit still has
//    minerals. Idle workers standing next to live minerals is exactly the
//    reported "AI mines out its main and coasts" bug — the idle re-gather
//    widening (bestReGatherPatch) must keep them working.
{
  const sim = new Sim(777, { factions: ["cogs", "cogs"] });
  const ai = new AI(1, "normal");
  const idleSince = new Map();   // workerId -> tick it went idle (while work exists)
  let worstIdleStreak = 0, offender = "";
  const NEAR2 = (256 * 12) * (256 * 12);
  for (let t = 0; t < 6000; t++) {
    const cmds = ai.update(sim);
    sim.step(cmds.length ? [{ pid: 1, cmds }] : []);
    if (sim.winner >= 0) break;
    // is there a live patch near ANY own deposit? (work is available)
    const deps = sim.entities.filter((e) => e.owner === 1 && e.building && e.done && e.type === "hq");
    const workAvailable = sim.entities.some((e) => e.type === "mineral" && e.amount > 0 &&
      deps.some((hq) => { const dx = hq.x - e.x, dy = hq.y - e.y; return dx * dx + dy * dy <= NEAR2; }));
    for (const w of sim.entities) {
      if (w.owner !== 1 || !w.unit || w.type !== "worker") continue;
      if (w.order.kind === "idle" && workAvailable) {
        if (!idleSince.has(w.id)) idleSince.set(w.id, sim.tick);
        const streak = sim.tick - idleSince.get(w.id);
        if (streak > worstIdleStreak) { worstIdleStreak = streak; offender = `worker ${w.id}`; }
      } else {
        idleSince.delete(w.id);
      }
    }
  }
  check(`logistics: no worker idle >600 ticks while a near-deposit patch has minerals (worst streak ${worstIdleStreak}, ${offender})`,
    worstIdleStreak <= 600);
}

// -- LOGISTICS (b): force-deplete the main's patches identically on BOTH mirror
//    sims mid-run; the AI's workers must RE-TARGET (leave idle, find fresh
//    minerals) within ~300 ticks, and the two mirrored sims stay in lockstep.
{
  const simA = new Sim(777, { factions: ["cogs", "cogs"] });
  const simB = new Sim(777, { factions: ["cogs", "cogs"] });
  const aiA = new AI(1, "normal");
  const aiB = new AI(1, "normal");
  const stepBoth = () => {
    const ca = aiA.update(simA), cb = aiB.update(simB);
    simA.step(ca.length ? [{ pid: 1, cmds: ca }] : []);
    simB.step(cb.length ? [{ pid: 1, cmds: cb }] : []);
  };
  // warm up so the AI has workers mining its main line
  for (let t = 0; t < 1500; t++) stepBoth();
  // deplete every patch within 12 tiles of an own (player-1) deposit — same
  // deterministic operation on both sims so they stay identical.
  const NEAR2 = (256 * 12) * (256 * 12);
  const depleteMain = (s) => {
    const deps = s.entities.filter((e) => e.owner === 1 && e.building && e.done && e.type === "hq");
    for (const e of s.entities) {
      if (e.type !== "mineral") continue;
      if (deps.some((hq) => { const dx = hq.x - e.x, dy = hq.y - e.y; return dx * dx + dy * dy <= NEAR2; })) e.amount = 0;
    }
  };
  depleteMain(simA); depleteMain(simB);
  const mainWorkers = simA.entities.filter((e) => e.owner === 1 && e.unit && e.type === "worker").map((e) => e.id);
  check("deplete-retarget: main workers exist to re-target", mainWorkers.length > 0);
  // count how many of those workers are gathering a LIVE patch after ~300 ticks
  let retargeted = false, desync = false;
  for (let t = 0; t < 300; t++) {
    stepBoth();
    if (t % 50 === 0 && simA.checksum() !== simB.checksum()) { desync = true; break; }
    const okWorkers = mainWorkers.filter((id) => {
      const w = simA.byId.get(id);
      if (!w) return false;
      if (w.order.kind !== "gather") return false;
      const node = simA.byId.get(w.order.targetId);
      return node && node.type === "mineral" && node.amount > 0;
    }).length;
    if (okWorkers >= Math.ceil(mainWorkers.length / 2)) { retargeted = true; break; }
  }
  check("deplete-retarget: majority of main workers re-target live minerals within ~300 ticks", retargeted);
  check("deplete-retarget: mirrored sims stay checksum-identical", !desync && simA.checksum() === simB.checksum());
}

// -- VARIANCE (c): mineral amounts vary across patches (not all PATCH_AMOUNT),
//    AND symmetric partners carry IDENTICAL amounts (fairness). We don't know
//    which patch is whose partner, so verify fairness by MULTISET equality: the
//    sorted list of amounts is symmetric — every value appears an even number of
//    times when a symmetric partner exists (each partner pair contributes two
//    equal amounts). Simpler + robust: the two players' near-deposit totals must
//    match exactly (mirror bases have identical resources).
{
  const sim = new Sim(1234, { factions: ["cogs", "cogs"] });
  const amounts = sim.entities.filter((e) => e.type === "mineral" && !e.rich).map((e) => e.amount);
  const distinct = new Set(amounts);
  check(`variance: patch amounts differ across patches (${distinct.size} distinct of ${amounts.length})`,
    distinct.size > 1);
  check("variance: amounts stay centered near PATCH_AMOUNT (mean within ±10%)", (() => {
    if (!amounts.length) return false;
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    return Math.abs(mean - 1500) < 150;
  })());
  // FAIRNESS: each player's total near-deposit minerals must match its mirror.
  const nearTotal = (pid) => {
    const dep = sim.entities.find((e) => e.owner === pid && e.building && e.type === "hq");
    let sum = 0;
    for (const e of sim.entities) {
      if (e.type !== "mineral") continue;
      const dx = dep.x - e.x, dy = dep.y - e.y;
      if (dx * dx + dy * dy <= (256 * 10) * (256 * 10)) sum += e.amount;
    }
    return sum;
  };
  check("variance: mirror bases carry IDENTICAL total minerals (symmetry-fair)",
    nearTotal(0) === nearTotal(1) && nearTotal(0) > 0);
  // Direct partner-amount check across several seeds: for each patch, its
  // rotate/reflect partner amount (looked up by matching fp coords) is equal.
  let partnerMismatch = 0, pairsChecked = 0;
  for (const seed of [1234, 777, 99, 4242, 2002]) {
    const s = new Sim(seed, { factions: ["cogs", "cogs"] });
    const W = s.map.w * 256, H = s.map.h * 256;
    const byPos = new Map();
    const mins = s.entities.filter((e) => e.type === "mineral");
    for (const e of mins) byPos.set((e.x << 16) | e.y, e.amount);
    for (const e of mins) {
      // try the three candidate partners; whichever exists must match amount
      for (const [px, py] of [[W - e.x, H - e.y], [W - e.x, e.y], [e.x, H - e.y]]) {
        const key = ((px & 0xffff) << 16) | (py & 0xffff);
        if (byPos.has(key)) { pairsChecked++; if (byPos.get(key) !== e.amount) partnerMismatch++; }
      }
    }
  }
  check(`variance: symmetric partners match exactly (${pairsChecked} pairs, ${partnerMismatch} mismatches)`,
    pairsChecked > 0 && partnerMismatch === 0);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL AI CHECKS PASSED.");
process.exit(fail ? 1 : 0);
