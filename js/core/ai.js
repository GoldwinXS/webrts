// Skirmish AI. Issues the same commands a human would, through the same
// command pipeline, so the sim stays authoritative. Rule-based build order:
// saturate minerals -> keep supply ahead -> barracks -> army -> attack waves.
import { FP, tileToFp, fpToTile, dist2 } from "./fixed.js";
import { UNITS, BUILDINGS, UPGRADES, UPGRADE_BITS, FACTIONS } from "./data.js";
import { findPath, nearestFree } from "./path.js";

// Per-difficulty tuning. The three faction branches are SHARED and read these
// constants — difficulty parameterizes behaviour, it does not fork the logic.
// No resource cheating on any tier; only caps, cadence, and toggles change.
//   workerCap     : how many workers/motes/ions to saturate to
//   firstWave     : tick of the first attack wave
//   waveSize      : units required before the first wave launches
//   waveGrowth    : how many units the required wave size grows each wave
//   waveCap       : ceiling on the required wave size
//   waveGap       : ticks between successive waves
//   maxExpansions : how many extra deposit buildings to try to take (0 = none)
//   richMinerals  : bank threshold that flags "rich enough to expand"
//   abilityMicro  : run per-unit ability micro (blink/siege/engulf/stim/...)?
//   harass        : send an early raid at the enemy mineral line?
//   harassTick    : tick to launch that raid
//   harassSize    : how many units the raid pulls
const DIFFICULTY = {
  easy: {
    workerCap: 10, firstWave: 2000, waveSize: 8, waveGrowth: 3, waveCap: 16,
    waveGap: 1100, maxExpansions: 0, richMinerals: 99999, abilityMicro: false,
    harass: false, harassTick: 0, harassSize: 0,
  },
  normal: {
    workerCap: 14, firstWave: 1200, waveSize: 8, waveGrowth: 4, waveCap: 20,
    waveGap: 900, maxExpansions: 1, richMinerals: 500, abilityMicro: true,
    harass: false, harassTick: 0, harassSize: 0,
  },
  hard: {
    workerCap: 18, firstWave: 900, waveSize: 6, waveGrowth: 5, waveCap: 28,
    waveGap: 650, maxExpansions: 3, richMinerals: 400, abilityMicro: true,
    harass: true, harassTick: 700, harassSize: 4,
  },
};

export class AI {
  constructor(pid, difficulty = "normal") {
    this.pid = pid;
    this.diff = DIFFICULTY[difficulty] || DIFFICULTY.normal;
    this.difficulty = DIFFICULTY[difficulty] ? difficulty : "normal";
    this.nextWave = this.diff.firstWave;
    this.waveSize = this.diff.waveSize;
    this.tankIdleSince = {};   // tankId -> tick nothing was near (for unsiege)
    this.sluiceIdleSince = {}; // sluiceId -> tick nothing was near (for unburrow)
    this.lastMorphTick = 0;    // throttle morph commands
    this.harassDone = false;   // early raid fired?
    this.expandMoteId = 0;     // ooze: mote currently escorting an expansion
    this.wantExpand = false;   // saving minerals toward a deposit this cycle
    this.expandWatch = null;   // {id,progress,since} stall watchdog for a deposit site
    this.failedSites = new Set(); // "tx,ty" of expansion spots that stalled — never retry
    this.savingSince = -1;     // tick we STARTED holding minerals for an expansion (-1 = not saving)
    this.expandCooldownUntil = 0; // don't attempt expansions again until this tick (after a failed save)
    this.expandFails = 0;      // dead-end expansion saves so far (2 = stop trying this game)
  }

  // Called every tick; returns a command list (usually empty).
  update(sim) {
    if (sim.tick % 10 !== 0 || sim.winner >= 0) return [];
    const cmds = [];
    const faction = sim.factions?.[this.pid] || "cogs";

    // Single-pass entity bucketing (replaces 8+ filter() calls). Storm types
    // map onto the same role buckets: forge=T1 production, shrine=T2,
    // spire=air/T3, tesla=defense, vault=research (its own bucket).
    const workers = [], army = [], hqs = [], barracks = [], refineries = [];
    const factories = [], starports = [], turrets = [], sites = [], vaults = [];
    let enemyBuilding = null;
    for (const e of sim.entities) {
      if (e.owner === this.pid) {
        if (e.unit) {
          if (e.type === "worker" || e.type === "mote" || e.type === "ion") workers.push(e);
          else army.push(e);
        } else if (e.building) {
          if (!e.done) { sites.push(e); continue; }
          switch (e.type) {
            case "hq": case "nucleus": case "core": hqs.push(e); break;
            case "barracks": case "den": case "forge": barracks.push(e); break;
            case "refinery": case "sump": case "extractor": refineries.push(e); break;
            case "factory": case "warren": case "shrine": factories.push(e); break;
            case "starport": case "roost": case "spire": starports.push(e); break;
            case "turret": case "barb": case "tesla": turrets.push(e); break;
            case "vault": vaults.push(e); break;
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

    // 1b. EXPANSION (runs EARLY so the deposit build claims minerals before the
    // army/tech spending below drains the bank — otherwise the AI, which trains
    // continuously, never banks the deposit's full cost). Shared across
    // factions; difficulty gates the count (Easy = 0). See tryExpand.
    this.tryExpand(sim, cmds, faction, hqs, workers, sites);

    if (faction === "ooze") {
      // =========================================================================
      // OOZE AI
      // =========================================================================

      // 2. keep training Motes up to the difficulty worker cap
      if (workers.length < this.diff.workerCap && hq.queue.length === 0 && sim.canAfford(this.pid, UNITS.mote.cost) && s.used + 1 <= s.cap) {
        cmds.push({ t: "train", buildingId: hq.id, unit: "mote" });
      }

      // 3. supply ahead of demand — Pods
      const podComing = sites.some((b) => b.type === "pod");
      if (s.cap - s.used < 4 && s.cap < 200 && !podComing && sim.canAfford(this.pid, BUILDINGS.pod.cost)) {
        this.tryBuildOoze(sim, cmds, "pod", hq);
      }

      // 4. build a Den once we have enough Motes
      const denComing = sites.some((b) => b.type === "den");
      if (workers.length >= 8 && barracks.length < 1 && !denComing && sim.canAfford(this.pid, BUILDINGS.den.cost)) {
        this.tryBuildOoze(sim, cmds, "den", hq);
      }

      // 4b. GooVents to spread goo — capped, they're support not an army
      const ventComing = sites.some((b) => b.type === "vent");
      const vents = sim.entities.filter((e) => e.owner === own && e.type === "vent").length;
      if (barracksDone && vents < 3 && !ventComing && sim.canAfford(this.pid, BUILDINGS.vent.cost)) {
        this.tryBuildOoze(sim, cmds, "vent", hq);
      }

      // 4c. Sump on a geyser for gas once a Den exists
      const sumpComing = sites.some((b) => b.type === "sump");
      if (barracksDone && !sumpComing && sim.canAfford(this.pid, BUILDINGS.sump.cost)) {
        this.tryBuildSump(sim, cmds);
      }

      // Gas management — pull workers onto the Sump
      if (refineries.length) {
        const ref = refineries[0];
        const onGas = workers.filter((w) =>
          w.order.kind === "gather" && w.order.resource === "gas").length;
        if (onGas < 3) {
          const w = workers.find((w) =>
            w.order.kind === "idle" ||
            (w.order.kind === "gather" && w.order.resource !== "gas"));
          if (w) cmds.push({ t: "gather", ids: [w.id], targetId: ref.id });
        }
      }

      // 4d. Warren (factory equivalent) once a Den is up and gas flowing
      const hasRefinery = refineries.length > 0 || sites.some((b) => b.type === "sump");
      const warrenComing = sites.some((b) => b.type === "warren");
      if (barracksDone && hasRefinery && factories.length === 0 && !warrenComing &&
          sim.canAfford(this.pid, BUILDINGS.warren.cost, BUILDINGS.warren.gasCost)) {
        this.tryBuildOoze(sim, cmds, "warren", hq);
      }

      // 4e. Roost (starport) once Warren is done
      const warrenDone = factories.some((f) => f.done);
      const roostComing = sites.some((b) => b.type === "roost");
      if (warrenDone && starports.length === 0 && !roostComing &&
          sim.canAfford(this.pid, BUILDINGS.roost.cost, BUILDINGS.roost.gasCost)) {
        this.tryBuildOoze(sim, cmds, "roost", hq);
      }

      // 4f. Barbs for base defense
      const barbComing = sites.some((b) => b.type === "barb");
      if (barracksDone && turrets.length < 2 && !barbComing &&
          sim.canAfford(this.pid, BUILDINGS.barb.cost)) {
        this.tryBuildOoze(sim, cmds, "barb", hq);
      }

      // 5. train army from Den: Nips and Spits (paused while saving to expand)
      for (const r of barracks) {
        if (this.wantExpand) break;
        if (!r.done || r.queue.length > 1) continue;
        // mix Nips (auto-broods 2) and Spits
        const type = (sim.tick % 30 === 0) ? "spit" : "nip";
        const d = UNITS[type];
        if (sim.canAfford(this.pid, d.cost, d.gasCost || 0) && s.used + d.supply <= s.cap) {
          cmds.push({ t: "train", buildingId: r.id, unit: type });
        }
      }

      // 5b. Sluices from Warren
      for (const fac of factories) {
        if (!fac.done || fac.queue.length > 0) continue;
        const d = UNITS.sluice;
        if (sim.canAfford(this.pid, d.cost, d.gasCost || 0) && s.used + d.supply <= s.cap) {
          cmds.push({ t: "train", buildingId: fac.id, unit: "sluice" });
        }
      }

      // 5c. Wisps from Roost
      for (const sp of starports) {
        if (!sp.done || sp.queue.length > 0) continue;
        const d = UNITS.wisp;
        if (sim.canAfford(this.pid, d.cost, d.gasCost || 0) && s.used + d.supply <= s.cap) {
          cmds.push({ t: "train", buildingId: sp.id, unit: "wisp" });
        }
      }

      // 5d. Morph some Nips into Maws (throttled)
      const nips = army.filter((u) => u.type === "nip");
      const maws = army.filter((u) => u.type === "maw");
      if (nips.length >= 3 && maws.length < Math.ceil(army.length / 4) &&
          sim.tick - this.lastMorphTick >= 30) {
        const nip = nips[0];
        const d = UNITS.maw;
        if (sim.canAfford(this.pid, d.cost, d.gasCost || 0)) {
          cmds.push({ t: "ooze_morph", ids: [nip.id], fromType: "nip", targetType: "maw" });
          this.lastMorphTick = sim.tick;
        }
      }

      // 5e. Ooze upgrades
      if (barracksDone && refineries.length && !(sim.upgrades[own] & UPGRADE_BITS.carapace) &&
          !sim.upgradeQueued(own, "carapace")) {
        const bk = barracks.find((b) => b.done && b.queue.length < 2);
        const u = UPGRADES.carapace;
        if (bk && sim.canAfford(own, u.cost, u.gasCost)) cmds.push({ t: "research", buildingId: bk.id, research: "carapace" });
      }
      if (barracksDone && (sim.upgrades[own] & UPGRADE_BITS.carapace) &&
          !(sim.upgrades[own] & UPGRADE_BITS.adrenal) &&
          !sim.upgradeQueued(own, "adrenal")) {
        const bk = barracks.find((b) => b.done && b.queue.length < 2);
        const u = UPGRADES.adrenal;
        if (bk && sim.canAfford(own, u.cost, u.gasCost)) cmds.push({ t: "research", buildingId: bk.id, research: "adrenal" });
      }
      if (factories.some((f) => f.done) && !(sim.upgrades[own] & UPGRADE_BITS.burrowtech) &&
          !sim.upgradeQueued(own, "burrowtech")) {
        const fac = factories.find((f) => f.done && f.queue.length < 2);
        const u = UPGRADES.burrowtech;
        if (fac && sim.canAfford(own, u.cost, u.gasCost)) cmds.push({ t: "research", buildingId: fac.id, research: "burrowtech" });
      }
      if (starports.some((sp) => sp.done) && !(sim.upgrades[own] & UPGRADE_BITS.membrane) &&
          !sim.upgradeQueued(own, "membrane")) {
        const sp = starports.find((sp) => sp.done && sp.queue.length < 2);
        const u = UPGRADES.membrane;
        if (sp && sim.canAfford(own, u.cost, u.gasCost)) cmds.push({ t: "research", buildingId: sp.id, research: "membrane" });
      }

      // 5f. Ooze ability micro: Engulf (maw) — jump onto enemy building
      if (this.diff.abilityMicro && enemyBuilding) {
        const mawsWithEngulf = army.filter((u) => u.type === "maw" && u.abilityCd === 0);
        if (mawsWithEngulf.length) {
          const close = mawsWithEngulf.filter((u) =>
            dist2(u.x, u.y, enemyBuilding.x, enemyBuilding.y) <= (FP * 5) * (FP * 5));
          if (close.length) {
            cmds.push({ t: "ability", ids: [close[0].id], ability: "engulf", x: enemyBuilding.x, y: enemyBuilding.y });
          }
        }
      }

      // 5g. Ooze ability micro: Burrow (sluice) — siege-like toggle using burrowtech
      if (this.diff.abilityMicro && sim.upgrades[own] & UPGRADE_BITS.burrowtech) {
        for (const sluice of army.filter((u) => u.type === "sluice")) {
          if (sim.tick < sluice.transformUntil) continue;
          const enemiesNear4 = sim.entities.filter((e) => e.owner >= 0 && e.owner !== own && e.unit &&
            dist2(sluice.x, sluice.y, e.x, e.y) <= (FP * 4) * (FP * 4)).length;
          const anyNear7 = sim.entities.some((e) => e.owner >= 0 && e.owner !== own && e.unit &&
            dist2(sluice.x, sluice.y, e.x, e.y) <= (FP * 7) * (FP * 7));
          if (!sluice.burrowed && enemiesNear4 >= 2 && sluice.abilityCd === 0) {
            cmds.push({ t: "ability", ids: [sluice.id], ability: "burrow" });
            delete this.sluiceIdleSince[sluice.id];
          } else if (sluice.burrowed) {
            if (anyNear7) delete this.sluiceIdleSince[sluice.id];
            else {
              if (this.sluiceIdleSince[sluice.id] === undefined) this.sluiceIdleSince[sluice.id] = sim.tick;
              if (sim.tick - this.sluiceIdleSince[sluice.id] >= 100 && sluice.abilityCd === 0) {
                cmds.push({ t: "ability", ids: [sluice.id], ability: "burrow" }); // unburrow
                delete this.sluiceIdleSince[sluice.id];
              }
            }
          }
        }
      }

    } else if (faction === "storm") {
      // =========================================================================
      // TEMPEST (storm) AI — Cog cadence with conduit-first power logic
      // =========================================================================

      // 2. keep training Ions up to the difficulty worker cap
      if (workers.length < this.diff.workerCap && hq.queue.length === 0 && sim.canAfford(this.pid, UNITS.ion.cost) && s.used + 1 <= s.cap) {
        cmds.push({ t: "train", buildingId: hq.id, unit: "ion" });
      }

      // 3. Conduits double as supply AND power — stay ahead on both counts.
      const conduitComing = sites.some((b) => b.type === "conduit");
      if (s.cap - s.used < 4 && s.cap < 200 && !conduitComing && sim.canAfford(this.pid, BUILDINGS.conduit.cost)) {
        this.tryBuild(sim, cmds, workers, "conduit", hq);
      }

      // 4. up to 2 forges once the economy is going (need power: near core/conduit)
      const forgeComing = sites.some((b) => b.type === "forge");
      if (workers.length >= 10 && barracks.length < 2 && !forgeComing && sim.canAfford(this.pid, BUILDINGS.forge.cost + 50)) {
        this.tryBuild(sim, cmds, workers, "forge", hq);
      }

      // 4b. extractor once a forge exists; keep ~3 workers on gas
      const extractorComing = sites.some((b) => b.type === "extractor");
      if (barracksDone && refineries.length === 0 && !extractorComing &&
          sim.canAfford(this.pid, BUILDINGS.extractor.cost)) {
        this.tryBuildRefinery(sim, cmds, workers, "extractor");
      }
      // adopt orphaned construction sites (same rationale as the Cog branch)
      const adoptedS = new Set();
      for (const site of sites) {
        const hasBuilder = workers.some((w) => w.order.kind === "build" && w.order.targetId === site.id);
        if (hasBuilder) continue;
        const w = workers.find((x) => !adoptedS.has(x.id) &&
          (x.order.kind === "idle" ||
           (x.order.kind === "gather" && x.order.resource !== "gas")));
        if (w) { adoptedS.add(w.id); cmds.push({ t: "resume", ids: [w.id], targetId: site.id }); }
      }
      if (refineries.length) {
        const ref = refineries[0];
        const onGas = workers.filter((w) =>
          w.order.kind === "gather" && w.order.resource === "gas").length;
        if (onGas < 3) {
          const w = workers.find((w) =>
            w.order.kind === "idle" ||
            (w.order.kind === "gather" && w.order.resource !== "gas"));
          if (w) cmds.push({ t: "gather", ids: [w.id], targetId: ref.id });
        }
      }

      // 4c. shrine (T2) once a forge is done and gas is flowing
      const shrineComing = sites.some((b) => b.type === "shrine");
      if (barracksDone && factories.length === 0 && !shrineComing &&
          sim.canAfford(this.pid, BUILDINGS.shrine.cost, BUILDINGS.shrine.gasCost)) {
        this.tryBuild(sim, cmds, workers, "shrine", hq);
      }

      // 4d. spire (air/T3) once a shrine is done
      const spireComing = sites.some((b) => b.type === "spire");
      const shrineDone = factories.some((f) => f.done);
      if (shrineDone && starports.length === 0 && !spireComing &&
          sim.canAfford(this.pid, BUILDINGS.spire.cost, BUILDINGS.spire.gasCost)) {
        this.tryBuild(sim, cmds, workers, "spire", hq);
      }

      // 4e. tesla pylons for defense
      const teslaComing = sites.some((b) => b.type === "tesla");
      if (barracksDone && turrets.length < 2 && !teslaComing &&
          sim.canAfford(this.pid, BUILDINGS.tesla.cost)) {
        this.tryBuild(sim, cmds, workers, "tesla", hq);
      }

      // 4f. vault (research) once a shrine is done
      const vaultComing = sites.some((b) => b.type === "vault");
      if (shrineDone && vaults.length === 0 && !vaultComing &&
          sim.canAfford(this.pid, BUILDINGS.vault.cost, BUILDINGS.vault.gasCost)) {
        this.tryBuild(sim, cmds, workers, "vault", hq);
      }

      // 5. train army: volts and arcs from forges (paused while saving to expand)
      for (const r of barracks) {
        if (this.wantExpand) break;
        if (!r.done || r.queue.length > 1) continue;
        const type = (sim.tick % 30 === 0) ? "volt" : "arc";
        const d = UNITS[type];
        if (sim.canAfford(this.pid, d.cost, d.gasCost || 0) && s.used + d.supply <= s.cap) {
          cmds.push({ t: "train", buildingId: r.id, unit: type });
        }
      }
      // 5b. sentinels (and the odd phantom) from shrines
      for (const fac of factories) {
        if (!fac.done || fac.queue.length > 0) continue;
        const type = (sim.tick % 50 === 0) ? "phantom" : "sentinel";
        const d = UNITS[type];
        if (sim.canAfford(this.pid, d.cost, d.gasCost || 0) && s.used + d.supply <= s.cap) {
          cmds.push({ t: "train", buildingId: fac.id, unit: type });
        }
      }
      // 5c. zephyrs, and a fulminar when the bank allows
      for (const sp of starports) {
        if (!sp.done || sp.queue.length > 0) continue;
        const type = (sim.tick % 80 === 0) ? "fulminar" : "zephyr";
        const d = UNITS[type];
        if (sim.canAfford(this.pid, d.cost, d.gasCost || 0) && s.used + d.supply <= s.cap) {
          cmds.push({ t: "train", buildingId: sp.id, unit: type });
        }
      }

      // 5d. research: capacitors -> blinktech -> stormtech
      if (barracksDone && refineries.length && !(sim.upgrades[own] & UPGRADE_BITS.capacitors) &&
          !sim.upgradeQueued(own, "capacitors")) {
        const bk = barracks.find((b) => b.done && b.queue.length < 2);
        const u = UPGRADES.capacitors;
        if (bk && sim.canAfford(own, u.cost, u.gasCost)) cmds.push({ t: "research", buildingId: bk.id, research: "capacitors" });
      }
      if (vaults.length && !(sim.upgrades[own] & UPGRADE_BITS.blinktech) &&
          !sim.upgradeQueued(own, "blinktech")) {
        const v = vaults.find((v) => v.queue.length < 2);
        const u = UPGRADES.blinktech;
        if (v && sim.canAfford(own, u.cost, u.gasCost)) cmds.push({ t: "research", buildingId: v.id, research: "blinktech" });
      }
      if (starports.some((sp) => sp.done) && !(sim.upgrades[own] & UPGRADE_BITS.stormtech) &&
          !sim.upgradeQueued(own, "stormtech")) {
        const sp = starports.find((sp) => sp.done && sp.queue.length < 2);
        const u = UPGRADES.stormtech;
        if (sp && sim.canAfford(own, u.cost, u.gasCost)) cmds.push({ t: "research", buildingId: sp.id, research: "stormtech" });
      }

      // 5e. ability micro: blink volts at enemy buildings, dome under fire,
      // tempest onto the enemy base
      if (this.diff.abilityMicro) {
      if (sim.upgrades[own] & UPGRADE_BITS.blinktech && enemyBuilding) {
        const volts = army.filter((u) => u.type === "volt" && u.abilityCd === 0 &&
          dist2(u.x, u.y, enemyBuilding.x, enemyBuilding.y) <= (FP * 6) * (FP * 6));
        if (volts.length) {
          cmds.push({ t: "ability", ids: [volts[0].id], ability: "blink", x: enemyBuilding.x, y: enemyBuilding.y });
        }
      }
      for (const sen of army.filter((u) => u.type === "sentinel" && u.abilityCd === 0)) {
        const enemiesNear = sim.entities.filter((e) => e.owner >= 0 && e.owner !== own && e.unit &&
          dist2(sen.x, sen.y, e.x, e.y) <= (FP * 4) * (FP * 4)).length;
        if (enemiesNear >= 2) { cmds.push({ t: "ability", ids: [sen.id], ability: "dome" }); break; }
      }
      if (sim.upgrades[own] & UPGRADE_BITS.stormtech && enemyBuilding) {
        const fuls = army.filter((u) => u.type === "fulminar" && u.abilityCd === 0 && !u.channelUntil &&
          dist2(u.x, u.y, enemyBuilding.x, enemyBuilding.y) <= (FP * 7) * (FP * 7));
        if (fuls.length) {
          cmds.push({ t: "ability", ids: [fuls[0].id], ability: "tempest", x: enemyBuilding.x, y: enemyBuilding.y });
        }
      }
      } // end abilityMicro (storm)

    } else {
      // =========================================================================
      // COG (Human) AI — unchanged
      // =========================================================================

      // 2. keep training workers up to the difficulty worker cap
      if (workers.length < this.diff.workerCap && hq.queue.length === 0 && sim.canAfford(this.pid, UNITS.worker.cost) && s.used + 1 <= s.cap) {
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
      // Keep EVERY half-built structure progressing. A worker's build order can be
      // cleared (path failure, or the worker gets stolen back to mining), which
      // orphans the site — and because an orphaned site still counts as
      // "<type>Coming", it permanently blocks that whole build branch AND makes the
      // AI bank minerals it can't spend. So: any site with no live builder gets an
      // idle/mining worker sent to resume it. (Was refinery-only; now all types.)
      const adopted = new Set();
      for (const site of sites) {
        const hasBuilder = workers.some((w) => w.order.kind === "build" && w.order.targetId === site.id);
        if (hasBuilder) continue;
        const w = workers.find((x) => !adopted.has(x.id) &&
          (x.order.kind === "idle" ||
           (x.order.kind === "gather" && x.order.resource !== "gas")));
        if (w) { adopted.add(w.id); cmds.push({ t: "resume", ids: [w.id], targetId: site.id }); }
      }
      const doneRefineries = refineries;
      if (doneRefineries.length) {
        const ref = doneRefineries[0];
        const onGas = workers.filter((w) =>
          w.order.kind === "gather" && w.order.resource === "gas").length;
        if (onGas < 3) {
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

      // 5. train army: mostly marines, some brutes (paused while saving to expand)
      for (const r of barracks) {
        if (this.wantExpand) break;
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
      if (this.diff.abilityMicro) {
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
      } // end abilityMicro (cogs)
    }

    // =========================================================================
    // SHARED: Defense, kiting, attack waves, harass
    // =========================================================================

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

    // 6b. kiting: back off from melee enemies after firing (marines / spits)
    if (sim.tick % 5 === 0) {
      for (const m of army) {
        if ((m.type !== "marine" && m.type !== "spit") || m.cooldown <= 4) continue;
        const e = sim.nearestEntity(m.x, m.y, FP * 2,
          (e) => e.owner >= 0 && e.owner !== own && e.unit && !e.fly);
        if (e && UNITS[e.type] && UNITS[e.type].range < FP) {
          const dx = m.x - e.x, dy = m.y - e.y;
          const dd = Math.max(1, Math.hypot(dx, dy));
          cmds.push({ t: "move", ids: [m.id], x: m.x + ((dx / dd * FP * 1.5) | 0), y: m.y + ((dy / dd * FP * 1.5) | 0), q: 1 });
        }
      }
    }

    // 6c. HARASS (Hard only): one early raid at the enemy mineral line before
    // the main army is ready. Pulls a small squad so it doesn't gut base
    // defense; fires once. Aimed at the enemy start's resource line.
    if (this.diff.harass && !this.harassDone && sim.tick >= this.diff.harassTick &&
        army.length >= this.diff.harassSize) {
      const raid = army.slice(0, this.diff.harassSize);
      const target = this.enemyMineralLine(sim) || this.enemyBase(sim);
      if (target) {
        cmds.push({ t: "attackmove", ids: raid.map((u) => u.id), x: target.x, y: target.y });
        this.harassDone = true;
      }
    }

    // 7. attack waves, growing over time (cadence/size tuned by difficulty)
    if (sim.tick >= this.nextWave && army.length >= this.waveSize) {
      const target = enemyBuilding
        ? { x: enemyBuilding.x, y: enemyBuilding.y }
        : this.enemyBase(sim);
      if (target) {
        cmds.push({ t: "attackmove", ids: army.map((u) => u.id), x: target.x, y: target.y });
        this.nextWave = sim.tick + this.diff.waveGap;
        this.waveSize = Math.min(this.diff.waveCap, this.waveSize + this.diff.waveGrowth);
      }
    }

    return cmds;
  }

  // A point at the enemy's starting mineral line (for harass). Falls back to
  // the enemy start tile. Deterministic: nearest mineral to the enemy start.
  enemyMineralLine(sim) {
    const s = sim.map.starts[1 - this.pid];
    if (!s) return null;
    const sx = tileToFp(s.x), sy = tileToFp(s.y);
    const patch = sim.nearestEntity(sx, sy, FP * 20,
      (e) => e.type === "mineral" && e.amount > 0);
    return patch ? { x: patch.x, y: patch.y } : { x: sx, y: sy };
  }

  enemyBase(sim) {
    const enemy = sim.entities.find((e) => e.building && e.owner >= 0 && e.owner !== this.pid);
    if (enemy) return { x: enemy.x, y: enemy.y };
    const s = sim.map.starts[1 - this.pid];
    return { x: tileToFp(s.x), y: tileToFp(s.y) };
  }

  // -------------------------------------------------------------------------
  // EXPANSION. Take another deposit (hq / nucleus / core) at a fresh mineral
  // cluster when we're rich or the current line is thinning. Shared logic;
  // per-faction issue path differs. All scans are deterministic (sorted by
  // distance then id), and the site search rides on canPlace which enforces
  // the HQ_RESOURCE_CLEARANCE, so no float branching is introduced.
  // -------------------------------------------------------------------------
  tryExpand(sim, cmds, faction, hqs, workers, sites) {
    this.wantExpand = false;      // cleared each cycle; set below if saving up
    const depositType = FACTIONS[faction]?.start; // hq / nucleus / core
    if (!depositType || !hqs.length) return;

    // Count expansions actually taken from live sim state (done deposits beyond
    // the first main, PLUS any deposit still under construction). Deriving from
    // the sim — instead of a counter bumped on ISSUE — is robust: a build the
    // sim silently rejects (couldn't afford / canPlace flipped that tick) simply
    // doesn't get counted, so the AI retries next tick instead of giving up.
    const depositSiteList = sites.filter((b) => b.type === depositType);
    const expansionsTaken = Math.max(0, hqs.length - 1) + depositSiteList.length;
    if (expansionsTaken >= this.diff.maxExpansions) return;
    // After a failed save (couldn't complete an expansion), back off for a while
    // so the AI resumes army production instead of starving forever.
    if (sim.tick < this.expandCooldownUntil) { this.savingSince = -1; return; }

    // STALL WATCHDOG: an expansion deposit whose builder physically can't reach
    // it (base congestion / a pocket the reachability test didn't catch) sits
    // at progress 0 forever, and — because it counts as an expansion "in
    // flight" — permanently blocks any retry. So watch its progress: if it
    // hasn't advanced within a grace window, tear it down (t:"remove") and let
    // the next cycle pick a fresh site. This is the "re-issue if it failed"
    // robustness the design calls for.
    if (depositSiteList.length > 0) {
      this.savingSince = -1;       // site exists — no longer just saving
      const site = depositSiteList[0];
      const rec = this.expandWatch;
      if (!rec || rec.id !== site.id) {
        this.expandWatch = { id: site.id, progress: site.progress, since: sim.tick };
      } else if (site.progress > rec.progress) {
        rec.progress = site.progress; rec.since = sim.tick; // making progress
      } else if (sim.tick - rec.since >= 500) {
        cmds.push({ t: "remove", ids: [site.id] });          // stalled: abandon
        this.failedSites.add(site.tx + "," + site.ty);       // never re-pick it
        this.expandWatch = null;
        this.expandMoteId = 0;
      }
      return; // one in flight (or being torn down); wait
    }
    this.expandWatch = null;

    // Trigger — expand PROACTIVELY (an aggressive AI grabs bases early), when
    // ANY of:
    //   rich      : bank over the tier threshold
    //   thinning  : minerals near our deposits are running low
    //   developed : economy is up (near worker cap + army production online),
    //               so we snowball with a second base instead of hoarding.
    // Any own worker (idle or mining) can be pulled to build it.
    const rich = sim.minerals[this.pid] >= this.diff.richMinerals;
    let nearbyMinerals = 0;
    for (const e of sim.entities) {
      if (e.type !== "mineral" || e.amount <= 0) continue;
      for (const hq of hqs) {
        if (dist2(hq.x, hq.y, e.x, e.y) <= (FP * 10) * (FP * 10)) { nearbyMinerals += e.amount; break; }
      }
    }
    const thinning = nearbyMinerals < 3000;
    const armyProduction = sim.entities.some((e) => e.owner === this.pid && e.building && e.done &&
      (e.type === "barracks" || e.type === "den" || e.type === "forge"));
    // Expand as an OPENING priority: once army production is online and the
    // eco has a decent worker base, grab a second base early (before the AI has
    // already steamrolled a passive opponent). A lower bar than full saturation
    // so the deposit actually completes while the game is still going.
    const developed = workers.length >= 8 && armyProduction;
    if (!rich && !thinning && !developed) return;

    // We WANT to expand. If we can't afford the deposit yet, flag "saving" so
    // the faction branches pause their army training this cycle and let the
    // bank fill toward the deposit cost (an AI that trains every tick otherwise
    // never accumulates the 400 for a Hub/Nucleus/Core). Only save once a
    // reachable site actually exists — no point starving the army for nothing.
    const site = this.findExpansionSite(sim, hqs, depositType, workers);
    if (!site) { this.savingSince = -1; return; }
    const canAfford = sim.canAfford(this.pid, BUILDINGS[depositType].cost);
    const cx = site.tx * FP + (BUILDINGS[depositType].size * FP >> 1);
    const cy = site.ty * FP + (BUILDINGS[depositType].size * FP >> 1);

    // SAVING TIMEOUT (safety valve): pausing the army to bank a deposit is only
    // worth it if the expansion actually happens. On a cramped map the escort
    // worker/mote may never reach a placeable spot, and an open-ended save would
    // starve the army forever (no units, eventual loss). So bound the save: if
    // we've held minerals this long without a deposit SITE spawning, give up on
    // this site, blacklist it, cool down, and let army production resume.
    if (this.savingSince < 0) this.savingSince = sim.tick;
    if (sim.tick - this.savingSince >= 1500) {
      this.failedSites.add(site.tx + "," + site.ty);
      this.expandFails = (this.expandFails || 0) + 1;
      // A dead-end save (escort can't reach a placeable spot) has to give up so
      // it doesn't starve the army forever. After two such dead ends, STOP
      // expanding for the game; the map is too cramped for this base and further
      // cycles just waste production against a passive opponent.
      this.expandCooldownUntil = this.expandFails >= 2 ? Infinity : sim.tick + 800;
      this.savingSince = -1;
      this.expandMoteId = 0;
      return; // wantExpand stays false -> army resumes this cycle
    }

    if (faction === "ooze") {
      // Nucleus is gooOozes (no goo needed) but ooze_build needs a Mote within
      // 4 tiles of the site. PRE-STAGE a mote at the site WHILE we save up (so
      // it's already in position the moment we can afford it), then melt it.
      const moteNear = sim.nearestEntity(cx, cy, FP * 4, (e) =>
        e.owner === this.pid && e.unit && e.type === "mote" && e.hp > 0);
      if (moteNear && canAfford) {
        cmds.push({ t: "ooze_build", building: depositType, tx: site.tx, ty: site.ty });
        this.expandMoteId = 0;
        return;
      }
      // Not ready (no funds yet, or no mote in place): hold the army (pause
      // training) to bank toward the deposit, and keep the escort mote walking
      // toward the site so it arrives in time. The saving TIMEOUT above is the
      // safety valve that stops an impossible expansion from starving us.
      if (!canAfford) this.wantExpand = true;
      let mote = this.expandMoteId ? workers.find((w) => w.id === this.expandMoteId && w.hp > 0) : null;
      if (!mote) {
        mote = sim.nearestEntity(cx, cy, FP * 999, (e) =>
          e.owner === this.pid && e.unit && e.type === "mote" && e.hp > 0);
        if (mote) this.expandMoteId = mote.id;
      }
      if (mote && !moteNear) cmds.push({ t: "move", ids: [mote.id], x: cx, y: cy });
      return;
    }

    // From here (cogs/storm) we need funds. Hold the army to bank toward the
    // deposit (the saving timeout above stops an impossible save from starving
    // us), then escort a worker over and build.
    if (!canAfford) { this.wantExpand = true; return; }

    // Cogs / Storm: worker-built (t:"build"). Storm core is powers:true so it
    // places without a power field — canPlace already handles that.
    //
    // ESCORT-THEN-BUILD: issuing a bare "build" makes the sim walk the worker
    // to the (soon-blocked) footprint CENTER, and its pathing can snap onto a
    // stub and strand the worker at progress 0 for a distant base-corner
    // expansion. Mirror the Ooze mote pattern instead: MOVE a dedicated worker
    // to a free tile beside the site (clean pathing to an open tile), and only
    // once it's actually adjacent do we issue the build. Robust + deterministic.
    const size = BUILDINGS[depositType].size;
    // reuse the escorting worker if it still lives; else pick a gatherer/idle
    let worker = this.expandMoteId ? workers.find((w) => w.id === this.expandMoteId && w.hp > 0) : null;
    if (!worker) worker = workers.find((w) => w.order.kind === "gather" || w.order.kind === "idle");
    if (!worker) return;
    this.expandMoteId = worker.id;
    // adjacent? (worker within one tile of the footprint box) -> build now
    const wtx = fpToTile(worker.x), wty = fpToTile(worker.y);
    const adjacent = wtx >= site.tx - 2 && wtx <= site.tx + size + 1 &&
                     wty >= site.ty - 2 && wty <= site.ty + size + 1;
    if (adjacent) {
      cmds.push({ t: "build", workerId: worker.id, building: depositType, tx: site.tx, ty: site.ty });
      this.expandMoteId = 0;
    } else {
      // walk it to a free tile just outside the footprint (open, no snap)
      const spot = nearestFree(sim.blocked, sim.map.w, sim.map.h, site.tx - 1, site.ty - 1) ||
        { x: fpToTile(cx), y: fpToTile(cy) };
      cmds.push({ t: "move", ids: [worker.id], x: tileToFp(spot.x), y: tileToFp(spot.y) });
    }
  }

  // Find a placeable deposit spot near a mineral cluster that is FAR (>10
  // tiles) from every one of our existing deposits. Ring-search radius 5..8
  // around the cluster centroid; canPlace enforces the HQ resource clearance.
  findExpansionSite(sim, hqs, depositType, workers) {
    const size = BUILDINGS[depositType].size;
    // Gather mineral patches not already claimed by one of our deposits.
    const far = (e) => hqs.every((hq) =>
      dist2(hq.x, hq.y, e.x, e.y) > (FP * 10) * (FP * 10));
    const patches = sim.entities
      .filter((e) => e.type === "mineral" && e.amount > 0 && far(e))
      .sort((a, b) => a.id - b.id);
    if (!patches.length) return null;

    // Cluster patches by proximity; evaluate clusters nearest to our main first
    // so we grab the closest fresh field. Cluster = patches within 6 tiles of a
    // seed. Deterministic: iterate patches in id order, greedy-group.
    const used = new Set();
    const clusters = [];
    for (const p of patches) {
      if (used.has(p.id)) continue;
      const group = [p]; used.add(p.id);
      for (const q of patches) {
        if (used.has(q.id)) continue;
        if (dist2(p.x, p.y, q.x, q.y) <= (FP * 6) * (FP * 6)) { group.push(q); used.add(q.id); }
      }
      let sx = 0, sy = 0;
      for (const g of group) { sx += g.x; sy += g.y; }
      clusters.push({ cx: (sx / group.length) | 0, cy: (sy / group.length) | 0, n: group.length });
    }
    // Prefer the NEAREST cluster to our main deposit, tie-break by size then
    // by centroid position (deterministic). Nearer clusters are almost always
    // on the same landmass, so a builder can actually path there — a far
    // cluster behind a cliff strands the builder forever at progress 0.
    const main = hqs[0];
    clusters.sort((a, b) =>
      (dist2(main.x, main.y, a.cx, a.cy) - dist2(main.x, main.y, b.cx, b.cy)) ||
      (b.n - a.n) || (a.cx - b.cx) || (a.cy - b.cy));

    // Reachability is measured from a point KNOWN to be on our landmass. A
    // live worker is ideal (it's standing on a reachable, unblocked tile);
    // fall back to a free tile beside the main deposit (its own footprint is
    // blocked, so pathing from the center fails outright).
    let startX, startY;
    const anchor = workers && workers.find((w) => w.hp > 0);
    if (anchor) { startX = anchor.x; startY = anchor.y; }
    else {
      const mfree = nearestFree(sim.blocked, sim.map.w, sim.map.h, fpToTile(main.x), fpToTile(main.y));
      startX = mfree ? tileToFp(mfree.x) : main.x;
      startY = mfree ? tileToFp(mfree.y) : main.y;
    }

    for (const cl of clusters) {
      const ctx = fpToTile(cl.cx), cty = fpToTile(cl.cy);
      for (let r = 5; r <= 8; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const tx = ctx + dx - (size >> 1), ty = cty + dy - (size >> 1);
            if (this.failedSites.has(tx + "," + ty)) continue; // known-stuck spot
            if (!sim.canPlace(depositType, tx, ty, this.pid)) continue;
            // Reachability gate. A worker BUILDS from a tile adjacent to the
            // footprint, and once the site spawns its own 3x3 becomes blocked —
            // so the honest test is "can we path to a free tile touching the
            // footprint, WITH the footprint treated as an obstacle?". Checking
            // the (soon-to-be-blocked) center instead lets findPath thread the
            // path through where the building will sit, then the real builder
            // stalls forever. This mirrors build-time and kills pocket sites.
            if (this.reachableSite(sim, startX, startY, tx, ty, size)) return { tx, ty };
          }
        }
      }
    }
    return null;
  }

  // Can a builder standing on our landmass reach a tile ADJACENT to the
  // [tx,ty]+size footprint, once that footprint is blocked (as it will be after
  // the deposit spawns)? Temporarily stamps the footprint into sim.blocked,
  // runs a real findPath to each free perimeter tile, then RESTORES blocked
  // byte-for-byte (mutating and un-mutating in the same call keeps the sim
  // pristine — no desync). Deterministic scan order.
  reachableSite(sim, startX, startY, tx, ty, size) {
    const { w, h } = sim.map;
    const blocked = sim.blocked;
    // stamp the footprint (it becomes blocked once the deposit spawns),
    // remembering prior values so we can restore byte-for-byte.
    const saved = [];
    for (let y = ty; y < ty + size; y++)
      for (let x = tx; x < tx + size; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const idx = y * w + x;
        saved.push([idx, blocked[idx]]);
        blocked[idx] = 1;
      }
    // Replicate the sim's build-time pathing EXACTLY: the builder walks toward
    // the site CENTER (blocked), which findPath snaps to nearestFree(center)
    // by stepping toward the start. If that snapped goal ends up near the site
    // (adjacent to the footprint) the builder arrives and builds; if it snaps
    // all the way back beside the start, the site is a pocket and the builder
    // stalls at progress 0. So: path to the center and check the endpoint is
    // actually next to the footprint.
    const scx = tx * FP + (size * FP >> 1), scy = ty * FP + (size * FP >> 1);
    const path = findPath(blocked, w, h, startX, startY, scx, scy);
    let ok = false;
    if (path && path.length) {
      const end = path[path.length - 1];
      const ex = fpToTile(end.x), ey = fpToTile(end.y);
      // endpoint must touch the footprint (Chebyshev distance 1 to the box)
      const nearBox =
        ex >= tx - 1 && ex <= tx + size && ey >= ty - 1 && ey <= ty + size;
      if (nearBox) ok = true;
    }
    // restore blocked exactly
    for (const [idx, v] of saved) blocked[idx] = v;
    return ok;
  }

  // Build a gas harvester (Cog refinery / Storm extractor) on the nearest
  // own-base geyser that has none yet.
  tryBuildRefinery(sim, cmds, workers, type = "refinery") {
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
        if (sim.canPlace(type, tx, ty, this.pid)) {
          cmds.push({ t: "build", workerId: worker.id, building: type, tx, ty });
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
          if (sim.canPlace(type, tx, ty, this.pid)) {
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

  // Ooze ooze_build: consumes a Mote at the site, auto-completes.
  // The sim SILENTLY rejects the command unless a Mote is within 4 tiles of
  // the site — so a candidate spot without one is a permanent stall (the
  // deterministic scan re-picks the same doomed spot forever, banking
  // thousands of minerals at 10/10 supply). Mirror that precondition here.
  tryBuildOoze(sim, cmds, type, hq) {
    const size = BUILDINGS[type].size;
    const htx = fpToTile(hq.x), hty = fpToTile(hq.y);
    for (let r = 3; r < 10; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = htx + dx - (size >> 1), ty = hty + dy - (size >> 1);
          if (sim.canPlace(type, tx, ty, this.pid)) {
            const cx = tx * FP + (size * FP >> 1), cy = ty * FP + (size * FP >> 1);
            const nearPatch = sim.nearestEntity(cx, cy, FP * 2, (e) => e.type === "mineral");
            if (nearPatch) continue;
            const moteNear = sim.nearestEntity(cx, cy, FP * 4, (e) =>
              e.owner === this.pid && e.unit && e.type === "mote" && e.hp > 0);
            if (!moteNear) continue;
            cmds.push({ t: "ooze_build", building: type, tx, ty });
            return;
          }
        }
      }
    }
  }

  // Build an Ooze Sump on the nearest own-base geyser (onGeyser: true).
  tryBuildSump(sim, cmds) {
    const start = sim.map.starts[this.pid];
    const sx = tileToFp(start.x), sy = tileToFp(start.y);
    const geysers = sim.entities
      .filter((e) => e.type === "geyser" && !sim.refineryOnGeyser(e.id))
      .sort((a, b) => dist2(sx, sy, a.x, a.y) - dist2(sx, sy, b.x, b.y) || a.id - b.id);
    for (const g of geysers) {
      if (dist2(sx, sy, g.x, g.y) > (FP * 20) * (FP * 20)) continue;
      const gx = fpToTile(g.x), gy = fpToTile(g.y);
      for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
        const tx = gx + ox, ty = gy + oy;
        if (sim.canPlace("sump", tx, ty, this.pid)) {
          // same silent-reject rule: a Mote must be within 4 tiles of the site
          const cx = tx * FP + FP, cy = ty * FP + FP;
          const moteNear = sim.nearestEntity(cx, cy, FP * 4, (e) =>
            e.owner === this.pid && e.unit && e.type === "mote" && e.hp > 0);
          if (!moteNear) continue;
          cmds.push({ t: "ooze_build", building: "sump", tx, ty });
          return;
        }
      }
    }
  }
}
