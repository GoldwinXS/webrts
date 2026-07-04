// Parts & ModelBuilder: a fluent API for assembling procedural models from
// primitives. Designed to make creating new models and tweaking existing ones
// as painless as possible.
//
// Quick start:
//   const m = new ModelBuilder();
//   m.add(part(G.dronePod, team).scl(1, 0.78, 1.12).shadow());
//   m.add(part(G.droneEye, glow).pos(-0.1, 0.06, 0.26), "eyeL");
//   m.addGroup(wandGroup, "wand");
//   m.body.position.y = 0.42;
//   m.liftToGround();
//   m.setAnim({ kind: "worker", ... });
//   return m.build();

import * as THREE from "three";

// ---------------------------------------------------------------------------
// part(): create a mesh with a fluent chaining API. Every method returns the
// same wrapper so calls chain naturally. Access the raw mesh via `.mesh`.
// ---------------------------------------------------------------------------
export function part(geo, mat) {
  const mesh = new THREE.Mesh(geo, mat);
  const api = {
    mesh,
    pos(x, y, z)     { mesh.position.set(x, y, z); return api; },
    rot(x, y, z)     { mesh.rotation.set(x, y, z); return api; },
    scl(x, y, z)     { if (y === undefined) mesh.scale.setScalar(x); else mesh.scale.set(x, y, z); return api; },
    shadow(on = true){ mesh.castShadow = on; return api; },
    receive(on = true){ mesh.receiveShadow = on; return api; },
    visible(v)       { mesh.visible = v; return api; },
    name(n)          { mesh.name = n; return api; },
  };
  return api;
}

// ---------------------------------------------------------------------------
// group(): assemble several parts (or raw meshes) into a THREE.Group that can
// be positioned/rotated/scaled as a unit. Returns a plain Group — use .pos etc
// directly on it, or pass to ModelBuilder.addGroup().
// ---------------------------------------------------------------------------
export function group(...items) {
  const g = new THREE.Group();
  for (const item of items) g.add(item.mesh || item);
  return g;
}

// ---------------------------------------------------------------------------
// ModelBuilder: assembles a model from parts, tracks named parts for animation
// access, and packages everything into userData on build().
//
// userData fields after build():
//   .body   — the Group containing all parts (animate this for bob/rotation)
//   .named  — { name: Object3D } map of named parts for animation access
//   .anim   — arbitrary data object passed to the animation function
//   .mats   — array of team-colored materials (for damage flash)
// ---------------------------------------------------------------------------
export class ModelBuilder {
  constructor() {
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    this.named = {};
    this.anim = {};
    this.mats = [];
  }

  // Add a part (or raw Object3D) to the body. If `name` is given, the part is
  // stored in .named[name] for animation access.
  add(item, name) {
    const obj = item.mesh || item;
    this.body.add(obj);
    if (name) this.named[name] = obj;
    return this;
  }

  // Add a Group to the body (use for compound parts like gun assemblies).
  addGroup(g, name) {
    this.body.add(g);
    if (name) this.named[name] = g;
    return this;
  }

  // Set the animation data object. Must include a `kind` field matching the
  // registered animation function.
  setAnim(data) { this.anim = data; return this; }

  // Register a team-colored material for damage flashing.
  addMat(mat) { this.mats.push(mat); return this; }

  // Lift the body's children so the lowest point rests near `floor`. Use for
  // ground units so feet/pods don't sink into the terrain.
  liftToGround(floor = -0.03) {
    this.body.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(this.body);
    if (bb.min.y < floor) {
      const dy = floor - bb.min.y;
      for (const c of this.body.children) c.position.y += dy;
    }
    return this;
  }

  // Finalize and return the root Group with all userData set.
  build() {
    this.root.userData.body = this.body;
    this.root.userData.named = this.named;
    this.root.userData.anim = this.anim;
    this.root.userData.mats = this.mats;
    return this.root;
  }
}

// ---------------------------------------------------------------------------
// BuildingHelper: wraps a ModelBuilder to add building-specific concerns —
// auto-fit to tile footprint and construction scaffold.
// ---------------------------------------------------------------------------
export function wrapBuilding(built, size, scaffoldMat, G) {
  const group = new THREE.Group();
  const fit = new THREE.Group();

  // Auto-fit: scale down if the model overflows its tile footprint
  built.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(built);
  const halfXZ = Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x),
                          Math.abs(bb.min.z), Math.abs(bb.max.z));
  const target = size / 2 - 0.1;
  if (halfXZ > target) fit.scale.setScalar(target / halfXZ);
  fit.add(built);
  group.add(fit);

  // Construction scaffold: four corner posts, hidden once built
  const scaffold = new THREE.Group();
  const half = size / 2 - 0.15;
  for (const [sx, sz] of [[half, half], [-half, half], [half, -half], [-half, -half]]) {
    const post = new THREE.Mesh(G.scaffold, scaffoldMat);
    post.position.set(sx, 0.5, sz);
    scaffold.add(post);
  }
  group.add(scaffold);

  group.userData.built = built;
  group.userData.scaffold = scaffold;
  return group;
}
