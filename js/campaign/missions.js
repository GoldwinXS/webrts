// The webRTS single-player CAMPAIGN — mission DATA (no DOM, no rendering).
//
// This file is pure data + scripting closures. The runner (campaign.js) walks
// a Sim through each mission, calling the hooks below and driving the UI. Every
// mission is a plain object:
//
//   {
//     id, act, title, blurb,
//     mapSeed, mapOpts,          fixed seed => hand-tuned, repeatable layout
//     factions: [player, enemy], faction keys for player 0 and player 1
//     aiDifficulty | ai:false,   "easy"|"normal"|"hard", or ai:false for no AI
//     setup(ctx) {},             post-init scripting (runs like prepShowcase,
//                                BEFORE the Renderer is built — flatten fog,
//                                clear/spawn entities, pre-place bases)
//     objectives: [{ id, text, check(sim)->bool, optional? }],
//     triggers:  [{ at?(tick) | when?(sim)->bool, once, run(ctx) }],
//     winWhen(sim)->bool, loseWhen(sim)->bool,
//     dialogue: { key: {speaker, text} }   referenced by triggers via ctx.line
//   }
//
// ctx (passed to setup/triggers/checks where useful) is built by the runner and
// exposes: { sim, game, tick, say(speaker,text), line(key), spawnWave(...),
//            objectiveDone(id), objectiveShow(id), reveal(), toast(msg),
//            player, enemy }  — see campaign.js buildCtx().
//
// The player is ALWAYS sim player 0; the enemy (if any) is player 1. Mission
// sims run single-player with sim.noGameOver = true — the runner drives the end
// from winWhen/loseWhen, NOT the sim's own winner detection. Scripted setup and
// triggers may bypass the command pipeline freely (determinism is moot here),
// exactly like the Dev Gallery showcase does.

import { FP, tileToFp } from "../core/fixed.js";

// ---- small scripting helpers shared by several missions --------------------

// Count a player's live units of a type (or any unit if type omitted).
function countUnits(sim, pid, type) {
  let n = 0;
  for (const e of sim.entities)
    if (e.owner === pid && e.unit && e.hp > 0 && (!type || e.type === type)) n++;
  return n;
}

// Count a player's FINISHED buildings of a type (or any building if omitted).
function countBuildings(sim, pid, type, doneOnly = true) {
  let n = 0;
  for (const e of sim.entities)
    if (e.owner === pid && e.building && e.hp > 0 && (!doneOnly || e.done) &&
        (!type || e.type === type)) n++;
  return n;
}

// Does the player have ANY finished building at all? (base-alive test)
function hasAnyBuilding(sim, pid) {
  for (const e of sim.entities)
    if (e.owner === pid && e.building && e.hp > 0) return true;
  return false;
}

// Total minerals gathered so far is not tracked by the sim, so missions that
// ask "mine X scrap" watch a running high-water counter the runner keeps in
// ctx (sim.minerals only reflects the CURRENT balance). We instead check the
// player's current mineral balance crossing a threshold, which is simpler and
// reads fine as "stockpile N Scrap".

// ===========================================================================
// ACT 1 — THE COGS
// A bright, silly tin-robot opening trilogy. Foreman Sprocket (a pompous Hub
// AI) and Bearing #7 (an over-caffeinated worker who has never seen a threat
// in its life) run a scrap depot. Their reserves keep vanishing overnight...
// ===========================================================================

const mission1 = {
  id: "a1m1",
  act: 1,
  title: "Rise and Grind",
  blurb: "Foreman Sprocket wants the morning quota met. No excuses, no coffee.",
  mapSeed: 1001,
  mapOpts: { spawns: "cross", expansions: 0, theme: 0 },
  factions: ["cogs", "cogs"],
  ai: false,                       // pure tutorial — nobody to fight
  intro: {
    speaker: "FOREMAN SPROCKET",
    text: "Rise and grind, Bearing #7! Reserves are low and the quota waits for no bolt.",
  },
  dialogue: {
    open2:   { speaker: "BEARING #7", text: "Morning, boss! Permission to fetch coffee first?" },
    open3:   { speaker: "FOREMAN SPROCKET", text: "Denied. We are ROBOTS. Right-click a Scrap pile to send workers mining." },
    workers: { speaker: "FOREMAN SPROCKET", text: "More hands! Click the Hub, then train Bearings. Shift-click to queue a whole batch." },
    battery: { speaker: "BEARING #7", text: "Ooh, a Battery! That raises our supply cap. Very roomy. Very cosy." },
    idle:    { speaker: "FOREMAN SPROCKET", text: "An idle worker is a rusting worker. Tap F1 to yank the loafer back to work." },
    assembly:{ speaker: "FOREMAN SPROCKET", text: "Now an Assembly. Someday we may need... soldiers. Perish the thought." },
    scrap:   { speaker: "BEARING #7", text: "Quota met, boss! Can I have that coffee NOW?" },
    done:    { speaker: "FOREMAN SPROCKET", text: "...Fine. One coffee. You've earned a single, regulation-sized coffee." },
  },
  // No enemy; keep it a calm, bright depot. Give the player a little starting
  // scrap so the first builds are frictionless.
  setup(ctx) {
    const { sim } = ctx;
    // full vision, no fog-of-war anxiety in the tutorial
    sim.fog[0].fill(2);
    // strip player 1 entirely — this is a solo economy lesson
    ctx.clearPlayer(1);
    sim.minerals[0] = 250;
    sim.gas[0] = 0;
  },
  objectives: [
    { id: "train",   text: "Train 4 more Bearings (workers)",     check: (s) => countUnits(s, 0, "worker") >= 9 },
    { id: "battery", text: "Build a Battery (supply)",            check: (s) => countBuildings(s, 0, "depot") >= 1 },
    { id: "assembly",text: "Build an Assembly (barracks)",        check: (s) => countBuildings(s, 0, "barracks") >= 1 },
    { id: "scrap",   text: "Stockpile 400 Scrap",                 check: (s) => s.minerals[0] >= 400 },
  ],
  triggers: [
    { at: 12,  once: true, run: (c) => c.line("open2") },
    { at: 40,  once: true, run: (c) => c.line("open3") },
    { at: 120, once: true, run: (c) => c.line("workers") },
    // teach idle-worker recall once a worker has actually gone idle
    { when: (s) => idleWorkerExists(s, 0), once: true, run: (c) => c.line("idle") },
    { when: (s) => countBuildings(s, 0, "depot") >= 1, once: true, run: (c) => c.line("battery") },
    { when: (s) => countBuildings(s, 0, "barracks") >= 1, once: true, run: (c) => c.line("assembly") },
    { when: (s) => s.minerals[0] >= 400, once: true, run: (c) => c.line("scrap") },
  ],
  winWhen: (s) => countUnits(s, 0, "worker") >= 9 &&
                  countBuildings(s, 0, "depot") >= 1 &&
                  countBuildings(s, 0, "barracks") >= 1 &&
                  s.minerals[0] >= 400,
  loseWhen: () => false,           // you can't lose a coffee-break argument
  outro: {
    speaker: "FOREMAN SPROCKET",
    text: "Quota met. Depot secure. Now excuse me while I calculate exactly how much coffee that was.",
  },
};

const mission2 = {
  id: "a1m2",
  act: 1,
  title: "Something in the Pipes",
  blurb: "The night-shift scrap keeps vanishing. Sprocket blames gremlins. It is not gremlins.",
  mapSeed: 1002,
  mapOpts: { spawns: "cross", expansions: 0, theme: 0 },
  factions: ["cogs", "ooze"],
  ai: false,                       // waves are hand-scripted, not an AI economy
  intro: {
    speaker: "FOREMAN SPROCKET",
    text: "Reserves down again overnight! Bearing #7, I want DEFENSES. And an explanation.",
  },
  dialogue: {
    build:   { speaker: "FOREMAN SPROCKET", text: "Build an Assembly, then a Sentry turret. Train some Zappers. Chop chop." },
    first:   { speaker: "BEARING #7", text: "Boss? The Scrap pile is... moving. And it has TEETH." },
    ooze1:   { speaker: "FOREMAN SPROCKET", text: "That is not a gremlin. That is GOO. Zap it! Right-click the goo to attack!" },
    wave2:   { speaker: "FOREMAN SPROCKET", text: "More of it! Sentries fire on their own — huddle your Zappers behind them." },
    wave3:   { speaker: "BEARING #7", text: "It keeps oozing out of the pipes, boss! So THAT'S where our scrap went!" },
    survive: { speaker: "FOREMAN SPROCKET", text: "Hold the line! Reinforcements are... well, WE are the reinforcements. Hold!" },
    win:     { speaker: "FOREMAN SPROCKET", text: "The goo has retreated. The mystery is solved: our scrap is being EATEN. Unacceptable." },
  },
  setup(ctx) {
    const { sim } = ctx;
    sim.fog[0].fill(2);
    ctx.clearPlayer(1);            // no enemy base — waves spawn from triggers
    sim.minerals[0] = 350;
    sim.gas[0] = 0;
    // give the player a small head start: two Zappers already on guard
    const s0 = sim.map.starts[0];
    ctx.spawnFor(0, "marine", s0.x + 4, s0.y + 1);
    ctx.spawnFor(0, "marine", s0.x + 4, s0.y + 2);
    // remember where waves crawl in from (a map corner far from the player)
    ctx._oozeFrom = { x: sim.map.w - 6, y: sim.map.h - 6 };
    ctx._wavesDone = 0;
    ctx._wavesTotal = 4;
  },
  objectives: [
    { id: "sentry", text: "Build a Sentry turret (defense)", check: (s) => countBuildings(s, 0, "turret") >= 1 },
    { id: "zap",    text: "Train 4 Zappers",                 check: (s) => countUnits(s, 0, "marine") >= 6 },
    { id: "hold",   text: "Survive 4 ooze waves",            check: (s, c) => (c?._wavesDone || 0) >= 4 },
  ],
  triggers: [
    { at: 20,  once: true, run: (c) => c.line("build") },
    // first wave once the player has had ~30s to set up
    { at: 320, once: true, run: (c) => { c.line("first"); } },
    { at: 360, once: true, run: (c) => { c.line("ooze1"); c.spawnWave("nip", 4, 1); } },
    { at: 620, once: true, run: (c) => { c.line("wave2"); c.spawnWave("nip", 5, 2); } },
    { at: 900, once: true, run: (c) => { c.line("wave3"); c.spawnWave("nip", 6, 3); } },
    { at: 1180,once: true, run: (c) => { c.line("survive"); c.spawnWave("nip", 7, 4); } },
  ],
  // win: all 4 waves cleared out (no ooze units left AND all waves have spawned)
  winWhen: (s, c) => (c?._wavesDone || 0) >= 4 && countUnits(s, 1) === 0,
  loseWhen: (s) => !hasAnyBuilding(s, 0),   // Hub (and everything) destroyed
  outro: {
    speaker: "BEARING #7",
    text: "Note to self: the scrap pile that bites is NOT a friend. Filing under 'goo, hostile.'",
  },
};

const mission3 = {
  id: "a1m3",
  act: 1,
  title: "Repo Men",
  blurb: "The company sends heavy equipment. Time to evict the goo and repossess the neighborhood.",
  mapSeed: 1003,
  mapOpts: { spawns: "cross", expansions: 1, theme: 0 },
  factions: ["cogs", "ooze"],
  aiDifficulty: "easy",            // a real (gentle) opponent from a head start
  intro: {
    speaker: "FOREMAN SPROCKET",
    text: "The company shipped us heavy equipment: THUMPERS. We are going door to door. Evict the goo.",
  },
  dialogue: {
    thumper: { speaker: "FOREMAN SPROCKET", text: "Build a Foundry (needs an Assembly first), then roll out Thumpers. Big. Loud. Ours." },
    scout:   { speaker: "BEARING #7", text: "Found their nest, boss! It's all... bubbly. And unlicensed!" },
    push:    { speaker: "FOREMAN SPROCKET", text: "Then we repossess it. Flatten every gooey structure. Leave no bubble unpopped." },
    hurt:    { speaker: "BEARING #7", text: "They're fighting back, boss! Rude. So very rude." },
    win:     { speaker: "FOREMAN SPROCKET", text: "Nest cleared. Scrap recovered. Paperwork filed. Another perfect day at the depot." },
    stinger1:{ speaker: "???", text: "...cold. dry. the little metal things scraped us off the warm rock. we remember." },
    stinger2:{ speaker: "???", text: "And far above, the sky begins to hum. Something with WEATHER is coming to visit." },
  },
  setup(ctx) {
    const { sim } = ctx;
    sim.fog[0].fill(2);            // no exploration puzzle; keep it a clean fight
    sim.minerals[0] = 300;
    sim.gas[0] = 120;             // enough oil to start a Foundry + Thumper line
    // Pre-place a small, slightly battered ooze base for the AI to defend, so
    // the "assault a nest" fantasy lands from tick 0 (the easy AI then rebuilds
    // and pushes from here). Uses raw spawns like the showcase does.
    ctx.woundEnemyBase(1);
  },
  objectives: [
    { id: "foundry", text: "Build a Foundry (unlocks Thumpers)", check: (s) => countBuildings(s, 0, "factory") >= 1 },
    { id: "thumper", text: "Train a Thumper",                    check: (s) => countUnits(s, 0, "tank") >= 1 },
    { id: "raze",    text: "Destroy every ooze structure",       check: (s) => countBuildings(s, 1, null, false) === 0 },
  ],
  triggers: [
    { at: 24,  once: true, run: (c) => c.line("thumper") },
    { when: (s) => countUnits(s, 0, "tank") >= 1, once: true, run: (c) => c.line("scout") },
    { when: (s) => countUnits(s, 0, "tank") >= 1, once: true, run: (c) => c.line("push") },
    // a little flavor when the enemy has bitten back (player lost a unit-ish):
    { at: 900, once: true, run: (c) => c.line("hurt") },
  ],
  winWhen: (s) => countBuildings(s, 1, null, false) === 0,
  loseWhen: (s) => !hasAnyBuilding(s, 0),
  outro: {
    speaker: "FOREMAN SPROCKET",
    text: "Act one, complete. Depot: secure. Goo: evicted. But down in the drains, something is still... watching.",
  },
  // end-of-act stinger: teases Act 2 (play AS the ooze) and Act 3 (the Tempest)
  stinger: ["stinger1", "stinger2"],
};

// ===========================================================================
// ACT 2 / ACT 3 — locked stubs (structure only; not yet playable)
// ===========================================================================

const act2stub = {
  id: "a2m1",
  act: 2,
  title: "The Other Side of the Slime",
  blurb: "Play as the Ooze. Turns out being scraped off a warm rock is a great origin story. [Coming soon]",
  stub: true,
};

const act3stub = {
  id: "a3m1",
  act: 3,
  title: "Weather Warning",
  blurb: "The Tempest arrives — living lightning in floating armor, and it does not like the neighborhood. [Coming soon]",
  stub: true,
};

// ---- act / mission registry ------------------------------------------------

export const ACTS = [
  { act: 1, title: "Act I — The Cogs",  subtitle: "A tin-robot depot, a vanishing quota, and a scrap pile with teeth." },
  { act: 2, title: "Act II — The Ooze", subtitle: "The other side of the slime." },
  { act: 3, title: "Act III — The Tempest", subtitle: "Weather warning." },
];

// Ordered mission list. Order defines unlock progression (a mission unlocks
// once the PREVIOUS non-stub mission is completed).
export const MISSIONS = [
  mission1, mission2, mission3,
  act2stub, act3stub,
];

export const MISSION_BY_ID = Object.fromEntries(MISSIONS.map((m) => [m.id, m]));

// The first mission id — always unlocked.
export const FIRST_MISSION = MISSIONS[0].id;

// ---- shared predicate used by a trigger above ------------------------------
// (kept at file end so the mission literals above can reference it via hoist)
function idleWorkerExists(sim, pid) {
  for (const e of sim.entities)
    if (e.owner === pid && e.unit && e.hp > 0 && UNITS_isWorker(e.type) &&
        e.order && e.order.kind === "idle") return true;
  return false;
}
// tiny local worker test (avoids importing the whole data module surface)
function UNITS_isWorker(type) { return type === "worker" || type === "mote" || type === "ion"; }

// Re-export fp helpers some setup closures use through ctx, but keep them here
// too in case a mission wants raw placement math.
export { FP, tileToFp };
