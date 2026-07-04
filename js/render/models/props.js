// Prop model definitions: minerals, geysers, shrubs, barrier materials.
// These are environment objects, not player-controlled units/buildings.

import * as THREE from "three";
import {
  G, propToon, glowMat, liftToGround, makeCrackTexture, toonGradient,
} from "./core.js";

// ---------------------------------------------------------------------------
// Mineral crystal cluster
// ---------------------------------------------------------------------------
export function makeMineralVisual(e) {
  const group = new THREE.Group();
  const mat = new THREE.MeshToonMaterial({
    color: 0x63e8db, gradientMap: toonGradient(),
    emissive: 0x1a8f83, emissiveIntensity: 1.1,
  });
  const main = new THREE.Mesh(G.mineral, mat);
  main.position.y = 0.34;
  main.rotation.set(0.3, (e.id * 0.7) % Math.PI, 0.15);
  main.castShadow = true;
  const s1 = new THREE.Mesh(G.mineralSmall, mat);
  s1.position.set(0.3, 0.16, -0.14); s1.rotation.set(0.4, e.id, 0.2);
  const s2 = new THREE.Mesh(G.mineralSmall, mat);
  s2.position.set(-0.26, 0.14, 0.18); s2.rotation.set(-0.3, e.id * 1.3, 0.1);
  const s3 = new THREE.Mesh(G.mineralSmall, mat);
  s3.scale.setScalar(0.7); s3.position.set(0.05, 0.1, 0.32);
  s3.rotation.set(0.6, e.id * 0.5, -0.2);
  const baseRock = new THREE.Mesh(G.boulder, propToon({ color: 0x2c3138 }));
  baseRock.scale.set(0.85, 0.4, 0.85); baseRock.position.y = 0.02;
  group.add(baseRock, main, s1, s2, s3);
  liftToGround(group, -0.06);
  group.userData.crystal = main;
  group.userData.anim = { kind: "mineral", mat };
  return group;
}

// Animate minerals (pulsing glow)
export function animateMineral(g, e, t) {
  const a = g.userData.anim;
  if (!a || a.kind !== "mineral") return;
  a.mat.emissiveIntensity = 0.9 + Math.sin(t * 1.5 + e.id) * 0.25;
}

// ---------------------------------------------------------------------------
// Vespene geyser
// ---------------------------------------------------------------------------
export function makeGeyserVisual(e, rockColor) {
  const group = new THREE.Group();
  const rockMat = propToon({ color: rockColor });
  const cone = new THREE.Mesh(G.geyserCone, rockMat);
  cone.position.y = 0.35; cone.castShadow = true;
  cone.rotation.y = (e.id * 0.7) % Math.PI;
  const throatMat = glowMat(0x7cd94f, 1.6);
  const throat = new THREE.Mesh(G.geyserThroat, throatMat);
  throat.position.y = 0.72;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.07, 8, 16), propToon({ color: rockColor }));
  rim.rotation.x = Math.PI / 2; rim.position.y = 0.72;
  group.add(rim);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + e.id;
    const chunk = new THREE.Mesh(G.boulder, rockMat);
    chunk.castShadow = true;
    chunk.position.set(Math.cos(a) * 0.72, 0.1, Math.sin(a) * 0.72);
    chunk.scale.set(0.62, 0.44, 0.62);
    group.add(chunk);
  }
  const plumeMat = new THREE.MeshBasicMaterial({
    color: 0x7cd94f, transparent: true, opacity: 0.14,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const plume = new THREE.Mesh(G.plume, plumeMat);
  plume.position.y = 0.8;
  group.add(cone, throat, plume);
  liftToGround(group, -0.05);
  group.userData.anim = { kind: "geyser", throatMat, plume, plumeMat };
  return group;
}

// Animate geyser (pulsing plume)
export function animateGeyser(g, e, t) {
  const a = g.userData.anim;
  if (!a || a.kind !== "geyser") return;
  a.throatMat.emissiveIntensity = 1.3 + Math.sin(t * 1.8 + e.id) * 0.5;
  const b = 0.5 + Math.sin(t * 0.9 + e.id) * 0.5;
  a.plumeMat.opacity = 0.06 + b * 0.12;
  a.plume.scale.set(0.8 + b * 0.3, 0.85 + b * 0.35, 0.8 + b * 0.3);
  a.plume.position.y = 0.8 + b * 0.25;
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
