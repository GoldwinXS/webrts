// The deterministic simulation. All state lives here; all mutation happens in
// step(). Integer math only — see fixed.js. The renderer reads this state but
// never writes it; players interact exclusively through commands, which is
// what makes lockstep multiplayer possible.
import { FP, HALF, tileToFp, fpToTile, isqrt, dist, dist2, makeHash } from "./fixed.js";
import { UNITS, BUILDINGS, START_MINERALS, START_GAS, CARRY_AMOUNT, GATHER_TICKS, PATCH_AMOUNT, MAX_QUEUE,
  GAS_CARRY, GAS_GATHER_TICKS, GAS_AMOUNT, GAS_DEPLETED, HQ_RESOURCE_CLEARANCE } from "./data.js";
import { generateMap } from "./map.js";
import { findPath, nearestFree } from "./path.js";

export class Sim {
  constructor(seed) {
    this.seed = seed;
    this.map = generateMap(seed);
    this.tick = 0;
    this.nextId = 1;
    this.entities = [];
    this.byId = new Map();
    this.minerals = [START_MINERALS, START_MINERALS];
    this.gas = [START_GAS, START_GAS];
    this.winner = -1;
    this.events = [];

    const { w, h } = this.map;
    // pathing grid: rocks + building footprints
    this.blocked = new Uint8Array(this.map.rock);
    // fog per player: 1 explored (grey), 2 visible. The whole map starts
    // explored — terrain is revealed, only current activity is hidden.
    // (0 = unseen black is reserved for future campaign maps.)
    this.fog = [new Uint8Array(w * h).fill(1), new Uint8Array(w * h).fill(1)];

    for (const m of this.map.minerals) {
      this.addEntity({ type: "mineral", owner: -1, x: m.x, y: m.y, hp: 0, maxHp: 0, amount: PATCH_AMOUNT, radius: (FP * 0.4) | 0 });
    }
    // Vespene geysers: non-blocking resource nodes. Placed at fp tile centers.
    // (map.js may not emit geysers yet — code defensively.)
    for (const g of (this.map.geysers || [])) {
      this.addEntity({ type: "geyser", owner: -1, x: g.x, y: g.y, hp: 0, maxHp: 0, amount: GAS_AMOUNT, radius: (FP * 0.45) | 0, geyser: true });
    }
    for (let pid = 0; pid < 2; pid++) {
      const s = this.map.starts[pid];
      this.spawnBuilding(pid, "hq", s.x - 1, s.y - 1, true);
      for (let i = 0; i < 5; i++) {
        const u = this.spawnUnit(pid, "worker", tileToFp(s.x + 2 + (i % 3)), tileToFp(s.y + 2 + ((i / 3) | 0)));
        this.autoGather(u);
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
    return this.addEntity({
      type, owner: pid, x, y, hp: d.hp, maxHp: d.hp, radius: d.radius,
      unit: true, fly: !!d.fly, order: { kind: "idle" }, next: [], path: null, pathI: 0,
      cooldown: 0, carry: 0, carryKind: 0, gatherTimer: 0,
    });
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
        if (head?.started) used += UNITS[head.type].supply;
      }
    }
    return { used, cap: Math.min(cap, 200) };
  }

  nearestEntity(x, y, maxDist, pred) {
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
    for (let y = ty; y < ty + d.size; y++)
      for (let x = tx; x < tx + d.size; x++)
        if (this.blocked[y * w + x]) return false;
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
      if (e.type === "refinery" && e.geyserId === geyserId) return true;
    }
    return false;
  }

  // ---------- commands ----------
  // bundle: [{pid, cmds:[...]}] applied in pid order — deterministic.

  step(bundle) {
    this.events.length = 0;
    for (const e of this.entities) { e.px = e.x; e.py = e.y; }

    if (bundle) {
      for (const group of bundle) {
        for (const c of group.cmds) this.applyCommand(group.pid, c);
      }
    }

    for (const e of this.entities) {
      if (e.unit) this.updateUnit(e);
      else if (e.building) this.updateBuilding(e);
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
      case "gather": {
        const patch = this.byId.get(c.targetId);
        if (!patch) break;
        // minerals: any patch. gas: an OWN finished refinery.
        let resource;
        if (patch.type === "mineral") resource = "minerals";
        else if (patch.type === "refinery" && patch.owner === pid && patch.done) resource = "gas";
        else break;
        for (const id of c.ids) {
          const e = own(id);
          if (e && e.type === "worker") {
            this.setOrder(e, { kind: "gather", targetId: c.targetId, phase: "to", resource }, c.q);
          }
        }
        break;
      }
      case "build": {
        const worker = own(c.workerId);
        const d = BUILDINGS[c.building];
        if (!worker || worker.type !== "worker" || !d) break;
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
      case "resume": {
        // send workers (back) to an unfinished building of ours
        const site = this.byId.get(c.targetId);
        if (!site || !site.building || site.owner !== pid || site.done) break;
        for (const id of c.ids) {
          const e = own(id);
          if (e && e.type === "worker") this.setOrder(e, { kind: "build", targetId: site.id }, c.q);
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
    }
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
    const d = UNITS[u.type];
    const o = u.order;

    switch (o.kind) {
      case "idle":
        if (d.acquire > 0) {
          const enemy = this.acquireTarget(u, d.acquire);
          if (enemy) u.order = { kind: "attack", targetId: enemy.id, resume: null };
        }
        break;

      case "move":
        if (this.travelTo(u, o.x, o.y, d.speed)) this.popNext(u);
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
        if (this.travelTo(u, o.x, o.y, d.speed)) this.popNext(u);
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
        if (this.travelTo(u, o.x, o.y, d.speed)) {
          // arrived: swing back the other way
          u.order = { kind: "patrol", x: o.ox, y: o.oy, ox: o.x, oy: o.y };
        }
        break;
      }

      case "hold": {
        // stand ground: fire at anything in weapon range, never chase
        if ((d.dmg > 0 || d.dmgAir > 0) && u.cooldown === 0) {
          const target = this.acquireTarget(u, d.range + HALF);
          if (target && this.gapTo(u, target) <= d.range) {
            u.cooldown = d.cooldown;
            const dmg = target.fly ? d.dmgAir : d.dmg;
            target.hp -= dmg;
            this.events.push({
              t: "shot", fx: u.x, fy: u.y, tx: target.x, ty: target.y,
              owner: u.owner, ranged: d.range > FP, air: !!target.fly,
              attackerId: u.id, targetId: target.id, tOwner: target.owner,
            });
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
        const gap = this.gapTo(u, target);
        if (gap <= d.range) {
          u.path = null;
          if (u.cooldown === 0) {
            u.cooldown = d.cooldown;
            const dmg = target.fly ? d.dmgAir : d.dmg;
            target.hp -= dmg;
            this.events.push({
              t: "shot", fx: u.x, fy: u.y, tx: target.x, ty: target.y,
              owner: u.owner, ranged: d.range > FP, air: !!target.fly,
              attackerId: u.id, targetId: target.id, tOwner: target.owner,
            });
          }
        } else {
          this.travelTo(u, target.x, target.y, d.speed, true);
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
    if (!b.done) return;
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
        const u = this.spawnUnit(b.owner, item.type, tileToFp(spot.x), tileToFp(spot.y));
        this.events.push({ t: "trained", id: u.id, owner: b.owner, type: item.type, x: u.x, y: u.y });
        // send the fresh unit to the rally point (workers rally onto minerals)
        if (b.rally) {
          const target = b.rally.targetId ? this.byId.get(b.rally.targetId) : null;
          if (u.type === "worker" && target?.type === "mineral") {
            // rally onto minerals: balance across the line, not one patch
            const patch = this.pickPatch(target, FP * 6) || (target.amount > 0 ? target : null);
            if (patch) u.order = { kind: "gather", targetId: patch.id, phase: "to", resource: "minerals" };
          } else {
            u.order = { kind: "move", x: b.rally.x, y: b.rally.y };
          }
        } else if (item.type === "worker") {
          this.autoGather(u);
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
        // refinery destroyed: give up (worker can't re-target a geyser itself)
        if (!node || node.type !== "refinery" || !node.done) { this.popNext(u); return; }
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

  acquireTarget(u, range) {
    // nearest visible enemy this unit can actually hit; deterministic because
    // entities iterate in id order
    return this.nearestEntity(u.x, u.y, range, (e) =>
      e.owner >= 0 && e.owner !== u.owner && e.hp > 0 &&
      this.canHit(u, e) && this.isVisible(u.owner, e.x, e.y));
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
      u.pathI = 0;
    }

    const wp = u.path[u.pathI];
    const dd = dist(u.x, u.y, wp.x, wp.y);
    if (dd <= Math.max(speed, HALF >> 1)) {
      u.x = wp.x; u.y = wp.y;
      if (++u.pathI >= u.path.length) { u.path = null; return true; }
    } else {
      u.x += ((wp.x - u.x) * speed / dd) | 0;
      u.y += ((wp.y - u.y) * speed / dd) | 0;
    }
    return false;
  }

  // Push overlapping units apart. Pairwise in id order — deterministic.
  separate() {
    const es = this.entities;
    for (let i = 0; i < es.length; i++) {
      const a = es[i];
      if (!a.unit) continue;
      for (let j = i + 1; j < es.length; j++) {
        const b = es[j];
        if (!b.unit) continue;
        // separation is layered: air pushes air, ground pushes ground, and the
        // two never shove each other (a flyer can hover over a tank)
        if (!!a.fly !== !!b.fly) continue;
        const min = a.radius + b.radius;
        const dx = a.x - b.x, dy = a.y - b.y;
        if (Math.abs(dx) >= min || Math.abs(dy) >= min) continue;
        const dsq = dx * dx + dy * dy;
        if (dsq >= min * min) continue;
        let px, py;
        if (dsq === 0) { px = (a.id & 1) ? 8 : -8; py = (b.id & 1) ? 8 : -8; }
        else {
          const dd = isqrt(dsq);
          const push = (min - dd) >> 1;
          px = ((dx * push) / dd) | 0;
          py = ((dy * push) / dd) | 0;
        }
        a.x = this.clampX(a.x + px); a.y = this.clampY(a.y + py);
        b.x = this.clampX(b.x - px); b.y = this.clampY(b.y - py);
      }
    }
    // keep GROUND units off blocked tiles after pushes (flyers ignore terrain)
    const { w } = this.map;
    for (const u of es) {
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
    if (this.winner >= 0 || this.tick < 10) return;
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
    for (const e of this.entities) {
      h.mix(e.id); h.mix(e.x); h.mix(e.y); h.mix(e.hp | 0);
      if (e.amount !== undefined) h.mix(e.amount | 0);   // resource depletion
    }
    return h.value();
  }
}
