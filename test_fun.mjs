// Headless unit-fun-pass regression: Nip Frenzy, Corrosive Spit slow,
// Wisp Essence Feast, Dart Target Lock, plus the transformative upgrade pass
// (Ablative Shells, Overdrive Governors, Broodburst, Overgrowth, Feedback
// Loop). Run: node test_fun.mjs
import { Sim } from "./js/core/sim.js";
import { tileToFp, fpToTile } from "./js/core/fixed.js";
import { UNITS, UPGRADE_BITS, ABLATE_ARM, OVERDRIVE_DUR, ABILITIES } from "./js/core/data.js";

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

// == UPGRADE PASS ============================================================
// Helper: grant an upgrade bit to a player on BOTH mirror sims.
const grant = (pid, key) => { a.upgrades[pid] |= UPGRADE_BITS[key]; b.upgrades[pid] |= UPGRADE_BITS[key]; };
// Helper: set the goo tile under an fp position on both sims (1=goo, 0=clear).
const gooAt = (fx, fy, v = 1) => {
  const i = fpToTile(fy) * a.map.w + fpToTile(fx);
  a.gooGrid[i] = v; b.gooGrid[i] = v;
};

// -- Ablative Shells (Cogs) ---------------------------------------------------
// Apply every hit to BOTH mirrors in lockstep so the ablate state stays synced.
grant(1, "ablative");
const zap = pair(1, "marine", 40, 40);
const zapB = b.byId.get(zap.id);
zap.lastDmg = 0; zapB.lastDmg = 0;                // armed: never hit
const zapHp0 = zap.hp;
a.applyDamage(zap, 20); b.applyDamage(zapB, 20);  // first hit — nullified on both
check("ablative nullifies the first hit after idle (0 dmg)", zap.hp === zapHp0);
check("ablate event emitted for the fx layer", a.events.some((e) => e.kind === "ablate"));
a.applyDamage(zap, 20); b.applyDamage(zapB, 20);  // second hit — plate disarmed, lands
check("ablative disarms after popping (2nd hit lands)", zap.hp === zapHp0 - 20);

// -- Overdrive Governors (Cogs) ----------------------------------------------
grant(1, "siegetech");   // siege is research-gated; needed to toggle Anchor Mode
grant(1, "overdrive");
const thumper = pair(1, "tank", 44, 44);
const tSpeedBase = a.unitSpeed(thumper);
// siege then unsiege; the burst arms when the transform-down finishes.
step([{ pid: 1, cmds: [{ t: "ability", ids: [thumper.id], ability: "siege" }] }]);
for (let t = 0; t < ABILITIES.siege.transform + 1; t++) step();  // finish siege-up
step([{ pid: 1, cmds: [{ t: "ability", ids: [thumper.id], ability: "siege" }] }]); // siege-down
// advance to just after the transform-down completes (burst window open)
for (let t = 0; t < ABILITIES.siege.transform; t++) step();
const tSpeedBurst = a.unitSpeed(thumper);
check("overdrive: Thumper faster in the window after unsieging", tSpeedBurst > tSpeedBase);
for (let t = 0; t < OVERDRIVE_DUR + 2; t++) step();
check("overdrive burst expires back to base speed", a.unitSpeed(thumper) === tSpeedBase);

// -- Broodburst (Ooze) --------------------------------------------------------
grant(0, "broodburst");
const bnip = pair(0, "nip", 12, 12);
const bvictim = pair(1, "marine", 12, 12);   // same tile → inside blast radius
// disarm this victim's Ablative plate (granted to p1 above) so the blast lands
bvictim.lastDmg = a.tick; b.byId.get(bvictim.id).lastDmg = b.tick;
const bvHp0 = bvictim.hp;
bnip.hp = 0; b.byId.get(bnip.id).hp = 0;      // kill the nip → detonation in removeDead
a.removeDead(); b.removeDead();
check("broodburst: dying Nip splashes an adjacent enemy", bvictim.hp < bvHp0);
check("broodburst event emitted", a.events.some((e) => e.kind === "broodburst"));

// -- Overgrowth (Ooze) --------------------------------------------------------
grant(0, "overgrowth");
const onGoo = pair(0, "nip", 48, 12);
const offGoo = pair(0, "nip", 48, 16);
gooAt(onGoo.x, onGoo.y, 1);                     // force goo under the on-goo nip
gooAt(offGoo.x, offGoo.y, 0);                   // force NO goo under the off-goo nip
check("overgrowth: attack cooldown lower on goo than off goo",
  a.fpOnGoo(onGoo.x, onGoo.y) && !a.fpOnGoo(offGoo.x, offGoo.y) &&
  a.unitCooldown(onGoo) < a.unitCooldown(offGoo));
check("overgrowth speeds goo spread interval", a.overgrowthActive() === true);

// -- Feedback Loop (Tempest) --------------------------------------------------
grant(1, "feedback");
const arcUnit = pair(1, "arc", 30, 44);        // shielded storm unit for player 1
const attacker = pair(0, "nip", 31, 44);       // enemy near it → feedback target
arcUnit.shield = 5; b.byId.get(arcUnit.id).shield = 5;
const atkHp0 = attacker.hp;
a.applyDamage(arcUnit, 8); b.applyDamage(b.byId.get(arcUnit.id), 8); // breaks 5 shield
check("feedback: shield break zaps a nearby enemy", attacker.hp < atkHp0);
check("feedback chain event emitted", a.events.some((e) => e.t === "chain" && e.feedback));

// -- determinism -------------------------------------------------------------------
for (let t = 0; t < 300; t++) step();
check("mirror sims stay checksum-identical", a.checksum() === b.checksum());

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL FUN CHECKS PASSED.");
process.exit(fail ? 1 : 0);
