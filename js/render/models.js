// Procedural unit & building models built from primitives, with animation
// rigs. Each visual gets userData refs that animateVisual() drives per frame.
// Purely presentational — nothing here may touch sim state.
import * as THREE from "three";

// ---------------------------------------------------------------------------
// Toon gradient map: a tiny 1D DataTexture with NearestFilter gives
// MeshToonMaterial a hard-stepped 3-4 band shading ramp (Saturday-morning
// cartoon look). Shared by terrain + environment props. Cached once.
// ---------------------------------------------------------------------------
let _toonGrad = null;
export function toonGradient() {
  if (_toonGrad) return _toonGrad;
  // 4 steps, biased bright so shadows stay light (soft toon shadowing).
  const data = new Uint8Array([90, 150, 205, 255]);
  const tex = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  _toonGrad = tex;
  return tex;
}

// A stepped-toon standard-ish material for environment props. MeshToonMaterial
// keeps emissive (so bloom still works) and honors the shared gradient ramp.
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

// shared geometries (created once). Slightly-more-segmented primitives read as
// gently bevelled without inflating tri counts; every key below is reused across
// many instances so nothing is allocated per make* call beyond a Group.
const G = {
  // worker drone — rounder friendly utility bot
  dronePod: new THREE.SphereGeometry(0.3, 18, 14),
  droneBelly: new THREE.SphereGeometry(0.22, 14, 10),     // lower chassis blister
  droneCollar: new THREE.TorusGeometry(0.24, 0.05, 8, 20), // brow ring around eye
  droneThruster: new THREE.CylinderGeometry(0.08, 0.11, 0.18, 10),
  droneThrusterGlow: new THREE.CylinderGeometry(0.07, 0.07, 0.04, 10),
  droneEye: new THREE.SphereGeometry(0.1, 12, 10),          // single round glowing eye
  droneArm: new THREE.BoxGeometry(0.06, 0.06, 0.3).translate(0, 0, 0.15),
  droneForearm: new THREE.CylinderGeometry(0.045, 0.055, 0.22, 8).rotateX(Math.PI / 2).translate(0, 0, 0.34),
  droneElbow: new THREE.SphereGeometry(0.055, 8, 6),        // articulation joint
  droneDrill: new THREE.ConeGeometry(0.05, 0.16, 8).rotateX(Math.PI / 2).translate(0, 0, 0.36),
  crystal: new THREE.OctahedronGeometry(0.14),
  // marine — iconic armored footman
  torso: new THREE.CapsuleGeometry(0.21, 0.26, 5, 12),
  chestPlate: new THREE.BoxGeometry(0.28, 0.24, 0.1),      // beveled feel via placement
  collar: new THREE.CylinderGeometry(0.11, 0.15, 0.12, 10),// neck ring under helmet
  head: new THREE.SphereGeometry(0.135, 14, 12),
  visor: new THREE.BoxGeometry(0.17, 0.05, 0.06),
  pauldron: new THREE.SphereGeometry(0.13, 12, 8),         // shoulder guard
  leg: new THREE.BoxGeometry(0.1, 0.24, 0.1).translate(0, -0.12, 0),
  boot: new THREE.BoxGeometry(0.12, 0.09, 0.16).translate(0, -0.04, 0.02),
  gunBody: new THREE.BoxGeometry(0.08, 0.1, 0.46),
  gunReceiver: new THREE.BoxGeometry(0.1, 0.13, 0.18),      // chunky mid-body
  gunMag: new THREE.BoxGeometry(0.06, 0.16, 0.08),
  gunTip: new THREE.CylinderGeometry(0.035, 0.045, 0.16, 8).rotateX(Math.PI / 2), // muzzle
  pack: new THREE.BoxGeometry(0.24, 0.28, 0.13),
  // brute — hunched armored bruiser
  bruteCore: new THREE.SphereGeometry(0.42, 12, 10),       // hunched mass (squashed)
  bruteBody: new THREE.DodecahedronGeometry(0.4),          // kept for compatibility
  bruteChest: new THREE.BoxGeometry(0.46, 0.34, 0.32),     // armored chest slab
  bruteShoulder: new THREE.SphereGeometry(0.18, 12, 9),    // big pauldron
  bruteHead: new THREE.SphereGeometry(0.16, 12, 10),       // low bull head
  bruteJaw: new THREE.BoxGeometry(0.22, 0.1, 0.16),
  bruteArm: new THREE.BoxGeometry(0.14, 0.4, 0.14).translate(0, -0.2, 0),
  bruteForearm: new THREE.BoxGeometry(0.18, 0.24, 0.18).translate(0, -0.12, 0),
  bruteFist: new THREE.SphereGeometry(0.11, 10, 8),
  bruteGauntlet: new THREE.BoxGeometry(0.22, 0.2, 0.22),   // oversized knuckles
  spike: new THREE.ConeGeometry(0.06, 0.2, 8),
  // buildings
  lamp: new THREE.SphereGeometry(0.07, 10, 8),
  pole: new THREE.CylinderGeometry(0.03, 0.03, 1.4, 8),
  antenna: new THREE.CylinderGeometry(0.018, 0.03, 0.9, 6).translate(0, 0.45, 0),
  dish: new THREE.BoxGeometry(0.5, 0.06, 0.18),
  vent: new THREE.CylinderGeometry(0.16, 0.2, 0.3, 10),    // rounded roof vent
  pipe: new THREE.CylinderGeometry(0.09, 0.09, 0.6, 8),    // greeble pipe
  scaffold: new THREE.BoxGeometry(0.08, 1, 0.08),
  mineral: new THREE.OctahedronGeometry(0.45),
  mineralSmall: new THREE.OctahedronGeometry(0.22),
  ring: new THREE.RingGeometry(0.5, 0.6, 28),
  bar: new THREE.PlaneGeometry(1, 0.11),
  flag: new THREE.BoxGeometry(0.34, 0.2, 0.02),
  // tank — low wide siege tank
  tankHull: new THREE.BoxGeometry(0.86, 0.24, 1.02),
  tankGlacis: new THREE.BoxGeometry(0.86, 0.24, 0.34),     // sloped front plate
  tankTread: new THREE.BoxGeometry(0.24, 0.32, 1.28),
  tankGuard: new THREE.BoxGeometry(0.3, 0.08, 1.34),       // tread guard over each track
  tankWheel: new THREE.CylinderGeometry(0.11, 0.11, 0.26, 12).rotateZ(Math.PI / 2),
  tankTurret: new THREE.BoxGeometry(0.5, 0.26, 0.55),
  tankTurretBevel: new THREE.CylinderGeometry(0.3, 0.34, 0.24, 10), // beveled turret cheeks
  tankMantlet: new THREE.BoxGeometry(0.34, 0.22, 0.2),
  tankBarrel: new THREE.CylinderGeometry(0.05, 0.065, 0.66, 12).rotateX(Math.PI / 2).translate(0, 0, 0.33),
  tankBarrel2: new THREE.CylinderGeometry(0.07, 0.075, 0.4, 12).rotateX(Math.PI / 2).translate(0, 0, 0.14), // stepped inner section
  tankMuzzle: new THREE.CylinderGeometry(0.09, 0.09, 0.16, 12).rotateX(Math.PI / 2), // muzzle brake
  // wraith — sleek air-superiority dart
  wraithFuse: new THREE.CylinderGeometry(0.09, 0.17, 0.95, 12).rotateX(Math.PI / 2),
  wraithSpine: new THREE.BoxGeometry(0.1, 0.1, 0.6),        // dorsal spine
  wraithNose: new THREE.ConeGeometry(0.09, 0.4, 12).rotateX(-Math.PI / 2).translate(0, 0, 0.64),
  wraithWing: new THREE.BoxGeometry(1.15, 0.045, 0.36),
  wraithTail: new THREE.BoxGeometry(0.52, 0.045, 0.2),
  wraithFin: new THREE.BoxGeometry(0.05, 0.3, 0.24),
  wraithNacelle: new THREE.CapsuleGeometry(0.075, 0.3, 4, 10).rotateX(Math.PI / 2), // engine pod
  wraithEngine: new THREE.CylinderGeometry(0.09, 0.06, 0.1, 12).rotateX(Math.PI / 2),
  wraithEngineGlow: new THREE.CylinderGeometry(0.06, 0.03, 0.05, 12).rotateX(Math.PI / 2),
  // banshee — heavier armored gunship
  bansheeBody: new THREE.CapsuleGeometry(0.2, 0.62, 5, 14).rotateX(Math.PI / 2),
  bansheeArmor: new THREE.BoxGeometry(0.34, 0.2, 0.5),     // fuselage armor slab
  bansheeCanopy: new THREE.SphereGeometry(0.15, 12, 10),
  bansheeArm: new THREE.BoxGeometry(0.08, 0.08, 0.44),
  bansheeRotor: new THREE.CylinderGeometry(0.56, 0.56, 0.008, 24),
  bansheeHub: new THREE.CylinderGeometry(0.06, 0.05, 0.16, 10),
  bansheeGun: new THREE.CylinderGeometry(0.055, 0.06, 0.4, 10).rotateX(Math.PI / 2).translate(0, 0, 0.2),
  bansheePod: new THREE.BoxGeometry(0.14, 0.14, 0.3),      // under-slung rocket pod
  // blob shadow for flyers
  blob: new THREE.CircleGeometry(1, 20),
  // geyser
  geyserCone: new THREE.CylinderGeometry(0.5, 0.85, 0.7, 9),
  geyserThroat: new THREE.CylinderGeometry(0.28, 0.34, 0.3, 9),
  plume: new THREE.ConeGeometry(0.32, 1.4, 10).translate(0, 0.7, 0),
  // shrub
  shrubBlade: new THREE.ConeGeometry(0.08, 1.0, 4).translate(0, 0.5, 0),
  // ---- environment barrier props (instanced by the renderer) ----
  // rounded boulder (kind 4 rock, geyser chunks, rock-pile deco): a low-poly
  // sphere, squashed by per-instance scale so it never reads as a polyhedron.
  boulder: new THREE.SphereGeometry(0.5, 10, 8),
  // stylized tree: cylinder trunk + squashed-sphere canopy (2 stacked blobs).
  treeTrunk: new THREE.CylinderGeometry(0.09, 0.13, 0.55, 7).translate(0, 0.27, 0),
  treeCanopyLo: new THREE.SphereGeometry(0.42, 10, 8),
  treeCanopyHi: new THREE.SphereGeometry(0.30, 10, 8),
  // basalt prism: 6-sided column (kind 2 lava).
  basalt: new THREE.CylinderGeometry(0.26, 0.30, 1.0, 6),
  // ice spire: 4-sided pyramid / cone (kind 3 ice).
  iceSpire: new THREE.ConeGeometry(0.28, 1.1, 4).translate(0, 0.55, 0),
  // rounded crystal shard (deco kind 0): elongated octahedron reads faceted
  // but not spiky.
  crystalShard: new THREE.OctahedronGeometry(0.22),
  // flora tuft (deco kind 2): rounded blob on a short stem.
  floraBlob: new THREE.SphereGeometry(0.16, 8, 7),
};
export const SHARED = G;

const DARK = new THREE.MeshStandardMaterial({ color: 0x232830, roughness: 0.5, metalness: 0.5 });
const GUNMETAL = new THREE.MeshStandardMaterial({ color: 0x30363f, roughness: 0.35, metalness: 0.7 });
// warm neutral trim: the "one accent" tone that reads on every chassis without
// stealing from the team color. Kept non-emissive so damage-flash stays on mats.
const TRIM = new THREE.MeshStandardMaterial({ color: 0x8a929c, roughness: 0.4, metalness: 0.6 });
const RUBBER = new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.85, metalness: 0.2 });

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
  s1.rotation.set(0.4, e.id, 0.2);
  const s2 = new THREE.Mesh(G.mineralSmall, mat);
  s2.position.set(-0.26, 0.14, 0.18);
  s2.rotation.set(-0.3, e.id * 1.3, 0.1);
  // a third small shard + darker rock base for a planted, clustered read
  const s3 = new THREE.Mesh(G.mineralSmall, mat);
  s3.scale.setScalar(0.7);
  s3.position.set(0.05, 0.1, 0.32);
  s3.rotation.set(0.6, e.id * 0.5, -0.2);
  const baseRock = new THREE.Mesh(G.boulder, propToon({ color: 0x2c3138 }));
  baseRock.scale.set(0.85, 0.4, 0.85);
  baseRock.position.y = 0.02;
  group.add(baseRock, main, s1, s2, s3);
  group.userData.crystal = main;
  group.userData.anim = { kind: "mineral", mat };
  return group;
}

// Vespene geyser: squat rocky vent cone with a glowing green throat and a slow
// pulsing translucent plume. `rockColor` is the theme rock color.
export function makeGeyserVisual(e, rockColor) {
  const group = new THREE.Group();
  const rockMat = propToon({ color: rockColor });
  const cone = new THREE.Mesh(G.geyserCone, rockMat);
  cone.position.y = 0.35;
  cone.castShadow = true;
  cone.rotation.y = (e.id * 0.7) % Math.PI;
  const throatMat = glowMat(0x7cd94f, 1.6);
  const throat = new THREE.Mesh(G.geyserThroat, throatMat);
  throat.position.y = 0.72;
  // dark rock rim around the glowing throat for contrast
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.07, 8, 16), propToon({ color: rockColor }));
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.72;
  group.add(rim);
  // rounded boulders around the base for silhouette (no polyhedra)
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + e.id;
    const chunk = new THREE.Mesh(G.boulder, rockMat);
    chunk.castShadow = true;
    chunk.position.set(Math.cos(a) * 0.72, 0.1, Math.sin(a) * 0.72);
    chunk.scale.set(0.62, 0.44, 0.62);
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

// ---------------------------------------------------------------------------
// Barrier prop materials (shared, theme-tinted). The renderer builds the
// InstancedMeshes; these keep the toon look + emissive contract in one place.
// A theme is { rock, ground, groundHi, deco:[c0,c1,c2], ... }.
// ---------------------------------------------------------------------------
export function barrierMaterials(theme) {
  const rockHex = theme.rock;
  const [d0, d1, d2] = theme.deco;                    // flora/ember/ice accents
  // forest trunk (dark warm), canopy (deco[2] darker flora tone)
  return {
    boulder: propToon({ color: rockHex }),
    treeTrunk: propToon({ color: 0x5a4632 }),
    treeCanopy: propToon({ color: d2, emissive: d2, emissiveIntensity: 0.06 }),
    // basalt: near-black volcanic rock; crack decal glows orange
    basalt: propToon({ color: 0x2a2420 }),
    crack: new THREE.MeshBasicMaterial({
      map: makeCrackTexture(), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    // ice: pale translucent crystal with a bright rim glow
    ice: new THREE.MeshToonMaterial({
      color: 0xbfe6ff, gradientMap: toonGradient(),
      emissive: 0x8fd0ff, emissiveIntensity: 0.55,
      transparent: true, opacity: 0.78,
    }),
  };
}

// Small canvas of additive glowing fissure lines for the lava crack decal.
let _crackTex = null;
function makeCrackTexture() {
  if (_crackTex) return _crackTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, 64, 64);
  // a couple of branching bright fissures on transparent ground
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
  // brighter hot core
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

// Tall shrub (deco kind 3): clumped tall grass tufts, theme-tinted, subtle sway.
// Marks LoS-blocker tiles — reads as concealment, taller than a unit.
export function makeShrubVisual(tint, id) {
  const group = new THREE.Group();
  const mat = propToon({ color: tint, emissive: tint, emissiveIntensity: 0.1 });
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
    // plucky utility bot: rounded team-color pod, a darker belly chassis, a
    // single round glowing eye ringed by a brow, and stubby thruster pods.
    const pod = new THREE.Mesh(G.dronePod, team);
    pod.scale.set(1, 0.78, 1.12);
    pod.castShadow = true;
    const belly = new THREE.Mesh(G.droneBelly, GUNMETAL);
    belly.position.set(0, -0.16, 0.02);
    belly.scale.set(1.05, 0.8, 1.05);
    // single expressive eye with a dark brow ring for a "face"
    const eye = new THREE.Mesh(G.droneEye, glow);
    eye.position.set(0, 0.05, 0.28);
    const brow = new THREE.Mesh(G.droneCollar, DARK);
    brow.position.set(0, 0.05, 0.27);
    brow.scale.setScalar(0.55);
    const tl = new THREE.Mesh(G.droneThruster, GUNMETAL);
    tl.position.set(0.27, -0.09, -0.02);
    tl.rotation.z = 0.18;
    const tlGlow = new THREE.Mesh(G.droneThrusterGlow, glowMat(0x63e8db, 1.2));
    tlGlow.position.set(0.29, -0.17, -0.02);
    const tr = tl.clone();
    tr.position.x = -0.27; tr.rotation.z = -0.18;
    const trGlow = tlGlow.clone();
    trGlow.position.x = -0.29;
    const carry = new THREE.Mesh(G.crystal, glowMat(0x63e8db, 1.4));
    carry.position.set(0, -0.2, 0.24);
    carry.visible = false;
    // articulated manipulator arm: upper boom + elbow + forearm + tool tip.
    const arm = new THREE.Group();
    const armMesh = new THREE.Mesh(G.droneArm, GUNMETAL);
    const elbow = new THREE.Mesh(G.droneElbow, TRIM);
    elbow.position.set(0, 0, 0.3);
    const forearm = new THREE.Mesh(G.droneForearm, DARK);
    const drill = new THREE.Mesh(G.droneDrill, glowMat(0x63e8db, 0.6));
    arm.add(armMesh, elbow, forearm, drill);
    arm.position.set(0.14, -0.07, 0.18);
    arm.rotation.x = 0.35;       // retracted by default
    arm.scale.setScalar(0.75);
    body.add(pod, belly, eye, brow, tl, tlGlow, tr, trGlow, carry, arm);
    body.position.y = 0.42;
    // the eye doubles as a task light: team color when moving/idle,
    // cyan while mining, amber while constructing
    anim = {
      kind: "worker", carry, carryMat: carry.material, hover: e.id % 7, eye: eye.material,
      baseColor: new THREE.Color(color), arm, drill: drill.material,
    };
  } else if (e.type === "marine") {
    // iconic footman: bulky armored torso with a chest plate, shoulder
    // pauldrons, a rounded helmet with a bright visor slit, a chunky rifle
    // with a muzzle, and slightly-bent planted legs.
    const torso = new THREE.Mesh(G.torso, team);
    torso.position.y = 0.48;
    torso.scale.set(1.08, 1, 0.95);
    torso.castShadow = true;
    const chest = new THREE.Mesh(G.chestPlate, GUNMETAL);
    chest.position.set(0, 0.5, 0.14);
    chest.rotation.x = -0.12;                 // angled plate catches light
    const collarPiece = new THREE.Mesh(G.collar, DARK);
    collarPiece.position.set(0, 0.68, 0);
    const head = new THREE.Mesh(G.head, DARK);
    head.position.y = 0.78;
    head.scale.set(1, 1.05, 1);
    const visor = new THREE.Mesh(G.visor, glow);
    visor.position.set(0, 0.79, 0.1);
    visor.rotation.x = -0.1;
    // shoulder pauldrons — asymmetric so it doesn't read CAD-clean
    const pauldronL = new THREE.Mesh(G.pauldron, team);
    pauldronL.position.set(0.24, 0.6, 0);
    pauldronL.scale.set(1.1, 0.9, 1.05);
    const pauldronR = new THREE.Mesh(G.pauldron, team);
    pauldronR.position.set(-0.24, 0.58, 0);
    pauldronR.scale.set(1, 0.85, 1);
    const pack = new THREE.Mesh(G.pack, GUNMETAL);
    pack.position.set(0, 0.52, -0.2);
    const legL = new THREE.Mesh(G.leg, DARK);
    legL.position.set(0.11, 0.28, 0.02);
    legL.rotation.x = 0.08;                    // planted, slightly bent
    const bootL = new THREE.Mesh(G.boot, TRIM);
    bootL.position.set(0.11, 0.04, 0.04);
    legL.add(bootL); bootL.position.set(0, -0.24, 0.02);
    const legR = new THREE.Mesh(G.leg, DARK);
    legR.position.set(-0.11, 0.28, 0.02);
    legR.rotation.x = 0.08;
    const bootR = bootL.clone();
    legR.add(bootR);
    const gunGroup = new THREE.Group();
    const gun = new THREE.Mesh(G.gunBody, GUNMETAL);
    gun.position.z = 0.06;
    const receiver = new THREE.Mesh(G.gunReceiver, DARK);
    receiver.position.z = -0.08;
    const mag = new THREE.Mesh(G.gunMag, TRIM);
    mag.position.set(0, -0.11, -0.04);
    const tip = new THREE.Mesh(G.gunTip, glow);
    tip.position.set(0, 0, 0.32);
    gunGroup.add(gun, receiver, mag, tip);
    gunGroup.position.set(0.22, 0.5, 0.16);
    body.add(torso, chest, collarPiece, head, visor, pauldronL, pauldronR, pack, legL, legR, gunGroup);
    anim = { kind: "marine", legL, legR, gunGroup, gunHome: 0.16 };
  } else if (e.type === "tank") {
    // low wide siege tank: sloped glacis, defined tread guards, beefy turret
    // with a long stepped barrel + muzzle brake.
    const hull = new THREE.Mesh(G.tankHull, team);
    hull.position.y = 0.34;
    hull.castShadow = true;
    const glacis = new THREE.Mesh(G.tankGlacis, GUNMETAL);
    glacis.position.set(0, 0.32, 0.52);
    glacis.rotation.x = -0.5;                  // sloped front plate
    const treadL = new THREE.Mesh(G.tankTread, RUBBER);
    treadL.position.set(0.55, 0.2, 0);
    const treadR = treadL.clone();
    treadR.position.x = -0.55;
    // road wheels peeking from the tracks
    for (const tx of [0.55, -0.55]) {
      for (const tz of [-0.42, 0, 0.42]) {
        const w = new THREE.Mesh(G.tankWheel, TRIM);
        w.position.set(tx, 0.12, tz);
        body.add(w);
      }
    }
    const guardL = new THREE.Mesh(G.tankGuard, DARK);
    guardL.position.set(0.55, 0.4, 0);
    const guardR = guardL.clone();
    guardR.position.x = -0.55;
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.1, 1.0), GUNMETAL);
    skirt.position.y = 0.48;
    // turret group rotates on Y; barrel recoils along -Z of the turret
    const turret = new THREE.Group();
    const dome = new THREE.Mesh(G.tankTurret, team);
    dome.position.y = 0;
    const cheeks = new THREE.Mesh(G.tankTurretBevel, team); // rounded turret sides
    cheeks.rotation.x = Math.PI / 2;
    cheeks.position.set(0, 0, 0.02);
    cheeks.scale.set(1, 1, 0.55);
    const mantlet = new THREE.Mesh(G.tankMantlet, GUNMETAL);
    mantlet.position.set(0, 0, 0.32);
    const barrelGroup = new THREE.Group();
    const barrel = new THREE.Mesh(G.tankBarrel, GUNMETAL);
    barrel.position.z = 0.44;
    const barrelStep = new THREE.Mesh(G.tankBarrel2, DARK); // stepped inner section
    const muzzle = new THREE.Mesh(G.tankMuzzle, GUNMETAL);
    muzzle.position.z = 1.02;
    const muzzleGlow = new THREE.Mesh(G.tankMuzzle, glow);
    muzzleGlow.scale.setScalar(0.6);
    muzzleGlow.position.z = 1.02;
    barrelGroup.add(barrelStep, barrel, muzzle, muzzleGlow);
    barrelGroup.position.set(0, 0, 0.28);
    const hatch = new THREE.Mesh(G.droneEye, glow);
    hatch.scale.set(1.4, 0.7, 1);
    hatch.position.set(0.1, 0.16, -0.12);
    turret.add(dome, cheeks, mantlet, barrelGroup, hatch);
    turret.position.set(0, 0.62, 0);
    body.add(hull, glacis, treadL, treadR, guardL, guardR, skirt, turret);
    anim = { kind: "tank", turret, barrelGroup, barrelHome: 0.28 };
  } else if (e.type === "wraith") {
    // sleek air-superiority dart: slim fuselage, dorsal spine, swept wings, a
    // canopy, twin engine nacelles with bright emissive exhaust.
    const fuse = new THREE.Mesh(G.wraithFuse, team);
    fuse.castShadow = true;
    const spine = new THREE.Mesh(G.wraithSpine, GUNMETAL);
    spine.position.set(0, 0.09, -0.06);
    const nose = new THREE.Mesh(G.wraithNose, DARK);
    const wing = new THREE.Mesh(G.wraithWing, team);
    wing.position.set(0, -0.02, -0.05);
    wing.rotation.y = 0.32;                 // sweep back
    const wingTrim = new THREE.Mesh(G.wraithWing, TRIM);
    wingTrim.scale.set(1, 1.4, 0.28);
    wingTrim.position.set(0, -0.015, 0.06);
    wingTrim.rotation.y = 0.32;
    wing.add(wingTrim); wingTrim.position.set(0, 0, 0.09);
    const tail = new THREE.Mesh(G.wraithTail, team);
    tail.position.set(0, 0.02, -0.5);
    const fin = new THREE.Mesh(G.wraithFin, DARK);
    fin.position.set(0, 0.14, -0.5);
    const cockpit = new THREE.Mesh(G.bansheeCanopy, glowMat(0x9fdcff, 0.7));
    cockpit.scale.set(0.7, 0.5, 1.1);
    cockpit.position.set(0, 0.1, 0.2);
    const engMat = glowMat(color, 2.4);     // >1 for bloom
    // twin engine nacelles slung under the wing roots, each with a bright core
    const nacL = new THREE.Mesh(G.wraithNacelle, GUNMETAL);
    nacL.position.set(0.22, -0.04, -0.42);
    const engL = new THREE.Mesh(G.wraithEngine, DARK);
    engL.position.set(0.22, -0.04, -0.5);
    const engLGlow = new THREE.Mesh(G.wraithEngineGlow, engMat);
    engLGlow.position.set(0.22, -0.04, -0.55);
    const nacR = nacL.clone(); nacR.position.x = -0.22;
    const engR = engL.clone(); engR.position.x = -0.22;
    const engRGlow = engLGlow.clone(); engRGlow.position.x = -0.22;
    body.add(fuse, spine, nose, wing, tail, fin, cockpit, nacL, nacR, engL, engR, engLGlow, engRGlow);
    anim = { kind: "wraith", engMat, roll: 0 };
  } else if (e.type === "banshee") {
    // heavier gunship: armored fuselage, twin overhead rotor discs, under-nose
    // gun and under-slung rocket pods. Menacing bulk.
    const bodyMesh = new THREE.Mesh(G.bansheeBody, team);
    bodyMesh.castShadow = true;
    const armor = new THREE.Mesh(G.bansheeArmor, GUNMETAL);
    armor.position.set(0, 0.02, 0.05);
    const canopy = new THREE.Mesh(G.bansheeCanopy, glowMat(0x9fdcff, 0.7));
    canopy.scale.set(0.9, 0.7, 1);
    canopy.position.set(0, 0.12, 0.4);
    const gun = new THREE.Mesh(G.bansheeGun, GUNMETAL);
    gun.position.set(0, -0.16, 0.35);
    const gunTip = new THREE.Mesh(G.tankMuzzle, glow);
    gunTip.scale.setScalar(0.6);
    gunTip.position.set(0, -0.16, 0.62);
    // under-slung rocket pods on the flanks
    const podL = new THREE.Mesh(G.bansheePod, DARK);
    podL.position.set(0.26, -0.12, 0.02);
    const podR = podL.clone(); podR.position.x = -0.26;
    body.add(podL, podR);
    // two rotor assemblies on thin arms
    const rotors = [];
    for (const side of [0.34, -0.34]) {
      const arm = new THREE.Mesh(G.bansheeArm, GUNMETAL);
      arm.position.set(side, 0.14, -0.05);
      arm.rotation.x = Math.PI / 2;
      const hub = new THREE.Mesh(G.bansheeHub, TRIM);
      hub.position.set(side, 0.3, -0.05);
      const disc = new THREE.Mesh(G.bansheeRotor, glowMat(color, 0.6));
      disc.position.set(side, 0.37, -0.05);
      body.add(arm, hub, disc);
      rotors.push(disc);
    }
    body.add(bodyMesh, armor, canopy, gun, gunTip);
    anim = { kind: "banshee", rotors, roll: 0 };
  } else { // brute — heavy melee bruiser: hunched armored mass, big asymmetric
    // shoulder plates, oversized gauntlets, a low menacing head with a glow eye.
    const core = new THREE.Mesh(G.bruteCore, team);
    core.position.set(0, 0.5, -0.04);
    core.scale.set(1.05, 1.0, 0.92);
    core.castShadow = true;
    const chest = new THREE.Mesh(G.bruteChest, GUNMETAL);
    chest.position.set(0, 0.5, 0.14);
    chest.rotation.x = 0.12;                   // hunched forward
    // broad shoulder plates — asymmetric (left bigger) for menace
    const shL = new THREE.Mesh(G.bruteShoulder, DARK);
    shL.scale.set(1.5, 1.15, 1.35);
    shL.position.set(0.5, 0.9, -0.02);
    const shR = new THREE.Mesh(G.bruteShoulder, DARK);
    shR.scale.set(1.25, 1.0, 1.2);
    shR.position.set(-0.48, 0.82, -0.02);
    // back spikes: two, tucked into the shoulder mass
    for (let i = 0; i < 2; i++) {
      const sp = new THREE.Mesh(G.spike, GUNMETAL);
      const a = i === 0 ? 0.5 : Math.PI - 0.5;
      sp.position.set(Math.cos(a) * 0.34, 1.0, -0.26);
      sp.rotation.z = -Math.cos(a) * 0.4;
      sp.scale.setScalar(0.9);
      body.add(sp);
    }
    // low bull head sunk between the shoulders, with a jaw and a glow eye
    const head = new THREE.Mesh(G.bruteHead, DARK);
    head.position.set(0, 0.62, 0.22);
    head.scale.set(1, 0.85, 1);
    const jaw = new THREE.Mesh(G.bruteJaw, GUNMETAL);
    jaw.position.set(0, 0.5, 0.32);
    const eye = new THREE.Mesh(G.droneEye, glowMat(0xff8844, 1.8));
    eye.scale.set(1.6, 0.7, 1);
    eye.position.set(0, 0.66, 0.34);
    // heavy arms: upper + forearm + oversized gauntlet fist
    const armL = new THREE.Group();
    const upperL = new THREE.Mesh(G.bruteArm, DARK);
    const foreL = new THREE.Mesh(G.bruteForearm, GUNMETAL);
    foreL.position.y = -0.4;
    const gauntL = new THREE.Mesh(G.bruteGauntlet, team);
    gauntL.position.y = -0.62;
    const fistL = new THREE.Mesh(G.bruteFist, DARK);
    fistL.scale.setScalar(1.2);
    fistL.position.y = -0.78;
    armL.add(upperL, foreL, gauntL, fistL);
    armL.position.set(0.54, 0.66, 0.02);
    const armR = armL.clone();
    armR.position.x = -0.54;
    body.add(core, chest, shL, shR, head, jaw, eye, armL, armR);
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
    // command center: broad dark base, team-trim mid storey, control tower with
    // a rotating radar dish, a corner landing pad, antennae greebles.
    const b1 = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.9, 2.7), base);
    b1.position.y = 0.45;
    const trim = new THREE.Mesh(new THREE.BoxGeometry(2.74, 0.14, 2.74), team);
    trim.position.y = 0.86;
    const b2 = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.6, 2.0), team);
    b2.position.y = 1.2;
    // beveled tower shoulders break the stack
    const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.05, 0.2, 8), GUNMETAL);
    shoulder.position.y = 1.55;
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.68, 0.8, 10), base);
    tower.position.y = 1.98;
    const towerBand = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.1, 10), team);
    towerBand.position.y = 2.28;
    const pole = new THREE.Mesh(G.pole, GUNMETAL);
    pole.position.y = 2.6;
    pole.scale.y = 0.6;
    const dish = new THREE.Mesh(G.dish, team);
    dish.position.y = 3.0;
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.1, 20), GUNMETAL);
    pad.position.set(0.8, 0.95, 0.8);
    const padRing = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.05, 8, 20), glowMat(color, 0.7));
    padRing.rotation.x = Math.PI / 2;
    padRing.position.set(0.8, 1.01, 0.8);
    const antL = new THREE.Mesh(G.antenna, GUNMETAL);
    antL.position.set(-1.1, 0.9, -1.1);
    const ventA = new THREE.Mesh(G.vent, GUNMETAL);
    ventA.position.set(-0.8, 0.95, 0.9);
    b1.castShadow = b2.castShadow = tower.castShadow = true;
    built.add(b1, trim, b2, shoulder, tower, towerBand, pole, dish, pad, padRing, antL, ventA);
    lampAt(1.25, 0.95, 1.25); lampAt(-1.25, 0.95, 1.25);
    lampAt(1.25, 0.95, -1.25); lampAt(-1.25, 0.95, -1.25);
    anim.dish = dish;
  } else if (e.type === "depot") {
    // supply silo: squat dark base, a glowing status band, a domed team-color
    // storage cap with rivets, and a vent stack.
    const b1 = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 1.7), base);
    b1.position.y = 0.28;
    const band = new THREE.Mesh(new THREE.BoxGeometry(1.74, 0.12, 1.74), glow);
    band.position.y = 0.58;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.3, 1.4), team);
    roof.position.y = 0.8;
    // low storage dome caps the depot (rounder read)
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.62, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), team);
    dome.scale.y = 0.6;
    dome.position.y = 0.94;
    const vent = new THREE.Mesh(G.vent, GUNMETAL);
    vent.position.set(0.42, 1.05, 0.42);
    // corner rivets / bumpers for scale
    for (const [rx, rz] of [[0.72, 0.72], [-0.72, 0.72], [0.72, -0.72], [-0.72, -0.72]]) {
      const r = new THREE.Mesh(G.lamp, GUNMETAL);
      r.scale.setScalar(1.4);
      r.position.set(rx, 0.28, rz);
      built.add(r);
    }
    b1.castShadow = roof.castShadow = true;
    built.add(b1, band, roof, dome, vent);
    anim.band = band;
  } else if (e.type === "refinery") {
    // gas extractor sitting ON the geyser: a squat industrial base skirt, a
    // capping dome, a glowing green intake ring, side extraction pipes with
    // tanks, and a short exhaust stack.
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.0, 0.24, 14), base);
    skirt.position.y = 0.12;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.82, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), base);
    dome.position.y = 0.2;
    dome.scale.y = 0.8;
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 0.3, 14), team);
    collar.position.y = 0.62;
    // green emissive intake ring (pulses while harvesting) over the throat
    const intakeMat = glowMat(0x7cd94f, 0.9);
    const intake = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.08, 10, 22), intakeMat);
    intake.rotation.x = Math.PI / 2;
    intake.position.y = 0.78;
    // extraction pipes flowing into side storage tanks
    const pipeGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.72, 10);
    const pipeL = new THREE.Mesh(pipeGeo, GUNMETAL);
    pipeL.position.set(0.75, 0.4, 0.2); pipeL.rotation.z = 0.3;
    const pipeR = pipeL.clone();
    pipeR.position.set(-0.75, 0.4, -0.2); pipeR.rotation.z = -0.3;
    const tankL = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.5, 12), team);
    tankL.position.set(0.92, 0.55, 0.2);
    const tankCapL = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), GUNMETAL);
    tankCapL.position.set(0.92, 0.8, 0.2);
    const tankR = tankL.clone(); tankR.position.set(-0.92, 0.55, -0.2);
    const tankCapR = tankCapL.clone(); tankCapR.position.set(-0.92, 0.8, -0.2);
    const stack = new THREE.Mesh(G.vent, GUNMETAL);
    stack.position.set(0.1, 0.95, -0.55);
    dome.castShadow = true;
    built.add(skirt, dome, collar, intake, pipeL, pipeR, tankL, tankCapL, tankR, tankCapR, stack);
    lampAt(0.95, 0.14, 0.95); lampAt(-0.95, 0.14, -0.95);
    anim.intake = intake; anim.intakeMat = intakeMat;
  } else if (e.type === "factory") {
    // wide heavy plant: stepped-roofline block, side ventilation stacks, huge
    // rolling door, short smokestack. Less shoebox — the roof steps back.
    const b1 = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.95, 2.3), base);
    b1.position.y = 0.48;
    // stepped upper storey (narrower, set back) breaks the box silhouette
    const step = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.5, 1.7), base);
    step.position.set(0, 1.12, -0.18);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.22, 1.55), GUNMETAL);
    roof.position.set(0, 1.45, -0.18);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(2.74, 0.12, 2.34), team);
    trim.position.y = 0.9;
    // side ventilation stacks (ribbed cylinders) on the flanks
    const ventGeo = new THREE.CylinderGeometry(0.16, 0.18, 0.7, 10);
    const ventL = new THREE.Mesh(ventGeo, GUNMETAL);
    ventL.position.set(1.15, 1.15, 0.55);
    const ventCapL = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.16, 0.1, 10), TRIM);
    ventCapL.position.set(1.15, 1.52, 0.55);
    const ventL2 = new THREE.Mesh(ventGeo, GUNMETAL);
    ventL2.position.set(1.15, 1.15, 0.05);
    const ventCapL2 = ventCapL.clone(); ventCapL2.position.set(1.15, 1.52, 0.05);
    // coolant pipe running along the flank (greeble)
    const flankPipe = new THREE.Mesh(G.pipe, TRIM);
    flankPipe.rotation.x = Math.PI / 2;
    flankPipe.position.set(-1.36, 0.7, 0.1);
    built.add(ventCapL, ventCapL2, flankPipe);
    // louvered side panel (team) for detail
    const louver = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 1.4), team);
    louver.position.set(1.37, 0.55, -0.2);
    // huge front rolling door: dark panel with team trim
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 0.1), DARK);
    door.position.set(0, 0.46, 1.16);
    const doorTrim = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.9, 0.06), team);
    doorTrim.position.set(0, 0.48, 1.13);
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.9, 10), GUNMETAL);
    stack.position.set(-0.85, 1.55, -0.7);
    // ember glow at the stack tip (lit while queue non-empty)
    const emberMat = glowMat(0xff7a2a, 0.2);
    const ember = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 10), emberMat);
    ember.position.set(-0.85, 2.03, -0.7);
    b1.castShadow = step.castShadow = roof.castShadow = true;
    built.add(b1, step, roof, trim, ventL, ventL2, louver, door, doorTrim, stack, ember);
    lampAt(1.25, 0.98, 1.1); lampAt(-1.25, 0.98, 1.1);
    anim.stackTip = ember; anim.emberMat = emberMat;
  } else if (e.type === "starport") {
    // flat landing pad on pylons + corner lights + rotating radar beacon.
    // thinner + larger pad reads more like a helipad than a drum.
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.62, 1.62, 0.14, 24), base);
    pad.position.y = 0.78;
    pad.castShadow = true;
    // glowing pad edge (pulses while training)
    const edgeMat = glowMat(color, 0.5);
    const edge = new THREE.Mesh(new THREE.TorusGeometry(1.56, 0.07, 8, 36), edgeMat);
    edge.rotation.x = Math.PI / 2;
    edge.position.y = 0.86;
    const pylonGeo = new THREE.CylinderGeometry(0.14, 0.18, 0.75, 10);
    for (const [px, pz] of [[1.0, 1.0], [-1.0, 1.0], [1.0, -1.0], [-1.0, -1.0]]) {
      const py = new THREE.Mesh(pylonGeo, GUNMETAL);
      py.position.set(px, 0.37, pz);
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.12, 10), DARK);
      foot.position.set(px, 0.06, pz);
      built.add(py, foot);
    }
    // landing-pad marker lights ringing the deck (green guidance)
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const mk = new THREE.Mesh(G.lamp, glowMat(0x7cd94f, 1.3));
      mk.scale.setScalar(0.7);
      mk.position.set(Math.cos(a) * 1.35, 0.87, Math.sin(a) * 1.35);
      built.add(mk);
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
    const podCheek = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.62, 10), team);
    podCheek.rotation.z = Math.PI / 2;
    podCheek.position.z = -0.02;               // rounded rear of the pod
    // sensor eye between the barrels
    const sensor = new THREE.Mesh(G.droneEye, glowMat(0xff5f4c, 1.6));
    sensor.scale.set(1.4, 0.8, 1);
    sensor.position.set(0, 0.06, 0.22);
    const barrelGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.75, 10).rotateX(Math.PI / 2).translate(0, 0, 0.38);
    const barrels = new THREE.Group();
    const bL = new THREE.Mesh(barrelGeo, GUNMETAL); bL.position.x = 0.16;
    const bR = new THREE.Mesh(barrelGeo, GUNMETAL); bR.position.x = -0.16;
    const tipL = new THREE.Mesh(G.tankMuzzle, glow); tipL.scale.setScalar(0.55); tipL.position.set(0.16, 0, 0.72);
    const tipR = tipL.clone(); tipR.position.x = -0.16;
    barrels.add(bL, bR, tipL, tipR);
    pod.add(podBox, podCheek, sensor, barrels);
    pod.position.y = 1.0;
    built.add(skirt, column, band, pod);
    anim.pod = pod; anim.podBarrels = barrels; anim.barrelHome = 0;
  } else { // barracks — infantry training block: dark hall, team roof cap, big
    // lit bay door with a frame, a comms mast and a rooftop vent.
    const b1 = new THREE.Mesh(new THREE.BoxGeometry(2.5, 1.15, 2.1), base);
    b1.position.y = 0.58;
    const trim = new THREE.Mesh(new THREE.BoxGeometry(2.54, 0.12, 2.14), team);
    trim.position.y = 1.02;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.25, 2.3), team);
    roof.position.y = 1.28;
    roof.rotation.z = 0.06;
    // recessed door surround (dark) + glowing bay door
    const surround = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.0, 0.1), DARK);
    surround.position.set(0, 0.5, 1.02);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.8, 0.08), glow);
    door.position.set(0, 0.42, 1.06);
    const pole = new THREE.Mesh(G.pole, GUNMETAL);
    pole.position.set(-1.0, 1.9, -0.8);
    const vent = new THREE.Mesh(G.vent, GUNMETAL);
    vent.position.set(0.85, 1.5, -0.7);
    b1.castShadow = roof.castShadow = true;
    built.add(b1, trim, roof, surround, door, pole, vent);
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
