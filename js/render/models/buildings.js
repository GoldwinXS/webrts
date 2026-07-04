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

// ===========================================================================
// HQ — command center: broad base, mid storey, control tower, radar dish
// ===========================================================================
registerBuilding("hq", {
  build(e, color, size) {
    const team = teamMat(color, 0.08);
    const glow = glowMat(color);
    const built = new THREE.Group();
    const anim = { kind: "hq", lamps: [] };

    const b1 = box(2.7, 0.9, 2.7, BUILDING_BASE, 0, 0.45, 0); b1.castShadow = true;
    const trim = box(2.74, 0.14, 2.74, team, 0, 0.86, 0);
    const b2 = box(2.0, 0.6, 2.0, team, 0, 1.2, 0); b2.castShadow = true;
    const tower = cyl(0.5, 0.68, 0.8, 10, BUILDING_BASE, 0, 1.98, 0); tower.castShadow = true;
    const towerBand = cyl(0.52, 0.52, 0.1, 10, team, 0, 2.28, 0);
    const pole = new THREE.Mesh(G.pole, GUNMETAL); pole.position.y = 2.6; pole.scale.y = 0.6;
    const dish = new THREE.Mesh(G.dish, team); dish.position.y = 3.0;
    const antL = new THREE.Mesh(G.antenna, GUNMETAL); antL.position.set(-1.1, 0.9, -1.1);
    const ventA = new THREE.Mesh(G.vent, GUNMETAL); ventA.position.set(-0.8, 0.95, 0.9);

    built.add(b1, trim, b2, tower, towerBand, pole, dish, antL, ventA);
    addLamp(built, anim, 1.25, 0.95, 1.25, color);
    addLamp(built, anim, -1.25, 0.95, 1.25, color);
    addLamp(built, anim, 1.25, 0.95, -1.25, color);
    addLamp(built, anim, -1.25, 0.95, -1.25, color);
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
    const built = new THREE.Group();
    const anim = { kind: "depot", lamps: [] };

    const b1 = box(1.7, 0.55, 1.7, BUILDING_BASE, 0, 0.28, 0); b1.castShadow = true;
    const band = box(1.74, 0.12, 1.74, glow, 0, 0.58, 0);
    const roof = box(1.4, 0.3, 1.4, team, 0, 0.8, 0); roof.castShadow = true;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.62, 14, 8, 0, Math.PI*2, 0, Math.PI/2), team);
    dome.scale.y = 0.6; dome.position.y = 0.94;
    const vent = new THREE.Mesh(G.vent, GUNMETAL); vent.position.set(0.42, 1.05, 0.42);

    for (const [rx, rz] of [[0.72,0.72],[-0.72,0.72],[0.72,-0.72],[-0.72,-0.72]]) {
      const r = new THREE.Mesh(G.lamp, GUNMETAL); r.scale.setScalar(1.4);
      r.position.set(rx, 0.28, rz); built.add(r);
    }
    built.add(b1, band, roof, dome, vent);
    anim.band = band;

    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    if (a.band) a.band.material.emissiveIntensity = 1.1 + Math.sin(t * 2 + e.id) * 0.5;
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
    const built = new THREE.Group();
    const anim = { kind: "barracks", lamps: [] };

    const b1 = box(2.5, 1.15, 2.1, BUILDING_BASE, 0, 0.58, 0); b1.castShadow = true;
    const trim = box(2.54, 0.12, 2.14, team, 0, 1.02, 0);
    const roof = box(2.6, 0.25, 2.3, team, 0, 1.28, 0); roof.rotation.z = 0.06; roof.castShadow = true;
    const surround = box(1.05, 1.0, 0.1, DARK, 0, 0.5, 1.02);
    const door = box(0.85, 0.8, 0.08, glow, 0, 0.42, 1.06);
    const pole = new THREE.Mesh(G.pole, GUNMETAL); pole.position.set(-1.0, 1.9, -0.8);
    const vent = new THREE.Mesh(G.vent, GUNMETAL); vent.position.set(0.85, 1.5, -0.7);

    built.add(b1, trim, roof, surround, door, pole, vent);
    addLamp(built, anim, -1.0, 2.62, -0.8, color);
    anim.door = door;

    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    if (a.door) a.door.material.emissiveIntensity = e.queue?.length ? 1.6 + Math.sin(t * 6) * 0.6 : 0.9;
  },
});
