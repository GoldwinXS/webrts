// Unit model definitions. Each unit has a build(e, color) function that
// returns a THREE.Group with userData.anim set, and an animate(g, e, t, move, a)
// function that drives per-frame animation.
//
// To add a new unit, write build + animate here, then register at the bottom.

import * as THREE from "three";
import { ModelBuilder, part } from "./parts.js";
import { registerUnit } from "./registry.js";
import {
  G, DARK, GUNMETAL, TRIM, RUBBER,
  teamMat, glowMat, liftToGround,
} from "./core.js";

// ===========================================================================
// WORKER — plucky utility bot: round pod, two expressive eyes, magic wand
// ===========================================================================
registerUnit("worker", {
  build(e, color) {
    const team = teamMat(color);
    const glow = glowMat(color);
    const m = new ModelBuilder();
    m.addMat(team);

    m.add(part(G.dronePod, team).scl(1, 0.78, 1.12).shadow());
    m.add(part(G.droneBelly, GUNMETAL).pos(0, -0.16, 0.02).scl(1.05, 0.8, 1.05));

    // two expressive eyes
    m.add(part(G.droneEye, glow).pos(-0.1, 0.06, 0.26), "eyeL");
    m.add(part(G.droneEye, glow).pos(0.1, 0.06, 0.26), "eyeR");

    // Cute rosy cheeks under the eyes
    const cheekMat = new THREE.MeshBasicMaterial({ color: 0xff88aa });
    const cheekGeo = new THREE.SphereGeometry(0.035, 8, 8);
    m.add(part(cheekGeo, cheekMat).pos(-0.15, -0.01, 0.28));
    m.add(part(cheekGeo, cheekMat).pos(0.15, -0.01, 0.28));

    // thrusters
    m.add(part(G.droneThruster, GUNMETAL).pos(0.27, -0.09, -0.02).rot(0, 0, 0.18));
    m.add(part(G.droneThrusterGlow, glowMat(0x63e8db, 1.2)).pos(0.29, -0.17, -0.02));
    m.add(part(G.droneThruster, GUNMETAL).pos(-0.27, -0.09, -0.02).rot(0, 0, -0.18));
    m.add(part(G.droneThrusterGlow, glowMat(0x63e8db, 1.2)).pos(-0.29, -0.17, -0.02));

    // carried crystal (hidden unless carrying)
    m.add(part(G.crystal, glowMat(0x63e8db, 1.4)).pos(0, -0.2, 0.24).visible(false), "carry");

    // magic wand with glowing crystal tip
    const wand = new THREE.Group();
    wand.add(part(G.droneWand, TRIM).mesh);
    const wandTipMesh = part(G.droneWandTip, glowMat(0x63e8db, 1.2)).pos(0, 0, 0.35).mesh;
    wand.add(wandTipMesh);
    wand.position.set(0.2, -0.02, 0.14);
    wand.rotation.set(0.25, 0, -0.25);
    wand.scale.setScalar(0.85);
    m.addGroup(wand, "wand");

    m.body.position.y = 0.42;
    m.liftToGround();
    m.setAnim({
      kind: "worker",
      hover: e.id % 7,
      baseColor: new THREE.Color(color),
      eye: glow,
      carry: m.named.carry,
      carryMat: m.named.carry.material,
      wand: m.named.wand,
      wandTip: wandTipMesh.material,
    });
    return m.build();
  },

  animate(g, e, t, move, a) {
    const phase = t * 9 + e.id * 1.7;
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
    } else if (kind === "idle") {
      a.eye.color.copy(a.baseColor); a.eye.emissive.copy(a.baseColor);
      a.eye.emissiveIntensity = 1.8;
    } else {
      a.eye.color.copy(a.baseColor); a.eye.emissive.copy(a.baseColor);
      a.eye.emissiveIntensity = 1.6;
    }

    if (mining) {
      a.wand.rotation.x = -0.1 + Math.sin(t * 20 + e.id) * 0.08;
      a.wand.scale.setScalar(1);
      a.wand.position.z = 0.18 + Math.sin(t * 20 + e.id) * 0.02;
      a.wandTip.color.setHex(0x63e8db); a.wandTip.emissive.setHex(0x63e8db);
      a.wandTip.emissiveIntensity = 1.8;
    } else if (kind === "build") {
      a.wand.rotation.x = -0.15 + Math.sin(t * 3 + e.id) * 0.3;
      a.wand.rotation.y = Math.sin(t * 1.7 + e.id) * 0.35;
      a.wand.scale.setScalar(1);
      a.wand.position.z = 0.16;
      a.wandTip.color.setHex(0xffb347); a.wandTip.emissive.setHex(0xffb347);
      a.wandTip.emissiveIntensity = 1.8;
    } else {
      a.wand.rotation.set(0.25, 0, -0.25);
      a.wand.scale.setScalar(0.85);
      a.wand.position.z = 0.14;
      a.wandTip.emissiveIntensity = 0.5;
    }
  },
});

// ===========================================================================
// MARINE — iconic armored footman: bulky torso, visor, chunky rifle
// ===========================================================================
registerUnit("marine", {
  build(e, color) {
    const team = teamMat(color);
    const glow = glowMat(color);
    const m = new ModelBuilder();
    m.addMat(team);

    m.add(part(G.torso, team).pos(0, 0.48, 0).scl(1.1, 0.92, 1.0).shadow());
    m.add(part(G.chestPlate, GUNMETAL).pos(0, 0.5, 0.14).rot(-0.12, 0, 0));
    m.add(part(G.collar, DARK).pos(0, 0.68, 0));
    m.add(part(G.head, DARK).pos(0, 0.78, 0).scl(1.25, 1.15, 1.1));
    m.add(part(G.visor, glow).pos(0, 0.79, 0.1).rot(-0.1, 0, 0));
    m.add(part(G.pauldron, team).pos(0.24, 0.6, 0).scl(1.1, 0.9, 1.05));
    m.add(part(G.pauldron, team).pos(-0.24, 0.58, 0).scl(1, 0.85, 1));
    m.add(part(G.pack, GUNMETAL).pos(0, 0.52, -0.2));

    // legs with boots
    const legL = part(G.leg, DARK).pos(0.11, 0.28, 0.02).rot(0.08, 0, 0);
    const bootL = part(G.boot, TRIM).pos(0, -0.24, 0.02).mesh;
    legL.mesh.add(bootL);
    m.add(legL, "legL");
    const legR = part(G.leg, DARK).pos(-0.11, 0.28, 0.02).rot(0.08, 0, 0);
    legR.mesh.add(bootL.clone());
    m.add(legR, "legR");

    // gun assembly
    const gunGroup = new THREE.Group();
    gunGroup.add(part(G.gunBody, GUNMETAL).pos(0, 0, 0.06).mesh);
    gunGroup.add(part(G.gunReceiver, DARK).pos(0, 0, -0.08).mesh);
    gunGroup.add(part(G.gunMag, TRIM).pos(0, -0.11, -0.04).mesh);
    gunGroup.add(part(G.gunTip, glow).pos(0, 0, 0.32).mesh);
    gunGroup.position.set(0.22, 0.5, 0.16);
    m.addGroup(gunGroup, "gunGroup");

    m.liftToGround();
    m.setAnim({ kind: "marine", legL: m.named.legL, legR: m.named.legR, gunGroup, gunHome: 0.16, recoil: 0 });
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
// BRUTE — chunky teddy-bear bruiser: round body, friendly eye, big fists
// ===========================================================================
registerUnit("brute", {
  build(e, color) {
    const team = teamMat(color);
    const glow = glowMat(color);
    const m = new ModelBuilder();
    m.addMat(team);

    m.add(part(G.bruteCore, team).pos(0, 0.5, -0.04).scl(1.0, 0.9, 0.95).shadow());
    m.add(part(G.bruteChest, GUNMETAL).pos(0, 0.5, 0.14).rot(0.12, 0, 0));
    m.add(part(G.bruteShoulder, DARK).pos(0.5, 0.9, -0.02).scl(1.2, 0.95, 1.1));
    m.add(part(G.bruteShoulder, DARK).pos(-0.48, 0.82, -0.02).scl(1.1, 0.9, 1.0));
    m.add(part(G.bruteHead, DARK).pos(0, 0.62, 0.22).scl(1.3, 1.15, 1.1));
    m.add(part(G.bruteJaw, GUNMETAL).pos(0, 0.5, 0.32));
    m.add(part(G.droneEye, glowMat(0xffcc66, 1.4)).pos(0, 0.66, 0.34).scl(1.1, 1.1, 1));

    // arms
    const armL = new THREE.Group();
    armL.add(part(G.bruteArm, DARK).mesh);
    armL.add(part(G.bruteForearm, GUNMETAL).pos(0, -0.4, 0).mesh);
    armL.add(part(G.bruteGauntlet, team).pos(0, -0.62, 0).mesh);
    armL.add(part(G.bruteFist, DARK).pos(0, -0.78, 0).scl(1.2).mesh);
    armL.position.set(0.54, 0.66, 0.02);
    m.addGroup(armL, "armL");

    const armR = armL.clone();
    armR.position.x = -0.54;
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
    const stomp = Math.abs(Math.sin(phase * 0.8)) * 0.06 * move;
    g.userData.body.position.y = stomp;
    g.userData.body.rotation.z = Math.sin(phase * 0.8) * 0.05 * move;
    if (a.recoil > 0) {
      a.recoil = Math.max(0, a.recoil - 0.6 / 60);
      g.userData.body.position.z = a.recoil * 0.5;
    }
  },
});

// ===========================================================================
// TANK — low wide siege tank: treads, turret, long barrel
// ===========================================================================
registerUnit("tank", {
  build(e, color) {
    const team = teamMat(color);
    const glow = glowMat(color);
    const m = new ModelBuilder();
    m.addMat(team);

    m.add(part(G.tankHull, team).pos(0, 0.34, 0).shadow());
    m.add(part(G.tankGlacis, GUNMETAL).pos(0, 0.32, 0.52).rot(-0.5, 0, 0));
    m.add(part(G.tankTread, RUBBER).pos(0.55, 0.2, 0));
    m.add(part(G.tankTread, RUBBER).pos(-0.55, 0.2, 0));

    for (const [tx, tz] of [[0.55,-0.42],[0.55,0],[0.55,0.42],[-0.55,-0.42],[-0.55,0],[-0.55,0.42]])
      m.add(part(G.tankWheel, TRIM).pos(tx, 0.12, tz));

    m.add(part(G.tankGuard, DARK).pos(0.55, 0.4, 0));
    m.add(part(G.tankGuard, DARK).pos(-0.55, 0.4, 0));
    m.add(part(new THREE.BoxGeometry(1.16, 0.1, 1.0), GUNMETAL).pos(0, 0.48, 0));

    // turret group
    const turret = new THREE.Group();
    turret.add(part(G.tankTurret, team).mesh);
    turret.add(part(G.tankTurretBevel, team).pos(0, 0, 0.02).rot(Math.PI/2, 0, 0).scl(1, 1, 0.55).mesh);
    turret.add(part(G.tankMantlet, GUNMETAL).pos(0, 0, 0.32).mesh);
    turret.add(part(G.droneEye, glow).pos(0.1, 0.16, -0.12).scl(1.4, 0.7, 1).mesh);

    const barrelGroup = new THREE.Group();
    barrelGroup.add(part(G.tankBarrel2, DARK).mesh);
    barrelGroup.add(part(G.tankBarrel, GUNMETAL).pos(0, 0, 0.44).mesh);
    barrelGroup.add(part(G.tankMuzzle, GUNMETAL).pos(0, 0, 1.02).mesh);
    barrelGroup.add(part(G.tankMuzzle, glow).pos(0, 0, 1.02).scl(0.6).mesh);
    barrelGroup.position.set(0, 0, 0.28);
    turret.add(barrelGroup);
    turret.position.set(0, 0.62, 0);
    m.addGroup(turret, "turret");

    m.liftToGround();
    m.setAnim({ kind: "tank", turret, barrelGroup, barrelHome: 0.28, recoil: 0 });
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
// WRAITH — sleek air-superiority dart: fuselage, swept wings, twin engines
// ===========================================================================
registerUnit("wraith", {
  build(e, color) {
    const team = teamMat(color);
    const glow = glowMat(color);
    const m = new ModelBuilder();
    m.addMat(team);

    m.add(part(G.wraithFuse, team).shadow());
    m.add(part(G.wraithSpine, GUNMETAL).pos(0, 0.09, -0.06));
    m.add(part(G.wraithNose, DARK));
    m.add(part(G.wraithWing, team).pos(0, -0.02, -0.05));
    m.add(part(G.wraithTail, team).pos(0, 0.02, -0.5));
    m.add(part(G.wraithFin, DARK).pos(0, 0.14, -0.5));
    m.add(part(G.bansheeCanopy, glowMat(0x9fdcff, 0.7)).pos(0, 0.1, 0.2).scl(0.7, 0.5, 1.1));

    const engMat = glowMat(color, 2.4);
    m.add(part(G.wraithNacelle, GUNMETAL).pos(0.22, -0.04, -0.42));
    m.add(part(G.wraithEngine, DARK).pos(0.22, -0.04, -0.5));
    m.add(part(G.wraithEngineGlow, engMat).pos(0.22, -0.04, -0.55));
    m.add(part(G.wraithNacelle, GUNMETAL).pos(-0.22, -0.04, -0.42));
    m.add(part(G.wraithEngine, DARK).pos(-0.22, -0.04, -0.5));
    m.add(part(G.wraithEngineGlow, engMat).pos(-0.22, -0.04, -0.55));

    m.setAnim({ kind: "wraith", engMat, roll: 0 });
    return m.build();
  },

  animate(g, e, t, move, a) {
    a.engMat.emissiveIntensity = 2.0 + Math.sin(t * 18 + e.id) * 0.6;
  },
});

// ===========================================================================
// BANSHEE — heavy gunship: armored fuselage, twin rotors, rocket pods
// ===========================================================================
registerUnit("banshee", {
  build(e, color) {
    const team = teamMat(color);
    const glow = glowMat(color);
    const m = new ModelBuilder();
    m.addMat(team);

    m.add(part(G.bansheeBody, team).shadow());
    m.add(part(G.bansheeArmor, GUNMETAL).pos(0, 0.02, 0.05));
    m.add(part(G.bansheeCanopy, glowMat(0x9fdcff, 0.7)).pos(0, 0.12, 0.4).scl(0.9, 0.7, 1));
    m.add(part(G.bansheeGun, GUNMETAL).pos(0, -0.16, 0.35));
    m.add(part(G.tankMuzzle, glow).pos(0, -0.16, 0.62).scl(0.6));
    m.add(part(G.bansheePod, DARK).pos(0.26, -0.12, 0.02));
    m.add(part(G.bansheePod, DARK).pos(-0.26, -0.12, 0.02));

    // two rotor assemblies
    const rotors = [];
    for (const side of [0.34, -0.34]) {
      m.add(part(G.bansheeArm, GUNMETAL).pos(side, 0.14, -0.05).rot(Math.PI/2, 0, 0));
      m.add(part(G.bansheeHub, TRIM).pos(side, 0.3, -0.05));
      const disc = part(G.bansheeRotor, glowMat(color, 0.6)).pos(side, 0.37, -0.05).mesh;
      m.add(disc);
      rotors.push(disc);
    }

    m.setAnim({ kind: "banshee", rotors, roll: 0 });
    return m.build();
  },

  animate(g, e, t, move, a) {
    for (let i = 0; i < a.rotors.length; i++)
      a.rotors[i].rotation.y = t * (26 + i * 3);
  },
});
