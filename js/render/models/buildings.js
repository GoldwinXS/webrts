// Building model definitions. Each building has a build(e, color, size) function
// and an optional animate(g, e, t, move, a) function.
//
// To add a new building, write build + animate here, then register at the bottom.

import * as THREE from "three";
import { wrapBuilding } from "./parts.js";
import { registerBuilding, addLamp } from "./registry.js";
import {
  G, DARK, GUNMETAL, TRIM, SCAFFOLD, BUILDING_BASE,
  teamMat, glowMat, toonGradient, liftToGround,
} from "./core.js";

// Helper: create a one-off BoxGeometry mesh with position
function box(w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

// Helper: create a one-off CylinderGeometry mesh with position
function cyl(rTop, rBot, h, seg, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat);
  m.position.set(x, y, z);
  return m;
}

// Helper: a thin emissive strip (window/vent glow) that reads with bloom.
function strip(w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

// Helper: a chamfered/beveled box built from a base + slightly inset cap so
// silhouettes read less like plain cubes. Returns a Group.
function beveledBlock(w, h, d, mat, bevel = 0.12) {
  const grp = new THREE.Group();
  const base = box(w, h - bevel, d, mat, 0, 0, 0);
  const cap = box(w - bevel * 1.6, bevel, d - bevel * 1.6, mat, 0, h / 2 - bevel / 2, 0);
  grp.add(base, cap);
  return grp;
}

// Helper: run a row of small panel/rivet detail boxes along an edge.
function panelRow(n, spacing, mat, x0, y, z, sx, sy, sz, axis = "x") {
  const grp = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * spacing;
    const p = box(sx, sy, sz, mat,
      x0 + (axis === "x" ? off : 0),
      y,
      z + (axis === "z" ? off : 0));
    grp.add(p);
  }
  return grp;
}

// ===========================================================================
// HQ — command center: broad base, mid storey, control tower, radar dish
// ===========================================================================
registerBuilding("hq", {
  build(e, color, size) {
    const team = teamMat(color, 0.08);
    const glow = glowMat(color);
    const win = glowMat(0x8fd6ff, 0.9);   // cool interior light
    const built = new THREE.Group();
    const anim = { kind: "hq", lamps: [] };

    // Broad footing skirt + beveled main hull for a heavier, readable base
    const skirt = cyl(1.5, 1.6, 0.22, 32, DARK, 0, 0.11, 0); skirt.castShadow = true;
    const hull = cyl(1.3, 1.4, 0.9, 32, BUILDING_BASE, 0, 0.67, 0); hull.castShadow = true;
    // Corner buttresses break the boxy silhouette - REMOVED FOR ROUND DESIGN
    // for (const [cx, cz] of [[1.28,1.28],[-1.28,1.28],[1.28,-1.28],[-1.28,-1.28]]) {
    //   const but = box(0.34, 1.02, 0.34, GUNMETAL, cx, 0.51, cz); but.castShadow = true;
    //   built.add(but);
    // }
    // Glowing window bands on each face
    const windowRing = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.04, 8, 48), win);
    windowRing.rotation.x = Math.PI / 2;
    windowRing.position.y = 0.6;
    // Player-color trim ring around the roofline
    const trim = cyl(1.38, 1.38, 0.16, 32, team, 0, 1.05, 0);
    const trimInset = cyl(1.25, 1.25, 0.06, 32, glow, 0, 1.15, 0);
    // Mid storey (control deck) with paneling
    const b2 = cyl(1.2, 1.25, 0.62, 32, team, 0, 1.42, 0); b2.castShadow = true;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const panel = box(0.5, 0.3, 0.2, GUNMETAL, Math.cos(a) * 1.1, 1.42, Math.sin(a) * 1.1);
      built.add(panel);
    }
    for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const rib = box(0.1, 0.9, 0.1, GUNMETAL, Math.cos(a) * 1.35, 0.67, Math.sin(a) * 1.35);
        built.add(rib);
    }
    // Control tower with banded collar
    const tower = cyl(0.5, 0.7, 0.86, 12, BUILDING_BASE, 0, 2.13, 0); tower.castShadow = true;
    const towerBand = cyl(0.53, 0.53, 0.12, 12, team, 0, 2.46, 0);
    const towerGlow = cyl(0.46, 0.46, 0.08, 12, win, 0, 2.2, 0);
    const cap = cyl(0.34, 0.5, 0.2, 12, GUNMETAL, 0, 2.66, 0);
    // Mast + rotating radar dish on top
    const pole = new THREE.Mesh(G.pole, GUNMETAL); pole.position.y = 2.9; pole.scale.y = 0.55;
    const dish = new THREE.Mesh(G.dish, team); dish.position.y = 3.25;
    const dishTip = new THREE.Mesh(G.lamp, glowMat(0xff5f4c, 1.8)); dishTip.position.set(0.26, 3.25, 0);
    dish.add(dishTip); dishTip.position.set(0.26, 0, 0);
    // Rooftop greebles: antenna + vents
    const antL = new THREE.Mesh(G.antenna, GUNMETAL); antL.position.set(-1.05, 1.7, -1.05);
    const ventA = new THREE.Mesh(G.vent, GUNMETAL); ventA.position.set(-0.8, 1.75, 0.9);
    const ventB = new THREE.Mesh(G.vent, GUNMETAL); ventB.position.set(0.85, 1.75, -0.85);

    built.add(skirt, hull, windowRing, trim, trimInset, b2,
              tower, towerBand, towerGlow, cap, pole, dish, antL, ventA, ventB);
    addLamp(built, anim, 1.3, 1.12, 1.3, color);
    addLamp(built, anim, -1.3, 1.12, 1.3, color);
    addLamp(built, anim, 1.3, 1.12, -1.3, color);
    addLamp(built, anim, -1.3, 1.12, -1.3, color);
    anim.dish = dish;

    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    if (a.dish) a.dish.rotation.y = t * 0.7;
  },
});

// ===========================================================================
// DEPOT — supply silo: squat base, glowing band, domed cap, vent
// ===========================================================================
registerBuilding("depot", {
  build(e, color, size) {
    const team = teamMat(color, 0.08);
    const glow = glowMat(color);
    const gauge = glowMat(0x7cd94f, 0.9);   // fill-level gauge glow
    const built = new THREE.Group();
    const anim = { kind: "depot", lamps: [] };

    // Low armored plinth with a player-color band
    const b1 = beveledBlock(1.7, 0.5, 1.7, BUILDING_BASE, 0.14); b1.position.y = 0.27;
    b1.children.forEach(c => c.castShadow = true);
    const band = box(1.76, 0.12, 1.76, glow, 0, 0.56, 0);
    const deck = box(1.5, 0.14, 1.5, GUNMETAL, 0, 0.68, 0); deck.castShadow = true;

    // Twin fuel/supply silos side by side — distinctive readable silhouette
    const silos = [];
    for (const sx of [-0.42, 0.42]) {
      const tank = cyl(0.36, 0.4, 0.7, 16, team, sx, 1.1, 0); tank.castShadow = true;
      const capT = new THREE.Mesh(new THREE.SphereGeometry(0.36, 16, 8, 0, Math.PI*2, 0, Math.PI/2), GUNMETAL);
      capT.position.set(sx, 1.44, 0); capT.scale.y = 0.55;
      const ribA = cyl(0.38, 0.38, 0.05, 16, GUNMETAL, sx, 1.0, 0);
      const ribB = cyl(0.38, 0.38, 0.05, 16, GUNMETAL, sx, 1.24, 0);
      // vertical fill gauge running up the front of each silo
      const g = strip(0.05, 0.5, 0.06, gauge, sx, 1.1, 0.38);
      silos.push(tank, capT, ribA, ribB, g);
    }
    // Cross catwalk + pipe tying the silos together
    const bridge = box(0.9, 0.08, 0.24, GUNMETAL, 0, 1.32, 0);
    const pipe = new THREE.Mesh(G.pipe, TRIM); pipe.rotation.z = Math.PI / 2;
    pipe.scale.set(1, 1.3, 1); pipe.position.set(0, 0.9, -0.34);
    const vent = new THREE.Mesh(G.vent, GUNMETAL); vent.position.set(0, 1.55, 0); vent.scale.setScalar(0.7);

    for (const [rx, rz] of [[0.72,0.72],[-0.72,0.72],[0.72,-0.72],[-0.72,-0.72]]) {
      const r = new THREE.Mesh(G.lamp, GUNMETAL); r.scale.setScalar(1.4);
      r.position.set(rx, 0.27, rz); built.add(r);
    }
    built.add(b1, band, deck, ...silos, bridge, pipe, vent);
    anim.band = band; anim.gaugeMat = gauge;

    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    if (a.band) a.band.material.emissiveIntensity = 1.1 + Math.sin(t * 2 + e.id) * 0.5;
    if (a.gaugeMat) a.gaugeMat.emissiveIntensity = 0.8 + Math.sin(t * 1.5 + e.id) * 0.35;
  },
});

// ===========================================================================
// REFINERY — gas extractor: dome, intake ring, side tanks, exhaust stack
// ===========================================================================
registerBuilding("refinery", {
  build(e, color, size) {
    const team = teamMat(color, 0.08);
    const glow = glowMat(color);
    const built = new THREE.Group();
    const anim = { kind: "refinery", lamps: [] };

    const skirt = cyl(0.9, 1.0, 0.24, 14, BUILDING_BASE, 0, 0.12, 0);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.82, 16, 10, 0, Math.PI*2, 0, Math.PI/2), BUILDING_BASE);
    dome.position.y = 0.2; dome.scale.y = 0.8; dome.castShadow = true;
    const collar = cyl(0.55, 0.7, 0.3, 14, team, 0, 0.62, 0);
    const intakeMat = glowMat(0x7cd94f, 0.9);
    const intake = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.08, 10, 22), intakeMat);
    intake.rotation.x = Math.PI / 2; intake.position.y = 0.78;

    const pipeGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.72, 10);
    const pipeL = new THREE.Mesh(pipeGeo, GUNMETAL); pipeL.position.set(0.75, 0.4, 0.2); pipeL.rotation.z = 0.3;
    const pipeR = pipeL.clone(); pipeR.position.set(-0.75, 0.4, -0.2); pipeR.rotation.z = -0.3;
    const tankL = cyl(0.22, 0.22, 0.5, 12, team, 0.92, 0.55, 0.2);
    const tankCapL = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 6, 0, Math.PI*2, 0, Math.PI/2), GUNMETAL);
    tankCapL.position.set(0.92, 0.8, 0.2);
    const tankR = tankL.clone(); tankR.position.set(-0.92, 0.55, -0.2);
    const tankCapR = tankCapL.clone(); tankCapR.position.set(-0.92, 0.8, -0.2);
    const stack = new THREE.Mesh(G.vent, GUNMETAL); stack.position.set(0.1, 0.95, -0.55);

    built.add(skirt, dome, collar, intake, pipeL, pipeR, tankL, tankCapL, tankR, tankCapR, stack);
    addLamp(built, anim, 0.95, 0.14, 0.95, color);
    addLamp(built, anim, -0.95, 0.14, -0.95, color);
    anim.intake = intake; anim.intakeMat = intakeMat;

    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    if (a.intakeMat) {
      const on = g.userData.harvesting;
      a.intakeMat.emissiveIntensity = on
        ? 1.8 + Math.sin(t * 9 + e.id) * 1.0
        : 0.55 + Math.sin(t * 2 + e.id) * 0.2;
      a.intake.rotation.z = t * (on ? 1.4 : 0.4);
    }
  },
});

// ===========================================================================
// FACTORY — wide plant: stepped roof, vents, rolling door, smokestack
// ===========================================================================
registerBuilding("factory", {
  build(e, color, size) {
    const team = teamMat(color, 0.08);
    const glow = glowMat(color);
    const built = new THREE.Group();
    const anim = { kind: "factory", lamps: [] };

    const b1 = box(2.7, 0.95, 2.3, BUILDING_BASE, 0, 0.48, 0); b1.castShadow = true;
    const step = box(2.0, 0.5, 1.7, BUILDING_BASE, 0, 1.12, -0.18); step.castShadow = true;
    const roof = box(1.85, 0.22, 1.55, GUNMETAL, 0, 1.45, -0.18); roof.castShadow = true;
    const trim = box(2.74, 0.12, 2.34, team, 0, 0.9, 0);

    const ventGeo = new THREE.CylinderGeometry(0.16, 0.18, 0.7, 10);
    const ventL = new THREE.Mesh(ventGeo, GUNMETAL); ventL.position.set(1.15, 1.15, 0.55);
    const ventCapL = cyl(0.2, 0.16, 0.1, 10, TRIM, 1.15, 1.52, 0.55);
    const ventL2 = new THREE.Mesh(ventGeo, GUNMETAL); ventL2.position.set(1.15, 1.15, 0.05);
    const ventCapL2 = ventCapL.clone(); ventCapL2.position.set(1.15, 1.52, 0.05);
    const flankPipe = new THREE.Mesh(G.pipe, TRIM);
    flankPipe.rotation.x = Math.PI / 2; flankPipe.position.set(-1.36, 0.7, 0.1);
    const louver = box(0.08, 0.5, 1.4, team, 1.37, 0.55, -0.2);

    const door = box(1.6, 0.8, 0.1, DARK, 0, 0.46, 1.16);
    const doorTrim = box(1.7, 0.9, 0.06, team, 0, 0.48, 1.13);
    const stack = cyl(0.2, 0.26, 0.9, 10, GUNMETAL, -0.85, 1.55, -0.7);
    const emberMat = glowMat(0xff7a2a, 0.2);
    const ember = cyl(0.2, 0.2, 0.1, 10, emberMat, -0.85, 2.03, -0.7);

    built.add(b1, step, roof, trim, ventL, ventL2, ventCapL, ventCapL2, flankPipe, louver, door, doorTrim, stack, ember);
    addLamp(built, anim, 1.25, 0.98, 1.1, color);
    addLamp(built, anim, -1.25, 0.98, 1.1, color);
    anim.stackTip = ember; anim.emberMat = emberMat;

    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    if (a.emberMat) {
      const hot = e.queue?.length;
      a.emberMat.emissiveIntensity = hot ? 1.6 + Math.sin(t * 7 + e.id) * 0.6 : 0.15;
    }
  },
});

// ===========================================================================
// STARPORT — landing pad on pylons, radar beacon, marker lights
// ===========================================================================
registerBuilding("starport", {
  build(e, color, size) {
    const team = teamMat(color, 0.08);
    const glow = glowMat(color);
    const built = new THREE.Group();
    const anim = { kind: "starport", lamps: [] };

    const pad = cyl(1.62, 1.62, 0.14, 24, BUILDING_BASE, 0, 0.78, 0); pad.castShadow = true;
    const edgeMat = glowMat(color, 0.5);
    const edge = new THREE.Mesh(new THREE.TorusGeometry(1.56, 0.07, 8, 36), edgeMat);
    edge.rotation.x = Math.PI / 2; edge.position.y = 0.86;

    const pylonGeo = new THREE.CylinderGeometry(0.14, 0.18, 0.75, 10);
    for (const [px, pz] of [[1,1],[-1,1],[1,-1],[-1,-1]]) {
      const py = new THREE.Mesh(pylonGeo, GUNMETAL); py.position.set(px, 0.37, pz);
      const foot = cyl(0.22, 0.26, 0.12, 10, DARK, px, 0.06, pz);
      built.add(py, foot);
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const mk = new THREE.Mesh(G.lamp, glowMat(0x7cd94f, 1.3));
      mk.scale.setScalar(0.7);
      mk.position.set(Math.cos(a) * 1.35, 0.87, Math.sin(a) * 1.35);
      built.add(mk);
    }
    const nub = box(0.5, 0.4, 0.5, team, 0.6, 1.07, 0.6);
    const mast = new THREE.Mesh(G.pole, GUNMETAL); mast.scale.y = 0.5; mast.position.set(0.6, 1.5, 0.6);
    const beacon = new THREE.Group();
    const dish = new THREE.Mesh(G.dish, team);
    const beaconLamp = new THREE.Mesh(G.lamp, glowMat(0xff5f4c, 2.0));
    beaconLamp.position.set(0.28, 0.06, 0);
    beacon.add(dish, beaconLamp);
    beacon.position.set(0.6, 1.85, 0.6);

    built.add(pad, edge, nub, mast, beacon);
    addLamp(built, anim, 1.2, 0.88, 1.2, color);
    addLamp(built, anim, -1.2, 0.88, 1.2, color);
    addLamp(built, anim, 1.2, 0.88, -1.2, color);
    addLamp(built, anim, -1.2, 0.88, -1.2, color);
    anim.beacon = beacon; anim.padEdgeMat = edgeMat;

    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    if (a.beacon) a.beacon.rotation.y = t * 1.6;
    if (a.padEdgeMat) {
      a.padEdgeMat.emissiveIntensity = e.queue?.length
        ? 1.6 + Math.sin(t * 6 + e.id) * 0.7 : 0.4;
    }
  },
});

// ===========================================================================
// TURRET — base + rotating twin-barrel missile pod
// ===========================================================================
registerBuilding("turret", {
  build(e, color, size) {
    const team = teamMat(color, 0.08);
    const glow = glowMat(color);
    const built = new THREE.Group();
    const anim = { kind: "turret", lamps: [] };

    const skirt = cyl(0.75, 0.9, 0.4, 12, BUILDING_BASE, 0, 0.2, 0); skirt.castShadow = true;
    const column = cyl(0.4, 0.5, 0.5, 10, GUNMETAL, 0, 0.6, 0);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.06, 8, 16), glow);
    band.rotation.x = Math.PI / 2; band.position.y = 0.82;

    const pod = new THREE.Group();
    const podBox = box(0.6, 0.34, 0.5, team, 0, 0, 0);
    const podCheek = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.62, 10), team);
    podCheek.rotation.z = Math.PI / 2; podCheek.position.z = -0.02;
    const sensor = new THREE.Mesh(G.droneEye, glowMat(0xff5f4c, 1.6));
    sensor.scale.set(1.4, 0.8, 1); sensor.position.set(0, 0.06, 0.22);
    const barrelGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.75, 10).rotateX(Math.PI/2).translate(0, 0, 0.38);
    const barrels = new THREE.Group();
    const bL = new THREE.Mesh(barrelGeo, GUNMETAL); bL.position.x = 0.16;
    const bR = new THREE.Mesh(barrelGeo, GUNMETAL); bR.position.x = -0.16;
    const tipL = new THREE.Mesh(G.tankMuzzle, glow); tipL.scale.setScalar(0.55); tipL.position.set(0.16, 0, 0.72);
    const tipR = tipL.clone(); tipR.position.x = -0.16;
    barrels.add(bL, bR, tipL, tipR);
    pod.add(podBox, podCheek, sensor, barrels);
    pod.position.y = 1.0;

    built.add(skirt, column, band, pod);
    anim.pod = pod; anim.podBarrels = barrels; anim.barrelHome = 0; anim.recoil = 0;

    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    if (a.pod) {
      const aim = g.userData.aimYaw;
      if (aim !== undefined) {
        let dy = aim - a.pod.rotation.y;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        a.pod.rotation.y += dy * 0.18;
      }
      if (a.recoil > 0) {
        a.recoil = Math.max(0, a.recoil - 1.2 / 60);
        a.podBarrels.position.z = a.barrelHome - a.recoil * 2.0;
      } else {
        a.podBarrels.position.z += (a.barrelHome - a.podBarrels.position.z) * 0.25;
      }
    }
  },
});

// ===========================================================================
// BARRACKS — infantry training block: hall, roof cap, bay door, comms mast
// ===========================================================================
registerBuilding("barracks", {
  build(e, color, size) {
    const team = teamMat(color, 0.08);
    const glow = glowMat(color);
    const win = glowMat(0xffb14c, 0.7);   // warm barracks interior
    const built = new THREE.Group();
    const anim = { kind: "barracks", lamps: [] };

    // Main drill hall — beveled block on an armored footing
    const skirt = box(2.62, 0.16, 2.22, DARK, 0, 0.08, 0); skirt.castShadow = true;
    const b1 = beveledBlock(2.5, 1.08, 2.1, BUILDING_BASE, 0.18); b1.position.y = 0.62;
    b1.children.forEach(c => c.castShadow = true);
    // Ribbed armor pilasters along the long side + row of small windows
    const ribs = panelRow(4, 0.6, GUNMETAL, 0, 0.62, -1.06, 0.16, 0.9, 0.06, "x");
    const winRow = panelRow(4, 0.55, win, 0, 0.85, 1.06, 0.28, 0.14, 0.05, "x");
    // Player-color trim + slightly overhanging roof with a raised spine
    const trim = box(2.56, 0.14, 2.16, team, 0, 1.12, 0);
    const roof = box(2.62, 0.22, 2.32, GUNMETAL, 0, 1.28, 0); roof.castShadow = true;
    const spine = box(1.4, 0.16, 2.0, team, 0, 1.45, 0); spine.castShadow = true;
    const spineGlow = strip(1.2, 0.06, 0.2, glow, 0, 1.54, 0);
    // Recessed reinforced bay door with a glowing frame + threshold light
    const surround = box(1.1, 1.02, 0.12, DARK, 0, 0.55, 1.02);
    const doorFrame = box(1.0, 0.92, 0.06, team, 0, 0.5, 1.07);
    const door = box(0.82, 0.78, 0.08, glow, 0, 0.44, 1.1);
    const threshold = strip(0.9, 0.05, 0.14, glow, 0, 0.06, 1.18);
    // Side annex + comms gear
    const annex = box(0.5, 0.6, 1.2, BUILDING_BASE, 1.36, 0.4, -0.3); annex.castShadow = true;
    const pole = new THREE.Mesh(G.pole, GUNMETAL); pole.position.set(-1.05, 1.95, -0.85);
    const dish = new THREE.Mesh(G.dish, team); dish.position.set(-1.05, 2.55, -0.85); dish.rotation.z = 0.5;
    const vent = new THREE.Mesh(G.vent, GUNMETAL); vent.position.set(0.9, 1.55, -0.75);
    const vent2 = new THREE.Mesh(G.vent, GUNMETAL); vent2.position.set(0.5, 1.55, -0.75); vent2.scale.setScalar(0.8);

    built.add(skirt, b1, ribs, winRow, trim, roof, spine, spineGlow,
              surround, doorFrame, door, threshold, annex, pole, dish, vent, vent2);
    addLamp(built, anim, -1.05, 2.65, -0.85, color);
    addLamp(built, anim, 1.28, 1.2, 1.0, color);
    addLamp(built, anim, -1.28, 1.2, 1.0, color);
    anim.door = door;

    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    if (a.door) a.door.material.emissiveIntensity = e.queue?.length ? 1.6 + Math.sin(t * 6) * 0.6 : 0.9;
  },
});
