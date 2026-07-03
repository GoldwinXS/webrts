// Three.js presentation layer. Reads sim state every frame, owns no game
// logic. Interpolates between the last two sim ticks for smooth motion.
// v2: shadows, ACES + bloom, procedural terrain, animated models, effects.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { FP, fpToTile } from "../core/fixed.js";
import { makeRng } from "../core/fixed.js";
import { BUILDINGS, PLAYER_COLORS } from "../core/data.js";
import { RtsCamera } from "./camera.js";
import { makeUnitVisual, makeBuildingVisual, makeMineralVisual, animateVisual, SHARED } from "./models.js";
import { Effects } from "./fx.js";

const W2 = (v) => v / FP;   // fp -> world units (1 tile = 1.0)
const PX = 12;              // ground texture pixels per tile

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
    this.renderer.toneMappingExposure = 1.35;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070a10);
    this.scene.fog = new THREE.Fog(0x070a10, 55, 150);

    const start = sim.map.starts[localPlayer];
    this.camera = new RtsCamera(sim.map.w, sim.map.h, start.x, start.y);

    this.meshes = new Map();          // entity id -> visual group
    this.selection = new Set();       // set by input.js
    this.playerColors = PLAYER_COLORS.map((c) => new THREE.Color(c));
    this.flashes = new Map();         // entity id -> remaining flash seconds
    this.moveAmt = new Map();         // entity id -> smoothed motion 0..1
    this.clockStart = performance.now();

    this.buildLights();
    this.buildGround();
    this.buildRocks();
    this.buildStars();
    this.fx = new Effects(this.scene);

    this.ringMat = new THREE.MeshBasicMaterial({ color: 0x7cff6b, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false });
    this.barBgMat = new THREE.MeshBasicMaterial({ color: 0x10141a });
    this.buildRallyPool();
    this.buildQueuePaths();
    this.buildTargetRings();
    this.taskFxTimers = new Map();   // entity id -> next spark time (render-only)

    // post-processing: MSAA target + bloom (threshold 1.0 = only HDR emissive blooms)
    const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { samples: 4, type: THREE.HalfFloatType });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera.cam));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.55, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    window.addEventListener("resize", () => {
      this.camera.resize();
      this.renderer.setSize(innerWidth, innerHeight);
      this.composer.setSize(innerWidth, innerHeight);
    });
  }

  buildLights() {
    this.scene.add(new THREE.AmbientLight(0x8a9cbd, 0.65));
    const sun = new THREE.DirectionalLight(0xffe8c8, 1.9);
    sun.position.set(this.sim.map.w * 0.3, 42, this.sim.map.h * 0.15);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -30; c.right = 30; c.top = 30; c.bottom = -30;
    c.near = 5; c.far = 110;
    sun.shadow.bias = -0.0006;
    sun.target.position.set(this.sim.map.w / 2, 0, this.sim.map.h / 2);
    this.scene.add(sun, sun.target);
    this.sun = sun;
    const fill = new THREE.DirectionalLight(0x3a4d7a, 0.5);
    fill.position.set(-25, 28, -32);
    this.scene.add(fill);
  }

  // ---------- terrain ----------

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
    this.paintFog();

    const mat = new THREE.MeshStandardMaterial({ map: this.groundTex, roughness: 0.95, metalness: 0 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(w / 2, 0, h / 2);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.lastFogPaint = -1;
  }

  paintTerrain() {
    const { w, h, rock } = this.sim.map;
    const ctx = this.baseCanvas.getContext("2d");
    const rng = makeRng(this.sim.seed ^ 0x5eed);
    const rnd = () => rng() / 0xffffffff;

    // grass base with two-octave value noise
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const isRock = rock[i];
        for (let sy = 0; sy < PX; sy += 3) {
          for (let sx = 0; sx < PX; sx += 3) {
            const n = rnd();
            let r, g, b;
            if (isRock) {
              const v = 56 + n * 20;
              r = v; g = v + 4; b = v + 12;
            } else {
              const patch = rnd() > 0.94;
              r = 40 + n * 16 + (patch ? 18 : 0);
              g = 68 + n * 22 + (patch ? 13 : 0);
              b = 42 + n * 13;
            }
            ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
            ctx.fillRect(x * PX + sx, y * PX + sy, 3, 3);
          }
        }
      }
    }
    // faint tile grid for placement legibility
    ctx.strokeStyle = "rgba(140,200,255,0.045)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x++) { ctx.moveTo(x * PX + 0.5, 0); ctx.lineTo(x * PX + 0.5, h * PX); }
    for (let y = 0; y <= h; y++) { ctx.moveTo(0, y * PX + 0.5); ctx.lineTo(w * PX, y * PX + 0.5); }
    ctx.stroke();
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
        ctx.fillStyle = f === 1 ? "rgba(4,6,10,0.55)" : "rgba(3,4,8,0.9)";
        ctx.fillRect(x * PX, y * PX, PX, PX);
      }
    }
    this.groundTex.needsUpdate = true;
  }

  buildRocks() {
    const { w, h, rock } = this.sim.map;
    const positions = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (rock[y * w + x]) positions.push([x + 0.5, y + 0.5]);
    const geo = new THREE.DodecahedronGeometry(0.55);
    const mat = new THREE.MeshStandardMaterial({ color: 0x555e6b, roughness: 0.85 });
    const inst = new THREE.InstancedMesh(geo, mat, positions.length);
    inst.castShadow = true;
    inst.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    positions.forEach(([x, z], i) => {
      const s = 0.75 + ((x * 7 + z * 13) % 6) / 9;
      q.setFromEuler(new THREE.Euler(((x * 3) % 7) / 7, ((z * 5) % 9) / 9 * Math.PI, 0));
      m.compose(new THREE.Vector3(x, 0.22 + (s - 0.75) * 0.2, z), q, new THREE.Vector3(s, s * 0.75, s));
      inst.setMatrixAt(i, m);
    });
    this.scene.add(inst);
  }

  buildStars() {
    const n = 700;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const cx = this.sim.map.w / 2, cz = this.sim.map.h / 2;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const alt = Math.random() * Math.PI * 0.42 + 0.06;
      const r = 130;
      pos[i * 3] = cx + Math.cos(a) * Math.cos(alt) * r;
      pos[i * 3 + 1] = Math.sin(alt) * r;
      pos[i * 3 + 2] = cz + Math.sin(a) * Math.cos(alt) * r;
      const b = 0.35 + Math.random() * 0.65;
      const warm = Math.random() > 0.8;
      col[i * 3] = b; col[i * 3 + 1] = b * (warm ? 0.85 : 0.95); col[i * 3 + 2] = b * (warm ? 0.7 : 1.1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const stars = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.8, vertexColors: true, sizeAttenuation: false,
      transparent: true, opacity: 0.85, depthWrite: false, fog: false,
    }));
    stars.frustumCulled = false;
    this.scene.add(stars);
  }

  // one dashed rally line (building center -> rally point)
  makeRallyLine() {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(), new THREE.Vector3(),
    ]);
    const mat = new THREE.LineDashedMaterial({
      color: 0x7cff6b, dashSize: 0.45, gapSize: 0.3,
      transparent: true, opacity: 0.65, depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    line.visible = false;
    line.frustumCulled = false;
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

  // one pooled LineSegments buffer drawing selected units' queued paths
  buildQueuePaths() {
    this.queueMaxSegments = 600;                 // 2 verts/segment, 3 floats/vert
    const geo = new THREE.BufferGeometry();
    const buf = new Float32Array(this.queueMaxSegments * 2 * 3);
    this.queuePathPos = new THREE.BufferAttribute(buf, 3);
    this.queuePathPos.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.queuePathPos);
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      color: 0x7cff6b, transparent: true, opacity: 0.4, depthWrite: false,
    });
    this.queuePaths = new THREE.LineSegments(geo, mat);
    this.queuePaths.frustumCulled = false;
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
  updateQueuePaths() {
    const sim = this.sim;
    const arr = this.queuePathPos.array;
    const cap = this.queueMaxSegments;
    const Y = 0.14;
    let seg = 0;

    const push = (ax, az, bx, bz) => {
      if (seg >= cap) return false;
      const i = seg * 6;
      arr[i] = ax; arr[i + 1] = Y; arr[i + 2] = az;
      arr[i + 3] = bx; arr[i + 4] = Y; arr[i + 5] = bz;
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
        // patrol also shows its route leg (ox,oy)<->(x,y)
        if (o.kind === "patrol") {
          if (!push(W2(o.ox), W2(o.oy), W2(o.x), W2(o.y))) break outer;
        }
        const pt = this.orderPoint(o);
        if (!pt) break;                            // hold/idle stop the chain
        if (!push(px, pz, pt[0], pt[1])) break outer;
        px = pt[0]; pz = pt[1];
      }
    }

    this.queuePaths.geometry.setDrawRange(0, seg * 2);
    this.queuePathPos.needsUpdate = true;
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
      line.visible = true;
      const pts = line.geometry.attributes.position;
      pts.setXYZ(0, W2(b.x), 0.12, W2(b.y));
      pts.setXYZ(1, rx, 0.12, rz);
      pts.needsUpdate = true;
      line.computeLineDistances();
      const onMineral = b.rally.targetId && sim.byId.get(b.rally.targetId)?.type === "mineral";
      line.material.color.setHex(onMineral ? 0x63e8db : 0x7cff6b);

      flag.visible = true;
      flag.position.set(rx, 0, rz);
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
          if (depot) targets.set(depot.id, 0x63e8db);
        } else if (sim.byId.has(o.targetId)) targets.set(o.targetId, 0x63e8db);
      } else if (o.kind === "build" && sim.byId.has(o.targetId)) {
        targets.set(o.targetId, 0xffb347);
      } else if (o.kind === "attack" && sim.byId.has(o.targetId)) {
        targets.set(o.targetId, 0xff5f4c);
      }
      if (targets.size >= this.targetRings.length) break;
    }
    let i = 0;
    for (const [tid, color] of targets) {
      const target = sim.byId.get(tid);
      const ring = this.targetRings[i++];
      ring.visible = true;
      ring.position.set(W2(target.x), 0.04, W2(target.y));
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
        this.fx.sparks.burst(cx, 0.4, cz, count, color, 1.1, 0.3, 1.4);
      }
    }
  }

  makeRallyFlag() {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(SHARED.pole, new THREE.MeshBasicMaterial({ color: 0xcccccc }));
    pole.position.y = 0.7;
    const flag = new THREE.Mesh(SHARED.flag, new THREE.MeshBasicMaterial({ color: 0x7cff6b }));
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
    if (e.type === "mineral") {
      group = makeMineralVisual(e);
    } else if (e.unit) {
      group = makeUnitVisual(e, color);
      this.addRingAndBar(group, e, 0.55, 1.25);
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

  // ---------- per-frame sync ----------

  render(alpha, dt = 1 / 60) {
    const sim = this.sim;
    const t = (performance.now() - this.clockStart) / 1000;
    const seen = new Set();

    if (sim.tick !== this.lastFogPaint && sim.tick % 3 === 0) {
      this.paintFog();
      this.lastFogPaint = sim.tick;
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
      if (!visible) continue;

      const x = W2(e.px + (e.x - e.px) * alpha);
      const z = W2(e.py + (e.y - e.py) * alpha);
      g.position.set(x, 0, z);

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
        g.userData.body.rotation.y += dy * Math.min(1, dt * 12);
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
      if (g.userData.ring) {
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
        this.meshes.delete(id);
        this.moveAmt.delete(id);
      }
    }

    // rally lines/flags (per building) + shift-queue path lines (per unit)
    this.updateRallyLines(t);
    this.updateQueuePaths();

    this.updateOrderMarkers(t);
    this.updateTaskSparks(t);

    this.fx.update(dt);
    this.composer.render();
  }

  entityVisible(e) {
    if (e.owner === this.localPlayer) return true;
    if (e.type === "mineral") return true;                  // map is revealed
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
          if (ev.ranged) this.fx.bolt(W2(ev.fx), W2(ev.fy), W2(ev.tx), W2(ev.ty), PLAYER_COLORS[ev.owner]);
          else this.fx.meleeHit(W2(ev.tx), W2(ev.ty), PLAYER_COLORS[ev.owner]);
          break;
        }
        case "death":
          if (!vis && ev.owner !== this.localPlayer) break;
          if (ev.building) this.fx.buildingDeath(W2(ev.x), W2(ev.y), ev.size || 2);
          else this.fx.unitDeath(W2(ev.x), W2(ev.y), PLAYER_COLORS[ev.owner]);
          break;
        case "complete":
          if (ev.owner === this.localPlayer) this.fx.shockRing(W2(ev.x), W2(ev.y), 0x7cff6b, 2.2, 0.6);
          break;
        case "trained":
          break; // spawn poof handled on mesh creation
      }
    }
  }

  orderPing(wx, wz, color) { this.fx.ping(wx, wz, color); }
}
