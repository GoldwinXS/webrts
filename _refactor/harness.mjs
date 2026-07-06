// Deterministic regression harness for the sim refactor.
// Drives BOTH players with the skirmish AI through the normal command pipeline
// and prints a checksum trace. A structural refactor of sim.js MUST reproduce
// this trace byte-for-byte. Run: node _refactor/harness.mjs
import { Sim } from '../js/core/sim.js';
import { AI } from '../js/core/ai.js';

const SEED = 123456789;
const TICKS = 4000;
const sim = new Sim(SEED, {});
const ai0 = new AI(0); ai0.pid = 0;
const ai1 = new AI(1);
const trace = [];
for (let t = 0; t < TICKS; t++) {
  const c0 = ai0.update(sim) || [];
  const c1 = ai1.update(sim) || [];
  sim.step([{ pid: 0, cmds: c0 }, { pid: 1, cmds: c1 }]);
  if (t % 100 === 0 || t === TICKS - 1) trace.push(sim.tick + ':' + sim.checksum());
}
let ec = 0; for (const e of sim.entities) ec++;
console.log(JSON.stringify({ ticks: TICKS, entities: ec, winner: sim.winner, trace }));
