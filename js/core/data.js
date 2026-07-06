// All game balance data. Times are in sim ticks (10/sec), distances in fp
// units (256 = 1 tile), speeds in fp per tick.
import { FP } from "./fixed.js";

export const TICK_MS = 100;          // 10 sim ticks per second
export const MAP_W = 56;             // tiles (procedural maps; <=64, fp-safe)
export const MAP_H = 56;

export const START_MINERALS = 50;
export const START_GAS = 0;
export const CARRY_AMOUNT = 8;       // minerals per worker trip
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
    name: "Worker", cost: 50, gasCost: 0, supply: 1, hp: 45, speed: 68,
    dmg: 4, dmgAir: 0, range: (FP * 0.7) | 0, acquire: 0, cooldown: 10,
    sight: 7, buildTime: 80, radius: (FP * 0.34) | 0,
  },
  marine: {
    name: "Marine", cost: 50, gasCost: 0, supply: 1, hp: 55, speed: 62,
    dmg: 6, dmgAir: 6, range: (FP * 4.5) | 0, acquire: (FP * 7) | 0, cooldown: 9,
    sight: 8, buildTime: 100, radius: (FP * 0.36) | 0,
  },
  brute: {
    name: "Brute", cost: 90, gasCost: 0, supply: 2, hp: 120, speed: 54,
    dmg: 12, dmgAir: 0, range: (FP * 0.9) | 0, acquire: (FP * 6) | 0, cooldown: 11,
    sight: 7, buildTime: 140, radius: (FP * 0.46) | 0,
  },
  // Siege tank: heavy ground damage, no air weapon.
  tank: {
    name: "Siege Tank", cost: 150, gasCost: 75, supply: 3, hp: 180, speed: 40,
    dmg: 22, dmgAir: 0, range: (FP * 6) | 0, acquire: (FP * 8) | 0, cooldown: 18,
    sight: 8, buildTime: 220, radius: (FP * 0.55) | 0,
  },
  // Wraith: fast flyer, weak but hits both ground and air.
  wraith: {
    name: "Wraith", cost: 125, gasCost: 75, supply: 2, hp: 95, speed: 85,
    dmg: 7, dmgAir: 14, range: (FP * 4.5) | 0, acquire: (FP * 9) | 0, cooldown: 10,
    sight: 9, buildTime: 180, radius: (FP * 0.4) | 0, fly: true,
  },
  // Banshee: flyer, heavy ground damage, cannot hit air.
  banshee: {
    name: "Banshee", cost: 150, gasCost: 100, supply: 3, hp: 115, speed: 70,
    dmg: 18, dmgAir: 0, range: (FP * 4) | 0, acquire: (FP * 8) | 0, cooldown: 12,
    sight: 8, buildTime: 220, radius: (FP * 0.44) | 0, fly: true,
  },
};

export const BUILDINGS = {
  hq: {
    name: "Command Post", cost: 400, gasCost: 0, hp: 1200, size: 3, supply: 10,
    buildTime: 500, sight: 9, trains: ["worker"], deposit: true,
  },
  depot: {
    name: "Supply Depot", cost: 100, gasCost: 0, hp: 450, size: 2, supply: 8,
    buildTime: 180, sight: 6, trains: [],
  },
  barracks: {
    name: "Barracks", cost: 150, gasCost: 0, hp: 750, size: 3, supply: 0,
    buildTime: 300, sight: 7, trains: ["marine", "brute"],
  },
  // Refinery: built over a geyser; enables gas harvest. No deposit, low sight.
  refinery: {
    name: "Refinery", cost: 75, gasCost: 0, hp: 400, size: 2, supply: 0,
    buildTime: 180, sight: 4, trains: [], deposit: false, onGeyser: true,
  },
  // Factory: unlocks tanks; needs a barracks first.
  factory: {
    name: "Factory", cost: 150, gasCost: 100, hp: 900, size: 3, supply: 0,
    buildTime: 350, sight: 7, trains: ["tank"], requires: "barracks",
  },
  // Starport: unlocks air; needs a factory first.
  starport: {
    name: "Starport", cost: 150, gasCost: 125, hp: 850, size: 3, supply: 0,
    buildTime: 350, sight: 7, trains: ["wraith", "banshee"], requires: "factory",
  },
  // Turret: static anti-ground/anti-air defense; needs a barracks first.
  turret: {
    name: "Turret", cost: 100, gasCost: 0, hp: 350, size: 2, supply: 0,
    buildTime: 200, sight: 7, trains: [], requires: "barracks",
    armed: true, dmg: 8, dmgAir: 16, range: (FP * 5.5) | 0, cooldown: 9,
  },
};

// ---------- upgrades (researched at buildings, global per player) ----------
// sim.upgrades[pid] is a bitmask of these bits. Each upgrade is researched once.
export const UPGRADE_BITS = {
  stims: 1, plating: 2, siegetech: 4, servos: 8, afterburners: 16,
};

// Research definitions. `building` is the structure whose production queue the
// research shares; cost is deducted at queue time like a unit.
export const UPGRADES = {
  stims:       { name: "Stim Pack",     building: "barracks", cost: 100, gasCost: 50,  time: 300, bit: 1 },
  plating:     { name: "Combat Plating", building: "barracks", cost: 125, gasCost: 75,  time: 350, bit: 2 },
  siegetech:   { name: "Siege Tech",    building: "factory",  cost: 150, gasCost: 100, time: 400, bit: 4 },
  servos:      { name: "Servo Motors",  building: "factory",  cost: 100, gasCost: 100, time: 300, bit: 8 },
  afterburners:{ name: "Afterburners",  building: "starport", cost: 100, gasCost: 100, time: 300, bit: 16 },
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
    name: "Stim Pack", unit: "marine", requires: "stims", targeted: false,
    cd: 120, hpCost: 8, dur: 80, spdNum: 14, spdDen: 10, cdNum: 6, cdDen: 10,
  },
  leap: {
    name: "Leap", unit: "brute", requires: null, targeted: true,
    cd: 150, range: 4, dur: 6, dmg: 10, splash: 1, // range/splash in tiles
  },
  siege: {
    name: "Siege Mode", unit: "tank", requires: "siegetech", targeted: false, toggle: true,
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
};

export const PLAYER_COLORS = ["#4cc2ff", "#ff5f4c"];
export const MAX_QUEUE = 5;
