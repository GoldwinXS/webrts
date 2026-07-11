// Headless campaign-runner regression. The mission definitions (js/campaign/
// missions.js) are pure data + scripting closures; the Sim (js/core/sim.js) is
// importable and deterministic. This test boots each mission's setup through a
// minimal ctx stub (mirroring CampaignRunner.runSetup), then drives the Sim
// to satisfy the objectives and asserts winWhen fires — plus that loseWhen and
// the unlock/progress logic behave.
//
// Act 2 (the Ooze) and the hand-authored map grids + cinematics are covered
// too: win/lose closures fire under scripted sim states, every marker a mission
// references actually exists in its grid, and all dialogue is emoji-free.
//
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

// Feature-detect the engine's map parser (built by the engine agent). If it's
// on disk we validate every hand-authored grid through it; otherwise we skip
// those checks gracefully with a note and validate grid shape ourselves.
let parseGrid = null;
try {
  const maps = await import("./js/campaign/maps.js");
  parseGrid = maps.parseGrid || maps.parseMapGrid || maps.default || null;
} catch { /* maps.js not on disk yet */ }

// ---- minimal ctx stub, matching CampaignRunner.runSetup + spawnWave ---------
// Only the entity-scripting surface the missions actually use in headless mode.
function makeCtx(sim) {
  const state = {};
  const ctx = {
    sim, state, player: 0, enemy: 1, tileToFp,
    say() {}, line() {}, toast() {}, objectiveDone() {},
    // cinematics are inert headlessly; missions guard every call with `if`.
    playCinematic() {},
    // marker resolution needs the live map parser; headlessly return null so
    // setups fall back to their default coords (all guarded with `|| {...}`).
    marker() { return null; },
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

// Spread goo across the whole grid (simulate the Ooze player claiming ground)
// so gooTiles-based objectives can be satisfied headlessly.
function floodGoo(sim, n) {
  const g = sim.gooGrid;
  let placed = 0;
  for (let i = 0; i < g.length && placed < n; i++) {
    if (g[i] !== 1) { g[i] = 1; placed++; }
  }
}

// ---- MISSION 1: economy tutorial, win when all four objectives clear --------
{
  const m = MISSION_BY_ID.a1m1;
  const { sim, ctx } = boot(m);
  check("m1: setup stripped player 1 (no enemy entities)",
    sim.entities.every((e) => e.owner !== 1));
  check("m1: win NOT satisfied at start", !m.winWhen(sim, ctx.state));

  const s0 = sim.map.starts[0];
  while (sim.entities.filter((e) => e.owner === 0 && e.unit && e.type === "worker").length < 9)
    sim.spawnUnit(0, "worker", tileToFp(s0.x + 2), tileToFp(s0.y + 2));
  sim.spawnBuilding(0, "depot", s0.x + 4, s0.y + 4, true);
  sim.spawnBuilding(0, "barracks", s0.x + 4, s0.y - 4, true);
  sim.minerals[0] = 400;
  for (let i = 0; i < 5; i++) sim.step(null);

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
  check("m2: setup left a Cog Hub standing for the player",
    sim.entities.some((e) => e.owner === 0 && e.building && e.type === "hq" && e.hp > 0));
  check("m2: win NOT satisfied at start", !m.winWhen(sim, ctx.state));

  ctx.spawnWave("nip", 4, 1);
  ctx.spawnWave("nip", 5, 2);
  ctx.spawnWave("nip", 6, 3);
  ctx.spawnWave("nip", 7, 4);
  check("m2: wave counter reached 4", (ctx.state._wavesDone || 0) >= 4);
  check("m2: win NOT satisfied while ooze units are alive", !m.winWhen(sim, ctx.state));
  for (const e of sim.entities) if (e.owner === 1 && e.unit) { e.hp = 0; sim.byId.delete(e.id); }
  sim.entities = sim.entities.filter((e) => sim.byId.has(e.id));
  check("m2: winWhen FIRES after 4 waves cleared", m.winWhen(sim, ctx.state));

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
  for (const e of sim.entities) if (e.owner === 1 && e.building) { sim.setFootprint(e, 0); e.hp = 0; sim.byId.delete(e.id); }
  sim.entities = sim.entities.filter((e) => sim.byId.has(e.id));
  check("m3: winWhen FIRES once all enemy structures razed", m.winWhen(sim, ctx.state));
}

// ---- ACT 2 MISSION 1 (a2m1): creep tutorial, win on goo+vent+den+nips --------
{
  const m = MISSION_BY_ID.a2m1;
  const { sim, ctx } = boot(m);
  check("a2m1: player 0 is the Ooze (has a Nucleus)",
    sim.entities.some((e) => e.owner === 0 && e.type === "nucleus" && e.hp > 0));
  check("a2m1: win NOT satisfied at start", !m.winWhen(sim, ctx.state));

  const s0 = sim.map.starts[0];
  floodGoo(sim, 40);
  sim.spawnBuilding(0, "vent", s0.x + 4, s0.y + 4, true);
  sim.spawnBuilding(0, "den", s0.x + 4, s0.y - 4, true);
  while (sim.entities.filter((e) => e.owner === 0 && e.type === "nip").length < 4)
    sim.spawnUnit(0, "nip", tileToFp(s0.x + 2), tileToFp(s0.y + 2));

  const byId = Object.fromEntries(m.objectives.map((o) => [o.id, o]));
  check("a2m1: obj spread (40 goo) satisfied", byId.spread.check(sim, ctx.state));
  check("a2m1: obj vent satisfied", byId.vent.check(sim, ctx.state));
  check("a2m1: obj den satisfied", byId.den.check(sim, ctx.state));
  check("a2m1: obj nips (4) satisfied", byId.nips.check(sim, ctx.state));
  check("a2m1: winWhen FIRES once all objectives met", m.winWhen(sim, ctx.state));
  check("a2m1: loseWhen NOT fired (Nucleus alive)", !m.loseWhen(sim, ctx.state));
}

// ---- ACT 2 MISSION 2 (a2m2): defense, win on 4 waves + no Cogs left ----------
{
  const m = MISSION_BY_ID.a2m2;
  const { sim, ctx } = boot(m);
  check("a2m2: player 0 is the Ooze (has a Nucleus)",
    sim.entities.some((e) => e.owner === 0 && e.type === "nucleus" && e.hp > 0));
  check("a2m2: win NOT satisfied at start", !m.winWhen(sim, ctx.state));

  ctx.spawnWave("marine", 4, 1);
  ctx.spawnWave("marine", 5, 2);
  ctx.spawnWave("brute", 4, 3);
  ctx.spawnWave("marine", 6, 4);
  check("a2m2: wave counter reached 4", (ctx.state._wavesDone || 0) >= 4);
  check("a2m2: win NOT satisfied while Cog units alive", !m.winWhen(sim, ctx.state));
  for (const e of sim.entities) if (e.owner === 1 && e.unit) { e.hp = 0; sim.byId.delete(e.id); }
  sim.entities = sim.entities.filter((e) => sim.byId.has(e.id));
  check("a2m2: winWhen FIRES after 4 waves cleared", m.winWhen(sim, ctx.state));

  const { sim: sim2, ctx: ctx2 } = boot(m);
  check("a2m2: loseWhen NOT set with warren intact", !m.loseWhen(sim2, ctx2.state));
  for (const e of sim2.entities) if (e.owner === 0 && e.building) { e.hp = 0; sim2.byId.delete(e.id); }
  sim2.entities = sim2.entities.filter((e) => sim2.byId.has(e.id));
  check("a2m2: loseWhen FIRES when all player buildings destroyed", m.loseWhen(sim2, ctx2.state));
}

// ---- ACT 2 MISSION 3 (a2m3): assault the depot, win on 0 Cog structures ------
{
  const m = MISSION_BY_ID.a2m3;
  const { sim, ctx } = boot(m);
  check("a2m3: setup pre-placed a Cog depot (player 1 has buildings)",
    sim.entities.some((e) => e.owner === 1 && e.building));
  check("a2m3: player 0 is the Ooze (has a Nucleus)",
    sim.entities.some((e) => e.owner === 0 && e.type === "nucleus" && e.hp > 0));
  check("a2m3: win NOT satisfied while the depot stands", !m.winWhen(sim, ctx.state));
  for (const e of sim.entities) if (e.owner === 1 && e.building) { sim.setFootprint(e, 0); e.hp = 0; sim.byId.delete(e.id); }
  sim.entities = sim.entities.filter((e) => sim.byId.has(e.id));
  check("a2m3: winWhen FIRES once the Cog depot is razed", m.winWhen(sim, ctx.state));
  check("a2m3: loseWhen FIRES if our Nucleus is gone too", (() => {
    for (const e of sim.entities) if (e.owner === 0 && e.building) { e.hp = 0; sim.byId.delete(e.id); }
    sim.entities = sim.entities.filter((e) => sim.byId.has(e.id));
    return m.loseWhen(sim, ctx.state);
  })());
}

// ---- HAND-AUTHORED MAP GRIDS: shape + parse (parse gated on maps.js) ---------
{
  const withMaps = MISSIONS.filter((m) => !m.stub && m.map && m.map.grid);
  check("maps: all 6 playable missions declare a hand-authored grid", withMaps.length === 6);
  for (const m of withMaps) {
    const rows = m.map.grid.split("\n").filter((r) => r.length);
    const w = Math.max(...rows.map((r) => r.length));
    // rectangular-ish and reasonably sized
    const rectish = rows.every((r) => Math.abs(r.length - w) <= 2);
    check(`maps: ${m.id} grid is rectangular-ish (${w}x${rows.length})`, rectish && w >= 30 && rows.length >= 12);
    // exactly one player start, at least one enemy start OR none (tutorials)
    const flat = m.map.grid;
    check(`maps: ${m.id} has exactly one player start '@'`, (flat.match(/@/g) || []).length === 1);
    // theme declared 0..2
    check(`maps: ${m.id} theme in 0..2`, m.map.theme >= 0 && m.map.theme <= 2);
    if (parseGrid) {
      let parsed = null, err = null;
      try { parsed = parseGrid(m.map.grid, m.map.theme); } catch (e) { err = e; }
      check(`maps: ${m.id} grid parses through maps.js`, !!parsed && !err);
    }
  }
  if (!parseGrid) console.log("  note: js/campaign/maps.js not on disk yet — grid PARSE checks skipped (shape checks still ran).");
}

// ---- MARKER INTEGRITY: no mission references a marker its grid lacks ----------
// Walk each mission's own data for marker names used in cinematics (cam.at,
// spawn.at, move.to, kill.at, fx.at/to) and setup marker() calls, and assert
// every referenced single-letter marker A..K appears in the grid.
{
  const MARKER_RE = /^[A-K]$/;
  const usedMarkers = (m) => {
    const set = new Set();
    const scanAt = (v) => { if (typeof v === "string" && MARKER_RE.test(v)) set.add(v); };
    for (const name in (m.cinematics || {})) {
      for (const step of m.cinematics[name]) {
        if (step.cam) scanAt(step.cam.at);
        if (step.spawn) scanAt(step.spawn.at);
        if (step.move) scanAt(step.move.to);
        if (step.kill) scanAt(step.kill.at);
        if (step.fx) { scanAt(step.fx.at); scanAt(step.fx.to); }
      }
    }
    // markers named in the mission source that setup resolves via ctx.marker(...)
    if (m.setup) {
      const src = m.setup.toString();
      const re = /marker\(\s*["']([A-K])["']\s*\)/g;
      let mm; while ((mm = re.exec(src))) set.add(mm[1]);
    }
    return set;
  };
  for (const m of MISSIONS.filter((x) => !x.stub && x.map)) {
    const grid = m.map.grid;
    const used = usedMarkers(m);
    let missing = [];
    for (const mk of used) if (!grid.includes(mk)) missing.push(mk);
    check(`markers: ${m.id} references only markers present in its grid` +
      (missing.length ? ` (missing: ${missing.join(",")})` : ""), missing.length === 0);
  }
}

// ---- NO EMOJIS ANYWHERE in mission data (hard user rule) ---------------------
{
  // Broad emoji / pictograph / dingbat coverage across the astral planes.
  const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/u;
  const strings = [];
  const collect = (m) => {
    const push = (s) => { if (typeof s === "string") strings.push([m.id, s]); };
    push(m.title); push(m.blurb);
    if (m.intro) push(m.intro.text);
    if (m.outro) push(m.outro.text);
    for (const k in (m.dialogue || {})) push(m.dialogue[k].text);
    for (const o of (m.objectives || [])) push(o.text);
    for (const name in (m.cinematics || {}))
      for (const step of m.cinematics[name]) {
        if (step.say) push(step.say.text);
        if (step.label) push(step.label.text);
      }
  };
  for (const m of MISSIONS) collect(m);
  for (const a of ACTS) { strings.push(["ACTS", a.title]); strings.push(["ACTS", a.subtitle]); }

  const offenders = strings.filter(([, s]) => EMOJI_RE.test(s));
  check("emoji-free: no mission/act string contains an emoji",
    offenders.length === 0);
  if (offenders.length) for (const [id, s] of offenders) console.log(`      offender in ${id}: ${JSON.stringify(s)}`);
}

// ---- registry / progression sanity ------------------------------------------
{
  check("registry: FIRST_MISSION is the first mission id", FIRST_MISSION === MISSIONS[0].id);
  check("registry: every mission has a unique id",
    new Set(MISSIONS.map((x) => x.id)).size === MISSIONS.length);
  check("registry: Act 1 ids preserved (a1m1/a1m2/a1m3)",
    ["a1m1", "a1m2", "a1m3"].every((id) => MISSION_BY_ID[id] && !MISSION_BY_ID[id].stub));
  check("registry: Act 2 is now three PLAYABLE missions",
    ["a2m1", "a2m2", "a2m3"].every((id) => MISSION_BY_ID[id] && !MISSION_BY_ID[id].stub));
  const stubs = MISSIONS.filter((x) => x.stub);
  check("registry: Act 3 remains a stub", stubs.length >= 1 && stubs.every((s) => s.act === 3));
  check("registry: three acts declared", ACTS.length === 3);
  for (const m of MISSIONS.filter((x) => !x.stub)) {
    const ok = m.title && m.blurb && typeof m.mapSeed === "number" &&
      Array.isArray(m.factions) && Array.isArray(m.objectives) &&
      typeof m.winWhen === "function" && typeof m.loseWhen === "function";
    check(`shape: ${m.id} has full mission definition`, !!ok);
  }
}

// ---- determinism: a booted mission Sim stays deterministic across two runs ---
{
  for (const id of ["a1m3", "a2m1", "a2m3"]) {
    const m = MISSION_BY_ID[id];
    const a = boot(m).sim, b = boot(m).sim;
    let desync = false;
    for (let t = 0; t < 300; t++) {
      a.step(null); b.step(null);
      if (t % 50 === 0 && a.checksum() !== b.checksum()) { desync = true; break; }
    }
    check(`determinism: ${id} — two identical boots stay checksum-identical`, !desync);
  }
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL CAMPAIGN CHECKS PASSED.");
process.exit(fail ? 1 : 0);
