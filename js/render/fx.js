// Transient visual effects: GPU point sparks, sprite smoke, traveling bolts,
// muzzle flashes, shockwave rings, scorch decals. Pool-based, render-only.
import * as THREE from "three";

// ---------- spark particles (one Points cloud, CPU-simmed) ----------

class SparkPool {
  constructor(scene, count = 600) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.baseCol = new Float32Array(count * 3);
    this.free = [];
    for (let i = count - 1; i >= 0; i--) { this.free.push(i); this.pos[i * 3 + 1] = -999; }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.14, vertexColors: true, blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  burst(x, y, z, n, color, speed = 4, life = 0.6, up = 2.5) {
    const c = new THREE.Color(color);
    for (let k = 0; k < n; k++) {
      const i = this.free.pop();
      if (i === undefined) return;
      const i3 = i * 3;
      this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
      const a = Math.random() * Math.PI * 2;
      const r = (0.3 + Math.random() * 0.7) * speed;
      this.vel[i3] = Math.cos(a) * r;
      this.vel[i3 + 1] = Math.random() * up + up * 0.3;
      this.vel[i3 + 2] = Math.sin(a) * r;
      const tint = 0.6 + Math.random() * 0.4;
      this.baseCol[i3] = c.r * tint; this.baseCol[i3 + 1] = c.g * tint; this.baseCol[i3 + 2] = c.b * tint;
      this.life[i] = this.maxLife[i] = life * (0.5 + Math.random() * 0.5);
    }
  }

  update(dt) {
    let dirty = false;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      dirty = true;
      const i3 = i * 3;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.pos[i3 + 1] = -999;
        this.col[i3] = this.col[i3 + 1] = this.col[i3 + 2] = 0;
        this.free.push(i);
        continue;
      }
      this.vel[i3 + 1] -= 9 * dt;                    // gravity
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] = Math.max(0.02, this.pos[i3 + 1] + this.vel[i3 + 1] * dt);
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const f = this.life[i] / this.maxLife[i];      // additive: fade to black
      this.col[i3] = this.baseCol[i3] * f;
      this.col[i3 + 1] = this.baseCol[i3 + 1] * f;
      this.col[i3 + 2] = this.baseCol[i3 + 2] * f;
    }
    if (dirty) {
      this.points.geometry.attributes.position.needsUpdate = true;
      this.points.geometry.attributes.color.needsUpdate = true;
    }
  }
}

// ---------- smoke sprites ----------

function makeSmokeTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
  g.addColorStop(0, "rgba(200,200,210,0.85)");
  g.addColorStop(0.6, "rgba(140,140,150,0.35)");
  g.addColorStop(1, "rgba(120,120,130,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

class SmokePool {
  constructor(scene, count = 48) {
    this.tex = makeSmokeTexture();
    this.items = [];
    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({ map: this.tex, transparent: true, opacity: 0, depthWrite: false });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      scene.add(s);
      this.items.push({ s, life: 0, max: 1, vy: 0, grow: 0 });
    }
    this.next = 0;
  }

  puff(x, y, z, scale = 1, life = 1.4) {
    const it = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    it.s.visible = true;
    it.s.position.set(x + (Math.random() - 0.5) * 0.4, y, z + (Math.random() - 0.5) * 0.4);
    it.s.scale.setScalar(0.5 * scale);
    it.life = it.max = life * (0.7 + Math.random() * 0.6);
    it.vy = 0.5 + Math.random() * 0.5;
    it.grow = 1.1 * scale;
  }

  update(dt) {
    for (const it of this.items) {
      if (it.life <= 0) continue;
      it.life -= dt;
      if (it.life <= 0) { it.s.visible = false; it.s.material.opacity = 0; continue; }
      const f = it.life / it.max;
      it.s.position.y += it.vy * dt;
      it.s.scale.addScalar(it.grow * dt);
      it.s.material.opacity = 0.55 * f;
    }
  }
}

// ---------- the effects manager ----------

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.sparks = new SparkPool(scene);
    this.smoke = new SmokePool(scene);
    this.live = [];   // bolts, flashes, rings, decals
    this.boltGeo = new THREE.BoxGeometry(0.055, 0.055, 0.5);
    this.flashGeo = new THREE.SphereGeometry(0.11, 8, 6);
    this.ringGeo = new THREE.RingGeometry(0.28, 0.42, 26);
    this.decalGeo = new THREE.CircleGeometry(1, 20);
    // optional terrain height sampler (set by the renderer). When present,
    // effects are lifted onto the terrain surface. Call signatures unchanged.
    this.heightAt = null;
  }

  // terrain lift for a world (x,z); 0 when no sampler is wired
  gy(x, z) { return this.heightAt ? this.heightAt(x, z) : 0; }

  add(obj, data) {
    this.scene.add(obj);
    this.live.push({ obj, ...data });
  }

  basic(color, opacity = 1) {
    return new THREE.MeshBasicMaterial({
      color, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
  }

  // traveling projectile from a to b; sparks on arrival
  bolt(ax, az, bx, bz, color) {
    const ay = this.gy(ax, az), by = this.gy(bx, bz);
    const m = new THREE.Mesh(this.boltGeo, this.basic(color));
    m.position.set(ax, 0.62 + ay, az);
    m.lookAt(bx, 0.55 + by, bz);
    const d = Math.hypot(bx - ax, bz - az);
    const dur = Math.max(0.06, d / 34);
    this.add(m, { kind: "bolt", t: 0, dur, ax, ay, az, bx, by, bz, color });
    // muzzle flash
    const f = new THREE.Mesh(this.flashGeo, this.basic(color, 0.95));
    f.position.set(ax + (bx - ax) / d * 0.35, 0.62 + ay, az + (bz - az) / d * 0.35);
    this.add(f, { kind: "flash", t: 0, dur: 0.07 });
  }

  meleeHit(x, z, color) {
    this.sparks.burst(x, 0.5 + this.gy(x, z), z, 6, color, 2.5, 0.35, 1.5);
  }

  unitDeath(x, z, color) {
    const y = this.gy(x, z);
    this.sparks.burst(x, 0.4 + y, z, 26, color, 4, 0.7);
    this.sparks.burst(x, 0.3 + y, z, 10, 0xffb347, 2.5, 0.5);
    this.smoke.puff(x, 0.5 + y, z, 0.9);
    this.shockRing(x, z, 0xffb347, 1.6, 0.4);
  }

  buildingDeath(x, z, size) {
    const y = this.gy(x, z);
    this.sparks.burst(x, 0.6 + y, z, 70, 0xff9540, 6, 1.0, 4);
    this.sparks.burst(x, 0.4 + y, z, 30, 0xffe08a, 4, 0.8);
    for (let i = 0; i < 5; i++) this.smoke.puff(x, 0.4 + y, z, 1.6, 2.2);
    this.shockRing(x, z, 0xff7733, size * 1.6, 0.7);
    // scorch decal
    const d = new THREE.Mesh(this.decalGeo, new THREE.MeshBasicMaterial({
      color: 0x0a0a0c, transparent: true, opacity: 0.75, depthWrite: false,
    }));
    d.rotation.x = -Math.PI / 2;
    d.position.set(x, 0.015 + y, z);
    d.scale.setScalar(size * 0.7);
    this.add(d, { kind: "decal", t: 0, dur: 14 });
  }

  shockRing(x, z, color, maxScale = 2, dur = 0.5) {
    const r = new THREE.Mesh(this.ringGeo, this.basic(color, 0.9));
    r.rotation.x = -Math.PI / 2;
    r.position.set(x, 0.06 + this.gy(x, z), z);
    this.add(r, { kind: "ring", t: 0, dur, maxScale });
  }

  // green/red order feedback marker on the ground
  ping(x, z, color) {
    const r = new THREE.Mesh(this.ringGeo, this.basic(color, 0.95));
    r.rotation.x = -Math.PI / 2;
    r.position.set(x, 0.05 + this.gy(x, z), z);
    r.scale.setScalar(2.2);
    this.add(r, { kind: "ping", t: 0, dur: 0.5 });
  }

  spawnPoof(x, z, color) {
    this.sparks.burst(x, 0.2 + this.gy(x, z), z, 10, color, 1.6, 0.4, 2);
  }

  update(dt) {
    this.sparks.update(dt);
    this.smoke.update(dt);
    for (let i = this.live.length - 1; i >= 0; i--) {
      const fx = this.live[i];
      fx.t += dt;
      const p = fx.t / fx.dur;
      if (p >= 1) {
        if (fx.kind === "bolt") this.sparks.burst(fx.bx, 0.55 + (fx.by || 0), fx.bz, 5, fx.color, 2, 0.3, 1);
        this.scene.remove(fx.obj);
        fx.obj.material.dispose();
        this.live.splice(i, 1);
        continue;
      }
      switch (fx.kind) {
        case "bolt":
          fx.obj.position.set(fx.ax + (fx.bx - fx.ax) * p, 0.62 + (fx.ay || 0) + ((fx.by || 0) - (fx.ay || 0)) * p, fx.az + (fx.bz - fx.az) * p);
          break;
        case "flash":
          fx.obj.scale.setScalar(1 + p * 2.2);
          fx.obj.material.opacity = 0.95 * (1 - p);
          break;
        case "ring":
          fx.obj.scale.setScalar(0.4 + p * fx.maxScale * 2.4);
          fx.obj.material.opacity = 0.9 * (1 - p);
          break;
        case "ping":
          fx.obj.scale.setScalar(2.2 * (1 - p * 0.75));
          fx.obj.material.opacity = 0.95 * (1 - p * p);
          break;
        case "decal":
          if (p > 0.6) fx.obj.material.opacity = 0.75 * (1 - (p - 0.6) / 0.4);
          break;
      }
    }
  }
}
