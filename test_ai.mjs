// Headless skirmish-AI regression: expansions, army, aggression, difficulty
// tiers, and lockstep determinism. The AI (js/core/ai.js) issues commands as
// player 1 through the same pipeline a human uses; player 0 stays idle.
// Run: node test_ai.mjs
import { Sim } from "./js/core/sim.js";
import { AI } from "./js/core/ai.js";
import { FACTIONS } from "./js/core/data.js";

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

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL AI CHECKS PASSED.");
process.exit(fail ? 1 : 0);
