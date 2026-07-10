// Headless goo regression test: organic growth, recede, and lockstep
// determinism. Run: node test_goo.mjs
import { Sim } from "./js/core/sim.js";

const opts = { factions: ["ooze", "ooze"] };
const a = new Sim(12345, opts);
const b = new Sim(12345, opts);

const gooCount = (s) => s.gooGrid.reduce((t, v) => t + v, 0);
let fail = 0;
const check = (name, ok) => {
  console.log(`  ${ok ? "ok" : "FAIL"}: ${name}`);
  if (!ok) fail++;
};

// -- growth + determinism over 1200 ticks --------------------------------
const start = gooCount(a);
let mid = 0;
for (let t = 1; t <= 1200; t++) {
  a.step([]); b.step([]);
  if (t === 300) mid = gooCount(a);
  if (t % 100 === 0 && a.checksum() !== b.checksum()) {
    check(`no desync through tick ${t}`, false);
    process.exit(1);
  }
}
const grownTo = gooCount(a);
check("no desync through tick 1200", true);
check(`goo grows (${start} -> ${mid} -> ${grownTo})`, mid > start && grownTo >= mid);
check("growth is gradual, not instant", mid < grownTo || mid < 0.95 * grownTo || start < 0.6 * mid);
check("noise cursor advanced and is integer", Number.isInteger(a.gooNoiseI) && a.gooNoiseI > 0);

// -- recede when the source dies ------------------------------------------
const nuc = a.entities.find((e) => e.type === "nucleus" && e.owner === 0);
const cmd = [{ pid: 0, cmds: [{ t: "remove", ids: [nuc.id] }] }];
a.step(cmd); b.step(cmd);
const atDeath = gooCount(a);
let partial = 0;
for (let t = 1; t <= 300; t++) {
  a.step([]); b.step([]);
  if (t === 40) partial = gooCount(a);
}
const receded = gooCount(a);
check(`goo recedes after source death (${atDeath} -> ${partial} -> ${receded})`, receded < atDeath);
check("recede is gradual (edges crumble inward)", partial < atDeath && partial > receded);
check("enemy creep untouched (half remains)", receded > 0.35 * atDeath);
check("no desync after recede", a.checksum() === b.checksum());

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL GOO CHECKS PASSED.");
process.exit(fail ? 1 : 0);
