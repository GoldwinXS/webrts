// Prop model definitions: minerals, geysers, shrubs, barrier materials.
// These are environment objects, not player-controlled units/buildings.

import * as THREE from "three";
import {
  G, propToon, glowMat, liftToGround, makeCrackTexture, toonGradient,
  TIN, GUNMETAL, COPPER, RUBBER, AMBER, DARK,
} from "./core.js";

// Module-scope one-off geometries for the Cog resource props (created once,
// shared across every instance — never created inside the build functions).
const SCRAP_CUBE  = new THREE.BoxGeometry(0.4, 0.32, 0.36);
const SCRAP_PLATE = new THREE.BoxGeometry(0.5, 0.06, 0.34);
const SCRAP_SLAB  = new THREE.BoxGeometry(0.3, 0.22, 0.24);
const SCRAP_BOLT_HEAD = new THREE.CylinderGeometry(0.07, 0.07, 0.05, 6);
const DERRICK_POST  = new THREE.BoxGeometry(0.08, 0.9, 0.08);
const DERRICK_BEAM  = new THREE.BoxGeometry(0.08, 0.08, 0.6);
const DERRICK_HEAD  = new THREE.BoxGeometry(0.16, 0.14, 0.5);
const OIL_POOL_GEO  = new THREE.CylinderGeometry(0.62, 0.7, 0.1, 16);
const OIL_BUBBLE_GEO = new THREE.SphereGeometry(0.08, 8, 6);

// ---------------------------------------------------------------------------
// Scrap pile — salvaged robot cubes/plates/bolts (was: mineral crystal
// cluster). Reads as METAL, not gems: tin/gunmetal/copper with a warm rust
// tint and a couple of teal-glint edges for sparkle. Same footprint/height
// and the same anim contract as before: userData.anim = { kind:"mineral",
// mat } — the renderer fades `mat`'s emissive as the patch depletes, and
// scales userData.crystal (the main chunk) by remaining amount.
// ---------------------------------------------------------------------------
export function makeMineralVisual(e) {
  const group = new THREE.Group();
  // `mat` keeps the depletion-tint contract: a single shared material whose
  // emissive the renderer pulses/fades. Warm rust-copper glow reads as
  // "salvage worth grabbing" without looking like a crystal. RICH (gold)
  // patches trade the gunmetal for gleaming brass so they read from orbit.
  const mat = new THREE.MeshToonMaterial(e.rich
    ? { color: 0xd4af37, gradientMap: toonGradient(),
        emissive: 0xffc94d, emissiveIntensity: 0.85 }
    : { color: 0x9aa1a8, gradientMap: toonGradient(),
        emissive: 0xc9853f, emissiveIntensity: 0.55 });
  // Main chunk: a stack of two chunky scrap cubes (the piece the renderer
  // scales down as the patch depletes -- must stay userData.crystal).
  const main = new THREE.Group();
  const cubeA = new THREE.Mesh(SCRAP_CUBE, mat);
  cubeA.position.set(0, 0.16, 0);
  cubeA.rotation.y = (e.id * 0.7) % Math.PI;
  cubeA.castShadow = true;
  const cubeB = new THREE.Mesh(SCRAP_CUBE, mat);
  cubeB.scale.setScalar(0.8);
  cubeB.position.set(0.06, 0.42, -0.02);
  cubeB.rotation.y = (e.id * 1.9) % Math.PI;
  cubeB.castShadow = true;
  main.add(cubeA, cubeB);
  main.position.y = 0.02;

  // Bolted plate leaning against the pile + a couple of loose slabs/bolts —
  // tin/gunmetal/copper trio so the pile reads as scavenged machine parts.
  const plate = new THREE.Mesh(SCRAP_PLATE, TIN);
  plate.position.set(-0.28, 0.14, 0.12);
  plate.rotation.set(0.2, e.id * 0.9, 0.55);
  plate.castShadow = true;
  const slab = new THREE.Mesh(SCRAP_SLAB, GUNMETAL);
  slab.position.set(0.28, 0.11, 0.2);
  slab.rotation.set(-0.15, e.id * 1.3, -0.2);
  slab.castShadow = true;
  const slab2 = new THREE.Mesh(SCRAP_SLAB, GUNMETAL);
  slab2.scale.setScalar(0.7);
  slab2.position.set(0.05, 0.08, 0.34);
  slab2.rotation.set(0.4, e.id * 0.5, 0.1);
  const bolt = new THREE.Mesh(SCRAP_BOLT_HEAD, COPPER);
  bolt.position.set(-0.12, 0.34, 0.22);
  bolt.rotation.z = 0.3;
  const bolt2 = new THREE.Mesh(SCRAP_BOLT_HEAD, COPPER);
  bolt2.scale.setScalar(0.75);
  bolt2.position.set(0.2, 0.28, -0.16);
  bolt2.rotation.x = 0.4;

  const baseRock = new THREE.Mesh(G.boulder, propToon({ color: 0x2c3138 }));
  baseRock.scale.set(0.85, 0.35, 0.85); baseRock.position.y = 0.02;
  group.add(baseRock, main, plate, slab, slab2, bolt, bolt2);
  liftToGround(group, -0.06);
  group.userData.crystal = main;
  group.userData.anim = { kind: "mineral", mat, base: e.rich ? 0.7 : 0.4 };
  return group;
}

// Animate scrap pile (warm pulsing glint on the metal — same contract/timing
// as the old crystal pulse: renderer reads userData.anim.mat).
export function animateMineral(g, e, t) {
  const a = g.userData.anim;
  if (!a || a.kind !== "mineral") return;
  a.mat.emissiveIntensity = (a.base ?? 0.4) + Math.sin(t * 1.5 + e.id) * 0.18;
}

// ---------------------------------------------------------------------------
// Watchtower — a weathered stone obelisk with a floating beacon orb. The orb
// takes the claimant's team color (renderer reads userData.beacon each frame
// and tints by e.claimedBy); unclaimed it idles a dim white.
// ---------------------------------------------------------------------------
const TOWER_PLINTH = new THREE.CylinderGeometry(0.5, 0.62, 0.22, 8);
const TOWER_SHAFT  = new THREE.CylinderGeometry(0.16, 0.3, 1.5, 8);
const TOWER_CROWN  = new THREE.CylinderGeometry(0.3, 0.2, 0.16, 8);
const TOWER_ORB    = new THREE.SphereGeometry(0.17, 12, 10);

export function makeTowerVisual(e) {
  const group = new THREE.Group();
  const stone = propToon({ color: 0x8d94a4 });
  const plinth = new THREE.Mesh(TOWER_PLINTH, stone);
  plinth.position.y = 0.11;
  plinth.castShadow = true;
  const shaft = new THREE.Mesh(TOWER_SHAFT, stone);
  shaft.position.y = 0.95;
  shaft.castShadow = true;
  const crown = new THREE.Mesh(TOWER_CROWN, propToon({ color: 0x6d7484 }));
  crown.position.y = 1.75;
  const orbMat = new THREE.MeshBasicMaterial({ color: 0xcfd6e4 });
  const orb = new THREE.Mesh(TOWER_ORB, orbMat);
  orb.position.y = 2.05;
  group.add(plinth, shaft, crown, orb);
  liftToGround(group, 0);
  group.userData.beacon = { orb, mat: orbMat };
  group.userData.anim = { kind: "tower" };
  return group;
}

// Renderer calls this each frame with the entity (claimedBy: -1/0/1) and the
// two player colors; the orb bobs and glows in the claimant's color.
export function animateTower(g, e, t, playerColors) {
  const b = g.userData.beacon;
  if (!b) return;
  b.orb.position.y = 2.05 + Math.sin(t * 1.8 + e.id) * 0.08;
  const claimed = e.claimedBy >= 0;
  const target = claimed ? playerColors[e.claimedBy] : 0xcfd6e4;
  b.mat.color.setHex(typeof target === "number" ? target : target.getHex?.() ?? 0xcfd6e4);
  const s = claimed ? 1 + Math.sin(t * 5) * 0.12 : 1;
  b.orb.scale.setScalar(s);
}

// ---------------------------------------------------------------------------
// Oil derrick — a small pumpjack-ish spout over a dark bubbling oil pool
// (was: green vespene gas geyser). Same anim contract: userData.anim =
// { kind:"geyser", throatMat, plume, plumeMat } — the renderer pulses
// throatMat's emissive and animates the plume's scale/opacity/height exactly
// as before, just retextured amber/dark instead of green.
// ---------------------------------------------------------------------------
export function makeGeyserVisual(e, rockColor) {
  const group = new THREE.Group();
  const rockMat = propToon({ color: rockColor });

  // dark oil pool sitting in the ground where the geyser cone used to be
  const pool = new THREE.Mesh(OIL_POOL_GEO, new THREE.MeshToonMaterial({
    color: 0x0c0a10, gradientMap: toonGradient(),
    emissive: 0x1a1006, emissiveIntensity: 0.4,
  }));
  pool.position.y = 0.08;
  pool.rotation.y = (e.id * 0.7) % Math.PI;

  // small derrick/pumpjack frame planted at the pool's edge
  const rig = new THREE.Group();
  const post = new THREE.Mesh(DERRICK_POST, GUNMETAL);
  post.position.set(0, 0.45, 0);
  post.castShadow = true;
  const brace = new THREE.Mesh(DERRICK_BEAM, GUNMETAL);
  brace.position.set(0, 0.62, 0);
  brace.rotation.y = Math.PI / 4;
  const head = new THREE.Mesh(DERRICK_HEAD, RUBBER);
  head.position.set(0, 0.86, 0.1);
  rig.add(post, brace, head);
  rig.position.set(0.3, 0, -0.18);
  rig.rotation.y = (e.id * 1.1) % (Math.PI * 2);
  rig.castShadow = true;

  // throatMat: glowing amber "seep" light at the pool's center (renderer
  // pulses this exactly as it did the old green gas throat).
  const throatMat = glowMat(AMBER, 1.1);
  const throat = new THREE.Mesh(G.geyserThroat, throatMat);
  throat.scale.set(0.55, 0.12, 0.55);
  throat.position.y = 0.13;

  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.07, 8, 16), propToon({ color: rockColor }));
  rim.rotation.x = Math.PI / 2; rim.position.y = 0.06;
  group.add(rim);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + e.id;
    const chunk = new THREE.Mesh(G.boulder, rockMat);
    chunk.castShadow = true;
    chunk.position.set(Math.cos(a) * 0.72, 0.1, Math.sin(a) * 0.72);
    chunk.scale.set(0.62, 0.44, 0.62);
    group.add(chunk);
  }

  // slow bubbling plume: reuses the old cone shape but dark/amber, additive,
  // low and squat like a heat-shimmer/bubble plume over an oil seep rather
  // than a tall gas jet.
  const plumeMat = new THREE.MeshBasicMaterial({
    color: 0x3a2a10, transparent: true, opacity: 0.12,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const plume = new THREE.Mesh(G.plume, plumeMat);
  plume.scale.set(0.5, 0.35, 0.5);
  plume.position.y = 0.2;

  // a few small dark bubble specks frozen mid-pop around the throat, purely
  // decorative (no anim hook needed -- static reads fine at RTS zoom)
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + e.id * 0.6;
    const bub = new THREE.Mesh(OIL_BUBBLE_GEO, DARK);
    bub.scale.setScalar(0.6 + (i % 2) * 0.3);
    bub.position.set(Math.cos(a) * 0.28, 0.14, Math.sin(a) * 0.28);
    group.add(bub);
  }

  group.add(pool, rig, throat, plume);
  liftToGround(group, -0.05);
  group.userData.anim = { kind: "geyser", throatMat, plume, plumeMat };
  return group;
}

// Animate oil derrick (pulsing amber seep light + slow bubbling plume) —
// identical field names/timing contract to the old geyser animation, just
// driving the retextured amber/dark materials instead of green gas.
export function animateGeyser(g, e, t) {
  const a = g.userData.anim;
  if (!a || a.kind !== "geyser") return;
  a.throatMat.emissiveIntensity = 0.9 + Math.sin(t * 1.8 + e.id) * 0.4;
  const b = 0.5 + Math.sin(t * 0.9 + e.id) * 0.5;
  a.plumeMat.opacity = 0.05 + b * 0.1;
  a.plume.scale.set(0.45 + b * 0.15, 0.3 + b * 0.15, 0.45 + b * 0.15);
  a.plume.position.y = 0.2 + b * 0.12;
}

// ---------------------------------------------------------------------------
// Tall shrub (deco kind 3): clumped grass tufts with sway
// ---------------------------------------------------------------------------
export function makeShrubVisual(tint, id) {
  const group = new THREE.Group();
  const mat = propToon({ color: tint, emissive: tint, emissiveIntensity: 0.1 });
  const blades = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + id;
    const r = 0.12 + ((i * 7 + id) % 5) / 14;
    const blade = new THREE.Mesh(G.shrubBlade, mat);
    const s = 1.3 + ((i * 3 + id) % 5) / 8;
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

// Animate shrub sway
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

// ---------------------------------------------------------------------------
// Barrier prop materials (theme-tinted, for instanced meshes)
// ---------------------------------------------------------------------------
export function barrierMaterials(theme) {
  const rockHex = theme.rock;
  const [d0, d1, d2] = theme.deco;
  return {
    boulder: propToon({ color: rockHex }),
    treeTrunk: propToon({ color: 0x5a4632 }),
    treeCanopy: propToon({ color: d2, emissive: d2, emissiveIntensity: 0.06 }),
    basalt: propToon({ color: 0x2a2420 }),
    crack: new THREE.MeshBasicMaterial({
      map: makeCrackTexture(), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    ice: new THREE.MeshToonMaterial({
      color: 0xbfe6ff, gradientMap: toonGradient(),
      emissive: 0x8fd0ff, emissiveIntensity: 0.55,
      transparent: true, opacity: 0.78,
    }),
  };
}
