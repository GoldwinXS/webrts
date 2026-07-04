// Skirmish AI. Issues the same commands a human would, through the same
// command pipeline, so the sim stays authoritative. Rule-based build order:
// saturate minerals -> keep supply ahead -> barracks -> army -> attack waves.
import { FP, tileToFp, fpToTile, dist2 } from "./fixed.js";
import { UNITS, BUILDINGS, UPGRADES, UPGRADE_BITS } from "./data.js";

export class AI {
  constructor(pid) {
    this.pid = pid;
    this.nextWave = 1200;      // first attack around 2 min
    this.waveSize = 8;
    this.tankIdleSince = {};   // tankId -> tick nothing was near (for unsiege)
  }

  // Called every tick; returns a command list (usually empty).
  update(sim) {
    if (sim.tick % 10 !== 0 || sim.winner >= 0) return [];
    const cmds = [];

    // Single-pass entity bucketing (replaces 8+ filter() calls)
    const workers = [], army = [], hqs = [], barracks = [], refineries = [];
    const factories = [], starports = [], turrets = [], sites = [];
    let enemyBuilding = null;
    for (const e of sim.entities) {
      if (e.owner === this.pid) {
        if (e.unit) {
          if (e.type === "worker") workers.push(e);
          else army.push(e);
        } else if (e.building) {
          if (!e.done) { sites.push(e); continue; }
          switch (e.type) {
            case "hq": hqs.push(e); break;
            case "barracks": barracks.push(e); break;
            case "refinery": refineries.push(e); break;
            case "factory": factories.push(e); break;
            case "starport": starports.push(e); break;
            case "turret": turrets.push(e); break;
          }
        }
      } else if (e.building && e.owner >= 0 && e.owner !== this.pid && !enemyBuilding) {
        enemyBuilding = e;
      }
    }
    const barracksDone = barracks.some((b) => b.done);
    const s = sim.supplyOf(this.pid);
    if (!hqs.length) return cmds;
    const hq = hqs[0];
    const own = this.pid;

    // 1. idle workers go mine
    for (const w of workers) {
      if (w.order.kind === "idle") {
        const patch = sim.nearestEntity(w.x, w.y, FP * 16, (e) => e.type === "mineral" && e.amount > 0);
        if (patch) cmds.push({ t: "gather", ids: [w.id], targetId: patch.id });
      }
    }

    // 2. keep training workers up to 14
    if (workers.length < 14 && hq.queue.length === 0 && sim.canAfford(this.pid, UNITS.worker.cost) && s.used + 1 <= s.cap) {
      cmds.push({ t: "train", buildingId: hq.id, unit: "worker" });
    }

    // 3. supply ahead of demand
    const supplyComing = sites.some((b) => b.type === "depot");
    if (s.cap - s.used < 4 && s.cap < 200 && !supplyComing && sim.canAfford(this.pid, BUILDINGS.depot.cost)) {
      this.tryBuild(sim, cmds, workers, "depot", hq);
    }

    // 4. up to 3 barracks once economy is going
    const racksComing = sites.some((b) => b.type === "barracks");
    if (workers.length >= 10 && barracks.length < 3 && !racksComing && sim.canAfford(this.pid, BUILDINGS.barracks.cost + 50)) {
      this.tryBuild(sim, cmds, workers, "barracks", hq);
    }

    // 4b. one refinery once a barracks exists, then keep ~3 workers on gas
    const refineryComing = sites.some((b) => b.type === "refinery");
    if (barracksDone && refineries.length === 0 && !refineryComing &&
        sim.canAfford(this.pid, BUILDINGS.refinery.cost)) {
      this.tryBuildRefinery(sim, cmds, workers);
    }
    // keep any half-built refinery progressing: if no worker is currently
    // constructing it, send one (workers get stolen back to mining otherwise).
    for (const site of sites) {
      if (site.type !== "refinery") continue;
      const hasBuilder = workers.some((w) => w.order.kind === "build" && w.order.targetId === site.id);
      if (!hasBuilder) {
        const w = workers.find((x) => x.order.kind === "gather" || x.order.kind === "idle");
        if (w) cmds.push({ t: "resume", ids: [w.id], targetId: site.id });
      }
    }
    const doneRefineries = refineries;
    if (doneRefineries.length) {
      const ref = doneRefineries[0];
      const onGas = workers.filter((w) =>
        w.order.kind === "gather" && w.order.resource === "gas").length;
      if (onGas < 3) {
        // pull an idle/mineral worker onto gas
        const w = workers.find((w) =>
          w.order.kind === "idle" ||
          (w.order.kind === "gather" && w.order.resource !== "gas"));
        if (w) cmds.push({ t: "gather", ids: [w.id], targetId: ref.id });
      }
    }

    // 4c. a factory once a barracks is up and gas is flowing
    const factoryComing = sites.some((b) => b.type === "factory");
    if (barracksDone && factories.length === 0 && !factoryComing &&
        sim.canAfford(this.pid, BUILDINGS.factory.cost, BUILDINGS.factory.gasCost)) {
      this.tryBuild(sim, cmds, workers, "factory", hq);
    }

    // 4d. a starport once a factory is done (unlocks air units)
    const starportComing = sites.some((b) => b.type === "starport");
    const factoryDone = factories.some((f) => f.done);
    if (factoryDone && starports.length === 0 && !starportComing &&
        sim.canAfford(this.pid, BUILDINGS.starport.cost, BUILDINGS.starport.gasCost)) {
      this.tryBuild(sim, cmds, workers, "starport", hq);
    }

    // 4e. build 1-2 turrets for base defense once a barracks is up
    const turretComing = sites.some((b) => b.type === "turret");
    if (barracksDone && turrets.length < 2 && !turretComing &&
        sim.canAfford(this.pid, BUILDINGS.turret.cost)) {
      this.tryBuild(sim, cmds, workers, "turret", hq);
    }

    // 5. train army: mostly marines, some brutes.
    for (const r of barracks) {
      if (!r.done || r.queue.length > 1) continue;
      const type = (sim.tick % 40 === 0) ? "brute" : "marine";
      const d = UNITS[type];
      if (sim.canAfford(this.pid, d.cost, d.gasCost || 0) && s.used + d.supply <= s.cap) {
        cmds.push({ t: "train", buildingId: r.id, unit: type });
      }
    }
    // 5b. one tank per factory when we can afford the gas
    for (const fac of factories) {
      if (!fac.done || fac.queue.length > 0) continue;
      const d = UNITS.tank;
      if (sim.canAfford(this.pid, d.cost, d.gasCost || 0) && s.used + d.supply <= s.cap) {
        cmds.push({ t: "train", buildingId: fac.id, unit: "tank" });
      }
    }
    // 5c. air units: mix wraiths and banshees from starports
    for (const sp of starports) {
      if (!sp.done || sp.queue.length > 0) continue;
      const type = (sim.tick % 60 === 0) ? "banshee" : "wraith";
      const d = UNITS[type];
      if (sim.canAfford(this.pid, d.cost, d.gasCost || 0) && s.used + d.supply <= s.cap) {
        cmds.push({ t: "train", buildingId: sp.id, unit: type });
      }
    }

    // 5d. research: stims, siegetech, afterburners
    if (barracksDone && doneRefineries.length && !(sim.upgrades[own] & UPGRADE_BITS.stims) &&
        !sim.upgradeQueued(own, "stims")) {
      const bk = barracks.find((b) => b.done && b.queue.length < 2);
      const u = UPGRADES.stims;
      if (bk && sim.canAfford(own, u.cost, u.gasCost)) cmds.push({ t: "research", buildingId: bk.id, research: "stims" });
    }
    if (factories.some((f) => f.done) && !(sim.upgrades[own] & UPGRADE_BITS.siegetech) &&
        !sim.upgradeQueued(own, "siegetech")) {
      const fac = factories.find((f) => f.done && f.queue.length < 2);
      const u = UPGRADES.siegetech;
      if (fac && sim.canAfford(own, u.cost, u.gasCost)) cmds.push({ t: "research", buildingId: fac.id, research: "siegetech" });
    }
    if (starports.some((sp) => sp.done) && !(sim.upgrades[own] & UPGRADE_BITS.afterburners) &&
        !sim.upgradeQueued(own, "afterburners")) {
      const sp = starports.find((sp) => sp.done && sp.queue.length < 2);
      const u = UPGRADES.afterburners;
      if (sp && sim.canAfford(own, u.cost, u.gasCost)) cmds.push({ t: "research", buildingId: sp.id, research: "afterburners" });
    }

    // 5e. ability micro. Stim marines near enemy buildings.
    if (sim.upgrades[own] & UPGRADE_BITS.stims) {
      const marines = army.filter((u) => u.type === "marine" && u.abilityCd === 0 &&
        sim.tick >= (u.stimUntil || 0) && u.hp > 12);
      if (enemyBuilding && marines.length) {
        const near = marines.filter((u) => dist2(u.x, u.y, enemyBuilding.x, enemyBuilding.y) <= (FP * 8) * (FP * 8));
        if (near.length) cmds.push({ t: "ability", ids: near.map((u) => u.id), ability: "stim" });
      }
    }
    if (sim.upgrades[own] & UPGRADE_BITS.siegetech) {
      for (const tank of army.filter((u) => u.type === "tank")) {
        if (sim.tick < tank.transformUntil) continue;
        const enemiesNear7 = sim.entities.filter((e) => e.owner >= 0 && e.owner !== own && e.unit &&
          dist2(tank.x, tank.y, e.x, e.y) <= (FP * 7) * (FP * 7)).length;
        const anyNear10 = sim.entities.some((e) => e.owner >= 0 && e.owner !== own && e.unit &&
          dist2(tank.x, tank.y, e.x, e.y) <= (FP * 10) * (FP * 10));
        if (!tank.sieged && enemiesNear7 >= 2 && tank.abilityCd === 0) {
          cmds.push({ t: "ability", ids: [tank.id], ability: "siege" });
          delete this.tankIdleSince[tank.id];
        } else if (tank.sieged) {
          if (anyNear10) delete this.tankIdleSince[tank.id];
          else {
            if (this.tankIdleSince[tank.id] === undefined) this.tankIdleSince[tank.id] = sim.tick;
            if (sim.tick - this.tankIdleSince[tank.id] >= 100 && tank.abilityCd === 0) {
              cmds.push({ t: "ability", ids: [tank.id], ability: "siege" }); // unsiege
              delete this.tankIdleSince[tank.id];
            }
          }
        }
      }
    }

    // 6. defense: enemy near base -> army responds; retreat if outnumbered
    const threat = sim.nearestEntity(hq.x, hq.y, FP * 12,
      (e) => e.owner >= 0 && e.owner !== this.pid && e.unit);
    if (threat && army.length) {
      const enemyNear = sim.entities.filter((e) => e.owner >= 0 && e.owner !== own && e.unit &&
        dist2(hq.x, hq.y, e.x, e.y) <= (FP * 15) * (FP * 15)).length;
      if (enemyNear > army.length + 4) {
        const allDef = [...army, ...workers.filter((w) => w.hp > 20)];
        const rally = sim.map.starts[own];
        cmds.push({ t: "move", ids: allDef.map((u) => u.id), x: tileToFp(rally.x), y: tileToFp(rally.y) });
        return cmds;
      }
      cmds.push({ t: "attackmove", ids: army.map((u) => u.id), x: threat.x, y: threat.y });
      return cmds;
    }

    // 6b. marine kiting: back off from melee enemies after firing
    if (sim.tick % 5 === 0) {
      for (const m of army) {
        if (m.type !== "marine" || m.cooldown <= 4) continue;
        const e = sim.nearestEntity(m.x, m.y, FP * 2,
          (e) => e.owner >= 0 && e.owner !== own && e.unit && !e.fly);
        if (e && UNITS[e.type] && UNITS[e.type].range < FP) {
          const dx = m.x - e.x, dy = m.y - e.y;
          const dd = Math.max(1, Math.hypot(dx, dy));
          cmds.push({ t: "move", ids: [m.id], x: m.x + ((dx / dd * FP * 1.5) | 0), y: m.y + ((dy / dd * FP * 1.5) | 0), q: 1 });
        }
      }
    }

    // 7. attack waves, growing over time
    if (sim.tick >= this.nextWave && army.length >= this.waveSize) {
      const target = enemyBuilding
        ? { x: enemyBuilding.x, y: enemyBuilding.y }
        : this.enemyBase(sim);
      if (target) {
        cmds.push({ t: "attackmove", ids: army.map((u) => u.id), x: target.x, y: target.y });
        this.nextWave = sim.tick + 900;
        this.waveSize = Math.min(20, this.waveSize + 4);
      }
    }

    return cmds;
  }

  enemyBase(sim) {
    const enemy = sim.entities.find((e) => e.building && e.owner >= 0 && e.owner !== this.pid);
    if (enemy) return { x: enemy.x, y: enemy.y };
    const s = sim.map.starts[1 - this.pid];
    return { x: tileToFp(s.x), y: tileToFp(s.y) };
  }

  // Build a refinery on the nearest own-base geyser that has no refinery yet.
  tryBuildRefinery(sim, cmds, workers) {
    const worker = workers.find((w) => w.order.kind === "gather" || w.order.kind === "idle");
    if (!worker) return;
    // geysers sorted by distance to our start, then id — deterministic
    const start = sim.map.starts[this.pid];
    const sx = tileToFp(start.x), sy = tileToFp(start.y);
    const geysers = sim.entities
      .filter((e) => e.type === "geyser" && !sim.refineryOnGeyser(e.id))
      .sort((a, b) => dist2(sx, sy, a.x, a.y) - dist2(sx, sy, b.x, b.y) || a.id - b.id);
    for (const g of geysers) {
      if (dist2(sx, sy, g.x, g.y) > (FP * 20) * (FP * 20)) continue; // near base only
      const gx = fpToTile(g.x), gy = fpToTile(g.y);
      // try the four 2x2 origins that can cover the geyser tile
      for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
        const tx = gx + ox, ty = gy + oy;
        if (sim.canPlace("refinery", tx, ty)) {
          cmds.push({ t: "build", workerId: worker.id, building: "refinery", tx, ty });
          return;
        }
      }
    }
  }

  tryBuild(sim, cmds, workers, type, hq) {
    const worker = workers.find((w) => w.order.kind === "gather" || w.order.kind === "idle");
    if (!worker) return;
    const size = BUILDINGS[type].size;
    const htx = fpToTile(hq.x), hty = fpToTile(hq.y);
    // scan outward rings around the HQ for a free spot, deterministic order
    for (let r = 3; r < 10; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = htx + dx - (size >> 1), ty = hty + dy - (size >> 1);
          if (sim.canPlace(type, tx, ty)) {
            // avoid plugging the mineral line: stay off patch-adjacent tiles
            const cx = tx * FP + (size * FP >> 1), cy = ty * FP + (size * FP >> 1);
            const nearPatch = sim.nearestEntity(cx, cy, FP * 2, (e) => e.type === "mineral");
            if (nearPatch) continue;
            cmds.push({ t: "build", workerId: worker.id, building: type, tx, ty });
            return;
          }
        }
      }
    }
  }
}
