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
// Gear/cog outline: alternating inner/outer radii make blocky teeth, with a
// round hole punched through the middle. THE signature Cog-faction emblem —
// stamped on chests, doors, silos, wheel hubs, and spinning over the HQ.
function makeCogGeo(r = 0.3, teeth = 8, depth = 0.1) {
  const shape = new THREE.Shape();
  const inner = r * 0.76;
  const n = teeth * 4;
  for (let i = 0; i <= n; i++) {
    const seg = i % 4;
    const a = (i / n) * Math.PI * 2;
    const rad = seg === 0 || seg === 3 ? inner : r;
    const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  const hole = new THREE.Path();
  hole.absarc(0, 0, r * 0.3, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

const G = {
  // --- Cog family shared parts (used across every unit AND building) ---
  cog: makeCogGeo(0.3, 8, 0.1),                       // gear emblem / spinner
  rivet: new THREE.SphereGeometry(0.04, 6, 5),        // stud detail (+ rosy cheeks)
  dome: new THREE.SphereGeometry(0.5, 20, 14),        // every head/cabin/roof
  domeVisor: new THREE.SphereGeometry(0.53, 20, 8,    // curved team-glow visor band
    Math.PI / 2 - 0.85, 1.7, Math.PI * 0.36, Math.PI * 0.22),
  tread: new THREE.CapsuleGeometry(0.16, 0.75, 4, 10).rotateX(Math.PI / 2), // pill tread
  stripe: new THREE.TorusGeometry(0.5, 0.045, 8, 28), // team stripe ring
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
// Shared materials — THE COGS palette. Industrious tin-toy robots: warm cream
// enamel shells, tin/gunmetal machinery, copper cog badges + rivets, dark
// rubber treads. Team color is applied ONLY as an accent (visors, stripes,
// bobble antenna tips) via teamMat/glowMat — never the whole body.
// ---------------------------------------------------------------------------
export const CREAM    = new THREE.MeshToonMaterial({ color: 0xf3e9d4, gradientMap: toonGradient() }); // enamel shell
export const TIN      = new THREE.MeshToonMaterial({ color: 0xaeb4ba, gradientMap: toonGradient() }); // light metal
export const COPPER   = new THREE.MeshToonMaterial({ color: 0xc9853f, gradientMap: toonGradient() }); // cogs, bands, rivets
export const DARK     = new THREE.MeshToonMaterial({ color: 0x525a66, gradientMap: toonGradient() }); // joints, sockets
export const GUNMETAL = new THREE.MeshToonMaterial({ color: 0x6d7580, gradientMap: toonGradient() }); // machinery
export const TRIM     = new THREE.MeshToonMaterial({ color: 0x9aa4b0, gradientMap: toonGradient() });
export const RUBBER   = new THREE.MeshToonMaterial({ color: 0x3c4048, gradientMap: toonGradient() }); // treads, grips
export const SCAFFOLD = new THREE.MeshToonMaterial({ color: 0xd4a85a, gradientMap: toonGradient() });
export const BUILDING_BASE = new THREE.MeshToonMaterial({ color: 0xd9cfb6, gradientMap: toonGradient() }); // civic cream

// Family constants: every Cog engine/thruster glows warm amber, every
// infantry face gets rosy cheeks. Shared everywhere so the faction reads as
// one civilization.
export const AMBER = 0xffb457;
export const CHEEK = new THREE.MeshBasicMaterial({ color: 0xff9db0 });

// Per-instance cream shell: same enamel as CREAM but with a warm emissive
// channel so the renderer's damage flash (userData.mats) lights the body up.
// One instance per unit/building, shared across all its cream parts.
export function shellMat() {
  return new THREE.MeshToonMaterial({
    color: 0xf3e9d4, gradientMap: toonGradient(),
    emissive: 0xffdfc0, emissiveIntensity: 0.1,
  });
}

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

// ---------------------------------------------------------------------------
// Idle-fidget gate. Returns a 0..1 pulse that spends most of its time at 0 and
// briefly ramps up-then-down during rare windows, giving units occasional
// "personality" twitches (a glance, a jaw snap, a weight-shift) instead of
// constant motion. Deterministic from time `t` + a per-unit `seed` (use e.id
// plus a small offset so different fidgets on the same unit don't sync).
//
// Usage:  const f = fidget(t, e.id, 0.13);  // f>0 only in brief windows
//         head.rotation.y = f * 0.4;          // scale motion by the pulse
//
// `rate` sets how often windows open (lower = rarer). `sharp` (default 40)
// controls how narrow each window is. Cheap: two sins + a pow.
export function fidget(t, seed, rate = 0.13, sharp = 40) {
  const s = Math.sin(t * rate + seed);
  if (s < 0.9) return 0;                 // cheap early-out most of the time
  // remap the top sliver of the sine into a 0..1..0 hump
  const w = Math.pow((s - 0.9) / 0.1, 0.5);   // 0..1 across the window
  return Math.sin(w * Math.PI);               // smooth up-then-down
}

// Lift a group so its lowest point rests near ground level
export function liftToGround(group, floor = -0.05) {
  group.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(group);
  if (bb.min.y < floor) {
    const dy = floor - bb.min.y;
    for (const c of group.children) c.position.y += dy;
  }
}

// ---------------------------------------------------------------------------
// THE OOZE — additive-only shared resources for the gooey-alien faction. NONE
// of the Cog materials/geometries above are touched. Family DNA:
//   * Translucent wobbly shells: a per-instance acid-green MeshToonMaterial with
//     transparency + a faint emissive "subsurface" glow (oozeShell()).
//   * Bruised-purple flesh underneath (OOZE_PURPLE) reads through the shell.
//   * Glistening rim/membrane accents in team color (via teamMat) + glowing
//     cores/eyes (glowMat) — accent only, never the whole body.
//   * Spore/bubble bumps (OG.bubble) and gooey rounded blobs everywhere.
//   * Amber is a Cog thing; the Ooze glows sickly acid-green / cyan-bile.
// ---------------------------------------------------------------------------

// Opaque flesh tones (read through / behind the translucent shells).
export const OOZE_PURPLE = new THREE.MeshToonMaterial({ color: 0x4a2b52, gradientMap: toonGradient() }); // bruised inner flesh
export const OOZE_PLUM   = new THREE.MeshToonMaterial({ color: 0x6b3a63, gradientMap: toonGradient() }); // lighter membrane
export const OOZE_DARK   = new THREE.MeshToonMaterial({ color: 0x241830, gradientMap: toonGradient() }); // sockets / gaps / maw interior
export const OOZE_BONE   = new THREE.MeshToonMaterial({ color: 0xe8e6cf, gradientMap: toonGradient() }); // fangs / teeth / claws
// Sickly acid-green emissive: the Ooze answer to the Cogs' AMBER glow.
export const BILE = 0x9be23a;

// Per-instance translucent acid-green shell. Transparent + faint self-emissive
// gives the wet "subsurface" jelly feel; ONE instance per model, shared across
// all its shell parts, and returned so it can also drive the damage flash.
//
// Richness pass: a slightly DEEPER base green (was flat-lime 0x8fd63a) so the
// toon ramp has more room to pop a bright top band, a warmer/brighter emissive
// tint that reads as a wet subsurface glow rather than a dull fill, and a
// touch LESS opacity (0.72 -> 0.66) so the bruised-purple gut shows through
// harder — the see-through read is the whole point of the family. specular +
// shininess give MeshToon a faint glossy spot for the "wet" feel (MeshToon
// honours specular via its Phong lineage even with a gradient ramp).
export function oozeShell(intensity = 0.26) {
  const m = new THREE.MeshToonMaterial({
    color: 0x7fce30, gradientMap: toonGradient(),
    emissive: 0x6ec02f, emissiveIntensity: intensity,
    transparent: true, opacity: 0.66,
  });
  return m;
}

// Deeper acid-green for shadowed/underbelly shell parts — pairs with oozeShell
// to give the body some tonal range instead of one flat lime. Same transparency
// so it reads as the same jelly, just the darker side of the blob.
export function oozeShellDeep(intensity = 0.18) {
  return new THREE.MeshToonMaterial({
    color: 0x5fa626, gradientMap: toonGradient(),
    emissive: 0x4c8a22, emissiveIntensity: intensity,
    transparent: true, opacity: 0.72,
  });
}

// Ooze shared geometry — additive companion to G. Blobby spheres, sacs, tendrils,
// fangs, spores. All created once, reused across every Ooze model instance.
export const OG = {
  blob:    new THREE.SphereGeometry(0.5, 16, 12),          // the universal goo blob
  blobHi:  new THREE.SphereGeometry(0.5, 20, 14),          // smoother hero blob
  bubble:  new THREE.SphereGeometry(0.09, 10, 8),          // spore / surface bump
  bubbleBig: new THREE.SphereGeometry(0.16, 12, 9),        // fat spore pod
  eye:     new THREE.SphereGeometry(0.12, 14, 12),         // glossy eye
  core:    new THREE.SphereGeometry(0.3, 16, 12),          // glowing inner organ
  tendril: new THREE.CapsuleGeometry(0.06, 0.4, 4, 8),     // wobbly limb / tool
  tendrilFat: new THREE.CapsuleGeometry(0.11, 0.5, 5, 10), // leg / thick arm
  fang:    new THREE.ConeGeometry(0.06, 0.22, 7),          // tooth / claw / spine
  fangBig: new THREE.ConeGeometry(0.13, 0.5, 8),           // barb spine / tusk
  pore:    new THREE.CylinderGeometry(0.16, 0.26, 0.34, 12), // vent / orifice
  poreLip: new THREE.TorusGeometry(0.24, 0.08, 8, 18),     // puckered rim
  membrane: new THREE.TorusGeometry(0.5, 0.06, 8, 24),     // team-color rim band
  sac:     new THREE.SphereGeometry(0.5, 18, 14),          // bloated body (scaled tall/wide)
  proboscis: new THREE.CylinderGeometry(0.1, 0.22, 0.7, 10), // sump ground-straw
  droplet: new THREE.SphereGeometry(0.5, 12, 9),           // teardrop (scaled)
};

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
