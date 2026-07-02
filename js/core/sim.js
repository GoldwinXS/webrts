// The deterministic simulation. All state lives here; all mutation happens in
// step(). Integer math only — see fixed.js. The renderer reads this state but
// never writes it; players interact exclusively through commands, which is
// what makes lockstep multiplayer possible.
import { FP, HALF, tileToFp, fpToTile, isqrt, dist, dist2, makeHash } from "./fixed.js";
import { UNITS, BUILDINGS, START_MINERALS, CARRY_AMOUNT, GATHER_TICKS, PATCH_AMOUNT, MAX_QUEUE } from "./data.js";
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
    this.winner = -1;
    this.events = [];

    const { w, h } = this.map;
    // pathing grid: rocks + building footprints
    this.blocked = new Uint8Array(this.map.rock);
    // fog per player: 0 unseen, 1 explored, 2 visible
    this.fog = [new Uint8Array(w * h), new Uint8Array(w * h)];

    for (const m of this.map.minerals) {
      this.addEntity({ type: "mineral", owner: -1, x: m.x, y: m.y, hp: 0, maxHp: 0, amount: PATCH_AMOUNT, radius: (FP * 0.4) | 0 });
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
      unit: true, order: { kind: "idle" }, next: [], path: null, pathI: 0,
      cooldown: 0, carry: 0, gatherTimer: 0,
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

  canAfford(pid, cost) { return this.minerals[pid] >= cost; }

  supplyOf(pid) {
    let used = 0, cap = 0;
    for (const e of this.entities) {
      if (e.owner !== pid) continue;
      if (e.unit) used += UNITS[e.type].supply;
      if (e.building) {
        if (e.done) cap += BUILDINGS[e.type].supply || 0;
        for (const q of e.queue) used += UNITS[q.type].supply;
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
    return true;
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
          if (e && e.unit) this.setOrder(e, { kind: "attack", targetId: c.targetId, resume: null }, c.q);
        }
        break;
      }
      case "gather": {
        const patch = this.byId.get(c.targetId);
        if (!patch || patch.type !== "mineral") break;
        for (const id of c.ids) {
          const e = own(id);
          if (e && e.type === "worker") {
            this.setOrder(e, { kind: "gather", targetId: c.targetId, phase: "to" }, c.q);
          }
        }
        break;
      }
      case "build": {
        const worker = own(c.workerId);
        const d = BUILDINGS[c.building];
        if (!worker || worker.type !== "worker" || !d) break;
        if (!this.canAfford(pid, d.cost) || !this.canPlace(c.building, c.tx, c.ty)) break;
        this.minerals[pid] -= d.cost;
        const site = this.spawnBuilding(pid, c.building, c.tx, c.ty, false);
        site.builderId = worker.id;
        worker.order = { kind: "build", targetId: site.id };
        worker.path = null;
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
        if (!this.canAfford(pid, d.cost)) break;
        const s = this.supplyOf(pid);
        if (s.used + d.supply > s.cap) break;
        this.minerals[pid] -= d.cost;
        b.queue.push({ type: c.unit, remaining: d.buildTime });
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
        if (d.acquire > 0) {
          const enemy = this.acquireTarget(u, d.acquire);
          if (enemy) {
            u.order = { kind: "attack", targetId: enemy.id, resume: { x: o.x, y: o.y } };
            u.path = null;
            break;
          }
        }
        if (this.travelTo(u, o.x, o.y, d.speed)) this.popNext(u);
        break;
      }

      case "attack": {
        const target = this.byId.get(o.targetId);
        if (!target || target.hp <= 0) {
          if (o.resume) {
            u.order = { kind: "attackmove", x: o.resume.x, y: o.resume.y };
            u.path = null;
          } else this.popNext(u);
          break;
        }
        const gap = this.gapTo(u, target);
        if (gap <= d.range) {
          u.path = null;
          if (u.cooldown === 0) {
            u.cooldown = d.cooldown;
            target.hp -= d.dmg;
            this.events.push({
              t: "shot", fx: u.x, fy: u.y, tx: target.x, ty: target.y,
              owner: u.owner, ranged: d.range > FP,
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
    if (!b.done || !b.queue.length) return;
    const item = b.queue[0];
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
          if (u.type === "worker" && target?.type === "mineral" && target.amount > 0) {
            u.order = { kind: "gather", targetId: target.id, phase: "to" };
          } else {
            u.order = { kind: "move", x: b.rally.x, y: b.rally.y };
          }
        } else if (item.type === "worker") {
          this.autoGather(u);
        }
      }
    }
  }

  updateGather(u, d) {
    const o = u.order;
    if (o.phase === "to") {
      const patch = this.byId.get(o.targetId);
      if (!patch || patch.amount <= 0) {
        const next = this.nearestEntity(u.x, u.y, FP * 14, (e) => e.type === "mineral" && e.amount > 0);
        if (next) { o.targetId = next.id; u.path = null; }
        else this.popNext(u);
        return;
      }
      const gap = dist(u.x, u.y, patch.x, patch.y);
      if (gap <= (FP * 0.8) | 0) {
        o.phase = "mining";
        u.gatherTimer = GATHER_TICKS;
        u.path = null;
      } else {
        this.travelTo(u, patch.x, patch.y, d.speed, true);
      }
    } else if (o.phase === "mining") {
      const patch = this.byId.get(o.targetId);
      if (!patch) { o.phase = "to"; return; }
      if (--u.gatherTimer <= 0) {
        const take = Math.min(CARRY_AMOUNT, patch.amount);
        patch.amount -= take;
        u.carry = take;
        o.phase = "return";
        u.path = null;
      }
    } else if (o.phase === "return") {
      const depot = this.nearestEntity(u.x, u.y, FP * 60,
        (e) => e.building && e.done && e.owner === u.owner && BUILDINGS[e.type].deposit);
      if (!depot) { u.order = { kind: "idle" }; return; }
      const gap = this.gapTo(u, depot);
      if (gap <= (FP * 0.75) | 0) {
        this.minerals[u.owner] += u.carry;
        u.carry = 0;
        o.phase = "to";
        u.path = null;
      } else {
        this.travelTo(u, depot.x, depot.y, d.speed); // static target: always pathfind
      }
    }
  }

  autoGather(u) {
    const patch = this.nearestEntity(u.x, u.y, FP * 12, (e) => e.type === "mineral" && e.amount > 0);
    if (patch) u.order = { kind: "gather", targetId: patch.id, phase: "to" };
  }

  acquireTarget(u, range) {
    // nearest visible enemy; deterministic because entities iterate in id order
    return this.nearestEntity(u.x, u.y, range, (e) =>
      e.owner >= 0 && e.owner !== u.owner && e.hp > 0 &&
      this.isVisible(u.owner, e.x, e.y));
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
    // keep units off blocked tiles after pushes
    const { w } = this.map;
    for (const u of es) {
      if (!u.unit) continue;
      if (this.blocked[fpToTile(u.y) * w + fpToTile(u.x)]) {
        const free = nearestFree(this.blocked, w, this.map.h, fpToTile(u.x), fpToTile(u.y));
        if (free) { u.x = tileToFp(free.x); u.y = tileToFp(free.y); }
      }
    }
  }

  // ---------- fog of war ----------

  updateFog() {
    const { w, h } = this.map;
    for (let pid = 0; pid < 2; pid++) {
      const f = this.fog[pid];
      for (let i = 0; i < f.length; i++) if (f[i] === 2) f[i] = 1;
      for (const e of this.entities) {
        if (e.owner !== pid) continue;
        const sight = e.unit ? UNITS[e.type].sight : BUILDINGS[e.type].sight;
        const cx = fpToTile(e.x), cy = fpToTile(e.y);
        const r2 = sight * sight;
        for (let y = Math.max(0, cy - sight); y <= Math.min(h - 1, cy + sight); y++) {
          for (let x = Math.max(0, cx - sight); x <= Math.min(w - 1, cx + sight); x++) {
            const dx = x - cx, dy = y - cy;
            if (dx * dx + dy * dy <= r2) f[y * w + x] = 2;
          }
        }
      }
    }
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
    for (const e of this.entities) {
      h.mix(e.id); h.mix(e.x); h.mix(e.y); h.mix(e.hp | 0);
    }
    return h.value();
  }
}
