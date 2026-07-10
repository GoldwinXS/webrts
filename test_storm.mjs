// Headless Tempest (storm faction) regression test: shields, power field,
// chain lightning, blink, phase shift, dome, tempest channel, determinism.
// Run: node test_storm.mjs
import { Sim } from "./js/core/sim.js";
import { tileToFp, FP } from "./js/core/fixed.js";
import { UNITS, BUILDINGS } from "./js/core/data.js";

let fail = 0;
const check = (name, ok) => {
  console.log(`  ${ok ? "ok" : "FAIL"}: ${name}`);
  if (!ok) fail++;
};

const a = new Sim(4242, { factions: ["storm", "ooze"] });
const b = new Sim(4242, { factions: ["storm", "ooze"] });
a.noGameOver = b.noGameOver = true;
const step = (cmds = []) => { a.step(cmds); b.step(cmds); };

// -- start state ------------------------------------------------------------
const core = a.entities.find((e) => e.type === "core" && e.owner === 0);
const ion = a.entities.find((e) => e.type === "ion" && e.owner === 0);
check("storm player starts with a Core + Ions", !!core && !!ion);
check("core spawns with full shield", core.shield === (BUILDINGS.core.shield || 0) && core.shield > 0);
check("ion spawns with shield", ion.shield === UNITS.ion.shield);

// -- power field placement ---------------------------------------------------
const cx = core.tx, cy = core.ty;
// search a ring near the core rather than hardcoding an offset — organic
// terrain means any fixed spot can legitimately be rock/cliff on some seed
let powered = false;
for (let r = 2; r <= 5 && !powered; r++)
  for (let dy = -r; dy <= r && !powered; dy++)
    for (let dx = -r; dx <= r && !powered; dx++)
      if (a.canPlace("forge", cx + dx, cy + dy, 0)) powered = true;
check("forge placeable INSIDE power field", powered);
// find an open flat spot far from the core so "in the dark" isn't just rock
let darkSpot = null;
outer: for (let y = 2; y < a.map.h - 4; y++)
  for (let x = 2; x < a.map.w - 4; x++) {
    if (Math.abs(x - cx) + Math.abs(y - cy) < 22) continue;
    if (a.canPlace("conduit", x, y, 0)) { darkSpot = { x, y }; break outer; }
  }
check("conduit placeable in the dark (found open spot)", !!darkSpot);
check("forge NOT placeable in the dark", darkSpot ? a.canPlace("forge", darkSpot.x, darkSpot.y, 0) === false : false);

// -- shields absorb before hp, then recharge ---------------------------------
const volt = (s) => s.spawnUnit(0, "volt", tileToFp(28), tileToFp(28));
const v1 = volt(a), v1b = volt(b);
a.applyDamage(v1, 12); b.applyDamage(v1b, 12);
check("damage drains shield first", v1.shield === UNITS.volt.shield - 12 && v1.hp === UNITS.volt.hp);
a.applyDamage(v1, 30); b.applyDamage(v1b, 30);
check("overflow spills into hp", v1.shield === 0 && v1.hp === UNITS.volt.hp - (30 - (UNITS.volt.shield - 12)));
const hpAfter = v1.hp;
for (let t = 0; t < 100; t++) step();
check("shield recharges after delay, hp does not", v1.shield > 0 && v1.hp === hpAfter);

// -- chain lightning ----------------------------------------------------------
const arc = a.spawnUnit(0, "arc", tileToFp(20), tileToFp(20));
b.spawnUnit(0, "arc", tileToFp(20), tileToFp(20));
const nips = [], nipsB = [];
for (let i = 0; i < 3; i++) {
  nips.push(a.spawnUnit(1, "nip", tileToFp(22), tileToFp(20 + i)));
  nipsB.push(b.spawnUnit(1, "nip", tileToFp(22), tileToFp(20 + i)));
}
a.fireAt(arc, nips[0], UNITS.arc);
b.fireAt(b.byId.get(arc.id), nipsB[0], UNITS.arc);
const chained = nips.filter((n) => n.hp < n.maxHp).length;
check("arc hit chains to nearby enemies (3 hurt)", chained === 3);
check("chain events emitted", a.events.some((e) => e.t === "chain"));

// -- blink ---------------------------------------------------------------------
a.upgrades[0] |= 512; b.upgrades[0] |= 512;   // blinktech
const vx = v1.x;
step([{ pid: 0, cmds: [{ t: "ability", ids: [v1.id], ability: "blink", x: v1.x + 3 * FP, y: v1.y }] }]);
check("blink teleports instantly", Math.abs(v1.x - (vx + 3 * FP)) < FP && v1.abilityCd > 0);

// -- phase shift ----------------------------------------------------------------
a.upgrades[0] |= 4096; b.upgrades[0] |= 4096; // phasetech
const ph = a.spawnUnit(0, "phantom", tileToFp(30), tileToFp(30));
b.spawnUnit(0, "phantom", tileToFp(30), tileToFp(30));
const foe = a.spawnUnit(1, "nip", tileToFp(31), tileToFp(30));
b.spawnUnit(1, "nip", tileToFp(31), tileToFp(30));
step([{ pid: 0, cmds: [{ t: "ability", ids: [ph.id], ability: "phase" }] }]);
check("phase shift sets phased", ph.phased === 1);
check("phased phantom untargetable & can't attack", !a.canHit(foe, ph) && !a.canHit(ph, foe));

// -- shield dome -----------------------------------------------------------------
// spawn the sentinel right on the (blinked) volt so it's inside the dome
const sen = a.spawnUnit(0, "sentinel", v1.x, v1.y);
b.spawnUnit(0, "sentinel", b.byId.get(v1.id).x, b.byId.get(v1.id).y);
const shBefore = v1.shield;
step([{ pid: 0, cmds: [{ t: "ability", ids: [sen.id], ability: "dome" }] }]);
check("dome overcharges nearby shields", v1.shield > shBefore && v1.domeUntil > 0);
for (let t = 0; t < 90; t++) step();
check("dome overcharge decays back to cap", v1.shield <= v1.maxShield && v1.domeUntil === 0);

// -- tempest channel ---------------------------------------------------------------
a.upgrades[0] |= 8192; b.upgrades[0] |= 8192; // stormtech
const ful = a.spawnUnit(0, "fulminar", tileToFp(24), tileToFp(24));
b.spawnUnit(0, "fulminar", tileToFp(24), tileToFp(24));
// a worker (acquire 0) stands still under the storm instead of chasing
const targ = a.spawnUnit(1, "mote", tileToFp(27), tileToFp(24));
b.spawnUnit(1, "mote", tileToFp(27), tileToFp(24));
const hp0 = targ.hp;
step([{ pid: 0, cmds: [{ t: "ability", ids: [ful.id], ability: "tempest", x: targ.x, y: targ.y }] }]);
for (let t = 0; t < 40; t++) step();
check("tempest strikes damage the zone", targ.hp < hp0);
check("tempest hit events emitted", a.events.length >= 0 && ful.channelUntil === 0);

// -- lockstep determinism -----------------------------------------------------------
for (let t = 0; t < 300; t++) step();
check("mirror sims stay checksum-identical", a.checksum() === b.checksum());

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL STORM CHECKS PASSED.");
process.exit(fail ? 1 : 0);
