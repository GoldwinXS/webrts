// Core shared resources: toon gradient, materials, geometry cache, helpers.
// Everything here is created once and reused across all model files.

import * as THREE from "three";

// ---------------------------------------------------------------------------
// Toon gradient map: a tiny 1D DataTexture with NearestFilter gives
// MeshToonMaterial a hard-stepped 3-4 band shading ramp (cartoon look).
// ---------------------------------------------------------------------------
let _toonGrad = null;
export function toonGradient() {
  if (_toonGrad) return _toonGrad;
  const data = new Uint8Array([90, 150, 205, 255]);
  const tex = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  _toonGrad = tex;
  return tex;
}

// Stepped-toon material for environment props. Keeps emissive (for bloom).
export function propToon(opts = {}) {
  return new THREE.MeshToonMaterial({
    color: opts.color ?? 0xffffff,
    gradientMap: toonGradient(),
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    side: opts.side,
  });
}

// ---------------------------------------------------------------------------
// Shared geometry cache. Created once, reused by every model. Adding a new
// model? Add new geometry keys here if needed, or use inline geometry for
// one-off shapes.
// ---------------------------------------------------------------------------
const G = {
  // worker drone
  dronePod: new THREE.SphereGeometry(0.3, 18, 14),
  droneBelly: new THREE.SphereGeometry(0.22, 14, 10),
  droneCollar: new THREE.TorusGeometry(0.24, 0.05, 8, 20),
  droneThruster: new THREE.CylinderGeometry(0.08, 0.11, 0.18, 10),
  droneThrusterGlow: new THREE.CylinderGeometry(0.07, 0.07, 0.04, 10),
  droneEye: new THREE.SphereGeometry(0.1, 12, 10),
  droneArm: new THREE.BoxGeometry(0.06, 0.06, 0.3).translate(0, 0, 0.15),
  droneForearm: new THREE.CylinderGeometry(0.045, 0.055, 0.22, 8).rotateX(Math.PI / 2).translate(0, 0, 0.34),
  droneElbow: new THREE.SphereGeometry(0.055, 8, 6),
  droneDrill: new THREE.ConeGeometry(0.05, 0.16, 8).rotateX(Math.PI / 2).translate(0, 0, 0.36),
  droneWand: new THREE.CylinderGeometry(0.02, 0.025, 0.35, 6).rotateX(Math.PI / 2).translate(0, 0, 0.175),
  droneWandTip: new THREE.OctahedronGeometry(0.07),
  crystal: new THREE.OctahedronGeometry(0.14),
  // marine
  torso: new THREE.CapsuleGeometry(0.21, 0.26, 5, 12),
  chestPlate: new THREE.BoxGeometry(0.28, 0.24, 0.1),
  collar: new THREE.CylinderGeometry(0.11, 0.15, 0.12, 10),
  head: new THREE.SphereGeometry(0.135, 14, 12),
  visor: new THREE.BoxGeometry(0.17, 0.05, 0.06),
  pauldron: new THREE.SphereGeometry(0.13, 12, 8),
  leg: new THREE.BoxGeometry(0.1, 0.24, 0.1).translate(0, -0.12, 0),
  boot: new THREE.BoxGeometry(0.12, 0.09, 0.16).translate(0, -0.04, 0.02),
  gunBody: new THREE.BoxGeometry(0.08, 0.1, 0.46),
  gunReceiver: new THREE.BoxGeometry(0.1, 0.13, 0.18),
  gunMag: new THREE.BoxGeometry(0.06, 0.16, 0.08),
  gunTip: new THREE.CylinderGeometry(0.035, 0.045, 0.16, 8).rotateX(Math.PI / 2),
  pack: new THREE.BoxGeometry(0.24, 0.28, 0.13),
  // brute
  bruteCore: new THREE.SphereGeometry(0.42, 12, 10),
  bruteBody: new THREE.DodecahedronGeometry(0.4),
  bruteChest: new THREE.BoxGeometry(0.46, 0.34, 0.32),
  bruteShoulder: new THREE.SphereGeometry(0.18, 12, 9),
  bruteHead: new THREE.SphereGeometry(0.16, 12, 10),
  bruteJaw: new THREE.BoxGeometry(0.22, 0.1, 0.16),
  bruteArm: new THREE.BoxGeometry(0.14, 0.4, 0.14).translate(0, -0.2, 0),
  bruteForearm: new THREE.BoxGeometry(0.18, 0.24, 0.18).translate(0, -0.12, 0),
  bruteFist: new THREE.SphereGeometry(0.11, 10, 8),
  bruteGauntlet: new THREE.BoxGeometry(0.22, 0.2, 0.22),
  spike: new THREE.ConeGeometry(0.06, 0.2, 8),
  // buildings
  lamp: new THREE.SphereGeometry(0.07, 10, 8),
  pole: new THREE.CylinderGeometry(0.03, 0.03, 1.4, 8),
  antenna: new THREE.CylinderGeometry(0.018, 0.03, 0.9, 6).translate(0, 0.45, 0),
  dish: new THREE.BoxGeometry(0.5, 0.06, 0.18),
  vent: new THREE.CylinderGeometry(0.16, 0.2, 0.3, 10),
  pipe: new THREE.CylinderGeometry(0.09, 0.09, 0.6, 8),
  scaffold: new THREE.BoxGeometry(0.08, 1, 0.08),
  mineral: new THREE.OctahedronGeometry(0.45),
  mineralSmall: new THREE.OctahedronGeometry(0.22),
  ring: new THREE.RingGeometry(0.5, 0.6, 28),
  bar: new THREE.PlaneGeometry(1, 0.11),
  flag: new THREE.BoxGeometry(0.34, 0.2, 0.02),
  // tank
  tankHull: new THREE.BoxGeometry(0.86, 0.24, 1.02),
  tankGlacis: new THREE.BoxGeometry(0.86, 0.24, 0.34),
  tankTread: new THREE.BoxGeometry(0.24, 0.32, 1.28),
  tankGuard: new THREE.BoxGeometry(0.3, 0.08, 1.34),
  tankWheel: new THREE.CylinderGeometry(0.11, 0.11, 0.26, 12).rotateZ(Math.PI / 2),
  tankTurret: new THREE.BoxGeometry(0.5, 0.26, 0.55),
  tankTurretBevel: new THREE.CylinderGeometry(0.3, 0.34, 0.24, 10),
  tankMantlet: new THREE.BoxGeometry(0.34, 0.22, 0.2),
  tankBarrel: new THREE.CylinderGeometry(0.05, 0.065, 0.66, 12).rotateX(Math.PI / 2).translate(0, 0, 0.33),
  tankBarrel2: new THREE.CylinderGeometry(0.07, 0.075, 0.4, 12).rotateX(Math.PI / 2).translate(0, 0, 0.14),
  tankMuzzle: new THREE.CylinderGeometry(0.09, 0.09, 0.16, 12).rotateX(Math.PI / 2),
  // wraith
  wraithFuse: new THREE.CylinderGeometry(0.09, 0.17, 0.95, 12).rotateX(Math.PI / 2),
  wraithSpine: new THREE.BoxGeometry(0.1, 0.1, 0.6),
  wraithNose: new THREE.ConeGeometry(0.09, 0.4, 12).rotateX(-Math.PI / 2).translate(0, 0, 0.64),
  wraithWing: new THREE.BoxGeometry(1.15, 0.045, 0.36),
  wraithTail: new THREE.BoxGeometry(0.52, 0.045, 0.2),
  wraithFin: new THREE.BoxGeometry(0.05, 0.3, 0.24),
  wraithNacelle: new THREE.CapsuleGeometry(0.075, 0.3, 4, 10).rotateX(Math.PI / 2),
  wraithEngine: new THREE.CylinderGeometry(0.09, 0.06, 0.1, 12).rotateX(Math.PI / 2),
  wraithEngineGlow: new THREE.CylinderGeometry(0.06, 0.03, 0.05, 12).rotateX(Math.PI / 2),
  // banshee
  bansheeBody: new THREE.CapsuleGeometry(0.2, 0.62, 5, 14).rotateX(Math.PI / 2),
  bansheeArmor: new THREE.BoxGeometry(0.34, 0.2, 0.5),
  bansheeCanopy: new THREE.SphereGeometry(0.15, 12, 10),
  bansheeArm: new THREE.BoxGeometry(0.08, 0.08, 0.44),
  bansheeRotor: new THREE.CylinderGeometry(0.56, 0.56, 0.008, 24),
  bansheeHub: new THREE.CylinderGeometry(0.06, 0.05, 0.16, 10),
  bansheeGun: new THREE.CylinderGeometry(0.055, 0.06, 0.4, 10).rotateX(Math.PI / 2).translate(0, 0, 0.2),
  bansheePod: new THREE.BoxGeometry(0.14, 0.14, 0.3),
  // misc
  blob: new THREE.CircleGeometry(1, 20),
  geyserCone: new THREE.CylinderGeometry(0.5, 0.85, 0.7, 9),
  geyserThroat: new THREE.CylinderGeometry(0.28, 0.34, 0.3, 9),
  plume: new THREE.ConeGeometry(0.32, 1.4, 10).translate(0, 0.7, 0),
  shrubBlade: new THREE.ConeGeometry(0.08, 1.0, 4).translate(0, 0.5, 0),
  // environment props
  boulder: new THREE.SphereGeometry(0.5, 10, 8),
  treeTrunk: new THREE.CylinderGeometry(0.09, 0.13, 0.55, 7).translate(0, 0.27, 0),
  treeCanopyLo: new THREE.SphereGeometry(0.42, 10, 8),
  treeCanopyHi: new THREE.SphereGeometry(0.30, 10, 8),
  basalt: new THREE.CylinderGeometry(0.26, 0.30, 1.0, 6),
  iceSpire: new THREE.ConeGeometry(0.28, 1.1, 4).translate(0, 0.55, 0),
  crystalShard: new THREE.OctahedronGeometry(0.22),
  floraBlob: new THREE.SphereGeometry(0.16, 8, 7),
};
export const SHARED = G;
export { G };

// ---------------------------------------------------------------------------
// Shared materials. Brightened toon palette — cute, not militaristic.
// ---------------------------------------------------------------------------
export const DARK     = new THREE.MeshToonMaterial({ color: 0x4a5266, gradientMap: toonGradient() });
export const GUNMETAL = new THREE.MeshToonMaterial({ color: 0x5e6878, gradientMap: toonGradient() });
export const TRIM     = new THREE.MeshToonMaterial({ color: 0x9aa4b0, gradientMap: toonGradient() });
export const RUBBER   = new THREE.MeshToonMaterial({ color: 0x3a3e48, gradientMap: toonGradient() });
export const SCAFFOLD = new THREE.MeshToonMaterial({ color: 0xd4a85a, gradientMap: toonGradient() });
export const BUILDING_BASE = new THREE.MeshToonMaterial({ color: 0x5a6680, gradientMap: toonGradient() });

// Team-colored material factory (one per unit/building instance)
export function teamMat(color, emissiveIntensity = 0.15) {
  return new THREE.MeshToonMaterial({
    color, gradientMap: toonGradient(),
    emissive: color, emissiveIntensity,
  });
}

// Glowing emissive material factory (eyes, lamps, engines, crystals)
export function glowMat(color, intensity = 1.6) {
  return new THREE.MeshToonMaterial({
    color, gradientMap: toonGradient(),
    emissive: color, emissiveIntensity: intensity,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Lift a group so its lowest point rests near ground level
export function liftToGround(group, floor = -0.05) {
  group.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(group);
  if (bb.min.y < floor) {
    const dy = floor - bb.min.y;
    for (const c of group.children) c.position.y += dy;
  }
}

// Small canvas texture of additive glowing fissure lines (lava crack decal)
let _crackTex = null;
export function makeCrackTexture() {
  if (_crackTex) return _crackTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, 64, 64);
  ctx.strokeStyle = "rgba(255,150,40,0.95)";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  const seams = [[[10, 8], [24, 30], [20, 54]], [[52, 10], [40, 34], [48, 58]], [[30, 4], [34, 32], [30, 60]]];
  for (const s of seams) {
    ctx.beginPath();
    ctx.moveTo(s[0][0], s[0][1]);
    for (let i = 1; i < s.length; i++) ctx.lineTo(s[i][0], s[i][1]);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255,235,170,0.9)";
  ctx.lineWidth = 1.2;
  for (const s of seams) {
    ctx.beginPath();
    ctx.moveTo(s[0][0], s[0][1]);
    for (let i = 1; i < s.length; i++) ctx.lineTo(s[i][0], s[i][1]);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  _crackTex = tex;
  return tex;
}
