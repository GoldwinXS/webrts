// Headless campaign-runner regression. The mission definitions (js/campaign/
// missions.js) are pure data + scripting closures; the Sim (js/core/sim.js) is
// importable and deterministic. This test boots each mission's setup through a
// minimal ctx stub (mirroring CampaignRunner.runSetup), then drives the Sim
// to satisfy the objectives and asserts winWhen fires — plus that loseWhen and
// the unlock/progress logic behave.
// Run: node test_campaign.mjs
import { Sim } from "./js/core/sim.js";
import { tileToFp } from "./js/core/fixed.js";
import { FACTIONS } from "./js/core/data.js";
import { MISSIONS, MISSION_BY_ID, ACTS, FIRST_MISSION } from "./js/campaign/missions.js";

let fail = 0;
const check = (name, ok) => {
  console.log(`  ${ok ? "ok" : "FAIL"}: ${name}`);
  if (!ok) fail++;
};

// ---- minimal ctx stub, matching CampaignRunner.runSetup + spawnWave ---------
// Only the entity-scripting surface the missions actually use in headless mode.
function makeCtx(sim) {
  const state = {};
  const ctx = {
    sim, state, player: 0, enemy: 1, tileToFp,
    say() {}, line() {}, toast() {}, objectiveDone() {},
    reveal: () => sim.fog[0].fill(2),
    clearPlayer(pid) {
      for (const e of sim.entities) {
        if (e.owner === pid) { if (e.building) sim.setFootprint(e, 0); e.hp = 0; sim.byId.delete(e.id); }
      }
      sim.entities = sim.entities.filter((e) => sim.byId.has(e.id));
    },
    spawnFor: (pid, type, tx, ty) => sim.spawnUnit(pid, type, tileToFp(tx | 0), tileToFp(ty | 0)),
    spawnWave(type, n, waveIndex) {
      const from = state._oozeFrom || { x: sim.map.w - 6, y: sim.map.h - 6 };
      for (let i = 0; i < n; i++) {
        const ox = (i % 3) - 1, oy = ((i / 3) | 0) - 1;
        const tx = Math.max(1, Math.min(sim.map.w - 2, from.x + ox));
        const ty = Math.max(1, Math.min(sim.map.h - 2, from.y + oy));
        sim.spawnUnit(1, type, tileToFp(tx), tileToFp(ty));
      }
      if (typeof waveIndex === "number") state._wavesDone = waveIndex;
    },
    woundEnemyBase(pid) {
      // simplified stand-in for the runner's version (enough for objective math)
      const fac = FACTIONS[sim.factions[pid]] || FACTIONS.ooze;
      const s = sim.map.starts[pid];
      ctx.clearPlayer(pid);
      sim.spawnBuilding(pid, fac.start, s.x - 1, s.y - 1, true);
      sim.spawnBuilding(pid, "den", s.x + 3, s.y - 1, true);
    },
  };
  return ctx;
}

// Boot a mission Sim exactly as the runner would: construct with the mission's
// seed + faction/opts, disable noGameOver, run setup.
function boot(mission) {
  const opts = Object.assign({}, mission.mapOpts || {});
  opts.factions = mission.factions || ["cogs", "cogs"];
  if (mission.aiDifficulty) opts.aidifficulty = mission.aiDifficulty;
  const sim = new Sim(mission.mapSeed | 0, opts);
  sim.noGameOver = true;
  const ctx = makeCtx(sim);
  if (mission.setup) mission.setup(ctx);
  return { sim, ctx };
}

// ---- MISSION 1: economy tutorial, win when all four objectives clear --------
{
  const m = MISSION_BY_ID.a1m1;
  const { sim, ctx } = boot(m);
  check("m1: setup stripped player 1 (no enemy entities)",
    sim.entities.every((e) => e.owner !== 1));
  check("m1: win NOT satisfied at start", !m.winWhen(sim, ctx.state));

  // satisfy each objective by hand (this is what a player's actions would do):
  const s0 = sim.map.starts[0];
  // train up to 9 workers (starts with 5)
  while (sim.entities.filter((e) => e.owner === 0 && e.unit && e.type === "worker").length < 9)
    sim.spawnUnit(0, "worker", tileToFp(s0.x + 2), tileToFp(s0.y + 2));
  // a Battery (depot) and Assembly (barracks), both finished
  sim.spawnBuilding(0, "depot", s0.x + 4, s0.y + 4, true);
  sim.spawnBuilding(0, "barracks", s0.x + 4, s0.y - 4, true);
  sim.minerals[0] = 400;

  // step the sim a few ticks so the state settles (removeDead, etc.)
  for (let i = 0; i < 5; i++) sim.step(null);

  // objective checks individually
  const byId = Object.fromEntries(m.objectives.map((o) => [o.id, o]));
  check("m1: obj train (9 workers) satisfied", byId.train.check(sim, ctx.state));
  check("m1: obj battery satisfied", byId.battery.check(sim, ctx.state));
  check("m1: obj assembly satisfied", byId.assembly.check(sim, ctx.state));
  check("m1: obj scrap (400) satisfied", byId.scrap.check(sim, ctx.state));
  check("m1: winWhen FIRES once all objectives met", m.winWhen(sim, ctx.state));
  check("m1: loseWhen never fires", !m.loseWhen(sim, ctx.state));
}

// ---- MISSION 2: survive 4 ooze waves, win when waves done + no ooze left -----
{
  const m = MISSION_BY_ID.a1m2;
  const { sim, ctx } = boot(m);
  check("m2: setup left a Cog Hub standing for the player", (() => {
    return sim.entities.some((e) => e.owner === 0 && e.building && e.type === "hq" && e.hp > 0);
  })());
  check("m2: win NOT satisfied at start", !m.winWhen(sim, ctx.state));

  // simulate all four waves spawning then being cleared out
  ctx.spawnWave("nip", 4, 1);
  ctx.spawnWave("nip", 5, 2);
  ctx.spawnWave("nip", 6, 3);
  ctx.spawnWave("nip", 7, 4);
  check("m2: wave counter reached 4", (ctx.state._wavesDone || 0) >= 4);
  check("m2: win NOT satisfied while ooze units are alive", !m.winWhen(sim, ctx.state));
  // wipe all player-1 (ooze) units to simulate them being destroyed
  for (const e of sim.entities) if (e.owner === 1 && e.unit) { e.hp = 0; sim.byId.delete(e.id); }
  sim.entities = sim.entities.filter((e) => sim.byId.has(e.id));
  check("m2: winWhen FIRES after 4 waves cleared", m.winWhen(sim, ctx.state));

  // lose condition: destroy every player-0 building
  const { sim: sim2, ctx: ctx2 } = boot(m);
  check("m2: loseWhen NOT set with base intact", !m.loseWhen(sim2, ctx2.state));
  for (const e of sim2.entities) if (e.owner === 0 && e.building) { e.hp = 0; sim2.byId.delete(e.id); }
  sim2.entities = sim2.entities.filter((e) => sim2.byId.has(e.id));
  check("m2: loseWhen FIRES when all player buildings destroyed", m.loseWhen(sim2, ctx2.state));
}

// ---- MISSION 3: raze the nest, win when enemy has zero structures ------------
{
  const m = MISSION_BY_ID.a1m3;
  const { sim, ctx } = boot(m);
  check("m3: setup pre-placed an enemy nest (player 1 has buildings)",
    sim.entities.some((e) => e.owner === 1 && e.building));
  check("m3: win NOT satisfied while the nest stands", !m.winWhen(sim, ctx.state));
  // raze every enemy structure
  for (const e of sim.entities) if (e.owner === 1 && e.building) { sim.setFootprint(e, 0); e.hp = 0; sim.byId.delete(e.id); }
  sim.entities = sim.entities.filter((e) => sim.byId.has(e.id));
  check("m3: winWhen FIRES once all enemy structures razed", m.winWhen(sim, ctx.state));
}

// ---- registry / progression sanity ------------------------------------------
{
  check("registry: FIRST_MISSION is the first mission id", FIRST_MISSION === MISSIONS[0].id);
  check("registry: every mission has a unique id",
    new Set(MISSIONS.map((x) => x.id)).size === MISSIONS.length);
  const stubs = MISSIONS.filter((x) => x.stub);
  check("registry: Act 2 and Act 3 are present as stubs", stubs.length >= 2);
  check("registry: three acts declared", ACTS.length === 3);
  // playable missions all declare the required shape
  for (const m of MISSIONS.filter((x) => !x.stub)) {
    const ok = m.title && m.blurb && typeof m.mapSeed === "number" &&
      Array.isArray(m.factions) && Array.isArray(m.objectives) &&
      typeof m.winWhen === "function" && typeof m.loseWhen === "function";
    check(`shape: ${m.id} has full mission definition`, !!ok);
  }
}

// ---- determinism: a booted mission Sim stays deterministic across two runs ---
{
  const m = MISSION_BY_ID.a1m3;
  const a = boot(m).sim, b = boot(m).sim;
  let desync = false;
  for (let t = 0; t < 300; t++) {
    a.step(null); b.step(null);
    if (t % 50 === 0 && a.checksum() !== b.checksum()) { desync = true; break; }
  }
  check("determinism: two identical mission boots stay checksum-identical", !desync);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL CAMPAIGN CHECKS PASSED.");
process.exit(fail ? 1 : 0);
