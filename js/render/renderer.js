// Three.js presentation layer. Reads sim state every frame, owns no game
// logic. Interpolates between the last two sim ticks for smooth motion.
import * as THREE from "three";
import { FP, fpToTile } from "../core/fixed.js";
import { UNITS, BUILDINGS, PLAYER_COLORS } from "../core/data.js";
import { RtsCamera } from "./camera.js";

const W2 = (v) => v / FP;   // fp -> world units (1 tile = 1.0)

export class Renderer {
  constructor(canvas, sim, localPlayer) {
    this.sim = sim;
    this.localPlayer = localPlayer;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0e14);
    this.scene.fog = new THREE.Fog(0x0a0e14, 60, 160);

    const start = sim.map.starts[localPlayer];
    this.camera = new RtsCamera(sim.map.w, sim.map.h, start.x, start.y);

    this.meshes = new Map();          // entity id -> visual group
    this.effects = [];                // transient tracers / rings
    this.selection = new Set();       // set by input.js
    this.playerColors = PLAYER_COLORS.map((c) => new THREE.Color(c));

    this.buildLights();
    this.buildGround();
    this.buildRocks();
    this.sharedGeo = {
      workerBody: new THREE.SphereGeometry(0.32, 12, 10),
      marineBody: new THREE.CapsuleGeometry(0.24, 0.42, 4, 10),
      marineGun: new THREE.BoxGeometry(0.08, 0.08, 0.55),
      bruteBody: new THREE.ConeGeometry(0.45, 1.0, 8),
      mineral: new THREE.OctahedronGeometry(0.42),
      ring: new THREE.RingGeometry(0.5, 0.62, 24),
      bar: new THREE.PlaneGeometry(1, 0.12),
    };
    this.mineralMat = new THREE.MeshStandardMaterial({ color: 0x4adfd2, emissive: 0x0d4a44, roughness: 0.2, metalness: 0.6 });
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0x7cff6b, side: THREE.DoubleSide, transparent: true, opacity: 0.9 });

    window.addEventListener("resize", () => {
      this.camera.resize();
      this.renderer.setSize(innerWidth, innerHeight);
    });
  }

  buildLights() {
    this.scene.add(new THREE.AmbientLight(0x8899bb, 0.55));
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.15);
    sun.position.set(30, 50, 10);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x334466, 0.4);
    fill.position.set(-20, 30, -30);
    this.scene.add(fill);
  }

  buildGround() {
    const { w, h } = this.sim.map;
    this.groundCanvas = document.createElement("canvas");
    this.groundCanvas.width = w * 8;
    this.groundCanvas.height = h * 8;
    this.groundTex = new THREE.CanvasTexture(this.groundCanvas);
    this.groundTex.magFilter = THREE.LinearFilter;
    this.paintGround();
    const mat = new THREE.MeshStandardMaterial({ map: this.groundTex, roughness: 0.95 });
    const geo = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(w / 2, 0, h / 2);
    this.scene.add(mesh);
    this.lastFogPaint = -1;
  }

  // Terrain + fog baked into one canvas texture, repainted when fog changes.
  paintGround() {
    const { w, h, rock } = this.sim.map;
    const fog = this.sim.fog[this.localPlayer];
    const ctx = this.groundCanvas.getContext("2d");
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let c;
        if (rock[i]) c = [52, 58, 66];
        else {
          const check = (x + y) & 1;
          c = check ? [38, 62, 42] : [35, 57, 39];
        }
        const f = fog[i];
        const mul = f === 2 ? 1 : f === 1 ? 0.45 : 0.12;
        ctx.fillStyle = `rgb(${(c[0] * mul) | 0},${(c[1] * mul) | 0},${(c[2] * mul) | 0})`;
        ctx.fillRect(x * 8, y * 8, 8, 8);
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
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a525e, roughness: 0.9 });
    const inst = new THREE.InstancedMesh(geo, mat, positions.length);
    const m = new THREE.Matrix4();
    positions.forEach(([x, z], i) => {
      const s = 0.8 + ((x * 7 + z * 13) % 5) / 10;
      m.makeScale(s, s * 0.8, s);
      m.setPosition(x, 0.25, z);
      inst.setMatrixAt(i, m);
    });
    this.scene.add(inst);
  }

  // ---------- entity visuals ----------

  makeMesh(e) {
    const group = new THREE.Group();
    const color = e.owner >= 0 ? this.playerColors[e.owner] : null;

    if (e.type === "mineral") {
      const m = new THREE.Mesh(this.sharedGeo.mineral, this.mineralMat);
      m.position.y = 0.35;
      m.rotation.y = (e.id * 0.7) % Math.PI;
      group.add(m);
      group.userData.crystal = m;
    } else if (e.unit) {
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.3 });
      const body = new THREE.Group();
      if (e.type === "worker") {
        const b = new THREE.Mesh(this.sharedGeo.workerBody, mat);
        b.position.y = 0.34; b.scale.y = 0.75;
        body.add(b);
      } else if (e.type === "marine") {
        const b = new THREE.Mesh(this.sharedGeo.marineBody, mat);
        b.position.y = 0.5;
        const gun = new THREE.Mesh(this.sharedGeo.marineGun,
          new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.4 }));
        gun.position.set(0.18, 0.55, 0.25);
        body.add(b, gun);
      } else { // brute
        const b = new THREE.Mesh(this.sharedGeo.bruteBody, mat);
        b.position.y = 0.5;
        body.add(b);
      }
      group.add(body);
      group.userData.body = body;
      this.addRingAndBar(group, e, 0.55);
    } else if (e.building) {
      const d = BUILDINGS[e.type];
      const built = new THREE.Group();
      const base = new THREE.MeshStandardMaterial({ color: 0x39424e, roughness: 0.7, metalness: 0.35 });
      const trim = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.4, emissive: color, emissiveIntensity: 0.15 });
      if (e.type === "hq") {
        const b1 = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.1, 2.6), base);
        b1.position.y = 0.55;
        const b2 = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 0.9, 8), trim);
        b2.position.y = 1.55;
        built.add(b1, b2);
      } else if (e.type === "depot") {
        const b1 = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.7, 1.7), base);
        b1.position.y = 0.35;
        const b2 = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.35, 1.2), trim);
        b2.position.y = 0.87;
        built.add(b1, b2);
      } else { // barracks
        const b1 = new THREE.Mesh(new THREE.BoxGeometry(2.5, 1.3, 2.2), base);
        b1.position.y = 0.65;
        const b2 = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.25), trim);
        b2.position.set(0, 0.45, 1.15);
        built.add(b1, b2);
      }
      group.add(built);
      group.userData.built = built;
      this.addRingAndBar(group, e, d.size * 0.62);
    }

    // pickable body reference for raycasting
    group.traverse((o) => { o.userData.eid = e.id; });
    group.position.set(W2(e.x), 0, W2(e.y));
    this.scene.add(group);
    return group;
  }

  addRingAndBar(group, e, ringScale) {
    const ring = new THREE.Mesh(this.sharedGeo.ring, this.ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.scale.setScalar(ringScale * 2);
    ring.visible = false;
    group.add(ring);
    group.userData.ring = ring;

    const barBg = new THREE.Mesh(this.sharedGeo.bar, new THREE.MeshBasicMaterial({ color: 0x1a1e24 }));
    const barFg = new THREE.Mesh(this.sharedGeo.bar, new THREE.MeshBasicMaterial({ color: 0x62d96b }));
    barFg.position.z = 0.001;
    const bar = new THREE.Group();
    bar.add(barBg, barFg);
    bar.position.y = e.building ? 2.1 : 1.25;
    bar.visible = false;
    group.add(bar);
    group.userData.bar = bar;
    group.userData.barFg = barFg;
  }

  // ---------- per-frame sync ----------

  render(alpha) {
    const sim = this.sim;
    const seen = new Set();

    // repaint fog when the sim updated it
    if (sim.tick !== this.lastFogPaint && sim.tick % 3 === 0) {
      this.paintGround();
      this.lastFogPaint = sim.tick;
    }

    for (const e of sim.entities) {
      const visible = this.entityVisible(e);
      let g = this.meshes.get(e.id);
      if (!g) {
        if (!visible) continue;
        g = this.makeMesh(e);
        this.meshes.set(e.id, g);
      }
      seen.add(e.id);
      g.visible = visible;
      if (!visible) continue;

      // interpolate between previous and current sim position
      const x = W2(e.px + (e.x - e.px) * alpha);
      const z = W2(e.py + (e.y - e.py) * alpha);
      g.position.set(x, 0, z);

      // face travel direction
      if (g.userData.body && (e.x !== e.px || e.y !== e.py)) {
        g.userData.body.rotation.y = Math.atan2(e.x - e.px, e.y - e.py);
      }

      if (g.userData.crystal) {
        const s = 0.5 + 0.5 * (e.amount / 1500);
        g.userData.crystal.scale.setScalar(s);
      }

      // construction progress: building rises out of the ground
      if (g.userData.built) {
        const d = BUILDINGS[e.type];
        const p = e.done ? 1 : Math.max(0.15, e.progress / d.buildTime);
        g.userData.built.scale.y = p;
        g.userData.built.traverse((o) => {
          if (o.material && o.material.transparent !== undefined) {
            o.material.transparent = !e.done;
            o.material.opacity = e.done ? 1 : 0.55 + p * 0.4;
          }
        });
      }

      // selection ring + health bar
      const sel = this.selection.has(e.id);
      if (g.userData.ring) g.userData.ring.visible = sel;
      if (g.userData.bar) {
        const show = sel || e.hp < e.maxHp;
        g.userData.bar.visible = show && e.maxHp > 0;
        if (show && e.maxHp > 0) {
          const frac = Math.max(0, e.hp / e.maxHp);
          g.userData.barFg.scale.x = frac;
          g.userData.barFg.position.x = -(1 - frac) / 2;
          g.userData.barFg.material.color.setHSL(frac * 0.33, 0.8, 0.5);
          g.userData.bar.quaternion.copy(this.camera.cam.quaternion);
        }
      }
    }

    // remove visuals for dead entities
    for (const [id, g] of this.meshes) {
      if (!seen.has(id) && !this.sim.byId.has(id)) {
        this.scene.remove(g);
        this.meshes.delete(id);
      }
    }

    this.updateEffects();
    this.renderer.render(this.scene, this.camera.cam);
  }

  entityVisible(e) {
    if (e.owner === this.localPlayer) return true;
    const f = this.sim.fog[this.localPlayer][fpToTile(e.y) * this.sim.map.w + fpToTile(e.x)];
    if (e.type === "mineral" || e.building) return f >= 1;  // remembered once seen
    return f === 2;
  }

  // ---------- transient effects ----------

  consumeEvents(events) {
    for (const ev of events) {
      if (ev.t === "shot" && ev.ranged) {
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(W2(ev.fx), 0.6, W2(ev.fy)),
          new THREE.Vector3(W2(ev.tx), 0.5, W2(ev.ty)),
        ]);
        const mat = new THREE.LineBasicMaterial({ color: this.playerColors[ev.owner], transparent: true, opacity: 0.9 });
        const line = new THREE.Line(geo, mat);
        this.scene.add(line);
        this.effects.push({ obj: line, ttl: 0.09, kind: "line" });
      } else if (ev.t === "death") {
        const geo = new THREE.RingGeometry(0.1, 0.35, 20);
        const mat = new THREE.MeshBasicMaterial({ color: 0xffaa55, side: THREE.DoubleSide, transparent: true });
        const ring = new THREE.Mesh(geo, mat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(W2(ev.x), 0.1, W2(ev.y));
        this.scene.add(ring);
        this.effects.push({ obj: ring, ttl: 0.45, max: 0.45, kind: "ring" });
      }
    }
  }

  updateEffects() {
    const dt = 1 / 60;
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.ttl -= dt;
      if (fx.ttl <= 0) {
        this.scene.remove(fx.obj);
        fx.obj.geometry?.dispose();
        fx.obj.material?.dispose();
        this.effects.splice(i, 1);
      } else if (fx.kind === "ring") {
        const p = 1 - fx.ttl / fx.max;
        fx.obj.scale.setScalar(1 + p * 4);
        fx.obj.material.opacity = 1 - p;
      }
    }
  }
}
