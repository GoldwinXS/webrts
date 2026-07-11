// Instanced 3D "cliff dressing": chunky low-poly ROCK slabs, lip stones and
// corner crags that hug every cliff face so the walls read as convincing rock
// instead of a stretched textured quad on a tile-resolution silhouette.
//
// WHY THIS EXISTS
// ---------------
// The terrain is one displaced quad per tile (see renderer.buildGround) plus a
// painted cliff texture (paintTerrain section 5). At tile resolution the wall
// is a single stretched, textured quad — from the play camera it reads as an
// extruded square, not a cliff. Paint can't fix geometry. This module ADDS
// geometry on top of the existing painted wall (which becomes the grout between
// the rocks); it replaces nothing.
//
// The look matches the barrier props (js/render/models/props.js barrierMaterials
// + renderer.buildBarriers): shared BufferGeometries, one THREE.InstancedMesh
// per geometry+material combo, the propToon stepped-toon material, deterministic
// per-tile jitter (a pure integer hash, NEVER Math.random), receive + cast
// shadows. Built ONCE at load — the map is static.
//
// Everything needed from the sim map is read locally here (rock/height
// Uint8Arrays, w/h) and the constants that mirror the renderer (HSCALE) are
// duplicated so this file stays fully self-contained.

import * as THREE from "three";
import { propToon, toonGradient } from "./models/core.js";

const HSCALE = 1.2;   // world units of elevation per height level (mirrors renderer.js:25)

// ---------------------------------------------------------------------------
// Deterministic per-tile hash -> float in [0,1). NO Math.random: the map is
// shared across multiplayer peers and the dressing must be byte-identical.
// Integer-mixed (xorshift-ish) so successive salts on the same tile decorrelate.
// ---------------------------------------------------------------------------
function hash01(x, y, s) {
  let h = (x * 0x9E3779B1 + y * 0x85EBCA6B + s * 0xC2B2AE35) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D) | 0;
  h = Math.imul(h ^ (h >>> 13), 0x297A2D39) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

// ---------------------------------------------------------------------------
// Shared low-poly rock geometries. Created once, reused across every instance.
// Kept deliberately chunky and few-sided to sit with the toy/toon aesthetic.
//   slab  : the workhorse wall plate — a box, tiled in a stack-and-column grid
//           to fully clad each exposed vertical face foot-to-lip (no wall-quad
//           left visible); scaled per-instance for chunky organic variety.
//   chunk : a smaller angular rock (an icosahedron reads as a faceted stone)
//           for the top lip / rubble at the base.
//   crag  : a tapered spike (cone, few sides) for skyline variety at corners.
//   lip   : a rounded overhang stone (dodecahedron) for the top rim.
// Module scope so they survive across (re)builds and are disposed explicitly.
// ---------------------------------------------------------------------------
const GEO = {
  slab: new THREE.BoxGeometry(0.62, 1.0, 0.5),         // unit-tall; y-scaled per wall
  chunk: new THREE.IcosahedronGeometry(0.32, 0),       // faceted rubble stone
  lip: new THREE.DodecahedronGeometry(0.34, 0),        // rounded rim boulder
  crag: new THREE.ConeGeometry(0.26, 1.0, 5),          // 5-sided skyline spike
};

// Theme -> rock tint palette, mirroring how barrierMaterials derives from the
// theme. We want the same three biome moods the user described:
//   verdant -> mossy grey, ashen -> ashen red-brown, frozen -> frozen blue-grey.
// Base off theme.cliff (the wall hex) and pull toward a per-biome rock tone so
// the dressing sits tonally with the painted wall underneath but reads as solid
// stone. Two shades (light face / dark base) give the toon ramp room to band.
function cliffPalette(theme) {
  const name = theme.name;
  // face (sunlit rock) and deep (shadowed base) hex per biome
  const face = name === "ashen" ? 0xb07852
             : name === "frozen" ? 0x9fb0c4
             : 0x8f9a86;                                 // verdant mossy grey
  const deep = name === "ashen" ? 0x744528
             : name === "frozen" ? 0x64748a
             : 0x5c6650;                                 // verdant deep moss
  // a faint biome emissive keeps them from going muddy in shadow, matching the
  // gentle emissive barriers carry (canopy/ice). Tiny — never blooms.
  return {
    face: propToon({ color: face }),
    deep: propToon({ color: deep }),
  };
}

// ---------------------------------------------------------------------------
// buildCliffDressing(scene, map, theme, heightAt)
//   scene    : THREE.Scene to add the instanced meshes to
//   map      : sim.map — reads { w, h, rock, height, rampTiles }
//   theme    : THEMES[...] entry — reads { name } (palette derived above)
//   heightAt : (wx,wz) => worldY bilinear sampler (renderer.heightAt, bound)
//
// Returns a disposable handle { group, dispose() }. The InstancedMeshes are
// added to `scene` directly (like buildBarriers) AND tracked on the handle so
// dispose() can remove + free them. A `group` is also provided (empty parent
// kept for API symmetry / future toggling) — the meshes are parented to it so a
// single scene.remove(group) also works.
// ---------------------------------------------------------------------------
export function buildCliffDressing(scene, map, theme, heightAt) {
  const w = map.w, h = map.h;
  const rock = map.rock, height = map.height;
  const rampTiles = map.rampTiles;   // may be undefined on older maps

  const group = new THREE.Group();
  group.name = "cliffDressing";
  scene.add(group);

  // No height field -> flat map -> nothing to dress.
  if (!height || !rock) return { group, dispose() { scene.remove(group); } };

  const lvlAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : height[y * w + x];
  const rockAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : rock[y * w + x];
  const rampAt = (x, y) => (!rampTiles || x < 0 || y < 0 || x >= w || y >= h) ? 0 : rampTiles[y * w + x];

  // Cliff-face rule: identical to paintTerrain / buildBarriers so we dress
  // exactly the tiles the wall texture paints. A rock tile that borders a lower
  // (or differing, when raised) tile is a wall.
  const isCliffFace = (x, y) => {
    if (!rockAt(x, y)) return false;
    const l = lvlAt(x, y);
    return lvlAt(x - 1, y) < l || lvlAt(x + 1, y) < l ||
           lvlAt(x, y - 1) < l || lvlAt(x, y + 1) < l ||
           (l > 0 && (lvlAt(x - 1, y) !== l || lvlAt(x + 1, y) !== l ||
                      lvlAt(x, y - 1) !== l || lvlAt(x, y + 1) !== l));
  };

  // A neighbour direction "drops away" (exposes a face on that side) if it is
  // lower non-face ground OR open/passable ground. Matches paintTerrain's
  // `drops`/`lowerOrOpen` so rocks face the same way the painted strat band does.
  const dropsFrom = (x, y, nx, ny) => {
    const l = lvlAt(x, y);
    return (lvlAt(nx, ny) < l && !isCliffFace(nx, ny)) || !rockAt(nx, ny);
  };

  // RAMP PROTECTION. Ramp mouths must stay clear: never place rock on a ramp
  // tile, on a tile adjacent to a ramp, or overhanging the tile directly in
  // front of a ramp (a unit's path onto the high ground). We forbid dressing a
  // face tile if it, or any 8-neighbour, is a ramp — and additionally clip any
  // outward-leaning instance whose landing tile is a ramp (belt & suspenders).
  const nearRamp = (x, y) => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (rampAt(x + dx, y + dy)) return true;
    return false;
  };

  // The four cardinal neighbour offsets (index chosen so 0=+x,1=-x,2=+z,3=-z).
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // ---- pose accumulators, one list per (geometry, material) combo ----------
  const slabFace = [], slabDeep = [];   // main wall slabs (two shades)
  const lipStone = [];                  // top-edge rim stones
  const baseRubble = [];                // small chunks at the wall foot
  const cragSpike = [];                 // corner skyline crags

  // reusable temporaries for pose math
  const push = (list, x, y, z, s, rx, ry, rz) =>
    list.push({ x, y, z, s, rx: rx || 0, ry: ry || 0, rz: rz || 0 });

  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      if (!isCliffFace(tx, ty)) continue;
      if (nearRamp(tx, ty)) continue;               // keep ramp mouths clear

      const l = lvlAt(tx, ty);
      const cxw = tx + 0.5, czw = ty + 0.5;         // tile center world
      // plateau-top world Y at this tile (where the wall's TOP lip sits)
      const topY = heightAt(cxw, czw);

      // Which cardinal sides drop away? Collect them; the wall height on each
      // side = (this level - neighbour level) * HSCALE (>=1 level).
      let dropCount = 0;
      for (let di = 0; di < 4; di++) {
        const [dx, dz] = DIRS[di];
        const nx = tx + dx, nz = ty + dz;
        if (!dropsFrom(tx, ty, nx, nz)) continue;
        dropCount++;

        // neighbour ground level (open ground counts as its own level, which may
        // be same-or-lower; clamp wall height to at least one step so isolated
        // raised-rock rings still get a visible chunk).
        const nl = rockAt(nx, nz) ? lvlAt(nx, nz) : lvlAt(nx, nz);
        const levels = Math.max(1, l - nl);
        const wallH = levels * HSCALE;               // world height of this face

        // Outward normal (points from tile center toward the dropping side).
        const ox = dx, oz = dz;

        // Skip if the tile the rocks would lean OUT over is a ramp (extra guard
        // beyond nearRamp — a diagonal ramp could sit just past a cardinal drop).
        if (rampAt(nx, nz)) continue;

        // ---- FULL-FACE SLAB CLADDING (the primary deliverable) --------------
        // Clad the ENTIRE exposed vertical face in stacked, overlapping rock
        // slabs from foot to lip so NO stretched wall-quad shows from the play
        // camera or from low angles. This is a grid of slabs:
        //   * COLUMNS across the tile edge (the tangent axis) — 2 columns per
        //     tile edge, offset half a slab, so the ~1.0-wide edge is fully
        //     covered with overlap and no vertical seam.
        //   * ROWS up the wall — one row per ~0.9 world units of wall height, so
        //     a 1-level wall (1.2u) gets ~2 rows, a 3-level wall (3.6u) ~5 rows;
        //     rows overlap vertically (each ~1.0u tall covering a ~0.75u band).
        // Slabs sit slightly PROUD of the wall plane (0.05..0.15 outward past the
        // 0.5 tile edge) so they never z-fight the terrain quad, and lean gently
        // outward. Deterministic jitter (hash, never Math.random) on position/
        // rotation/scale keeps it chunky-organic, not a brick wall.
        const tangent = [dz, -dx];                   // in-plane perpendicular (unit)
        const yaw = Math.atan2(ox, oz);              // orient broad slab face outward
        const nCols = 2;                             // columns across the tile edge
        const rows = Math.max(2, Math.round(wallH / 0.82)); // rows up the wall
        const rowH = wallH / rows;                   // world height each row covers
        for (let cc = 0; cc < nCols; cc++) {
          // column center along the edge; two columns straddle the tile center,
          // each offset so their slabs overlap at the seam (0.62-wide slab over a
          // 0.5-wide half means neighbours and columns all overlap -> continuous).
          const colAlong = (cc - (nCols - 1) / 2) * 0.34;
          for (let rr = 0; rr < rows; rr++) {
            const s = di * 97 + cc * 31 + rr * 7;    // salt unique per slab
            // vertical center of this row band, jittered a touch so rows aren't
            // a dead-level masonry course.
            const bandCenter = topY - (rr + 0.5) * rowH;
            const jy = (hash01(tx, ty, s + 1) - 0.5) * rowH * 0.3;
            const midY = bandCenter + jy;
            // along-edge jitter, brick-offset alternate rows so vertical seams
            // between the two columns don't line up floor-to-ceiling.
            const brick = (rr & 1) ? 0.17 : 0;
            const jt = (hash01(tx, ty, s + 2) - 0.5) * 0.22;
            const along = colAlong + brick + jt;
            // PROUD of the wall plane: edge is 0.5 out; push 0.05..0.15 further.
            const outset = 0.5 + 0.05 + hash01(tx, ty, s + 3) * 0.10;
            const wx = cxw + ox * outset + tangent[0] * along;
            const wz = czw + oz * outset + tangent[1] * along;
            // slab dimensions: wide enough to overlap its neighbours, tall enough
            // to overlap the row above/below (rowH * ~1.5), depth shallow (it's a
            // facing plate hugging the wall). Deterministic size variety.
            const sx = 0.5 + hash01(tx, ty, s + 4) * 0.34;   // width along edge
            const sy = rowH * (1.35 + hash01(tx, ty, s + 5) * 0.5); // overlaps rows
            const sz = 0.34 + hash01(tx, ty, s + 6) * 0.28;  // shallow depth
            // gentle outward lean so the face isn't a flat wall; top tips out.
            const lean = 0.05 + hash01(tx, ty, s + 7) * 0.12;
            const rx = oz * lean;
            const rz = -ox * lean;
            const ry = yaw + (hash01(tx, ty, s + 8) - 0.5) * 0.45;
            const list = (hash01(tx, ty, s) < 0.5) ? slabFace : slabDeep;
            push(list, wx, midY, wz, new THREE.Vector3(sx, sy, sz), rx, ry, rz);
          }
        }

        // ---- rubble CHUNK at the wall foot (breaks the base line) ------------
        if (hash01(tx, ty, di * 37 + 2) < 0.7) {
          const fx = cxw + ox * (0.46 + hash01(tx, ty, di + 40) * 0.1)
                   + tangent[0] * (hash01(tx, ty, di + 41) - 0.5) * 0.4;
          const fz = czw + oz * (0.46 + hash01(tx, ty, di + 42) * 0.1)
                   + tangent[1] * (hash01(tx, ty, di + 43) - 0.5) * 0.4;
          const footY = heightAt(fx, fz);            // sits on the LOWER ground
          const s = 0.4 + hash01(tx, ty, di + 44) * 0.35;
          push(baseRubble, fx, footY + s * 0.28 - 0.06, fz,
            new THREE.Vector3(s, s * (0.7 + hash01(tx, ty, di + 45) * 0.3), s),
            (hash01(tx, ty, di + 46) - 0.5) * 0.6,
            hash01(tx, ty, di + 47) * Math.PI * 2,
            (hash01(tx, ty, di + 48) - 0.5) * 0.6);
        }
      }

      // ---- TOP LIP row: a rounded rim stone overhanging the plateau edge -----
      // Only where the tile actually has an exposed side, so the silhouette from
      // the 53deg play camera is broken rock, not a straight tile line. Placed
      // toward the "average" drop direction so it overhangs the exposed corner.
      if (dropCount > 0) {
        // average outward direction across dropping sides
        let ax = 0, az = 0;
        for (let di = 0; di < 4; di++) {
          const [dx, dz] = DIRS[di];
          if (dropsFrom(tx, ty, tx + dx, ty + dz)) { ax += dx; az += dz; }
        }
        const al = Math.hypot(ax, az) || 1;
        ax /= al; az /= al;
        const lx = cxw + ax * (0.32 + hash01(tx, ty, 60) * 0.12);
        const lz = czw + az * (0.32 + hash01(tx, ty, 61) * 0.12);
        // don't overhang a ramp landing
        if (!rampAt(Math.floor(lx), Math.floor(lz))) {
          const s = 0.5 + hash01(tx, ty, 62) * 0.35;
          push(lipStone, lx, topY - 0.04, lz,
            new THREE.Vector3(s, s * 0.7, s),
            (hash01(tx, ty, 63) - 0.5) * 0.5,
            hash01(tx, ty, 64) * Math.PI * 2,
            (hash01(tx, ty, 65) - 0.5) * 0.5);
        }

        // ---- CRAG spike at CONVEX (outward) corners for skyline variety ------
        // A convex corner: two adjacent cardinal sides both drop away (the tile
        // juts out). Occasional (hash-gated) tall spike there.
        const convex =
          (dropsFrom(tx, ty, tx + 1, ty) && dropsFrom(tx, ty, tx, ty + 1)) ||
          (dropsFrom(tx, ty, tx + 1, ty) && dropsFrom(tx, ty, tx, ty - 1)) ||
          (dropsFrom(tx, ty, tx - 1, ty) && dropsFrom(tx, ty, tx, ty + 1)) ||
          (dropsFrom(tx, ty, tx - 1, ty) && dropsFrom(tx, ty, tx, ty - 1));
        if (convex && hash01(tx, ty, 70) < 0.35) {
          const cs = 0.5 + hash01(tx, ty, 71) * 0.4;
          const chgt = 1.1 + hash01(tx, ty, 72) * 1.3;    // taller than the wall
          push(cragSpike, cxw + ax * 0.2, topY + chgt * 0.5 - 0.3, czw + az * 0.2,
            new THREE.Vector3(cs, chgt, cs),
            (hash01(tx, ty, 73) - 0.5) * 0.3,
            hash01(tx, ty, 74) * Math.PI * 2,
            (hash01(tx, ty, 75) - 0.5) * 0.3);
        }
      }
    }
  }

  // ---- materials (one palette build; two shades share across all meshes) ----
  const pal = cliffPalette(theme);
  const meshes = [];

  // helper: build one InstancedMesh from a pose list, add to group, track it.
  const M = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const V = new THREE.Vector3();
  const E = new THREE.Euler();
  const buildInst = (geo, mat, poses, cast = true) => {
    if (!poses.length) return;
    const inst = new THREE.InstancedMesh(geo, mat, poses.length);
    inst.castShadow = cast;
    inst.receiveShadow = true;
    inst.frustumCulled = false;
    for (let i = 0; i < poses.length; i++) {
      const p = poses[i];
      E.set(p.rx, p.ry, p.rz);
      Q.setFromEuler(E);
      V.set(p.x, p.y, p.z);
      M.compose(V, Q, p.s);
      inst.setMatrixAt(i, M);
    }
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
    meshes.push(inst);
  };

  buildInst(GEO.slab, pal.face, slabFace);
  buildInst(GEO.slab, pal.deep, slabDeep);
  buildInst(GEO.lip, pal.face, lipStone);
  buildInst(GEO.chunk, pal.deep, baseRubble);
  buildInst(GEO.crag, pal.face, cragSpike);

  return {
    group,
    // count exposed for desk-checking / tests
    instanceCount: slabFace.length + slabDeep.length + lipStone.length +
                   baseRubble.length + cragSpike.length,
    dispose() {
      for (const m of meshes) {
        group.remove(m);
        m.dispose?.();               // frees the per-instance matrix buffer
      }
      // materials are per-handle (built above), safe to dispose here.
      pal.face.dispose?.();
      pal.deep.dispose?.();
      scene.remove(group);
      // NOTE: shared GEO.* geometries are module-scoped and intentionally NOT
      // disposed (they may be reused by a subsequent map build).
    },
  };
}
