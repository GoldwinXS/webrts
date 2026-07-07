// Unit model definitions — THE COGS: a family of industrious tin-toy robots.
//
// Family DNA (every unit shares these, so the army reads as one civilization):
//   1. Warm cream enamel shell (per-unit shellMat) over tin/gunmetal machinery
//   2. A dome head/cabin (G.dome) wearing a curved TEAM-GLOW visor (G.domeVisor)
//   3. A whip antenna (G.antenna) tipped with a glowing team-color bobble (G.lamp)
//   4. Copper cog emblems (G.cog) + copper rivets (G.rivet) on shells/shoulders
//   5. Chibi proportions: oversized head/cabin, stubby limbs, compact body
//   6. Every engine/thruster glows warm AMBER — never team color
//   7. Team color appears ONLY as accent: visor, stripe ring, bobble tips
//
// Each unit has a build(e, color) function returning a THREE.Group with
// userData.anim set, and an animate(g, e, t, move, a) driving per-frame motion.
// Renderer contracts preserved: anim.recoil is set on fire, g.userData.aimYaw
// is smoothed onto turrets, g.userData.body is yawed/rolled by the renderer.

import * as THREE from "three";
import { ModelBuilder, part } from "./parts.js";
import { registerUnit } from "./registry.js";
import {
  G, DARK, GUNMETAL, TIN, COPPER, RUBBER, AMBER, CHEEK,
  shellMat, teamMat, glowMat, toonGradient,
} from "./core.js";

// Module-scope one-off geometries (shared across all instances — never create
// geometry inside build()).
const SPINE_STRIPE = new THREE.BoxGeometry(0.1, 0.03, 0.55);   // flyer team stripe
const GLACIS_STRIPE = new THREE.BoxGeometry(0.62, 0.05, 0.07); // tank team stripe

// ===========================================================================
// WORKER ("Bolt") — round little helper: hovering cream pod, two big team-glow
// eyes + rosy cheeks, waist stripe, antenna bobble, one tool arm ending in a
// spinning copper cog (the Cog wrench).
// ===========================================================================
registerUnit("worker", {
  build(e, color) {
    const shell = shellMat();
    const glow = glowMat(color);
    const m = new ModelBuilder();
    m.addMat(shell);

    // pod body: cream dome over a tin belly
    m.add(part(G.dome, shell).scl(0.64, 0.56, 0.66).shadow());
    m.add(part(G.dome, TIN).pos(0, -0.1, 0).scl(0.56, 0.42, 0.58));
    // team stripe ring around the waistline
    m.add(part(G.stripe, teamMat(color, 0.4)).pos(0, -0.02, 0).rot(Math.PI / 2, 0, 0).scl(0.62));

    // face: two big expressive eyes + rosy cheeks
    m.add(part(G.droneEye, glow).pos(-0.1, 0.05, 0.27).scl(0.9), "eyeL");
    m.add(part(G.droneEye, glow).pos(0.1, 0.05, 0.27).scl(0.9), "eyeR");
    m.add(part(G.rivet, CHEEK).pos(-0.17, -0.04, 0.26));
    m.add(part(G.rivet, CHEEK).pos(0.17, -0.04, 0.26));

    // antenna + team bobble on top
    m.add(part(G.antenna, GUNMETAL).pos(0, 0.24, -0.04).scl(0.6, 0.38, 0.6));
    m.add(part(G.lamp, glowMat(color, 1.5)).pos(0, 0.43, -0.04).scl(0.8));

    // amber hover thrusters
    m.add(part(G.droneThruster, TIN).pos(0.27, -0.16, -0.02).rot(0, 0, 0.18));
    m.add(part(G.droneThrusterGlow, glowMat(AMBER, 1.6)).pos(0.29, -0.25, -0.02));
    m.add(part(G.droneThruster, TIN).pos(-0.27, -0.16, -0.02).rot(0, 0, -0.18));
    m.add(part(G.droneThrusterGlow, glowMat(AMBER, 1.6)).pos(-0.29, -0.25, -0.02));

    // carried resource crystal (hidden unless carrying)
    m.add(part(G.crystal, glowMat(0x63e8db, 1.4)).pos(0, -0.28, 0.24).visible(false), "carry");

    // tool arm: dark socket, tin arm, spinning copper cog "wrench"
    const cogMat = glowMat(0xc9853f, 0.25);
    const tool = new THREE.Group();
    tool.add(part(G.droneElbow, DARK).scl(1.5).mesh);
    tool.add(part(G.droneArm, TIN).mesh);
    const cogTip = part(G.cog, cogMat).pos(0, 0, 0.34).rot(0, Math.PI / 2, 0).scl(0.42).mesh;
    tool.add(cogTip);
    tool.position.set(0.26, -0.04, 0.1);
    tool.rotation.set(0.35, -0.2, 0);
    m.addGroup(tool, "tool");

    m.body.position.y = 0.42;
    m.setAnim({
      kind: "worker",
      hover: e.id % 7,
      baseColor: new THREE.Color(color),
      eye: glow,
      carry: m.named.carry,
      carryMat: m.named.carry.material,
      tool: m.named.tool,
      cog: cogTip,
      cogMat,
    });
    return m.build();
  },

  animate(g, e, t, move, a) {
    g.userData.body.position.y = 0.42 + Math.sin(t * 3 + a.hover) * 0.05 + move * 0.04;
    g.userData.body.rotation.x = move * 0.18;

    a.carry.visible = e.carry > 0;
    if (e.carry > 0) {
      a.carry.rotation.y = t * 2;
      const hex = e.carryKind === 1 ? 0x7cd94f : 0x63e8db;
      a.carryMat.color.setHex(hex); a.carryMat.emissive.setHex(hex);
    }

    const kind = e.order?.kind;
    const mining = kind === "gather" && e.order?.phase === "mining";
    if (kind === "gather") {
      a.eye.color.setHex(0x63e8db); a.eye.emissive.setHex(0x63e8db);
      a.eye.emissiveIntensity = 1.8;
    } else if (kind === "build") {
      a.eye.color.setHex(0xffb347); a.eye.emissive.setHex(0xffb347);
      a.eye.emissiveIntensity = 1.8;
    } else {
      a.eye.color.copy(a.baseColor); a.eye.emissive.copy(a.baseColor);
      a.eye.emissiveIntensity = kind === "idle" ? 1.8 : 1.6;
    }

    if (mining) {
      // lean in and buzz the cog like a rock saw
      a.tool.rotation.set(0.15 + Math.sin(t * 20 + e.id) * 0.08, 0, 0);
      a.cog.rotation.x = t * 14;
      a.cogMat.emissive.setHex(0x63e8db);
      a.cogMat.emissiveIntensity = 1.4;
    } else if (kind === "build") {
      // wave the cog around like a socket wrench
      a.tool.rotation.set(-0.2 + Math.sin(t * 3 + e.id) * 0.35, Math.sin(t * 1.7 + e.id) * 0.3, 0);
      a.cog.rotation.x = t * 8;
      a.cogMat.emissive.setHex(0xffb347);
      a.cogMat.emissiveIntensity = 1.4;
    } else {
      a.tool.rotation.set(0.35, -0.2, 0);
      a.cog.rotation.x = t * 0.8;
      a.cogMat.emissive.setHex(0xc9853f);
      a.cogMat.emissiveIntensity = 0.25;
    }
  },
});

// ===========================================================================
// MARINE ("Trooper") — small trooper with visor: oversized dome helmet with a
// wraparound team visor, stubby legs, chest cog badge, chunky little blaster.
// ===========================================================================
registerUnit("marine", {
  build(e, color) {
    const shell = shellMat();
    const glow = glowMat(color);
    const m = new ModelBuilder();
    m.addMat(shell);

    // stubby legs with tin boots
    const legL = part(G.leg, DARK).pos(0.1, 0.3, 0.01).scl(0.85, 0.8, 0.85);
    legL.mesh.add(part(G.boot, TIN).pos(0, -0.22, 0.02).mesh);
    m.add(legL, "legL");
    const legR = part(G.leg, DARK).pos(-0.1, 0.3, 0.01).scl(0.85, 0.8, 0.85);
    legR.mesh.add(part(G.boot, TIN).pos(0, -0.22, 0.02).mesh);
    m.add(legR, "legR");

    // compact cream torso with team belt stripe + copper cog badge
    m.add(part(G.torso, shell).pos(0, 0.42, 0).scl(1.0, 0.72, 0.95).shadow());
    m.add(part(G.stripe, teamMat(color, 0.4)).pos(0, 0.33, 0).rot(Math.PI / 2, 0, 0).scl(0.44));
    m.add(part(G.cog, COPPER).pos(0, 0.46, 0.2).scl(0.32));
    m.add(part(G.pack, TIN).pos(0, 0.44, -0.19).scl(0.8, 0.75, 0.8));

    // BIG dome helmet + wraparound team visor (the chibi read)
    m.add(part(G.collar, DARK).pos(0, 0.57, 0));
    m.add(part(G.dome, shell).pos(0, 0.72, 0).scl(0.46, 0.42, 0.46).shadow());
    m.add(part(G.domeVisor, glow).pos(0, 0.72, 0).scl(0.46, 0.42, 0.46));

    // helmet antenna + team bobble
    m.add(part(G.antenna, GUNMETAL).pos(0.15, 0.88, -0.06).rot(0, 0, -0.3).scl(0.5, 0.3, 0.5));
    m.add(part(G.lamp, glowMat(color, 1.5)).pos(0.23, 1.14, -0.06).scl(0.6));

    // tin dome pauldrons with a copper rivet each
    m.add(part(G.pauldron, TIN).pos(0.25, 0.56, 0).scl(1.05, 0.85, 1.0));
    m.add(part(G.pauldron, TIN).pos(-0.25, 0.55, 0).scl(1.0, 0.8, 0.95));
    m.add(part(G.rivet, COPPER).pos(0.27, 0.66, 0));
    m.add(part(G.rivet, COPPER).pos(-0.27, 0.64, 0));

    // chunky little blaster: tin body, copper muzzle band, amber tip
    const gunGroup = new THREE.Group();
    gunGroup.add(part(G.gunReceiver, DARK).pos(0, 0, -0.06).mesh);
    gunGroup.add(part(G.gunBody, TIN).pos(0, 0, 0.08).scl(1, 1, 0.7).mesh);
    gunGroup.add(part(G.gunMag, GUNMETAL).pos(0, -0.1, -0.02).mesh);
    gunGroup.add(part(G.gunTip, COPPER).pos(0, 0, 0.26).mesh);
    gunGroup.add(part(G.lamp, glowMat(AMBER, 1.5)).pos(0, 0, 0.35).scl(0.55).mesh);
    gunGroup.position.set(0.24, 0.44, 0.14);
    m.addGroup(gunGroup, "gunGroup");

    m.liftToGround();
    m.setAnim({ kind: "marine", legL: m.named.legL, legR: m.named.legR, gunGroup, gunHome: 0.14, recoil: 0 });
    return m.build();
  },

  animate(g, e, t, move, a) {
    const phase = t * 9 + e.id * 1.7;
    const sw = Math.sin(phase) * 0.55 * move;
    a.legL.rotation.x = sw;
    a.legR.rotation.x = -sw;
    g.userData.body.position.y = Math.abs(Math.sin(phase)) * 0.045 * move;
    if (a.recoil > 0) {
      a.recoil = Math.max(0, a.recoil - 0.5 / 60);
      a.gunGroup.position.z = a.gunHome - a.recoil * 0.9;
    }
  },
});

// ===========================================================================
// BRUTE ("Bruiser") — big shoulders: barrel-bodied heavy with huge tin dome
// pauldrons, tiny dome head peeking over its chest, twin antenna "horns",
// belly cog, and enormous fists.
// ===========================================================================
registerUnit("brute", {
  build(e, color) {
    const shell = shellMat();
    const glow = glowMat(color);
    const m = new ModelBuilder();
    m.addMat(shell);

    // stubby feet peeking out under the barrel body
    m.add(part(G.boot, TIN).pos(0.2, 0.06, 0.08).scl(1.5, 1.3, 1.5));
    m.add(part(G.boot, TIN).pos(-0.2, 0.06, 0.08).scl(1.5, 1.3, 1.5));

    // barrel body: cream sphere, tin chest plate, copper belly cog, team stripe
    m.add(part(G.bruteCore, shell).pos(0, 0.56, -0.02).scl(1.0, 0.92, 0.95).shadow());
    m.add(part(G.bruteChest, TIN).pos(0, 0.46, 0.2).rot(0.15, 0, 0).scl(0.95, 0.8, 0.6));
    m.add(part(G.cog, COPPER).pos(0, 0.48, 0.34).rot(0.15, 0, 0).scl(0.55));
    m.add(part(G.stripe, teamMat(color, 0.4)).pos(0, 0.32, -0.02).rot(Math.PI / 2, 0, 0).scl(0.76));

    // tiny dome head peeking over the chest, wide team visor
    m.add(part(G.dome, shell).pos(0, 0.96, 0.12).scl(0.42, 0.36, 0.42).shadow());
    m.add(part(G.domeVisor, glow).pos(0, 0.96, 0.12).scl(0.42, 0.36, 0.42));

    // twin antenna horns with team bobbles (bigger robot = more antennae)
    m.add(part(G.antenna, GUNMETAL).pos(0.12, 1.08, 0.02).rot(0, 0, -0.35).scl(0.6, 0.35, 0.6));
    m.add(part(G.antenna, GUNMETAL).pos(-0.12, 1.08, 0.02).rot(0, 0, 0.35).scl(0.6, 0.35, 0.6));
    m.add(part(G.lamp, glowMat(color, 1.5)).pos(0.23, 1.37, 0.02).scl(0.7));
    m.add(part(G.lamp, glowMat(color, 1.5)).pos(-0.23, 1.37, 0.02).scl(0.7));

    // HUGE tin dome pauldrons studded with copper rivets — the silhouette
    m.add(part(G.dome, TIN).pos(0.52, 0.92, -0.02).scl(0.48, 0.36, 0.48).shadow());
    m.add(part(G.dome, TIN).pos(-0.52, 0.92, -0.02).scl(0.46, 0.34, 0.46).shadow());
    m.add(part(G.rivet, COPPER).pos(0.42, 1.05, 0.1));
    m.add(part(G.rivet, COPPER).pos(0.62, 1.05, -0.1));
    m.add(part(G.rivet, COPPER).pos(-0.42, 1.03, 0.1));
    m.add(part(G.rivet, COPPER).pos(-0.62, 1.03, -0.1));

    // arms: dark upper, tin forearm, cream gauntlet, huge dark fist
    const armL = new THREE.Group();
    armL.add(part(G.bruteArm, DARK).mesh);
    armL.add(part(G.bruteForearm, TIN).pos(0, -0.4, 0).mesh);
    armL.add(part(G.bruteGauntlet, shell).pos(0, -0.62, 0).mesh);
    armL.add(part(G.bruteFist, DARK).pos(0, -0.8, 0).scl(1.25).mesh);
    armL.position.set(0.6, 0.8, 0.02);
    m.addGroup(armL, "armL");

    const armR = armL.clone();
    armR.position.x = -0.6;
    m.addGroup(armR, "armR");

    m.liftToGround();
    m.setAnim({ kind: "brute", armL, armR, recoil: 0 });
    return m.build();
  },

  animate(g, e, t, move, a) {
    const phase = t * 9 + e.id * 1.7;
    const sw = Math.sin(phase * 0.8) * 0.5 * move;
    a.armL.rotation.x = sw;
    a.armR.rotation.x = -sw;
    g.userData.body.position.y = Math.abs(Math.sin(phase * 0.8)) * 0.06 * move;
    g.userData.body.rotation.z = Math.sin(phase * 0.8) * 0.05 * move;
    if (a.recoil > 0) {
      a.recoil = Math.max(0, a.recoil - 0.6 / 60);
      g.userData.body.position.z = a.recoil * 0.5;
    }
  },
});

// ===========================================================================
// TANK ("Crawler") — low wide artillery: pill-shaped rubber treads with copper
// cog hubs, cream hull, dome turret with team visor, stubby fat barrel.
// ===========================================================================
registerUnit("tank", {
  build(e, color) {
    const shell = shellMat();
    const glow = glowMat(color);
    const m = new ModelBuilder();
    m.addMat(shell);

    // pill treads + tin fenders with copper rivet rows + cog wheel hubs
    for (const sx of [0.48, -0.48]) {
      m.add(part(G.tread, RUBBER).pos(sx, 0.2, 0).scl(1.2, 1.1, 1.4).shadow());
      m.add(part(G.tankGuard, TIN).pos(sx, 0.42, 0).scl(0.9, 1, 0.95));
      for (const rz of [-0.42, 0, 0.42])
        m.add(part(G.rivet, COPPER).pos(sx, 0.47, rz));
      m.add(part(G.cog, COPPER).pos(sx * 1.28, 0.2, 0).rot(0, Math.PI / 2, 0).scl(0.5));
    }

    // hull: cream slab, tin glacis, team stripe across the brow
    m.add(part(G.tankHull, shell).pos(0, 0.4, 0).scl(1, 1, 0.95).shadow());
    m.add(part(G.tankGlacis, TIN).pos(0, 0.38, 0.48).rot(-0.5, 0, 0));
    m.add(part(GLACIS_STRIPE, teamMat(color, 0.4)).pos(0, 0.5, 0.42));
    m.add(part(G.tankTurretBevel, TIN).pos(0, 0.54, -0.02).scl(0.95, 0.6, 0.95));

    // dome turret with team visor, antenna bobble, stubby fat barrel
    const turret = new THREE.Group();
    turret.add(part(G.dome, shell).pos(0, 0.02, 0).scl(0.5, 0.4, 0.5).shadow().mesh);
    turret.add(part(G.domeVisor, glow).pos(0, 0.02, 0).scl(0.5, 0.4, 0.5).mesh);
    turret.add(part(G.tankMantlet, TIN).pos(0, -0.02, 0.22).scl(0.8, 0.7, 0.8).mesh);
    turret.add(part(G.antenna, GUNMETAL).pos(-0.16, 0.12, -0.14).rot(0.35, 0, 0).scl(0.6, 0.35, 0.6).mesh);
    turret.add(part(G.lamp, glowMat(color, 1.5)).pos(-0.16, 0.42, -0.25).scl(0.7).mesh);

    const barrelGroup = new THREE.Group();
    barrelGroup.add(part(G.tankBarrel2, TIN).mesh);
    barrelGroup.add(part(G.tankBarrel, shell).pos(0, 0, 0.05).scl(1.25, 1.25, 0.8).mesh);
    barrelGroup.add(part(G.tankMuzzle, COPPER).pos(0, 0, 0.56).scl(1.1, 1.1, 0.7).mesh);
    barrelGroup.add(part(G.tankMuzzle, glowMat(AMBER, 1.5)).pos(0, 0, 0.62).scl(0.6).mesh);
    barrelGroup.position.set(0, 0, 0.34);
    turret.add(barrelGroup);
    turret.position.set(0, 0.68, -0.02);
    m.addGroup(turret, "turret");

    m.liftToGround();
    m.setAnim({ kind: "tank", turret, barrelGroup, barrelHome: 0.34, recoil: 0 });
    return m.build();
  },

  animate(g, e, t, move, a) {
    const aim = g.userData.aimYaw;
    if (aim !== undefined) {
      let dy = aim - a.turret.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      a.turret.rotation.y += dy * 0.12;
    }
    if (a.recoil > 0) {
      a.recoil = Math.max(0, a.recoil - 0.9 / 60);
      a.barrelGroup.position.z = a.barrelHome - a.recoil * 3.2;
    } else {
      a.barrelGroup.position.z += (a.barrelHome - a.barrelGroup.position.z) * 0.2;
    }
  },
});

// ===========================================================================
// WRAITH — nimble winged hoverer: plump cream fuselage, glass dome canopy,
// stubby wings with team wingtip lights, twin amber engines, tail bobble.
// ===========================================================================
registerUnit("wraith", {
  build(e, color) {
    const shell = shellMat();
    const m = new ModelBuilder();
    m.addMat(shell);

    // plump body with rounded tin nose cap and glass dome canopy
    m.add(part(G.bansheeBody, shell).scl(0.75, 0.75, 0.8).shadow());
    m.add(part(G.dome, TIN).pos(0, 0, 0.4).scl(0.24, 0.2, 0.28));
    m.add(part(G.dome, glowMat(0x9fdcff, 0.7)).pos(0, 0.1, 0.16).scl(0.24, 0.2, 0.3));
    m.add(part(G.rivet, COPPER).pos(0.12, 0.04, 0.34));
    m.add(part(G.rivet, COPPER).pos(-0.12, 0.04, 0.34));

    // spine with team racing stripe
    m.add(part(G.wraithSpine, TIN).pos(0, 0.08, -0.12).scl(0.8, 0.7, 0.8));
    m.add(part(SPINE_STRIPE, teamMat(color, 0.5)).pos(0, 0.13, -0.12));

    // stubby wings with team wingtip lights
    m.add(part(G.wraithWing, shell).pos(0, -0.02, -0.08).scl(0.8, 1, 1));
    m.add(part(G.lamp, glowMat(color, 1.5)).pos(0.45, -0.02, -0.08).scl(0.7, 0.5, 1.1));
    m.add(part(G.lamp, glowMat(color, 1.5)).pos(-0.45, -0.02, -0.08).scl(0.7, 0.5, 1.1));

    // tail + fin + antenna bobble
    m.add(part(G.wraithTail, shell).pos(0, 0.02, -0.46).scl(0.9, 1, 1));
    m.add(part(G.wraithFin, TIN).pos(0, 0.13, -0.48));
    m.add(part(G.antenna, GUNMETAL).pos(0, 0.24, -0.54).rot(0.4, 0, 0).scl(0.5, 0.28, 0.5));
    m.add(part(G.lamp, glowMat(color, 1.5)).pos(0, 0.47, -0.64).scl(0.6));

    // twin amber engines
    const engMat = glowMat(AMBER, 2.2);
    for (const sx of [0.24, -0.24]) {
      m.add(part(G.wraithNacelle, TIN).pos(sx, -0.04, -0.38));
      m.add(part(G.wraithEngine, DARK).pos(sx, -0.04, -0.46));
      m.add(part(G.wraithEngineGlow, engMat).pos(sx, -0.04, -0.51));
    }

    m.setAnim({ kind: "wraith", engMat });
    return m.build();
  },

  animate(g, e, t, move, a) {
    a.engMat.emissiveIntensity = 2.0 + Math.sin(t * 18 + e.id) * 0.6;
  },
});

// ===========================================================================
// BANSHEE — heavier gunship: chunky cream hull, glass dome cockpit, riveted
// tin armor, twin amber rotors on copper hubs, chin gun + rocket pods.
// ===========================================================================
registerUnit("banshee", {
  build(e, color) {
    const shell = shellMat();
    const m = new ModelBuilder();
    m.addMat(shell);

    // chunky hull + glass dome cockpit
    m.add(part(G.bansheeBody, shell).scl(1.15, 1.05, 1.05).shadow());
    m.add(part(G.dome, glowMat(0x9fdcff, 0.7)).pos(0, 0.13, 0.36).scl(0.3, 0.24, 0.34));

    // riveted tin dorsal armor with team spine stripe
    m.add(part(G.bansheeArmor, TIN).pos(0, 0.06, -0.04).scl(1.05, 0.9, 1.0));
    m.add(part(SPINE_STRIPE, teamMat(color, 0.5)).pos(0, 0.17, -0.06));
    m.add(part(G.rivet, COPPER).pos(0.14, 0.17, 0.16));
    m.add(part(G.rivet, COPPER).pos(-0.14, 0.17, 0.16));
    m.add(part(G.rivet, COPPER).pos(0.14, 0.17, -0.26));
    m.add(part(G.rivet, COPPER).pos(-0.14, 0.17, -0.26));

    // chin gun: tin barrel, copper muzzle band, amber tip
    m.add(part(G.bansheeGun, TIN).pos(0, -0.18, 0.3));
    m.add(part(G.tankMuzzle, COPPER).pos(0, -0.18, 0.66).scl(0.55));
    m.add(part(G.lamp, glowMat(AMBER, 1.5)).pos(0, -0.18, 0.72).scl(0.5));

    // rocket pods with copper tips
    m.add(part(G.bansheePod, DARK).pos(0.3, -0.1, 0.05));
    m.add(part(G.bansheePod, DARK).pos(-0.3, -0.1, 0.05));
    m.add(part(G.rivet, COPPER).pos(0.3, -0.1, 0.22).scl(1.6));
    m.add(part(G.rivet, COPPER).pos(-0.3, -0.1, 0.22).scl(1.6));

    // tail + antenna bobble
    m.add(part(G.wraithTail, shell).pos(0, 0.05, -0.56).scl(0.9, 1, 1));
    m.add(part(G.wraithFin, TIN).pos(0, 0.16, -0.58));
    m.add(part(G.antenna, GUNMETAL).pos(0, 0.26, -0.62).rot(0.4, 0, 0).scl(0.5, 0.28, 0.5));
    m.add(part(G.lamp, glowMat(color, 1.5)).pos(0, 0.49, -0.72).scl(0.6));

    // twin rotors: tin masts, copper hubs, translucent amber blur discs
    const rotorMat = new THREE.MeshToonMaterial({
      color: 0xffd9a0, gradientMap: toonGradient(),
      emissive: AMBER, emissiveIntensity: 0.5,
      transparent: true, opacity: 0.5,
    });
    const rotors = [];
    for (const sx of [0.36, -0.36]) {
      m.add(part(G.bansheeArm, TIN).pos(sx, 0.14, -0.05).rot(Math.PI / 2, 0, 0));
      m.add(part(G.bansheeHub, COPPER).pos(sx, 0.3, -0.05));
      const disc = part(G.bansheeRotor, rotorMat).pos(sx, 0.38, -0.05).mesh;
      m.add(disc);
      rotors.push(disc);
    }

    m.setAnim({ kind: "banshee", rotors });
    return m.build();
  },

  animate(g, e, t, move, a) {
    for (let i = 0; i < a.rotors.length; i++)
      a.rotors[i].rotation.y = t * (26 + i * 3);
  },
});
