// Headless unit-fun-pass regression: Nip Frenzy, Corrosive Spit slow,
// Wisp Essence Feast, Dart Target Lock. Run: node test_fun.mjs
import { Sim } from "./js/core/sim.js";
import { tileToFp } from "./js/core/fixed.js";
import { UNITS } from "./js/core/data.js";

let fail = 0;
const check = (name, ok) => {
  console.log(`  ${ok ? "ok" : "FAIL"}: ${name}`);
  if (!ok) fail++;
};

const a = new Sim(99, { factions: ["ooze", "cogs"] });
const b = new Sim(99, { factions: ["ooze", "cogs"] });
a.noGameOver = b.noGameOver = true;
const step = (cmds = []) => { a.step(cmds); b.step(cmds); };
const twin = (s, pid, type, x, y) => s.spawnUnit(pid, type, tileToFp(x), tileToFp(y));
const pair = (pid, type, x, y) => { const u = twin(a, pid, type, x, y); twin(b, pid, type, x, y); return u; };

// -- Nip Frenzy ---------------------------------------------------------------
const nip = pair(0, "nip", 28, 28);
const base = a.unitSpeed(nip), baseCd = a.unitCooldown(nip);
step([{ pid: 0, cmds: [{ t: "ability", ids: [nip.id], ability: "frenzy" }] }]);
check("frenzy boosts speed + attack rate, sets cd",
  a.unitSpeed(nip) > base && a.unitCooldown(nip) < baseCd && nip.abilityCd > 0);

// -- Corrosive Spit ------------------------------------------------------------
const spit = pair(0, "spit", 20, 20);
const victim = pair(1, "marine", 21, 20);
const vBase = a.unitSpeed(victim);
a.fireAt(spit, victim, UNITS.spit); b.fireAt(b.byId.get(spit.id), b.byId.get(victim.id), UNITS.spit);
check("spit hit slimes the victim (30% slower)",
  victim.slimedUntil > 0 && a.unitSpeed(victim) < vBase);

// -- Wisp Essence Feast ----------------------------------------------------------
const wisp = pair(0, "wisp", 24, 24);
const prey = pair(1, "worker", 24, 25);
prey.hp = 1; b.byId.get(prey.id).hp = 1;
const preFeastDmg = a.unitDmg(wisp, prey);
a.fireAt(wisp, prey, UNITS.wisp); b.fireAt(b.byId.get(wisp.id), b.byId.get(prey.id), UNITS.wisp);
check("kill feeds the wisp (+1 dmg)", wisp.feast === 1 && a.unitDmg(wisp, victim) === preFeastDmg + 1);

// -- Dart Target Lock -------------------------------------------------------------
const dart = pair(0, "wraith", 30, 30);
const tank = pair(1, "tank", 31, 30);
const d0 = a.unitDmg(dart, tank);
a.fireAt(dart, tank, UNITS.wraith); b.fireAt(b.byId.get(dart.id), b.byId.get(tank.id), UNITS.wraith);
const d1 = a.unitDmg(dart, tank);
a.fireAt(dart, tank, UNITS.wraith); b.fireAt(b.byId.get(dart.id), b.byId.get(tank.id), UNITS.wraith);
const d2 = a.unitDmg(dart, tank);
check("consecutive dart hits ramp +2 each", d1 === d0 && d2 === d0 + 2);
const other = pair(1, "brute", 32, 30);
a.fireAt(dart, other, UNITS.wraith); b.fireAt(b.byId.get(dart.id), b.byId.get(other.id), UNITS.wraith);
check("switching targets resets the lock", a.unitDmg(dart, other) === (other.fly ? UNITS.wraith.dmgAir : UNITS.wraith.dmg));

// -- determinism -------------------------------------------------------------------
for (let t = 0; t < 300; t++) step();
check("mirror sims stay checksum-identical", a.checksum() === b.checksum());

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL FUN CHECKS PASSED.");
process.exit(fail ? 1 : 0);
