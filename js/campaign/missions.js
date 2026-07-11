// The webRTS single-player CAMPAIGN — mission DATA (no DOM, no rendering).
//
// This file is pure data + scripting closures. The runner (campaign.js) walks
// a Sim through each mission, calling the hooks below and driving the UI. Every
// mission is a plain object:
//
//   {
//     id, act, title, blurb,
//     mapSeed, mapOpts,          fixed seed => hand-tuned, repeatable layout
//     map: { theme, grid },      OPTIONAL hand-authored terrain (see legend)
//     cinematics: { name: [..] }, OPTIONAL scripted camera/dialogue sequences
//     introCinematic: "name",     OPTIONAL cinematic that plays on mission start
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
//            marker(name), playCinematic(name), spawnFor(pid,type,tx,ty),
//            player, enemy }  — see campaign.js buildCtx().
//
// The player is ALWAYS sim player 0; the enemy (if any) is player 1. Mission
// sims run single-player with sim.noGameOver = true — the runner drives the end
// from winWhen/loseWhen, NOT the sim's own winner detection. Scripted setup and
// triggers may bypass the command pipeline freely (determinism is moot here),
// exactly like the Dev Gallery showcase does.
//
// ---------------------------------------------------------------------------
// HAND-AUTHORED MAP GRIDS (the `map` field, engine per FROZEN CONTRACT)
// ---------------------------------------------------------------------------
// Legend, one char per tile:
//   .  lowland          #  rock wall (blocked)     /  ramp
//   1 2 3  raised passable levels                  F  forest (blocked)
//   L  lava (blocked)   I  ice        R  rock barrier (blocked)
//   M  mineral patch    G  geyser (top-left of its 2x2)
//   s  LoS shrub        @  player start            !  enemy start
//   A..K  named markers -> resolve via ctx.marker(name); spawn/`at` accept names
// The grids below STAGE the story: chokes for ambushes, a scarred pit for the
// goo nest, cliff overlooks for reveals. Author's note: base pads are kept flat
// (~11x11) with mineral arcs 4-6 tiles out and a geyser nearby.

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

// Count tiles of Goo the player controls (Ooze creep spread). Missions that
// teach/track creep read the sim's gooGrid directly; it's a plain Uint8Array.
function gooTiles(sim) {
  const g = sim.gooGrid;
  if (!g) return 0;
  let n = 0;
  for (let i = 0; i < g.length; i++) if (g[i] === 1) n++;
  return n;
}

// Total minerals gathered so far is not tracked by the sim, so missions that
// ask "mine X scrap" watch the player's current mineral balance crossing a
// threshold, which reads fine as "stockpile N Scrap".

// ===========================================================================
// ACT 1 — THE COGS
// A bright, silly tin-robot opening trilogy. Foreman Sprocket (a pompous Hub
// AI) and Bearing #7 (an over-caffeinated worker who has never seen a threat
// in its life) run a scrap depot. Their reserves keep vanishing overnight...
// ===========================================================================

// ---- a1m1 map: a tidy sunlit depot on a low mesa. One flat base pad (@) with
// a mineral arc and a geyser; a shrub-lined yard; the loading dock is a gentle
// ramp down to lowland. Deliberately calm — no chokes, no threats. -----------
const MAP_A1M1 = `
................................................
................................................
......############################..............
......#........................../#.............
......#..MM....................../#.............
......#.MMM......ssss...........A.#.............
......#.MMM......ssss.............#.............
......#..MM.........@.............#.............
......#....GG.....................#.............
......#....GG.....................#.............
......#...........ssss............#.............
......#...........ssss...........B#.............
......#........................../#.............
......############################..............
................................................
................................................
`;

const mission1 = {
  id: "a1m1",
  act: 1,
  title: "Rise and Grind",
  blurb: "Foreman Sprocket wants the morning quota met. No excuses, no coffee.",
  mapSeed: 1001,
  mapOpts: { spawns: "cross", expansions: 0, theme: 0 },
  map: { theme: 0, grid: MAP_A1M1 },
  factions: ["cogs", "cogs"],
  ai: false,                       // pure tutorial — nobody to fight
  introCinematic: "open",
  intro: {
    speaker: "FOREMAN SPROCKET",
    text: "Rise and grind, Bearing #7. Reserves are low and the quota waits for no bolt.",
  },
  cinematics: {
    // Establishing pan across the depot, banter, title card. ~9s, skippable.
    open: [
      { fade: { out: true, dur: 0 } },
      { cam: { at: "A", dist: 34, yaw: 0.4, dur: 10 } },
      { fade: { out: false, dur: 700 } },
      { label: { text: "COG DEPOT 7 — MORNING SHIFT" } },
      { wait: 700 },
      { cam: { at: "@", dist: 24, yaw: 0.9, dur: 2600 } },
      { say: { speaker: "FOREMAN SPROCKET", text: "Rise and grind, Bearing #7. The quota waits for no bolt.", dur: 2600 } },
      { say: { speaker: "BEARING #7", text: "Morning, boss! Is it a coffee kind of morning?", dur: 2400 } },
      { say: { speaker: "FOREMAN SPROCKET", text: "It is a QUOTA kind of morning. Get to work.", dur: 2400 } },
      { label: { text: "RISE AND GRIND" } },
      { wait: 900 },
    ],
  },
  dialogue: {
    open2:   { speaker: "BEARING #7", text: "Permission to fetch coffee first? For morale. Mine, mostly." },
    open3:   { speaker: "FOREMAN SPROCKET", text: "Denied. We are ROBOTS. Right-click a Scrap pile to send workers mining." },
    mining:  { speaker: "BEARING #7", text: "Ooh, the numbers go UP. I love the numbers going up." },
    workers: { speaker: "FOREMAN SPROCKET", text: "More hands. Click the Hub, train Bearings. Shift-click to queue a whole batch." },
    battery: { speaker: "BEARING #7", text: "A Battery! It raises our supply cap. Very roomy. Very cosy." },
    idle:    { speaker: "FOREMAN SPROCKET", text: "An idle worker is a rusting worker. Tap F1 to yank the loafer back to work." },
    assembly:{ speaker: "FOREMAN SPROCKET", text: "Now an Assembly. Someday we may need... soldiers. Perish the thought." },
    quota:   { speaker: "BEARING #7", text: "Quota's climbing, boss. We're going to MAKE it. We're going to make it!" },
    scrap:   { speaker: "BEARING #7", text: "Quota met! Can I have that coffee NOW? Please? I filed a request and everything." },
  },
  // No enemy; keep it a calm, bright depot. Give the player a little starting
  // scrap so the first builds are frictionless.
  setup(ctx) {
    const { sim } = ctx;
    sim.fog[0].fill(2);            // full vision, no fog anxiety in the tutorial
    ctx.clearPlayer(1);            // strip player 1 — this is a solo lesson
    sim.minerals[0] = 250;
    sim.gas[0] = 0;
  },
  objectives: [
    { id: "train",   text: "Train 4 more Bearings — quota needs hands", check: (s) => countUnits(s, 0, "worker") >= 9 },
    { id: "battery", text: "Build a Battery — the crew needs elbow room", check: (s) => countBuildings(s, 0, "depot") >= 1 },
    { id: "assembly",text: "Build an Assembly — just in case, Sprocket says", check: (s) => countBuildings(s, 0, "barracks") >= 1 },
    { id: "scrap",   text: "Stockpile 400 Scrap — hit the morning quota", check: (s) => s.minerals[0] >= 400 },
  ],
  triggers: [
    { at: 12,  once: true, run: (c) => c.line("open2") },
    { at: 40,  once: true, run: (c) => c.line("open3") },
    // first bit of scrap comes in
    { when: (s) => s.minerals[0] >= 300, once: true, run: (c) => c.line("mining") },
    { at: 160, once: true, run: (c) => c.line("workers") },
    // teach idle-worker recall once a worker has actually gone idle
    { when: (s) => idleWorkerExists(s, 0), once: true, run: (c) => c.line("idle") },
    { when: (s) => countBuildings(s, 0, "depot") >= 1, once: true, run: (c) => c.line("battery") },
    { when: (s) => countBuildings(s, 0, "barracks") >= 1, once: true, run: (c) => c.line("assembly") },
    { when: (s) => s.minerals[0] >= 360, once: true, run: (c) => c.line("quota") },
    { when: (s) => s.minerals[0] >= 400, once: true, run: (c) => c.line("scrap") },
  ],
  winWhen: (s) => countUnits(s, 0, "worker") >= 9 &&
                  countBuildings(s, 0, "depot") >= 1 &&
                  countBuildings(s, 0, "barracks") >= 1 &&
                  s.minerals[0] >= 400,
  loseWhen: () => false,           // you can't lose a coffee-break argument
  outro: {
    speaker: "FOREMAN SPROCKET",
    text: "Fine. One coffee. One regulation-sized, thoroughly-earned coffee. Do not tell Rivet.",
  },
};

// ---- a1m2 map: the night-shift scrap yard. A pipeworks maze — rock walls
// carve a chute from a dark seep corner (D) down through a shrub-choked choke
// (C) toward the depot pad (@). Goo waves crawl from D; the choke is where they
// bottleneck. A raised catwalk (level 1) overlooks the yard. --------------------
const MAP_A1M2 = `
....................................................
....................................................
....####################################............
....#..................................#............
....#..MM....@.........#####...........#............
....#.MMM..............#...#....11111...#...........
....#.MMM..............#.C.#....11111...#...........
....#..MM..............#...#....1111....#...........
....#...GG.............#/#/#.....E......#...........
....#...GG.............#...#............#............
....#.................#....#............#...........
....#.........#########....#############.#..........
....#.........#..........................#..........
....#.........#..sss......########.......#..........
....#.........#..sss......#......#...D....#.........
....#.........#...........#......#........#.........
....#######################......##########.........
....................................................
`;

const mission2 = {
  id: "a1m2",
  act: 1,
  title: "Something in the Pipes",
  blurb: "The night-shift scrap keeps vanishing. Sprocket blames gremlins. It is not gremlins.",
  mapSeed: 1002,
  mapOpts: { spawns: "cross", expansions: 0, theme: 0 },
  map: { theme: 0, grid: MAP_A1M2 },
  factions: ["cogs", "ooze"],
  ai: false,                       // waves are hand-scripted, not an AI economy
  introCinematic: "open",
  intro: {
    speaker: "FOREMAN SPROCKET",
    text: "Reserves down AGAIN overnight. Bearing #7, I want defenses. And an explanation.",
  },
  cinematics: {
    open: [
      { fade: { out: true, dur: 0 } },
      { cam: { at: "@", dist: 22, yaw: 0.5, dur: 10 } },
      { fade: { out: false, dur: 700 } },
      { label: { text: "COG DEPOT 7 — NIGHT SHIFT" } },
      { say: { speaker: "FOREMAN SPROCKET", text: "Reserves down again. That's the third night running.", dur: 2600 } },
      { say: { speaker: "BEARING #7", text: "Gremlins, boss? I hear it's gremlins.", dur: 2200 } },
      // slow push toward the dark seep corner — set the dread
      { cam: { at: "D", dist: 20, yaw: 2.1, dur: 3200 } },
      { say: { speaker: "FOREMAN SPROCKET", text: "There are no gremlins. Build defenses. Now.", dur: 2600 } },
      { label: { text: "SOMETHING IN THE PIPES" } },
      { wait: 800 },
    ],
    // Mid-mission: the pile has teeth. Short (~6s), fires with wave 1.
    teeth: [
      { simRun: false },
      { cam: { at: "D", dist: 14, yaw: 2.0, dur: 1400 } },
      { say: { speaker: "BEARING #7", text: "Boss? The scrap pile is... moving.", dur: 2200 } },
      { fx: { kind: "ring", at: "D" } },
      { say: { speaker: "BEARING #7", text: "And it has TEETH.", dur: 1600 } },
      { simRun: true },
    ],
  },
  dialogue: {
    build:   { speaker: "FOREMAN SPROCKET", text: "Build an Assembly, then a Sentry turret. Train some Zappers. Chop chop." },
    ready:   { speaker: "BEARING #7", text: "Turret's humming, boss. Whatever's out there is going to get zapped and I'm THRILLED." },
    ooze1:   { speaker: "FOREMAN SPROCKET", text: "That is not a gremlin. That is GOO. Right-click it to attack. Zap it!" },
    wave2:   { speaker: "FOREMAN SPROCKET", text: "More of it. Sentries fire on their own — huddle your Zappers behind them." },
    wave3:   { speaker: "BEARING #7", text: "It keeps oozing out of the pipes! So THAT'S where the scrap went. It's been EATING." },
    survive: { speaker: "FOREMAN SPROCKET", text: "Hold the line. Reinforcements are... well. WE are the reinforcements. Hold." },
    memo:    { speaker: "FOREMAN SPROCKET", text: "Rivet just filed Form 7-B. 'Standard Shrinkage.' Rivet has never seen shrinkage with a MOUTH." },
    win:     { speaker: "FOREMAN SPROCKET", text: "The goo's retreated. Mystery solved: the scrap isn't stolen. It's dinner. Unacceptable." },
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
    // waves crawl in from the dark seep corner marker 'D' (resolved if maps are
    // live; otherwise fall back to a far map corner). _oozeFrom seeds spawnWave.
    const d = ctx.marker && ctx.marker("D");
    ctx.state._oozeFrom = d || { x: sim.map.w - 6, y: sim.map.h - 6 };
    ctx.state._wavesDone = 0;
    ctx.state._wavesTotal = 4;
  },
  objectives: [
    { id: "sentry", text: "Build a Sentry turret — cover the pipe mouth", check: (s) => countBuildings(s, 0, "turret") >= 1 },
    { id: "zap",    text: "Train 4 Zappers — someone has to do the zapping", check: (s) => countUnits(s, 0, "marine") >= 6 },
    { id: "hold",   text: "Survive 4 waves of whatever THAT is", check: (s, c) => (c?._wavesDone || 0) >= 4 },
  ],
  triggers: [
    { at: 20,  once: true, run: (c) => c.line("build") },
    { when: (s) => countBuildings(s, 0, "turret") >= 1, once: true, run: (c) => c.line("ready") },
    // first wave once the player has had ~30s to set up — with the "teeth" beat
    { at: 320, once: true, run: (c) => { if (c.playCinematic) c.playCinematic("teeth"); } },
    { at: 360, once: true, run: (c) => { c.line("ooze1"); c.spawnWave("nip", 4, 1); } },
    { at: 560, once: true, run: (c) => c.line("memo") },
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

// ---- a1m3 map: the eviction. Player depot pad (@) on a high shelf (level 2)
// to the west. A ramp (/) drops into a lava-scarred pit where the wounded goo
// nest (!) squats among lava (L) and rock. An overlook shelf (marker E) gives
// the reveal shot down into the pit. A choke of forest (F) guards the approach.
const MAP_A1M3 = `
......................................................
......................................................
...##############.....................................
...#............#.....................................
...#..MM..@.....#.....................................
...#.MMM........#.....................................
...#.MMM....2222#.....................................
...#..MM....222/#.....................................
...#...GG...222.#............E.........................
...#...GG.......#......FF..............................
...#............#.....FF...LL....LL....................
...##########.../......L....LLLL...L...................
............#../.......L..LL....LL.LL..................
............#./......LL....!.......L...................
............#./....LL....LLLL...LLL....................
............#/....L....LL....LL....L...................
............#....LL...L.MM.....LL......................
............#.....L..LL.MMM.LLL........................
............#......LL...MM....L........................
............################LL........................
......................................................
`;

const mission3 = {
  id: "a1m3",
  act: 1,
  title: "Repo Men",
  blurb: "The company sends heavy equipment. Time to evict the goo and repossess the neighborhood.",
  mapSeed: 1003,
  mapOpts: { spawns: "cross", expansions: 1, theme: 0 },
  map: { theme: 0, grid: MAP_A1M3 },
  factions: ["cogs", "ooze"],
  aiDifficulty: "easy",            // a real (gentle) opponent from a head start
  introCinematic: "open",
  intro: {
    speaker: "FOREMAN SPROCKET",
    text: "The company shipped us heavy equipment: THUMPERS. We're going door to door. Evict the goo.",
  },
  cinematics: {
    open: [
      { fade: { out: true, dur: 0 } },
      { cam: { at: "@", dist: 24, yaw: 0.6, dur: 10 } },
      { fade: { out: false, dur: 700 } },
      { label: { text: "REPOSSESSION DAY" } },
      { say: { speaker: "FOREMAN SPROCKET", text: "The company sent Thumpers. Big. Loud. Ours.", dur: 2400 } },
      { say: { speaker: "BEARING #7", text: "Do we know where the goo LIVES, boss?", dur: 2200 } },
      // overlook reveal: pan from depot out to the lava pit and the nest
      { cam: { at: "E", dist: 26, yaw: 1.6, dur: 2600 } },
      { wait: 200 },
      { cam: { at: "!", dist: 18, yaw: 1.8, dur: 2400 } },
      { say: { speaker: "BEARING #7", text: "...Oh. It's all bubbly down there. And unlicensed.", dur: 2600 } },
      { say: { speaker: "FOREMAN SPROCKET", text: "Then we repossess. Leave no bubble unpopped.", dur: 2400 } },
      { label: { text: "REPO MEN" } },
      { wait: 800 },
    ],
  },
  dialogue: {
    thumper: { speaker: "FOREMAN SPROCKET", text: "Build a Foundry (needs an Assembly first), then roll out Thumpers. Big. Loud. Ours." },
    scout:   { speaker: "BEARING #7", text: "Thumper's rolling, boss! Feels good. Feels LOUD. Where to?" },
    push:    { speaker: "FOREMAN SPROCKET", text: "The pit. Down the ramp. Flatten every gooey structure and file it as recovered." },
    hurt:    { speaker: "BEARING #7", text: "They're fighting back, boss! Rude. So very rude." },
    memo:    { speaker: "FOREMAN SPROCKET", text: "Rivet upgraded the form. 7-B-Revised: 'Biomass, Aggressive.' He's finally taking this seriously." },
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
    // and pushes from here).
    ctx.woundEnemyBase(1);
  },
  objectives: [
    { id: "foundry", text: "Build a Foundry — Thumpers don't grow on trees", check: (s) => countBuildings(s, 0, "factory") >= 1 },
    { id: "thumper", text: "Roll out a Thumper — big, loud, ours", check: (s) => countUnits(s, 0, "tank") >= 1 },
    { id: "raze",    text: "Pop every bubble — raze the goo nest", check: (s) => countBuildings(s, 1, null, false) === 0 },
  ],
  triggers: [
    { at: 24,  once: true, run: (c) => c.line("thumper") },
    { when: (s) => countUnits(s, 0, "tank") >= 1, once: true, run: (c) => c.line("scout") },
    { when: (s) => countUnits(s, 0, "tank") >= 1, once: true, run: (c) => c.line("push") },
    { at: 700, once: true, run: (c) => c.line("memo") },
    // a little flavor when the enemy has bitten back:
    { at: 1000, once: true, run: (c) => c.line("hurt") },
  ],
  winWhen: (s) => countBuildings(s, 1, null, false) === 0,
  loseWhen: (s) => !hasAnyBuilding(s, 0),
  outro: {
    speaker: "FOREMAN SPROCKET",
    text: "Act one, complete. Depot secure. Goo evicted. But down in the drains, something is still... watching.",
  },
  // end-of-act stinger: teases Act 2 (play AS the ooze) and Act 3 (the Tempest)
  stinger: ["stinger1", "stinger2"],
};

// ===========================================================================
// ACT 2 — THE OOZE
// The perspective flips. You ARE the goo now: a soft-spoken collective that
// only wanted the warm rock back. It speaks in lowercase, first-person plural.
// Politely ominous, secretly homesick. The "monsters" of Act 1 were us.
// ===========================================================================

// ---- a2m1 map: the cold flats where the goo was scraped to. The warm rock
// (marker W) sits mid-map; the Nucleus start (@) is a small damp patch beside
// it with a mineral arc + geyser. A light Cog patrol wanders the north road
// (marker P). Open ground, so creep-spreading is the whole lesson. ------------
const MAP_A2M1 = `
....................................................
....................................................
...##############################################...
...#............................................#...
...#....P..............P........................#...
...#..IIII.........................MM...........#...
...#..IIII.........WW..............MMM..@........#...
...#..III..........WW..............MMM...........#...
...#...............................MM............#...
...#....................ssss.........GG..........#...
...#....................ssss.........GG..........#...
...#.......................................C.....#...
...#..............#####.........................#...
...#..............#...#........sss..............#...
...#..............#.Q.#........sss..............#...
...#..............#####..........................#..
...##############################################...
....................................................
`;

// A tiny helper Act 2 missions use: seed the player as the Ooze faction with a
// bit of starting biomass so the creep lesson has room to breathe.
function oozeStart(ctx, minerals = 250, gas = 0) {
  const { sim } = ctx;
  sim.fog[0].fill(2);
  sim.minerals[0] = minerals;
  sim.gas[0] = gas;
}

const mission4 = {
  id: "a2m1",
  act: 2,
  title: "The Warm Rock",
  blurb: "You are the Ooze now. Spread the Goo, remember the warm rock, and grow a home before the little metal things tidy you away.",
  mapSeed: 2001,
  mapOpts: { spawns: "cross", expansions: 0, theme: 1 },
  map: { theme: 1, grid: MAP_A2M1 },
  factions: ["ooze", "cogs"],
  ai: false,                       // Cog patrols are scripted, not an AI economy
  introCinematic: "open",
  intro: {
    speaker: "THE OOZE",
    text: "we are awake. we are cold. the warm rock is near. we would like it back, please.",
  },
  cinematics: {
    open: [
      { fade: { out: true, dur: 0 } },
      { cam: { at: "W", dist: 30, yaw: 0.3, dur: 10 } },
      { fade: { out: false, dur: 900 } },
      { label: { text: "SOMEWHERE COLD" } },
      { say: { speaker: "THE OOZE", text: "the little metal things scraped us off. we remember.", dur: 2800 } },
      { cam: { at: "@", dist: 20, yaw: 1.0, dur: 2600 } },
      { say: { speaker: "THE OOZE", text: "but we are still here. we spread. we grow. we go home.", dur: 2800 } },
      { label: { text: "THE WARM ROCK" } },
      { wait: 900 },
    ],
    // Mid-mission: a Cog patrol notices the creep and files a memo. ~7s.
    noticed: [
      { simRun: false },
      { cam: { at: "P", dist: 16, yaw: 3.0, dur: 1600 } },
      { say: { speaker: "COG PATROL", text: "Unit 12 to depot: the ground is... green. And squishy. Filing a form.", dur: 2800 } },
      { say: { speaker: "THE OOZE", text: "they count. they always count. we do not count. we only want the warm.", dur: 2800 } },
      { simRun: true },
    ],
  },
  dialogue: {
    spread:  { speaker: "THE OOZE", text: "the goo flows from the nucleus. build only where it is warm. spread first, then grow." },
    vent:    { speaker: "THE OOZE", text: "a goo vent reaches further than we can. plant one. let the warm crawl outward." },
    morph:   { speaker: "THE OOZE", text: "a mote can melt into a den. from the den come nips. small. many. ours." },
    heal:    { speaker: "THE OOZE", text: "on the goo we mend. off it we thin. stay warm and we do not die easily." },
    patrol:  { speaker: "THE OOZE", text: "the metal things walk their little road. do not fear them yet. grow." },
    reclaim: { speaker: "THE OOZE", text: "the warm rock is under goo again. it remembers us. we remember it." },
    win:     { speaker: "THE OOZE", text: "a home. small, but warm. we have not had warm in a long, slow time. thank you." },
  },
  setup(ctx) {
    const { sim } = ctx;
    oozeStart(ctx, 250, 0);
    // strip player 1 to a couple of scripted patrol units near the north road.
    ctx.clearPlayer(1);
    const p = (ctx.marker && ctx.marker("P")) || { x: 10, y: 4 };
    ctx.spawnFor(1, "worker", p.x, p.y);
    ctx.spawnFor(1, "marine", p.x + 1, p.y);
    // remember the warm-rock marker so the reclaim objective can read it
    ctx.state._warm = (ctx.marker && ctx.marker("W")) || { x: 18, y: 6 };
    ctx.state._patrolFrom = p;
  },
  objectives: [
    { id: "spread", text: "Spread the Goo — reclaim 40 tiles of warm ground", check: (s) => gooTiles(s) >= 40 },
    { id: "vent",   text: "Plant a Goo Vent — reach further from the nest", check: (s) => countBuildings(s, 0, "vent") >= 1 },
    { id: "den",    text: "Morph a Den — the nips must come from somewhere", check: (s) => countBuildings(s, 0, "den") >= 1 },
    { id: "nips",   text: "Grow 4 Nips — small, many, ours", check: (s) => countUnits(s, 0, "nip") >= 4 },
  ],
  triggers: [
    { at: 20,  once: true, run: (c) => c.line("spread") },
    { at: 120, once: true, run: (c) => c.line("heal") },
    { when: (s) => gooTiles(s) >= 12, once: true, run: (c) => c.line("vent") },
    { when: (s) => countBuildings(s, 0, "vent") >= 1, once: true, run: (c) => c.line("morph") },
    // Cog patrol notices the creep once it has spread a bit
    { when: (s) => gooTiles(s) >= 24, once: true, run: (c) => { if (c.playCinematic) c.playCinematic("noticed"); else c.line("patrol"); } },
    { when: (s) => gooTiles(s) >= 40, once: true, run: (c) => c.line("reclaim") },
  ],
  winWhen: (s) => gooTiles(s) >= 40 &&
                  countBuildings(s, 0, "vent") >= 1 &&
                  countBuildings(s, 0, "den") >= 1 &&
                  countUnits(s, 0, "nip") >= 4,
  loseWhen: (s) => !hasAnyBuilding(s, 0),   // Nucleus (and all) gone
  outro: {
    speaker: "THE OOZE",
    text: "warm again. we sit. we spread. and far off, the metal things sharpen their forms. let them come.",
  },
};

// ---- a2m2 map: the warren, dug into a rock hollow. The Nucleus (@) sits in a
// bowl (level 1) ringed by rock, one ramp (/) the only way in — the killbox.
// Cog waves stage from the east road (marker S for the siege line, marker E for
// the Thumper's firing position on the ridge). Barbs go on the ramp lip. ------
const MAP_A2M2 = `
......................................................
......................................................
...##################################.................
...#................................#.................
...#...11111111.....................#.................
...#...1......1.....................#.................
...#...1.MM...1.....................#.................
...#...1.MMM.@1.....................#.................
...#...1.MMM..1........sss..........#........E........
...#...1..MM..1........sss..........#.................
...#...1..GG..1.....................#.................
...#...1..GG..1.....................######/#####......
...#...1......1..........................C......S.....
...#...11111/11.....................................#.
...#........./.........................FF...........#.
...#.........#.........................FF...........#.
...#.........###############################........#.
...#................................................#.
...##################################################.
`;

const mission5 = {
  id: "a2m2",
  act: 2,
  title: "They Always Count",
  blurb: "The Cogs filed a form about you. Now they've come to enforce it. Defend the warren from the repossession.",
  mapSeed: 2002,
  mapOpts: { spawns: "cross", expansions: 0, theme: 1 },
  map: { theme: 1, grid: MAP_A2M2 },
  factions: ["ooze", "cogs"],
  ai: false,                       // waves are scripted, culminating in a siege
  introCinematic: "open",
  intro: {
    speaker: "THE OOZE",
    text: "they found the warm ground. they filed a form about it. now they come to enforce the form.",
  },
  cinematics: {
    open: [
      { fade: { out: true, dur: 0 } },
      { cam: { at: "@", dist: 22, yaw: 0.5, dur: 10 } },
      { fade: { out: false, dur: 800 } },
      { label: { text: "THE WARREN" } },
      { say: { speaker: "THE OOZE", text: "one way in. we grew the bowl around us on purpose.", dur: 2600 } },
      { cam: { at: "C", dist: 18, yaw: 2.4, dur: 2400 } },
      { say: { speaker: "THE OOZE", text: "put barbs on the lip. let them come up the ramp, one at a time.", dur: 2800 } },
      { label: { text: "THEY ALWAYS COUNT" } },
      { wait: 800 },
    ],
    // Mid-mission: the Thumper siege beat. A tank crawls onto the ridge and
    // Sprocket's voice leaks in. ~9s. Fires before the final wave.
    siege: [
      { simRun: false },
      { cam: { at: "E", dist: 20, yaw: 1.8, dur: 1800 } },
      { spawn: { pid: 1, type: "tank", at: "E", n: 1, tag: "siegetank" } },
      { say: { speaker: "FOREMAN SPROCKET", text: "Form 12-Q. 'Unscheduled Biomass.' Bring the Thumper. Flatten it.", dur: 3000 } },
      { fx: { kind: "arc", at: "E", to: "@" } },
      { say: { speaker: "THE OOZE", text: "the loud one. we remember the loud one. we do not move. we mend. we hold.", dur: 3000 } },
      { move: { tag: "siegetank", pid: 1, to: "S", attack: true } },
      { simRun: true },
    ],
  },
  dialogue: {
    defend:  { speaker: "THE OOZE", text: "morph barbs on the ramp lip. grow nips behind them. we do not run. we mend and we hold." },
    wave1:   { speaker: "THE OOZE", text: "the first ones come. zappers. they sting. the goo heals what they sting." },
    wave2:   { speaker: "COG PATROL", text: "Depot, the biomass is FIGHTING. It heals. It just... heals. Requesting the big one." },
    heal:    { speaker: "THE OOZE", text: "feed the wounded to the warm ground. it gives them back. this is why we do not fear a long fight." },
    survive: { speaker: "THE OOZE", text: "the loud one anchors on the ridge. hold the ramp. patience is a kind of armor." },
    turn:    { speaker: "THE OOZE", text: "they thin. we do not. this is the shape of every fight we have ever won by simply staying." },
    win:     { speaker: "THE OOZE", text: "they left forms in the dirt. we do not read forms. but we understand: they will keep coming. so. we will go to them first." },
  },
  setup(ctx) {
    const { sim } = ctx;
    oozeStart(ctx, 300, 60);
    ctx.clearPlayer(1);            // no enemy base — Cog waves are scripted
    // waves stage from the east siege line marker 'S'
    const s = (ctx.marker && ctx.marker("S")) || { x: sim.map.w - 6, y: 12 };
    ctx.state._oozeFrom = s;       // reused by spawnWave as the wave origin
    ctx.state._wavesDone = 0;
    ctx.state._wavesTotal = 4;
    // a couple of defenders already loitering at the ramp
    ctx.spawnFor(0, "nip", sim.map.starts[0].x + 2, sim.map.starts[0].y + 3);
    ctx.spawnFor(0, "nip", sim.map.starts[0].x + 3, sim.map.starts[0].y + 3);
  },
  objectives: [
    { id: "barb", text: "Morph a Barb on the ramp — hold the one way in", check: (s) => countBuildings(s, 0, "barb") >= 1 },
    { id: "army", text: "Grow 6 Nips — patience needs numbers", check: (s) => countUnits(s, 0, "nip") >= 6 },
    { id: "hold", text: "Outlast 4 waves, siege and all", check: (s, c) => (c?._wavesDone || 0) >= 4 },
  ],
  triggers: [
    { at: 20,  once: true, run: (c) => c.line("defend") },
    { at: 260, once: true, run: (c) => { c.line("wave1"); c.spawnWave("marine", 4, 1); } },
    { at: 300, once: true, run: (c) => c.line("heal") },
    { at: 560, once: true, run: (c) => { c.line("wave2"); c.spawnWave("marine", 5, 2); } },
    { at: 820, once: true, run: (c) => { c.line("survive"); c.spawnWave("brute", 4, 3); } },
    // the Thumper siege beat, then the final push
    { at: 1060, once: true, run: (c) => { if (c.playCinematic) c.playCinematic("siege"); } },
    { at: 1140, once: true, run: (c) => { c.spawnWave("marine", 6, 4); } },
    { at: 1400, once: true, run: (c) => c.line("turn") },
  ],
  winWhen: (s, c) => (c?._wavesDone || 0) >= 4 && countUnits(s, 1) === 0,
  loseWhen: (s) => !hasAnyBuilding(s, 0),
  outro: {
    speaker: "THE OOZE",
    text: "we will not wait to be flattened again. the warm rock they took has a name in their mouths: depot. we are going home.",
  },
};

// ---- a2m3 map: HOMECOMING. A variant of Act 1 m3's depot pit, seen from the
// goo's side. Our Nucleus (@) sits down in the old lava pit (level 0) where our
// nest was razed; the Cog depot (!) sits up on the high western shelf (level 2)
// behind its ramp — the exact ground we defended, now theirs to lose. The
// overlook marker (E) is where Sprocket first saw us. Callback by design. -----
const MAP_A2M3 = `
......................................................
......................................................
...##############.....................................
...#............#.....................................
...#..MM..!.....#.....................................
...#.MMM........#.....................................
...#.MMM....2222#.....................................
...#..MM....222/#.....................................
...#...GG...222.#............E.........................
...#...GG.......#......ss..............................
...#............#.....ss....LL....LL...................
...##########.../......L....LLLL...L...................
............#../.......L..LL....LL.LL..................
............#./......LL....@.......L...MM..............
............#./....LL....LLLL...LLL....MMM.............
............#/....L....LL....LL....L...MMM.............
............#....LL...L........LL......MM..............
............#.....L..LL.....LLL......GG................
............#......LL.........L......GG................
............################LL........................
......................................................
`;

const mission6 = {
  id: "a2m3",
  act: 2,
  title: "Homecoming",
  blurb: "The depot from Act 1, from below. Take back the warm rock. Sprocket is the voice behind the wall now — and he's scared.",
  mapSeed: 2003,
  mapOpts: { spawns: "cross", expansions: 1, theme: 1 },
  map: { theme: 1, grid: MAP_A2M3 },
  factions: ["ooze", "cogs"],
  aiDifficulty: "easy",            // the Cog depot defends itself (gently)
  introCinematic: "open",
  intro: {
    speaker: "THE OOZE",
    text: "we know this pit. they scraped us out of it. we climbed all the way back. the warm rock is just up the ramp.",
  },
  cinematics: {
    open: [
      { fade: { out: true, dur: 0 } },
      { cam: { at: "@", dist: 26, yaw: 0.4, dur: 10 } },
      { fade: { out: false, dur: 900 } },
      { label: { text: "THE OLD PIT" } },
      { say: { speaker: "THE OOZE", text: "this is where they scraped us out. we remember the ramp.", dur: 2800 } },
      // pan up the ramp to the depot on the shelf — Sprocket's side now
      { cam: { at: "!", dist: 22, yaw: 1.7, dur: 3000 } },
      { say: { speaker: "FOREMAN SPROCKET", text: "Perimeter! The goo's in the pit — the SAME goo. How is it the same goo?", dur: 3000 } },
      { say: { speaker: "THE OOZE", text: "we are always the same goo. up the ramp. take back the warm.", dur: 2800 } },
      { label: { text: "HOMECOMING" } },
      { wait: 900 },
    ],
    // Sprocket's spine moment — fires when the depot is badly hurt. ~8s.
    spine: [
      { simRun: false },
      { cam: { at: "!", dist: 18, yaw: 1.9, dur: 1800 } },
      { say: { speaker: "BEARING #7", text: "Boss, we're losing the pad! Do we... do we file a retreat?", dur: 2600 } },
      { say: { speaker: "FOREMAN SPROCKET", text: "No. No forms. No coffee break. This is our rock and I am DONE deflecting. Hold.", dur: 3200 } },
      { say: { speaker: "THE OOZE", text: "the small one grew a spine. we did not think they had it in them. good. it is warmer, earned.", dur: 3000 } },
      { simRun: true },
    ],
  },
  dialogue: {
    climb:   { speaker: "THE OOZE", text: "grow first. the pit is cold, but the goo will warm it. then up the ramp, all of us, slow." },
    scout:   { speaker: "BEARING #7", text: "Boss! It's climbing the RAMP. The rude bubbly stuff is coming up the ramp!" },
    push:    { speaker: "THE OOZE", text: "the depot sits on our warm rock. we do not hate them. we would just like to lie down. flatten the depot." },
    sprocket:{ speaker: "FOREMAN SPROCKET", text: "Rivet, tear up the forms. Every one. I need Thumpers and I need them NOW." },
    hurt:    { speaker: "FOREMAN SPROCKET", text: "It doesn't STOP. You hit it and the ground gives it back. What ARE you people?" },
    taste:   { speaker: "THE OOZE", text: "we reach the warm middle. it is warm. it is bitter. there is a brown warmth here they called coffee. we understand them a little now." },
    win:     { speaker: "THE OOZE", text: "the depot is quiet. the warm rock is ours. we lie down on it, all of us, at last, and we rest." },
    stinger1:{ speaker: "HERALD", text: "You have been squatting on our battery. All of you. Robot and goo alike." },
    stinger2:{ speaker: "HERALD", text: "We are here to collect. Mind the sparks. The sky opens tomorrow." },
  },
  setup(ctx) {
    const { sim } = ctx;
    sim.fog[0].fill(2);
    sim.minerals[0] = 300;
    sim.gas[0] = 120;
    // The Cog depot on the shelf is the "wounded base" here (mirror of m3):
    // the AI defends it. Uses the shared helper, which reads the enemy faction
    // from sim.factions[1] = "cogs" and lays a battered Hub + support.
    ctx.woundEnemyBase(1);
  },
  objectives: [
    { id: "warm",   text: "Warm the pit — spread 30 tiles of Goo", check: (s) => gooTiles(s) >= 30 },
    { id: "maw",    text: "Morph a Maw — something heavy for the ramp", check: (s) => countUnits(s, 0, "maw") >= 1 },
    { id: "depot",  text: "Flatten the Cog depot — take back the warm rock", check: (s) => countBuildings(s, 1, null, false) === 0 },
  ],
  triggers: [
    { at: 24,  once: true, run: (c) => c.line("climb") },
    { when: (s) => gooTiles(s) >= 30, once: true, run: (c) => c.line("push") },
    { when: (s) => countUnits(s, 0, "maw") >= 1, once: true, run: (c) => c.line("scout") },
    { when: (s) => countUnits(s, 0, "maw") >= 1, once: true, run: (c) => c.line("sprocket") },
    { at: 900, once: true, run: (c) => c.line("hurt") },
    // Sprocket's spine moment once his depot is badly hurt (<=1 building left)
    { when: (s) => countBuildings(s, 1, null, false) <= 1 && countBuildings(s, 1, null, false) >= 1,
      once: true, run: (c) => { if (c.playCinematic) c.playCinematic("spine"); } },
    { when: (s) => countBuildings(s, 1, null, false) === 0, once: true, run: (c) => c.line("taste") },
  ],
  winWhen: (s) => countBuildings(s, 1, null, false) === 0,
  loseWhen: (s) => !hasAnyBuilding(s, 0),
  outro: {
    speaker: "THE OOZE",
    text: "act two, complete. the warm rock is ours. we rest. we do not count the days. and then — the sky begins to speak.",
  },
  // end-of-act stinger: the Tempest arrives for Act 3
  stinger: ["stinger1", "stinger2"],
};

// ===========================================================================
// ACT 3 — THE TEMPEST — locked stub (structure only; not yet playable)
// ===========================================================================

const act3stub = {
  id: "a3m1",
  act: 3,
  title: "Weather Warning",
  blurb: "A Herald of living lightning descends: \"You have been squatting on our battery. We are here to collect. Mind the sparks.\" [Coming soon]",
  stub: true,
};

// ---- act / mission registry ------------------------------------------------

export const ACTS = [
  { act: 1, title: "Act I — The Cogs",  subtitle: "A tin-robot depot, a vanishing quota, and a scrap pile with teeth." },
  { act: 2, title: "Act II — The Ooze", subtitle: "The other side of the slime. All we wanted was the warm rock back." },
  { act: 3, title: "Act III — The Tempest", subtitle: "The sky comes to collect its battery." },
];

// Ordered mission list. Order defines unlock progression (a mission unlocks
// once the PREVIOUS non-stub mission is completed).
export const MISSIONS = [
  mission1, mission2, mission3,       // Act 1 — The Cogs
  mission4, mission5, mission6,       // Act 2 — The Ooze
  act3stub,                           // Act 3 — stub
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
