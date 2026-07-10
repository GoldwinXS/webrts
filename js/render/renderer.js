// Three.js presentation layer. Reads sim state every frame, owns no game
// logic. Interpolates between the last two sim ticks for smooth motion.
// v2: shadows, ACES + bloom, procedural terrain, animated models, effects.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { FP, HALF, fpToTile } from "../core/fixed.js";
import { makeRng } from "../core/fixed.js";
import { BUILDINGS, PLAYER_COLORS } from "../core/data.js";
import { RtsCamera } from "./camera.js";
import { makeUnitVisual, makeBuildingVisual, makeMineralVisual, makeGeyserVisual, makeShrubVisual, animateVisual, animateShrub, SHARED, propToon, toonGradient, barrierMaterials } from "./models/index.js";
import { UNITS } from "../core/data.js";
import { THEMES } from "../core/map.js";
import { Effects } from "./fx.js";

const W2 = (v) => v / FP;   // fp -> world units (1 tile = 1.0)
const PX = 32;              // ground texture pixels per tile (32px seamless tiles)
const HSCALE = 1.2;         // world units of elevation per height level

// clamp a 0..255 channel
const CH = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
// lighten/shift an [r,g,b] toward white by k (0..1) — for stepped elevation tones
const lift = (c, k) => [CH(c[0] + (255 - c[0]) * k), CH(c[1] + (255 - c[1]) * k), CH(c[2] + (255 - c[2]) * k)];
const rgbStr = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
const hexToRgb = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
// Deterministic hash for pixel-art tile textures -- same input = same shade,
// so the PXxPX pattern repeats identically on every tile (Minecraft-style).
const pixHash = (x, y) => {
  let h = (x * 0x9E3779B1 + y * 0x85EBCA6B) | 0;
  h = (h ^ (h >>> 16)) | 0;
  h = Math.imul(h, 0x9E3779B1) | 0;
  return (h ^ (h >>> 15)) >>> 0;
};
// Proportional shade: k>0 lightens toward white, k<0 darkens by multiplying.
const shade = (c, k) => k >= 0
  ? lift(c, k)
  : [CH(c[0] * (1 + k)), CH(c[1] * (1 + k)), CH(c[2] * (1 + k))];

export class Renderer {
  constructor(canvas, sim, localPlayer) {
    this.sim = sim;
    this.localPlayer = localPlayer;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;   // brighter palette -> less exposure

    this.theme = THEMES[sim.map.theme || 0] || THEMES[0];
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.theme.sky);
    this.scene.fog = new THREE.Fog(this.theme.fog, 55, 150);

    const start = sim.map.starts[localPlayer];
    this.camera = new RtsCamera(sim.map.w, sim.map.h, start.x, start.y);

    this.meshes = new Map();          // entity id -> visual group
    this.selection = new Set();       // set by input.js
    this.playerColors = PLAYER_COLORS.map((c) => new THREE.Color(c));
    this.flashes = new Map();         // entity id -> remaining flash seconds
    this.moveAmt = new Map();         // entity id -> smoothed motion 0..1
    this.clockStart = performance.now();

    this.buildHeightGrid();
    this.buildLights();
    this.buildGround();
    this.buildBarriers();
    this.buildDecos();
    this.buildSky();      // bright daytime gradient dome (replaces deep-space stars)
    this.fx = new Effects(this.scene);
    this.fx.heightAt = (x, z) => this.heightAt(x, z);

    // Selection: white reads on every bright biome (the old 0x7cff6b green was
    // near-isoluminant with verdant grass). Order feedback uses DEEP ink tones.
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false });
    this.barBgMat = new THREE.MeshBasicMaterial({ color: 0x10141a });
    this.fatLineMats = [];   // LineMaterial instances needing resolution updates on resize
    this.buildRallyPool();
    this.buildQueuePaths();
    this.buildTargetRings();
    this.buildPlacementGrid();
    this.taskFxTimers = new Map();   // entity id -> next spark time (render-only)

    // post-processing: MSAA target + bloom (threshold 1.0 = only HDR emissive blooms)
    const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { samples: 4, type: THREE.HalfFloatType });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera.cam));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.55, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.updateLineResolution();   // fat lines need an initial resolution before first frame

    window.addEventListener("resize", () => {
      this.camera.resize();
      this.renderer.setSize(innerWidth, innerHeight);
      this.composer.setSize(innerWidth, innerHeight);
      this.updateLineResolution();
    });
  }

  // Fat lines (Line2/LineMaterial) need their pixel resolution kept in sync
  // with the actual render target size, or their world-space width computation
  // is wrong. Called on init and on every resize. this.fatLineMats is filled
  // in by each buildXxx() that creates a LineMaterial.
  updateLineResolution() {
    if (!this.fatLineMats) return;
    for (const m of this.fatLineMats) m.resolution.set(innerWidth, innerHeight);
  }

  buildLights() {
    // Toon pass: raised ambient lifts shadow floors (softer, lighter shadows)
    // so the stepped gradient ramps read as clean bands, not muddy darkness.
    this.scene.add(new THREE.AmbientLight(0xd2e4f5, 1.05));  // bright sky ambient
    const sun = new THREE.DirectionalLight(0xffefd2, 1.6);   // warm key light
    sun.position.set(this.sim.map.w * 0.3, 42, this.sim.map.h * 0.15);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -30; c.right = 30; c.top = 30; c.bottom = -30;
    c.near = 5; c.far = 130;
    sun.shadow.bias = -0.0006;
    // lighter shadow: don't let shadowed terrain go fully dark
    this.renderer.shadowMap.enabled = true;
    sun.target.position.set(this.sim.map.w / 2, 0, this.sim.map.h / 2);
    this.scene.add(sun, sun.target);
    this.sun = sun;
    const fill = new THREE.DirectionalLight(0x9fb6d8, 0.55); // soft sky fill
    fill.position.set(-25, 28, -32);
    this.scene.add(fill);
  }

  // Soft daytime sky: a big inverted gradient dome (zenith sky color -> horizon
  // fog color) so the horizon blends seamlessly into the Fog-faded terrain.
  // Replaces the old deep-space starfield to match the bright Chibi Sci-Fi look.
  buildSky() {
    const R = 165;
    const geo = new THREE.SphereGeometry(R, 24, 16);
    const horizon = new THREE.Color(this.theme.fog);
    const zenith = new THREE.Color(this.theme.sky).lerp(new THREE.Color(0xffffff), 0.10);
    // per-theme warm horizon glow band: golden over verdant fields, ember over
    // ash, cold peach sun over ice — gives the skyline a time-of-day feel
    const glow = new THREE.Color(this.theme.name === "ashen" ? 0xffb27a
               : this.theme.name === "frozen" ? 0xffd9c2 : 0xffe9b0);
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = Math.max(0, Math.min(1, (pos.getY(i) / R + 0.12) / 0.85));
      c.copy(horizon).lerp(zenith, t);
      // low-band glow, strongest right at the horizon, gone by mid-sky
      const g = Math.max(0, 0.35 - t) / 0.35;
      c.lerp(glow, g * g * 0.55);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
    }));
    dome.position.set(this.sim.map.w / 2, 0, this.sim.map.h / 2);
    dome.frustumCulled = false;
    this.scene.add(dome);
  }

  // ---------- terrain ----------

  // Build a per-tile-corner height grid ((w+1)*(h+1)) in world units from the
  // sim's integer tile height field. Each corner samples the max of its four
  // adjacent tiles, then a light box blur softens ramps into slopes while
  // cliff faces (large corner-to-corner deltas) stay reasonably crisp.
  buildHeightGrid() {
    const { w, h, height } = this.sim.map;
    const gw = w + 1, gh = h + 1;
    this.gw = gw; this.gh = gh;
    const raw = new Float32Array(gw * gh);
    const lvl = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : (height ? height[y * w + x] : 0);
    for (let cy = 0; cy < gh; cy++) {
      for (let cx = 0; cx < gw; cx++) {
        // corner (cx,cy) touches tiles (cx-1,cy-1)..(cx,cy)
        const m = Math.max(lvl(cx - 1, cy - 1), lvl(cx, cy - 1), lvl(cx - 1, cy), lvl(cx, cy));
        raw[cy * gw + cx] = m * HSCALE;
      }
    }
    // Crisper cliff profile: keep plateaus dead flat and steepen faces by
    // smoothing ONLY corners that sit in a gentle (<=1 level) transition. A
    // corner straddling a >=2-level jump (a real cliff wall) keeps its raw max
    // height so the wall stays vertical and tall. This tightens the blur so
    // 0..3 elevation reads as clean stepped terraces.
    const grid = new Float32Array(gw * gh);
    const step = HSCALE;
    for (let cy = 0; cy < gh; cy++) {
      for (let cx = 0; cx < gw; cx++) {
        // local relief around this corner (max - min of the 3x3 raw window)
        let lo = Infinity, hi = -Infinity;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
            const v = raw[y * gw + x];
            if (v < lo) lo = v; if (v > hi) hi = v;
          }
        const relief = hi - lo;
        if (relief > step * 1.5) {
          // cliff wall: no blur, keep the crisp raw height (vertical face)
          grid[cy * gw + cx] = raw[cy * gw + cx];
          continue;
        }
        // gentle slope / ramp: strong center weight keeps plateaus flat while
        // softening single-level transitions into walkable slopes.
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
            const wt = (dx === 0 && dy === 0) ? 6 : 1;
            sum += raw[y * gw + x] * wt; n += wt;
          }
        grid[cy * gw + cx] = sum / n;
      }
    }
    this.heightGrid = grid;
  }

  // Bilinear sample of the corner height grid at world coords (wx,wz). Corner
  // (cx,cy) sits at world (cx,cy); tile centers therefore land mid-cell.
  heightAt(wx, wz) {
    const gw = this.gw, gh = this.gh;
    if (!this.heightGrid) return 0;
    let x = wx, z = wz;
    if (x < 0) x = 0; else if (x > gw - 1) x = gw - 1;
    if (z < 0) z = 0; else if (z > gh - 1) z = gh - 1;
    const x0 = x | 0, z0 = z | 0;
    const x1 = Math.min(gw - 1, x0 + 1), z1 = Math.min(gh - 1, z0 + 1);
    const fx = x - x0, fz = z - z0;
    const g = this.heightGrid;
    const a = g[z0 * gw + x0], b = g[z0 * gw + x1];
    const c = g[z1 * gw + x0], d = g[z1 * gw + x1];
    const top = a + (b - a) * fx;
    const bot = c + (d - c) * fx;
    return top + (bot - top) * fz;
  }

  // Discrete flat height of the tile under a world point. Buildings and
  // resources sit on this (not the smoothed heightAt) so they stay level
  // instead of tilting onto the smoothed cliff-edge slope.
  tileFlatHeight(wx, wz) {
    const H = this.sim.map.height;
    if (!H) return 0;
    const w = this.sim.map.w, h = this.sim.map.h;
    let tx = wx | 0, tz = wz | 0;
    if (tx < 0) tx = 0; else if (tx >= w) tx = w - 1;
    if (tz < 0) tz = 0; else if (tz >= h) tz = h - 1;
    return H[tz * w + tx] * HSCALE;
  }

  buildGround() {
    const { w, h } = this.sim.map;
    // static terrain painted once; fog composited over it on updates
    this.baseCanvas = document.createElement("canvas");
    this.baseCanvas.width = w * PX;
    this.baseCanvas.height = h * PX;
    this.paintTerrain();

    this.groundCanvas = document.createElement("canvas");
    this.groundCanvas.width = w * PX;
    this.groundCanvas.height = h * PX;
    this.groundTex = new THREE.CanvasTexture(this.groundCanvas);
    this.groundTex.colorSpace = THREE.SRGBColorSpace;
    this.groundTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    // Crisp pixel-art look: nearest sampling so the 32px tiles stay blocky
    // instead of being blurred by bilinear filtering (anisotropy preserved).
    this.groundTex.magFilter = THREE.NearestFilter;
    this.groundTex.minFilter = THREE.NearestFilter;
    this.groundTex.generateMipmaps = false;
    this.paintFog();

    // displaced grid: one quad per tile (w*h), vertices at tile corners so the
    // Y matches the height grid exactly. The ground texture still maps 1:1 over
    // the whole plane (uv preserved from PlaneGeometry).
    const geo = new THREE.PlaneGeometry(w, h, w, h);
    const pos = geo.attributes.position;
    const gw = this.gw;
    for (let i = 0; i < pos.count; i++) {
      // PlaneGeometry lays out verts row-major, x in [-w/2,w/2], y in [h/2,-h/2]
      const vx = pos.getX(i) + w / 2;               // 0..w corner x
      const vy = pos.getY(i);                        // plane-space y (pre-rotate)
      const cz = h / 2 - vy;                         // 0..h corner z
      const cx = Math.round(vx), cz2 = Math.round(cz);
      pos.setZ(i, this.heightGrid[cz2 * gw + cx]);   // displace along +Z (up after rotate)
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    // stepped-toon terrain: the painted canvas supplies color, the shared
    // gradient ramp supplies hard cartoon light bands.
    const mat = new THREE.MeshToonMaterial({ map: this.groundTex, gradientMap: toonGradient() });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(w / 2, 0, h / 2);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.lastFogPaint = -1;

    // ---- Goo overlay (Ooze faction creep) ----
    this.gooCanvas = document.createElement("canvas");
    this.gooCanvas.width = w * PX;
    this.gooCanvas.height = h * PX;
    this.gooTex = new THREE.CanvasTexture(this.gooCanvas);
    this.gooTex.colorSpace = THREE.SRGBColorSpace;
    this.gooTex.magFilter = THREE.NearestFilter;
    this.gooTex.minFilter = THREE.NearestFilter;
    this.gooTex.generateMipmaps = false;
    // Same displaced grid as the ground so the creep hugs ramps and stays
    // under cliff tops; depthTest lets terrain occlude it, polygonOffset
    // keeps it from z-fighting the ground it sits on.
    const gooGeo = new THREE.PlaneGeometry(w, h, w, h);
    const gooPos = gooGeo.attributes.position;
    for (let i = 0; i < gooPos.count; i++) {
      const vx = gooPos.getX(i) + w / 2;
      const cz = h / 2 - gooPos.getY(i);
      const cx = Math.round(vx), cz2 = Math.round(cz);
      gooPos.setZ(i, this.heightGrid[cz2 * gw + cx] + 0.05);
    }
    gooPos.needsUpdate = true;
    const gooMat = new THREE.MeshBasicMaterial({
      map: this.gooTex, transparent: true, opacity: 0.65,
      depthWrite: false, depthTest: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.gooPlane = new THREE.Mesh(gooGeo, gooMat);
    this.gooPlane.rotation.x = -Math.PI / 2;
    this.gooPlane.position.set(w / 2, 0, h / 2);
    this.gooPlane.renderOrder = 1;
    this.scene.add(this.gooPlane);
  }

  // Minecraft-style SEAMLESS tileable ground texture: a PXxPX pixel-art canvas
  // with deterministic per-pixel shade variation + theme-specific accents.
  // Every write wraps its coordinates modulo PX (via `set` below) so the left/
  // right and top/bottom edges match perfectly -> no visible seams when tiled.
  makeGroundTile(th, tone, detailSeed = 0) {
    const c = document.createElement("canvas");
    c.width = PX; c.height = PX;
    const tctx = c.getContext("2d");
    tctx.imageSmoothingEnabled = false;
    // detailSeed selects a DIFFERENT slice of the (still periodic) noise field
    // so content variants differ in their interior speckle/tuft layout, not
    // just orientation. The seed only shifts WHICH cells get shaded via a
    // constant offset added to the hash input; since the offset is constant
    // (not position-dependent), the field stays periodic at PX -> seamless.
    // A per-seed constant offset (in whole CELLs) also slides tuft positions.
    const sd = (detailSeed | 0);
    const noiseAt = (cx, cy) => pixHash(cx + sd * 101, cy + sd * 53) % 100;
    // wrapped 1px write: any x/y is folded back into [0,PX) so features that
    // spill off an edge reappear on the opposite edge -> seamless tiling.
    const set = (x, y, css) => {
      tctx.fillStyle = css;
      tctx.fillRect(((x % PX) + PX) % PX, ((y % PX) + PX) % PX, 1, 1);
    };

    // Base fill
    tctx.fillStyle = rgbStr(tone);
    tctx.fillRect(0, 0, PX, PX);

    // Per-pixel shade variation. pixHash is sampled on WRAPPED coordinates so
    // the noise field itself tiles: hash(0,y) == the pixel that neighbors
    // hash(PX-1,y) across the seam. (pixHash already only depends on x,y, and
    // x/y stay in [0,PX) here, so the field is inherently periodic at PX.)
    // Hand-painted color logic for the bright palette: flat darkening reads as
    // DIRT on sunny tones, so shadow cells are hue-shifted toward a saturated
    // per-biome shadow color (deep meadow green / terracotta / periwinkle) and
    // highlight cells toward a per-biome sunlight color. Saturated shadows are
    // what makes gouache/toy dioramas feel alive; gray shadows make mud.
    const mixC = (a, b, k) => [CH(a[0] + (b[0] - a[0]) * k), CH(a[1] + (b[1] - a[1]) * k), CH(a[2] + (b[2] - a[2]) * k)];
    const name = th.name;
    const shadowHue = name === "verdant" ? [46, 120, 70]      // deep meadow green
                    : name === "ashen"   ? [168, 88, 52]      // terracotta
                    :                      [120, 160, 214];   // periwinkle ice-shadow
    const sunHue    = name === "verdant" ? [214, 240, 170]    // warm chartreuse sun
                    : name === "ashen"   ? [255, 218, 152]    // late-afternoon sand
                    :                      [235, 248, 255];   // cool snow-light
    // Amplitudes gentler than the old dark-palette pass (bright bases need
    // less push to read), with the hue mixes doing the expressive work.
    const dark = rgbStr(mixC(shade(tone, -0.07), shadowHue, 0.18));
    const darker = rgbStr(mixC(shade(tone, -0.13), shadowHue, 0.26));
    const light = rgbStr(mixC(lift(tone, 0.05), sunHue, 0.12));
    const lighter = rgbStr(mixC(lift(tone, 0.08), sunHue, 0.18));
    // "Simple but detailed": paint the noise in coarse CELL blocks instead of
    // per-pixel. A CELL x CELL fill reads as a calm soft patch rather than TV
    // static, and holds up when the camera zooms out. Coverage is also lower
    // (~14% of cells shaded vs ~24% of pixels before), so the surface stays
    // clean. The cell grid divides PX evenly (32 / 2 = 16), so wrapping is
    // preserved and the field still tiles seamlessly.
    const CELL = 2;
    const fillCell = (cx, cy, css) => {
      for (let dy = 0; dy < CELL; dy++)
        for (let dx = 0; dx < CELL; dx++) set(cx + dx, cy + dy, css);
    };
    for (let cy = 0; cy < PX; cy += CELL) {
      for (let cx = 0; cx < PX; cx += CELL) {
        const v = noiseAt(cx, cy);
        if (v < 8) fillCell(cx, cy, dark);
        else if (v < 12) fillCell(cx, cy, light);
        else if (v < 14) fillCell(cx, cy, darker);
        else if (v < 15) fillCell(cx, cy, lighter);
      }
    }

    // Theme-specific pixel-art accents at fixed positions. Positions scaled up
    // for the 32px tile; ALL writes go through `set` so multi-pixel features
    // wrap cleanly across edges instead of being clipped. Every accent slides
    // by a per-seed CELL-agnostic offset so content variants differ; `set`
    // wraps, so shifted features stay seamless.
    if (name === "verdant") {
      // Grass blade tufts: short 2px verticals in a livelier meadow green
      // (color says "grass", brightness alone said "glint") plus one shadow
      // pixel at the foot so each blade sits IN the lawn instead of ON it.
      const tufts = [[9, 13], [22, 8], [15, 25]];
      const blade = rgbStr(mixC(lift(tone, 0.08), [150, 224, 120], 0.45));
      const root = rgbStr(mixC(shade(tone, -0.10), shadowHue, 0.30));
      const ox = (sd * 7) | 0, oy = (sd * 11) | 0;
      for (const [tx, ty] of tufts) {
        set(tx + ox, ty + oy, blade);
        set(tx + ox, ty + oy - 1, blade);
        set(tx + ox + 1, ty + oy, root);
      }
      // Tiny meadow blooms on HALF the content variants only — charm, not
      // confetti. A 2px petal pair (soft pink or butter yellow, both blended
      // 25% toward the grass so nothing reads as a stray white speck at RTS
      // zoom), a warm heart pixel, and a leaf pixel tying it to the ground.
      if (sd % 2 === 1) {
        const petal = (sd & 2) ? mixC([255, 190, 205], tone, 0.25)   // clover pink
                               : mixC([255, 224, 150], tone, 0.25);  // buttercup
        const petalCss = rgbStr(petal);
        const heart = rgbStr(mixC(petal, [226, 148, 92], 0.40));
        const leaf = rgbStr(mixC(shade(tone, -0.12), shadowHue, 0.30));
        const fx = 5 + ((sd * 13) % 20), fy = 4 + ((sd * 17) % 20);
        set(fx, fy, petalCss); set(fx + 1, fy, petalCss);
        set(fx, fy + 1, heart);
        set(fx + 1, fy + 1, leaf);
      }
    } else if (name === "ashen") {
      // Sunlit pebbles: 2x2 stones with a light sandy cap over a warm umber
      // underside — the two-tone pair reads as a lit pebble casting shade
      // (painted desert), where the old lone dark specks read as dirt flecks.
      const pebbles = [[8, 6], [22, 12], [5, 21], [18, 27]];
      const cap = rgbStr(mixC(lift(tone, 0.13), sunHue, 0.25));
      const under = rgbStr(mixC(shade(tone, -0.16), shadowHue, 0.35));
      const ox = (sd * 5) | 0, oy = (sd * 9) | 0;
      for (const [sx, sy] of pebbles) {
        set(sx + ox, sy + oy, cap); set(sx + ox + 1, sy + oy, cap);
        set(sx + ox, sy + oy + 1, under); set(sx + ox + 1, sy + oy + 1, under);
      }
      // One hairline crack in gentle warm umber — sunbaked clay shrinkage,
      // not scorched-earth fissure (old -0.40 black-brown was ember gloom).
      const crackCss = rgbStr(mixC(shade(tone, -0.20), [132, 72, 46], 0.40));
      const crack = [[11, 9], [12, 9], [13, 10], [14, 10], [15, 11]];
      for (const [cx, cy] of crack) set(cx + ox, cy + oy, crackCss);
    } else if (name === "frozen") {
      // Gentle sparkle diamonds: pastel cores LIFTED FROM THE LOCAL TONE
      // (never a fixed near-white — that glared on the bright base) with
      // softer arms, thinned 6 -> 4 so the ice shimmers instead of glinting.
      const sparkles = [[7, 9], [19, 15], [26, 25], [12, 28]];
      const core = rgbStr(mixC(lift(tone, 0.15), sunHue, 0.30));
      const arm = rgbStr(lift(tone, 0.08));
      const ox = (sd * 7) | 0, oy = (sd * 11) | 0;
      for (const [sx, sy] of sparkles) {
        set(sx + ox, sy + oy, core);
        set(sx + ox - 1, sy + oy, arm);
        set(sx + ox + 1, sy + oy, arm);
        set(sx + ox, sy + oy - 1, arm);
        set(sx + ox, sy + oy + 1, arm);
      }
      // A short meltwater vein: deeper pastel blue diagonal that gives the
      // glacier soft depth without reading as a crack in the toy.
      const vein = rgbStr(mixC(shade(tone, -0.09), [110, 156, 214], 0.35));
      const veinPts = [[3, 18], [4, 19], [5, 19], [6, 20]];
      for (const [vx, vy] of veinPts) set(vx + ox, vy + oy, vein);
    }
    return c;
  }

  // Build a set of seamless VARIANTS of a base tile so adjacent world tiles
  // aren't pixel-identical. Each variant = the base tone shifted by a small
  // brightness offset, re-rendered seamless, then drawn onto a fresh 32x32
  // canvas through one of 4 orientation transforms (identity, 90deg rotate,
  // mirror-X, 180deg rotate). Because the base is seamless, every rotation/
  // mirror of it is also seamless.
  makeTileVariants(th, tone) {
    // (brightnessOffset, transformIndex) pairs — 4 variants per level.
    // NOTE: all brightness offsets are 0. Per-tile brightness shifts made
    // adjacent tiles differ by a flat tonal step, producing hard seams at tile
    // boundaries (the "visible squares"). Orientation variety alone (identity /
    // rotate 90 / mirror-X / rotate 180) breaks up repetition WITHOUT any
    // tone jump, so tiles blend seamlessly.
    // 8 orientation variants (the full dihedral group of the square): the 4
    // rotations plus their mirrors. More distinct orientations means any given
    // base tile's repeat is pushed much further apart on screen, so the eye
    // can't lock onto a directional rhythm when zoomed out. All brightness
    // offsets stay 0 (per-tile tone steps caused the old "visible squares").
    // Two axes of variety, combined multiplicatively for a large effective
    // pool from a small bitmap set:
    //   * CONTENT variant (detailSeed): a handful of distinct interior detail
    //     layouts (different speckle + tuft positions), each still seamless.
    //   * ORIENTATION: the 8 dihedral transforms of the square.
    // CONTENT * ORIENTATION = 4 * 8 = 32 distinct seamless tiles per level.
    // Neighboring world tiles now differ in interior detail, not just rotation,
    // so the repeating rhythm visible at high camera elevation is broken up
    // while staying cheap (32 cached bitmaps per level, generated once).
    const CONTENT_VARIANTS = 4;
    const ORIENTATIONS = 8;
    const variants = [];
    for (let content = 0; content < CONTENT_VARIANTS; content++) {
      // detailSeed 0 keeps the original layout; 1..N are alternates.
      const base = this.makeGroundTile(th, tone, content);
      for (let xf = 0; xf < ORIENTATIONS; xf++) {
      const out = document.createElement("canvas");
      out.width = PX; out.height = PX;
      const octx = out.getContext("2d");
      octx.imageSmoothingEnabled = false;
      octx.save();
      switch (xf) {
        case 1: // rotate 90
          octx.translate(PX, 0); octx.rotate(Math.PI / 2); break;
        case 2: // rotate 180
          octx.translate(PX, PX); octx.rotate(Math.PI); break;
        case 3: // rotate 270
          octx.translate(0, PX); octx.rotate(-Math.PI / 2); break;
        case 4: // mirror-X
          octx.translate(PX, 0); octx.scale(-1, 1); break;
        case 5: // mirror-X then rotate 90
          octx.translate(PX, 0); octx.rotate(Math.PI / 2);
          octx.translate(PX, 0); octx.scale(-1, 1); break;
        case 6: // mirror-Y (mirror-X + rotate 180)
          octx.translate(0, PX); octx.scale(1, -1); break;
        case 7: // mirror-X then rotate 270
          octx.translate(0, PX); octx.rotate(-Math.PI / 2);
          octx.translate(PX, 0); octx.scale(-1, 1); break;
        default: break; // identity
      }
      octx.drawImage(base, 0, 0);
      octx.restore();
      variants.push(out);
      }
    }
    return variants;
  }

  // Deterministic 2D blue-noise index field over the w*h tile grid using a
  // Mitchell best-candidate ranking: repeatedly place the candidate (from a
  // seeded batch) that is farthest from all already-placed points, then assign
  // each placed point a rank; each grid cell's rank modulo N picks its variant.
  // Result: variant choices are evenly spread with no clumping / obvious rows.
  buildBlueNoise(w, h, seed) {
    const n = w * h;
    const idx = new Int32Array(n).fill(-1);   // placement order (rank) per cell
    const px = [], py = [];                    // placed coordinates
    const rng = makeRng((seed ^ 0x81b2e2b3) >>> 0);
    const rnd = () => rng() / 0xffffffff;
    // toroidal distance so the pattern also tiles across map edges
    const dist2 = (ax, ay, bx, by) => {
      let dx = Math.abs(ax - bx); if (dx > w / 2) dx = w - dx;
      let dy = Math.abs(ay - by); if (dy > h / 2) dy = h - dy;
      return dx * dx + dy * dy;
    };
    for (let placed = 0; placed < n; placed++) {
      // candidate pool grows with the count of placed points (Mitchell)
      const cand = Math.min(20, 1 + placed);
      let bestX = 0, bestY = 0, bestD = -1;
      for (let k = 0; k < cand; k++) {
        const cx = (rnd() * w) | 0, cy = (rnd() * h) | 0;
        if (idx[cy * w + cx] >= 0) continue;   // cell already taken
        // distance to nearest placed point (large if none placed yet)
        let nd = Infinity;
        for (let i = 0; i < px.length; i++) {
          const d = dist2(cx, cy, px[i], py[i]);
          if (d < nd) nd = d;
        }
        if (nd > bestD) { bestD = nd; bestX = cx; bestY = cy; }
      }
      // if the sampled candidates all landed on taken cells, scan for a free one
      if (bestD < 0 || idx[bestY * w + bestX] >= 0) {
        let found = false;
        for (let i = 0; i < n && !found; i++) {
          if (idx[i] < 0) { bestX = i % w; bestY = (i / w) | 0; found = true; }
        }
        if (!found) break;
      }
      idx[bestY * w + bestX] = placed;
      px.push(bestX); py.push(bestY);
    }
    return idx;   // rank per cell; caller does rank % variantCount
  }

  // Hand-painted stylized terrain: ZERO per-pixel noise. One saturated base
  // tone per elevation level (each level distinctly lighter), soft organic
  // color blobs for life, crisp dark outlines along cliff edges + barrier
  // blobs, a worn-path ramp treatment, and denser/darker losBlock tiles.
  paintTerrain() {
    const { w, h, rock, height } = this.sim.map;
    const ctx = this.baseCanvas.getContext("2d");
    const th = this.theme;
    const lvlAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : (height ? height[y * w + x] : 0);
    const rockAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : rock[y * w + x];

    // Defensive reads of the (possibly-not-yet-present) new map fields.
    const rampTiles = this.sim.map.rampTiles;     // Uint8Array | undefined
    const barrierKind = this.sim.map.barrierKind; // Uint8Array | undefined
    const losBlock = this.sim.map.losBlock;

    // A rock tile is a CLIFF FACE if it borders a lower-elevation tile (a real
    // height wall). Otherwise it's a flat-ground obstacle (a barrier blob).
    const isCliffFace = (x, y) => {
      if (!rockAt(x, y)) return false;
      const l = lvlAt(x, y);
      return lvlAt(x - 1, y) < l || lvlAt(x + 1, y) < l ||
             lvlAt(x, y - 1) < l || lvlAt(x, y + 1) < l ||
             // also treat a raised rock ring beside lower ground as a face
             (l > 0 && (lvlAt(x - 1, y) !== l || lvlAt(x + 1, y) !== l ||
                        lvlAt(x, y - 1) !== l || lvlAt(x, y + 1) !== l));
    };
    // Is this a ramp tile? Prefer the explicit field; else detect a passable
    // tile whose neighbors span two elevation levels (a height transition).
    const isRamp = (x, y) => {
      if (rampTiles) return rampTiles[y * w + x] !== 0;
      // fallback: a passable tile whose passable neighbors span >=2 elevation
      // levels is a walkable height transition (a ramp/slope).
      if (rockAt(x, y)) return false;
      let lo = Infinity, hi = -Infinity;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (rockAt(x + dx, y + dy)) continue;
        const nl = lvlAt(x + dx, y + dy);
        if (nl < lo) lo = nl; if (nl > hi) hi = nl;
      }
      return hi > lo;   // neighbors on two different passable levels
    };

    // Per-level base tones: lowland from theme.ground, each level up lightened
    // and hue-shifted toward theme.groundHi. cliff tops sit at the top step.
    const base = th.ground, hiTone = th.groundHi;
    const toneFor = (lvl) => {
      const t = Math.min(1, lvl / 3);                 // 0..1 across 0..3 levels
      // blend ground->groundHi by elevation, then add a per-step brightening
      const r = base[0] + (hiTone[0] - base[0]) * t;
      const g = base[1] + (hiTone[1] - base[1]) * t;
      const b = base[2] + (hiTone[2] - base[2]) * t;
      return lift([r, g, b], lvl * 0.10);
    };


    // ---- 1. Minecraft-style SEAMLESS tileable ground texture + variants ----
    // Per elevation level, pre-render a small set of seamless variant tiles
    // (subtle brightness + rotation/mirror). A deterministic blue-noise field
    // picks which variant each world tile stamps, so the grid of identical
    // tiles is broken up evenly with no clumping and no hard seams.
    const variantCache = [];
    for (let lvl = 0; lvl <= 3; lvl++)
      variantCache[lvl] = this.makeTileVariants(th, toneFor(lvl));
    const variantCount = variantCache[0].length;   // 32 (4 content x 8 orientations)
    const blueNoise = this.buildBlueNoise(w, h, this.sim.seed);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const lvl = Math.max(0, Math.min(3, lvlAt(x, y)));
        const vi = ((blueNoise[y * w + x] % variantCount) + variantCount) % variantCount;
        ctx.drawImage(variantCache[lvl][vi], x * PX, y * PX);
      }
    }

    // ---- 2b. shared overlay helpers ----
    // (The old translucent cliff-speckle pass here was entirely painted over
    // by the opaque cliff fill in section 5, and the old ramp pre-gradient by
    // section 6's opaque ramp tiles — so the visible rock-chip detail now
    // lives inside section 5 where it actually shows.)
    const texRng = makeRng(this.sim.seed ^ 0x7e57);
    const texRnd = () => texRng() / 0xffffffff;
    const tName = th.name;
    const mixT = (a, b, k) => [CH(a[0] + (b[0] - a[0]) * k), CH(a[1] + (b[1] - a[1]) * k), CH(a[2] + (b[2] - a[2]) * k)];

    // ---- 3. losBlock tiles: soft feathered shade, no hard tile boundary ------
    // Used to be a flat per-tile fillRect at 0.26 alpha, which painted a crisp
    // dark SQUARE under every vision-blocking doodad (shrubs etc.) — reads as
    // an ugly rectangular stain on the ground. A radial gradient centered on
    // each tile, feathered to zero alpha well inside the tile edge, gives a
    // soft shapeless pool of shade instead; overlapping neighbor tiles blend
    // into one organic patch with no visible boundary.
    if (losBlock) {
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      const tint = tName === "verdant" ? "26,74,44"
                 : tName === "ashen"  ? "122,56,30"
                 :                      "54,92,140";
      const peakAlpha = 0.16;
      const r = PX * 0.72;   // feather radius: stays inside the tile, no hard edge
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!losBlock[y * w + x]) continue;
          const cx = x * PX + PX / 2, cy = y * PX + PX / 2;
          const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          grad.addColorStop(0, `rgba(${tint},${peakAlpha})`);
          grad.addColorStop(1, `rgba(${tint},0)`);
          ctx.fillStyle = grad;
          ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
        }
      }
      ctx.restore();
    }

    // ---- 4. crisp dark outline along cliff edges ----------------------------
    // Draw a dark band on the ground-side of every cliff face so walls read.
    // Toon outlines stay DARK (that is the look), but hue-tied to the biome —
    // deep forest green / burnt umber / deep slate blue — the way a painter
    // inks with a dark cousin of the local color instead of neutral black.
    // Barrier blobs (forest/lava/ice/rock doodad stands) get NO inked border —
    // they already carry 3D props, and the box outline under them read as an
    // ugly perimeter fence. They get a soft pool of shade below instead.
    const outline = tName === "verdant" ? "rgba(28,52,34,0.50)"
                  : tName === "ashen"   ? "rgba(94,44,24,0.52)"
                  :                       "rgba(40,60,92,0.50)";
    const OW = Math.max(2, (PX / 6) | 0);             // outline band width
    ctx.fillStyle = outline;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!isCliffFace(x, y)) continue;
        // draw an inset border on the sides that face open/lower ground
        const px = x * PX, py = y * PX;
        const lowerOrOpen = (nx, ny) =>
          lvlAt(nx, ny) < lvlAt(x, y) && !isCliffFace(nx, ny) || (!rockAt(nx, ny));
        if (lowerOrOpen(x - 1, y)) ctx.fillRect(px, py, OW, PX);
        if (lowerOrOpen(x + 1, y)) ctx.fillRect(px + PX - OW, py, OW, PX);
        if (lowerOrOpen(x, y - 1)) ctx.fillRect(px, py, PX, OW);
        if (lowerOrOpen(x, y + 1)) ctx.fillRect(px, py + PX - OW, PX, OW);
      }
    }

    // ---- 4b. barrier blobs: soft feathered ground shade (like losBlock) -----
    // The prop clusters sit in an organic pool of shadow that overlaps tile
    // bounds, instead of an inked rectangle fence.
    {
      const tint = tName === "verdant" ? "22,52,32"
                 : tName === "ashen"  ? "96,42,22"
                 :                      "40,68,104";
      const r = PX * 0.85;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!rockAt(x, y) || isCliffFace(x, y)) continue;
          if (barrierKind && !barrierKind[y * w + x]) continue;
          const cx = x * PX + PX / 2, cy = y * PX + PX / 2;
          const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          grad.addColorStop(0, `rgba(${tint},0.20)`);
          grad.addColorStop(1, `rgba(${tint},0)`);
          ctx.fillStyle = grad;
          ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
        }
      }
      ctx.fillStyle = outline; // restore for any later passes
    }

    // ---- 5. cliff FACE fill: warm painted rock derived from cliffTop --------
    // The face is a deeper, slightly MORE SATURATED cousin of the plateau top:
    // multiplied down less than before (0.66/0.84 vs the old 0.58/0.78 — the
    // bright palette needs less push to read as a wall) and hue-shifted toward
    // a per-biome rock-shadow color so cliffs read as sunlit painted rock, not
    // gray gloom. Chunky two-step bevel + full cliffTop lip = toy-block cliff.
    const cliffTone = th.cliffTop;
    const rockShadowHue = tName === "verdant" ? [96, 104, 78]     // mossy olive
                        : tName === "ashen"   ? [172, 96, 58]     // canyon red
                        :                       [126, 152, 190];  // glacial blue
    const cliffDark = mixT([cliffTone[0] * 0.66, cliffTone[1] * 0.66, cliffTone[2] * 0.66].map(CH), rockShadowHue, 0.30);
    const cliffMid = mixT([cliffTone[0] * 0.84, cliffTone[1] * 0.84, cliffTone[2] * 0.84].map(CH), rockShadowHue, 0.18);
    const chipDark = rgbStr(mixT(cliffDark, rockShadowHue, 0.45));
    const chipLight = rgbStr(lift(cliffMid, 0.10));
    const lipW = Math.max(2, (OW / 2) | 0);
    const chipSpan = PX - 2 * OW - 6;               // keep chips inside the bevel
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!isCliffFace(x, y)) continue;
        const px = x * PX, py = y * PX;
        const l = lvlAt(x, y);
        ctx.fillStyle = rgbStr(cliffDark);
        ctx.fillRect(px + OW, py + OW, PX - 2 * OW, PX - 2 * OW);
        ctx.fillStyle = rgbStr(cliffMid);
        ctx.fillRect(px + OW + 1, py + OW + 1, PX - 2 * OW - 2, PX - 2 * OW - 2);
        // deterministic rock chips (texRnd): two shadow dabs + one sun glint
        // per face so cliffs aren't flat slabs — drawn inside the inset so the
        // outline and lip stay crisp. Integer coords keep the pixel-art edge.
        ctx.fillStyle = chipDark;
        for (let i = 0; i < 2; i++)
          ctx.fillRect(px + OW + 2 + ((texRnd() * chipSpan) | 0),
                       py + OW + 2 + ((texRnd() * chipSpan) | 0),
                       2 + ((texRnd() * 3) | 0), 1 + ((texRnd() * 2) | 0));
        ctx.fillStyle = chipLight;
        ctx.fillRect(px + OW + 2 + ((texRnd() * chipSpan) | 0),
                     py + OW + 2 + ((texRnd() * chipSpan) | 0),
                     2 + ((texRnd() * 2) | 0), 1);
        ctx.fillStyle = rgbStr(cliffTone);
        if (lvlAt(x, y - 1) >= l) ctx.fillRect(px, py, PX, lipW);
        if (lvlAt(x, y + 1) >= l) ctx.fillRect(px, py + PX - lipW, PX, lipW);
        if (lvlAt(x - 1, y) >= l) ctx.fillRect(px, py, lipW, PX);
        if (lvlAt(x + 1, y) >= l) ctx.fillRect(px + PX - lipW, py, lipW, PX);
        ctx.fillStyle = "rgba(255,255,255,0.14)";
        if (lvlAt(x, y - 1) >= l) ctx.fillRect(px, py, PX, 1);
        if (lvlAt(x, y + 1) >= l) ctx.fillRect(px, py + PX - 1, PX, 1);
        if (lvlAt(x - 1, y) >= l) ctx.fillRect(px, py, 1, PX);
        if (lvlAt(x + 1, y) >= l) ctx.fillRect(px + PX - 1, py, 1, PX);
      }
    }

    // ---- 6. ramps: seamless mid-tone pixel tile + carved walkway ------------
    // Each ramp tile is stamped with a SEAMLESS pixel-art tile rendered at the
    // halfway tone between its two levels (cached per lo->hi pair, a handful
    // of extra bitmaps at most) so ramps keep the same hand-painted grain as
    // the ground instead of dropping to a flat smooth fill. Over that: a soft
    // sunlit path band plus two deterministic tread notches across the travel
    // axis, so ramps read as friendly carved walkways in the toy diorama.
    const rampTileCache = {};
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!isRamp(x, y)) continue;
        const px = x * PX, py = y * PX;
        const l = lvlAt(x, y);
        // Find the highest adjacent level to blend toward
        let rampHi = l;
        if (lvlAt(x, y - 1) > rampHi) rampHi = lvlAt(x, y - 1);
        if (lvlAt(x, y + 1) > rampHi) rampHi = lvlAt(x, y + 1);
        if (lvlAt(x - 1, y) > rampHi) rampHi = lvlAt(x - 1, y);
        if (lvlAt(x + 1, y) > rampHi) rampHi = lvlAt(x + 1, y);
        const key = l * 4 + rampHi;
        let rTile = rampTileCache[key];
        if (!rTile) {
          const loT = toneFor(l);
          const hiT = toneFor(rampHi);
          const mid = [(loT[0] + hiT[0]) * 0.5, (loT[1] + hiT[1]) * 0.5, (loT[2] + hiT[2]) * 0.5].map(CH);
          rTile = rampTileCache[key] = this.makeGroundTile(th, mid, 0);
        }
        ctx.drawImage(rTile, px, py);
        const horiz = (isRamp(x - 1, y) || isRamp(x + 1, y));
        // sunlit worn path down the middle of the travel axis
        ctx.fillStyle = "rgba(255,244,205,0.13)";
        if (horiz) {
          ctx.fillRect(px, py + (PX * 0.34) | 0, PX, (PX * 0.32) | 0);
        } else {
          ctx.fillRect(px + (PX * 0.34) | 0, py, (PX * 0.32) | 0, PX);
        }
        // two carved tread notches per tile, deterministically placed (pixHash
        // of the tile coords), perpendicular to travel — gentle "steps"
        ctx.fillStyle = "rgba(70,52,34,0.16)";
        const n1 = 5 + (pixHash(x, y) % 9);
        const n2 = 19 + (pixHash(x + 7, y + 3) % 9);
        if (horiz) {
          ctx.fillRect(px + n1, py + ((PX * 0.36) | 0), 1, (PX * 0.28) | 0);
          ctx.fillRect(px + n2, py + ((PX * 0.36) | 0), 1, (PX * 0.28) | 0);
        } else {
          ctx.fillRect(px + ((PX * 0.36) | 0), py + n1, (PX * 0.28) | 0, 1);
          ctx.fillRect(px + ((PX * 0.36) | 0), py + n2, (PX * 0.28) | 0, 1);
        }
        // warm rail lines on the ramp's flanks (was near-black; umber keeps
        // the crisp edge but stays in the sunny key)
        ctx.fillStyle = "rgba(58,42,28,0.22)";
        if (horiz) { ctx.fillRect(px, py, PX, 1); ctx.fillRect(px, py + PX - 1, PX, 1); }
        else { ctx.fillRect(px, py, 1, PX); ctx.fillRect(px + PX - 1, py, 1, PX); }
      }
    }

  }

  paintFog() {
    const { w, h } = this.sim.map;
    const fog = this.sim.fog[this.localPlayer];
    const ctx = this.groundCanvas.getContext("2d");
    ctx.drawImage(this.baseCanvas, 0, 0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const f = fog[y * w + x];
        if (f === 2) continue;
        // Bright look, salience-ordered: VISIBLE terrain stays the most vivid
        // thing on screen. Unexplored is a mid-tone slate haze (obscured but not
        // glaring); explored-but-out-of-sight is a clear cool dim between the two.
        ctx.fillStyle = f === 1 ? "rgba(52,66,88,0.38)" : "rgba(148,168,190,0.72)";
        ctx.fillRect(x * PX, y * PX, PX, PX);
      }
    }
    this.groundTex.needsUpdate = true;
  }

  // Paint the goo creep overlay (Ooze faction) as one organic silhouette:
  // a union of discs (one per goo tile, one per goo-goo edge midpoint) gives
  // a smooth amoeba outline with rounded lobes instead of square tiles. A
  // dark rim is stamped by drawing the silhouette offset in 4 directions
  // under the fill; veins/speckles are composited source-atop so all detail
  // stays inside the blob. Only painted where the gooGrid has a 1 AND the
  // fog is clear (fog===2) so hidden goo doesn't leak information.
  paintGoo() {
    const { w, h } = this.sim.map;
    if (!this.sim.gooGrid) { this.gooPlane.visible = false; return; }
    const grid = this.sim.gooGrid;
    const fog = this.sim.fog[this.localPlayer];
    const W = this.gooCanvas.width, H = this.gooCanvas.height;
    if (!this.gooMask) {
      this.gooMask = document.createElement("canvas");
      this.gooMask.width = W; this.gooMask.height = H;
      this.gooTint = document.createElement("canvas");
      this.gooTint.width = W; this.gooTint.height = H;
    }
    const vis = (x, y) => grid[y * w + x] === 1 && fog[y * w + x] === 2;

    // 1) white silhouette mask: union of discs
    const mctx = this.gooMask.getContext("2d");
    mctx.clearRect(0, 0, W, H);
    mctx.fillStyle = "#fff";
    let anyGoo = false;
    const R = PX * 0.72;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!vis(x, y)) continue;
        anyGoo = true;
        const cx = x * PX + PX / 2, cy = y * PX + PX / 2;
        mctx.beginPath(); mctx.arc(cx, cy, R, 0, Math.PI * 2); mctx.fill();
        // discs at shared edge midpoints fill the waists between neighbors
        if (x + 1 < w && vis(x + 1, y)) { mctx.beginPath(); mctx.arc(cx + PX / 2, cy, R, 0, Math.PI * 2); mctx.fill(); }
        if (y + 1 < h && vis(x, y + 1)) { mctx.beginPath(); mctx.arc(cx, cy + PX / 2, R, 0, Math.PI * 2); mctx.fill(); }
      }
    }
    const ctx = this.gooCanvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    this.gooPlane.visible = anyGoo;
    if (!anyGoo) { this.gooTex.needsUpdate = true; return; }

    // tint helper: colored copy of the silhouette
    const tint = (color) => {
      const tctx = this.gooTint.getContext("2d");
      tctx.clearRect(0, 0, W, H);
      tctx.drawImage(this.gooMask, 0, 0);
      tctx.globalCompositeOperation = "source-in";
      tctx.fillStyle = color;
      tctx.fillRect(0, 0, W, H);
      tctx.globalCompositeOperation = "source-over";
      return this.gooTint;
    };

    // 2) dark rim (offset stamps) under the acid-green fill
    const rim = tint("rgba(24,92,20,0.9)");
    const O = 3;
    ctx.drawImage(rim, -O, 0); ctx.drawImage(rim, O, 0);
    ctx.drawImage(rim, 0, -O); ctx.drawImage(rim, 0, O);
    ctx.drawImage(tint("rgba(62,205,40,0.82)"), 0, 0);

    // 3) per-tile veins + darker blotches, clipped inside the silhouette
    ctx.globalCompositeOperation = "source-atop";
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!vis(x, y)) continue;
        const hh = pixHash(x + 42, y + 99);
        const cx = x * PX + PX / 2, cy = y * PX + PX / 2;
        // soft dark blotch for organic mottling
        ctx.fillStyle = `rgba(20,80,16,${0.10 + (hh & 7) * 0.02})`;
        ctx.beginPath();
        ctx.arc(cx + ((hh >> 3) & 7) - 3, cy + ((hh >> 6) & 7) - 3, PX * (0.22 + ((hh >> 9) & 3) * 0.05), 0, Math.PI * 2);
        ctx.fill();
        // bright vein highlights
        const veins = 2 + (hh & 1);
        for (let v = 0; v < veins; v++) {
          const ang = ((hh >> (v * 3)) & 15) / 15 * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(ang) * 2, cy + Math.sin(ang) * 2);
          ctx.lineTo(cx + Math.cos(ang) * (PX * 0.4), cy + Math.sin(ang) * (PX * 0.4));
          ctx.lineWidth = 2 + (hh & 2);
          ctx.strokeStyle = `rgba(150,255,90,0.20)`;
          ctx.stroke();
        }
      }
    }
    ctx.globalCompositeOperation = "source-over";
    this.gooTex.needsUpdate = true;
  }

  // Instanced, theme-tinted barrier props keyed by map.barrierKind:
  //   1 forest (trees)  2 lava (basalt + crack)  3 ice (spires)  4 rock (boulders).
  // Cliff-face rock tiles are terrain (painted, displaced mesh) and get NO prop.
  // Degrades gracefully: when barrierKind is absent, every blocked flat-ground
  // tile becomes a kind-4 boulder cluster (the old behavior's replacement).
  buildBarriers() {
    const { w, h, rock, height } = this.sim.map;
    const barrierKind = this.sim.map.barrierKind;     // may be undefined
    const lvlAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : (height ? height[y * w + x] : 0);
    const rockAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : rock[y * w + x];
    // cliff-face detection (same rule as paintTerrain): a raised/bordering wall
    const isCliffFace = (x, y) => {
      if (!rockAt(x, y)) return false;
      const l = lvlAt(x, y);
      return lvlAt(x - 1, y) < l || lvlAt(x + 1, y) < l ||
             lvlAt(x, y - 1) < l || lvlAt(x, y + 1) < l ||
             (l > 0 && (lvlAt(x - 1, y) !== l || lvlAt(x + 1, y) !== l ||
                        lvlAt(x, y - 1) !== l || lvlAt(x, y + 1) !== l));
    };

    // bucket barrier tiles by kind
    const tiles = { 1: [], 2: [], 3: [], 4: [] };
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!rockAt(x, y) || isCliffFace(x, y)) continue;   // walls are terrain
        let kind = barrierKind ? barrierKind[y * w + x] : 4;
        if (kind < 1 || kind > 4) kind = 4;
        tiles[kind].push([x, y]);
      }

    const mats = barrierMaterials(this.theme);
    const M = new THREE.Matrix4();
    const Q = new THREE.Quaternion();
    const V = new THREE.Vector3();
    // deterministic per-tile pseudo-random in [0,1)
    const rand = (x, y, s) => { const n = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return n - Math.floor(n); };

    // helper: build an InstancedMesh from a list of poses
    const buildInst = (geo, mat, poses, cast = true) => {
      if (!poses.length) return null;
      const inst = new THREE.InstancedMesh(geo, mat, poses.length);
      inst.castShadow = cast;
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      poses.forEach((p, i) => {
        Q.setFromEuler(new THREE.Euler(p.rx || 0, p.ry || 0, p.rz || 0));
        M.compose(V.set(p.x, p.y, p.z), Q, p.s);
        inst.setMatrixAt(i, M);
      });
      this.scene.add(inst);
      return inst;
    };

    this.barrierMeshes = [];

    // ---- kind 4: ROUNDED boulders, clustered 2-4 with size falloff ----------
    {
      const poses = [];
      for (const [tx, ty] of tiles[4]) {
        const n = 2 + ((rand(tx, ty, 1) * 3) | 0);        // 2..4 per tile
        for (let k = 0; k < n; k++) {
          const ang = rand(tx, ty, k + 2) * Math.PI * 2;
          const rad = rand(tx, ty, k + 5) * 0.34;
          const wx = tx + 0.5 + Math.cos(ang) * rad;
          const wz = ty + 0.5 + Math.sin(ang) * rad;
          const fall = 1 - k / (n + 1);                    // size falloff
          const s = (0.42 + rand(tx, ty, k + 8) * 0.34) * fall + 0.22;
          const gy = this.heightAt(wx, wz);
          poses.push({ x: wx, y: gy + s * 0.32 - 0.14, z: wz,   // sunk in
            ry: rand(tx, ty, k + 3) * Math.PI * 2,
            rz: (rand(tx, ty, k + 4) - 0.5) * 0.5,
            s: new THREE.Vector3(s, s * (0.62 + rand(tx, ty, k) * 0.2), s) });
        }
      }
      this.barrierMeshes.push(buildInst(SHARED.boulder, mats.boulder, poses));
    }

    // ---- kind 1: FOREST — trunk + double-sphere canopy, hue/size variants ---
    {
      const trunkP = [], canLoP = [], canHiP = [];
      for (const [tx, ty] of tiles[1]) {
        const n = 1 + ((rand(tx, ty, 1) > 0.55) ? 1 : 0);  // 1-2 trees, overhang
        for (let k = 0; k < n; k++) {
          // trees slightly overhang tile edges so stands read as woods
          const wx = tx + 0.5 + (rand(tx, ty, k + 2) - 0.5) * 0.9;
          const wz = ty + 0.5 + (rand(tx, ty, k + 3) - 0.5) * 0.9;
          const sv = 0.85 + rand(tx, ty, k + 4) * 0.5;      // size variant
          const gy = this.heightAt(wx, wz);
          const ry = rand(tx, ty, k + 5) * Math.PI * 2;
          trunkP.push({ x: wx, y: gy, z: wz, ry, s: new THREE.Vector3(sv, sv, sv) });
          canLoP.push({ x: wx, y: gy + 0.62 * sv, z: wz, ry,
            s: new THREE.Vector3(sv * (0.9 + rand(tx, ty, k + 6) * 0.3), sv * 0.85, sv) });
          canHiP.push({ x: wx, y: gy + 0.95 * sv, z: wz, ry,
            s: new THREE.Vector3(sv * 0.8, sv * 0.8, sv * 0.8) });
        }
      }
      this.barrierMeshes.push(buildInst(SHARED.treeTrunk, mats.treeTrunk, trunkP));
      this.barrierMeshes.push(buildInst(SHARED.treeCanopyLo, mats.treeCanopy, canLoP));
      this.barrierMeshes.push(buildInst(SHARED.treeCanopyHi, mats.treeCanopy, canHiP));
    }

    // ---- kind 2: LAVA — clustered hex basalt prisms + emissive crack decal ---
    {
      const basaltP = [], crackP = [];
      for (const [tx, ty] of tiles[2]) {
        const n = 2 + ((rand(tx, ty, 1) * 3) | 0);
        for (let k = 0; k < n; k++) {
          const ang = rand(tx, ty, k + 2) * Math.PI * 2;
          const rad = rand(tx, ty, k + 5) * 0.3;
          const wx = tx + 0.5 + Math.cos(ang) * rad;
          const wz = ty + 0.5 + Math.sin(ang) * rad;
          const hgt = 0.55 + rand(tx, ty, k + 6) * 0.75;    // varied heights
          const sc = 0.55 + rand(tx, ty, k + 7) * 0.3;
          const gy = this.heightAt(wx, wz);
          basaltP.push({ x: wx, y: gy + hgt * 0.5 - 0.1, z: wz,
            ry: rand(tx, ty, k + 3) * Math.PI,
            s: new THREE.Vector3(sc, hgt, sc) });
        }
        // one glowing crack decal laid flat between the prisms
        const gy = this.heightAt(tx + 0.5, ty + 0.5);
        crackP.push({ x: tx + 0.5, y: gy + 0.03, z: ty + 0.5,
          rx: -Math.PI / 2, ry: rand(tx, ty, 9) * Math.PI,
          s: new THREE.Vector3(1.05, 1.05, 1.05) });
      }
      this.barrierMeshes.push(buildInst(SHARED.basalt, mats.basalt, basaltP));
      // crack decals: flat additive planes, no shadow
      const crackGeo = new THREE.PlaneGeometry(1, 1);
      const crackInst = buildInst(crackGeo, mats.crack, crackP, false);
      if (crackInst) this.emberMat = mats.crack;   // pulsed in render()
    }

    // ---- kind 3: ICE — translucent crystal spires, clustered, varied lean ---
    {
      const poses = [];
      for (const [tx, ty] of tiles[3]) {
        const n = 2 + ((rand(tx, ty, 1) * 3) | 0);          // 2..4 spires
        for (let k = 0; k < n; k++) {
          const ang = rand(tx, ty, k + 2) * Math.PI * 2;
          const rad = rand(tx, ty, k + 5) * 0.32;
          const wx = tx + 0.5 + Math.cos(ang) * rad;
          const wz = ty + 0.5 + Math.sin(ang) * rad;
          const hgt = 0.7 + rand(tx, ty, k + 6) * 0.9;
          const sc = 0.5 + rand(tx, ty, k + 7) * 0.35;
          const lean = (rand(tx, ty, k + 8) - 0.5) * 0.5;   // varied lean
          const gy = this.heightAt(wx, wz);
          poses.push({ x: wx, y: gy - 0.1, z: wz,
            ry: rand(tx, ty, k + 3) * Math.PI * 2, rz: lean,
            s: new THREE.Vector3(sc, hgt, sc) });
        }
      }
      // ice spires don't cast shadow (translucent) so they read as glassy
      this.barrierMeshes.push(buildInst(SHARED.iceSpire, mats.ice, poses, false));
    }
  }

  // Instanced, theme-colored decorations (crystal shards, rock piles, glowing
  // flora tufts). Non-blocking props scattered deterministically by the map.
  buildDecos() {
    const decos = this.sim.map.decos || [];
    if (!decos.length) return;
    const buckets = [[], [], [], []];           // by kind (3 = tall shrub)
    for (const d of decos) if (buckets[d.kind]) buckets[d.kind].push(d);
    const [c0, c1, c2] = this.theme.deco;

    // kind 3: tall shrubs (LoS blockers) — animated groups, subtle sway.
    this.shrubs = [];
    for (const d of buckets[3]) {
      const wx = d.x + 0.5, wz = d.y + 0.5;
      // theme-tinted, biased toward the darker mid flora color
      const g = makeShrubVisual(c2, (d.x * 13 + d.y * 7) & 0xff);
      g.position.set(wx, this.heightAt(wx, wz), wz);
      g.scale.setScalar(0.9 + ((d.x + d.y) % 4) / 8);
      this.scene.add(g);
      this.shrubs.push(g);
    }

    // kind 0: crystal shard cluster — rounded, saturated, slight emissive (toon)
    this.addDecoInstances(buckets[0], SHARED.crystalShard,
      propToon({ color: c0, emissive: c0, emissiveIntensity: 0.7 }),
      (d) => ({ y: 0.22, s: 0.7 + ((d.x * 5 + d.y * 3) % 5) / 8, spin: (d.x + d.y) % 6 }));

    // kind 1: small rock pile — ROUNDED boulder (kill the dodecahedron), toon
    this.addDecoInstances(buckets[1], SHARED.boulder,
      propToon({ color: this.theme.rock }),
      (d) => ({ y: 0.1, s: 0.34 + ((d.x * 7 + d.y) % 5) / 12, spin: (d.x * 2 + d.y) % 6 }));

    // kind 2: glowing flora tuft — rounded blob, emissive (toon)
    this.addDecoInstances(buckets[2], SHARED.floraBlob,
      propToon({ color: c1, emissive: c2, emissiveIntensity: 0.8 }),
      (d) => ({ y: 0.18, s: 0.7 + ((d.x + d.y * 4) % 5) / 8, spin: (d.x + d.y * 3) % 6 }));
  }

  addDecoInstances(list, geo, mat, poseFn) {
    if (!list.length) return;
    const inst = new THREE.InstancedMesh(geo, mat, list.length);
    inst.castShadow = true;
    inst.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    list.forEach((d, i) => {
      const wx = d.x + 0.5, wz = d.y + 0.5;
      const p = poseFn(d);
      const gy = this.heightAt(wx, wz);
      q.setFromEuler(new THREE.Euler(0, (p.spin / 6) * Math.PI * 2, 0));
      m.compose(new THREE.Vector3(wx, gy + p.y * p.s, wz), q, new THREE.Vector3(p.s, p.s, p.s));
      inst.setMatrixAt(i, m);
    });
    inst.frustumCulled = false;
    this.scene.add(inst);
  }

  // one thick rally line (building center -> rally point). Fat line via
  // Line2/LineGeometry/LineMaterial (regular THREE.Line ignores linewidth on
  // WebGL, so it always renders 1px regardless of the value passed).
  makeRallyLine() {
    const geo = new LineGeometry();
    geo.setPositions([0, 0, 0, 0, 0, 0]);
    const mat = new LineMaterial({
      color: 0x0b3d20,           // dark ink: reads on bright ground
      linewidth: 5.5,            // pixels (worldUnits: false)
      transparent: true, opacity: 0.95,
      depthWrite: false, depthTest: false,   // UI overlay: never hide under terrain
      dashed: true, dashSize: 0.6, gapSize: 0.28, dashScale: 1,
    });
    mat.resolution.set(innerWidth, innerHeight);
    this.fatLineMats.push(mat);
    const line = new Line2(geo, mat);
    line.renderOrder = 5;
    line.visible = false;
    line.frustumCulled = false;
    line.computeLineDistances();
    this.scene.add(line);
    return line;
  }

  // pool of 8 rally visuals (dashed line + flag), one per selected building
  buildRallyPool() {
    this.rallyPool = [];
    for (let i = 0; i < 8; i++) {
      this.rallyPool.push({ line: this.makeRallyLine(), flag: this.makeRallyFlag() });
    }
  }

  // one pooled fat-line-segments buffer drawing selected units' queued paths.
  // LineSegments2/LineSegmentsGeometry is the disjoint-segment sibling of
  // Line2/LineGeometry (same fat-line technique, but each pair of verts is an
  // independent segment rather than a connected polyline) — matches the old
  // THREE.LineSegments layout so the position/color buffers below are unchanged.
  buildQueuePaths() {
    this.queueMaxSegments = 600;                 // 2 verts/segment, 3 floats/vert
    const geo = new LineSegmentsGeometry();
    this.queuePathArr = new Float32Array(this.queueMaxSegments * 2 * 3);
    this.queuePathCol = new Float32Array(this.queueMaxSegments * 2 * 3);
    geo.setPositions(this.queuePathArr);
    geo.setColors(this.queuePathCol);
    const mat = new LineMaterial({
      vertexColors: true, transparent: true, opacity: 0.92,  // near-opaque: reads over bright ground
      linewidth: 4.5,          // pixels (worldUnits: false)
      depthWrite: false, depthTest: false,   // UI overlay: never hide under terrain
    });
    mat.resolution.set(innerWidth, innerHeight);
    this.fatLineMats.push(mat);
    this.queuePaths = new LineSegments2(geo, mat);
    this.queuePaths.renderOrder = 5;
    this.queuePaths.frustumCulled = false;
    this.queuePaths.visible = false;   // nothing queued yet
    this.scene.add(this.queuePaths);
  }

  // world point (in world units) for a single order, or null to stop the chain
  orderPoint(o) {
    const sim = this.sim;
    switch (o.kind) {
      case "move":
      case "attackmove":
      case "patrol":
        return [W2(o.x), W2(o.y)];
      case "attack":
      case "gather":
      case "build": {
        const t = sim.byId.get(o.targetId);
        return t ? [W2(t.x), W2(t.y)] : null;
      }
      default:               // "hold" / "idle" and anything else stop the chain
        return null;
    }
  }

  // Rebuild the shift-queue path buffer from the current selection.
  // Segment colors: green move, red attack(-move), blue patrol, cyan gather,
  // amber build.
  updateQueuePaths() {
    const sim = this.sim;
    const arr = this.queuePathArr;
    const col = this.queuePathCol;
    const cap = this.queueMaxSegments;
    let seg = 0;

    // Near-black ink tones: order lines are 1px, so they need MAXIMUM value
    // contrast against the bright terrain (the toon-outline language).
    const KIND_COLORS = {
      move: [0.03, 0.26, 0.12],
      attackmove: [0.55, 0.08, 0.05],
      attack: [0.55, 0.08, 0.05],
      patrol: [0.06, 0.18, 0.45],
      gather: [0.02, 0.34, 0.31],
      build: [0.45, 0.26, 0.03],
    };

    // follow the terrain: each endpoint sits at ground height + a small lift
    const push = (ax, az, bx, bz, c) => {
      if (seg >= cap) return false;
      const i = seg * 6;
      arr[i] = ax; arr[i + 1] = this.heightAt(ax, az) + 0.14; arr[i + 2] = az;
      arr[i + 3] = bx; arr[i + 4] = this.heightAt(bx, bz) + 0.14; arr[i + 5] = bz;
      col[i] = c[0]; col[i + 1] = c[1]; col[i + 2] = c[2];
      col[i + 3] = c[0]; col[i + 4] = c[1]; col[i + 5] = c[2];
      seg++;
      return true;
    };

    outer:
    for (const id of this.selection) {
      const e = sim.byId.get(id);
      if (!e || e.owner !== this.localPlayer || !e.unit) continue;
      const next = e.next || [];
      if (e.order.kind === "idle" && next.length === 0) continue;

      let px = W2(e.x), pz = W2(e.y);              // start at the unit
      const orders = [e.order, ...next];
      for (const o of orders) {
        const c = KIND_COLORS[o.kind] || KIND_COLORS.move;
        // patrol also shows its route leg (ox,oy)<->(x,y)
        if (o.kind === "patrol") {
          if (!push(W2(o.ox), W2(o.oy), W2(o.x), W2(o.y), c)) break outer;
        }
        const pt = this.orderPoint(o);
        if (!pt) break;                            // hold/idle stop the chain
        if (!push(px, pz, pt[0], pt[1], c)) break outer;
        px = pt[0]; pz = pt[1];
      }
    }

    this.queuePaths.visible = seg > 0;
    if (seg > 0) {
      // LineSegmentsGeometry rebuilds its instanced attributes from a flat
      // array each call, so pass only the filled prefix (a full-capacity
      // buffer would draw `cap` segments, most of them stale zero-length
      // leftovers from a previous, longer selection).
      this.queuePaths.geometry.setPositions(arr.subarray(0, seg * 6));
      this.queuePaths.geometry.setColors(col.subarray(0, seg * 6));
    }
  }

  // Rally lines + flags for every selected own finished building with a rally.
  updateRallyLines(t) {
    const sim = this.sim;
    let i = 0;
    for (const id of this.selection) {
      if (i >= this.rallyPool.length) break;
      const b = sim.byId.get(id);
      if (!b || b.owner !== this.localPlayer || !b.building || !b.done || !b.rally) continue;
      const slot = this.rallyPool[i++];
      const { line, flag } = slot;

      const rx = W2(b.rally.x), rz = W2(b.rally.y);
      const bx = W2(b.x), bz = W2(b.y);
      line.visible = true;
      // follow the terrain at both ends so the line/flag sit on the ground.
      // LineGeometry (fat-line addon) has no attribute-level setXYZ; rebuild
      // its instanced position buffer from a flat array instead.
      line.geometry.setPositions([
        bx, this.heightAt(bx, bz) + 0.12, bz,
        rx, this.heightAt(rx, rz) + 0.12, rz,
      ]);
      line.computeLineDistances();
      const onMineral = b.rally.targetId && sim.byId.get(b.rally.targetId)?.type === "mineral";
      line.material.color.setHex(onMineral ? 0x074f46 : 0x0b3d20);

      flag.visible = true;
      flag.position.set(rx, this.heightAt(rx, rz), rz);
      flag.userData.flag.rotation.y = Math.sin(t * 3) * 0.15;
    }
    for (; i < this.rallyPool.length; i++) {
      this.rallyPool[i].line.visible = false;
      this.rallyPool[i].flag.visible = false;
    }
  }

  // pool of pulsing rings that mark what selected units are working on
  buildTargetRings() {
    this.targetRings = [];
    const geo = new THREE.RingGeometry(0.78, 0.9, 30);
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xffffff, side: THREE.DoubleSide, transparent: true,
        opacity: 0.7, depthWrite: false,
      }));
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.04;
      m.visible = false;
      this.scene.add(m);
      this.targetRings.push(m);
    }
  }

  // ---------- build-grid placement overlay ----------

  // Pool of 81 thin translucent quads (a 9x9 grid of tiles) for the placement
  // overlay. Each cell is colored green (valid) / red (invalid) per canPlace.
  buildPlacementGrid() {
    this.gridSpan = 4;                      // 9x9 (center +/- 4)
    this.gridPool = [];
    // one shared quad geo, per-cell material so colors differ
    const geo = new THREE.PlaneGeometry(0.9, 0.9);
    for (let i = 0; i < 81; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x2e9e57, transparent: true, opacity: 0.3,   // deep green: readable fill on bright ground
        depthWrite: false, side: THREE.DoubleSide,
      });
      const q = new THREE.Mesh(geo, mat);
      q.rotation.x = -Math.PI / 2;
      q.visible = false;
      q.renderOrder = 2;
      this.scene.add(q);
      this.gridPool.push(q);
    }
    this.placementGrid = null;              // { type, tx, ty } while placing
  }

  // Called by input.updateGhost: show the overlay centered on the cursor tile.
  // Recomputes cell colors only when the center tile changed (ghost moved).
  setPlacementGrid(type, tx, ty) {
    if (this.placementGrid && this.placementGrid.type === type &&
        this.placementGrid.tx === tx && this.placementGrid.ty === ty) return;
    this.placementGrid = { type, tx, ty };
    this.refreshPlacementGrid();
  }

  clearPlacementGrid() {
    this.placementGrid = null;
    for (const q of this.gridPool) q.visible = false;
  }

  // Recompute cell positions + validity colors. SC2 semantics: each CELL
  // shows whether THAT TILE is buildable ground (the ghost's own green/red
  // still communicates whether the whole footprint fits). For deposit
  // buildings the resource-clearance zone shows red so the "no-CP ring"
  // around minerals/geysers is visible.
  refreshPlacementGrid() {
    const g = this.placementGrid;
    if (!g) return;
    const d = BUILDINGS[g.type];
    const sim = this.sim;
    const { w, h } = sim.map;
    const span = this.gridSpan;
    const clearFp = (d?.deposit ? 6 : 0) * FP; // HQ_RESOURCE_CLEARANCE
    let i = 0;
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const cellX = g.tx + dx, cellY = g.ty + dz;
        const q = this.gridPool[i++];
        const wx = cellX + 0.5, wz = cellY + 0.5;
        q.position.set(wx, this.heightAt(wx, wz) + 0.05, wz);
        let ok = cellX >= 0 && cellY >= 0 && cellX < w && cellY < h &&
          !sim.blocked[cellY * w + cellX] &&
          !(sim.map.rampTiles && sim.map.rampTiles[cellY * w + cellX]);
        if (ok) {
          const gey = sim.geyserInFootprint?.(cellX, cellY, 1);
          if (d?.onGeyser) { /* refinery: geyser tiles are the point */ }
          else if (gey) ok = false;
          // deposit clearance ring: tile too close to any resource
          if (ok && clearFp) {
            const cx = cellX * FP + HALF, cy = cellY * FP + HALF;
            const near = sim.nearestEntity(cx, cy, clearFp,
              (e) => e.type === "mineral" || e.type === "geyser");
            if (near) ok = false;
          }
        }
        q.material.color.setHex(0x2e9e57);
        q.visible = ok;
      }
    }
  }

  // Collect the targets of selected units (patch being mined, depot being
  // returned to, site being built, enemy being attacked) and ring them.
  updateOrderMarkers(t) {
    const sim = this.sim;
    const targets = new Map(); // id -> color
    for (const id of this.selection) {
      const e = sim.byId.get(id);
      if (!e || e.owner !== this.localPlayer || !e.unit) continue;
      const o = e.order;
      if (o.kind === "gather") {
        if (o.phase === "return") {
          const depot = sim.nearestEntity(e.x, e.y, 60 * FP, (b) =>
            b.building && b.done && b.owner === e.owner && BUILDINGS[b.type].deposit);
          if (depot) targets.set(depot.id, 0x0e8f83);
        } else if (sim.byId.has(o.targetId)) targets.set(o.targetId, 0x0e8f83);
      } else if (o.kind === "build" && sim.byId.has(o.targetId)) {
        targets.set(o.targetId, 0xb36a12);
      } else if (o.kind === "attack" && sim.byId.has(o.targetId)) {
        targets.set(o.targetId, 0xe04432);
      }
      if (targets.size >= this.targetRings.length) break;
    }
    let i = 0;
    for (const [tid, color] of targets) {
      const target = sim.byId.get(tid);
      const ring = this.targetRings[i++];
      ring.visible = true;
      const trx = W2(target.x), trz = W2(target.y);
      ring.position.set(trx, this.heightAt(trx, trz) + 0.04, trz);
      const base = target.building ? target.size * 0.75 : 0.8;
      ring.scale.setScalar(base + Math.sin(t * 4) * 0.06);
      ring.material.color.setHex(color);
      ring.material.opacity = 0.5 + Math.sin(t * 4) * 0.2;
    }
    for (; i < this.targetRings.length; i++) this.targetRings[i].visible = false;
  }

  // While a worker mines or welds, face it toward its target and emit
  // periodic sparks at the contact point. Render-only.
  updateTaskSparks(t) {
    const sim = this.sim;
    for (const e of sim.entities) {
      if (e.type !== "worker") continue;
      const g = this.meshes.get(e.id);
      if (!g || !g.visible) continue;
      const o = e.order;
      let target = null, color = null, count = 3;
      if (o.kind === "gather" && o.phase === "mining") {
        target = sim.byId.get(o.targetId);
        color = 0x63e8db;
      } else if (o.kind === "build") {
        const site = sim.byId.get(o.targetId);
        if (site && sim.gapTo(e, site) <= FP) { target = site; color = 0xffb347; count = 4; }
      }
      if (!target) continue;

      // face the work
      if (g.userData.body) {
        const yaw = Math.atan2(target.x - e.x, target.y - e.y);
        let dy = yaw - g.userData.body.rotation.y;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        g.userData.body.rotation.y += dy * 0.15;
      }

      // sparks at the contact point (biased toward the target's edge)
      const next = this.taskFxTimers.get(e.id) || 0;
      if (t >= next) {
        this.taskFxTimers.set(e.id, t + 0.28 + (e.id % 5) * 0.05);
        const cx = W2(e.x) + (W2(target.x) - W2(e.x)) * 0.55;
        const cz = W2(e.y) + (W2(target.y) - W2(e.y)) * 0.55;
        this.fx.sparks.burst(cx, this.heightAt(cx, cz) + 0.4, cz, count, color, 1.1, 0.3, 1.4);
      }
    }
  }

  makeRallyFlag() {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(SHARED.pole, new THREE.MeshBasicMaterial({ color: 0xcccccc }));
    pole.position.y = 0.7;
    const flag = new THREE.Mesh(SHARED.flag, new THREE.MeshBasicMaterial({ color: 0x0b3d20 }));
    flag.position.set(0.17, 1.25, 0);
    g.add(pole, flag);
    g.visible = false;
    this.scene.add(g);
    g.userData.flag = flag;
    return g;
  }

  // ---------- entity visuals ----------

  makeMesh(e) {
    let group;
    const color = e.owner >= 0 ? this.playerColors[e.owner] : null;
    if (e.type === "geyser") {
      group = makeGeyserVisual(e, this.theme.rock);
    } else if (e.type === "mineral") {
      group = makeMineralVisual(e);
    } else if (e.unit) {
      group = makeUnitVisual(e, color);
      this.addRingAndBar(group, e, 0.55, 1.25);
      if (e.fly) this.setupFlyer(group, e);
    } else {
      group = makeBuildingVisual(e, color, e.size);
      this.addRingAndBar(group, e, e.size * 0.62, BUILDINGS[e.type].size + 0.6);
    }
    group.traverse((o) => { o.userData.eid = e.id; });
    group.position.set(W2(e.x), 0, W2(e.y));
    this.scene.add(group);
    return group;
  }

  addRingAndBar(group, e, ringScale, barHeight) {
    const ring = new THREE.Mesh(SHARED.ring, this.ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.scale.setScalar(ringScale * 2);
    ring.visible = false;
    group.add(ring);
    group.userData.ring = ring;

    const barBg = new THREE.Mesh(SHARED.bar, this.barBgMat);
    const barFg = new THREE.Mesh(SHARED.bar, new THREE.MeshBasicMaterial({ color: 0x62d96b }));
    barFg.position.z = 0.004;
    const bar = new THREE.Group();
    bar.add(barBg, barFg);
    bar.position.y = barHeight;
    bar.visible = false;
    group.add(bar);
    group.userData.bar = bar;
    group.userData.barFg = barFg;
  }

  // Flyer extras: a scene-level blob shadow on the terrain below, and the
  // selection ring is detached from the group so it stays at terrain level
  // (the group itself rides at cruise altitude). Health bar stays in the group,
  // lifted higher. Body-space bob/bank are driven per frame in render().
  setupFlyer(group, e) {
    const u = UNITS[e.type];
    const radius = (u.radius || 100) / FP;
    if (!this.blobShadowMat) {
      this.blobShadowMat = new THREE.MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity: 0.32,
        depthWrite: false,
      });
    }
    const shadow = new THREE.Mesh(SHARED.blob, this.blobShadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.setScalar(radius * 1.35);
    shadow.renderOrder = -1;
    this.scene.add(shadow);
    group.userData.blobShadow = shadow;
    group.userData.flyer = true;
    group.userData.cruise = 2.2;
    group.userData.yawPrev = 0;
    // detach the selection ring so it draws at terrain level, not at altitude
    const ring = group.userData.ring;
    if (ring) {
      group.remove(ring);
      ring.rotation.x = -Math.PI / 2;
      this.scene.add(ring);
      group.userData.ringDetached = ring;
    }
    // lift the health bar above the flyer body
    if (group.userData.bar) group.userData.bar.position.y = 1.4;
    // higher bar altitude is applied on top of the group's cruise height
  }

  // Tank turret aim: face the current attack target if any, else the body's
  // travel yaw. Writes g.userData.aimYaw (models.js smooths onto the turret).
  updateTankAim(g, e, alpha) {
    const o = e.order;
    let aim;
    if ((o?.kind === "attack") && this.sim.byId.has(o.targetId)) {
      const tgt = this.sim.byId.get(o.targetId);
      aim = Math.atan2(tgt.x - e.x, tgt.y - e.y);
    } else if (e.x !== e.px || e.y !== e.py) {
      aim = Math.atan2(e.x - e.px, e.y - e.py);
    }
    if (aim !== undefined) {
      // aim is world yaw; the turret lives inside body (already yawed), so
      // express it relative to the body's yaw.
      g.userData.aimYaw = aim - (g.userData.body ? g.userData.body.rotation.y : 0);
    }
  }

  // Turret pod tracking: each armed-building visual pivots toward the nearest
  // visible enemy within ~7 tiles. Cheap render-side scan; aimYaw is smoothed
  // in models.js. Called per frame for turret meshes.
  updateTurretAim(g, e) {
    const range = 7;
    let best = null, bestD2 = range * range * FP * FP;
    for (const o of this.sim.entities) {
      if (o.owner < 0 || o.owner === e.owner || o.hp <= 0) continue;
      if (!o.unit && !o.building) continue;
      if (!this.entityVisible(o)) continue;
      const dx = o.x - e.x, dy = o.y - e.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = o; }
    }
    if (best) g.userData.aimYaw = Math.atan2(best.x - e.x, best.y - e.y);
  }

  // Whether a refinery is actively being harvested (any own worker gathering
  // from it). Cached per second to keep this off the per-frame hot path.
  refineryHarvesting(e) {
    const now = performance.now();
    if (!this._harvestCache) this._harvestCache = new Map();
    const c = this._harvestCache.get(e.id);
    if (c && now - c.t < 1000) return c.v;
    let v = false;
    for (const u of this.sim.entities) {
      if (u.unit && u.order?.kind === "gather" &&
          u.order.targetId === e.id && u.order.resource === "gas") { v = true; break; }
    }
    this._harvestCache.set(e.id, { t: now, v });
    return v;
  }

  // ---------- per-frame sync ----------

  render(alpha, dt = 1 / 60) {
    const sim = this.sim;
    const t = (performance.now() - this.clockStart) / 1000;
    const seen = new Set();

    if (sim.tick !== this.lastFogPaint && sim.tick % 3 === 0) {
      this.paintFog();
      this.lastFogPaint = sim.tick;
    }
    // Goo repaints only when the grid actually changed (gooVersion) or on a
    // slow heartbeat so fog reveals eventually show hidden creep. The slow
    // breathing pulse is pure material opacity — no repaint.
    if (sim.gooVersion !== this.lastGooVersion || sim.tick - (this.lastGooTick || 0) >= 15) {
      this.paintGoo();
      this.lastGooVersion = sim.gooVersion;
      this.lastGooTick = sim.tick;
    }
    if (this.gooPlane.visible) {
      this.gooPlane.material.opacity = 0.62 + Math.sin(t * 1.6) * 0.07;
    }

    // sun shadow frustum follows the camera target
    this.sun.position.set(this.camera.tx + 14, 42, this.camera.tz + 7);
    this.sun.target.position.set(this.camera.tx, 0, this.camera.tz);

    for (const e of sim.entities) {
      const visible = this.entityVisible(e);
      let g = this.meshes.get(e.id);
      if (!g) {
        if (!visible) continue;
        g = this.makeMesh(e);
        this.meshes.set(e.id, g);
        if (e.unit && sim.tick > 5) this.fx.spawnPoof(W2(e.x), W2(e.y), e.owner >= 0 ? PLAYER_COLORS[e.owner] : 0xffffff);
      }
      seen.add(e.id);
      g.visible = visible;
      if (!visible) {
        // keep the flyer's detached extras in sync with fog visibility
        if (g.userData.blobShadow) g.userData.blobShadow.visible = false;
        if (g.userData.ringDetached) g.userData.ringDetached.visible = false;
        continue;
      }

      const x = W2(e.px + (e.x - e.px) * alpha);
      const z = W2(e.py + (e.y - e.py) * alpha);
      const terrainY = this.heightAt(x, z);
      if (g.userData.flyer) {
        // cruise altitude above terrain + gentle idle bob
        const bob = Math.sin(t * 1.6 + e.id * 1.3) * 0.14;
        g.position.set(x, terrainY + g.userData.cruise + bob, z);
        // blob shadow directly below on the terrain surface
        const sh = g.userData.blobShadow;
        if (sh) { sh.position.set(x, terrainY + 0.03, z); sh.visible = g.visible; }
      } else if (e.building || e.type === "geyser" || e.type === "mineral") {
        // buildings & resources sit flat on their tile level (not the smoothed
        // slope). A refinery snaps onto the geyser it covers.
        let px = x, pz = z;
        if (e.type === "refinery" && e.geyserId) {
          const gey = this.sim.byId.get(e.geyserId);
          if (gey) { px = W2(gey.x); pz = W2(gey.y); }
        }
        g.position.set(px, this.tileFlatHeight(px, pz), pz);
        // hide a geyser vent once a refinery is built over it
        if (e.type === "geyser") g.visible = g.visible && !this.sim.refineryOnGeyser(e.id);
      } else {
        let baseY = terrainY;
        // Clank leap: a parabolic HOP instead of a flat ground slide. The sim
        // interpolates the unit along leapFrom->leapTo on the ground, so leap
        // progress = the horizontal fraction along that path; the arc peaks at
        // mid-leap. Render-only (never touches the deterministic sim position).
        if (e.type === "brute" && e.leapUntil && e.leapFrom && e.leapTo) {
          const fx = W2(e.leapFrom.x), fz = W2(e.leapFrom.y);
          const tX = W2(e.leapTo.x), tZ = W2(e.leapTo.y);
          const dtot = Math.hypot(tX - fx, tZ - fz);
          let p = dtot > 0.001 ? Math.hypot(x - fx, z - fz) / dtot : 1;
          p = p < 0 ? 0 : p > 1 ? 1 : p;
          baseY += 1.7 * 4 * p * (1 - p);   // peak ~1.7 world units at p=0.5
        }
        g.position.set(x, baseY, z);
      }

      // smoothed motion amount drives walk cycles
      const moving = (e.x !== e.px || e.y !== e.py) ? 1 : 0;
      const prev = this.moveAmt.get(e.id) || 0;
      const amt = prev + (moving - prev) * Math.min(1, dt * 10);
      this.moveAmt.set(e.id, amt);
      if (g.userData.body && moving) {
        const targetYaw = Math.atan2(e.x - e.px, e.y - e.py);
        let dy = targetYaw - g.userData.body.rotation.y;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        const rate = g.userData.flyer ? Math.min(1, dt * 6) : Math.min(1, dt * 12);
        g.userData.body.rotation.y += dy * rate;
        // flyers bank/roll into turns: roll proportional to yaw delta, clamped
        if (g.userData.flyer) {
          const roll = Math.max(-0.6, Math.min(0.6, -dy * 2.2));
          g.userData.body.rotation.z += (roll - g.userData.body.rotation.z) * Math.min(1, dt * 5);
        }
      } else if (g.userData.flyer && g.userData.body) {
        // level out when not turning
        g.userData.body.rotation.z += (0 - g.userData.body.rotation.z) * Math.min(1, dt * 3);
      }
      // Stationary ranged attackers (marine/tank/wraith/banshee/etc.) turn to
      // face their live attack target instead of holding stale travel facing.
      // Tank/turret already track targets via aimYaw (turret-relative), so
      // this only needs to drive the whole-body yaw for the rest. Gated on
      // "ranged" (range beyond melee reach) so brutes/workers don't spin to
      // face melee targets they're already walking into.
      if (g.userData.body && !moving && e.unit) {
        const o = e.order;
        const hasTarget = (o?.kind === "attack" || o?.kind === "attackmove") && o.targetId != null;
        const u = UNITS[e.type];
        if (hasTarget && u && u.range > FP * 1.5) {
          const tgt = sim.byId.get(o.targetId);
          if (tgt) {
            const aimYaw = Math.atan2(tgt.x - e.x, tgt.y - e.y);
            let dy = aimYaw - g.userData.body.rotation.y;
            while (dy > Math.PI) dy -= Math.PI * 2;
            while (dy < -Math.PI) dy += Math.PI * 2;
            const rate = g.userData.flyer ? Math.min(1, dt * 6) : Math.min(1, dt * 12);
            g.userData.body.rotation.y += dy * rate;
          }
        }
      }
      // turret/tank aim: face the attack target (or travel direction)
      if (g.userData.anim) {
        const k = g.userData.anim.kind;
        if (k === "tank") this.updateTankAim(g, e, alpha);
        else if (k === "turret" && e.done) this.updateTurretAim(g, e);
        else if (k === "refinery" && e.done) g.userData.harvesting = this.refineryHarvesting(e);
      }
      animateVisual(g, e, t, amt);

      if (g.userData.crystal && e.type === "mineral") {
        const s = 0.55 + 0.45 * (e.amount / 1500);
        g.userData.crystal.scale.setScalar(s);
      }

      if (g.userData.built) {
        const d = BUILDINGS[e.type];
        const p = e.done ? 1 : Math.max(0.12, e.progress / d.buildTime);
        g.userData.built.scale.y = p;
        g.userData.scaffold.visible = !e.done;
        if (!e.done) {
          g.userData.built.traverse((o) => {
            if (o.material) { o.material.transparent = true; o.material.opacity = 0.45 + p * 0.4; }
          });
        } else if (g.userData.wasSite) {
          g.userData.built.traverse((o) => {
            if (o.material) { o.material.transparent = false; o.material.opacity = 1; }
          });
        }
        g.userData.wasSite = !e.done;
      }

      // damage flash
      const flash = this.flashes.get(e.id);
      if (flash !== undefined) {
        const rem = flash - dt;
        if (rem <= 0) this.flashes.delete(e.id);
        else this.flashes.set(e.id, rem);
        const k = Math.max(0, rem / 0.12);
        for (const m of g.userData.mats || []) m.emissiveIntensity = 0.12 + k * 1.4;
      }

      // selection ring + health bar
      const sel = this.selection.has(e.id);
      if (g.userData.ringDetached) {
        // flyer ring rides on the terrain below the unit, not at altitude
        const r = g.userData.ringDetached;
        r.visible = sel && g.visible;
        if (sel) {
          r.position.set(x, terrainY + 0.04, z);
          r.material.opacity = 0.75 + Math.sin(t * 5) * 0.2;
        }
      } else if (g.userData.ring) {
        g.userData.ring.visible = sel;
        if (sel) g.userData.ring.material.opacity = 0.75 + Math.sin(t * 5) * 0.2;
      }
      if (g.userData.bar) {
        const show = (sel || e.hp < e.maxHp) && e.maxHp > 0;
        g.userData.bar.visible = show;
        if (show) {
          const frac = Math.max(0, e.hp / e.maxHp);
          g.userData.barFg.scale.x = frac;
          g.userData.barFg.position.x = -(1 - frac) / 2;
          g.userData.barFg.material.color.setHSL(frac * 0.33, 0.75, 0.5);
          g.userData.bar.quaternion.copy(this.camera.cam.quaternion);
        }
      }
    }

    for (const [id, g] of this.meshes) {
      if (!seen.has(id) && !this.sim.byId.has(id)) {
        this.scene.remove(g);
        if (g.userData.blobShadow) this.scene.remove(g.userData.blobShadow);
        if (g.userData.ringDetached) this.scene.remove(g.userData.ringDetached);
        this.meshes.delete(id);
        this.moveAmt.delete(id);
      }
    }

    // rally lines/flags (per building) + shift-queue path lines (per unit)
    this.updateRallyLines(t);
    this.updateQueuePaths();

    this.updateOrderMarkers(t);
    this.updateTaskSparks(t);

    // subtle shrub sway (LoS-blocker concealment tufts)
    if (this.shrubs) for (const s of this.shrubs) animateShrub(s, t);

    // faint ember pulse on lava-barrier crack decals
    if (this.emberMat) this.emberMat.opacity = 0.55 + Math.sin(t * 2.2) * 0.35;

    this.fx.update(dt);
    this.composer.render();
  }

  entityVisible(e) {
    if (e.owner === this.localPlayer) return true;
    if (e.type === "mineral" || e.type === "geyser") return true; // map is revealed
    const f = this.sim.fog[this.localPlayer][fpToTile(e.y) * this.sim.map.w + fpToTile(e.x)];
    if (e.building) return f === 2 || (e.seenBy & (1 << this.localPlayer)) !== 0;
    return f === 2;                                         // enemy units: live sight only
  }

  // ---------- sim events -> effects ----------

  consumeEvents(events) {
    for (const ev of events) {
      const vis = this.sim.fog[this.localPlayer][fpToTile(ev.y ?? ev.ty ?? 0) * this.sim.map.w + fpToTile(ev.x ?? ev.tx ?? 0)] === 2;
      switch (ev.t) {
        case "shot": {
          this.flashes.set(ev.targetId, 0.12);
          const g = this.meshes.get(ev.attackerId);
          if (g?.userData.anim) g.userData.anim.recoil = 0.08;
          if (!vis && !this.sim.fog[this.localPlayer][fpToTile(ev.fy) * this.sim.map.w + fpToTile(ev.fx)]) break;
          if (ev.ranged) {
            // muzzle/impact heights: a flyer endpoint sits at cruise altitude,
            // a ground endpoint at ~0.62. Attacker altitude = attacker unit's
            // fly flag; target altitude = the shot's `air` flag.
            const fromY = this.shotHeight(ev.attackerId, W2(ev.fx), W2(ev.fy), false);
            const toY = this.shotHeight(ev.targetId, W2(ev.tx), W2(ev.ty), ev.air);
            this.fx.bolt(W2(ev.fx), W2(ev.fy), W2(ev.tx), W2(ev.ty), PLAYER_COLORS[ev.owner], fromY, toY);
          } else {
            this.fx.meleeHit(W2(ev.tx), W2(ev.ty), PLAYER_COLORS[ev.owner]);
          }
          break;
        }
        case "death": {
          if (!vis && ev.owner !== this.localPlayer) break;
          if (ev.building) { this.fx.buildingDeath(W2(ev.x), W2(ev.y), ev.size || 2); break; }
          // a dying flyer: explode at altitude, then a falling wreck that drops
          // to the terrain and detonates on the ground.
          const flyer = !!UNITS[ev.type]?.fly;
          if (flyer) {
            const wx = W2(ev.x), wz = W2(ev.y);
            const alt = this.heightAt(wx, wz) + 2.2;
            this.fx.sparks.burst(wx, alt, wz, 22, PLAYER_COLORS[ev.owner], 4, 0.6);
            this.fx.sparks.burst(wx, alt, wz, 8, 0xffb347, 2.5, 0.5);
            this.fx.fallingWreck(wx, wz, alt, PLAYER_COLORS[ev.owner], null);
          } else {
            this.fx.unitDeath(W2(ev.x), W2(ev.y), PLAYER_COLORS[ev.owner]);
          }
          break;
        }
        case "complete":
          if (ev.owner === this.localPlayer) this.fx.shockRing(W2(ev.x), W2(ev.y), 0x1c7d3f, 2.2, 0.6);
          break;
        case "trained":
          break; // spawn poof handled on mesh creation
      }
    }
  }

  // World height of a shot endpoint. `airHint` (the shot's `air` flag) forces
  // altitude for the target; for the attacker we look up its entity fly flag.
  // Turret/building attackers sit low; their muzzle is ~0.9 up their body.
  shotHeight(entId, wx, wz, airHint) {
    const e = this.sim.byId.get(entId);
    const terrain = this.heightAt(wx, wz);
    if (airHint || (e && e.fly)) return terrain + 2.2;   // cruise altitude
    if (e && e.building) return terrain + 1.0;            // turret pod height
    return terrain + 0.62;                                // ground muzzle
  }

  orderPing(wx, wz, color) { this.fx.ping(wx, wz, color); }
}
