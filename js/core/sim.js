// The deterministic simulation. All state lives here; all mutation happens in
// step(). Integer math only — see fixed.js. The renderer reads this state but
// never writes it; players interact exclusively through commands, which is
// what makes lockstep multiplayer possible.
import { FP, HALF, tileToFp, fpToTile, isqrt, dist, dist2, makeHash } from "./fixed.js";
import { UNITS, BUILDINGS, FACTIONS, START_MINERALS, START_GAS, CARRY_AMOUNT, GATHER_TICKS, PATCH_AMOUNT, MAX_QUEUE,
  GAS_CARRY, GAS_GATHER_TICKS, GAS_AMOUNT, GAS_DEPLETED, HQ_RESOURCE_CLEARANCE,
  UPGRADES, UPGRADE_BITS, ABILITIES, PLATING_HP, SERVOS_SPEED_NUM, SERVOS_SPEED_DEN,
  GOO_GROW_INTERVAL, GOO_RECEDE_INTERVAL, GOO_NOISE, GOO_MAX_RADIUS, GOO_SPEED_NUM, GOO_SPEED_DEN,
  REGEN_DELAY, REGEN_RATE, REGEN_RATE_OFF, CARAPACE_HP } from "./data.js";
import { generateMap } from "./map.js";
import { findPath, nearestFree } from "./path.js";

// Is this unit type a worker (gathers + builds)? Flagged per-faction in data.js
// so the Cog Bearing and the Ooze Mote both count without hardcoding type names.
const isWorker = (t) => !!(UNITS[t] && UNITS[t].isWorker);
// Is this building type a gas harvester (Cog Refinery / Ooze Sump)? Both sit on
// a geyser (onGeyser) and let workers harvest Oil.
const isGasBuilding = (t) => !!(BUILDINGS[t] && BUILDINGS[t].onGeyser);

export class Sim {
  constructor(seed, opts) {
    this.seed = seed;
    this.map = generateMap(seed, opts);
    this.tick = 0;
    this.nextId = 1;
    this.entities = [];
    this.byId = new Map();
    this.minerals = [START_MINERALS, START_MINERALS];
    this.gas = [START_GAS, START_GAS];
    // researched-upgrade bitmasks, one per player (see UPGRADE_BITS in data.js)
    this.upgrades = [0, 0];
    this.winner = -1;
    this.events = [];

    const { w, h } = this.map;
    // pathing grid: rocks + building footprints
    this.blocked = new Uint8Array(this.map.rock);
    // fog per player: 1 explored (grey), 2 visible. The whole map starts
    // explored — terrain is revealed, only current activity is hidden.
    // (0 = unseen black is reserved for future campaign maps.)
    this.fog = [new Uint8Array(w * h).fill(1), new Uint8Array(w * h).fill(1)];

    // Goo field: Ooze creep grid. 0 = no goo, 1 = goo. Spreads from Nucleus
    // and Goo Vent sources (buildings with gooOozes: true). Ooze ground units
    // get +speed and +regen on Goo; Ooze buildings require Goo underneath
    // (except the sources themselves).
    this.gooGrid = new Uint8Array(w * h);
    // Live goo sources: [{id}] of finished gooOozes buildings. Goo grows
    // tile-by-tile from tiles BFS-connected to a source (up to GOO_MAX_RADIUS)
    // and crumbles back where that support is lost.
    this._gooSources = [];
    // Cursor into the GOO_NOISE dice list. Sim state: mixed into checksum()
    // so any consumption drift between lockstep peers is caught immediately.
    this.gooNoiseI = 0;
    // Scratch: per-tile BFS distance-from-source (0 = unsupported). Derived
    // from gooGrid + sources each pass, so NOT part of the checksum.
    this._gooSupport = new Uint8Array(w * h);
    // Bumped whenever any goo tile changes — lets the renderer repaint the
    // creep canvas only when needed. Presentation-facing, not checksummed.
    this.gooVersion = 0;

    for (const m of this.map.minerals) {
      this.addEntity({ type: "mineral", owner: -1, x: m.x, y: m.y, hp: 0, maxHp: 0, amount: PATCH_AMOUNT, radius: (FP * 0.4) | 0 });
    }
    // Vespene geysers: non-blocking resource nodes. Placed at fp tile centers.
    // (map.js may not emit geysers yet — code defensively.)
    for (const g of (this.map.geysers || [])) {
      this.addEntity({ type: "geyser", owner: -1, x: g.x, y: g.y, hp: 0, maxHp: 0, amount: GAS_AMOUNT, radius: (FP * 0.45) | 0, geyser: true });
    }
    // Per-player faction (default both Cogs). Picks each player's start building
    // + worker type; static per game, so it doesn't enter the per-tick checksum.
    this.factions = (opts && opts.factions) || ["cogs", "cogs"];
    for (let pid = 0; pid < 2; pid++) {
      const fac = FACTIONS[this.factions[pid]] || FACTIONS.cogs;
      const s = this.map.starts[pid];
      this.spawnBuilding(pid, fac.start, s.x - 1, s.y - 1, true);
      for (let i = 0; i < 5; i++) {
        const u = this.spawnUnit(pid, fac.worker, tileToFp(s.x + 2 + (i % 3)), tileToFp(s.y + 2 + ((i / 3) | 0)));
        this.autoGather(u);
      }
    }
    // Initialize goo sources from start buildings. Ooze players start with a
    // Nucleus (gooOozes: true) whose seed stamp gives them enough goo from
    // tick 0 to place their first buildings (Pod, Den, etc.).
    for (const e of this.entities) {
      if (e.building && e.done && BUILDINGS[e.type]?.gooOozes) {
        e.gooStamped = 1;
        this._gooSources.push({ id: e.id });
        this.stampGooSeed(e);
      }
    }
    this.updateFog();
  }

  // ---------- entity helpers ----------

  addEntity(e) {
    e.id = this.nextId++;
    e.px = e.x; e.py = e.y;      // previous-tick position, for render interpolation
    this.entities.push(e);
    this.byId.set(e.id, e);
    return e;
  }

  spawnUnit(pid, type, x, y) {
    const d = UNITS[type];
    const e = this.addEntity({
      type, owner: pid, x, y, hp: d.hp, maxHp: d.hp, radius: d.radius,
      unit: true, fly: !!d.fly, order: { kind: "idle" }, next: [], path: null, pathI: 0,
      cooldown: 0, carry: 0, carryKind: 0, gatherTimer: 0,
      // anti-stuck: ticks of no progress toward the current waypoint, the last
      // measured distance to it, and which waypoint index that distance was for.
      noProg: 0, wpDist: 0, wpI: -1,
      // ability state (all sim-visible, mixed into checksum):
      abilityCd: 0,        // ticks until this unit's ability is ready again
      stimUntil: 0,        // marine: stim buff active while tick < stimUntil
      burnUntil: 0,        // wraith: afterburner buff active while tick < burnUntil
      sieged: 0,           // tank: 1 while in siege mode
      burrowed: 0,         // sluice: 1 while burrowed (mortar mode)
      transformUntil: 0,   // tank: transforming (immobile) while tick < transformUntil
      leapUntil: 0,        // brute: leaping (airborne) while tick < leapUntil
      leapTo: null,        // brute: landing point {x,y}
      channelUntil: 0,     // banshee: barrage channel end tick
      channel: null,       // banshee: barrage state {x,y,fired}
      // Ooze regen: last tick this unit took damage (0 = never). Used to
      // gate regeneration (only heals after REGEN_DELAY ticks without dmg).
      lastDmg: 0,
    });
    // FUTURE-unit plating: marines/brutes built after plating completes get +12 maxHp.
    if ((type === "marine" || type === "brute") && (this.upgrades[pid] & UPGRADE_BITS.plating)) {
      e.maxHp += PLATING_HP;
      e.hp += PLATING_HP;
    }
    // Ooze Carapace: units built after carapace completes get bonus HP
    const carapaceHp = CARAPACE_HP[type];
    if (carapaceHp && (this.upgrades[pid] & UPGRADE_BITS.carapace)) {
      e.maxHp += carapaceHp;
      e.hp += carapaceHp;
    }
    return e;
  }

  spawnBuilding(pid, type, tx, ty, done) {
    const d = BUILDINGS[type];
    const b = this.addEntity({
      type, owner: pid, tx, ty, size: d.size,
      x: tx * FP + (d.size * FP >> 1), y: ty * FP + (d.size * FP >> 1),
      hp: done ? d.hp : Math.max(1, (d.hp / 10) | 0), maxHp: d.hp,
      building: true, done: !!done, progress: done ? d.buildTime : 0,
      queue: [], radius: (d.size * FP >> 1),
      cooldown: 0, geyserId: 0,
    });
    this.setFootprint(b, 1);
    return b;
  }

  setFootprint(b, val) {
    const { w } = this.map;
    for (let y = b.ty; y < b.ty + b.size; y++)
      for (let x = b.tx; x < b.tx + b.size; x++)
        this.blocked[y * w + x] = val;
  }

  removeDead() {
    let changed = false;
    for (const e of this.entities) {
      if (e.owner >= 0 && e.hp <= 0) {
        changed = true;
        this.events.push({ t: "death", x: e.x, y: e.y, type: e.type, owner: e.owner, building: !!e.building, size: e.size || 0 });
        if (e.building) this.setFootprint(e, 0);
        this.byId.delete(e.id);
      } else if (e.type === "mineral" && e.amount <= 0) {
        changed = true;
        this.byId.delete(e.id);
      }
    }
    if (changed) this.entities = this.entities.filter((e) => this.byId.has(e.id));
  }

  // ---------- queries ----------

  canAfford(pid, cost, gasCost = 0) {
    return this.minerals[pid] >= cost && this.gas[pid] >= gasCost;
  }

  // Does the player own a FINISHED building of the given type? Used for tech
  // prerequisites (factory needs barracks, etc.).
  hasBuilding(pid, type) {
    for (const e of this.entities) {
      if (e.building && e.done && e.owner === pid && e.type === type) return true;
    }
    return false;
  }

  supplyOf(pid) {
    let used = 0, cap = 0;
    for (const e of this.entities) {
      if (e.owner !== pid) continue;
      if (e.unit) used += UNITS[e.type].supply;
      if (e.building) {
        if (e.done) cap += BUILDINGS[e.type].supply || 0;
        // only the unit actually in production consumes supply; the rest of
        // the queue waits (production stalls when supply-blocked)
        const head = e.queue[0];
        if (head?.started && head.type) used += UNITS[head.type].supply;
      }
    }
    return { used, cap: Math.min(cap, 200) };
  }

  nearestEntity(x, y, maxDist, pred) {
    if (this._shCells && maxDist <= FP * 6) {
      let best = null, bestD = maxDist * maxDist;
      for (const e of this.shNeighbors(x, y)) {
        if (!pred(e)) continue;
        const d = dist2(x, y, e.x, e.y);
        if (d < bestD) { bestD = d; best = e; }
      }
      for (const e of this.entities) {
        if (e.unit) continue;
        if (!pred(e)) continue;
        const d = dist2(x, y, e.x, e.y);
        if (d < bestD) { bestD = d; best = e; }
      }
      return best;
    }
    let best = null, bestD = maxDist * maxDist;
    for (const e of this.entities) {
      if (!pred(e)) continue;
      const d = dist2(x, y, e.x, e.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  isVisible(pid, x, y) {
    return this.fog[pid][fpToTile(y) * this.map.w + fpToTile(x)] === 2;
  }

  canPlace(type, tx, ty) {
    const d = BUILDINGS[type];
    if (!d) return false;
    const { w, h } = this.map;
    if (tx < 0 || ty < 0 || tx + d.size > w || ty + d.size > h) return false;
    const ramps = this.map.rampTiles;
    const H = this.map.height;
    let lvl = -1;
    for (let y = ty; y < ty + d.size; y++)
      for (let x = tx; x < tx + d.size; x++) {
        const idx = y * w + x;
        if (this.blocked[idx]) return false;
        if (ramps && ramps[idx]) return false;          // no building on ramps
        // footprint must be one flat level — no straddling a cliff/slope edge
        if (H) { if (lvl < 0) lvl = H[idx]; else if (H[idx] !== lvl) return false; }
      }
    // Ooze buildings (except sources like Nucleus/Vent) must be built on Goo.
    if (d.faction === "ooze" && !d.gooOozes) {
      for (let y = ty; y < ty + d.size; y++)
        for (let x = tx; x < tx + d.size; x++) {
          if (!this.tileOnGoo(x, y)) return false;
        }
    }
    // don't allow placement on top of mineral patches or units
    const cx = tx * FP + (d.size * FP >> 1), cy = ty * FP + (d.size * FP >> 1);
    for (const e of this.entities) {
      if (e.type === "mineral" || e.unit) {
        const clear = (d.size * FP >> 1) + FP;
        if (dist2(cx, cy, e.x, e.y) < clear * clear && e.type === "mineral") return false;
      }
    }
    // Geyser rules: a refinery MUST cover a free geyser's tile; every other
    // building may NOT cover a geyser tile.
    const geo = this.geyserInFootprint(tx, ty, d.size);
    if (d.onGeyser) {
      if (!geo) return false;                       // refinery needs a geyser
      if (this.refineryOnGeyser(geo.id)) return false; // one refinery per geyser
    } else if (geo) {
      return false;                                 // don't block a geyser
    }
    // Deposit buildings (Command Post) must keep clear of the resource line so
    // mining isn't trivially efficient: footprint CENTER >= clearance from any
    // mineral patch or geyser (center-to-center). Refinery is exempt above.
    if (d.deposit) {
      const clr = HQ_RESOURCE_CLEARANCE * FP;
      for (const e of this.entities) {
        if (e.type === "mineral" || e.type === "geyser") {
          if (dist2(cx, cy, e.x, e.y) < clr * clr) return false;
        }
      }
    }
    return true;
  }

  // The geyser whose tile falls inside the [tx,ty]+size footprint, or null.
  geyserInFootprint(tx, ty, size) {
    for (const e of this.entities) {
      if (e.type !== "geyser") continue;
      const gx = fpToTile(e.x), gy = fpToTile(e.y);
      if (gx >= tx && gx < tx + size && gy >= ty && gy < ty + size) return e;
    }
    return null;
  }

  refineryOnGeyser(geyserId) {
    for (const e of this.entities) {
      if (isGasBuilding(e.type) && e.geyserId === geyserId) return true;
    }
    return false;
  }

  // ---------- Goo field ----------
  // The gooGrid is a Uint8Array(w*h) where 1 = covered by goo. Goo grows
  // tile-by-tile at the frontier around gooOozes buildings (Nucleus, Goo
  // Vents): every GOO_GROW_INTERVAL ticks each empty tile touching supported
  // goo rolls the GOO_NOISE dice — more goo neighbors, better odds — so fronts
  // creep out as ragged amoeba lobes instead of rings. "Supported" means
  // BFS-connected to a live source within GOO_MAX_RADIUS; when a source dies
  // its unsupported goo crumbles back edge-first every GOO_RECEDE_INTERVAL
  // ticks. All rolls come from the shared noise list in strict tile-index
  // order, so both lockstep peers stay bit-identical (cursor is checksummed).

  // Is a tile coordinate covered by goo?
  tileOnGoo(tx, ty) {
    const { w } = this.map;
    return tx >= 0 && tx < w && ty >= 0 && ty < this.map.h && this.gooGrid[ty * w + tx] === 1;
  }

  // Is an fp position on goo?
  fpOnGoo(fpx, fpy) {
    return this.tileOnGoo(fpToTile(fpx), fpToTile(fpy));
  }

  // Regenerate HP for Ooze units that haven't taken damage recently.
  applyRegen(e) {
    const d = UNITS[e.type];
    if (!d || d.faction !== "ooze" || e.hp <= 0 || e.hp >= e.maxHp) return;
    if (e.lastDmg > 0 && this.tick - e.lastDmg < REGEN_DELAY) return; // recent damage
    const onGoo = this.fpOnGoo(e.x, e.y);
    if (onGoo && e.hp < e.maxHp) {
      e.hp = Math.min(e.maxHp, e.hp + REGEN_RATE);
    } else if (!onGoo && this.tick % 2 === 0 && e.hp < e.maxHp) {
      // Off-goo: half rate (1 HP per 2 ticks)
      e.hp = Math.min(e.maxHp, e.hp + REGEN_RATE_OFF);
    }
  }

  // Stamp goo under a building's footprint plus `border` extra tiles in each
  // direction (terrain permitting). Sources stamp a 2-tile seed border the
  // moment they finish so a fresh Nucleus/Vent isn't starved while the
  // frontier grows; other Ooze buildings stamp only their own footprint.
  stampGoo(e, border) {
    const { w, h } = this.map;
    const rock = this.map.rock, H = this.map.height, ramps = this.map.rampTiles;
    const lvl = H ? H[e.ty * w + e.tx] : 0;
    const x0 = Math.max(0, e.tx - border), x1 = Math.min(w - 1, e.tx + e.size - 1 + border);
    const y0 = Math.max(0, e.ty - border), y1 = Math.min(h - 1, e.ty + e.size - 1 + border);
    let changed = false;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (this.gooGrid[i]) continue;
        const inside = x >= e.tx && x < e.tx + e.size && y >= e.ty && y < e.ty + e.size;
        if (!inside) {
          if (rock && rock[i]) continue;
          if (H && H[i] !== lvl && !(ramps && ramps[i])) continue;
        }
        this.gooGrid[i] = 1;
        changed = true;
      }
    if (changed) this.gooVersion++;
  }

  stampGooSeed(e) { this.stampGoo(e, 2); }

  // BFS from all live source footprints across existing goo (4-neighbor),
  // depth-capped. _gooSupport[i] = distance+1 from a source footprint, 0 =
  // unsupported. FIFO BFS distances are order-independent, so this is
  // deterministic regardless of source ordering.
  computeGooSupport() {
    const { w, h } = this.map;
    const grid = this.gooGrid, sup = this._gooSupport;
    sup.fill(0);
    const queue = [];
    for (const src of this._gooSources) {
      const e = this.byId.get(src.id);
      if (!e) continue;
      for (let y = e.ty; y < e.ty + e.size; y++)
        for (let x = e.tx; x < e.tx + e.size; x++) {
          const i = y * w + x;
          if (grid[i] && !sup[i]) { sup[i] = 1; queue.push(i); }
        }
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const i = queue[qi];
      const d = sup[i];
      if (d > GOO_MAX_RADIUS) continue; // depth cap
      const x = i % w;
      if (x > 0 && grid[i - 1] && !sup[i - 1]) { sup[i - 1] = d + 1; queue.push(i - 1); }
      if (x < w - 1 && grid[i + 1] && !sup[i + 1]) { sup[i + 1] = d + 1; queue.push(i + 1); }
      if (i >= w && grid[i - w] && !sup[i - w]) { sup[i - w] = d + 1; queue.push(i - w); }
      if (i < w * (h - 1) && grid[i + w] && !sup[i + w]) { sup[i + w] = d + 1; queue.push(i + w); }
    }
  }

  // Can goo tile j feed growth into empty tile i? j must be supported with
  // headroom (so the new tile stays inside GOO_MAX_RADIUS) and on the same
  // height level — unless either tile is a ramp tile, so creep flows along
  // ramps but never over cliff walls (those are rock anyway).
  gooCanFeed(i, j) {
    const sup = this._gooSupport;
    if (!this.gooGrid[j] || !sup[j] || sup[j] > GOO_MAX_RADIUS) return 0;
    const H = this.map.height, ramps = this.map.rampTiles;
    if (H && H[i] !== H[j] && !(ramps && (ramps[i] || ramps[j]))) return 0;
    return 1;
  }

  // Grow and recede the goo frontier. Called every step.
  spreadGoo() {
    // Step 1: drop dead sources — their goo loses support and crumbles below.
    this._gooSources = this._gooSources.filter((src) => {
      const e = this.byId.get(src.id);
      return e && e.building && e.hp > 0;
    });
    // Step 2: newly finished Ooze buildings stamp their goo; gooOozes ones
    // also register as sources with a seed border.
    for (const e of this.entities) {
      if (!e.building || !e.done || e.hp <= 0 || e.gooStamped) continue;
      const bd = BUILDINGS[e.type];
      if (!bd || bd.faction !== "ooze") continue;
      e.gooStamped = 1;
      if (bd.gooOozes) {
        this._gooSources.push({ id: e.id });
        this.stampGooSeed(e);
      } else {
        this.stampGoo(e, 0);
      }
    }
    const growing = this.tick % GOO_GROW_INTERVAL === 0;
    const receding = this.tick % GOO_RECEDE_INTERVAL === 0;
    if (!growing && !receding) return;
    this.computeGooSupport();

    const { w, h } = this.map;
    const grid = this.gooGrid;
    const rock = this.map.rock;
    const grown = [], dying = [];

    if (growing) {
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] || (rock && rock[i])) continue;
        const x = i % w, y = (i / w) | 0;
        let n = 0;
        if (x > 0) n += this.gooCanFeed(i, i - 1);
        if (x < w - 1) n += this.gooCanFeed(i, i + 1);
        if (y > 0) n += this.gooCanFeed(i, i - w);
        if (y < h - 1) n += this.gooCanFeed(i, i + w);
        if (!n) continue;
        // more goo around the tile = better odds: concavities fill fast,
        // lone spikes stay rare, fronts come out blobby
        const roll = GOO_NOISE[this.gooNoiseI++ % GOO_NOISE.length];
        if (roll < (n === 1 ? 40 : n === 2 ? 110 : 215)) grown.push(i);
      }
    }

    if (receding) {
      const sup = this._gooSupport;
      // Tiles under living Ooze buildings never crumble.
      const hold = this._gooHold || (this._gooHold = new Uint8Array(w * h));
      hold.fill(0);
      for (const e of this.entities) {
        if (!e.building || e.hp <= 0) continue;
        const bd = BUILDINGS[e.type];
        if (!bd || bd.faction !== "ooze") continue;
        for (let y = e.ty; y < e.ty + e.size; y++)
          for (let x = e.tx; x < e.tx + e.size; x++) hold[y * w + x] = 1;
      }
      for (let i = 0; i < grid.length; i++) {
        if (!grid[i] || sup[i] || hold[i]) continue;
        // only edge tiles crumble (fewer than 4 orthogonal goo neighbors),
        // so lost creep shrivels inward instead of blinking off
        const x = i % w, y = (i / w) | 0;
        let n = 0;
        if (x > 0 && grid[i - 1]) n++;
        if (x < w - 1 && grid[i + 1]) n++;
        if (y > 0 && grid[i - w]) n++;
        if (y < h - 1 && grid[i + w]) n++;
        if (n >= 4) continue;
        const roll = GOO_NOISE[this.gooNoiseI++ % GOO_NOISE.length];
        if (roll < 120) dying.push(i);
      }
    }

    if (grown.length || dying.length) {
      for (const i of grown) grid[i] = 1;
      for (const i of dying) grid[i] = 0;
      this.gooVersion++;
    }
  }

  // Does the player have a building that oozes goo? (for AI checks)
  hasGooSources(pid) {
    for (const src of this._gooSources) {
      const e = this.byId.get(src.id);
      if (e && e.owner === pid) return true;
    }
    return false;
  }

  // ---------- commands ----------
  // bundle: [{pid, cmds:[...]}] applied in pid order — deterministic.

  step(bundle) {
    this.events.length = 0;
    for (const e of this.entities) { e.px = e.x; e.py = e.y; }

    // Spread goo before commands so newly-placed sources start radiating
    this.spreadGoo();

    if (bundle) {
      for (const group of bundle) {
        for (const c of group.cmds) this.applyCommand(group.pid, c);
      }
    }

    for (const e of this.entities) {
      if (e.unit) this.updateUnit(e);
      else if (e.building) this.updateBuilding(e);
    }
    // Ooze regeneration: apply after all damage from this tick is resolved.
    for (const e of this.entities) {
      if (e.unit) this.applyRegen(e);
    }
    this.separate();
    this.removeDead();
    if (this.tick % 3 === 0) this.updateFog();
    this.checkGameOver();
    this.tick++;
  }

  applyCommand(pid, c) {
    const own = (id) => {
      const e = this.byId.get(id);
      return e && e.owner === pid ? e : null;
    };
    switch (c.t) {
      case "move":
      case "attackmove": {
        const units = c.ids.map(own).filter((e) => e && e.unit);
        this.groupMove(units, c.x, c.y, c.t === "attackmove", c.q);
        break;
      }
      case "stop": {
        for (const id of c.ids) {
          const e = own(id);
          if (e && e.unit) { e.order = { kind: "idle" }; e.next = []; e.path = null; }
        }
        break;
      }
      case "attack": {
        const target = this.byId.get(c.targetId);
        if (!target || target.owner === pid || target.owner === -1) break;
        for (const id of c.ids) {
          const e = own(id);
          // reject a target this unit can't hit (e.g. tank ordered onto a
          // flyer) so it doesn't chase something forever
          if (e && e.unit && this.canHit(e, target)) {
            this.setOrder(e, { kind: "attack", targetId: c.targetId, resume: null }, c.q);
          }
        }
        break;
      }
      case "patrol": {
        const units = c.ids.map(own).filter((e) => e && e.unit);
        for (const u of units) {
          this.setOrder(u, {
            kind: "patrol",
            x: this.clampX(c.x), y: this.clampY(c.y),
            ox: u.x, oy: u.y,       // patrol swings between here and the click
          }, c.q);
        }
        break;
      }
      case "hold": {
        for (const id of c.ids) {
          const e = own(id);
          if (e && e.unit) this.setOrder(e, { kind: "hold" }, c.q);
        }
        break;
      }
      case "remove": {
        for (const id of c.ids) {
          const e = own(id);
          // buildings, units, and production structures all removable
          if (e) { e.hp = 0; }
        }
        break;
      }
      case "gather": {
        const patch = this.byId.get(c.targetId);
        if (!patch) break;
        // minerals: any patch. gas: an OWN finished refinery.
        let resource;
        if (patch.type === "mineral") resource = "minerals";
        else if (isGasBuilding(patch.type) && patch.owner === pid && patch.done) resource = "gas";
        else break;
        for (const id of c.ids) {
          const e = own(id);
          if (e && isWorker(e.type)) {
            this.setOrder(e, { kind: "gather", targetId: c.targetId, phase: "to", resource }, c.q);
          }
        }
        break;
      }
      case "build": {
        const worker = own(c.workerId);
        const d = BUILDINGS[c.building];
        if (!worker || !isWorker(worker.type) || !d) break;
        if (d.faction !== this.factions[pid]) break;   // can only build your faction
        if (!this.canAfford(pid, d.cost, d.gasCost || 0)) break;
        // tech prerequisite: must own a FINISHED building of the required type
        if (d.requires && !this.hasBuilding(pid, d.requires)) break;
        if (!this.canPlace(c.building, c.tx, c.ty)) break;
        this.minerals[pid] -= d.cost;
        this.gas[pid] -= (d.gasCost || 0);
        const site = this.spawnBuilding(pid, c.building, c.tx, c.ty, false);
        // remember which geyser a refinery sits on (ownership realized on finish)
        if (d.onGeyser) {
          const geo = this.geyserInFootprint(c.tx, c.ty, d.size);
          if (geo) site.geyserId = geo.id;
        }
        site.builderId = worker.id;
        worker.order = { kind: "build", targetId: site.id };
        worker.path = null;
        break;
      }
      case "ooze_build": {
        // Ooze faction: a Mote melts into the building site, consumed.
        // No worker babysitting — the building auto-completes.
        const d = BUILDINGS[c.building];
        if (!d || d.faction !== "ooze") break;
        if (!this.canAfford(pid, d.cost, d.gasCost || 0)) break;
        if (d.requires && !this.hasBuilding(pid, d.requires)) break;
        if (!this.canPlace(c.building, c.tx, c.ty)) break;
        // Find a Mote within 4 tiles of the build site
        const cx = c.tx * FP + (d.size * FP >> 1);
        const cy = c.ty * FP + (d.size * FP >> 1);
        const mote = this.nearestEntity(cx, cy, FP * 4, (e) =>
          e.owner === pid && e.unit && e.type === "mote" && e.hp > 0);
        if (!mote) break;
        this.minerals[pid] -= d.cost;
        this.gas[pid] -= (d.gasCost || 0);
        // Consume the Mote
        mote.hp = 0; // killed on next removeDead
        this.byId.delete(mote.id);
        // Spawn the building
        const site = this.spawnBuilding(pid, c.building, c.tx, c.ty, false);
        if (d.onGeyser) {
          const geo = this.geyserInFootprint(c.tx, c.ty, d.size);
          if (geo) site.geyserId = geo.id;
        }
        // Auto-complete progress — the building builds itself
        site.builderId = 0;
        break;
      }
      case "ooze_morph": {
        // Ooze unit morph: consume a unit and morph it into the target type.
        // e.g. Nip → Maw.
        const targetType = c.targetType;
        const td = UNITS[targetType];
        if (!td || td.faction !== "ooze") break;
        if (!this.canAfford(pid, td.cost, td.gasCost || 0)) break;
        for (const id of c.ids) {
          const u = this.byId.get(id);
          if (!u || u.owner !== pid || u.type !== c.fromType || u.hp <= 0) continue;
          // Consume the source unit
          const sx = u.x, sy = u.y;
          u.hp = 0;
          this.byId.delete(u.id);
          // Spawn the target unit at the same position
          this.minerals[pid] -= td.cost;
          this.gas[pid] -= (td.gasCost || 0);
          const nu = this.spawnUnit(pid, targetType, sx, sy);
          this.events.push({ t: "morph", id: nu.id, owner: pid, from: c.fromType, to: targetType, x: sx, y: sy });
          break; // only morph one unit per command
        }
        break;
      }
      case "resume": {
        // send workers (back) to an unfinished building of ours
        const site = this.byId.get(c.targetId);
        if (!site || !site.building || site.owner !== pid || site.done) break;
        for (const id of c.ids) {
          const e = own(id);
          if (e && isWorker(e.type)) this.setOrder(e, { kind: "build", targetId: site.id }, c.q);
        }
        break;
      }
      case "rally": {
        const b = own(c.buildingId);
        if (!b || !b.building) break;
        b.rally = { x: this.clampX(c.x), y: this.clampY(c.y), targetId: c.targetId || 0 };
        break;
      }
      case "train": {
        const b = own(c.buildingId);
        const d = UNITS[c.unit];
        if (!b || !b.building || !b.done || !d) break;
        if (!(BUILDINGS[b.type].trains || []).includes(c.unit)) break;
        if (b.queue.length >= MAX_QUEUE) break;
        if (!this.canAfford(pid, d.cost, d.gasCost || 0)) break;
        // no supply check here — supply is claimed when production starts
        this.minerals[pid] -= d.cost;
        this.gas[pid] -= (d.gasCost || 0);
        b.queue.push({ type: c.unit, remaining: d.buildTime, started: false });
        break;
      }
      case "research": {
        const b = own(c.buildingId);
        const up = UPGRADES[c.research];
        if (!b || !b.building || !b.done || !up) break;
        if (b.type !== up.building) break;                 // wrong building
        if (this.upgrades[pid] & up.bit) break;            // already owned
        if (this.upgradeQueued(pid, c.research)) break;    // already queued anywhere
        if (b.queue.length >= MAX_QUEUE) break;
        if (!this.canAfford(pid, up.cost, up.gasCost || 0)) break;
        this.minerals[pid] -= up.cost;
        this.gas[pid] -= (up.gasCost || 0);
        // research never supply-blocks, so it starts immediately (started:true)
        b.queue.push({ research: c.research, remaining: up.time, started: true });
        break;
      }
      case "ability": {
        this.applyAbility(pid, c);
        break;
      }
      case "cancel": {
        // remove a queued item and refund its cost
        const b = own(c.buildingId);
        if (!b || !b.building || !b.queue.length) break;
        const idx = Math.min(Math.max(c.index | 0, 0), b.queue.length - 1);
        const item = b.queue[idx];
        if (item.research) {
          const up = UPGRADES[item.research];
          if (up) { this.minerals[pid] += up.cost; this.gas[pid] += up.gasCost || 0; }
        } else {
          const d = UNITS[item.type];
          if (d) { this.minerals[pid] += d.cost; this.gas[pid] += d.gasCost || 0; }
        }
        b.queue.splice(idx, 1);
        break;
      }
    }
  }

  // Is an upgrade already in-progress in ANY of this player's queues?
  upgradeQueued(pid, upg) {
    for (const e of this.entities) {
      if (!e.building || e.owner !== pid) continue;
      for (const item of e.queue) if (item.research === upg) return true;
    }
    return false;
  }

  // Finish an upgrade: set the player's bit, apply retroactive effects, notify.
  completeResearch(pid, upg) {
    const up = UPGRADES[upg];
    if (!up) return;
    this.upgrades[pid] |= up.bit;
    // plating: +12 max & current hp to all LIVING marines/brutes of this player
    // (future units get it at spawn — see spawnUnit).
    if (upg === "plating") {
      for (const e of this.entities) {
        if (e.owner === pid && (e.type === "marine" || e.type === "brute")) {
          e.maxHp += PLATING_HP;
          e.hp += PLATING_HP;
        }
      }
    }
    // Carapace: retroactive HP bonus to existing Ooze ground units
    if (upg === "carapace") {
      for (const e of this.entities) {
        if (e.owner === pid && e.unit) {
          const bonus = CARAPACE_HP[e.type];
          if (bonus) { e.maxHp += bonus; e.hp += bonus; }
        }
      }
    }
    this.events.push({ t: "research", owner: pid, upg });
  }

  // ---------- abilities ----------
  // Command shape: { t:"ability", ids:[...], ability:"stim"|..., x?, y? }
  // Validated per-unit: correct type, research owned (if gated), not on cd, not
  // mid-transform/leap/channel. Rejected units are silently skipped.
  applyAbility(pid, c) {
    const a = ABILITIES[c.ability];
    if (!a) return;
    const req = a.requires ? UPGRADE_BITS[a.requires] : 0;
    if (req && !(this.upgrades[pid] & req)) return;   // research missing
    for (const id of c.ids) {
      const u = this.byId.get(id);
      if (!u || u.owner !== pid || u.type !== a.unit || u.hp <= 0) continue;
      // busy in another timed ability state? skip (siege toggle handles its own)
      if (u.leapUntil || u.channelUntil || (u.type === "tank" && this.tick < u.transformUntil)) continue;
      switch (c.ability) {
        case "stim":   this.castStim(u, a); break;
        case "leap":   this.castLeap(u, a, c.x, c.y); break;
        case "siege":  this.castSiege(u, a); break;
        case "burners":this.castBurners(u, a); break;
        case "barrage":this.castBarrage(u, a, c.x, c.y); break;
        case "burrow": this.castBurrow(u, a); break;
        case "engulf": this.castEngulf(u, a, c.x, c.y); break;
      }
    }
  }

  castStim(u, a) {
    if (u.abilityCd > 0) return;
    u.hp = Math.max(1, u.hp - a.hpCost);       // costs hp, never lethal
    u.stimUntil = this.tick + a.dur;
    u.abilityCd = a.cd;
    this.events.push({ t: "ability", kind: "stim", id: u.id, x: u.x, y: u.y, owner: u.owner });
  }

  castLeap(u, a, tx, ty) {
    if (u.abilityCd > 0) return;
    tx = this.clampX(tx | 0); ty = this.clampY(ty | 0);
    // clamp the target to <= range tiles from the brute
    const maxR = a.range * FP;
    const dx = tx - u.x, dy = ty - u.y;
    const dd = isqrt(dx * dx + dy * dy);
    if (dd > maxR) { tx = u.x + ((dx * maxR / dd) | 0); ty = u.y + ((dy * maxR / dd) | 0); }
    // must land on a passable, unblocked tile — else snap to the nearest free
    const { w, h } = this.map;
    if (this.blocked[fpToTile(ty) * w + fpToTile(tx)]) {
      const free = nearestFree(this.blocked, w, h, fpToTile(tx), fpToTile(ty));
      if (!free) return;
      tx = tileToFp(free.x); ty = tileToFp(free.y);
    }
    u.leapFrom = { x: u.x, y: u.y };
    u.leapTo = { x: tx, y: ty };
    u.leapUntil = this.tick + a.dur;
    u.abilityCd = a.cd;
    u.path = null; u.next = [];
    this.events.push({
      t: "ability", kind: "leap", id: u.id, owner: u.owner,
      fromX: u.x, fromY: u.y, toX: tx, toY: ty,
    });
  }

  // Leaping brute: fly in a straight line to the landing point ignoring
  // terrain/separation, then land and slam nearby enemy ground units.
  updateLeap(u) {
    const a = ABILITIES.leap;
    const to = u.leapTo;
    const remaining = u.leapUntil - this.tick; // ticks left including this one
    if (remaining <= 0 || !to) { this.landLeap(u, a); return; }
    // interpolate from leapFrom to leapTo by elapsed fraction (integer)
    const total = a.dur;
    const elapsed = total - remaining + 1;
    const fr = u.leapFrom;
    u.x = this.clampX(fr.x + (((to.x - fr.x) * elapsed) / total | 0));
    u.y = this.clampY(fr.y + (((to.y - fr.y) * elapsed) / total | 0));
    if (elapsed >= total) this.landLeap(u, a);
  }

  landLeap(u, a) {
    const to = u.leapTo;
    if (to) { u.x = this.clampX(to.x); u.y = this.clampY(to.y); }
    u.leapUntil = 0; u.leapTo = null; u.leapFrom = null;
    u.order = { kind: "idle" }; u.path = null;
    // slam: damage all enemy GROUND units within `splash` tiles (id order)
    const r = a.splash * FP;
    for (const e of this.entities) {
      if (!e.unit || e.fly || e.owner < 0 || e.owner === u.owner || e.hp <= 0) continue;
      if (dist2(u.x, u.y, e.x, e.y) <= r * r) {
        e.hp -= a.dmg;
        e.lastDmg = this.tick;
      }
    }
    this.events.push({ t: "ability", kind: "leap_land", id: u.id, owner: u.owner, x: u.x, y: u.y });
  }

  // Tank siege toggle: begin a 20-tick transform; the sieged flag flips at the
  // START so range/dmg/immobility take effect immediately, matching the intent
  // that the transform is the "windup" during which it can't fire (gated by
  // transformUntil in updateUnit).
  castSiege(u, a) {
    if (u.abilityCd > 0) return; // shared per-unit cd guards spam
    u.transformUntil = this.tick + a.transform;
    u.abilityCd = a.transform;   // can't re-toggle until the transform finishes
    u.order = { kind: "idle" }; u.path = null; u.next = [];
    if (!u.sieged) {
      u.sieged = 1;
      this.events.push({ t: "ability", kind: "siege_up", id: u.id, owner: u.owner, x: u.x, y: u.y });
    } else {
      u.sieged = 0;
      this.events.push({ t: "ability", kind: "siege_down", id: u.id, owner: u.owner, x: u.x, y: u.y });
    }
  }

  castBurners(u, a) {
    if (u.abilityCd > 0) return;
    u.burnUntil = this.tick + a.dur;
    u.abilityCd = a.cd;
    this.events.push({ t: "ability", kind: "burners", id: u.id, owner: u.owner, x: u.x, y: u.y });
  }

  castBarrage(u, a, tx, ty) {
    if (u.abilityCd > 0) return;
    tx = this.clampX(tx | 0); ty = this.clampY(ty | 0);
    // clamp target within range tiles of the banshee
    const maxR = a.range * FP;
    const dx = tx - u.x, dy = ty - u.y;
    const dd = isqrt(dx * dx + dy * dy);
    if (dd > maxR) { tx = u.x + ((dx * maxR / dd) | 0); ty = u.y + ((dy * maxR / dd) | 0); }
    u.channel = { x: tx, y: ty, fired: 0 };
    u.channelUntil = this.tick + a.channel;
    u.abilityCd = a.cd;
    u.order = { kind: "idle" }; u.path = null; u.next = [];
    this.events.push({ t: "ability", kind: "barrage", id: u.id, owner: u.owner, x: tx, y: ty });
  }

  // Channeling banshee: immobile; fire one rocket every `interval` ticks at the
  // target point (with a deterministic per-rocket spread), each hitting enemy
  // ground units within `radius`. Ends after all rockets or the channel window.
  updateBarrage(u) {
    const a = ABILITIES.barrage;
    const ch = u.channel;
    const elapsed = a.channel - (u.channelUntil - this.tick); // ticks since start
    // fire on ticks 0, interval, 2*interval, ... up to `rockets`
    if (ch && ch.fired < a.rockets && elapsed >= ch.fired * a.interval) {
      const i = ch.fired;
      const ox = ((i * 97) % 129 - 64);
      const oy = ((i * 61) % 129 - 64);
      const ix = this.clampX(ch.x + ox), iy = this.clampY(ch.y + oy);
      const r = a.radius;
      for (const e of this.entities) {
        if (!e.unit || e.fly || e.owner < 0 || e.owner === u.owner || e.hp <= 0) continue;
        if (dist2(ix, iy, e.x, e.y) <= r * r) {
          e.hp -= a.dmg;
          e.lastDmg = this.tick;
        }
      }
      this.events.push({ t: "ability", kind: "barrage_hit", id: u.id, owner: u.owner, x: ix, y: iy });
      ch.fired++;
    }
    if (this.tick >= u.channelUntil && (!ch || ch.fired >= a.rockets)) {
      u.channelUntil = 0; u.channel = null;
      if (u.order.kind === "idle") u.order = { kind: "idle" };
    } else if (this.tick >= u.channelUntil) {
      // window elapsed but rockets remain: fire the rest, then end next check
      u.channelUntil = this.tick + 1;
    }
  }

  // Sluice burrow toggle: mirrors tank siege — begin transform, set burrowed
  // flag which enables longer-range splash mortar (gated by transformUntil in
  // updateUnit so it can't fire while winding up).
  castBurrow(u, a) {
    if (u.abilityCd > 0) return;
    u.transformUntil = this.tick + a.transform;
    u.abilityCd = a.transform;
    u.order = { kind: "idle" }; u.path = null; u.next = [];
    if (!u.burrowed) {
      u.burrowed = 1;
      this.events.push({ t: "ability", kind: "burrow_up", id: u.id, owner: u.owner, x: u.x, y: u.y });
    } else {
      u.burrowed = 0;
      this.events.push({ t: "ability", kind: "burrow_down", id: u.id, owner: u.owner, x: u.x, y: u.y });
    }
  }

  // Maw engulf: short-range lunge that lands on the target and deals splash
  // damage to nearby enemy ground units (mirrors brute leap).
  castEngulf(u, a, tx, ty) {
    if (u.abilityCd > 0) return;
    tx = this.clampX(tx | 0); ty = this.clampY(ty | 0);
    const maxR = a.range * FP;
    const dx = tx - u.x, dy = ty - u.y;
    const dd = isqrt(dx * dx + dy * dy);
    if (dd > maxR) { tx = u.x + ((dx * maxR / dd) | 0); ty = u.y + ((dy * maxR / dd) | 0); }
    // must land on a passable tile — else snap to nearest free
    const { w, h } = this.map;
    if (this.blocked[fpToTile(ty) * w + fpToTile(tx)]) {
      const free = nearestFree(this.blocked, w, h, fpToTile(tx), fpToTile(ty));
      if (!free) return;
      tx = tileToFp(free.x); ty = tileToFp(free.y);
    }
    u.leapFrom = { x: u.x, y: u.y };
    u.leapTo = { x: tx, y: ty };
    u.leapUntil = this.tick + a.dur;
    u.abilityCd = a.cd;
    u.path = null; u.next = [];
    this.events.push({
      t: "ability", kind: "engulf", id: u.id, owner: u.owner,
      fromX: u.x, fromY: u.y, toX: tx, toY: ty,
    });
  }

  groupMove(units, x, y, attackMove, queued) {
    if (!units.length) return;
    // deterministic formation: sort by id, tidy grid around the target
    units.sort((a, b) => a.id - b.id);
    const cols = Math.ceil(Math.sqrt(units.length));
    const spacing = (FP * 0.9) | 0;
    units.forEach((u, i) => {
      const col = i % cols, row = (i / cols) | 0;
      const ox = ((col - (cols - 1) / 2) * spacing) | 0;
      const oy = ((row - (Math.ceil(units.length / cols) - 1) / 2) * spacing) | 0;
      const tx = this.clampX(x + ox), ty = this.clampY(y + oy);
      this.setOrder(u, attackMove
        ? { kind: "attackmove", x: tx, y: ty }
        : { kind: "move", x: tx, y: ty }, queued);
    });
  }

  clampX(v) { return Math.min(this.map.w * FP - HALF, Math.max(HALF, v)); }
  clampY(v) { return Math.min(this.map.h * FP - HALF, Math.max(HALF, v)); }

  // Set an order now, or append it when the command was shift-queued.
  setOrder(u, order, queued) {
    if (queued && u.order.kind !== "idle") {
      if (u.next.length < 8) u.next.push(order);
    } else {
      u.order = order;
      u.next = queued ? u.next : [];
      u.path = null;
    }
  }

  // Current order finished: advance to the next queued one (or idle).
  popNext(u) {
    u.order = u.next.shift() || { kind: "idle" };
    u.path = null;
  }

  // ---------- unit brain ----------

  updateUnit(u) {
    if (u.cooldown > 0) u.cooldown--;
    if (u.abilityCd > 0) u.abilityCd--;
    const d = UNITS[u.type];
    const o = u.order;

    // ---- special ability states preempt the normal order machine ----
    // Leaping brute / Engulfing maw: fly straight to the landing point, then slam.
    if ((u.type === "brute" || u.type === "maw") && u.leapUntil) { this.updateLeap(u); return; }
    // Channeling banshee: fire a timed volley of rockets, immobile.
    if (u.type === "banshee" && u.channelUntil) { this.updateBarrage(u); return; }
    // Transforming tank / Burrowing sluice: immobile, can't fire; finish the
    // toggle when the timer elapses. Weapon/acquire resumes next tick.
    if ((u.type === "tank" || u.type === "sluice") && this.tick < u.transformUntil) return;

    const speed = this.unitSpeed(u);

    switch (o.kind) {
      case "idle":
        if (d.acquire > 0) {
          const enemy = this.acquireTarget(u, d.acquire);
          if (enemy) u.order = { kind: "attack", targetId: enemy.id, resume: null };
        }
        break;

      case "move":
        if (u.sieged || u.burrowed) { u.order = { kind: "idle" }; break; } // immobile
        if (this.travelTo(u, o.x, o.y, speed)) this.popNext(u);
        break;

      case "attackmove": {
        // workers have no idle auto-acquire (acquire: 0) but an explicit
        // attack-move should still engage — fall back to a short radius
        const acqAM = d.acquire > 0 ? d.acquire : (FP * 3) | 0;
        {
          const enemy = this.acquireTarget(u, acqAM);
          if (enemy) {
            // resume holds the full pre-fight order, restored on target death
            u.order = { kind: "attack", targetId: enemy.id, resume: { ...o } };
            u.path = null;
            break;
          }
        }
        if (u.sieged) break; // sieged tank holds position, keeps acquiring
        if (this.travelTo(u, o.x, o.y, speed)) this.popNext(u);
        break;
      }

      case "patrol": {
        const acqP = d.acquire > 0 ? d.acquire : (FP * 3) | 0;
        {
          const enemy = this.acquireTarget(u, acqP);
          if (enemy) {
            u.order = { kind: "attack", targetId: enemy.id, resume: { ...o } };
            u.path = null;
            break;
          }
        }
        if (u.sieged) break;
        if (this.travelTo(u, o.x, o.y, speed)) {
          // arrived: swing back the other way
          u.order = { kind: "patrol", x: o.ox, y: o.oy, ox: o.x, oy: o.y };
        }
        break;
      }

      case "hold": {
        // stand ground: fire at anything in weapon range, never chase
        const range = this.unitRange(u);
        if ((d.dmg > 0 || d.dmgAir > 0) && u.cooldown === 0) {
          const target = this.acquireTarget(u, range + HALF);
          if (target && this.canSiegeHit(u, target) && this.gapTo(u, target) <= range) {
            this.fireAt(u, target, d);
          }
        }
        break;
      }

      case "attack": {
        const target = this.byId.get(o.targetId);
        if (!target || target.hp <= 0) {
          if (o.resume) {
            u.order = o.resume;
            u.path = null;
          } else this.popNext(u);
          break;
        }
        // can't hit this target (e.g. a ground unit chasing a flyer): drop it
        if (!this.canHit(u, target)) {
          if (o.resume) { u.order = o.resume; u.path = null; }
          else this.popNext(u);
          break;
        }
        // sieged tank can't hit a target inside its minimum range: drop it
        if (!this.canSiegeHit(u, target)) {
          if (o.resume) { u.order = o.resume; u.path = null; }
          else this.popNext(u);
          break;
        }
        const range = this.unitRange(u);
        const gap = this.gapTo(u, target);
        if (gap <= range) {
          u.path = null;
          if (u.cooldown === 0) this.fireAt(u, target, d);
        } else if (u.sieged || this.tick < u.transformUntil) {
          // sieged/transforming tanks never move to chase — just wait
          u.path = null;
        } else {
          this.travelTo(u, target.x, target.y, this.unitSpeed(u), true);
        }
        break;
      }

      case "gather": this.updateGather(u, d); break;

      case "build": {
        const site = this.byId.get(o.targetId);
        if (!site || site.done) { u.order = { kind: "idle" }; u.path = null; break; }
        const bd = BUILDINGS[site.type];
        const gap = this.gapTo(u, site);
        if (gap <= (FP * 0.75) | 0) {
          u.path = null;
          site.progress++;
          site.hp = Math.min(site.maxHp, site.hp + Math.ceil(site.maxHp / bd.buildTime));
          if (site.progress >= bd.buildTime) {
            site.done = true;
            site.hp = site.maxHp;
            this.events.push({ t: "complete", id: site.id, x: site.x, y: site.y, owner: site.owner });
            u.order = { kind: "idle" };
            this.autoGather(u);
          }
        } else {
          this.travelTo(u, site.x, site.y, d.speed); // static target: always pathfind
        }
        break;
      }
    }
  }

  // ---------- building brain: training queues ----------

  updateBuilding(b) {
    // Auto-build for Ooze faction: no worker needed. If the building isn't done
    // and has no active builder (or the builder is dead/missing), tick progress.
    if (!b.done) {
      const bd = BUILDINGS[b.type];
      if (bd && bd.faction === "ooze") {
        b.progress++;
        b.hp = Math.min(b.maxHp, b.hp + Math.ceil(b.maxHp / bd.buildTime));
        if (b.progress >= bd.buildTime) {
          b.done = true;
          b.hp = b.maxHp;
          this.events.push({ t: "complete", id: b.id, x: b.x, y: b.y, owner: b.owner });
        }
        return; // no further processing until done
      }
      return;
    }
    const bd = BUILDINGS[b.type];
    // armed buildings (turret): acquire the nearest VISIBLE enemy in range that
    // this weapon can hit and fire. Never chase — just gate on cooldown.
    if (bd.armed) {
      if (b.cooldown > 0) b.cooldown--;
      if (b.cooldown === 0) {
        const target = this.nearestEntity(b.x, b.y, bd.range, (e) =>
          e.owner >= 0 && e.owner !== b.owner && e.hp > 0 &&
          (e.fly ? (bd.dmgAir || 0) > 0 : (bd.dmg || 0) > 0) &&
          this.isVisible(b.owner, e.x, e.y));
        if (target) {
          b.cooldown = bd.cooldown;
          const dmg = target.fly ? bd.dmgAir : bd.dmg;
          target.hp -= dmg;
          if (target.unit) target.lastDmg = this.tick;
          this.events.push({
            t: "shot", fx: b.x, fy: b.y, tx: target.x, ty: target.y,
            owner: b.owner, ranged: true, air: !!target.fly,
            attackerId: b.id, targetId: target.id, tOwner: target.owner,
          });
        }
      }
    }
    if (!b.queue.length) return;
    const item = b.queue[0];
    // research item: never supply-gated, completes into an upgrade bit.
    if (item.research) {
      if (--item.remaining <= 0) {
        b.queue.shift();
        this.completeResearch(b.owner, item.research);
      }
      return;
    }
    if (!item.started) {
      // production begins only when supply is available; otherwise stall
      const d = UNITS[item.type];
      const s = this.supplyOf(b.owner);
      if (s.used + d.supply > s.cap) return;
      item.started = true;
    }
    if (--item.remaining <= 0) {
      b.queue.shift();
      const spot = nearestFree(this.blocked, this.map.w, this.map.h,
        fpToTile(b.x), b.ty + b.size); // prefer below the building
      if (spot) {
        // Brood: the Den morphs Nips TWO at a time per cycle
        const broodCount = (b.type === "den" && item.type === "nip") ? 2 : 1;
        for (let i = 0; i < broodCount; i++) {
          const s = i === 0 ? spot : nearestFree(this.blocked, this.map.w, this.map.h,
            fpToTile(b.x) + (i % 2), b.ty + b.size + ((i / 2) | 0));
          if (!s) break;
          const u = this.spawnUnit(b.owner, item.type, tileToFp(s.x), tileToFp(s.y));
          this.events.push({ t: "trained", id: u.id, owner: b.owner, type: item.type, x: u.x, y: u.y });
          // send the fresh unit to the rally point (workers rally onto minerals)
          if (b.rally) {
            const target = b.rally.targetId ? this.byId.get(b.rally.targetId) : null;
            if (isWorker(u.type) && target?.type === "mineral") {
              // rally onto minerals: balance across the line, not one patch
              const patch = this.pickPatch(target, FP * 6) || (target.amount > 0 ? target : null);
              if (patch) u.order = { kind: "gather", targetId: patch.id, phase: "to", resource: "minerals" };
            } else if (isWorker(u.type) && target && (isGasBuilding(target.type) || target.type === "geyser")) {
              // rally onto gas: send workers to a finished refinery/sump on that spot
              const ref = isGasBuilding(target.type) ? target
                : this.entities.find((e) => isGasBuilding(e.type) && e.done && e.geyserId === target.id);
              if (ref && ref.done) u.order = { kind: "gather", targetId: ref.id, phase: "to", resource: "gas" };
              else u.order = { kind: "move", x: b.rally.x, y: b.rally.y };
            } else {
              u.order = { kind: "move", x: b.rally.x, y: b.rally.y };
            }
          } else if (isWorker(item.type)) {
            this.autoGather(u);
          }
        }
      }
    }
  }

  // One code path for both resources. `resource` is "gas" for a refinery over
  // a geyser, else "minerals" (default for legacy orders without the field).
  updateGather(u, d) {
    const o = u.order;
    const gas = o.resource === "gas";
    if (o.phase === "to") {
      const node = this.byId.get(o.targetId);
      if (gas) {
        // refinery/sump destroyed: give up (worker can't re-target a geyser itself)
        if (!node || !isGasBuilding(node.type) || !node.done) { this.popNext(u); return; }
      } else if (!node || node.amount <= 0) {
        const next = this.pickPatch(u, FP * 14);
        if (next) { o.targetId = next.id; u.path = null; }
        else this.popNext(u);
        return;
      }
      // gas node is a building (approach its edge); mineral node is a point
      const gap = gas ? this.gapTo(u, node) : dist(u.x, u.y, node.x, node.y);
      if (gap <= (gas ? (FP * 0.75) | 0 : (FP * 0.8) | 0)) {
        o.phase = "mining";
        u.gatherTimer = gas ? GAS_GATHER_TICKS : GATHER_TICKS;
        u.path = null;
      } else {
        this.travelTo(u, node.x, node.y, d.speed, true);
      }
    } else if (o.phase === "mining") {
      const node = this.byId.get(o.targetId);
      if (!node) { o.phase = "to"; return; }
      if (--u.gatherTimer <= 0) {
        if (gas) {
          // the refinery draws from its geyser; depleted geysers trickle
          const geo = node.geyserId ? this.byId.get(node.geyserId) : null;
          let take;
          if (geo && geo.amount > 0) {
            take = Math.min(GAS_CARRY, geo.amount);
            geo.amount -= take;
          } else {
            take = GAS_DEPLETED;   // depleted (or missing) geyser: small trickle
          }
          u.carry = take;
          u.carryKind = 1;         // 1 = gas
        } else {
          const take = Math.min(CARRY_AMOUNT, node.amount);
          node.amount -= take;
          u.carry = take;
          u.carryKind = 0;         // 0 = minerals
        }
        o.phase = "return";
        u.path = null;
      }
    } else if (o.phase === "return") {
      const depot = this.nearestEntity(u.x, u.y, FP * 60,
        (e) => e.building && e.done && e.owner === u.owner && BUILDINGS[e.type].deposit);
      if (!depot) { u.order = { kind: "idle" }; return; }
      const gap = this.gapTo(u, depot);
      if (gap <= (FP * 0.75) | 0) {
        if (u.carryKind === 1) this.gas[u.owner] += u.carry;
        else this.minerals[u.owner] += u.carry;
        u.carry = 0;
        o.phase = "to";
        u.path = null;
      } else {
        // aim at the depot edge on THIS worker's side, so returns spread
        // evenly around the building instead of converging on one corner
        const t = this.edgePointToward(u, depot);
        this.travelTo(u, t.x, t.y, d.speed);
      }
    }
  }

  // How many workers are already assigned to a patch.
  gatherersOn(patchId) {
    let n = 0;
    for (const e of this.entities) {
      if (e.unit && e.order.kind === "gather" && e.order.targetId === patchId) n++;
    }
    return n;
  }

  // Pick the best patch near a point: fewest assigned workers first, then
  // nearest, then lowest id — fully deterministic, spreads workers across
  // the mineral line instead of stacking them on the closest patch.
  pickPatch(at, maxDist) {
    let best = null, bestLoad = 0, bestD2 = 0;
    for (const e of this.entities) {
      if (e.type !== "mineral" || e.amount <= 0) continue;
      const d2 = dist2(at.x, at.y, e.x, e.y);
      if (d2 > maxDist * maxDist) continue;
      const load = this.gatherersOn(e.id);
      if (!best || load < bestLoad || (load === bestLoad && d2 < bestD2)) {
        best = e; bestLoad = load; bestD2 = d2;
      }
    }
    return best;
  }

  autoGather(u) {
    const patch = this.pickPatch(u, FP * 12);
    if (patch) u.order = { kind: "gather", targetId: patch.id, phase: "to" };
  }

  // Point just outside a building's footprint, on the side facing the unit.
  edgePointToward(u, b) {
    const half = (b.size * FP) >> 1;
    const dx = u.x - b.x, dy = u.y - b.y;
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    if (m === 0) return { x: this.clampX(b.x + half + HALF), y: b.y };
    const scale = half + (HALF >> 1);
    return {
      x: this.clampX(b.x + (((dx * scale) / m) | 0)),
      y: this.clampY(b.y + (((dy * scale) / m) | 0)),
    };
  }

  // Can `attacker` (a unit) damage `target`? A flying target requires an air
  // weapon (dmgAir > 0); a ground target requires a ground weapon (dmg > 0).
  canHit(attacker, target) {
    const d = UNITS[attacker.type];
    if (!d) return false;
    return target.fly ? (d.dmgAir || 0) > 0 : (d.dmg || 0) > 0;
  }

  // ---------- ability-aware stat reads ----------
  // Effective movement speed: stim (marine x1.4), afterburners (wraith x1.8),
  // servos (tank x1.3). Integer math, applied at read time so `data` is never
  // mutated. Sieged/transforming tanks and leaping/channeling units are
  // immobile — callers gate movement separately, this just scales the number.
  unitSpeed(u) {
    const d = UNITS[u.type];
    let s = d.speed;
    if (u.type === "marine" && this.tick < u.stimUntil) {
      const a = ABILITIES.stim; s = (s * a.spdNum / a.spdDen) | 0;
    }
    if (u.type === "wraith" && this.tick < u.burnUntil) {
      const a = ABILITIES.burners; s = (s * a.spdNum / a.spdDen) | 0;
    }
    if (u.type === "tank" && (this.upgrades[u.owner] & UPGRADE_BITS.servos)) {
      s = (s * SERVOS_SPEED_NUM / SERVOS_SPEED_DEN) | 0;
    }
    // Ooze ground units on Goo: +20% speed
    if (d.faction === "ooze" && !u.fly && this.fpOnGoo(u.x, u.y)) {
      s = (s * GOO_SPEED_NUM / GOO_SPEED_DEN) | 0;
    }
    // Membrane: +20% speed for Wisps
    if (u.type === "wisp" && (this.upgrades[u.owner] & UPGRADE_BITS.membrane)) {
      s = (s * 6 / 5) | 0;
    }
    return s;
  }

  // Effective attack cooldown: stim shortens the marine's (x0.6).
  unitCooldown(u) {
    const d = UNITS[u.type];
    let c = d.cooldown;
    if (u.type === "marine" && this.tick < u.stimUntil) {
      const a = ABILITIES.stim; c = (c * a.cdNum / a.cdDen) | 0;
    }
    if (u.type === "tank" && u.sieged) c = ABILITIES.siege.cooldown;
    if (u.type === "sluice" && u.burrowed) c = ABILITIES.burrow.cooldown;
    // Ooze Adrenal: +20% attack speed for Nip, Spit, Maw
    if ((u.type === "nip" || u.type === "spit" || u.type === "maw") &&
        (this.upgrades[u.owner] & UPGRADE_BITS.adrenal)) {
      c = (c * 5 / 6) | 0; // -17% = x5/6 = faster
    }
    return c;
  }

  // Effective weapon range: a sieged tank reaches 9 tiles; a burrowed sluice 7.
  unitRange(u) {
    const d = UNITS[u.type];
    if (u.type === "tank" && u.sieged) return ABILITIES.siege.range * FP;
    if (u.type === "sluice" && u.burrowed) return ABILITIES.burrow.range * FP;
    return d.range;
  }

  // Effective ground damage: a sieged tank hits for 30.
  unitDmg(u, target) {
    const d = UNITS[u.type];
    if (u.type === "tank" && u.sieged && !target.fly) return ABILITIES.siege.dmg;
    if (u.type === "sluice" && u.burrowed && !target.fly) return ABILITIES.burrow.dmg;
    return target.fly ? d.dmgAir : d.dmg;
  }

  // A sieged tank cannot fire at anything inside its minimum range (2.5 tiles).
  // A burrowed sluice cannot fire inside 2.5 tiles.
  // Every other unit/state can always hit a valid target.
  canSiegeHit(u, target) {
    if (u.type === "tank" && u.sieged) {
      const min = (ABILITIES.siege.minRange * FP / 10) | 0;
      if (this.gapTo(u, target) < min) return false;
    }
    if (u.type === "sluice" && u.burrowed) {
      const min = (ABILITIES.burrow.minRange * FP / 10) | 0;
      if (this.gapTo(u, target) < min) return false;
    }
    return true;
  }

  // Fire `u`'s weapon at `target`, applying the shot, cooldown, and (for a
  // sieged tank) splash to nearby enemy ground units. `d` is UNITS[u.type].
  fireAt(u, target, d) {
    u.cooldown = this.unitCooldown(u);
    const dmg = this.unitDmg(u, target);
    target.hp -= dmg;
    if (target.unit) target.lastDmg = this.tick;
    this.events.push({
      t: "shot", fx: u.x, fy: u.y, tx: target.x, ty: target.y,
      owner: u.owner, ranged: this.unitRange(u) > FP, air: !!target.fly,
      attackerId: u.id, targetId: target.id, tOwner: target.owner,
      siege: u.type === "tank" && u.sieged ? 1 : 0,
      burrow: u.type === "sluice" && u.burrowed ? 1 : 0,
    });
    // sieged-tank / burrowed-sluice splash: all OTHER enemy ground units within
    // 1 tile of the impact take splash damage too (deterministic id order).
    if ((u.type === "tank" && u.sieged || u.type === "sluice" && u.burrowed) && !target.fly) {
      const a = u.type === "tank" ? ABILITIES.siege : ABILITIES.burrow;
      const r = a.splash * FP;
      for (const e of this.entities) {
        if (e === target || !e.unit || e.fly || e.owner < 0 || e.owner === u.owner || e.hp <= 0) continue;
        if (dist2(target.x, target.y, e.x, e.y) <= r * r) {
          e.hp -= a.splashDmg;
          e.lastDmg = this.tick;
          this.events.push({
            t: "shot", fx: u.x, fy: u.y, tx: e.x, ty: e.y,
            owner: u.owner, ranged: true, air: false,
            attackerId: u.id, targetId: e.id, tOwner: e.owner, siege: 1, splash: 1, burrow: u.type === "sluice" ? 1 : 0,
          });
        }
      }
    }
  }

  acquireTarget(u, range) {
    // nearest visible enemy this unit can actually hit; deterministic because
    // entities iterate in id order. A sieged tank skips targets inside its
    // minimum range (they can't be shot).
    return this.nearestEntity(u.x, u.y, range, (e) =>
      e.owner >= 0 && e.owner !== u.owner && e.hp > 0 &&
      this.canHit(u, e) && this.canSiegeHit(u, e) && this.isVisible(u.owner, e.x, e.y));
  }

  // ---------- movement ----------

  // Distance from a unit to an entity's *edge* (not its center). Buildings
  // use rectangle distance so diagonal approaches aren't penalized — with
  // center-minus-radius a worker at a 3x3 building's corner reads ~1.3 tiles
  // away and can never satisfy a 0.5-tile arrival check (the old oscillation
  // bug: it kept walking into the footprint and getting ejected).
  gapTo(u, e) {
    if (e.building) {
      const half = (e.size * FP) >> 1;
      const dx = Math.max(0, Math.abs(u.x - e.x) - half);
      const dy = Math.max(0, Math.abs(u.y - e.y) - half);
      return isqrt(dx * dx + dy * dy);
    }
    return dist(u.x, u.y, e.x, e.y) - (e.radius || 0);
  }

  // Returns true when arrived. `chasing` allows periodic repathing toward a
  // moving target and short beelines — but never a beeline into a blocked
  // tile (that walks units onto building footprints, where the separation
  // pass ejects them and they thrash back and forth).
  travelTo(u, x, y, speed, chasing) {
    const far = dist2(u.x, u.y, x, y);
    if (far <= FP * FP / 16) { u.path = null; return true; }

    // Ground units slow on ramps: the sim moves in 2D at a constant tile
    // rate, but a ramp also gains elevation, so at constant 2D speed a unit
    // visibly races up the slope. Slowing it here keeps ramp travel looking
    // right and makes ramps the tactical slow-chokes they should be.
    // (Deterministic: rampTiles + fpToTile are integer sim data.)
    if (!u.fly && this.map.rampTiles &&
        this.map.rampTiles[fpToTile(u.y) * this.map.w + fpToTile(u.x)]) {
      speed = (speed * 60 / 100) | 0;
    }

    // Flyers ignore terrain entirely: straight-line beeline every tick, no
    // pathfinding and no blocked-tile ejection (they live on the air layer).
    if (u.fly) {
      const dd = dist(u.x, u.y, x, y);
      if (dd <= speed) { u.x = this.clampX(x); u.y = this.clampY(y); return true; }
      u.x = this.clampX(u.x + (((x - u.x) * speed / dd) | 0));
      u.y = this.clampY(u.y + (((y - u.y) * speed / dd) | 0));
      return false;
    }

    if (!u.path || (chasing && this.tick % 8 === 0 && dist2(u.path[u.path.length - 1].x, u.path[u.path.length - 1].y, x, y) > FP * FP)) {
      const destBlocked = this.blocked[fpToTile(y) * this.map.w + fpToTile(x)];
      if (chasing && far < 9 * FP * FP && !destBlocked) {
        u.path = [{ x, y }]; // close chase of a reachable point: beeline
      } else {
        u.path = findPath(this.blocked, this.map.w, this.map.h, u.x, u.y, x, y);
        if (!u.path) { u.order = { kind: "idle" }; return false; }
      }
      u.pathI = 0; u.wpI = -1; u.noProg = 0;
    }

    const wp = u.path[u.pathI];
    const dd = dist(u.x, u.y, wp.x, wp.y);
    if (dd <= Math.max(speed, HALF >> 1)) {
      u.x = wp.x; u.y = wp.y;
      u.noProg = 0; u.wpI = -1;                     // reached a waypoint = progress
      if (++u.pathI >= u.path.length) { u.path = null; return true; }
    } else {
      u.x += ((wp.x - u.x) * speed / dd) | 0;
      u.y += ((wp.y - u.y) * speed / dd) | 0;
      // Anti-stuck: if we're not getting meaningfully closer to the waypoint —
      // because the separation pass keeps ejecting us off a barrier we've
      // drifted onto, so the straight-line to the waypoint clips a blocked tile
      // (the thrash the LOS smoother warns about) — recompute the path from where
      // we actually are. A* routes around the obstacle. Truly-blocked units fall
      // through to findPath's null -> idle rather than thrashing forever.
      const near = dist(u.x, u.y, wp.x, wp.y);      // distance AFTER moving
      if (u.wpI === u.pathI && near >= u.wpDist - (HALF >> 3)) {
        if (++u.noProg >= 12) { u.path = null; u.noProg = 0; u.wpI = -1; return false; }
      } else {
        u.noProg = 0;
      }
      u.wpDist = near; u.wpI = u.pathI;
    }
    return false;
  }

  // ---------- spatial hash grid ----------
  buildSpatialHash() {
    const cs = 2;
    this._shCs = cs;
    const gw = Math.ceil(this.map.w / cs) + 1;
    const gh = Math.ceil(this.map.h / cs) + 1;
    this._shGw = gw;
    this._shCells = new Array(gw * gh);
    for (let i = 0; i < gw * gh; i++) this._shCells[i] = null;
    for (const e of this.entities) {
      if (!e.unit) continue;
      const cx = (fpToTile(e.x) / cs) | 0;
      const cy = (fpToTile(e.y) / cs) | 0;
      const idx = cy * gw + cx;
      if (!this._shCells[idx]) this._shCells[idx] = [];
      this._shCells[idx].push(e);
    }
  }

  shNeighbors(x, y) {
    const cs = this._shCs, gw = this._shGw;
    const cx = (fpToTile(x) / cs) | 0;
    const cy = (fpToTile(y) / cs) | 0;
    const out = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ix = cx + dx, iy = cy + dy;
        if (ix < 0 || iy < 0) continue;
        const cell = this._shCells[iy * gw + ix];
        if (cell) for (let k = 0; k < cell.length; k++) out.push(cell[k]);
      }
    }
    return out;
  }

  separate() {
    this.buildSpatialHash();
    const cs = this._shCs, gw = this._shGw;
    const cells = this._shCells;
    for (let ci = 0; ci < cells.length; ci++) {
      const cell = cells[ci];
      if (!cell) continue;
      for (let ai = 0; ai < cell.length; ai++) {
        const a = cell[ai];
        const cx = (fpToTile(a.x) / cs) | 0;
        const cy = (fpToTile(a.y) / cs) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ix = cx + dx, iy = cy + dy;
            if (ix < 0 || iy < 0) continue;
            const neighbors = cells[iy * gw + ix];
            if (!neighbors) continue;
            for (let bi = 0; bi < neighbors.length; bi++) {
              const b = neighbors[bi];
              if (b.id <= a.id) continue;
              if (!!a.fly !== !!b.fly) continue;
              const min = a.radius + b.radius;
              const ddx = a.x - b.x, ddy = a.y - b.y;
              if (Math.abs(ddx) >= min || Math.abs(ddy) >= min) continue;
              const dsq = ddx * ddx + ddy * ddy;
              if (dsq >= min * min) continue;
              let px, py;
              if (dsq === 0) { px = (a.id & 1) ? 8 : -8; py = (b.id & 1) ? 8 : -8; }
              else {
                const dd = isqrt(dsq);
                const push = (min - dd) >> 1;
                px = ((ddx * push) / dd) | 0;
                py = ((ddy * push) / dd) | 0;
              }
              a.x = this.clampX(a.x + px); a.y = this.clampY(a.y + py);
              b.x = this.clampX(b.x - px); b.y = this.clampY(b.y - py);
            }
          }
        }
      }
    }
    const { w } = this.map;
    for (const u of this.entities) {
      if (!u.unit || u.fly) continue;
      if (this.blocked[fpToTile(u.y) * w + fpToTile(u.x)]) {
        const free = nearestFree(this.blocked, w, this.map.h, fpToTile(u.x), fpToTile(u.y));
        if (free) { u.x = tileToFp(free.x); u.y = tileToFp(free.y); }
      }
    }
  }

  // ---------- fog of war ----------

  updateFog() {
    const { w, h } = this.map;
    const height = this.map.height;             // Uint8Array or undefined
    const losBlock = this.map.losBlock;         // Uint8Array or undefined
    for (let pid = 0; pid < 2; pid++) {
      const f = this.fog[pid];
      for (let i = 0; i < f.length; i++) if (f[i] === 2) f[i] = 1;
      for (const e of this.entities) {
        if (e.owner !== pid) continue;
        // construction sites grant no vision — otherwise half-built depots
        // could be scattered around the map as cheap wards
        if (e.building && !e.done) continue;
        const sight = e.unit ? UNITS[e.type].sight : BUILDINGS[e.type].sight;
        const cx = fpToTile(e.x), cy = fpToTile(e.y);
        const tile = cy * w + cx;
        // reuse the cached reveal set when the viewer hasn't changed tiles
        // (buildings never move; most units hold a tile for several updates)
        if (e._losTile === tile && e._losTiles) {
          const arr = e._losTiles;
          for (let k = 0; k < arr.length; k++) f[arr[k]] = 2;
          continue;
        }
        const revealed = this.raycastVision(cx, cy, sight, !!e.fly, height, losBlock);
        for (let k = 0; k < revealed.length; k++) f[revealed[k]] = 2;
        e._losTile = tile;
        e._losTiles = revealed;
      }
      // buildings a player has actually laid eyes on stay drawn under fog
      // (terrain is revealed from the start, but structures must be scouted)
      for (const e of this.entities) {
        if (!e.building || e.owner < 0 || e.owner === pid) continue;
        if (f[fpToTile(e.y) * w + fpToTile(e.x)] === 2) e.seenBy = (e.seenBy || 0) | (1 << pid);
      }
    }
  }

  // Tiles visible from (cx,cy) within `sight`, honoring height/blocker LoS.
  // A ray to a target tile is clear iff no INTERMEDIATE tile (excluding the
  // target itself) is higher than the viewer or flagged as a vision blocker.
  // Flyers see as if at height 99 (over every cliff/blocker). Integer-only DDA
  // sampling — deterministic. Returns an array of tile indices.
  raycastVision(cx, cy, sight, fly, height, losBlock) {
    const { w, h } = this.map;
    const viewerH = fly ? 99 : (height ? height[cy * w + cx] : 0);
    const r2 = sight * sight;
    const out = [];
    const x0min = Math.max(0, cx - sight), x0max = Math.min(w - 1, cx + sight);
    const y0min = Math.max(0, cy - sight), y0max = Math.min(h - 1, cy + sight);
    for (let ty = y0min; ty <= y0max; ty++) {
      for (let tx = x0min; tx <= x0max; tx++) {
        const dx = tx - cx, dy = ty - cy;
        if (dx * dx + dy * dy > r2) continue;
        if (this.rayClear(cx, cy, tx, ty, viewerH, height, losBlock, w)) out.push(ty * w + tx);
      }
    }
    return out;
  }

  // Integer supercover-ish DDA from (cx,cy) to (tx,ty). Steps in unit fractions
  // of the longer axis and blocks on any intermediate tile that is a blocker or
  // higher than the viewer. The target tile itself is never treated as a
  // blocker (you can see the cliff/blocker face but not past it).
  rayClear(cx, cy, tx, ty, viewerH, height, losBlock, w) {
    const ddx = tx - cx, ddy = ty - cy;
    const steps = Math.max(Math.abs(ddx), Math.abs(ddy));
    if (steps <= 1) return true;                 // adjacent/self: always clear
    // Sample the segment at each of the (steps-1) interior points. Round to the
    // nearest tile with integer math: floor((ddx*i + steps/2) / steps).
    const halfN = steps >> 1;
    for (let i = 1; i < steps; i++) {
      const sx = cx + (((ddx * i + (ddx >= 0 ? halfN : -halfN)) / steps) | 0);
      const sy = cy + (((ddy * i + (ddy >= 0 ? halfN : -halfN)) / steps) | 0);
      if (sx === tx && sy === ty) continue;      // never block on the target
      const idx = sy * w + sx;
      if (losBlock && losBlock[idx]) return false;
      if (height && height[idx] > viewerH) return false;
    }
    return true;
  }

  // ---------- end conditions & desync detection ----------

  checkGameOver() {
    if (this.noGameOver || this.winner >= 0 || this.tick < 10) return;
    const alive = [0, 0];
    for (const e of this.entities) {
      if (e.building && e.owner >= 0) alive[e.owner]++;
    }
    if (alive[0] === 0) this.winner = 1;
    else if (alive[1] === 0) this.winner = 0;
    if (this.winner >= 0) this.events.push({ t: "gameover", winner: this.winner });
  }

  checksum() {
    const h = makeHash();
    h.mix(this.tick);
    h.mix(this.minerals[0]); h.mix(this.minerals[1]);
    h.mix(this.gas[0]); h.mix(this.gas[1]);
    h.mix(this.upgrades[0]); h.mix(this.upgrades[1]);
    // Goo grid checksum: sample tiles near sources for deterministic sync
    const { w } = this.map;
    for (let i = 0; i < this.gooGrid.length; i += 13) h.mix(this.gooGrid[i]); // sparse sample
    for (const src of this._gooSources) h.mix(src.id);
    h.mix(this.gooNoiseI); // noise-cursor drift = goo divergence, caught here
    for (const e of this.entities) {
      h.mix(e.id); h.mix(e.x); h.mix(e.y); h.mix(e.hp | 0);
      if (e.amount !== undefined) h.mix(e.amount | 0);
      if (e.unit) {
        h.mix(e.abilityCd | 0); h.mix(e.sieged | 0);
        h.mix(e.burrowed | 0);
        h.mix(e.cooldown | 0); h.mix(e.carry | 0); h.mix(e.carryKind | 0);
        h.mix(e.gatherTimer | 0);
        h.mix(e.stimUntil | 0); h.mix(e.burnUntil | 0);
        h.mix(e.transformUntil | 0); h.mix(e.leapUntil | 0);
        h.mix(e.channelUntil | 0); h.mix(e.noProg | 0);
        h.mix(e.lastDmg | 0);
        h.mix(e.order?.kind?.charCodeAt(0) || 0);
        h.mix(e.order?.targetId || 0);
      }
      if (e.building) {
        h.mix(e.done ? 1 : 0); h.mix(e.progress | 0);
        h.mix(e.cooldown | 0); h.mix(e.queue.length);
        h.mix(e.geyserId | 0);
        const head = e.queue[0];
        if (head) { h.mix(head.type?.charCodeAt(0) || 0); h.mix(head.remaining | 0); }
        if (e.rally) { h.mix(e.rally.x); h.mix(e.rally.y); h.mix(e.rally.targetId || 0); }
      }
    }
    return h.value();
  }
}
