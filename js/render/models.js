// Procedural unit & building models built from primitives, with animation
// rigs. Each visual gets userData refs that animateVisual() drives per frame.
// Purely presentational — nothing here may touch sim state.
import * as THREE from "three";

// shared geometries (created once)
const G = {
  // worker drone
  dronePod: new THREE.SphereGeometry(0.3, 14, 12),
  droneThruster: new THREE.CylinderGeometry(0.07, 0.1, 0.16, 8),
  droneEye: new THREE.BoxGeometry(0.26, 0.06, 0.05),
  droneArm: new THREE.BoxGeometry(0.06, 0.06, 0.3).translate(0, 0, 0.15),
  droneDrill: new THREE.ConeGeometry(0.05, 0.16, 6).rotateX(Math.PI / 2).translate(0, 0, 0.36),
  crystal: new THREE.OctahedronGeometry(0.14),
  // marine
  torso: new THREE.CapsuleGeometry(0.2, 0.28, 4, 10),
  head: new THREE.SphereGeometry(0.13, 10, 8),
  visor: new THREE.BoxGeometry(0.16, 0.06, 0.06),
  leg: new THREE.BoxGeometry(0.09, 0.28, 0.09).translate(0, -0.14, 0),
  gunBody: new THREE.BoxGeometry(0.07, 0.09, 0.42),
  gunTip: new THREE.CylinderGeometry(0.025, 0.025, 0.14, 6).rotateX(Math.PI / 2),
  pack: new THREE.BoxGeometry(0.22, 0.26, 0.12),
  // brute
  bruteBody: new THREE.DodecahedronGeometry(0.4),
  bruteArm: new THREE.BoxGeometry(0.14, 0.4, 0.14).translate(0, -0.2, 0),
  bruteFist: new THREE.SphereGeometry(0.11, 8, 6),
  spike: new THREE.ConeGeometry(0.06, 0.2, 6),
  // buildings
  lamp: new THREE.SphereGeometry(0.07, 8, 6),
  pole: new THREE.CylinderGeometry(0.03, 0.03, 1.4, 6),
  dish: new THREE.BoxGeometry(0.5, 0.06, 0.18),
  scaffold: new THREE.BoxGeometry(0.08, 1, 0.08),
  mineral: new THREE.OctahedronGeometry(0.45),
  mineralSmall: new THREE.OctahedronGeometry(0.22),
  ring: new THREE.RingGeometry(0.5, 0.6, 28),
  bar: new THREE.PlaneGeometry(1, 0.11),
  flag: new THREE.BoxGeometry(0.34, 0.2, 0.02),
  // tank
  tankHull: new THREE.BoxGeometry(0.9, 0.28, 1.15),
  tankTread: new THREE.BoxGeometry(0.24, 0.34, 1.25),
  tankTurret: new THREE.BoxGeometry(0.5, 0.26, 0.55),
  tankMantlet: new THREE.BoxGeometry(0.34, 0.2, 0.2),
  tankBarrel: new THREE.CylinderGeometry(0.055, 0.07, 1.1, 10).rotateX(Math.PI / 2).translate(0, 0, 0.55),
  tankMuzzle: new THREE.CylinderGeometry(0.09, 0.09, 0.14, 10).rotateX(Math.PI / 2),
  // wraith
  wraithFuse: new THREE.CylinderGeometry(0.08, 0.16, 0.95, 10).rotateX(Math.PI / 2),
  wraithNose: new THREE.ConeGeometry(0.08, 0.34, 10).rotateX(-Math.PI / 2).translate(0, 0, 0.62),
  wraithWing: new THREE.BoxGeometry(1.05, 0.05, 0.34),
  wraithTail: new THREE.BoxGeometry(0.5, 0.05, 0.2),
  wraithFin: new THREE.BoxGeometry(0.05, 0.28, 0.24),
  wraithEngine: new THREE.CylinderGeometry(0.09, 0.06, 0.18, 10).rotateX(Math.PI / 2),
  // banshee
  bansheeBody: new THREE.CapsuleGeometry(0.22, 0.5, 4, 10).rotateX(Math.PI / 2),
  bansheeCanopy: new THREE.SphereGeometry(0.15, 10, 8),
  bansheeArm: new THREE.BoxGeometry(0.07, 0.07, 0.42),
  bansheeRotor: new THREE.CylinderGeometry(0.42, 0.42, 0.02, 4),
  bansheeHub: new THREE.CylinderGeometry(0.05, 0.05, 0.14, 8),
  bansheeGun: new THREE.CylinderGeometry(0.05, 0.05, 0.4, 8).rotateX(Math.PI / 2).translate(0, 0, 0.2),
  // blob shadow for flyers
  blob: new THREE.CircleGeometry(1, 20),
  // geyser
  geyserCone: new THREE.CylinderGeometry(0.5, 0.85, 0.7, 9),
  geyserThroat: new THREE.CylinderGeometry(0.28, 0.34, 0.3, 9),
  plume: new THREE.ConeGeometry(0.32, 1.4, 10).translate(0, 0.7, 0),
  // shrub
  shrubBlade: new THREE.ConeGeometry(0.08, 1.0, 4).translate(0, 0.5, 0),
};
export const SHARED = G;

const DARK = new THREE.MeshStandardMaterial({ color: 0x232830, roughness: 0.5, metalness: 0.5 });
const GUNMETAL = new THREE.MeshStandardMaterial({ color: 0x30363f, roughness: 0.35, metalness: 0.7 });

function teamMat(color, emissiveIntensity = 0.12) {
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.45, metalness: 0.35,
    emissive: color, emissiveIntensity,
  });
}
function glowMat(color, intensity = 1.6) {
  return new THREE.MeshStandardMaterial({
    color, roughness: 0.3, metalness: 0.1,
    emissive: color, emissiveIntensity: intensity,
  });
}

export function makeMineralVisual(e) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x63e8db, roughness: 0.15, metalness: 0.55,
    emissive: 0x1a8f83, emissiveIntensity: 1.1,
  });
  const main = new THREE.Mesh(G.mineral, mat);
  main.position.y = 0.34;
  main.rotation.set(0.3, (e.id * 0.7) % Math.PI, 0.15);
  main.castShadow = true;
  const s1 = new THREE.Mesh(G.mineralSmall, mat);
  s1.position.set(0.3, 0.16, -0.14);
  s1.rotation.y = e.id;
  const s2 = new THREE.Mesh(G.mineralSmall, mat);
  s2.position.set(-0.26, 0.14, 0.18);
  group.add(main, s1, s2);
  group.userData.crystal = main;
  group.userData.anim = { kind: "mineral", mat };
  return group;
}

// Vespene geyser: squat rocky vent cone with a glowing green throat and a slow
// pulsing translucent plume. `rockColor` is the theme rock color.
export function makeGeyserVisual(e, rockColor) {
  const group = new THREE.Group();
  const rockMat = new THREE.MeshStandardMaterial({ color: rockColor, roughness: 0.9, metalness: 0.1 });
  const cone = new THREE.Mesh(G.geyserCone, rockMat);
  cone.position.y = 0.35;
  cone.castShadow = true;
  cone.rotation.y = (e.id * 0.7) % Math.PI;
  const throatMat = glowMat(0x7cd94f, 1.6);
  const throat = new THREE.Mesh(G.geyserThroat, throatMat);
  throat.position.y = 0.72;
  // a couple of leaning rock chunks around the base for silhouette
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + e.id;
    const chunk = new THREE.Mesh(G.mineralSmall, rockMat);
    chunk.position.set(Math.cos(a) * 0.7, 0.12, Math.sin(a) * 0.7);
    chunk.scale.setScalar(0.7);
    group.add(chunk);
  }
  // translucent rising plume (stretched cone), subtle
  const plumeMat = new THREE.MeshBasicMaterial({
    color: 0x7cd94f, transparent: true, opacity: 0.14,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const plume = new THREE.Mesh(G.plume, plumeMat);
  plume.position.y = 0.8;
  group.add(cone, throat, plume);
  group.userData.anim = { kind: "geyser", throatMat, plume, plumeMat };
  return group;
}

// Tall shrub (deco kind 3): clumped tall grass tufts, theme-tinted, subtle sway.
// Marks LoS-blocker tiles — reads as concealment, taller than a unit.
export function makeShrubVisual(tint, id) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: tint, roughness: 0.85, metalness: 0.0,
    emissive: tint, emissiveIntensity: 0.08,
  });
  const blades = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + id;
    const r = 0.12 + ((i * 7 + id) % 5) / 14;
    const blade = new THREE.Mesh(G.shrubBlade, mat);
    const s = 1.3 + ((i * 3 + id) % 5) / 8;   // taller than a unit
    blade.scale.set(0.8, s, 0.8);
    blade.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    blade.rotation.z = Math.cos(a) * 0.2;
    blade.rotation.x = Math.sin(a) * 0.2;
    blades.push(blade);
    group.add(blade);
  }
  group.userData.anim = { kind: "shrub", blades, seed: id };
  return group;
}

export function makeUnitVisual(e, color) {
  const group = new THREE.Group();
  const body = new THREE.Group();
  const team = teamMat(color);
  const glow = glowMat(color);
  const mats = [team];
  let anim;

  if (e.type === "worker") {
    const pod = new THREE.Mesh(G.dronePod, team);
    pod.scale.set(1, 0.7, 1.15);
    pod.castShadow = true;
    const eye = new THREE.Mesh(G.droneEye, glow);
    eye.position.set(0, 0.04, 0.26);
    const tl = new THREE.Mesh(G.droneThruster, GUNMETAL);
    tl.position.set(0.26, -0.1, 0);
    const tr = tl.clone();
    tr.position.x = -0.26;
    const carry = new THREE.Mesh(G.crystal, glowMat(0x63e8db, 1.4));
    carry.position.set(0, -0.18, 0.22);
    carry.visible = false;
    // manipulator arm: drill for mining, torch for welding
    const arm = new THREE.Group();
    const armMesh = new THREE.Mesh(G.droneArm, GUNMETAL);
    const drill = new THREE.Mesh(G.droneDrill, glowMat(0x63e8db, 0.6));
    arm.add(armMesh, drill);
    arm.position.set(0.12, -0.08, 0.18);
    arm.rotation.x = 0.35;       // retracted by default
    arm.scale.setScalar(0.75);
    body.add(pod, eye, tl, tr, carry, arm);
    body.position.y = 0.42;
    // the eye doubles as a task light: team color when moving/idle,
    // cyan while mining, amber while constructing
    anim = {
      kind: "worker", carry, carryMat: carry.material, hover: e.id % 7, eye: eye.material,
      baseColor: new THREE.Color(color), arm, drill: drill.material,
    };
  } else if (e.type === "marine") {
    const torso = new THREE.Mesh(G.torso, team);
    torso.position.y = 0.46;
    torso.castShadow = true;
    const head = new THREE.Mesh(G.head, DARK);
    head.position.y = 0.76;
    const visor = new THREE.Mesh(G.visor, glow);
    visor.position.set(0, 0.77, 0.09);
    const pack = new THREE.Mesh(G.pack, GUNMETAL);
    pack.position.set(0, 0.5, -0.19);
    const legL = new THREE.Mesh(G.leg, DARK);
    legL.position.set(0.1, 0.3, 0);
    const legR = new THREE.Mesh(G.leg, DARK);
    legR.position.set(-0.1, 0.3, 0);
    const gunGroup = new THREE.Group();
    const gun = new THREE.Mesh(G.gunBody, GUNMETAL);
    const tip = new THREE.Mesh(G.gunTip, glow);
    tip.position.set(0, 0, 0.26);
    gunGroup.add(gun, tip);
    gunGroup.position.set(0.2, 0.5, 0.16);
    body.add(torso, head, visor, pack, legL, legR, gunGroup);
    anim = { kind: "marine", legL, legR, gunGroup, gunHome: 0.16 };
  } else if (e.type === "tank") {
    // low wide hull with side tread blocks and a rotating long-barrel turret
    const hull = new THREE.Mesh(G.tankHull, team);
    hull.position.y = 0.34;
    hull.castShadow = true;
    const treadL = new THREE.Mesh(G.tankTread, DARK);
    treadL.position.set(0.55, 0.22, 0);
    const treadR = treadL.clone();
    treadR.position.x = -0.55;
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 1.1), GUNMETAL);
    skirt.position.y = 0.48;
    // turret group rotates on Y; barrel recoils along -Z of the turret
    const turret = new THREE.Group();
    const dome = new THREE.Mesh(G.tankTurret, team);
    dome.position.y = 0;
    const mantlet = new THREE.Mesh(G.tankMantlet, GUNMETAL);
    mantlet.position.set(0, 0, 0.32);
    const barrelGroup = new THREE.Group();
    const barrel = new THREE.Mesh(G.tankBarrel, GUNMETAL);
    const muzzle = new THREE.Mesh(G.tankMuzzle, glow);
    muzzle.position.z = 1.05;
    barrelGroup.add(barrel, muzzle);
    barrelGroup.position.set(0, 0, 0.28);
    const hatch = new THREE.Mesh(G.droneEye, glow);
    hatch.position.set(0, 0.16, -0.1);
    turret.add(dome, mantlet, barrelGroup, hatch);
    turret.position.set(0, 0.62, 0);
    body.add(hull, treadL, treadR, skirt, turret);
    anim = { kind: "tank", turret, barrelGroup, barrelHome: 0.28 };
  } else if (e.type === "wraith") {
    // sleek dart: slim fuselage, swept wings, twin engine glow
    const fuse = new THREE.Mesh(G.wraithFuse, team);
    fuse.castShadow = true;
    const nose = new THREE.Mesh(G.wraithNose, DARK);
    const wing = new THREE.Mesh(G.wraithWing, team);
    wing.position.set(0, -0.02, -0.05);
    wing.rotation.y = 0.32;                 // sweep back
    const tail = new THREE.Mesh(G.wraithTail, team);
    tail.position.set(0, 0.02, -0.5);
    const fin = new THREE.Mesh(G.wraithFin, DARK);
    fin.position.set(0, 0.14, -0.5);
    const cockpit = new THREE.Mesh(G.bansheeCanopy, glowMat(0x9fdcff, 0.7));
    cockpit.scale.set(0.7, 0.5, 1.1);
    cockpit.position.set(0, 0.1, 0.2);
    const engMat = glowMat(color, 2.4);     // >1 for bloom
    const engL = new THREE.Mesh(G.wraithEngine, engMat);
    engL.position.set(0.22, 0, -0.5);
    const engR = engL.clone();
    engR.position.x = -0.22;
    body.add(fuse, nose, wing, tail, fin, cockpit, engL, engR);
    anim = { kind: "wraith", engMat, roll: 0 };
  } else if (e.type === "banshee") {
    // gunship: fat body, twin overhead rotor discs, under-nose gun
    const bodyMesh = new THREE.Mesh(G.bansheeBody, team);
    bodyMesh.castShadow = true;
    const canopy = new THREE.Mesh(G.bansheeCanopy, glowMat(0x9fdcff, 0.7));
    canopy.scale.set(0.9, 0.7, 1);
    canopy.position.set(0, 0.12, 0.4);
    const gun = new THREE.Mesh(G.bansheeGun, GUNMETAL);
    gun.position.set(0, -0.16, 0.35);
    const gunTip = new THREE.Mesh(G.tankMuzzle, glow);
    gunTip.scale.setScalar(0.6);
    gunTip.position.set(0, -0.16, 0.62);
    // two rotor assemblies on thin arms
    const rotors = [];
    for (const side of [0.34, -0.34]) {
      const arm = new THREE.Mesh(G.bansheeArm, GUNMETAL);
      arm.position.set(side, 0.14, -0.05);
      arm.rotation.x = Math.PI / 2;
      const hub = new THREE.Mesh(G.bansheeHub, DARK);
      hub.position.set(side, 0.3, -0.05);
      const disc = new THREE.Mesh(G.bansheeRotor, glowMat(color, 0.6));
      disc.position.set(side, 0.37, -0.05);
      body.add(arm, hub, disc);
      rotors.push(disc);
    }
    body.add(bodyMesh, canopy, gun, gunTip);
    anim = { kind: "banshee", rotors, roll: 0 };
  } else { // brute
    const core = new THREE.Mesh(G.bruteBody, team);
    core.position.y = 0.52;
    core.scale.set(1, 1.15, 0.95);
    core.castShadow = true;
    for (let i = 0; i < 4; i++) {
      const sp = new THREE.Mesh(G.spike, GUNMETAL);
      const a = (i / 4) * Math.PI - Math.PI / 2 + 0.4;
      sp.position.set(Math.cos(a) * 0.28, 0.82, Math.sin(a) * 0.18 - 0.1);
      sp.rotation.z = -Math.cos(a) * 0.5;
      body.add(sp);
    }
    const armL = new THREE.Group();
    const upperL = new THREE.Mesh(G.bruteArm, DARK);
    const fistL = new THREE.Mesh(G.bruteFist, team);
    fistL.position.y = -0.42;
    armL.add(upperL, fistL);
    armL.position.set(0.42, 0.66, 0);
    const armR = armL.clone();
    armR.position.x = -0.42;
    const eye = new THREE.Mesh(G.droneEye, glowMat(0xff8844, 1.8));
    eye.scale.set(0.8, 1, 1);
    eye.position.set(0, 0.6, 0.34);
    body.add(core, armL, armR, eye);
    anim = { kind: "brute", armL, armR };
  }

  group.add(body);
  group.userData.body = body;
  group.userData.mats = mats;
  group.userData.anim = anim;
  return group;
}

export function makeBuildingVisual(e, color, size) {
  const group = new THREE.Group();
  const built = new THREE.Group();
  const team = teamMat(color, 0.08);
  const glow = glowMat(color);
  const base = new THREE.MeshStandardMaterial({ color: 0x39424e, roughness: 0.65, metalness: 0.4 });
  const anim = { kind: e.type, lamps: [] };

  const lampAt = (x, y, z) => {
    const l = new THREE.Mesh(G.lamp, glowMat(color, 1.2));
    l.position.set(x, y, z);
    anim.lamps.push(l);
    built.add(l);
  };

  if (e.type === "hq") {
    const b1 = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.9, 2.7), base);
    b1.position.y = 0.45;
    const b2 = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.6, 2.0), team);
    b2.position.y = 1.2;
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.65, 0.8, 8), base);
    tower.position.y = 1.9;
    const pole = new THREE.Mesh(G.pole, GUNMETAL);
    pole.position.y = 2.6;
    pole.scale.y = 0.6;
    const dish = new THREE.Mesh(G.dish, team);
    dish.position.y = 3.0;
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.1, 16), GUNMETAL);
    pad.position.set(0.8, 0.95, 0.8);
    b1.castShadow = b2.castShadow = tower.castShadow = true;
    built.add(b1, b2, tower, pole, dish, pad);
    lampAt(1.25, 0.95, 1.25); lampAt(-1.25, 0.95, 1.25);
    lampAt(1.25, 0.95, -1.25); lampAt(-1.25, 0.95, -1.25);
    anim.dish = dish;
  } else if (e.type === "depot") {
    const b1 = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 1.7), base);
    b1.position.y = 0.28;
    const band = new THREE.Mesh(new THREE.BoxGeometry(1.74, 0.12, 1.74), glow);
    band.position.y = 0.58;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.3, 1.4), team);
    roof.position.y = 0.8;
    const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.3, 8), GUNMETAL);
    vent.position.set(0.4, 1.05, 0.4);
    b1.castShadow = roof.castShadow = true;
    built.add(b1, band, roof, vent);
    anim.band = band;
  } else if (e.type === "refinery") {
    // industrial dome capping the geyser + two side pipes + intake ring
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.85, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), base);
    dome.position.y = 0.05;
    dome.scale.y = 0.85;
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 0.3, 12), team);
    collar.position.y = 0.55;
    // green emissive intake ring (pulses while harvesting)
    const intakeMat = glowMat(0x7cd94f, 0.9);
    const intake = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.08, 8, 18), intakeMat);
    intake.rotation.x = Math.PI / 2;
    intake.position.y = 0.72;
    const pipeGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.7, 8);
    const pipeL = new THREE.Mesh(pipeGeo, GUNMETAL);
    pipeL.position.set(0.75, 0.35, 0.2); pipeL.rotation.z = 0.3;
    const pipeR = pipeL.clone();
    pipeR.position.set(-0.75, 0.35, -0.2); pipeR.rotation.z = -0.3;
    const capL = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.14, 8), team);
    capL.position.set(0.82, 0.7, 0.2);
    const capR = capL.clone();
    capR.position.set(-0.82, 0.7, -0.2);
    dome.castShadow = true;
    built.add(dome, collar, intake, pipeL, pipeR, capL, capR);
    lampAt(0.9, 0.1, 0.9); lampAt(-0.9, 0.1, -0.9);
    anim.intake = intake; anim.intakeMat = intakeMat;
  } else if (e.type === "factory") {
    // wide heavy plant: big box, huge rolling door, short smokestack
    const b1 = new THREE.Mesh(new THREE.BoxGeometry(2.7, 1.1, 2.3), base);
    b1.position.y = 0.55;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.35, 2.1), GUNMETAL);
    roof.position.y = 1.25;
    const trim = new THREE.Mesh(new THREE.BoxGeometry(2.74, 0.12, 2.34), team);
    trim.position.y = 0.95;
    // huge front rolling door: dark panel with team trim
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.9, 0.1), DARK);
    door.position.set(0, 0.5, 1.16);
    const doorTrim = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.0, 0.06), team);
    doorTrim.position.set(0, 0.52, 1.13);
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.9, 10), GUNMETAL);
    stack.position.set(-0.85, 1.6, -0.7);
    // ember glow at the stack tip (lit while queue non-empty)
    const emberMat = glowMat(0xff7a2a, 0.2);
    const ember = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 10), emberMat);
    ember.position.set(-0.85, 2.08, -0.7);
    b1.castShadow = roof.castShadow = true;
    built.add(b1, roof, trim, door, doorTrim, stack, ember);
    lampAt(1.25, 1.05, 1.1); lampAt(-1.25, 1.05, 1.1);
    anim.stackTip = ember; anim.emberMat = emberMat;
  } else if (e.type === "starport") {
    // flat landing pad on pylons + corner lights + rotating radar beacon
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.45, 0.24, 20), base);
    pad.position.y = 0.75;
    pad.castShadow = true;
    // glowing pad edge (pulses while training)
    const edgeMat = glowMat(color, 0.5);
    const edge = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.08, 8, 30), edgeMat);
    edge.rotation.x = Math.PI / 2;
    edge.position.y = 0.88;
    const pylonGeo = new THREE.CylinderGeometry(0.14, 0.18, 0.75, 8);
    for (const [px, pz] of [[1.0, 1.0], [-1.0, 1.0], [1.0, -1.0], [-1.0, -1.0]]) {
      const py = new THREE.Mesh(pylonGeo, GUNMETAL);
      py.position.set(px, 0.37, pz);
      built.add(py);
    }
    // central control nub + rotating radar beacon on a mast
    const nub = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.5), team);
    nub.position.set(0.6, 1.07, 0.6);
    const mast = new THREE.Mesh(G.pole, GUNMETAL);
    mast.scale.y = 0.5; mast.position.set(0.6, 1.5, 0.6);
    const beacon = new THREE.Group();
    const dish = new THREE.Mesh(G.dish, team);
    const beaconLamp = new THREE.Mesh(G.lamp, glowMat(0xff5f4c, 2.0));
    beaconLamp.position.set(0.28, 0.06, 0);
    beacon.add(dish, beaconLamp);
    beacon.position.set(0.6, 1.85, 0.6);
    built.add(pad, edge, nub, mast, beacon);
    lampAt(1.2, 0.88, 1.2); lampAt(-1.2, 0.88, 1.2);
    lampAt(1.2, 0.88, -1.2); lampAt(-1.2, 0.88, -1.2);
    anim.beacon = beacon; anim.padEdgeMat = edgeMat;
  } else if (e.type === "turret") {
    // sturdy base + rotating twin-barrel missile pod that tracks enemies
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.9, 0.4, 12), base);
    skirt.position.y = 0.2;
    skirt.castShadow = true;
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 0.5, 10), GUNMETAL);
    column.position.y = 0.6;
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.06, 8, 16), glow);
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.82;
    // pod pivots on Y (yaw) toward the target; barrels recoil on -Z
    const pod = new THREE.Group();
    const podBox = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.34, 0.5), team);
    const barrelGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.75, 8).rotateX(Math.PI / 2).translate(0, 0, 0.38);
    const barrels = new THREE.Group();
    const bL = new THREE.Mesh(barrelGeo, GUNMETAL); bL.position.x = 0.16;
    const bR = new THREE.Mesh(barrelGeo, GUNMETAL); bR.position.x = -0.16;
    const tipL = new THREE.Mesh(G.tankMuzzle, glow); tipL.scale.setScalar(0.55); tipL.position.set(0.16, 0, 0.72);
    const tipR = tipL.clone(); tipR.position.x = -0.16;
    barrels.add(bL, bR, tipL, tipR);
    pod.add(podBox, barrels);
    pod.position.y = 1.0;
    built.add(skirt, column, band, pod);
    anim.pod = pod; anim.podBarrels = barrels; anim.barrelHome = 0;
  } else { // barracks
    const b1 = new THREE.Mesh(new THREE.BoxGeometry(2.5, 1.15, 2.1), base);
    b1.position.y = 0.58;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.25, 2.3), team);
    roof.position.y = 1.28;
    roof.rotation.z = 0.06;
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.8, 0.08), glow);
    door.position.set(0, 0.42, 1.06);
    const pole = new THREE.Mesh(G.pole, GUNMETAL);
    pole.position.set(-1.0, 1.9, -0.8);
    b1.castShadow = roof.castShadow = true;
    built.add(b1, roof, door, pole);
    lampAt(-1.0, 2.62, -0.8);
    anim.door = door;
  }

  group.add(built);

  // construction scaffold: four corner posts, hidden once done
  const scaffold = new THREE.Group();
  const smat = new THREE.MeshStandardMaterial({ color: 0xc9a04b, roughness: 0.8 });
  const half = size / 2 - 0.15;
  for (const [sx, sz] of [[half, half], [-half, half], [half, -half], [-half, -half]]) {
    const post = new THREE.Mesh(G.scaffold, smat);
    post.position.set(sx, 0.5, sz);
    scaffold.add(post);
  }
  group.add(scaffold);

  group.userData.built = built;
  group.userData.scaffold = scaffold;
  group.userData.mats = [team];
  group.userData.anim = anim;
  return group;
}

// Per-frame animation. t is seconds, moveAmt 0..1 smoothed movement.
export function animateVisual(g, e, t, moveAmt) {
  const a = g.userData.anim;
  if (!a) return;
  const phase = t * 9 + e.id * 1.7;

  switch (a.kind) {
    case "worker": {
      g.userData.body.position.y = 0.42 + Math.sin(t * 3 + a.hover) * 0.05 + moveAmt * 0.04;
      g.userData.body.rotation.x = moveAmt * 0.18;
      a.carry.visible = e.carry > 0;
      if (e.carry > 0) {
        a.carry.rotation.y = t * 2;
        // gas is green (carryKind 1), minerals cyan (carryKind 0)
        const hex = e.carryKind === 1 ? 0x7cd94f : 0x63e8db;
        a.carryMat.color.setHex(hex); a.carryMat.emissive.setHex(hex);
      }
      // task light + arm pose
      const kind = e.order?.kind;
      const mining = kind === "gather" && e.order.phase === "mining";
      if (kind === "gather") {
        a.eye.color.setHex(0x63e8db); a.eye.emissive.setHex(0x63e8db);
        a.eye.emissiveIntensity = 1.8;
      } else if (kind === "build") {
        a.eye.color.setHex(0xffb347); a.eye.emissive.setHex(0xffb347);
        a.eye.emissiveIntensity = 1.6 + Math.sin(t * 8) * 0.6; // welding flicker
      } else if (kind === "idle") {
        a.eye.color.copy(a.baseColor); a.eye.emissive.copy(a.baseColor);
        a.eye.emissiveIntensity = Math.sin(t * 5) > 0 ? 2.2 : 0.5; // blink = needs orders
      } else {
        a.eye.color.copy(a.baseColor); a.eye.emissive.copy(a.baseColor);
        a.eye.emissiveIntensity = 1.6;
      }
      if (mining) {
        // drill: arm level, extended, vibrating hard
        a.arm.rotation.x = -0.1 + Math.sin(t * 40 + e.id) * 0.05;
        a.arm.scale.setScalar(1);
        a.arm.position.z = 0.22 + Math.sin(t * 40 + e.id) * 0.02;
        a.drill.color.setHex(0x63e8db); a.drill.emissive.setHex(0x63e8db);
        a.drill.emissiveIntensity = 1.6;
      } else if (kind === "build") {
        // welding torch: slow sweeping passes
        a.arm.rotation.x = -0.25 + Math.sin(t * 3 + e.id) * 0.35;
        a.arm.rotation.y = Math.sin(t * 1.7 + e.id) * 0.3;
        a.arm.scale.setScalar(1);
        a.arm.position.z = 0.2;
        a.drill.color.setHex(0xffb347); a.drill.emissive.setHex(0xffb347);
        a.drill.emissiveIntensity = 1.4 + Math.sin(t * 13) * 0.8;
      } else {
        // stowed
        a.arm.rotation.x = 0.35;
        a.arm.rotation.y = 0;
        a.arm.scale.setScalar(0.75);
        a.arm.position.z = 0.18;
        a.drill.emissiveIntensity = 0.4;
      }
      break;
    }
    case "marine": {
      const sw = Math.sin(phase) * 0.55 * moveAmt;
      a.legL.rotation.x = sw;
      a.legR.rotation.x = -sw;
      g.userData.body.position.y = Math.abs(Math.sin(phase)) * 0.045 * moveAmt;
      // gun recoil decays back to home
      if (a.recoil > 0) {
        a.recoil = Math.max(0, a.recoil - 0.5 / 60);
        a.gunGroup.position.z = a.gunHome - a.recoil * 0.9;
      }
      break;
    }
    case "brute": {
      const sw = Math.sin(phase * 0.8) * 0.5 * moveAmt;
      a.armL.rotation.x = sw;
      a.armR.rotation.x = -sw;
      const stomp = Math.abs(Math.sin(phase * 0.8)) * 0.06 * moveAmt;
      g.userData.body.position.y = stomp;
      g.userData.body.rotation.z = Math.sin(phase * 0.8) * 0.05 * moveAmt;
      if (a.recoil > 0) { // melee lunge
        a.recoil = Math.max(0, a.recoil - 0.6 / 60);
        g.userData.body.position.z = a.recoil * 0.5;
      }
      break;
    }
    case "tank": {
      // turret yaw toward attack target (or travel dir), barrel recoils on shot
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
      break;
    }
    case "wraith": {
      a.engMat.emissiveIntensity = 2.0 + Math.sin(t * 18 + e.id) * 0.6;
      break;
    }
    case "banshee": {
      for (let i = 0; i < a.rotors.length; i++) a.rotors[i].rotation.y = t * (26 + i * 3);
      break;
    }
    case "mineral":
      a.mat.emissiveIntensity = 0.9 + Math.sin(t * 1.5 + e.id) * 0.25;
      break;
    case "geyser": {
      a.throatMat.emissiveIntensity = 1.3 + Math.sin(t * 1.8 + e.id) * 0.5;
      // slow pulsing plume: rise/fade, gentle scale breathing
      const b = 0.5 + Math.sin(t * 0.9 + e.id) * 0.5;   // 0..1
      a.plumeMat.opacity = 0.06 + b * 0.12;
      a.plume.scale.set(0.8 + b * 0.3, 0.85 + b * 0.35, 0.8 + b * 0.3);
      a.plume.position.y = 0.8 + b * 0.25;
      break;
    }
    case "hq":
      if (a.dish) a.dish.rotation.y = t * 0.7;
      break;
    case "depot":
      if (a.band) a.band.material.emissiveIntensity = 1.1 + Math.sin(t * 2 + e.id) * 0.5;
      break;
    case "barracks":
      if (a.door) a.door.material.emissiveIntensity = e.queue?.length ? 1.6 + Math.sin(t * 6) * 0.6 : 0.9;
      break;
    case "refinery":
      if (a.intakeMat) {
        // stronger pulse while a worker is harvesting (renderer sets harvesting)
        const on = g.userData.harvesting;
        a.intakeMat.emissiveIntensity = on
          ? 1.8 + Math.sin(t * 9 + e.id) * 1.0
          : 0.55 + Math.sin(t * 2 + e.id) * 0.2;
        a.intake.rotation.z = t * (on ? 1.4 : 0.4);
      }
      break;
    case "factory":
      if (a.emberMat) {
        const hot = e.queue?.length;
        a.emberMat.emissiveIntensity = hot ? 1.6 + Math.sin(t * 7 + e.id) * 0.6 : 0.15;
      }
      break;
    case "starport":
      if (a.beacon) a.beacon.rotation.y = t * 1.6;
      if (a.padEdgeMat) {
        a.padEdgeMat.emissiveIntensity = e.queue?.length
          ? 1.6 + Math.sin(t * 6 + e.id) * 0.7 : 0.4;
      }
      break;
    case "turret":
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
      break;
  }

  // blinking lamps on buildings
  if (a.lamps) {
    for (let i = 0; i < a.lamps.length; i++) {
      a.lamps[i].material.emissiveIntensity = Math.sin(t * 3 + i * 1.6 + e.id) > 0.55 ? 1.8 : 0.3;
    }
  }
}

// Subtle sway for a tall-shrub group (not a sim entity). Called per frame by
// the renderer with the group and current time.
export function animateShrub(g, t) {
  const a = g.userData.anim;
  if (!a || a.kind !== "shrub") return;
  const s = a.seed;
  for (let i = 0; i < a.blades.length; i++) {
    const b = a.blades[i];
    b.rotation.z = Math.cos(i + s) * 0.2 + Math.sin(t * 1.6 + i * 0.7 + s) * 0.12;
    b.rotation.x = Math.sin(i + s) * 0.2 + Math.cos(t * 1.4 + i * 0.9 + s) * 0.1;
  }
}
