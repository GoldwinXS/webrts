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
      kind: "worker", carry, hover: e.id % 7, eye: eye.material,
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
      if (e.carry > 0) a.carry.rotation.y = t * 2;
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
    case "mineral":
      a.mat.emissiveIntensity = 0.9 + Math.sin(t * 1.5 + e.id) * 0.25;
      break;
    case "hq":
      if (a.dish) a.dish.rotation.y = t * 0.7;
      break;
    case "depot":
      if (a.band) a.band.material.emissiveIntensity = 1.1 + Math.sin(t * 2 + e.id) * 0.5;
      break;
    case "barracks":
      if (a.door) a.door.material.emissiveIntensity = e.queue?.length ? 1.6 + Math.sin(t * 6) * 0.6 : 0.9;
      break;
  }

  // blinking lamps on buildings
  if (a.lamps) {
    for (let i = 0; i < a.lamps.length; i++) {
      a.lamps[i].material.emissiveIntensity = Math.sin(t * 3 + i * 1.6 + e.id) > 0.55 ? 1.8 : 0.3;
    }
  }
}
