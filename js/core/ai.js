// Skirmish AI. Issues the same commands a human would, through the same
// command pipeline, so the sim stays authoritative. Rule-based build order:
// saturate minerals -> keep supply ahead -> barracks -> army -> attack waves.
import { FP, tileToFp, fpToTile, dist2 } from "./fixed.js";
import { UNITS, BUILDINGS } from "./data.js";

export class AI {
  constructor(pid) {
    this.pid = pid;
    this.nextWave = 1200;      // first attack around 2 min
    this.waveSize = 8;
  }

  // Called every tick; returns a command list (usually empty).
  update(sim) {
    if (sim.tick % 10 !== 0 || sim.winner >= 0) return [];
    const cmds = [];
    const mine = sim.entities.filter((e) => e.owner === this.pid);
    const workers = mine.filter((e) => e.type === "worker");
    const army = mine.filter((e) => e.unit && e.type !== "worker");
    const hqs = mine.filter((e) => e.type === "hq" && e.done);
    const barracks = mine.filter((e) => e.type === "barracks");
    const sites = mine.filter((e) => e.building && !e.done);
    const s = sim.supplyOf(this.pid);
    if (!hqs.length) return cmds;
    const hq = hqs[0];

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

    // 5. train army: mostly marines, some brutes
    for (const r of barracks) {
      if (!r.done || r.queue.length > 1) continue;
      const type = (sim.tick % 40 === 0) ? "brute" : "marine";
      const d = UNITS[type];
      if (sim.canAfford(this.pid, d.cost) && s.used + d.supply <= s.cap) {
        cmds.push({ t: "train", buildingId: r.id, unit: type });
      }
    }

    // 6. defense: enemy near base -> everyone in the army responds
    const threat = sim.nearestEntity(hq.x, hq.y, FP * 12,
      (e) => e.owner >= 0 && e.owner !== this.pid && e.unit);
    if (threat && army.length) {
      cmds.push({ t: "attackmove", ids: army.map((u) => u.id), x: threat.x, y: threat.y });
      return cmds;
    }

    // 7. attack waves, growing over time
    if (sim.tick >= this.nextWave && army.length >= this.waveSize) {
      const target = this.enemyBase(sim);
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
