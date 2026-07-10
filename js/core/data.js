// All game balance data. Times are in sim ticks (10/sec), distances in fp
// units (256 = 1 tile), speeds in fp per tick.
import { FP } from "./fixed.js";

export const TICK_MS = 100;          // 10 sim ticks per second
export const MAP_W = 56;             // tiles (procedural maps; <=64, fp-safe)
export const MAP_H = 56;

export const START_MINERALS = 50;
export const START_GAS = 0;
export const CARRY_AMOUNT = 8;       // minerals per worker trip
export const GOLD_PATCH_AMOUNT = 1000; // rich contested patches: smaller pool...
export const GOLD_CARRY_BONUS = 4;     // ...but +4 per trip (12 vs 8)
export const GATHER_TICKS = 18;      // time spent mining at a patch
export const PATCH_AMOUNT = 1500;

// A deposit building (Command Post) may not be planted right on the mineral
// line: its footprint CENTER must be at least this many tiles (center-to-
// center) from every mineral patch and geyser. Keeps mining from being
// trivially over-efficient. Refineries are exempt (they sit ON a geyser).
export const HQ_RESOURCE_CLEARANCE = 4;

// Vespene gas economy. A refinery built over a geyser lets workers harvest gas
// on a mineral-like cycle. Depleted geysers still trickle a little (SC-style).
export const GAS_CARRY = 4;          // gas per worker trip
export const GAS_GATHER_TICKS = 22;  // time spent harvesting at a refinery
export const GAS_AMOUNT = 2500;      // gas in a fresh geyser
export const GAS_DEPLETED = 2;       // gas yielded once a geyser hits 0

export const UNITS = {
  worker: {
    name: "Bearing", isWorker: true, cost: 50, gasCost: 0, supply: 1, hp: 45, speed: 68,
    dmg: 4, dmgAir: 0, range: (FP * 0.7) | 0, acquire: 0, cooldown: 10,
    sight: 7, buildTime: 80, radius: (FP * 0.34) | 0,
  },
  marine: {
    name: "Zapper", cost: 50, gasCost: 0, supply: 1, hp: 55, speed: 62,
    dmg: 6, dmgAir: 6, range: (FP * 4.5) | 0, acquire: (FP * 7) | 0, cooldown: 9,
    sight: 8, buildTime: 100, radius: (FP * 0.36) | 0,
  },
  brute: {
    name: "Clank", cost: 90, gasCost: 0, supply: 2, hp: 120, speed: 54,
    dmg: 12, dmgAir: 0, range: (FP * 0.9) | 0, acquire: (FP * 6) | 0, cooldown: 11,
    sight: 7, buildTime: 140, radius: (FP * 0.46) | 0,
  },
  // Siege tank: heavy ground damage, no air weapon.
  tank: {
    name: "Thumper", cost: 150, gasCost: 75, supply: 3, hp: 180, speed: 40,
    dmg: 22, dmgAir: 0, range: (FP * 6) | 0, acquire: (FP * 8) | 0, cooldown: 18,
    sight: 8, buildTime: 220, radius: (FP * 0.55) | 0,
  },
  // Wraith: fast flyer, weak but hits both ground and air.
  wraith: {
    name: "Dart", cost: 125, gasCost: 75, supply: 2, hp: 95, speed: 85,
    dmg: 7, dmgAir: 14, range: (FP * 4.5) | 0, acquire: (FP * 9) | 0, cooldown: 10,
    sight: 9, buildTime: 180, radius: (FP * 0.4) | 0, fly: true,
  },
  // Banshee: flyer, heavy ground damage, cannot hit air.
  banshee: {
    name: "Rumble", cost: 150, gasCost: 100, supply: 3, hp: 115, speed: 70,
    dmg: 18, dmgAir: 0, range: (FP * 4) | 0, acquire: (FP * 8) | 0, cooldown: 12,
    sight: 8, buildTime: 220, radius: (FP * 0.44) | 0, fly: true,
  },
};

export const BUILDINGS = {
  hq: {
    name: "Hub", cost: 400, gasCost: 0, hp: 1200, size: 3, supply: 10,
    buildTime: 500, sight: 9, trains: ["worker"], deposit: true,
  },
  depot: {
    name: "Battery", cost: 100, gasCost: 0, hp: 450, size: 2, supply: 8,
    buildTime: 180, sight: 6, trains: [],
  },
  barracks: {
    name: "Assembly", cost: 150, gasCost: 0, hp: 750, size: 3, supply: 0,
    buildTime: 300, sight: 7, trains: ["marine", "brute"],
  },
  // Refinery: built over a geyser; enables gas harvest. No deposit, low sight.
  refinery: {
    name: "Pumpjack", cost: 75, gasCost: 0, hp: 400, size: 2, supply: 0,
    buildTime: 180, sight: 4, trains: [], deposit: false, onGeyser: true,
  },
  // Factory: unlocks tanks; needs a barracks first.
  factory: {
    name: "Foundry", cost: 150, gasCost: 100, hp: 900, size: 3, supply: 0,
    buildTime: 350, sight: 7, trains: ["tank"], requires: "barracks",
  },
  // Starport: unlocks air; needs a factory first.
  starport: {
    name: "Hangar", cost: 150, gasCost: 125, hp: 850, size: 3, supply: 0,
    buildTime: 350, sight: 7, trains: ["wraith", "banshee"], requires: "factory",
  },
  // Turret: static anti-ground/anti-air defense; needs a barracks first.
  turret: {
    name: "Sentry", cost: 100, gasCost: 0, hp: 350, size: 2, supply: 0,
    buildTime: 200, sight: 7, trains: [], requires: "barracks",
    armed: true, dmg: 8, dmgAir: 16, range: (FP * 5.5) | 0, cooldown: 9,
  },
};

// ---------- upgrades (researched at buildings, global per player) ----------
// sim.upgrades[pid] is a bitmask of these bits. Each upgrade is researched once.
export const UPGRADE_BITS = {
  stims: 1, plating: 2, siegetech: 4, servos: 8, afterburners: 16,
  carapace: 32, adrenal: 64, burrowtech: 128, membrane: 256,
};

// Research definitions. `building` is the structure whose production queue the
// research shares; cost is deducted at queue time like a unit.
export const UPGRADES = {
  stims:       { name: "Overclock",     building: "barracks", cost: 100, gasCost: 50,  time: 300, bit: 1 },
  plating:     { name: "Tin Plating",   building: "barracks", cost: 125, gasCost: 75,  time: 350, bit: 2 },
  siegetech:   { name: "Anchor Tech",   building: "factory",  cost: 150, gasCost: 100, time: 400, bit: 4 },
  servos:      { name: "Servo Motors",  building: "factory",  cost: 100, gasCost: 100, time: 300, bit: 8 },
  afterburners:{ name: "Afterburners",  building: "starport", cost: 100, gasCost: 100, time: 300, bit: 16 },
  // Ooze upgrades
  carapace:    { name: "Carapace",      building: "den",      cost: 150, gasCost: 100, time: 350, bit: 32 },
  adrenal:     { name: "Adrenal",       building: "den",      cost: 100, gasCost: 100, time: 300, bit: 64 },
  burrowtech:  { name: "Burrow Tech",   building: "warren",   cost: 100, gasCost: 100, time: 300, bit: 128 },
  membrane:    { name: "Membrane",      building: "roost",    cost: 100, gasCost: 100, time: 300, bit: 256 },
};

// Retroactive plating buff applied to living + future marines/brutes.
export const PLATING_HP = 12;
// Tank speed multiplier from servos (numerator/denominator, integer math).
export const SERVOS_SPEED_NUM = 13, SERVOS_SPEED_DEN = 10;

// ---------- abilities (per-unit, command-driven) ----------
// Multipliers are numerator/denominator pairs so speed/cooldown math stays
// integer-only and deterministic.
export const ABILITIES = {
  stim: {
    name: "Overclock", unit: "marine", requires: "stims", targeted: false,
    cd: 120, hpCost: 8, dur: 80, spdNum: 14, spdDen: 10, cdNum: 6, cdDen: 10,
  },
  leap: {
    name: "Leap", unit: "brute", requires: null, targeted: true,
    cd: 150, range: 4, dur: 6, dmg: 10, splash: 1, // range/splash in tiles
  },
  siege: {
    name: "Anchor Mode", unit: "tank", requires: "siegetech", targeted: false, toggle: true,
    cd: 0, transform: 20, range: 9, dmg: 30, minRange: 25, // minRange in tenths of a tile (2.5)
    splash: 1, splashDmg: 15, cooldown: 24,
  },
  burners: {
    name: "Afterburners", unit: "wraith", requires: "afterburners", targeted: false,
    cd: 150, dur: 40, spdNum: 18, spdDen: 10,
  },
  barrage: {
    name: "Rocket Barrage", unit: "banshee", requires: null, targeted: true,
    cd: 200, range: 6, channel: 15, rockets: 5, interval: 3, dmg: 8, radius: 192, // radius fp (0.75 tile)
  },
  // Ooze abilities
  burrow: {
    name: "Burrow", unit: "sluice", requires: "burrowtech", targeted: false, toggle: true,
    cd: 0, transform: 20, range: 7, dmg: 20, minRange: 25, // minRange in tenths (2.5 tiles)
    splash: 1, splashDmg: 10, cooldown: 20,
  },
  engulf: {
    name: "Engulf", unit: "maw", requires: null, targeted: true,
    cd: 120, range: 3, dur: 5, dmg: 14, splash: 1,
  },
};

export const PLAYER_COLORS = ["#4cc2ff", "#ff5f4c"];
export const MAX_QUEUE = 5;

// Goo-field constants (Ooze faction). The gooGrid grows tile-by-tile from
// Nucleus and Goo Vent sources and crumbles back when they die. Ticks are
// 100ms real-time, so 10 ticks = 1s.
export const GOO_GROW_INTERVAL = 10;       // frontier growth pass every 10 ticks
export const GOO_RECEDE_INTERVAL = 5;      // unsupported-edge decay pass every 5 ticks
export const GOO_MAX_RADIUS = 10;          // BFS depth cap: tiles from source footprint
// The goo dice: a fixed list of "random" bytes both lockstep peers step
// through in the same order (cursor lives in sim state and is checksummed).
// Deliberately dumb — no PRNG, just numbers — so goo growth is trivially
// deterministic and auditable.
export const GOO_NOISE = Uint8Array.from([
  183,  42, 219,  91, 137,  12, 250,  68, 201,  33, 174, 226,  57, 148,   5, 239,
   96, 210,  27, 163,  78, 244, 119,  49, 192,   8, 231, 104, 156,  71, 217,  36,
  128, 253,  61, 179,  22, 145, 236,  87, 199,  14, 110, 168,  44, 222,  99, 187,
    3, 133, 246,  53, 205,  75, 160,  30, 228, 116,  84, 194,  18, 141, 251,  65,
]);
export const GOO_SPEED_NUM = 6, GOO_SPEED_DEN = 5;  // ×1.2 speed on Goo
export const REGEN_DELAY = 30;             // 3s before regen starts after damage
export const REGEN_RATE = 1;               // HP per tick on Goo
export const REGEN_RATE_OFF = 0.5;         // HP per 2 ticks off Goo (integer: 1/2)

// ===========================================================================
// THE OOZE (Phase 3) — see docs/DESIGN.md S8. Same flat registries, unique type
// Carapace HP bonus per unit type (Ooze faction). Applied retroactively and
// on spawn, same as Cog's Tin Plating.
export const CARAPACE_HP = { nip: 12, spit: 12, sluice: 12, maw: 16 };
// all implemented in sim.js. Type
// keys never collide with Cog keys, so the sim's spawn/combat/tech code is
// unchanged — it still looks up UNITS[type] / BUILDINGS[type].
// ===========================================================================
Object.assign(UNITS, {
  mote: {
    name: "Mote", faction: "ooze", isWorker: true, cost: 50, gasCost: 0, supply: 1, hp: 40, speed: 66,
    dmg: 3, dmgAir: 0, range: (FP * 0.7) | 0, acquire: 0, cooldown: 10,
    sight: 7, buildTime: 80, radius: (FP * 0.34) | 0,
  },
  nip: {
    name: "Nip", faction: "ooze", cost: 40, gasCost: 0, supply: 1, hp: 40, speed: 74,
    dmg: 5, dmgAir: 0, range: (FP * 0.9) | 0, acquire: (FP * 6) | 0, cooldown: 8,
    sight: 7, buildTime: 80, radius: (FP * 0.36) | 0,
  },
  spit: {
    name: "Spit", faction: "ooze", cost: 65, gasCost: 0, supply: 1, hp: 45, speed: 60,
    dmg: 5, dmgAir: 7, range: (FP * 4.2) | 0, acquire: (FP * 7) | 0, cooldown: 10,
    sight: 8, buildTime: 110, radius: (FP * 0.36) | 0,
  },
  maw: {
    name: "Maw", faction: "ooze", cost: 100, gasCost: 25, supply: 3, hp: 160, speed: 52,
    dmg: 17, dmgAir: 0, range: (FP * 0.9) | 0, acquire: (FP * 6) | 0, cooldown: 12,
    sight: 7, buildTime: 160, radius: (FP * 0.5) | 0,
  },
  // Increment A: ranged siege-ish unit. Increment B adds the Burrow toggle
  // (stationary acid-mortar with minRange + splash, the true anchor role).
  sluice: {
    name: "Sluice", faction: "ooze", cost: 150, gasCost: 50, supply: 3, hp: 130, speed: 42,
    dmg: 18, dmgAir: 0, range: (FP * 5.5) | 0, acquire: (FP * 8) | 0, cooldown: 16,
    sight: 8, buildTime: 220, radius: (FP * 0.55) | 0,
  },
  wisp: {
    name: "Wisp", faction: "ooze", cost: 110, gasCost: 50, supply: 2, hp: 90, speed: 78,
    dmg: 8, dmgAir: 8, range: (FP * 4) | 0, acquire: (FP * 8) | 0, cooldown: 11,
    sight: 9, buildTime: 170, radius: (FP * 0.4) | 0, fly: true,
  },
});
Object.assign(BUILDINGS, {
  nucleus: {
    name: "Nucleus", faction: "ooze", cost: 400, gasCost: 0, hp: 1100, size: 3, supply: 10,
    buildTime: 500, sight: 9, trains: ["mote"], deposit: true, gooOozes: true,
  },
  pod: {
    name: "Pod", faction: "ooze", cost: 100, gasCost: 0, hp: 450, size: 2, supply: 8,
    buildTime: 180, sight: 6, trains: [],
  },
  vent: {
    name: "Goo Vent", faction: "ooze", cost: 75, gasCost: 0, hp: 350, size: 2, supply: 0,
    buildTime: 160, sight: 6, trains: [], gooOozes: true,
  },
  den: {
    name: "Den", faction: "ooze", cost: 150, gasCost: 0, hp: 750, size: 3, supply: 0,
    buildTime: 300, sight: 7, trains: ["nip", "spit"],
  },
  sump: {
    name: "Sump", faction: "ooze", cost: 75, gasCost: 0, hp: 400, size: 2, supply: 0,
    buildTime: 180, sight: 4, trains: [], deposit: false, onGeyser: true,
  },
  warren: {
    name: "Warren", faction: "ooze", cost: 150, gasCost: 100, hp: 900, size: 3, supply: 0,
    buildTime: 350, sight: 7, trains: ["maw", "sluice"], requires: "den",
  },
  roost: {
    name: "Roost", faction: "ooze", cost: 150, gasCost: 125, hp: 850, size: 3, supply: 0,
    buildTime: 350, sight: 7, trains: ["wisp"], requires: "warren",
  },
  barb: {
    name: "Barb", faction: "ooze", cost: 100, gasCost: 0, hp: 350, size: 2, supply: 0,
    buildTime: 200, sight: 7, trains: [], requires: "den",
    armed: true, dmg: 8, dmgAir: 16, range: (FP * 5.5) | 0, cooldown: 9,
  },
});

// ---------- factions ----------
// Per-faction metadata: the start building, the worker type, and the worker's
// build list (what it can construct — replaces the old hardcoded order array in
// hud.js). Order maps to command-card grid keys, so keep it deliberate.
export const FACTIONS = {
  cogs: {
    name: "The Cogs", blurb: "Industrious robots. Build, repair, out-tech.",
    worker: "worker", start: "hq",
    build: ["depot", "barracks", "refinery", "hq", "factory", "starport", "turret"],
  },
  ooze: {
    name: "The Ooze", blurb: "Gooey swarm. Cheap, self-healing, morphing.",
    worker: "mote", start: "nucleus",
    build: ["pod", "den", "vent", "sump", "warren", "roost", "barb", "nucleus"],
  },
};

// Tag every entry that didn't declare a faction as a Cog (keeps the sim able to
// answer "what faction is this type?" without touching each Cog definition).
for (const reg of [UNITS, BUILDINGS, ABILITIES, UPGRADES])
  for (const k in reg) if (!reg[k].faction) reg[k].faction = "cogs";
