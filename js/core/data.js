// All game balance data. Times are in sim ticks (10/sec), distances in fp
// units (256 = 1 tile), speeds in fp per tick.
import { FP } from "./fixed.js";

export const TICK_MS = 100;          // 10 sim ticks per second
export const MAP_W = 56;             // tiles (procedural maps; <=64, fp-safe)
export const MAP_H = 56;

export const START_MINERALS = 50;
export const CARRY_AMOUNT = 8;       // minerals per worker trip
export const GATHER_TICKS = 18;      // time spent mining at a patch
export const PATCH_AMOUNT = 1500;

export const UNITS = {
  worker: {
    name: "Worker", cost: 50, supply: 1, hp: 45, speed: 68,
    dmg: 4, range: (FP * 0.7) | 0, acquire: 0, cooldown: 10,
    sight: 7, buildTime: 80, radius: (FP * 0.34) | 0,
  },
  marine: {
    name: "Marine", cost: 50, supply: 1, hp: 55, speed: 62,
    dmg: 6, range: (FP * 4.5) | 0, acquire: (FP * 7) | 0, cooldown: 9,
    sight: 8, buildTime: 100, radius: (FP * 0.36) | 0,
  },
  brute: {
    name: "Brute", cost: 90, supply: 2, hp: 120, speed: 54,
    dmg: 12, range: (FP * 0.9) | 0, acquire: (FP * 6) | 0, cooldown: 11,
    sight: 7, buildTime: 140, radius: (FP * 0.46) | 0,
  },
};

export const BUILDINGS = {
  hq: {
    name: "Command Post", cost: 400, hp: 1200, size: 3, supply: 10,
    buildTime: 500, sight: 9, trains: ["worker"], deposit: true,
  },
  depot: {
    name: "Supply Depot", cost: 100, hp: 450, size: 2, supply: 8,
    buildTime: 180, sight: 6, trains: [],
  },
  barracks: {
    name: "Barracks", cost: 150, hp: 750, size: 3, supply: 0,
    buildTime: 300, sight: 7, trains: ["marine", "brute"],
  },
};

export const HOTKEYS = {
  worker: "q", marine: "q", brute: "w",
  depot: "z", barracks: "x", hq: "c",
};

export const PLAYER_COLORS = ["#4cc2ff", "#ff5f4c"];
export const MAX_QUEUE = 5;
