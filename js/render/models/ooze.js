// Model definitions — THE OOZE: one gooey alien civilization of translucent
// blobs, sacs and mouths. This whole file is ADDITIVE — it never touches the
// Cog models. It registers real builders for all 14 Ooze types (6 units +
// 8 buildings) under their exact data.js keys, so registry.js's placeholder
// (which borrowed Cog models) is bypassed automatically once this loads.
//
// FAMILY DNA — shared across every unit AND building so the faction reads as
// ONE organism, distinct from the tin-robot Cogs:
//   1. Translucent acid-green jelly shell (per-instance oozeShell()) that you
//      can see the bruised-purple flesh through — the wet "subsurface" feel.
//   2. Wobbly rounded blobby forms (OG.blob/sac/droplet) — no hard machine edges.
//   3. A glowing inner CORE / eye in TEAM COLOR (glowMat) reading through the
//      shell — the single team-color accent, never the whole body.
//   4. A team-color MEMBRANE rim (teamMat) hugging a seam or orifice — the
//      second, sparing accent.
//   5. Spore/bubble bumps (OG.bubble) freckling the shells; bone-white fangs
//      (OG.fang) where it bites; sickly BILE-green glows where the Cogs glow amber.
//   6. Chibi readable silhouettes: worker=round glob, nip=tiny, maw=big mouth,
//      sluice=fat bloated, spit=sac-on-legs, wisp=floaty; bigger role = bigger read.
//   7. Everything BREATHES — idle squash-and-stretch wobble driven by time `t`,
//      so even a still Ooze looks alive and gross-cute.
//
// Contract (identical to the Cog files):
//   * Units: build(e,color) -> Group with userData.body + userData.anim{kind,...};
//     animate(g,e,t,move,a) drives idle/walk motion. The renderer yaws/rolls
//     userData.body and sets anim.recoil=0.08 on fire.
//   * Buildings: build(e,color,size) -> wrapBuilding(built,size,SCAFFOLD,G) with
//     built.userData.anim{kind,...} + built.userData.mats=[teamMaterial] so the
//     damage flash + build-in grow animation work. addLamp() drives blinking pips.

import * as THREE from "three";
import { ModelBuilder, part, wrapBuilding } from "./parts.js";
import { registerUnit, registerBuilding, addLamp } from "./registry.js";
import {
  G, SCAFFOLD,
  OG, OOZE_PURPLE, OOZE_PLUM, OOZE_DARK, OOZE_BONE, BILE,
  oozeShell, teamMat, glowMat,
} from "./core.js";

// A wobble helper: a smooth squash-stretch scale applied to a blob mesh. Keeps
// every Ooze "breathing" with the same organic rhythm. Deterministic (uses t).
function breathe(mesh, t, id, baseX, baseY, baseZ, amp = 0.06, rate = 2.2) {
  const s = Math.sin(t * rate + id) * amp;
  mesh.scale.set(baseX * (1 + s), baseY * (1 - s), baseZ * (1 + s));
}

// ===========================================================================
// UNITS
// ===========================================================================

// ---------------------------------------------------------------------------
// MOTE ("Mote") — worker. A round little jelly glob: translucent green body over
// a purple gut, one big team-color eye-core, a team membrane belt, spore
// freckles, and a single gooey TENDRIL "tool" arm that pokes/melts at work.
// (Lore: it melts INTO buildings — so its tool is a reaching blob of itself.)
// ---------------------------------------------------------------------------
registerUnit("mote", {
  build(e, color) {
    const shell = oozeShell();
    const core = glowMat(color, 1.5);
    const m = new ModelBuilder();
    m.addMat(shell);

    // squat purple gut, wrapped in a translucent green shell (see-through)
    m.add(part(OG.blob, OOZE_PURPLE).pos(0, 0, 0).scl(0.34, 0.3, 0.34));
    const bodyBlob = part(OG.blobHi, shell).pos(0, 0.02, 0).scl(0.44, 0.4, 0.44).shadow();
    m.add(bodyBlob, "bodyBlob");

    // one big glossy team-color eye-core reading through the shell
    m.add(part(OG.core, glowMat(color, 1.2)).pos(0, 0.04, 0).scl(0.6), "core");
    m.add(part(OG.eye, core).pos(0, 0.06, 0.28).scl(0.9), "eye");
    m.add(part(OG.eye, OOZE_DARK).pos(0, 0.06, 0.36).scl(0.42));       // pupil

    // team membrane belt at the waistline (second accent)
    m.add(part(OG.membrane, teamMat(color, 0.5)).pos(0, -0.04, 0).rot(Math.PI / 2, 0, 0).scl(0.42));

    // spore freckles on the crown
    m.add(part(OG.bubble, shell).pos(-0.14, 0.28, 0.04).scl(0.9));
    m.add(part(OG.bubble, shell).pos(0.12, 0.3, -0.06).scl(1.1));
    m.add(part(OG.bubble, shell).pos(0.2, 0.18, 0.14).scl(0.8));

    // carried resource: a bile droplet held in the belly (hidden unless carrying)
    m.add(part(OG.droplet, glowMat(0x8fe86a, 1.3)).pos(0, -0.16, 0.24).scl(0.22, 0.3, 0.22).visible(false), "carry");

    // TOOL: a reaching gooey tendril tipped with a sticky bile blob. Rooted in
    // the body so it never floats. Waggles at work.
    const tool = new THREE.Group();
    tool.add(part(OG.tendril, shell).rot(Math.PI / 2, 0, 0).pos(0, 0, 0.16).mesh);
    const tipMat = glowMat(BILE, 0.6);
    const tip = part(OG.bubbleBig, tipMat).pos(0, 0, 0.4).mesh;
    tool.add(tip);
    tool.position.set(0.28, -0.02, 0.14);
    tool.rotation.set(0.2, -0.25, 0);
    m.addGroup(tool, "tool");

    m.body.position.y = 0.4;
    m.setAnim({
      kind: "mote", wob: e.id % 7, baseColor: new THREE.Color(color),
      body: bodyBlob.mesh, eye: m.named.eye.material, core: m.named.core.material,
      carry: m.named.carry, carryMat: m.named.carry.material,
      tool, tip, tipMat,
    });
    return m.build();
  },

  animate(g, e, t, move, a) {
    // bob + breathe
    g.userData.body.position.y = 0.4 + Math.sin(t * 3 + a.wob) * 0.05 + move * 0.04;
    breathe(a.body, t, e.id, 0.44, 0.4, 0.44, 0.07, 2.6);

    a.carry.visible = e.carry > 0;
    if (e.carry > 0) a.carry.rotation.y = t * 2;

    const kind = e.order?.kind;
    const mining = kind === "gather" && e.order?.phase === "mining";
    // eye/core recolor by task (bile-green = gather, cyan = build, team = idle)
    if (kind === "gather") { a.eye.color.setHex(0x9be23a); a.eye.emissive.setHex(0x9be23a); }
    else if (kind === "build") { a.eye.color.setHex(0x63e8db); a.eye.emissive.setHex(0x63e8db); }
    else { a.eye.color.copy(a.baseColor); a.eye.emissive.copy(a.baseColor); }

    if (mining) {
      a.tool.rotation.set(0.05 + Math.sin(t * 16 + e.id) * 0.35, -0.25, 0);
      a.tipMat.emissiveIntensity = 1.4;
    } else if (kind === "build") {
      a.tool.rotation.set(-0.1 + Math.sin(t * 4 + e.id) * 0.4, Math.sin(t * 2 + e.id) * 0.3, 0);
      a.tipMat.emissiveIntensity = 1.2;
    } else {
      a.tool.rotation.set(0.2 + Math.sin(t * 1.6 + e.id) * 0.15, -0.25, 0);
      a.tipMat.emissiveIntensity = 0.6;
    }
  },
});

// ---------------------------------------------------------------------------
// NIP ("Nip") — tiny fast swarm melee. A little fanged glob: one greedy team-eye,
// a wide bone-fang underbite, two stubby scuttling tendril legs, a whip tail.
// The smallest silhouette in the roster.
// ---------------------------------------------------------------------------
registerUnit("nip", {
  build(e, color) {
    const shell = oozeShell();
    const m = new ModelBuilder();
    m.addMat(shell);

    // little teardrop body: purple gut in a green shell
    m.add(part(OG.blob, OOZE_PURPLE).pos(0, 0, 0).scl(0.24, 0.22, 0.26));
    const body = part(OG.blobHi, shell).pos(0, 0.02, 0).scl(0.32, 0.3, 0.36).shadow();
    m.add(body, "body");

    // one big hungry team eye-core
    m.add(part(OG.eye, glowMat(color, 1.5)).pos(0, 0.1, 0.2).scl(1.1), "eye");
    m.add(part(OG.eye, OOZE_DARK).pos(0, 0.1, 0.3).scl(0.5));

    // toothy underbite: a dark mouth gash rimmed with bone fangs
    m.add(part(OG.blob, OOZE_DARK).pos(0, -0.08, 0.26).scl(0.18, 0.09, 0.12));
    for (const fx of [-0.1, -0.033, 0.033, 0.1]) {
      m.add(part(OG.fang, OOZE_BONE).pos(fx, -0.04, 0.3).rot(Math.PI, 0, 0).scl(0.7));
    }

    // two stubby scuttle legs (tendrils) that patter when moving
    const legL = part(OG.tendril, OOZE_PLUM).pos(0.14, -0.16, 0.02).rot(0, 0, 0.5).scl(0.7);
    const legR = part(OG.tendril, OOZE_PLUM).pos(-0.14, -0.16, 0.02).rot(0, 0, -0.5).scl(0.7);
    m.add(legL, "legL");
    m.add(legR, "legR");

    // whip tail with a bile bead
    const tail = new THREE.Group();
    tail.add(part(OG.tendril, shell).rot(Math.PI / 2, 0, 0).pos(0, 0, 0.14).scl(0.8).mesh);
    tail.add(part(OG.bubble, glowMat(BILE, 0.7)).pos(0, 0, 0.34).mesh);
    tail.position.set(0, 0.02, -0.26);
    tail.rotation.set(-0.5, 0, 0);
    m.addGroup(tail, "tail");

    // spore freckle
    m.add(part(OG.bubble, shell).pos(0.1, 0.24, -0.05).scl(0.9));

    m.liftToGround();
    m.setAnim({ kind: "nip", body: body.mesh, legL: legL.mesh, legR: legR.mesh, tail, recoil: 0 });
    return m.build();
  },

  animate(g, e, t, move, a) {
    const phase = t * 14 + e.id * 1.7;
    breathe(a.body, t, e.id, 0.32, 0.3, 0.36, 0.09, 4.0);
    // frantic little scuttle
    a.legL.rotation.z = 0.5 + Math.sin(phase) * 0.5 * move;
    a.legR.rotation.z = -0.5 - Math.sin(phase) * 0.5 * move;
    g.userData.body.position.y = Math.abs(Math.sin(phase)) * 0.05 * move;
    a.tail.rotation.z = Math.sin(t * 6 + e.id) * 0.5;
    // lunge on bite
    if (a.recoil > 0) {
      a.recoil = Math.max(0, a.recoil - 0.6 / 60);
      g.userData.body.position.z = a.recoil * 0.6;
    }
  },
});

// ---------------------------------------------------------------------------
// SPIT ("Spit") — ranged acid-lobber + anti-air. A wobbling acid SAC on three
// spindly legs, topped by a puckered spout that lobs bile. Tall, top-heavy read.
// ---------------------------------------------------------------------------
registerUnit("spit", {
  build(e, color) {
    const shell = oozeShell();
    const m = new ModelBuilder();
    m.addMat(shell);

    // three spindly splayed legs
    const legs = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      const lx = Math.cos(a) * 0.2, lz = Math.sin(a) * 0.2;
      const leg = part(OG.tendril, OOZE_PLUM).pos(lx, -0.18, lz)
        .rot(Math.cos(a) * 0.6, 0, -Math.sin(a) * 0.6).scl(0.9, 1.2, 0.9);
      m.add(leg);
      legs.push(leg.mesh);
    }

    // fat acid sac (bile core visible through the green shell)
    m.add(part(OG.core, glowMat(BILE, 0.8)).pos(0, 0.12, 0).scl(0.9), "bile");
    const sac = part(OG.sac, shell).pos(0, 0.14, 0).scl(0.4, 0.44, 0.4).shadow();
    m.add(sac, "sac");
    // sloshing bubbles on the sac
    m.add(part(OG.bubbleBig, shell).pos(0.18, 0.06, 0.16).scl(0.9));
    m.add(part(OG.bubble, shell).pos(-0.16, 0.26, 0.1).scl(1.1));

    // team membrane rim around the sac's shoulder
    m.add(part(OG.membrane, teamMat(color, 0.5)).pos(0, 0.24, 0).rot(Math.PI / 2, 0, 0).scl(0.42));

    // team eye peering out the front
    m.add(part(OG.eye, glowMat(color, 1.5)).pos(0, 0.16, 0.34).scl(0.85), "eye");

    // puckered SPOUT on top that lobs acid (recoil group)
    const spout = new THREE.Group();
    spout.add(part(OG.pore, OOZE_DARK).scl(0.7, 0.6, 0.7).mesh);
    spout.add(part(OG.poreLip, glowMat(BILE, 0.7)).pos(0, 0.08, 0).rot(Math.PI / 2, 0, 0).scl(0.55).mesh);
    spout.position.set(0, 0.42, 0.02);
    spout.rotation.x = -0.35;
    m.addGroup(spout, "spout");

    m.liftToGround();
    m.setAnim({ kind: "spit", sac: sac.mesh, spout, spoutHome: 0.42, bile: m.named.bile.material, recoil: 0 });
    return m.build();
  },

  animate(g, e, t, move, a) {
    breathe(a.sac, t, e.id, 0.4, 0.44, 0.4, 0.06, 2.2);
    g.userData.body.position.y = Math.abs(Math.sin(t * 10 + e.id)) * 0.03 * move;
    a.bile.emissiveIntensity = 0.7 + Math.sin(t * 3 + e.id) * 0.25;
    // spit recoil: sac clenches down then eases back
    if (a.recoil > 0) {
      a.recoil = Math.max(0, a.recoil - 0.8 / 60);
      a.spout.position.y = a.spoutHome - a.recoil * 0.5;
      a.spout.rotation.x = -0.35 - a.recoil * 0.8;
    } else {
      a.spout.position.y += (a.spoutHome - a.spout.position.y) * 0.2;
      a.spout.rotation.x += (-0.35 - a.spout.rotation.x) * 0.2;
    }
  },
});

// ---------------------------------------------------------------------------
// MAW ("Maw") — big heavy melee. A huge toothy mouth-blob: an enormous
// bone-fanged gaping maw is 80% of the silhouette, tiny team eyes perched on top,
// stubby foot-blobs, hulking see-through green shell over dark-purple gullet.
// ---------------------------------------------------------------------------
registerUnit("maw", {
  build(e, color) {
    const shell = oozeShell();
    const m = new ModelBuilder();
    m.addMat(shell);

    // stubby foot-blobs
    m.add(part(OG.blob, OOZE_PLUM).pos(0.28, -0.28, 0.08).scl(0.24, 0.2, 0.28));
    m.add(part(OG.blob, OOZE_PLUM).pos(-0.28, -0.28, 0.08).scl(0.24, 0.2, 0.28));

    // massive green shell body over a dark gullet
    m.add(part(OG.blob, OOZE_DARK).pos(0, 0.08, 0.06).scl(0.6, 0.5, 0.5));   // gullet seen inside
    const body = part(OG.blobHi, shell).pos(0, 0.1, -0.04).scl(0.78, 0.72, 0.66).shadow();
    m.add(body, "body");

    // THE MOUTH: a wide dark cavity ringed top and bottom with big bone fangs.
    // Upper jaw + lower jaw are separate groups so it can chomp.
    m.add(part(OG.blob, OOZE_DARK).pos(0, 0.06, 0.42).scl(0.5, 0.36, 0.24)); // throat

    const jawU = new THREE.Group();
    for (const fx of [-0.34, -0.2, -0.07, 0.07, 0.2, 0.34]) {
      jawU.add(part(OG.fang, OOZE_BONE).pos(fx, 0, 0.02).rot(Math.PI, 0, 0).scl(1.15, 1.4, 1.15).mesh);
    }
    jawU.position.set(0, 0.22, 0.46);
    m.addGroup(jawU, "jawU");

    const jawL = new THREE.Group();
    for (const fx of [-0.3, -0.16, -0.03, 0.1, 0.24]) {
      jawL.add(part(OG.fang, OOZE_BONE).pos(fx, 0, 0.02).scl(1.0, 1.2, 1.0).mesh);
    }
    jawL.position.set(0, -0.12, 0.46);
    m.addGroup(jawL, "jawL");

    // tiny team eyes perched high on the crown
    m.add(part(OG.eye, glowMat(color, 1.5)).pos(-0.2, 0.5, 0.18).scl(0.7), "eyeL");
    m.add(part(OG.eye, glowMat(color, 1.5)).pos(0.2, 0.5, 0.18).scl(0.7), "eyeR");
    m.add(part(OG.eye, OOZE_DARK).pos(-0.2, 0.5, 0.26).scl(0.34));
    m.add(part(OG.eye, OOZE_DARK).pos(0.2, 0.5, 0.26).scl(0.34));

    // team membrane rim + spore lumps on the back
    m.add(part(OG.membrane, teamMat(color, 0.5)).pos(0, 0.1, -0.1).rot(Math.PI / 2, 0.2, 0).scl(0.62));
    m.add(part(OG.bubbleBig, shell).pos(0.22, 0.4, -0.28).scl(1.1));
    m.add(part(OG.bubbleBig, shell).pos(-0.24, 0.32, -0.3).scl(1.0));
    m.add(part(OG.bubble, shell).pos(0, 0.56, -0.22).scl(1.2));

    m.liftToGround();
    m.setAnim({ kind: "maw", body: body.mesh, jawU, jawR: 0, recoil: 0 });
    return m.build();
  },

  animate(g, e, t, move, a) {
    const phase = t * 7 + e.id * 1.7;
    breathe(a.body, t, e.id, 0.78, 0.72, 0.66, 0.05, 1.8);
    // heavy lumber
    g.userData.body.position.y = Math.abs(Math.sin(phase)) * 0.05 * move;
    g.userData.body.rotation.z = Math.sin(phase) * 0.05 * move;
    // idle chomp; big snap on attack
    let open = 0.12 + Math.sin(t * 2 + e.id) * 0.06;
    if (a.recoil > 0) {
      a.recoil = Math.max(0, a.recoil - 0.5 / 60);
      open = 0.12 + a.recoil * 0.9;         // gape then chomp shut
      g.userData.body.position.z = a.recoil * 0.4;
    }
    a.jawU.rotation.x = open;
  },
});

// ---------------------------------------------------------------------------
// SLUICE ("Sluice") — siege. A FAT bloated bile-sac low to the ground on four
// splayed stump-legs, with a hunched acid-mortar snout. Reads as the heaviest,
// roundest, most swollen thing on the field (it will later burrow to fire).
// ---------------------------------------------------------------------------
registerUnit("sluice", {
  build(e, color) {
    const shell = oozeShell();
    const m = new ModelBuilder();
    m.addMat(shell);

    // four splayed stump legs under the belly
    for (const [lx, lz] of [[0.34, 0.28], [-0.34, 0.28], [0.34, -0.28], [-0.34, -0.28]]) {
      m.add(part(OG.tendrilFat, OOZE_PLUM).pos(lx, -0.24, lz)
        .rot(lz * 0.6, 0, -lx * 0.6).scl(0.8, 0.8, 0.8));
    }

    // enormous bloated sac: bright bile core glowing through a taut green shell
    m.add(part(OG.core, glowMat(BILE, 0.7)).pos(0, 0.08, 0).scl(1.4), "bile");
    const sac = part(OG.sac, shell).pos(0, 0.1, 0).scl(0.66, 0.56, 0.62).shadow();
    m.add(sac, "sac");

    // pressure bubbles bulging off the top/sides
    m.add(part(OG.bubbleBig, shell).pos(0.34, 0.28, 0.1).scl(1.3));
    m.add(part(OG.bubbleBig, shell).pos(-0.3, 0.2, 0.24).scl(1.1));
    m.add(part(OG.bubbleBig, shell).pos(0.08, 0.42, -0.24).scl(1.4));
    m.add(part(OG.bubble, shell).pos(-0.34, 0.36, -0.14).scl(1.2));

    // team membrane seam around the swollen belly
    m.add(part(OG.membrane, teamMat(color, 0.5)).pos(0, 0.04, 0).rot(Math.PI / 2, 0, 0).scl(0.7));

    // team eyes peering over the front of the sac
    m.add(part(OG.eye, glowMat(color, 1.4)).pos(-0.16, 0.26, 0.5).scl(0.8), "eye");
    m.add(part(OG.eye, glowMat(color, 1.4)).pos(0.16, 0.26, 0.5).scl(0.8));

    // hunched acid-mortar SNOUT jutting forward-down (the siege spout)
    const snout = new THREE.Group();
    snout.add(part(OG.pore, OOZE_DARK).rot(-1.1, 0, 0).scl(1.1, 1.0, 1.1).mesh);
    snout.add(part(OG.poreLip, glowMat(BILE, 0.8)).pos(0, 0.02, 0.24).rot(0.4, 0, 0).scl(0.7).mesh);
    snout.position.set(0, 0.02, 0.5);
    m.addGroup(snout, "snout");

    m.liftToGround();
    m.setAnim({ kind: "sluice", sac: sac.mesh, bile: m.named.bile.material, snout, recoil: 0 });
    return m.build();
  },

  animate(g, e, t, move, a) {
    // heavy heaving breath
    breathe(a.sac, t, e.id, 0.66, 0.56, 0.62, 0.05, 1.6);
    a.bile.emissiveIntensity = 0.6 + Math.sin(t * 2.4 + e.id) * 0.25;
    g.userData.body.position.y = Math.abs(Math.sin(t * 8 + e.id)) * 0.025 * move;
    // mortar cough on fire
    if (a.recoil > 0) {
      a.recoil = Math.max(0, a.recoil - 0.7 / 60);
      a.snout.rotation.x = a.recoil * 0.6;
      a.bile.emissiveIntensity = 0.6 + a.recoil * 2.0;
    } else {
      a.snout.rotation.x += (0 - a.snout.rotation.x) * 0.2;
    }
  },
});

// ---------------------------------------------------------------------------
// WISP ("Wisp") — flyer. A floating translucent jelly medusa: a domed bell shell
// with a glowing team core, trailing wispy tendrils, spore motes. Hovers (bob is
// added to the body; the renderer carries it at cruise altitude and banks it).
// ---------------------------------------------------------------------------
registerUnit("wisp", {
  build(e, color) {
    const shell = oozeShell(0.28);
    const m = new ModelBuilder();
    m.addMat(shell);

    // domed jellyfish bell (translucent green) over a bright team core
    m.add(part(OG.core, glowMat(color, 1.6)).pos(0, 0.02, 0).scl(0.85), "core");
    const bell = part(OG.blobHi, shell).pos(0, 0.06, 0).scl(0.46, 0.36, 0.46).shadow();
    m.add(bell, "bell");
    // bell underside lip (team membrane)
    m.add(part(OG.membrane, teamMat(color, 0.6)).pos(0, -0.06, 0).rot(Math.PI / 2, 0, 0).scl(0.44));

    // spore motes freckling the dome
    m.add(part(OG.bubble, shell).pos(-0.16, 0.16, 0.12).scl(1.0));
    m.add(part(OG.bubble, shell).pos(0.14, 0.2, -0.08).scl(1.2));
    m.add(part(OG.bubble, shell).pos(0.2, 0.1, 0.1).scl(0.8));

    // trailing tendrils hanging under the bell (they sway)
    const tendrils = new THREE.Group();
    for (const [tx, tz] of [[0.16, 0.12], [-0.16, 0.12], [0.16, -0.12], [-0.16, -0.12], [0, 0]]) {
      const td = new THREE.Group();
      td.add(part(OG.tendril, shell).rot(Math.PI / 2, 0, 0).pos(0, 0, 0.16).scl(0.8, 1.2, 0.8).mesh);
      td.add(part(OG.bubble, glowMat(BILE, 0.7)).pos(0, 0, 0.34).mesh);
      td.position.set(tx, -0.14, tz);
      td.rotation.x = Math.PI / 2;          // hang downward
      tendrils.add(td);
    }
    m.addGroup(tendrils, "tendrils");

    m.setAnim({ kind: "wisp", bell: bell.mesh, core: m.named.core.material, tendrils, bob: e.id % 6 });
    return m.build();
  },

  animate(g, e, t, move, a) {
    // gentle hover bob (added on top of the renderer's cruise altitude on body)
    g.userData.body.position.y = Math.sin(t * 1.8 + a.bob) * 0.1;
    breathe(a.bell, t, e.id, 0.46, 0.36, 0.46, 0.08, 2.0);
    a.core.emissiveIntensity = 1.4 + Math.sin(t * 3 + e.id) * 0.4;
    // tendrils sway
    for (let i = 0; i < a.tendrils.children.length; i++) {
      const td = a.tendrils.children[i];
      td.rotation.z = Math.sin(t * 2.2 + i * 0.8) * 0.25;
    }
  },
});

// ===========================================================================
// BUILDINGS — the same organism, grown large. Fleshy pulsing mounds with pores,
// membranes and orifices; NOT boxes. Each rises from a purple flesh MOUND base
// so nothing floats, wears a translucent green shell + team membrane rim, pulses
// via animate, and returns wrapBuilding(...). All keep their raw model within
// ~size units so auto-fit doesn't shrink them.
// ===========================================================================

// Shared building helpers (local; buildings are few so bespoke geometry is fine).
function blobMesh(mat, x, y, z, sx, sy, sz) {
  const mesh = new THREE.Mesh(OG.blobHi, mat);
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  mesh.castShadow = true;
  return mesh;
}
// A puckered pore/orifice: dark socket + team-or-bile glowing rim, seated at (x,y,z).
function poreVent(x, y, z, rimMat, s = 1) {
  const grp = new THREE.Group();
  const socket = new THREE.Mesh(OG.pore, OOZE_DARK);
  const lip = new THREE.Mesh(OG.poreLip, rimMat);
  lip.rotation.x = Math.PI / 2; lip.position.y = 0.1;
  grp.add(socket, lip);
  grp.position.set(x, y, z);
  grp.scale.setScalar(s);
  return grp;
}
// A ring of spore bubbles around a circle (freckles the flesh).
function sporeRing(n, r, y, mat, s = 1) {
  const grp = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const b = new THREE.Mesh(OG.bubbleBig, mat);
    b.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    b.scale.setScalar(s);
    grp.add(b);
  }
  return grp;
}

// ---------------------------------------------------------------------------
// NUCLEUS ("Nucleus") — the hub/heart. The BIGGEST Ooze form: a great pulsing
// organ. A broad purple flesh mound carries a towering translucent green dome
// with a huge team-color core beating inside, a membrane crown, ringed pores
// that ooze goo, and spore lumps. size 3.
// ---------------------------------------------------------------------------
registerBuilding("nucleus", {
  build(e, color, size) {
    const shell = oozeShell(0.2);
    const team = teamMat(color, 0.1);
    const built = new THREE.Group();
    const anim = { kind: "nucleus", lamps: [] };

    // broad flesh mound base
    built.add(blobMesh(OOZE_PURPLE, 0, 0.1, 0, 1.5, 0.55, 1.5));
    built.add(blobMesh(OOZE_PLUM, 0, 0.16, 0, 1.28, 0.5, 1.28));

    // the great heart-core: a huge team-color glowing organ (pulses)
    const heart = blobMesh(glowMat(color, 1.0), 0, 1.0, 0, 0.95, 1.0, 0.95);
    built.add(heart);
    // towering translucent green dome shell over the heart
    const domeShell = blobMesh(shell, 0, 1.0, 0, 1.22, 1.35, 1.22);
    built.add(domeShell);

    // membrane crown ring around the dome's shoulder
    const crown = new THREE.Mesh(OG.membrane, team);
    crown.rotation.x = Math.PI / 2; crown.position.y = 1.5; crown.scale.setScalar(2.0);
    built.add(crown);

    // ring of goo pores around the mound that ooze (bile-lit)
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      built.add(poreVent(Math.cos(a) * 1.3, 0.34, Math.sin(a) * 1.3, glowMat(BILE, 0.7), 0.7));
    }
    // fat spore lumps clustered on the dome
    built.add(sporeRing(5, 1.0, 1.7, shell, 1.3));
    built.add(blobMesh(shell, 0, 2.3, 0, 0.4, 0.34, 0.4));   // crown spore cap

    // team eye peering out the front of the dome
    const eye = new THREE.Mesh(OG.eye, glowMat(color, 1.5));
    eye.position.set(0, 1.1, 1.1); eye.scale.setScalar(1.8);
    built.add(eye);
    built.add(new THREE.Mesh(OG.eye, OOZE_DARK)); // pupil placed next
    built.children[built.children.length - 1].position.set(0, 1.1, 1.28);
    built.children[built.children.length - 1].scale.setScalar(0.9);

    // blinking bile pips low on the mound (use addLamp so registry blinks them)
    addLamp(built, anim, 0.95, 0.4, 0.95, 0x9be23a);
    addLamp(built, anim, -0.95, 0.4, 0.95, 0x9be23a);
    addLamp(built, anim, 0.95, 0.4, -0.95, 0x9be23a);
    addLamp(built, anim, -0.95, 0.4, -0.95, 0x9be23a);

    anim.heart = heart; anim.heartMat = heart.material; anim.dome = domeShell;
    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    // the heart beats: a double-thump pulse in scale + glow
    const beat = Math.sin(t * 2.2) * 0.5 + Math.sin(t * 2.2 + 0.5) * 0.5;
    const s = 1 + beat * 0.05;
    if (a.heart) a.heart.scale.set(0.95 * s, 1.0 * s, 0.95 * s);
    if (a.heartMat) a.heartMat.emissiveIntensity = 1.0 + beat * 0.5;
    if (a.dome) { const w = 1 + Math.sin(t * 1.6) * 0.02; a.dome.scale.set(1.22 * w, 1.35 * (2 - w), 1.22 * w); }
  },
});

// ---------------------------------------------------------------------------
// POD ("Pod") — supply. A swollen egg-sac: a fat translucent green egg on a
// purple flesh foot, veined with a team membrane, a glowing bile embryo inside,
// spore warts. Gently swells as if incubating. size 2.
// ---------------------------------------------------------------------------
registerBuilding("pod", {
  build(e, color, size) {
    const shell = oozeShell(0.22);
    const team = teamMat(color, 0.1);
    const built = new THREE.Group();
    const anim = { kind: "pod", lamps: [] };

    // purple flesh foot the egg roots into
    built.add(blobMesh(OOZE_PURPLE, 0, 0.14, 0, 0.75, 0.4, 0.75));

    // glowing embryo (bile core) + tall translucent egg shell over it
    const embryo = blobMesh(glowMat(BILE, 0.8), 0, 0.72, 0, 0.44, 0.6, 0.44);
    built.add(embryo);
    const egg = blobMesh(shell, 0, 0.78, 0, 0.62, 0.86, 0.62);
    built.add(egg);

    // team membrane vein wrapping the egg's middle
    const vein = new THREE.Mesh(OG.membrane, team);
    vein.rotation.x = Math.PI / 2; vein.position.y = 0.78; vein.scale.setScalar(1.05);
    built.add(vein);
    const vein2 = new THREE.Mesh(OG.membrane, team);
    vein2.rotation.set(Math.PI / 2, 0, Math.PI / 2); vein2.position.y = 0.78; vein2.scale.set(0.55, 1.05, 1.05);
    built.add(vein2);

    // spore warts + a puckered top pore
    built.add(sporeRing(4, 0.5, 1.1, shell, 1.1));
    built.add(poreVent(0, 1.42, 0, glowMat(BILE, 0.7), 0.55));

    addLamp(built, anim, 0.55, 0.34, 0.55, 0x9be23a);
    addLamp(built, anim, -0.55, 0.34, -0.55, 0x9be23a);

    anim.egg = egg; anim.embryoMat = embryo.material;
    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    const s = Math.sin(t * 1.4 + e.id) * 0.04;
    if (a.egg) a.egg.scale.set(0.62 * (1 + s), 0.86 * (1 - s * 0.6), 0.62 * (1 + s));
    if (a.embryoMat) a.embryoMat.emissiveIntensity = 0.8 + Math.sin(t * 1.4 + e.id) * 0.4;
  },
});

// ---------------------------------------------------------------------------
// VENT ("Goo Vent") — a goo-oozing pore/chimney. A squat flesh mound crowned by
// a puckered chimney orifice that belches bile, glistening runnels down the side.
// size 2.
// ---------------------------------------------------------------------------
registerBuilding("vent", {
  build(e, color, size) {
    const shell = oozeShell(0.22);
    const team = teamMat(color, 0.12);
    const built = new THREE.Group();
    const anim = { kind: "vent", lamps: [] };

    // squat flesh mound + green shell skin
    built.add(blobMesh(OOZE_PURPLE, 0, 0.14, 0, 0.8, 0.42, 0.8));
    const skin = blobMesh(shell, 0, 0.26, 0, 0.72, 0.5, 0.72);
    built.add(skin);

    // team membrane rim at the base seam
    const rim = new THREE.Mesh(OG.membrane, team);
    rim.rotation.x = Math.PI / 2; rim.position.y = 0.2; rim.scale.setScalar(1.3);
    built.add(rim);

    // tapering chimney throat rising from the mound, tipped with a glowing pore
    const throat = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.4, 0.7, 14), OOZE_PLUM);
    throat.position.y = 0.72; throat.castShadow = true;
    built.add(throat);
    const throatShell = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.42, 0.6, 14), shell);
    throatShell.position.y = 0.72;
    built.add(throatShell);
    // the erupting orifice (bile-lit, pulses)
    const mouth = poreVent(0, 1.02, 0, glowMat(BILE, 1.0), 0.85);
    built.add(mouth);
    const plume = blobMesh(glowMat(BILE, 0.9), 0, 1.16, 0, 0.24, 0.3, 0.24);
    built.add(plume);

    // goo runnels (bile beads) dripping down the mound
    built.add(sporeRing(5, 0.62, 0.36, glowMat(BILE, 0.5), 0.8));

    addLamp(built, anim, 0.6, 0.3, 0.5, 0x9be23a);
    addLamp(built, anim, -0.6, 0.3, -0.5, 0x9be23a);

    anim.plume = plume; anim.plumeMat = plume.material; anim.skin = skin;
    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    const p = Math.sin(t * 3 + e.id) * 0.5 + 0.5;
    if (a.plume) a.plume.scale.set(0.24 * (0.7 + p * 0.6), 0.3 * (0.7 + p), 0.24 * (0.7 + p * 0.6));
    if (a.plumeMat) a.plumeMat.emissiveIntensity = 0.7 + p * 0.8;
    if (a.skin) { const s = Math.sin(t * 2 + e.id) * 0.03; a.skin.scale.set(0.72 * (1 + s), 0.5, 0.72 * (1 + s)); }
  },
});

// ---------------------------------------------------------------------------
// DEN ("Den") — unit-morphing pit/maw. A fleshy mound split by a wide gaping
// birthing MAW ringed with bone fangs; a bile womb glows in the throat; new
// broods bubble up. Clearly kin to the Maw unit. size 3.
// ---------------------------------------------------------------------------
registerBuilding("den", {
  build(e, color, size) {
    const shell = oozeShell(0.2);
    const team = teamMat(color, 0.1);
    const built = new THREE.Group();
    const anim = { kind: "den", lamps: [] };

    // broad purple flesh mound + translucent green skin
    built.add(blobMesh(OOZE_PURPLE, 0, 0.18, 0, 1.35, 0.65, 1.35));
    const skin = blobMesh(shell, 0, 0.34, -0.05, 1.2, 0.72, 1.2);
    built.add(skin);

    // team membrane rim around the mound
    const rim = new THREE.Mesh(OG.membrane, team);
    rim.rotation.x = Math.PI / 2; rim.position.y = 0.3; rim.scale.setScalar(2.4);
    built.add(rim);

    // the birthing MAW: a wide dark cavity in the front, ringed with bone fangs,
    // a bile womb glowing at the back of the throat.
    built.add(blobMesh(OOZE_DARK, 0, 0.5, 0.5, 0.75, 0.5, 0.5));   // cavity
    const womb = blobMesh(glowMat(BILE, 1.0), 0, 0.46, 0.2, 0.5, 0.4, 0.4);
    built.add(womb);
    // fang ring around the mouth's lip
    const jaw = new THREE.Group();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI - Math.PI * 0.05; // upper arc
      const fx = Math.cos(a) * 0.7, fy = Math.sin(a) * 0.5;
      const f = new THREE.Mesh(OG.fangBig, OOZE_BONE);
      f.position.set(fx, 0.5 + fy, 0.86);
      f.rotation.z = Math.PI - a;               // point inward around the arc
      f.scale.setScalar(0.7);
      jaw.add(f);
    }
    built.add(jaw);

    // spore lumps + tiny team eyes over the maw
    built.add(sporeRing(4, 0.95, 0.85, shell, 1.2));
    const eyeL = new THREE.Mesh(OG.eye, glowMat(color, 1.4)); eyeL.position.set(-0.28, 1.05, 0.5); eyeL.scale.setScalar(1.3);
    const eyeR = new THREE.Mesh(OG.eye, glowMat(color, 1.4)); eyeR.position.set(0.28, 1.05, 0.5); eyeR.scale.setScalar(1.3);
    built.add(eyeL, eyeR);

    addLamp(built, anim, 0.9, 0.44, 0.9, 0x9be23a);
    addLamp(built, anim, -0.9, 0.44, 0.9, 0x9be23a);
    addLamp(built, anim, 0, 0.44, -1.0, 0x9be23a);

    anim.womb = womb; anim.wombMat = womb.material; anim.skin = skin;
    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    // womb glows brighter + swells while a brood is queued
    const busy = e.queue?.length ? 1 : 0;
    const p = Math.sin(t * (busy ? 5 : 2) + e.id) * 0.5 + 0.5;
    if (a.wombMat) a.wombMat.emissiveIntensity = (busy ? 1.4 : 0.7) + p * 0.6;
    if (a.womb) { const s = 1 + p * (busy ? 0.14 : 0.05); a.womb.scale.set(0.5 * s, 0.4 * s, 0.4 * s); }
    if (a.skin) { const b = Math.sin(t * 1.8 + e.id) * 0.02; a.skin.scale.set(1.2 * (1 + b), 0.72, 1.2 * (1 + b)); }
  },
});

// ---------------------------------------------------------------------------
// SUMP ("Sump") — on-geyser oil harvester. A bulbous flesh sac hunched over the
// geyser, sinking a hard PROBOSCIS straw into the ground; the sac fills with
// bile as it drinks. Sits within a 2x2 footprint over the geyser. size 2.
// ---------------------------------------------------------------------------
registerBuilding("sump", {
  build(e, color, size) {
    const shell = oozeShell(0.22);
    const team = teamMat(color, 0.1);
    const built = new THREE.Group();
    const anim = { kind: "sump", lamps: [] };

    // low flesh ring hugging the geyser mouth
    built.add(blobMesh(OOZE_PURPLE, 0, 0.12, 0, 0.95, 0.32, 0.95));

    // bulbous drinking sac (bile fills it) hunched to one side
    const bileFill = blobMesh(glowMat(BILE, 0.6), 0.28, 0.6, -0.1, 0.4, 0.42, 0.4);
    built.add(bileFill);
    const sac = blobMesh(shell, 0.28, 0.66, -0.1, 0.56, 0.6, 0.56);
    built.add(sac);
    built.add(sporeRing(3, 0.42, 0.9, shell, 1.0));

    // team membrane rim on the sac
    const rim = new THREE.Mesh(OG.membrane, team);
    rim.rotation.x = Math.PI / 2; rim.position.set(0.28, 0.66, -0.1); rim.scale.setScalar(1.0);
    built.add(rim);

    // hard PROBOSCIS straw plunging into the geyser (roots into the flesh ring)
    const straw = new THREE.Mesh(OG.proboscis, OOZE_DARK);
    straw.position.set(-0.1, 0.28, 0.2); straw.rotation.x = 0.25; straw.castShadow = true;
    built.add(straw);
    const strawShell = new THREE.Mesh(OG.proboscis, shell);
    strawShell.position.set(-0.1, 0.32, 0.2); strawShell.rotation.x = 0.25; strawShell.scale.set(1.15, 0.8, 1.15);
    built.add(strawShell);
    // a bile bead at the straw's base where it meets the ground
    built.add(blobMesh(glowMat(BILE, 0.7), -0.1, 0.06, 0.32, 0.22, 0.14, 0.22));

    addLamp(built, anim, 0.7, 0.26, 0.5, 0x9be23a);
    addLamp(built, anim, -0.6, 0.26, -0.5, 0x9be23a);

    anim.sac = sac; anim.bileMat = bileFill.material;
    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    // gulping breaths — brighter/faster while harvesting
    const on = g.userData.harvesting;
    const p = Math.sin(t * (on ? 6 : 2.2) + e.id) * 0.5 + 0.5;
    if (a.sac) { const s = 1 + p * (on ? 0.1 : 0.04); a.sac.scale.set(0.56 * s, 0.6 * s, 0.56 * s); }
    if (a.bileMat) a.bileMat.emissiveIntensity = (on ? 1.2 : 0.5) + p * 0.6;
  },
});

// ---------------------------------------------------------------------------
// WARREN ("Warren") — bigger morph-tank. A large elongated flesh gestation tank:
// a long translucent green blister with several bile embryos suspended inside,
// a membrane seam down the spine, a pulsing birth-pore at the front. Reads as a
// heavier Den (it morphs the big Maws & Sluices). size 3.
// ---------------------------------------------------------------------------
registerBuilding("warren", {
  build(e, color, size) {
    const shell = oozeShell(0.2);
    const team = teamMat(color, 0.1);
    const built = new THREE.Group();
    const anim = { kind: "warren", lamps: [] };

    // broad flesh base bed
    built.add(blobMesh(OOZE_PURPLE, 0, 0.16, 0, 1.4, 0.5, 1.15));

    // long translucent gestation blister with embryos inside
    const embryos = [];
    for (const ex of [-0.62, 0, 0.62]) {
      const em = blobMesh(glowMat(BILE, 0.8), ex, 0.66, 0, 0.34, 0.44, 0.34);
      built.add(em); embryos.push(em.material);
    }
    const blister = blobMesh(shell, 0, 0.7, 0, 1.25, 0.78, 0.85);
    built.add(blister);

    // membrane seam running the length of the spine
    const seam = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.06, 8, 24), team);
    seam.rotation.set(Math.PI / 2, 0, Math.PI / 2); seam.position.y = 1.2; seam.scale.set(1.0, 2.3, 1.0);
    built.add(seam);

    // pulsing birth-pore at the front + fang hint (kin to Den)
    const pore = poreVent(0, 0.5, 0.86, glowMat(BILE, 1.0), 1.0);
    pore.rotation.x = 0.5;
    built.add(pore);
    for (const fx of [-0.28, -0.1, 0.1, 0.28]) {
      const f = new THREE.Mesh(OG.fangBig, OOZE_BONE);
      f.position.set(fx, 0.72, 0.86); f.rotation.x = Math.PI * 0.55; f.scale.setScalar(0.55);
      built.add(f);
    }

    // spore lumps + team eyes
    built.add(sporeRing(4, 0.9, 1.15, shell, 1.2));
    const eyeL = new THREE.Mesh(OG.eye, glowMat(color, 1.4)); eyeL.position.set(-0.3, 1.05, 0.55); eyeL.scale.setScalar(1.2);
    const eyeR = new THREE.Mesh(OG.eye, glowMat(color, 1.4)); eyeR.position.set(0.3, 1.05, 0.55); eyeR.scale.setScalar(1.2);
    built.add(eyeL, eyeR);

    addLamp(built, anim, 1.0, 0.4, 0.8, 0x9be23a);
    addLamp(built, anim, -1.0, 0.4, 0.8, 0x9be23a);
    addLamp(built, anim, 0, 0.4, -0.9, 0x9be23a);

    anim.blister = blister; anim.embryos = embryos;
    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    if (a.blister) { const b = Math.sin(t * 1.6 + e.id) * 0.025; a.blister.scale.set(1.25 * (1 + b), 0.78, 0.85 * (1 + b)); }
    if (a.embryos) for (let i = 0; i < a.embryos.length; i++)
      a.embryos[i].emissiveIntensity = 0.7 + Math.sin(t * 2 + i * 1.3 + e.id) * 0.4;
  },
});

// ---------------------------------------------------------------------------
// ROOST ("Roost") — flyer nest. A tall flesh stalk cupping an open fleshy
// ORIFICE the Wisps hatch from, spore pods clustered around the fleshy mouth, a
// team membrane rim, a bile glow inside the nest. size 3.
// ---------------------------------------------------------------------------
registerBuilding("roost", {
  build(e, color, size) {
    const shell = oozeShell(0.22);
    const team = teamMat(color, 0.1);
    const built = new THREE.Group();
    const anim = { kind: "roost", lamps: [] };

    // flesh mound base + a thick rising stalk
    built.add(blobMesh(OOZE_PURPLE, 0, 0.14, 0, 1.15, 0.45, 1.15));
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.85, 1.1, 16), OOZE_PLUM);
    stalk.position.y = 0.85; stalk.castShadow = true;
    built.add(stalk);
    const stalkShell = new THREE.Mesh(new THREE.CylinderGeometry(0.54, 0.88, 1.0, 16), shell);
    stalkShell.position.y = 0.85;
    built.add(stalkShell);

    // open cup nest at the top: a fleshy ring opening upward, bile glow inside
    const cup = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.22, 10, 20), OOZE_PLUM);
    cup.rotation.x = Math.PI / 2; cup.position.y = 1.45; cup.castShadow = true;
    built.add(cup);
    const cupShell = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.24, 10, 20), shell);
    cupShell.rotation.x = Math.PI / 2; cupShell.position.y = 1.45;
    built.add(cupShell);
    const nestGlow = blobMesh(glowMat(BILE, 0.9), 0, 1.4, 0, 0.42, 0.24, 0.42);
    built.add(nestGlow);

    // team membrane rim hugging the cup lip
    const rim = new THREE.Mesh(OG.membrane, team);
    rim.rotation.x = Math.PI / 2; rim.position.y = 1.56; rim.scale.setScalar(1.25);
    built.add(rim);

    // spore pods clustered around the nest lip (the "eggs")
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const pod = blobMesh(shell, Math.cos(a) * 0.62, 1.5, Math.sin(a) * 0.62, 0.18, 0.22, 0.18);
      built.add(pod);
    }
    // a team eye on the stalk
    const eye = new THREE.Mesh(OG.eye, glowMat(color, 1.4)); eye.position.set(0, 0.85, 0.72); eye.scale.setScalar(1.4);
    built.add(eye);

    addLamp(built, anim, 0.8, 0.32, 0.6, 0x9be23a);
    addLamp(built, anim, -0.8, 0.32, -0.6, 0x9be23a);

    anim.nestGlow = nestGlow; anim.nestMat = nestGlow.material;
    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    const p = Math.sin(t * 2.5 + e.id) * 0.5 + 0.5;
    if (a.nestMat) a.nestMat.emissiveIntensity = 0.7 + p * 0.7;
    if (a.nestGlow) { const s = 1 + p * 0.12; a.nestGlow.scale.set(0.42 * s, 0.24 * s, 0.42 * s); }
  },
});

// ---------------------------------------------------------------------------
// BARB ("Barb") — static defense (ground + air). A flesh mound bristling with a
// tall bone SPINE-spitter that swivels a bile-loaded muzzle; fang barbs ring the
// base. Reads as an angrier cousin of the Spit unit. size 2.
// ---------------------------------------------------------------------------
registerBuilding("barb", {
  build(e, color, size) {
    const shell = oozeShell(0.22);
    const team = teamMat(color, 0.12);
    const built = new THREE.Group();
    const anim = { kind: "barb", lamps: [] };

    // flesh mound + green skin
    built.add(blobMesh(OOZE_PURPLE, 0, 0.14, 0, 0.8, 0.42, 0.8));
    const skin = blobMesh(shell, 0, 0.24, 0, 0.72, 0.48, 0.72);
    built.add(skin);

    // team membrane rim + a ring of bone barbs jutting from the base
    const rim = new THREE.Mesh(OG.membrane, team);
    rim.rotation.x = Math.PI / 2; rim.position.y = 0.22; rim.scale.setScalar(1.3);
    built.add(rim);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const barb = new THREE.Mesh(OG.fangBig, OOZE_BONE);
      barb.position.set(Math.cos(a) * 0.62, 0.34, Math.sin(a) * 0.62);
      barb.rotation.set(Math.PI / 2 + Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5 + Math.PI); // splay outward-up
      barb.scale.setScalar(0.7);
      built.add(barb);
    }

    // central spitter STALK: a taut green sac on a plum neck, topped with a
    // bile-loaded muzzle pore that pulses. (Radially readable, no turret contract.)
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.26, 0.55, 12), OOZE_PLUM);
    neck.position.y = 0.62; neck.castShadow = true;
    built.add(neck);
    const head = blobMesh(shell, 0, 1.0, 0, 0.36, 0.4, 0.36);
    built.add(head);
    const bileCore = blobMesh(glowMat(BILE, 0.8), 0, 1.0, 0, 0.24, 0.28, 0.24);
    built.add(bileCore);
    // muzzle pore aimed up-forward + a team eye on the head
    const muzzle = poreVent(0, 1.12, 0.18, glowMat(BILE, 1.0), 0.5);
    muzzle.rotation.x = -0.5;
    built.add(muzzle);
    const eye = new THREE.Mesh(OG.eye, glowMat(color, 1.5)); eye.position.set(0, 1.02, 0.34); eye.scale.setScalar(1.1);
    built.add(eye);

    addLamp(built, anim, 0.6, 0.3, 0.5, 0x9be23a);
    addLamp(built, anim, -0.6, 0.3, -0.5, 0x9be23a);

    anim.head = head; anim.bileMat = bileCore.material; anim.recoil = 0;
    built.userData.anim = anim;
    built.userData.mats = [team];
    return wrapBuilding(built, size, SCAFFOLD, G);
  },

  animate(g, e, t, move, a) {
    // idle sway of the head + bile throb; a spit-clench on fire
    if (a.head) a.head.position.y = 1.0 + Math.sin(t * 1.8 + e.id) * 0.03;
    let glow = 0.8 + Math.sin(t * 2.5 + e.id) * 0.3;
    if (a.recoil > 0) {
      a.recoil = Math.max(0, a.recoil - 1.0 / 60);
      glow = 0.8 + a.recoil * 2.5;
      if (a.head) a.head.position.y = 1.0 - a.recoil * 0.12;
    }
    if (a.bileMat) a.bileMat.emissiveIntensity = glow;
  },
});
