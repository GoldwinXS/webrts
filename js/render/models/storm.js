// Model definitions — THE TEMPEST: living lightning wearing hovering empty
// armor. This file is ADDITIVE — it never touches the Cog or Ooze models. It
// registers real builders for all 15 Tempest types (7 units + 8 buildings)
// under their exact data.js keys, bypassing registry.js's placeholders.
//
// FAMILY DNA — shared across every unit AND building so the faction reads as
// ONE civilization, distinct from tin-toy Cogs and jelly Ooze:
//   1. NO BODIES. Units are floating armor pieces (pauldrons, plates, rings)
//      arranged around a blinding white-cyan CORE with visible gaps between
//      them — you can see there is nothing inside but light.
//   2. Every armor piece bobs on its own sin phase (addFloat/floatPieces) so
//      the shell feels loosely held together by magnetism, not welded.
//   3. Palette: storm-slate armor (slightly blue, dark enough to contrast
//      the glow from the top-down camera), darker gunmetal undersides, TEAM
//      COLOR as trim rings/edging with at least one top-facing team element
//      per unit (the Cogs' visor rule, aimed at the sky), white-cyan emissive
//      cores + halo rings that read from above + small cyan spark nodes.
//   4. Buildings are crystalline monoliths: angular obelisks/prisms (boxes
//      rotated 45°, 4-sided cones) with emissive seams and floating shard
//      halos that orbit slowly overhead.
//   5. Where Cogs glow amber and Ooze glows bile-green, the Tempest glows
//      white-cyan (CORE_WHITE / SPARK).
//
// Contract (identical to the other families):
//   * Units: build(e,color) -> Group with userData.body + userData.anim{kind};
//     animate(g,e,t,move,a) drives hover/idle motion. The renderer yaws
//     userData.body and sets anim.recoil=0.08 on fire.
//   * Buildings: build(e,color,size) -> wrapBuilding(built,size,SCAFFOLD,G)
//     with userData.anim + userData.mats for the damage flash; addLamp pips.
//   * tesla mirrors the Cog turret contract: anim.pod (yawed toward
//     userData.aimYaw by its own animate) + anim.podBarrels + anim.recoil.
//   * extractor reads g.userData.harvesting (renderer sets it like refinery).

import * as THREE from "three";
import { ModelBuilder, part, wrapBuilding } from "./parts.js";
import { registerUnit, registerBuilding, addLamp } from "./registry.js";
import { G, SCAFFOLD, toonGradient, teamMat, glowMat } from "./core.js";

// ---------------------------------------------------------------------------
// Shared palette. Opaque family materials are module-scope singletons (like
// OOZE_PURPLE); per-instance factories below feed the damage flash.
// ---------------------------------------------------------------------------
const STORM_STEEL = new THREE.MeshToonMaterial({ color: 0x59616e, gradientMap: toonGradient() }); // building gunmetal
const STORM_DARK  = new THREE.MeshToonMaterial({ color: 0x454c58, gradientMap: toonGradient() }); // dark unit undersides
const CORE_WHITE = 0xeafcff;   // the blinding inner-lightning core
const SPARK      = 0x8fe8ff;   // small cyan emissive nodes / lamps

// Per-instance storm-slate armor. Dark enough that the white-cyan core and
// halo CONTRAST from the top-down game camera (pale silver washed out to
// near-white on green). Faint emissive so the renderer's damage flash
// (userData.mats) lights the shell up. DoubleSide so open pauldron shells
// read from underneath (they float — you see inside).
function armorMat(opacity) {
  const m = new THREE.MeshToonMaterial({
    color: 0x6d7889, gradientMap: toonGradient(),
    emissive: 0x39424f, emissiveIntensity: 0.1,
    side: THREE.DoubleSide,
  });
  if (opacity !== undefined) { m.transparent = true; m.opacity = opacity; }
  return m;
}

// Per-instance pale crystal for buildings (opaque — the construction-site
// opacity fade forces materials back to opaque on completion).
function crystalMat() {
  return new THREE.MeshToonMaterial({
    color: 0xb9cddf, gradientMap: toonGradient(),
    emissive: 0x7fa9c8, emissiveIntensity: 0.14,
  });
}

// ---------------------------------------------------------------------------
// Shared geometry — created ONCE at module scope, reused by every instance.
// ---------------------------------------------------------------------------
const SG = {
  core:     new THREE.SphereGeometry(0.12, 14, 12),      // blinding core (scaled per unit)
  node:     new THREE.SphereGeometry(0.045, 8, 6),       // small emissive spark node
  pauldron: new THREE.SphereGeometry(0.2, 12, 9, 0, Math.PI * 2, 0, Math.PI * 0.42), // open shell cap
  plate:    new THREE.BoxGeometry(0.2, 0.26, 0.06),      // chest / side armor plate
  plateSm:  new THREE.BoxGeometry(0.12, 0.16, 0.045),
  ring:     new THREE.TorusGeometry(0.26, 0.05, 8, 22),  // armor ring / torus band
  trim:     new THREE.TorusGeometry(0.2, 0.016, 6, 18),  // thin TEAM trim edging
  blade:    new THREE.BoxGeometry(0.05, 0.55, 0.05),     // volt's lightning blade
  shard:    new THREE.OctahedronGeometry(0.12),          // carried crystal
  disc:     new THREE.CylinderGeometry(0.3, 0.34, 0.055, 10), // sentinel shield disc
  wing:     new THREE.BoxGeometry(0.62, 0.035, 0.18),    // zephyr wing blade
  fin:      new THREE.BoxGeometry(0.035, 0.2, 0.3),
  spike:    new THREE.ConeGeometry(0.035, 0.16, 6),      // fulminar crown spike
  prong:    new THREE.BoxGeometry(0.05, 0.05, 0.34).translate(0, 0, 0.17), // tesla fork tine
  trimFat:  new THREE.TorusGeometry(0.2, 0.035, 6, 22),  // fat team band — reads from above
  glowRing: new THREE.TorusGeometry(0.15, 0.028, 6, 20), // white-cyan core halo — reads from above
  finTop:   new THREE.BoxGeometry(0.08, 0.03, 0.24),     // team top fin — reads from above
  // buildings
  plinth:   new THREE.CylinderGeometry(0.92, 1.05, 0.24, 8), // octagonal base slab
  monoBox:  new THREE.BoxGeometry(1, 1, 1),              // rot-45 obelisk block (scaled)
  prism:    new THREE.ConeGeometry(0.5, 1, 4),           // 4-sided crystal prism (scaled)
  column:   new THREE.CylinderGeometry(0.14, 0.34, 1, 6),// tapering crystal column
  orb:      new THREE.SphereGeometry(0.24, 16, 12),      // glowing building orb
  haloRing: new THREE.TorusGeometry(0.6, 0.05, 8, 28),   // big monolith ring
  seam:     new THREE.BoxGeometry(0.04, 1, 0.04),        // emissive seam strip (scale y)
  shardBig: new THREE.OctahedronGeometry(0.2),           // orbiting monolith shard
};

// ---------------------------------------------------------------------------
// Magnetic-hover helpers: each armor piece registers a float entry, then
// floatPieces() bobs every piece on its own phase so the shell feels loose.
// Deterministic (uses t + e.id). rateMul lets the phantom speed up while phased.
// ---------------------------------------------------------------------------
function addFloat(anim, obj, ph, amp = 0.03, rate = 2.3) {
  if (!anim.float) anim.float = [];
  anim.float.push({ o: obj, y0: obj.position.y, ph, amp, rate });
}
function floatPieces(a, t, id, rateMul = 1) {
  if (!a.float) return;
  for (const f of a.float) {
    f.o.position.y = f.y0 + Math.sin(t * f.rate * rateMul + id + f.ph) * f.amp;
  }
}

// A floating pauldron shell with a thin team-trim ring hugging its rim.
// Returned as a group so it can be positioned/rotated (and floated) as one.
function pauldron(mat, trimMaterial, s = 1) {
  const grp = new THREE.Group();
  const shell = new THREE.Mesh(SG.pauldron, mat);
  shell.castShadow = true;
  const rim = new THREE.Mesh(SG.trim, trimMaterial);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.04;
  rim.scale.setScalar(0.95);
  grp.add(shell, rim);
  grp.scale.setScalar(s);
  return grp;
}

// ===========================================================================
// UNITS — no legs, no bodies. Armor around light.
// ===========================================================================

// ---------------------------------------------------------------------------
// ION ("Ion") — worker. The smallest spark: a bare core wearing one hood
// pauldron and a single tilted armor ring, with a thin team trim ring riding
// the armor ring. Carries a glowing crystal shard tucked under the core.
// ---------------------------------------------------------------------------
registerUnit("ion", {
  build(e, color) {
    const armor = armorMat();
    const trim = teamMat(color, 0.6);
    const coreMat = glowMat(CORE_WHITE, 1.8);
    const m = new ModelBuilder();
    m.addMat(armor);

    m.add(part(SG.core, coreMat).scl(1.0), "core");
    // white-cyan halo ring at core height — the glow that reads from above,
    // peeking out past the hood rim
    const halo = part(SG.glowRing, glowMat(CORE_WHITE, 1.6)).rot(Math.PI / 2, 0, 0).pos(0, 0.09, 0).scl(1.3);
    m.add(halo, "halo");

    // single hood pauldron floating over the core (small so the halo shows)
    const hood = pauldron(armor, trim, 0.85);
    hood.position.set(0, 0.2, -0.01);
    hood.rotation.x = -0.15;
    m.addGroup(hood, "hood");
    // team cap dot riding the hood crown — the top-facing team read
    const teamCap = part(SG.node, trim).pos(0, 0.36, -0.01).scl(2.0, 1.0, 2.0);
    m.add(teamCap, "teamCap");

    // one tilted armor ring around the waist of the light + its team trim
    const ring = part(SG.ring, armor).rot(Math.PI / 2 - 0.35, 0, 0).pos(0, -0.05, 0).scl(0.95).shadow();
    m.add(ring, "ring");
    const ringTrim = part(SG.trim, trim).rot(Math.PI / 2 - 0.35, 0, 0).pos(0, -0.085, 0).scl(1.15);
    m.add(ringTrim, "ringTrim");

    // dark underside dish + spark nodes drifting in the gaps
    m.add(part(SG.disc, STORM_DARK).pos(0, -0.16, 0).scl(0.45, 0.5, 0.45));
    m.add(part(SG.node, glowMat(SPARK, 1.9)).pos(0, 0.02, 0.16));
    m.add(part(SG.node, glowMat(SPARK, 1.6)).pos(-0.05, 0.06, -0.15).scl(0.8));

    // hauled crystal, tucked under the core (hidden unless carrying)
    const carry = part(SG.shard, glowMat(SPARK, 1.4)).pos(0, -0.15, 0.1).scl(0.8).visible(false);
    m.add(carry, "carry");

    m.body.scale.setScalar(1.45);    // chibi-match the Cog worker's presence
    m.body.position.y = 0.48;
    const anim = { kind: "ion", coreMat, carry: carry.mesh };
    addFloat(anim, hood, 0, 0.035, 2.2);
    addFloat(anim, teamCap.mesh, 0, 0.035, 2.2);      // rides the hood
    addFloat(anim, halo.mesh, 1.1, 0.02, 2.9);
    addFloat(anim, ring.mesh, 2.1, 0.028, 2.6);
    addFloat(anim, ringTrim.mesh, 2.1, 0.028, 2.6);   // same phase: rides the ring
    m.setAnim(anim);
    return m.build();
  },

  animate(g, e, t, move, a) {
    g.userData.body.position.y = 0.48 + Math.sin(t * 2.6 + e.id) * 0.055 + move * 0.04;
    g.userData.body.rotation.x = move * 0.12;      // hover-lean into travel
    floatPieces(a, t, e.id);

    // core flares by task: frantic while mining, steady while building
    const kind = e.order?.kind;
    const mining = kind === "gather" && e.order?.phase === "mining";
    a.coreMat.emissiveIntensity = mining
      ? 2.2 + Math.sin(t * 14 + e.id) * 0.7
      : kind === "build" ? 1.9 + Math.sin(t * 8 + e.id) * 0.5
      : 1.7 + Math.sin(t * 3 + e.id) * 0.25;

    a.carry.visible = e.carry > 0;
    if (e.carry > 0) a.carry.rotation.y = t * 3;
  },
});

// ---------------------------------------------------------------------------
// VOLT ("Volt") — melee blade of lightning. Two shoulder pauldrons + chest
// plate around the core, a tiny helm cap above, and a floating BLADE of pure
// lightning hovering at its right side that chops forward on hit.
// ---------------------------------------------------------------------------
registerUnit("volt", {
  build(e, color) {
    const armor = armorMat();
    const trim = teamMat(color, 0.6);
    const coreMat = glowMat(CORE_WHITE, 1.9);
    const m = new ModelBuilder();
    m.addMat(armor);

    m.add(part(SG.core, coreMat).pos(0, 0.02, 0).scl(1.1), "core");
    // core halo — top-down glow read between the pauldrons
    const halo = part(SG.glowRing, glowMat(CORE_WHITE, 1.5)).rot(Math.PI / 2, 0, 0).pos(0, 0.1, 0).scl(1.25);
    m.add(halo, "halo");

    // chest plate floating in front, dark back plate behind — gaps between
    const chest = part(SG.plate, armor).pos(0, 0.03, 0.16).rot(-0.12, 0, 0).shadow();
    m.add(chest, "chest");
    const back = part(SG.plateSm, STORM_DARK).pos(0, 0.0, -0.17).rot(0.15, 0, 0);
    m.add(back, "back");

    // shoulder pauldrons (trim-rimmed), tipped outward
    const pL = pauldron(armor, trim, 0.95); pL.position.set(0.22, 0.2, 0); pL.rotation.z = -0.55;
    const pR = pauldron(armor, trim, 0.95); pR.position.set(-0.22, 0.2, 0); pR.rotation.z = 0.55;
    m.addGroup(pL, "pL"); m.addGroup(pR, "pR");

    // helm cap crowned by a TEAM fin (the top-facing team read) + eye spark
    const helm = pauldron(armor, trim, 0.6); helm.position.set(0, 0.36, 0);
    m.addGroup(helm, "helm");
    const fin = part(SG.finTop, trim).pos(0, 0.47, 0);
    m.add(fin, "fin");
    m.add(part(SG.node, glowMat(SPARK, 2.0)).pos(0, 0.3, 0.1).scl(0.9));

    // waist trim ring + dark keel plate low in the gap
    m.add(part(SG.trim, trim).rot(Math.PI / 2, 0, 0).pos(0, -0.13, 0).scl(1.0));
    const keel = part(SG.plateSm, STORM_DARK).pos(0, -0.23, 0.02).rot(Math.PI / 2, 0, 0).scl(1.1, 1.1, 1);
    m.add(keel, "keel");

    // THE BLADE: a bar of lightning hovering at the right hip, hilt-trimmed
    const bladeGrp = new THREE.Group();
    const bladeMat = glowMat(0x9ff1ff, 2.2);
    const blade = new THREE.Mesh(SG.blade, bladeMat);
    blade.position.y = 0.1;
    const hilt = new THREE.Mesh(SG.node, teamMat(color, 1.0));
    hilt.position.y = -0.2; hilt.scale.setScalar(1.3);
    bladeGrp.add(blade, hilt);
    bladeGrp.position.set(0.32, 0.0, 0.06);
    bladeGrp.rotation.z = -0.15;
    m.addGroup(bladeGrp, "bladeGrp");

    m.body.scale.setScalar(1.5);     // marine-class presence at gameplay zoom
    m.body.position.y = 0.55;
    const anim = { kind: "volt", coreMat, bladeMat, bladeGrp, recoil: 0 };
    addFloat(anim, chest.mesh, 0.6, 0.03, 2.5);
    addFloat(anim, back.mesh, 2.9, 0.03, 2.2);
    addFloat(anim, halo.mesh, 1.7, 0.02, 2.9);
    addFloat(anim, pL, 1.3, 0.035, 2.4);
    addFloat(anim, pR, 4.2, 0.035, 2.4);
    addFloat(anim, helm, 3.5, 0.03, 2.0);
    addFloat(anim, fin.mesh, 3.5, 0.03, 2.0);         // rides the helm
    addFloat(anim, keel.mesh, 5.1, 0.025, 2.7);
    addFloat(anim, bladeGrp, 1.0, 0.045, 3.0);
    m.setAnim(anim);
    return m.build();
  },

  animate(g, e, t, move, a) {
    g.userData.body.position.y = 0.55 + Math.sin(t * 2.4 + e.id) * 0.06 + move * 0.045;
    g.userData.body.rotation.x = move * 0.12;
    floatPieces(a, t, e.id);
    // idle blade hum; forward chop on hit (renderer sets recoil=0.08)
    a.bladeGrp.rotation.y = Math.sin(t * 1.5 + e.id) * 0.25;
    if (a.recoil > 0) {
      a.recoil = Math.max(0, a.recoil - 0.5 / 60);
      a.bladeGrp.rotation.x = -a.recoil * 14;          // slash arc
      a.bladeMat.emissiveIntensity = 2.2 + a.recoil * 18;
      a.coreMat.emissiveIntensity = 1.9 + a.recoil * 10;
    } else {
      a.bladeGrp.rotation.x += (0 - a.bladeGrp.rotation.x) * 0.2;
      a.bladeMat.emissiveIntensity = 2.0 + Math.sin(t * 6 + e.id) * 0.3;
      a.coreMat.emissiveIntensity = 1.8 + Math.sin(t * 3 + e.id) * 0.25;
    }
  },
});

// ---------------------------------------------------------------------------
// ARC ("Arc") — chain-lightning skirmisher. A floating armor torus around the
// core with 3 spark nodes orbiting in the gap, capped by a small pauldron.
// The ring flares when the chain fires.
// ---------------------------------------------------------------------------
registerUnit("arc", {
  build(e, color) {
    const armor = armorMat();
    const trim = teamMat(color, 0.6);
    const coreMat = glowMat(CORE_WHITE, 2.0);
    const m = new ModelBuilder();
    m.addMat(armor);

    m.add(part(SG.core, coreMat).scl(1.15), "core");
    // core halo above the ring plane — top-down glow read (cap is small so it shows)
    const halo = part(SG.glowRing, glowMat(CORE_WHITE, 1.6)).rot(Math.PI / 2, 0, 0).pos(0, 0.13, 0).scl(0.9);
    m.add(halo, "halo");

    // the signature horizontal armor ring + FAT team band riding outside it
    // (the band sits proud of the armor ring so it reads from straight above)
    const ring = part(SG.ring, armor).rot(Math.PI / 2, 0, 0).pos(0, 0.02, 0).scl(1.1).shadow();
    m.add(ring, "ring");
    const ringTrim = part(SG.trimFat, trim).rot(Math.PI / 2, 0, 0).pos(0, -0.06, 0).scl(1.35);
    m.add(ringTrim, "ringTrim");

    // small cap pauldron above, dark dish below — core visible through gaps
    const cap = pauldron(armor, trim, 0.55); cap.position.set(0, 0.32, 0);
    m.addGroup(cap, "cap");
    const capSpark = part(SG.node, glowMat(SPARK, 2.0)).pos(0, 0.44, 0).scl(1.1);
    m.add(capSpark, "capSpark");
    const dish = part(SG.disc, STORM_DARK).pos(0, -0.22, 0).scl(0.55, 0.5, 0.55);
    m.add(dish, "dish");

    // 3 spark nodes orbiting between core and ring
    const orbit = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2;
      const n = new THREE.Mesh(SG.node, glowMat(SPARK, 2.2));
      n.position.set(Math.cos(ang) * 0.3, 0.02, Math.sin(ang) * 0.3);
      n.scale.setScalar(1.1);
      orbit.add(n);
    }
    m.addGroup(orbit, "orbit");

    m.body.scale.setScalar(1.5);     // marine-class presence at gameplay zoom
    m.body.position.y = 0.52;
    const anim = { kind: "arc", coreMat, orbit, ringMesh: ring.mesh, recoil: 0 };
    addFloat(anim, ring.mesh, 0, 0.03, 2.4);
    addFloat(anim, ringTrim.mesh, 0, 0.03, 2.4);
    addFloat(anim, halo.mesh, 1.2, 0.02, 2.9);
    addFloat(anim, cap, 2.2, 0.035, 2.1);
    addFloat(anim, capSpark.mesh, 2.2, 0.035, 2.1);   // rides the cap
    addFloat(anim, dish.mesh, 4.0, 0.025, 2.6);
    m.setAnim(anim);
    return m.build();
  },

  animate(g, e, t, move, a) {
    g.userData.body.position.y = 0.52 + Math.sin(t * 2.5 + e.id) * 0.06 + move * 0.04;
    g.userData.body.rotation.x = move * 0.12;
    floatPieces(a, t, e.id);
    a.orbit.rotation.y = t * 3.2 + e.id;
    if (a.recoil > 0) {
      a.recoil = Math.max(0, a.recoil - 0.6 / 60);
      a.coreMat.emissiveIntensity = 2.0 + a.recoil * 14;
      a.ringMesh.scale.setScalar(1.1 * (1 + a.recoil * 3));
    } else {
      a.coreMat.emissiveIntensity = 1.9 + Math.sin(t * 3.4 + e.id) * 0.3;
      a.ringMesh.scale.setScalar(1.1);
    }
  },
});

// ---------------------------------------------------------------------------
// SENTINEL ("Sentinel") — bulky shield-caster. Wide flat shield-discs float
// above and below a caged lantern core (four bar plates around the light),
// flanked by side plates. Reads heavier and slower than the rest.
// ---------------------------------------------------------------------------
registerUnit("sentinel", {
  build(e, color) {
    const armor = armorMat();
    const trim = teamMat(color, 0.6);
    const coreMat = glowMat(0xf2f8ff, 1.9);
    const m = new ModelBuilder();
    m.addMat(armor);

    // lantern: a fat core inside four vertical cage bars
    m.add(part(SG.core, coreMat).pos(0, 0.05, 0).scl(1.6), "core");
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
      m.add(part(SG.plateSm, STORM_DARK)
        .pos(Math.cos(ang) * 0.17, 0.05, Math.sin(ang) * 0.17)
        .rot(0, -ang, 0).scl(0.5, 1.5, 0.6));
    }

    // wide shield-discs above and below; a FAT team band rides the top disc
    // edge and a glow chimney ring floats over its center — both top reads
    const discB = part(SG.disc, armor).pos(0, -0.22, 0).scl(1.2, 1, 1.2).shadow();
    m.add(discB, "discB");
    const discBu = part(SG.disc, STORM_DARK).pos(0, -0.27, 0).scl(1.05, 0.6, 1.05);
    m.add(discBu, "discBu");
    const discT = part(SG.disc, armor).pos(0, 0.32, 0).scl(0.92, 1, 0.92).shadow();
    m.add(discT, "discT");
    const trimB = part(SG.trim, trim).rot(Math.PI / 2, 0, 0).pos(0, -0.185, 0).scl(1.85);
    m.add(trimB, "trimB");
    const trimT = part(SG.trimFat, trim).rot(Math.PI / 2, 0, 0).pos(0, 0.36, 0).scl(1.35);
    m.add(trimT, "trimT");
    const chimney = part(SG.glowRing, glowMat(CORE_WHITE, 1.6)).rot(Math.PI / 2, 0, 0).pos(0, 0.42, 0).scl(0.9);
    m.add(chimney, "chimney");

    // flanking side plates facing outward
    const sL = part(SG.plate, armor).pos(0.34, 0.05, 0).rot(0, Math.PI / 2, -0.2).shadow();
    const sR = part(SG.plate, armor).pos(-0.34, 0.05, 0).rot(0, -Math.PI / 2, 0.2).shadow();
    m.add(sL, "sL"); m.add(sR, "sR");

    // spark nodes on the lower disc rim
    m.add(part(SG.node, glowMat(SPARK, 1.8)).pos(0.25, -0.15, 0.25).scl(0.9));
    m.add(part(SG.node, glowMat(SPARK, 1.8)).pos(-0.25, -0.15, 0.25).scl(0.9));
    m.add(part(SG.node, glowMat(SPARK, 1.6)).pos(0, -0.15, -0.34).scl(0.8));

    m.body.scale.setScalar(1.45);    // bulky mid-tier read
    m.body.position.y = 0.55;
    const anim = { kind: "sentinel", coreMat, recoil: 0 };
    addFloat(anim, discB.mesh, 0, 0.03, 1.8);
    addFloat(anim, discBu.mesh, 0, 0.03, 1.8);
    addFloat(anim, trimB.mesh, 0, 0.03, 1.8);
    addFloat(anim, discT.mesh, Math.PI, 0.035, 1.8);   // counter-phase to the bottom
    addFloat(anim, trimT.mesh, Math.PI, 0.035, 1.8);
    addFloat(anim, chimney.mesh, Math.PI + 0.8, 0.03, 2.2);
    addFloat(anim, sL.mesh, 1.4, 0.04, 2.1);
    addFloat(anim, sR.mesh, 4.5, 0.04, 2.1);
    m.setAnim(anim);
    return m.build();
  },

  animate(g, e, t, move, a) {
    g.userData.body.position.y = 0.55 + Math.sin(t * 1.9 + e.id) * 0.05 + move * 0.03;
    g.userData.body.rotation.x = move * 0.08;
    floatPieces(a, t, e.id);
    // lantern flicker: slow swell + fast shimmer
    let glow = 1.7 + Math.sin(t * 2.1 + e.id) * 0.3 + Math.sin(t * 7.3 + e.id) * 0.12;
    if (a.recoil > 0) {
      a.recoil = Math.max(0, a.recoil - 0.7 / 60);
      glow += a.recoil * 12;
    }
    a.coreMat.emissiveIntensity = glow;
  },
});

// ---------------------------------------------------------------------------
// PHANTOM ("Phantom") — phase harasser. Sleek angular armor (swept side
// blades, a forward chest prism, a tall head shard) in a semi-transparent
// per-instance shell. While e.phased the armor drops to ghost opacity and
// every piece bobs almost twice as fast.
// ---------------------------------------------------------------------------
registerUnit("phantom", {
  build(e, color) {
    const ph = armorMat(0.85);     // per-instance translucent armor
    const trim = teamMat(color, 0.6);
    const coreMat = glowMat(CORE_WHITE, 1.8);
    const m = new ModelBuilder();
    m.addMat(ph);

    m.add(part(SG.core, coreMat).pos(0, 0.06, 0).scl(0.95), "core");
    // core halo — the top-down glow read between the swept blades
    const halo = part(SG.glowRing, glowMat(CORE_WHITE, 1.5)).rot(Math.PI / 2, 0, 0).pos(0, 0.13, 0).scl(1.0);
    m.add(halo, "halo");

    // forward chest prism (apex points +z after the x-rotation)
    const chest = part(SG.prism, ph).pos(0, 0.06, 0.16).rot(Math.PI / 2, 0, 0).scl(0.4, 0.5, 0.4).shadow();
    m.add(chest, "chest");

    // swept angular side blades
    const bL = part(SG.plate, ph).pos(0.18, 0.07, -0.04).rot(0, -0.55, 0.15).scl(0.75, 1.3, 0.7).shadow();
    const bR = part(SG.plate, ph).pos(-0.18, 0.07, -0.04).rot(0, 0.55, -0.15).scl(0.75, 1.3, 0.7).shadow();
    m.add(bL, "bL"); m.add(bR, "bR");

    // tall head shard hovering above the light, crowned by a TEAM fin
    const head = part(SG.shard, ph).pos(0, 0.4, 0.02).scl(0.7, 1.35, 0.7);
    m.add(head, "head");
    const fin = part(SG.finTop, trim).pos(0, 0.6, 0.02);
    m.add(fin, "fin");

    // hip trim ring + trailing spark nodes on the blade tips
    m.add(part(SG.trim, trim).rot(Math.PI / 2, 0, 0).pos(0, -0.12, 0).scl(0.95));
    m.add(part(SG.node, glowMat(SPARK, 1.8)).pos(0.22, -0.05, -0.16).scl(0.8));
    m.add(part(SG.node, glowMat(SPARK, 1.8)).pos(-0.22, -0.05, -0.16).scl(0.8));

    m.body.scale.setScalar(1.5);     // marine-class presence at gameplay zoom
    m.body.position.y = 0.55;
    const anim = { kind: "phantom", coreMat, ph, recoil: 0 };
    addFloat(anim, chest.mesh, 0, 0.035, 2.4);
    addFloat(anim, halo.mesh, 0.9, 0.02, 2.9);
    addFloat(anim, bL.mesh, 1.6, 0.04, 2.6);
    addFloat(anim, bR.mesh, 4.3, 0.04, 2.6);
    addFloat(anim, head.mesh, 2.8, 0.045, 2.2);
    addFloat(anim, fin.mesh, 2.8, 0.045, 2.2);        // rides the head shard
    m.setAnim(anim);
    return m.build();
  },

  animate(g, e, t, move, a) {
    const phased = !!e.phased;
    // armor fades toward ghost opacity while phased, back to solid otherwise
    a.ph.opacity += ((phased ? 0.3 : 0.85) - a.ph.opacity) * 0.12;
    floatPieces(a, t, e.id, phased ? 1.9 : 1);
    g.userData.body.position.y = 0.55
      + Math.sin(t * (phased ? 4.6 : 2.4) + e.id) * (phased ? 0.09 : 0.055)
      + move * 0.04;
    g.userData.body.rotation.x = move * 0.12;
    let glow = (phased ? 2.4 : 1.8) + Math.sin(t * (phased ? 8 : 3) + e.id) * 0.3;
    if (a.recoil > 0) {
      a.recoil = Math.max(0, a.recoil - 0.5 / 60);
      glow += a.recoil * 12;
    }
    a.coreMat.emissiveIntensity = glow;
  },
});

// ---------------------------------------------------------------------------
// ZEPHYR ("Zephyr") — flyer. Swept wing-blades of armor around the core with
// a tilted canopy pauldron, a gunmetal tail fin and a cyan thruster spark.
// The renderer carries it at cruise altitude and banks it; the model only
// adds its own hover bob and piece drift.
// ---------------------------------------------------------------------------
registerUnit("zephyr", {
  build(e, color) {
    const armor = armorMat();
    const trim = teamMat(color, 0.6);
    const coreMat = glowMat(CORE_WHITE, 2.1);
    const m = new ModelBuilder();
    m.addMat(armor);

    m.add(part(SG.core, coreMat).pos(0, 0, 0.02).scl(1.05), "core");
    // core halo peeking around the canopy — the top-down glow read
    const halo = part(SG.glowRing, glowMat(CORE_WHITE, 1.5)).rot(Math.PI / 2, 0, 0).pos(0, 0.03, 0.02).scl(1.2);
    m.add(halo, "halo");

    // canopy pauldron tilted over the nose
    const canopy = pauldron(armor, trim, 0.85);
    canopy.position.set(0, 0.1, 0.05);
    canopy.rotation.x = 0.35;
    m.addGroup(canopy, "canopy");

    // swept wing-blades (outer tips back and slightly up) + team tip plates
    // laid FLAT on the tips so they read from the top-down camera
    const wL = part(SG.wing, armor).pos(0.3, -0.01, -0.1).rot(0, -0.6, 0.12).shadow();
    const wR = part(SG.wing, armor).pos(-0.3, -0.01, -0.1).rot(0, 0.6, -0.12).shadow();
    m.add(wL, "wL"); m.add(wR, "wR");
    const tipL = part(SG.plateSm, trim).pos(0.5, 0.04, -0.28).rot(Math.PI / 2, -0.6, 0).scl(1.2, 0.9, 0.7);
    const tipR = part(SG.plateSm, trim).pos(-0.5, 0.04, -0.28).rot(Math.PI / 2, 0.6, 0).scl(1.2, 0.9, 0.7);
    m.add(tipL, "tipL"); m.add(tipR, "tipR");

    // gunmetal tail fin + thruster spark at the stern
    const fin = part(SG.fin, STORM_DARK).pos(0, 0.06, -0.28);
    m.add(fin, "fin");
    const thrMat = glowMat(SPARK, 1.6);
    m.add(part(SG.node, thrMat).pos(0, 0.0, -0.36).scl(1.3), "thr");

    // no ground contact: no lift — the renderer owns cruise altitude
    const anim = { kind: "zephyr", coreMat, thrMat, recoil: 0 };
    addFloat(anim, canopy, 0, 0.03, 2.2);
    addFloat(anim, halo.mesh, 2.6, 0.02, 2.9);
    addFloat(anim, wL.mesh, 1.8, 0.035, 2.5);
    addFloat(anim, tipL.mesh, 1.8, 0.035, 2.5);
    addFloat(anim, wR.mesh, 4.4, 0.035, 2.5);
    addFloat(anim, tipR.mesh, 4.4, 0.035, 2.5);
    addFloat(anim, fin.mesh, 3.0, 0.03, 2.1);
    m.setAnim(anim);
    return m.build();
  },

  animate(g, e, t, move, a) {
    // gentle hover bob added on top of the renderer's cruise altitude
    g.userData.body.position.y = Math.sin(t * 1.8 + e.id) * 0.09;
    floatPieces(a, t, e.id);
    a.thrMat.emissiveIntensity = 1.4 + move * 1.2 + Math.sin(t * 11 + e.id) * 0.3;
    if (a.recoil > 0) {
      a.recoil = Math.max(0, a.recoil - 0.6 / 60);
      a.coreMat.emissiveIntensity = 2.1 + a.recoil * 14;
    } else {
      a.coreMat.emissiveIntensity = 2.0 + Math.sin(t * 3 + e.id) * 0.3;
    }
  },
});

// ---------------------------------------------------------------------------
// FULMINAR ("Fulminar") — the T3 storm colossus. A ~2.2-unit-tall cathedral
// of stacked floating armor rings (widest at the base, ~1.2 units across)
// around one huge blazing core, four orbiting tower plates, and a crackling
// crown of spikes at the summit. It towers over Volts the way a tank towers
// over marines. Slow, ponderous bob; the core carries a constant menace
// pulse that goes wild while it channels Tempest (e.channelUntil).
// ---------------------------------------------------------------------------
registerUnit("fulminar", {
  build(e, color) {
    const armor = armorMat();
    const trim = teamMat(color, 0.6);
    const coreMat = glowMat(CORE_WHITE, 2.2);
    const m = new ModelBuilder();
    m.addMat(armor);

    // the great core, high in the tower — a huge lamp visible between rings
    m.add(part(SG.core, coreMat).pos(0, 1.12, 0).scl(2.8), "core");
    // a wide blazing halo around the core — the top-down glow read
    const halo = part(SG.glowRing, glowMat(CORE_WHITE, 1.8)).rot(Math.PI / 2, 0, 0).pos(0, 1.14, 0).scl(2.7);
    m.add(halo, "halo");

    // the ring cathedral: wide at the base, narrowing upward, with a tall
    // open gap around the core. Armor/dark alternating.
    const ringSpecs = [
      [0.16, 2.00, armor], [0.46, 1.75, STORM_DARK], [0.76, 1.50, armor],
      [1.48, 1.20, STORM_DARK], [1.76, 0.95, armor],
    ];
    ringSpecs.forEach(([ry, rs, mat], i) => {
      const r = part(SG.ring, mat).rot(Math.PI / 2, 0, 0).pos(0, ry, 0).scl(rs);
      if (mat === armor) r.shadow();
      m.add(r, "ring" + i);
    });
    // FAT team bands riding the stacks (top-readable) + a thin upper trim
    const trim1 = part(SG.trimFat, trim).rot(Math.PI / 2, 0, 0).pos(0, 0.3, 0).scl(2.8);
    const trim2 = part(SG.trimFat, trim).rot(Math.PI / 2, 0, 0).pos(0, 1.62, 0).scl(1.6);
    m.add(trim1, "trim1"); m.add(trim2, "trim2");

    // four tower plates orbiting the core (a slow magnetic waltz)
    const plates = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      const p = new THREE.Mesh(SG.plate, armor);
      p.position.set(Math.cos(ang) * 0.44, 0, Math.sin(ang) * 0.44);
      p.rotation.y = -ang + Math.PI / 2;
      p.scale.setScalar(1.3);
      p.castShadow = true;
      plates.add(p);
    }
    plates.position.y = 1.12;
    m.addGroup(plates, "plates");

    // crackling crown at the summit: spike circlet + bright storm nodes
    const crown = new THREE.Group();
    const crackle = [];
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2;
      const s = new THREE.Mesh(SG.spike, armor);
      s.position.set(Math.cos(ang) * 0.16, 0.04, Math.sin(ang) * 0.16);
      s.rotation.set(Math.sin(ang) * 0.45, 0, -Math.cos(ang) * 0.45);
      s.scale.setScalar(1.5);
      crown.add(s);
    }
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2 + 0.5;
      const nMat = glowMat(0xcdefff, 2.4);
      const n = new THREE.Mesh(SG.node, nMat);
      n.position.set(Math.cos(ang) * 0.22, 0.1, Math.sin(ang) * 0.22);
      n.scale.setScalar(1.3);
      crown.add(n);
      crackle.push(nMat);
    }
    const crownEye = new THREE.Mesh(SG.node, glowMat(CORE_WHITE, 2.6));
    crownEye.position.y = 0.14; crownEye.scale.setScalar(2.0);
    crown.add(crownEye);
    // team circlet band around the crown — the summit team read from above
    const crownBand = new THREE.Mesh(SG.trimFat, trim);
    crownBand.rotation.x = Math.PI / 2;
    crownBand.scale.setScalar(1.2);
    crown.add(crownBand);
    crown.position.y = 2.05;
    m.addGroup(crown, "crown");

    m.body.position.y = 0.12;
    const anim = { kind: "fulminar", coreMat, plates, crown, crackle, recoil: 0 };
    ringSpecs.forEach((_, i) => addFloat(anim, m.named["ring" + i], i * 1.7, 0.035, 1.4 + i * 0.12));
    addFloat(anim, halo.mesh, 1.3, 0.03, 1.8);
    addFloat(anim, trim1.mesh, 0.9, 0.03, 1.5);
    addFloat(anim, trim2.mesh, 3.7, 0.03, 1.6);
    addFloat(anim, crown, 2.4, 0.05, 1.3);
    m.setAnim(anim);
    return m.build();
  },

  animate(g, e, t, move, a) {
    // ponderous hover
    g.userData.body.position.y = 0.12 + Math.sin(t * 1.2 + e.id) * 0.05 + move * 0.02;
    g.userData.body.rotation.x = move * 0.05;
    floatPieces(a, t, e.id);
    a.plates.rotation.y = t * 0.4 + e.id;
    a.crown.rotation.y = -t * 0.7;
    // constant menace pulse; frantic while channeling Tempest; spike on fire
    const chan = e.channelUntil ? 1 : 0;
    let glow = 2.0 + chan * 0.9
      + Math.sin(t * (chan ? 9 : 2.4) + e.id) * (chan ? 0.9 : 0.4);
    if (a.recoil > 0) {
      a.recoil = Math.max(0, a.recoil - 0.6 / 60);
      glow += a.recoil * 12;
    }
    a.coreMat.emissiveIntensity = glow;
    for (let i = 0; i < a.crackle.length; i++) {
      a.crackle[i].emissiveIntensity = 1.8 + Math.sin(t * (13 + i * 2) + i * 2.1 + e.id) * 0.8 + chan;
    }
  },
});

// ===========================================================================
// BUILDINGS — crystalline monoliths. Angular obelisks and prisms in pale
// crystal with team-trim rings, white-cyan emissive seams/orbs, and floating
// shard halos that orbit slowly overhead. Everything rises from an octagonal
// plinth so nothing floats unanchored, builds UP from y~0 for the grow-in,
// and keeps its raw footprint within ~size units so auto-fit doesn't shrink.
// ===========================================================================

// Local building helpers (module scope, shared geometry only).
function put(geo, mat, x, y, z, sx = 1, sy, sz) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (sy === undefined) m.scale.setScalar(sx); else m.scale.set(sx, sy, sz);
  return m;
}
// A 45°-rotated box: the crystal obelisk block that reads as a cut gem column.
function diamond(mat, x, y, z, sx, sy, sz) {
  const m = put(SG.monoBox, mat, x, y, z, sx, sy, sz);
  m.rotation.y = Math.PI / 4;
  m.castShadow = true;
  return m;
}
// A vertical emissive seam strip glowing along a crystal face.
function seam(mat, x, y, z, h, ry = 0) {
  const m = put(SG.seam, mat, x, y, z);
  m.scale.y = h;
  m.rotation.y = ry;
  return m;
}
// Halo of n shards on a horizontal circle; the group is rotated + bobbed by
// animBuilding via anim.halo/haloY/haloSpd.
function shardHalo(n, r, s, mat, y) {
  const grp = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    const m = new THREE.Mesh(SG.shardBig, mat);
    m.position.set(Math.cos(ang) * r, 0, Math.sin(ang) * r);
    m.rotation.set(ang * 0.7, ang, 0);
    m.scale.setScalar(s);
    grp.add(m);
  }
  grp.position.y = y;
  return grp;
}
// Shared halo orbit + bob applied by every building's animate.
function animHalo(a, t, id) {
  if (!a.halo) return;
  a.halo.rotation.y = t * (a.haloSpd || 0.5) + id;
  a.halo.position.y = a.haloY + Math.sin(t * 1.5 + id) * 0.06;
}

// ---------------------------------------------------------------------------
// CORE ("Storm Core") — the HQ. A grand monolith: one great diamond column
// with a prism cap and glowing seams, THREE floating rings turning around it
// at different speeds, a blinding summit orb and a five-shard halo. size 3.
// ---------------------------------------------------------------------------
registerBuilding("core", {
  build(e, color, size) {
    const crys = crystalMat();
    const team = teamMat(color, 0.12);
    const glow = glowMat(CORE_WHITE, 1.6);
    const built = new THREE.Group();
    const anim = { kind: "core", lamps: [] };

    // broad octagonal plinth
    const plinth = put(SG.plinth, STORM_STEEL, 0, 0.12, 0, 1.5, 1, 1.5);
    plinth.castShadow = true;
    built.add(plinth);

    // the great diamond monolith + prism cap
    built.add(diamond(crys, 0, 1.0, 0, 0.85, 1.9, 0.85));
    const cap = put(SG.prism, crys, 0, 2.2, 0, 0.85, 0.7, 0.85);
    cap.rotation.y = Math.PI / 4; cap.castShadow = true;
    built.add(cap);

    // emissive seams running up the four faces
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      built.add(seam(glow, Math.cos(ang) * 0.61, 1.0, Math.sin(ang) * 0.61, 1.7, -ang));
    }

    // three turning rings — silver, thin TEAM trim, silver
    const rings = [];
    const rSpecs = [[0.7, 1.9, crys], [1.35, 1.55, team], [1.95, 1.2, crys]];
    for (const [ry, rs, mat] of rSpecs) {
      const geo = mat === team ? SG.trim : SG.haloRing;
      const r = put(geo, mat, 0, ry, 0, mat === team ? rs * 4.6 : rs);
      r.rotation.x = Math.PI / 2;
      rings.push(r);
      built.add(r);
    }

    // summit orb + shard halo
    const orbMat = glowMat(CORE_WHITE, 1.8);
    built.add(put(SG.orb, orbMat, 0, 2.75, 0, 0.85));
    const halo = shardHalo(5, 0.95, 1.0, crys, 2.5);
    built.add(halo);

    addLamp(built, anim, 1.05, 0.28, 1.05, SPARK);
    addLamp(built, anim, -1.05, 0.28, 1.05, SPARK);
    addLamp(built, anim, 1.05, 0.28, -1.05, SPARK);
    addLamp(built, anim, -1.05, 0.28, -1.05, SPARK);

    anim.rings = rings; anim.orbMat = orbMat;
    anim.halo = halo; anim.haloY = 2.5; anim.haloSpd = 0.45;
    built.userData.anim = anim;
    built.userData.mats = [team, crys];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    if (a.rings) for (let i = 0; i < a.rings.length; i++) {
      a.rings[i].rotation.z = t * 0.35 * (i % 2 ? -1.4 : 1);   // counter-turning
    }
    if (a.orbMat) a.orbMat.emissiveIntensity = 1.6 + Math.sin(t * 1.8 + e.id) * 0.45;
    animHalo(a, t, e.id);
  },
});

// ---------------------------------------------------------------------------
// CONDUIT ("Conduit") — supply pylon. A tesla-coil spire: one tapering
// crystal column with glowing seams, a team trim collar, a blinding orb at
// the tip and a pair of shards circling the shaft. size 2.
// ---------------------------------------------------------------------------
registerBuilding("conduit", {
  build(e, color, size) {
    const crys = crystalMat();
    const team = teamMat(color, 0.12);
    const glow = glowMat(CORE_WHITE, 1.4);
    const built = new THREE.Group();
    const anim = { kind: "conduit", lamps: [] };

    const plinth = put(SG.plinth, STORM_STEEL, 0, 0.1, 0, 0.8, 0.85, 0.8);
    plinth.castShadow = true;
    built.add(plinth);

    // the coil column
    const col = put(SG.column, crys, 0, 0.92, 0, 0.85, 1.5, 0.85);
    col.castShadow = true;
    built.add(col);
    const collar = put(SG.trim, team, 0, 0.34, 0, 2.1);
    collar.rotation.x = Math.PI / 2;
    built.add(collar);
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2;
      built.add(seam(glow, Math.cos(ang) * 0.2, 0.95, Math.sin(ang) * 0.2, 1.1, -ang));
    }

    // the coil orb
    const orbMat = glowMat(CORE_WHITE, 1.8);
    const orb = put(SG.orb, orbMat, 0, 1.78, 0, 1.0);
    built.add(orb);

    const halo = shardHalo(2, 0.55, 0.8, crys, 1.25);
    built.add(halo);

    addLamp(built, anim, 0.6, 0.22, 0.6, SPARK);
    addLamp(built, anim, -0.6, 0.22, -0.6, SPARK);

    anim.orb = orb; anim.orbMat = orbMat;
    anim.halo = halo; anim.haloY = 1.25; anim.haloSpd = 0.7;
    built.userData.anim = anim;
    built.userData.mats = [team, crys];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    const p = Math.sin(t * 2.2 + e.id) * 0.5 + 0.5;
    if (a.orbMat) a.orbMat.emissiveIntensity = 1.3 + p * 1.0;
    if (a.orb) a.orb.scale.setScalar(1.0 + p * 0.08);
    animHalo(a, t, e.id);
  },
});

// ---------------------------------------------------------------------------
// EXTRACTOR ("Extractor") — on-geyser harvester. Four crystal prisms lean
// inward over the geyser like a claw, cradling a glowing intake orb that
// gulps faster while gas is actually being harvested. size 2.
// ---------------------------------------------------------------------------
registerBuilding("extractor", {
  build(e, color, size) {
    const crys = crystalMat();
    const team = teamMat(color, 0.12);
    const built = new THREE.Group();
    const anim = { kind: "extractor", lamps: [] };

    const plinth = put(SG.plinth, STORM_STEEL, 0, 0.08, 0, 0.85, 0.65, 0.85);
    plinth.castShadow = true;
    built.add(plinth);

    // team trim ring on the plinth seam
    const trimRing = put(SG.trim, team, 0, 0.22, 0, 3.4);
    trimRing.rotation.x = Math.PI / 2;
    built.add(trimRing);

    // four prisms leaning in over the geyser mouth
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const p = put(SG.prism, crys, Math.cos(ang) * 0.58, 0.52, Math.sin(ang) * 0.58, 0.45, 0.95, 0.45);
      p.rotation.set(Math.sin(ang) * 0.5, Math.PI / 4, -Math.cos(ang) * 0.5);
      p.castShadow = true;
      built.add(p);
    }

    // the intake orb cradled between the prism tips
    const orbMat = glowMat(SPARK, 1.2);
    const orb = put(SG.orb, orbMat, 0, 0.78, 0, 1.05);
    built.add(orb);

    const halo = shardHalo(1, 0.5, 0.7, crys, 1.15);
    built.add(halo);

    addLamp(built, anim, 0.62, 0.2, 0.62, SPARK);
    addLamp(built, anim, -0.62, 0.2, -0.62, SPARK);

    anim.orb = orb; anim.orbMat = orbMat;
    anim.halo = halo; anim.haloY = 1.15; anim.haloSpd = 0.8;
    built.userData.anim = anim;
    built.userData.mats = [team, crys];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    // gulping pulse — brighter/faster while actually harvesting
    const on = g.userData.harvesting;
    const p = Math.sin(t * (on ? 7 : 2) + e.id) * 0.5 + 0.5;
    if (a.orbMat) a.orbMat.emissiveIntensity = (on ? 1.8 : 0.9) + p * 0.8;
    if (a.orb) a.orb.scale.setScalar(1.05 * (1 + p * (on ? 0.1 : 0.04)));
    animHalo(a, t, e.id);
  },
});

// ---------------------------------------------------------------------------
// FORGE ("Arc Forge") — T1 unit-maker. Twin obelisks flank a floating
// crystal WORKPIECE being forged in the arc between them; a glowing crossbar
// bridges the tips. The workpiece spins and flares while training. size 3.
// ---------------------------------------------------------------------------
registerBuilding("forge", {
  build(e, color, size) {
    const crys = crystalMat();
    const team = teamMat(color, 0.12);
    const glow = glowMat(CORE_WHITE, 1.4);
    const built = new THREE.Group();
    const anim = { kind: "forge", lamps: [] };

    const plinth = put(SG.plinth, STORM_STEEL, 0, 0.12, 0, 1.45, 1, 1.45);
    plinth.castShadow = true;
    built.add(plinth);
    const trimRing = put(SG.trim, team, 0, 0.3, 0, 6.4);
    trimRing.rotation.x = Math.PI / 2;
    built.add(trimRing);

    // twin obelisks with prism caps + inward-facing seams
    for (const sx of [-0.75, 0.75]) {
      built.add(diamond(crys, sx, 0.92, 0, 0.55, 1.5, 0.55));
      const capP = put(SG.prism, crys, sx, 1.85, 0, 0.5, 0.45, 0.5);
      capP.rotation.y = Math.PI / 4; capP.castShadow = true;
      built.add(capP);
      built.add(seam(glow, sx * 0.6, 0.92, 0, 1.3, Math.PI / 2));
    }

    // the forged workpiece floating in the arc gap + crossbar between tips
    const workMat = glowMat(SPARK, 1.4);
    const work = put(SG.shardBig, workMat, 0, 1.25, 0, 1.2, 2.2, 1.2);
    built.add(work);
    const bar = put(SG.seam, glow, 0, 1.85, 0);
    bar.scale.y = 1.25; bar.rotation.z = Math.PI / 2;
    built.add(bar);

    addLamp(built, anim, 1.05, 0.28, 1.05, SPARK);
    addLamp(built, anim, -1.05, 0.28, 1.05, SPARK);
    addLamp(built, anim, 0, 0.28, -1.1, SPARK);

    anim.work = work; anim.workMat = workMat; anim.workY = 1.25; anim.barMat = glow;
    built.userData.anim = anim;
    built.userData.mats = [team, crys];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    const busy = e.queue?.length ? 1 : 0;
    if (a.work) {
      a.work.rotation.y = t * (busy ? 2.4 : 0.6) + e.id;
      a.work.position.y = a.workY + Math.sin(t * 1.8 + e.id) * 0.06;
    }
    const p = Math.sin(t * (busy ? 7 : 2.2) + e.id) * 0.5 + 0.5;
    if (a.workMat) a.workMat.emissiveIntensity = (busy ? 1.9 : 1.1) + p * 0.7;
    if (a.barMat) a.barMat.emissiveIntensity = (busy ? 1.8 : 1.2) + p * 0.5;
  },
});

// ---------------------------------------------------------------------------
// SHRINE ("Storm Shrine") — T2 unit-maker. A tall central prism ringed by
// four kneeling corner obelisks, a wobbling tilted halo ring turning around
// the spire and a summit orb that quickens while training. size 3.
// ---------------------------------------------------------------------------
registerBuilding("shrine", {
  build(e, color, size) {
    const crys = crystalMat();
    const team = teamMat(color, 0.12);
    const glow = glowMat(CORE_WHITE, 1.4);
    const built = new THREE.Group();
    const anim = { kind: "shrine", lamps: [] };

    const plinth = put(SG.plinth, STORM_STEEL, 0, 0.12, 0, 1.45, 1, 1.45);
    plinth.castShadow = true;
    built.add(plinth);
    const trimRing = put(SG.trim, team, 0, 0.3, 0, 6.4);
    trimRing.rotation.x = Math.PI / 2;
    built.add(trimRing);

    // central spire: diamond pedestal + tall prism
    built.add(diamond(crys, 0, 0.55, 0, 0.7, 0.8, 0.7));
    const spire = put(SG.prism, crys, 0, 1.55, 0, 1.0, 1.9, 1.0);
    spire.rotation.y = Math.PI / 4; spire.castShadow = true;
    built.add(spire);
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      built.add(seam(glow, Math.cos(ang) * 0.3, 0.9, Math.sin(ang) * 0.3, 0.9, -ang));
    }

    // four corner obelisks bowing toward the spire
    for (const [ox, oz] of [[1.0, 1.0], [-1.0, 1.0], [1.0, -1.0], [-1.0, -1.0]]) {
      const o = diamond(crys, ox * 0.72, 0.55, oz * 0.72, 0.3, 0.85, 0.3);
      o.rotation.x = oz * 0.16; o.rotation.z = -ox * 0.16;
      built.add(o);
    }

    // tilted halo ring (in a group so its wobble reads as precession)
    const haloGrp = new THREE.Group();
    const hr = put(SG.haloRing, crys, 0, 0, 0, 1.5);
    hr.rotation.x = Math.PI / 2 + 0.35;
    haloGrp.add(hr);
    haloGrp.position.y = 1.7;
    built.add(haloGrp);

    const orbMat = glowMat(CORE_WHITE, 1.6);
    built.add(put(SG.orb, orbMat, 0, 2.55, 0, 0.7));

    addLamp(built, anim, 1.05, 0.28, 1.05, SPARK);
    addLamp(built, anim, -1.05, 0.28, 1.05, SPARK);
    addLamp(built, anim, 0, 0.28, -1.1, SPARK);

    anim.halo = haloGrp; anim.haloY = 1.7; anim.haloSpd = 0.6;
    anim.orbMat = orbMat;
    built.userData.anim = anim;
    built.userData.mats = [team, crys];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    const busy = e.queue?.length ? 1 : 0;
    animHalo(a, t, e.id);
    if (a.orbMat) {
      a.orbMat.emissiveIntensity = (busy ? 1.9 : 1.3)
        + Math.sin(t * (busy ? 6 : 2) + e.id) * 0.5;
    }
  },
});

// ---------------------------------------------------------------------------
// SPIRE ("Sky Ring") — flyer-maker. Two leaning pylon obelisks hold a great
// horizontal RING high over the pad — the gate the Zephyrs are born through —
// with shards riding the ring and a gate orb at its center. size 3.
// ---------------------------------------------------------------------------
registerBuilding("spire", {
  build(e, color, size) {
    const crys = crystalMat();
    const team = teamMat(color, 0.12);
    const glow = glowMat(CORE_WHITE, 1.4);
    const built = new THREE.Group();
    const anim = { kind: "spire", lamps: [] };

    const plinth = put(SG.plinth, STORM_STEEL, 0, 0.12, 0, 1.45, 1, 1.45);
    plinth.castShadow = true;
    built.add(plinth);
    const trimRing = put(SG.trim, team, 0, 0.3, 0, 6.4);
    trimRing.rotation.x = Math.PI / 2;
    built.add(trimRing);

    // two pylons leaning inward to hold the ring
    for (const sx of [-0.9, 0.9]) {
      const py = diamond(crys, sx, 0.85, 0, 0.42, 1.5, 0.42);
      py.rotation.z = -sx * 0.3;
      built.add(py);
      built.add(seam(glow, sx * 0.82, 0.8, 0, 1.2, Math.PI / 2));
    }

    // THE SKY RING — big, nearly flat, with a thin team trim ring nested in it
    const ringGrp = new THREE.Group();
    const big = put(SG.haloRing, crys, 0, 0, 0, 2.0);
    big.rotation.x = Math.PI / 2;
    big.castShadow = true;
    const teamRing = put(SG.trim, team, 0, -0.06, 0, 5.4);
    teamRing.rotation.x = Math.PI / 2;
    ringGrp.add(big, teamRing);
    ringGrp.position.y = 1.62;
    built.add(ringGrp);

    // gate orb hovering in the ring's mouth + shard outriders
    const orbMat = glowMat(SPARK, 1.3);
    const orb = put(SG.orb, orbMat, 0, 1.62, 0, 0.9);
    built.add(orb);
    const halo = shardHalo(4, 1.0, 0.75, crys, 1.62);
    built.add(halo);

    addLamp(built, anim, 1.05, 0.28, 1.05, SPARK);
    addLamp(built, anim, -1.05, 0.28, -1.05, SPARK);

    anim.ringGrp = ringGrp; anim.orb = orb; anim.orbMat = orbMat;
    anim.halo = halo; anim.haloY = 1.62; anim.haloSpd = 0.9;
    built.userData.anim = anim;
    built.userData.mats = [team, crys];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    const busy = e.queue?.length ? 1 : 0;
    if (a.ringGrp) a.ringGrp.rotation.y = t * 0.3;
    animHalo(a, t, e.id);
    if (a.orbMat) a.orbMat.emissiveIntensity = (busy ? 2.0 : 1.1) + Math.sin(t * (busy ? 7 : 2.4) + e.id) * 0.6;
    if (a.orb) a.orb.scale.setScalar(0.9 * (1 + Math.sin(t * 2.4 + e.id) * 0.05));
  },
});

// ---------------------------------------------------------------------------
// TESLA ("Tesla Pylon") — armed turret. A crystal column carrying a floating
// armor HEAD: a pauldron cap, a charge orb and a two-tine lightning fork that
// tracks targets. Mirrors the Cog turret contract — anim.pod is yawed toward
// g.userData.aimYaw, anim.podBarrels recoils on fire. size 2.
// ---------------------------------------------------------------------------
registerBuilding("tesla", {
  build(e, color, size) {
    const crys = crystalMat();
    const team = teamMat(color, 0.12);
    const glow = glowMat(CORE_WHITE, 1.4);
    const built = new THREE.Group();
    const anim = { kind: "tesla", lamps: [] };

    const plinth = put(SG.plinth, STORM_STEEL, 0, 0.1, 0, 0.78, 0.85, 0.78);
    plinth.castShadow = true;
    built.add(plinth);
    const trimRing = put(SG.trim, team, 0, 0.28, 0, 2.6);
    trimRing.rotation.x = Math.PI / 2;
    built.add(trimRing);

    // crystal column with seams
    const col = put(SG.column, crys, 0, 0.65, 0, 0.75, 1.1, 0.75);
    col.castShadow = true;
    built.add(col);
    built.add(seam(glow, 0.14, 0.62, 0.14, 0.8, -Math.PI / 4));
    built.add(seam(glow, -0.14, 0.62, -0.14, 0.8, -Math.PI / 4));

    // the aiming HEAD (pod): floating cap + charge orb + fork tines
    const pod = new THREE.Group();
    const cap = new THREE.Mesh(SG.pauldron, armorMat());
    cap.scale.setScalar(1.6); cap.position.y = 0.1; cap.castShadow = true;
    const capTrim = new THREE.Mesh(SG.trim, team);
    capTrim.rotation.x = Math.PI / 2; capTrim.position.y = 0.14; capTrim.scale.setScalar(1.5);
    const orbMat = glowMat(SPARK, 1.6);
    const orb = new THREE.Mesh(SG.orb, orbMat);
    orb.scale.setScalar(0.55); orb.position.set(0, 0, 0.02);
    const fork = new THREE.Group();
    const tineL = new THREE.Mesh(SG.prong, STORM_STEEL); tineL.position.set(0.1, 0, 0.08);
    const tineR = new THREE.Mesh(SG.prong, STORM_STEEL); tineR.position.set(-0.1, 0, 0.08);
    const tipL = new THREE.Mesh(SG.node, glowMat(SPARK, 2.0)); tipL.position.set(0.1, 0, 0.44);
    const tipR = new THREE.Mesh(SG.node, glowMat(SPARK, 2.0)); tipR.position.set(-0.1, 0, 0.44);
    fork.add(tineL, tineR, tipL, tipR);
    pod.add(cap, capTrim, orb, fork);
    pod.position.y = 1.28;
    built.add(pod);

    addLamp(built, anim, 0.55, 0.2, 0.55, SPARK);
    addLamp(built, anim, -0.55, 0.2, -0.55, SPARK);

    anim.pod = pod; anim.podBarrels = fork; anim.barrelHome = 0; anim.recoil = 0;
    anim.orbMat = orbMat; anim.podY = 1.28;
    built.userData.anim = anim;
    built.userData.mats = [team, crys];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    if (!a.pod) return;
    // hover + smooth yaw toward the renderer's aim scan (turret contract)
    a.pod.position.y = a.podY + Math.sin(t * 2 + e.id) * 0.04;
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
      a.orbMat.emissiveIntensity = 1.6 + a.recoil * 20;
    } else {
      a.podBarrels.position.z += (a.barrelHome - a.podBarrels.position.z) * 0.25;
      a.orbMat.emissiveIntensity = 1.4 + Math.sin(t * 3 + e.id) * 0.4;
    }
  },
});

// ---------------------------------------------------------------------------
// VAULT ("Phase Vault") — research crypt. A squat diamond vault under a
// gunmetal lid slab, with a floating KEY-shard slowly turning above the seal;
// the seams burn brighter while research is underway. size 2.
// ---------------------------------------------------------------------------
registerBuilding("vault", {
  build(e, color, size) {
    const crys = crystalMat();
    const team = teamMat(color, 0.12);
    const seamMat = glowMat(CORE_WHITE, 1.2);
    const built = new THREE.Group();
    const anim = { kind: "vault", lamps: [] };

    const plinth = put(SG.plinth, STORM_STEEL, 0, 0.1, 0, 0.78, 0.85, 0.78);
    plinth.castShadow = true;
    built.add(plinth);
    const trimRing = put(SG.trim, team, 0, 0.26, 0, 2.6);
    trimRing.rotation.x = Math.PI / 2;
    built.add(trimRing);

    // the vault block + gunmetal lid slab
    built.add(diamond(crys, 0, 0.64, 0, 0.9, 0.9, 0.9));
    built.add(diamond(STORM_STEEL, 0, 1.14, 0, 0.68, 0.16, 0.68));

    // sealed seams on the four faces
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
      built.add(seam(seamMat, Math.cos(ang) * 0.46, 0.64, Math.sin(ang) * 0.46, 0.78, -ang));
    }

    // the floating key-shard above the seal
    const keyMat = glowMat(SPARK, 1.3);
    const key = put(SG.shardBig, keyMat, 0, 1.52, 0, 0.9, 1.4, 0.9);
    built.add(key);

    addLamp(built, anim, 0.55, 0.2, 0.55, SPARK);
    addLamp(built, anim, -0.55, 0.2, -0.55, SPARK);

    anim.key = key; anim.keyMat = keyMat; anim.keyY = 1.52; anim.seamMat = seamMat;
    built.userData.anim = anim;
    built.userData.mats = [team, crys];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    const busy = e.queue?.length ? 1 : 0;
    if (a.key) {
      a.key.rotation.y = t * (busy ? 1.8 : 0.5) + e.id;
      a.key.position.y = a.keyY + Math.sin(t * 1.4 + e.id) * 0.06;
    }
    const p = Math.sin(t * (busy ? 6 : 2) + e.id) * 0.5 + 0.5;
    if (a.seamMat) a.seamMat.emissiveIntensity = (busy ? 1.6 : 1.0) + p * 0.5;
    if (a.keyMat) a.keyMat.emissiveIntensity = (busy ? 1.8 : 1.2) + p * 0.4;
  },
});
