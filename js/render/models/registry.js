// Registry: a dispatch table that maps entity types to their build + animate
// functions. Adding a new model is just one registerUnit/registerBuilding call.
//
// To add a new unit:
//   1. Write build + animate functions in units.js
//   2. Call registerUnit("myUnit", { build, animate }) at the bottom
//   3. Done — the renderer picks it up automatically
//
// Similarly for buildings: registerBuilding("myBuilding", { build, animate })

import * as THREE from "three";
import { ModelBuilder, wrapBuilding, part } from "./parts.js";
import { G, SCAFFOLD, glowMat, BUILDING_BASE } from "./core.js";
import { animateMineral, animateGeyser } from "./props.js";

const unitRegistry = {};
const buildingRegistry = {};

// Temporary placeholder art: until the Ooze faction has its own model family,
// its types render as the closest-role Cog model (team-colored). Real Ooze
// builders, once registered under their own keys, take precedence automatically.
const PLACEHOLDER = {
  mote: "worker", nip: "marine", spit: "marine", maw: "brute", sluice: "tank", wisp: "wraith",
  nucleus: "hq", pod: "depot", vent: "turret", den: "barracks", sump: "refinery",
  warren: "factory", roost: "starport", barb: "turret",
};
const propAnimators = {
  mineral: animateMineral,
  geyser: animateGeyser,
};

export function registerUnit(type, def) {
  unitRegistry[type] = def;
}

export function registerBuilding(type, def) {
  buildingRegistry[type] = def;
}

// Build a unit visual by dispatching to the registered builder.
export function makeUnitVisual(e, color) {
  const def = unitRegistry[e.type] || unitRegistry[PLACEHOLDER[e.type]];
  if (!def) {
    console.warn(`Unknown unit type: ${e.type}`);
    return new THREE.Group();
  }
  return def.build(e, color);
}

// Build a building visual by dispatching to the registered builder.
export function makeBuildingVisual(e, color, size) {
  const def = buildingRegistry[e.type] || buildingRegistry[PLACEHOLDER[e.type]];
  if (!def) {
    console.warn(`Unknown building type: ${e.type}`);
    return new THREE.Group();
  }
  return def.build(e, color, size);
}

// Animate any visual by dispatching to the registered animator.
export function animateVisual(g, e, t, moveAmt) {
  const a = g.userData.anim;
  if (!a || !a.kind) return;
  const def = unitRegistry[a.kind] || buildingRegistry[a.kind];
  if (def && def.animate) def.animate(g, e, t, moveAmt, a);

  // Universal: blinking building lamps
  if (a.lamps) {
    for (let i = 0; i < a.lamps.length; i++) {
      a.lamps[i].material.emissiveIntensity =
        Math.sin(t * 3 + i * 1.6 + e.id) > 0.55 ? 1.8 : 0.3;
    }
  }
}

// Helper: create a building lamp mesh and register it for blinking animation
export function addLamp(built, anim, x, y, z, color, intensity = 1.2) {
  const l = new THREE.Mesh(G.lamp, glowMat(color, intensity));
  l.position.set(x, y, z);
  if (!anim.lamps) anim.lamps = [];
  anim.lamps.push(l);
  built.add(l);
}

export { ModelBuilder, wrapBuilding, part, G, SCAFFOLD, glowMat, BUILDING_BASE };
