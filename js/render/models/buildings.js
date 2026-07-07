// Building model definitions — THE COGS' civic architecture. These are the
// factories, silos and towers built by the same tin-toy robots as units.js, so
// they share the exact family DNA:
//   1. Warm cream enamel shells (per-building shellMat) over tin/gunmetal machinery
//   2. Rounded slab bases (RUBBER/DARK) that the cream body sits ON, never floats
//   3. G.dome roofs + a curved TEAM-GLOW G.domeVisor band, just like unit heads
//   4. Copper G.cog emblems + copper G.rivet studs stamped on shells
//   5. Bobble antennae: G.antenna rising FROM a surface, tipped with a team G.lamp
//   6. A team G.stripe / team-mat trim ring around the waist or roofline
//   7. Warm AMBER glows for every vent/exhaust/thruster — team color only as accent
//
// Every mesh is positioned to OVERLAP the part beneath it (no floating bits):
// domes sink into their hulls, antennae start inside the roof, pipes enter walls,
// pads rest on their pylons.
//
// Renderer contracts preserved (see registry.js / renderer.js):
//   - wrapBuilding(built, size, ...) auto-fits to the tile footprint + adds the
//     construction scaffold. Models build UP from y~0 so the vertical grow reads.
//   - userData.mats = [team materials] for the damage flash.
//   - addLamp(...) registers blinking corner lamps into anim.lamps.
//   - refinery reads g.userData.harvesting; turret reads g.userData.aimYaw and
//     needs anim.pod (yawed) + anim.podBarrels (recoil) + anim.recoil.

import * as THREE from "three";
import { wrapBuilding } from "./parts.js";
import { registerBuilding, addLamp } from "./registry.js";
import {
  G, TIN, COPPER, DARK, GUNMETAL, TRIM, RUBBER, SCAFFOLD, AMBER,
  shellMat, teamMat, glowMat,
} from "./core.js";

// Shared toon material for warm interior/window glow (cool blue reads as glass).
const GLASS = glowMat(0x9fdcff, 0.7);

// ---------------------------------------------------------------------------
// Small mesh helpers (one-off geometries; buildings are few, so per-shape
// geometry is fine — units share cached geometry, buildings can be bespoke).
// ---------------------------------------------------------------------------
function box(w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}
function cyl(rTop, rBot, h, seg, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat);
  m.position.set(x, y, z);
  return m;
}
// Domed cap (hemisphere) — the recurring Cog roof. Overlaps down into whatever
// it caps by keeping its equator slightly below the seam.
function domeCap(r, mat, x, y, z, flat = 0.72) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat);
  m.position.set(x, y, z);
  m.scale.y = flat;
  m.castShadow = true;
  return m;
}
// Copper cog emblem, oriented to face +Z (like unit chest badges).
function cogBadge(mat, x, y, z, s) {
  const m = new THREE.Mesh(G.cog, mat);
  m.position.set(x, y, z);
  m.scale.setScalar(s);
  return m;
}
// A ring of copper rivets around a circle at height y, radius r.
function rivetRing(n, r, y, mat, cx = 0, cz = 0) {
  const grp = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const m = new THREE.Mesh(G.rivet, mat);
    m.position.set(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r);
    m.scale.setScalar(1.5);
    grp.add(m);
  }
  return grp;
}
// A bobble antenna: gunmetal whip that STARTS inside `y` and rises, tipped with a
// glowing team lamp. Returns the group so it can be tilted/positioned as a unit.
function bobbleAntenna(x, y, z, teamColor, len = 0.5, tilt = 0) {
  const grp = new THREE.Group();
  const whip = new THREE.Mesh(G.antenna, GUNMETAL);
  whip.scale.set(0.7, len, 0.7);
  grp.add(whip);
  const lamp = new THREE.Mesh(G.lamp, glowMat(teamColor, 1.6));
  lamp.scale.setScalar(0.85);
  // G.antenna is 0.9 tall pre-translate (already shifted so it grows upward from
  // ~0); its tip lands near 0.9*len. Seat the bobble just below that so it kisses
  // the whip end with a slight overlap (no gap).
  lamp.position.y = 0.9 * len - 0.02;
  grp.add(lamp);
  grp.position.set(x, y, z);
  grp.rotation.z = tilt;
  return grp;
}

// ===========================================================================
// HQ ("Command Post") — the big friendly dome at the heart of the base. A broad
// rubber slab base carries a fat cream drum; a huge cream dome roof wearing a
// team-glow visor caps it; a copper cog crowns the dome, ringed by rivets, with
// a spinning radar mast rising out of the crown and a team stripe at the waist.
// ===========================================================================
registerBuilding("hq", {
  build(e, color, size) {
    const shell = shellMat();
    const team = teamMat(color, 0.1);
    const built = new THREE.Group();
    const anim = { kind: "hq", lamps: [] };

    // Rounded slab base (dark rubber) the whole thing rests ON.
    const base = cyl(1.5, 1.62, 0.34, 28, RUBBER, 0, 0.17, 0); base.castShadow = true;
    const baseRivets = rivetRing(12, 1.48, 0.24, COPPER);
    // TWO-TONE hull (de-caked): a gunmetal machine skirt carries a cream upper
    // hull — mechanical, not tiered icing. The old cream drum + white glass
    // torus + wide stripe sandwich read as a birthday cake.
    const skirt = cyl(1.36, 1.46, 0.44, 28, GUNMETAL, 0, 0.54, 0); skirt.castShadow = true;
    const hull = cyl(1.18, 1.3, 0.66, 28, shell, 0, 1.06, 0); hull.castShadow = true;
    // Slim team collar just under the dome seat (accent, not a layer).
    const collar = cyl(1.22, 1.22, 0.09, 28, team, 0, 1.36, 0);
    // Porthole windows dotted around the upper hull (diagonals, clear of the door).
    const ports = new THREE.Group();
    for (const [px, pz] of [[0.88, 0.88], [-0.88, 0.88], [0.88, -0.88], [-0.88, -0.88]]) {
      const p = new THREE.Mesh(G.lamp, GLASS); p.scale.setScalar(0.95);
      p.position.set(px, 1.1, pz);
      ports.add(p);
    }
    // Glowing bay DOOR on the skirt front + copper cog keystone — the same door
    // language as the Assembly, so the base reads as one family.
    const doorFrame = box(0.66, 0.56, 0.16, GUNMETAL, 0, 0.56, 1.36);
    const doorPanel = box(0.5, 0.44, 0.2, GLASS, 0, 0.52, 1.37);
    const doorCog = cogBadge(COPPER, 0, 0.94, 1.24, 0.32);
    // Big cream dome roof seated into the hull top (hull top ~1.39; seat 1.32).
    const dome = domeCap(1.16, shell, 0, 1.32, 0, 0.62);
    const visor = new THREE.Mesh(G.domeVisor, glowMat(color, 0.6));
    visor.position.set(0, 1.66, 0); visor.scale.set(1.4, 1.0, 1.4);
    // Copper cog crown stamped flat on the dome apex + rivet ring around it.
    const crownCog = new THREE.Mesh(G.cog, COPPER);
    crownCog.position.set(0, 1.94, 0); crownCog.rotation.x = -Math.PI / 2; crownCog.scale.setScalar(1.4);
    const crownRivets = rivetRing(8, 0.6, 1.9, COPPER);

    // Radar mast rising OUT of the dome crown (starts inside the dome).
    const mastFoot = cyl(0.22, 0.28, 0.3, 12, GUNMETAL, 0, 2.06, 0);
    const mast = new THREE.Mesh(G.pole, GUNMETAL); mast.scale.y = 0.5; mast.position.y = 2.5;
    const dish = new THREE.Group();
    const dishPlate = new THREE.Mesh(G.dish, team);
    const dishTip = new THREE.Mesh(G.lamp, glowMat(AMBER, 1.8));
    dishTip.position.set(0.26, 0.04, 0);
    dish.add(dishPlate, dishTip);
    dish.position.y = 2.84;
    // Antenna bobbles flanking the mast foot, rising from the dome shoulders.
    const antA = bobbleAntenna(0.72, 1.58, 0.2, color, 0.42, -0.3);
    const antB = bobbleAntenna(-0.72, 1.58, -0.2, color, 0.42, 0.3);
    // Warm amber vents seated on the dome shoulders (overlap into the dome).
    const ventA = new THREE.Mesh(G.vent, GUNMETAL); ventA.position.set(-0.55, 1.64, 0.62); ventA.scale.setScalar(0.6);
    const ventAglow = cyl(0.13, 0.13, 0.04, 10, glowMat(AMBER, 1.4), -0.55, 1.8, 0.62);
    const ventB = new THREE.Mesh(G.vent, GUNMETAL); ventB.position.set(0.55, 1.64, -0.62); ventB.scale.setScalar(0.6);
    const ventBglow = cyl(0.13, 0.13, 0.04, 10, glowMat(AMBER, 1.4), 0.55, 1.8, -0.62);

    built.add(base, baseRivets, skirt, hull, collar, ports, doorFrame, doorPanel, doorCog,
              dome, visor, crownCog, crownRivets,
              mastFoot, mast, dish, antA, antB, ventA, ventAglow, ventB, ventBglow);
    // Corner lamps ON the base slab top (radius 1.39 < slab top radius 1.5,
    // y half-sunk into the slab). The old (±1.32, ±1.32) diagonal reach of 1.87
    // hovered in AIR past the round slab — and inflated the bounding box so
    // auto-fit shrank the whole HQ ~25% for nothing.
    addLamp(built, anim, 0.98, 0.36, 0.98, color);
    addLamp(built, anim, -0.98, 0.36, 0.98, color);
    addLamp(built, anim, 0.98, 0.36, -0.98, color);
    addLamp(built, anim, -0.98, 0.36, -0.98, color);
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
// DEPOT ("Supply Depot") — squat storage. A low rubber slab carries two chunky
// cream silos with copper hoop bands + domed tin caps + antenna bobbles, tied
// together by a gunmetal catwalk. A green fill-gauge glows up each front; a
// team stripe wraps the base.
// ===========================================================================
registerBuilding("depot", {
  build(e, color, size) {
    const shell = shellMat();
    const team = teamMat(color, 0.1);
    const gauge = glowMat(0x7cd94f, 0.9);
    const built = new THREE.Group();
    const anim = { kind: "depot", lamps: [] };

    // Rounded rubber slab base + team stripe band + rivet ring.
    const base = cyl(1.6, 1.72, 0.34, 24, RUBBER, 0, 0.17, 0); base.castShadow = true;
    const band = cyl(1.64, 1.64, 0.14, 24, team, 0, 0.4, 0);   // pulses in animate
    const baseRivets = rivetRing(10, 1.58, 0.22, COPPER);
    const deck = cyl(1.4, 1.5, 0.12, 24, GUNMETAL, 0, 0.5, 0); deck.castShadow = true;

    // Twin cream silos side by side (the readable squat silhouette).
    const parts = [];
    for (const sx of [-0.62, 0.62]) {
      const tank = cyl(0.5, 0.56, 0.9, 18, shell, sx, 1.0, 0); tank.castShadow = true;
      // copper hoop bands hugging the tank
      const hoopA = cyl(0.53, 0.53, 0.07, 18, COPPER, sx, 0.72, 0);
      const hoopB = cyl(0.53, 0.53, 0.07, 18, COPPER, sx, 1.24, 0);
      // domed tin cap sunk into the tank top (tank top ~1.45; seat at 1.4)
      const cap = domeCap(0.52, TIN, sx, 1.4, 0, 0.62);
      const capCog = cogBadge(COPPER, sx, 1.62, 0, 0.4); capCog.rotation.x = -Math.PI / 2;
      // green fill gauge running up the front face, sitting proud of the shell
      const gaugeStrip = box(0.08, 0.62, 0.06, gauge, sx, 1.0, 0.52);
      // antenna bobble rising from the cap
      const ant = bobbleAntenna(sx, 1.5, 0, color, 0.34);
      parts.push(tank, hoopA, hoopB, cap, capCog, gaugeStrip, ant);
    }
    // Gunmetal catwalk + amber-lit pipe tying the two silos together (both ends
    // buried into the tanks so nothing floats).
    const bridge = box(1.24, 0.1, 0.28, GUNMETAL, 0, 1.2, 0.0);
    const pipe = new THREE.Mesh(G.pipe, TRIM);
    pipe.rotation.z = Math.PI / 2; pipe.scale.set(1, 1.9, 1); pipe.position.set(0, 0.78, -0.4);
    const pipeGlow = cyl(0.06, 0.06, 0.02, 8, glowMat(AMBER, 1.2), 0, 0.78, -0.53);

    built.add(base, band, baseRivets, deck, ...parts, bridge, pipe, pipeGlow);
    for (const [rx, rz] of [[1.02, 1.02], [-1.02, 1.02], [1.02, -1.02], [-1.02, -1.02]])
      addLamp(built, anim, rx, 0.34, rz, color);
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
// BARRACKS — wide unit-maker with a big glowing bay DOOR. A cream hall on a
// rubber slab, dome-visor roof cap, copper cog over the door, rivet studs, a
// team roof stripe, a comms antenna bobble and a warm amber vent.
// ===========================================================================
registerBuilding("barracks", {
  build(e, color, size) {
    const shell = shellMat();
    const team = teamMat(color, 0.1);
    const glow = glowMat(color);
    const built = new THREE.Group();
    const anim = { kind: "barracks", lamps: [] };

    // Rounded rubber slab footing + copper rivet studs at the corners.
    const base = box(2.62, 0.28, 2.26, RUBBER, 0, 0.14, 0); base.castShadow = true;
    // Cream drill hall.
    const hall = box(2.42, 1.1, 2.06, shell, 0, 0.83, 0); hall.castShadow = true;
    for (const [rx, rz] of [[1.22, 1.06], [-1.22, 1.06], [1.22, -1.06], [-1.22, -1.06]]) {
      const rv = new THREE.Mesh(G.rivet, COPPER); rv.scale.setScalar(2.2); rv.position.set(rx, 0.5, rz);
      built.add(rv);
    }
    // Team trim + slightly overhanging gunmetal roof + a big dome-visor cap sunk
    // into the roof (roof top ~1.5; seat dome at 1.42).
    const trim = box(2.5, 0.14, 2.14, team, 0, 1.35, 0);
    const roof = box(2.56, 0.2, 2.2, GUNMETAL, 0, 1.44, 0); roof.castShadow = true;
    const dome = domeCap(0.95, shell, 0, 1.42, -0.1, 0.6);
    const visor = new THREE.Mesh(G.domeVisor, glow); visor.position.set(0, 1.72, -0.1); visor.scale.set(1.1, 0.85, 1.1);
    // Comms antenna bobble rising from the roof spine + amber vent seated on roof.
    const ant = bobbleAntenna(-0.95, 1.5, -0.6, color, 0.55, 0.25);
    const vent = new THREE.Mesh(G.vent, GUNMETAL); vent.position.set(0.85, 1.5, -0.6); vent.scale.setScalar(0.7);
    const ventGlow = cyl(0.15, 0.15, 0.04, 10, glowMat(AMBER, 1.4), 0.85, 1.68, -0.6);

    // Recessed bay door on the front wall: dark surround set INTO the wall, team
    // frame, glowing door face proud of the frame, copper cog keystone above,
    // threshold light on the ground.
    const surround = box(1.16, 1.06, 0.16, DARK, 0, 0.66, 1.0);
    const frame = box(1.04, 0.94, 0.08, team, 0, 0.62, 1.06);
    const door = box(0.86, 0.8, 0.08, glow, 0, 0.56, 1.1);   // pulses in animate
    const keyCog = cogBadge(COPPER, 0, 1.18, 1.08, 0.4);
    const threshold = box(0.94, 0.05, 0.16, glow, 0, 0.16, 1.16);

    built.add(base, hall, trim, roof, dome, visor, ant, vent, ventGlow,
              surround, frame, door, keyCog, threshold);
    addLamp(built, anim, 1.28, 1.5, 0.9, color);
    addLamp(built, anim, -1.28, 1.5, 0.9, color);
    anim.door = door;

    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    if (a.door) a.door.material.emissiveIntensity = e.queue?.length ? 1.6 + Math.sin(t * 6) * 0.6 : 0.9;
  },
});

// ===========================================================================
// REFINERY — gas extractor straddling the geyser. A cream dome sits on a rubber
// ring; a spinning green intake ring feeds it; two riveted cream side-tanks with
// tin caps flank it, tied by gunmetal pipes that ENTER the dome; an amber exhaust
// stack vents at the back.
// ===========================================================================
registerBuilding("refinery", {
  build(e, color, size) {
    const shell = shellMat();
    const team = teamMat(color, 0.1);
    const built = new THREE.Group();
    const anim = { kind: "refinery", lamps: [] };

    // Rounded rubber ring base + team stripe.
    const base = cyl(0.98, 1.08, 0.28, 16, RUBBER, 0, 0.14, 0); base.castShadow = true;
    const stripe = cyl(1.0, 1.0, 0.1, 16, team, 0, 0.32, 0);
    // Cream dome core sunk into the base.
    const dome = domeCap(0.88, shell, 0, 0.22, 0, 0.85);
    const domeRivets = rivetRing(8, 0.6, 0.62, COPPER);
    const cog = cogBadge(COPPER, 0, 0.55, 0.7, 0.42);
    // Spinning green intake ring hugging the dome throat (sits on the dome top).
    const intakeMat = glowMat(0x7cd94f, 0.9);
    const intake = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.08, 10, 24), intakeMat);
    intake.rotation.x = Math.PI / 2; intake.position.y = 0.86;
    // tin throat collar the intake sits around (overlaps into dome + intake)
    const throat = cyl(0.34, 0.42, 0.24, 14, TIN, 0, 0.86, 0);

    // Two riveted cream side-tanks with tin caps + gunmetal feed pipes that run
    // from the tank INTO the dome (both ends overlap their targets).
    const parts = [];
    for (const [sx, sz] of [[0.92, 0.22], [-0.92, -0.22]]) {
      const tank = cyl(0.24, 0.26, 0.6, 12, shell, sx, 0.52, sz); tank.castShadow = true;
      const cap = domeCap(0.26, TIN, sx, 0.8, sz, 0.7);
      const hoop = cyl(0.27, 0.27, 0.05, 12, COPPER, sx, 0.62, sz);
      // pipe angled from tank shoulder into the dome side
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.78, 10), GUNMETAL);
      pipe.position.set(sx * 0.55, 0.42, sz * 0.55);
      pipe.rotation.z = sx > 0 ? 0.7 : -0.7;
      pipe.rotation.y = sz > 0 ? -0.3 : 0.3;
      parts.push(tank, cap, hoop, pipe);
    }
    // Amber exhaust stack at the back, its foot buried in the dome.
    const stack = cyl(0.16, 0.2, 0.5, 10, GUNMETAL, 0.1, 0.9, -0.55); stack.castShadow = true;
    const stackGlow = cyl(0.15, 0.15, 0.06, 10, glowMat(AMBER, 1.3), 0.1, 1.16, -0.55);
    // antenna bobble on the dome shoulder
    const ant = bobbleAntenna(-0.28, 0.6, 0.35, color, 0.32);

    built.add(base, stripe, dome, domeRivets, cog, throat, intake, ...parts, stack, stackGlow, ant);
    // Lamps ON the base ring (radius 0.9 < base top radius 0.98) — the old
    // (±0.96, ±0.96) diagonal reach of 1.36 floated well past the round base.
    addLamp(built, anim, 0.64, 0.3, 0.64, color);
    addLamp(built, anim, -0.64, 0.3, -0.64, color);
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
// FACTORY — heavy industrial plant with a smoking CHIMNEY and a gantry. A wide
// cream block on a rubber slab, stepped roof with a gunmetal cap, a big rolling
// bay door with a copper cog, twin tin vents, a side gantry pipe, and a tall
// stack that puffs amber embers when producing.
// ===========================================================================
registerBuilding("factory", {
  build(e, color, size) {
    const shell = shellMat();
    const team = teamMat(color, 0.1);
    const glow = glowMat(color);
    const built = new THREE.Group();
    const anim = { kind: "factory", lamps: [] };

    // Rubber slab base + wide cream main block + stepped upper storey.
    const base = box(2.74, 0.24, 2.34, RUBBER, 0, 0.12, 0); base.castShadow = true;
    const b1 = box(2.6, 0.9, 2.2, shell, 0, 0.69, 0); b1.castShadow = true;
    const trim = box(2.66, 0.14, 2.26, team, 0, 1.1, 0);
    const step = box(1.9, 0.5, 1.6, shell, 0, 1.42, -0.2); step.castShadow = true;
    const roofCap = box(1.98, 0.16, 1.68, GUNMETAL, 0, 1.72, -0.2); roofCap.castShadow = true;
    // copper cog + rivets on the upper storey face
    const stepCog = cogBadge(COPPER, 0, 1.42, 0.62, 0.5);
    const stepRivets = new THREE.Group();
    for (const rx of [-0.7, 0.7]) {
      const rv = new THREE.Mesh(G.rivet, COPPER); rv.scale.setScalar(2.2); rv.position.set(rx, 1.42, 0.62);
      stepRivets.add(rv);
    }

    // Twin tin exhaust vents on the roof, each with a tin cap that overlaps down.
    const vents = new THREE.Group();
    for (const vz of [0.5, 0.02]) {
      const v = cyl(0.16, 0.18, 0.66, 10, GUNMETAL, 1.15, 1.28, vz); v.castShadow = true;
      const vc = cyl(0.21, 0.16, 0.12, 10, TIN, 1.15, 1.6, vz);
      vents.add(v, vc);
    }
    // Side gantry pipe running along the flank (buried into the wall at both ends).
    const gantry = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.9, 10), TRIM);
    gantry.rotation.x = Math.PI / 2; gantry.position.set(-1.32, 0.55, 0.1);
    const louver = box(0.1, 0.5, 1.4, team, 1.32, 0.62, -0.2);

    // Big rolling bay door recessed into the front wall + team frame + copper cog.
    const surround = box(1.7, 0.94, 0.14, DARK, 0, 0.6, 1.12);
    const door = box(1.5, 0.82, 0.08, team, 0, 0.55, 1.18);
    const doorGlow = box(1.5, 0.06, 0.1, glow, 0, 0.18, 1.2);
    const doorCog = cogBadge(COPPER, 0, 1.02, 1.18, 0.42);

    // Tall smokestack with an amber ember mouth (foot buried in the roof).
    const stack = cyl(0.2, 0.26, 0.95, 10, GUNMETAL, -0.85, 1.55, -0.72); stack.castShadow = true;
    const stackBand = cyl(0.24, 0.24, 0.1, 10, COPPER, -0.85, 1.35, -0.72);
    const emberMat = glowMat(0xff7a2a, 0.2);
    const ember = cyl(0.2, 0.2, 0.12, 10, emberMat, -0.85, 2.06, -0.72);
    const ant = bobbleAntenna(0.95, 1.5, -0.7, color, 0.4);

    built.add(base, b1, trim, step, roofCap, stepCog, stepRivets, vents, gantry, louver,
              surround, door, doorGlow, doorCog, stack, stackBand, ember, ant);
    addLamp(built, anim, 1.28, 1.16, 1.12, color);
    addLamp(built, anim, -1.28, 1.16, 1.12, color);
    anim.emberMat = emberMat;

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
// STARPORT — landing pad on pylons. A round cream pad ringed with a team-glow
// edge and green marker lights, resting ON four gunmetal pylons with rubber
// feet, plus a corner control nub with a domed cap and a spinning radar beacon.
// ===========================================================================
registerBuilding("starport", {
  build(e, color, size) {
    const shell = shellMat();
    const team = teamMat(color, 0.1);
    const built = new THREE.Group();
    const anim = { kind: "starport", lamps: [] };

    // Four gunmetal pylons on rubber feet holding up the pad.
    for (const [px, pz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const foot = cyl(0.24, 0.3, 0.16, 10, RUBBER, px, 0.08, pz); foot.castShadow = true;
      const pylon = cyl(0.15, 0.2, 0.7, 10, GUNMETAL, px, 0.5, pz); pylon.castShadow = true;
      built.add(foot, pylon);
    }
    // Round cream landing pad resting ON the pylons (pylon tops ~0.85; pad center
    // 0.85 so pad underside overlaps the pylon caps).
    const pad = cyl(1.6, 1.66, 0.16, 24, shell, 0, 0.85, 0); pad.castShadow = true;
    const padRivets = rivetRing(12, 1.5, 0.78, COPPER);
    // Team-glow edge ring hugging the pad rim.
    const edgeMat = glowMat(color, 0.5);
    const edge = new THREE.Mesh(new THREE.TorusGeometry(1.56, 0.07, 8, 36), edgeMat);
    edge.rotation.x = Math.PI / 2; edge.position.y = 0.9;
    // Green landing marker lights set INTO the pad surface around the rim.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const mk = new THREE.Mesh(G.lamp, glowMat(0x7cd94f, 1.3)); mk.scale.setScalar(0.7);
      mk.position.set(Math.cos(a) * 1.32, 0.94, Math.sin(a) * 1.32);
      built.add(mk);
    }
    // Central copper landing-cog decal painted on the pad.
    const padCog = cogBadge(COPPER, 0, 0.95, 0, 0.9); padCog.rotation.x = -Math.PI / 2;

    // Corner control nub: cream box + tin dome cap + spinning radar beacon +
    // antenna bobble. Everything seated on the pad (base at pad top 0.93).
    const nub = box(0.56, 0.44, 0.56, shell, 0.62, 1.15, 0.62); nub.castShadow = true;
    const nubDome = domeCap(0.34, TIN, 0.62, 1.36, 0.62, 0.7);
    const mast = new THREE.Mesh(G.pole, GUNMETAL); mast.scale.y = 0.42; mast.position.set(0.62, 1.68, 0.62);
    const beacon = new THREE.Group();
    const dishPlate = new THREE.Mesh(G.dish, team);
    const beaconLamp = new THREE.Mesh(G.lamp, glowMat(AMBER, 2.0)); beaconLamp.position.set(0.28, 0.05, 0);
    beacon.add(dishPlate, beaconLamp);
    beacon.position.set(0.62, 1.96, 0.62);
    const ant = bobbleAntenna(-0.62, 1.0, -0.62, color, 0.4);

    built.add(pad, padRivets, edge, padCog, nub, nubDome, mast, beacon, ant);
    // Team corner beacons ON the pad surface (radius 1.46 < pad radius 1.6),
    // set between the green rim markers — the old (±1.2, ±1.2) diagonal reach
    // of 1.70 floated just past the pad rim in mid-air.
    addLamp(built, anim, 1.03, 0.94, 1.03, color);
    addLamp(built, anim, -1.03, 0.94, 1.03, color);
    addLamp(built, anim, 1.03, 0.94, -1.03, color);
    addLamp(built, anim, -1.03, 0.94, -1.03, color);
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
// TURRET — small friendly gun tower. A rubber slab base, a squat cream column
// with a copper cog + team band, and a rotating dome gun-head wearing a team
// visor with a glowing sensor eye and twin amber-tipped barrels. anim.pod is
// yawed by aimYaw; anim.podBarrels recoils.
// ===========================================================================
registerBuilding("turret", {
  build(e, color, size) {
    const shell = shellMat();
    const team = teamMat(color, 0.1);
    const glow = glowMat(color);
    const built = new THREE.Group();
    const anim = { kind: "turret", lamps: [] };

    // Rounded rubber slab base + copper rivet ring.
    const base = cyl(0.78, 0.92, 0.34, 14, RUBBER, 0, 0.17, 0); base.castShadow = true;
    const baseRivets = rivetRing(8, 0.72, 0.24, COPPER);
    // Squat cream column with a copper cog badge + team band collar.
    const column = cyl(0.42, 0.54, 0.62, 12, shell, 0, 0.62, 0); column.castShadow = true;
    const colCog = cogBadge(COPPER, 0, 0.62, 0.42, 0.42);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.06, 8, 18), team);
    band.rotation.x = Math.PI / 2; band.position.y = 0.9;

    // Rotating dome gun-head (the aiming pod). Built around origin; the whole
    // group is placed on top of the column and yawed by aimYaw.
    const pod = new THREE.Group();
    // dome head + team visor (matches every unit head)
    const head = domeCap(0.42, shell, 0, -0.06, 0, 0.85); head.castShadow = true;
    const chin = box(0.5, 0.24, 0.42, TIN, 0, -0.08, 0.06);
    const visor = new THREE.Mesh(G.domeVisor, glow); visor.position.set(0, 0.06, 0); visor.scale.setScalar(0.85);
    const sensor = new THREE.Mesh(G.droneEye, glowMat(color, 1.6));
    sensor.scale.set(1.4, 0.9, 1); sensor.position.set(0, 0.0, 0.34);
    // twin barrels with amber tips (recoil group)
    const barrelGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.75, 10).rotateX(Math.PI / 2).translate(0, 0, 0.38);
    const barrels = new THREE.Group();
    const bL = new THREE.Mesh(barrelGeo, GUNMETAL); bL.position.set(0.15, -0.04, 0.14);
    const bR = new THREE.Mesh(barrelGeo, GUNMETAL); bR.position.set(-0.15, -0.04, 0.14);
    const tipL = new THREE.Mesh(G.tankMuzzle, glowMat(AMBER, 1.5)); tipL.scale.setScalar(0.55); tipL.position.set(0.15, -0.04, 0.88);
    const tipR = tipL.clone(); tipR.position.x = -0.15;
    barrels.add(bL, bR, tipL, tipR);
    // antenna bobble on the head crown
    const ant = bobbleAntenna(-0.12, 0.18, -0.16, color, 0.32, 0.25);
    pod.add(head, chin, visor, sensor, barrels, ant);
    pod.position.y = 1.12;

    built.add(base, baseRivets, column, colCog, band, pod);
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
