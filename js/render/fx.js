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
    // thin unit-radius ring (r 1) scaled to arbitrary field radii for ability
    // boundaries (dome pop, shockwave). Additive, shares the ring update path.
    this.thinRingGeo = new THREE.RingGeometry(0.9, 1.0, 40);
    // hemisphere shell for the Shield Dome bubble (top half of a sphere,
    // open bottom so it reads as a dome sitting on the ground).
    this.domeGeo = new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.5);
    // small elongated rocket body (a stubby capsule-ish cylinder) for the
    // Rumble barrage tracers — points along +Z so lookAt() aims it down-range.
    this.rocketGeo = new THREE.CylinderGeometry(0.06, 0.11, 0.42, 7);
    this.rocketGeo.rotateX(Math.PI / 2);   // long axis -> +Z (matches bolt/lookAt)
    // flat stretched quad for dash afterimages (a soft additive streak plane)
    this.streakGeo = new THREE.PlaneGeometry(1, 1);
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

  // traveling projectile from a to b; sparks on arrival. fromY/toY are ABSOLUTE
  // world heights for the muzzle/impact (used for air combat so bolts angle
  // correctly). When omitted, the legacy behavior applies: terrain lift + 0.62.
  bolt(ax, az, bx, bz, color, fromY, toY) {
    const ay = fromY !== undefined ? fromY : 0.62 + this.gy(ax, az);
    const by = toY !== undefined ? toY : 0.55 + this.gy(bx, bz);
    const m = new THREE.Mesh(this.boltGeo, this.basic(color));
    m.position.set(ax, ay, az);
    m.lookAt(bx, by, bz);
    const d = Math.hypot(bx - ax, bz - az);
    const dur = Math.max(0.06, d / 34);
    // store absolute endpoint heights so update() lerps in world space
    this.add(m, { kind: "bolt", t: 0, dur, ax, ay, az, bx, by, bz, color, absY: true });
    // muzzle flash at the muzzle height
    const f = new THREE.Mesh(this.flashGeo, this.basic(color, 0.95));
    f.position.set(ax + (bx - ax) / d * 0.35, ay, az + (bz - az) / d * 0.35);
    this.add(f, { kind: "flash", t: 0, dur: 0.07 });
  }

  // A render-only falling wreck: an object (silhouette or generic chunk) that
  // tumbles and drops from `fromY` to the terrain over ~0.7s, then a ground
  // explosion. Used when a flyer dies mid-air.
  fallingWreck(x, z, fromY, color, silhouette) {
    let obj = silhouette;
    if (!obj) {
      // rounded low-poly hull chunk (gently bevelled, no polyhedra)
      obj = new THREE.Mesh(
        new THREE.SphereGeometry(0.32, 10, 8),
        new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.5, emissive: color, emissiveIntensity: 0.35 }));
      obj.scale.set(1, 0.62, 1.2);
    }
    obj.position.set(x, fromY, z);
    const groundY = this.gy(x, z);
    this.add(obj, {
      kind: "wreck", t: 0, dur: 0.7, x, z, fromY, groundY, color,
      spinx: (Math.random() - 0.5) * 12, spinz: (Math.random() - 0.5) * 12,
      trail: 0,
    });
    // a little smoke plume trailing the fall
    this.smoke.puff(x, fromY, z, 0.7, 0.9);
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

  // A thin bright expanding ring on the ground (like shockRing but a crisp hoop
  // instead of the thick default ring). start..end are world radii.
  hoop(x, z, color, start, end, dur = 0.4, opacity = 0.9) {
    const r = new THREE.Mesh(this.thinRingGeo, this.basic(color, opacity));
    r.rotation.x = -Math.PI / 2;
    r.position.set(x, 0.06 + this.gy(x, z), z);
    r.scale.setScalar(start);
    this.add(r, { kind: "hoop", t: 0, dur, from: start, to: end, startA: opacity });
  }

  // A ground-hugging ring of small dust puffs (settle plume) — reused by
  // siege/burrow transitions and heavy landings.
  dustRing(x, z, n = 8, scale = 0.8, rad = 0.9) {
    const y = this.gy(x, z);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + Math.random() * 0.4;
      const rr = rad * (0.7 + Math.random() * 0.5);
      this.smoke.puff(x + Math.cos(a) * rr, 0.15 + y, z + Math.sin(a) * rr, scale, 1.1);
    }
  }

  // --- ability fx ------------------------------------------------------------

  // Marine Overclock (stim): a snappy amber glow burst + upward speed-lines.
  stim(x, z, color = 0xffb733) {
    const y = this.gy(x, z);
    // tight upward jet of amber sparks (speed-lines), little lateral spread
    this.sparks.burst(x, 0.4 + y, z, 16, color, 1.4, 0.45, 4.5);
    this.sparks.burst(x, 0.3 + y, z, 6, 0xfff0c8, 1.0, 0.35, 3.5);
    this.hoop(x, z, color, 0.5, 1.6, 0.35, 0.85);
  }

  // Nip Frenzy: a bile-green burst + a quick low green hoop (visual "shake").
  frenzy(x, z, color = 0x8ff23a) {
    const y = this.gy(x, z);
    this.sparks.burst(x, 0.35 + y, z, 20, color, 3.2, 0.5, 3);
    this.sparks.burst(x, 0.3 + y, z, 8, 0xd8ff8a, 2.0, 0.4, 2);
    this.hoop(x, z, color, 0.4, 1.8, 0.35, 0.8);
  }

  // Siege / burrow settle: dust puff ring + a low thump hoop that reads as the
  // machine planting itself. `up` true = deploying (bigger), false = packing.
  settle(x, z, color = 0xcbb58c, big = true) {
    this.dustRing(x, z, big ? 10 : 7, big ? 0.9 : 0.7, big ? 1.0 : 0.75);
    this.hoop(x, z, color, 0.5, big ? 2.2 : 1.6, 0.4, 0.7);
    this.sparks.burst(x, 0.25 + this.gy(x, z), z, big ? 8 : 5, color, 1.6, 0.4, 1.2);
  }

  // Heavy landing slam (leap_land / engulf): shockwave hoop + dust + amber grit.
  slam(x, z, color = 0xffd58a) {
    const y = this.gy(x, z);
    this.hoop(x, z, color, 0.5, 2.6, 0.4, 0.95);
    this.dustRing(x, z, 9, 0.85, 1.0);
    this.sparks.burst(x, 0.25 + y, z, 14, color, 3, 0.45, 1.6);
  }

  // Sentinel Shield Dome CAST flash: a beefier translucent cyan hemisphere that
  // pops in over the field radius and fades out, a bright double edge hoop, an
  // upward burst of shield sparks and a rising energy flash so the CAST reads as
  // a big event. The DURATION is now sold by a persistent per-unit shimmer in
  // the render loop (renderer reads domeUntil), so this is the punchy one-shot.
  dome(x, z, r, color = 0x66d8ff) {
    const y = this.gy(x, z);
    const m = new THREE.Mesh(this.domeGeo, this.basic(color, 0.42));
    m.material.side = THREE.DoubleSide;
    m.position.set(x, 0.02 + y, z);
    m.scale.set(r, r * 0.66, r);   // slightly squashed dome
    this.add(m, { kind: "dome", t: 0, dur: 0.8, r });
    // twin edge hoops (crisp footprint + a trailing echo) so the radius reads
    this.hoop(x, z, color, r * 0.75, r, 0.5, 0.9);
    this.hoop(x, z, color, r * 0.35, r * 1.05, 0.7, 0.55);
    // shield sparks jetting up + a bright core flash rising off the caster
    this.sparks.burst(x, 0.4 + y, z, 18, color, 2.2, 0.5, 4);
    this.sparks.burst(x, 0.3 + y, z, 8, 0xffffff, 1.4, 0.4, 3);
    const f = new THREE.Mesh(this.flashGeo, this.basic(color, 0.9));
    f.position.set(x, 0.7 + y, z);
    f.scale.setScalar(2.6);
    this.add(f, { kind: "flash", t: 0, dur: 0.3 });
  }

  // Rumble Rocket Barrage tracer: a small glowing rocket that flies from the
  // banshee's launch point up-and-over to the impact point over ~200ms, leaving
  // smoke puffs, then hands off to the caller's explosion. from/to are world
  // (x,z); fromY/toY are absolute world heights. The rocket arcs (a low lob) so
  // it reads as a launched projectile rather than a straight bolt.
  rocket(ax, az, ay, bx, bz, by, color = 0xffb347) {
    const m = new THREE.Mesh(this.rocketGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.98,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    m.position.set(ax, ay, az);
    const d = Math.hypot(bx - ax, bz - az);
    const dur = Math.max(0.15, Math.min(0.28, d / 26));
    const arc = 0.9 + d * 0.18;   // lob height scales gently with distance
    this.add(m, { kind: "rocket", t: 0, dur, ax, ay, az, bx, by, bz, arc, color, trail: 0 });
    // launch flash + a puff of exhaust at the muzzle
    const fl = new THREE.Mesh(this.flashGeo, this.basic(color, 0.9));
    fl.position.set(ax, ay, az);
    this.add(fl, { kind: "flash", t: 0, dur: 0.09 });
    this.smoke.puff(ax, ay, az, 0.5, 0.7);
  }

  // Blink / Slipstream dash streak: 2-3 fading additive afterimage planes strung
  // along the teleport path plus a stretched capsule streak, selling the travel
  // the instant-teleport sim state can't. from/to are world (x,z); y is the
  // absolute streak height (unit body height). tint is the team/ability color.
  dashStreak(ax, az, bx, bz, y, color = 0x9fefff) {
    const dx = bx - ax, dz = bz - az;
    const d = Math.hypot(dx, dz) || 0.001;
    const ux = dx / d, uz = dz / d;
    const yaw = Math.atan2(ux, uz);
    // 3 ghost silhouettes fading from start (dim) to end (bright), each a soft
    // additive quad standing upright and facing broadside to the path.
    const ghosts = 3;
    for (let i = 0; i < ghosts; i++) {
      const f = (i + 0.5) / ghosts;
      const gx = ax + dx * f, gz = az + dz * f;
      const q = new THREE.Mesh(this.streakGeo, this.basic(color, 0.28 + f * 0.28));
      q.position.set(gx, y, gz);
      q.rotation.y = yaw;
      q.scale.set(0.5, 0.9, 1);
      this.add(q, { kind: "streak", t: 0, dur: 0.32 + i * 0.04, startA: 0.28 + f * 0.28 });
    }
    // one long stretched core streak spanning the whole path (a bright capsule)
    const core = new THREE.Mesh(this.streakGeo, this.basic(color, 0.7));
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    core.position.set(mx, y, mz);
    core.rotation.y = yaw + Math.PI / 2;   // stand the plane along the travel axis
    core.scale.set(d, 0.5, 1);
    this.add(core, { kind: "streak", t: 0, dur: 0.26, startA: 0.7 });
  }

  // Phantom phase blink: a quick refraction-ish flash + an afterimage hoop that
  // shrinks inward, marking the shimmer as the model fades its opacity.
  shimmer(x, z, color = 0xbfe6ff) {
    const y = this.gy(x, z);
    const f = new THREE.Mesh(this.flashGeo, this.basic(color, 0.8));
    f.position.set(x, 0.7 + y, z);
    f.scale.setScalar(2.4);
    this.add(f, { kind: "flash", t: 0, dur: 0.22 });
    // inward afterimage: ring collapsing toward the unit
    const r = new THREE.Mesh(this.thinRingGeo, this.basic(color, 0.6));
    r.rotation.x = -Math.PI / 2;
    r.position.set(x, 0.5 + y, z);
    r.scale.setScalar(1.4);
    this.add(r, { kind: "hoop", t: 0, dur: 0.3, from: 1.4, to: 0.2, startA: 0.6 });
    this.sparks.burst(x, 0.6 + y, z, 8, color, 1.4, 0.35, 1.5);
  }

  // Wisp Essence Feast: a small red-green soul wisp that drifts UP off the kill
  // point (the event carries the wisp's own position). Tiny additive flash that
  // rises and fades, tinted between crimson and toxic green.
  soul(x, z, color = 0xff5a6e) {
    const y = this.gy(x, z);
    const s = new THREE.Mesh(this.flashGeo, this.basic(color, 0.9));
    s.position.set(x + (Math.random() - 0.5) * 0.4, 0.4 + y, z + (Math.random() - 0.5) * 0.4);
    s.scale.setScalar(1.6);
    this.add(s, { kind: "soul", t: 0, dur: 0.7, x: s.position.x, y0: 0.4 + y, z: s.position.z });
    this.sparks.burst(x, 0.4 + y, z, 6, 0x9bff6b, 1.2, 0.4, 2.5);
  }

  // Jagged lightning polyline between two world points: 8 segments with random
  // perpendicular jitter, additive line, re-jittered every few frames so it
  // crackles, dead in ~0.15-0.25s. fromY/toY are ABSOLUTE world heights (like
  // bolt); when omitted the endpoints sit ~0.6 above the terrain. Passing the
  // same x/z for both ends with a high fromY gives a vertical strike.
  spawnArc(ax, az, bx, bz, color = 0x9feeff, fromY, toY) {
    const ay = fromY !== undefined ? fromY : 0.6 + this.gy(ax, az);
    const by = toY !== undefined ? toY : 0.6 + this.gy(bx, bz);
    const segs = 8;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((segs + 1) * 3), 3));
    const line = new THREE.Line(geo, this.basic(color, 1));
    line.frustumCulled = false;
    const data = { kind: "arc", t: 0, dur: 0.15 + Math.random() * 0.1, ax, ay, az, bx, by, bz, segs, flick: 0 };
    this.jitterArc(line, data);
    this.add(line, data);
    // endpoint flashes so the strike points read
    const fa = new THREE.Mesh(this.flashGeo, this.basic(color, 0.9));
    fa.position.set(ax, ay, az);
    this.add(fa, { kind: "flash", t: 0, dur: 0.1 });
    const fb = new THREE.Mesh(this.flashGeo, this.basic(color, 0.9));
    fb.position.set(bx, by, bz);
    this.add(fb, { kind: "flash", t: 0, dur: 0.12 });
  }

  // (re)roll the arc's jitter: endpoints pinned, interior points displaced
  // along the two perpendiculars of the A->B axis.
  jitterArc(line, d) {
    const pos = line.geometry.attributes.position.array;
    const dx = d.bx - d.ax, dy = d.by - d.ay, dz = d.bz - d.az;
    const len = Math.hypot(dx, dy, dz) || 1;
    // first perpendicular: axis x worldUp (falls back to +X for vertical arcs)
    let px = -dz, py = 0, pz = dx;
    const pl = Math.hypot(px, py, pz);
    if (pl < 0.001) { px = 1; py = 0; pz = 0; } else { px /= pl; pz /= pl; }
    // second perpendicular: axis x first
    const qx = (dy * pz - dz * py) / len;
    const qy = (dz * px - dx * pz) / len;
    const qz = (dx * py - dy * px) / len;
    const amp = Math.min(0.55, len * 0.1 + 0.08);
    for (let i = 0; i <= d.segs; i++) {
      const f = i / d.segs;
      const mid = (i === 0 || i === d.segs) ? 0 : 1;   // pin the endpoints
      const j1 = (Math.random() - 0.5) * 2 * amp * mid;
      const j2 = (Math.random() - 0.5) * 2 * amp * mid;
      pos[i * 3]     = d.ax + dx * f + px * j1 + qx * j2;
      pos[i * 3 + 1] = d.ay + dy * f + py * j1 + qy * j2;
      pos[i * 3 + 2] = d.az + dz * f + pz * j1 + qz * j2;
    }
    line.geometry.attributes.position.needsUpdate = true;
  }

  update(dt) {
    this.sparks.update(dt);
    this.smoke.update(dt);
    for (let i = this.live.length - 1; i >= 0; i--) {
      const fx = this.live[i];
      fx.t += dt;
      const p = fx.t / fx.dur;
      if (p >= 1) {
        if (fx.kind === "bolt") this.sparks.burst(fx.bx, fx.by || 0, fx.bz, 5, fx.color, 2, 0.3, 1);
        if (fx.kind === "rocket") {
          // rocket impact: fiery burst + smoke + a small shock hoop at the point
          this.sparks.burst(fx.bx, fx.by, fx.bz, 16, fx.color, 4, 0.5, 2.2);
          this.sparks.burst(fx.bx, fx.by, fx.bz, 6, 0xfff0c8, 2.4, 0.4, 1.8);
          this.smoke.puff(fx.bx, fx.by, fx.bz, 0.9, 1.2);
          this.hoop(fx.bx, fx.bz, 0xff8a3a, 0.3, 1.3, 0.35, 0.85);
        }
        if (fx.kind === "wreck") {
          // impact: ground explosion where the wreck landed
          this.unitDeath(fx.x, fx.z, fx.color);
        }
        this.scene.remove(fx.obj);
        if (fx.obj.material?.dispose) fx.obj.material.dispose();
        if (fx.kind === "arc") fx.obj.geometry.dispose();   // per-arc geometry
        this.live.splice(i, 1);
        continue;
      }
      switch (fx.kind) {
        case "bolt": {
          // absY bolts store absolute endpoint heights; legacy adds the 0.62 lift
          const y0 = fx.absY ? fx.ay : 0.62 + (fx.ay || 0);
          const y1 = fx.absY ? fx.by : 0.62 + (fx.by || 0);
          fx.obj.position.set(fx.ax + (fx.bx - fx.ax) * p, y0 + (y1 - y0) * p, fx.az + (fx.bz - fx.az) * p);
          break;
        }
        case "wreck": {
          // ease-in fall (accelerating), tumbling, occasional smoke trail
          const yy = fx.fromY + (fx.groundY - fx.fromY) * (p * p);
          fx.obj.position.set(fx.x, yy, fx.z);
          fx.obj.rotation.x += fx.spinx * dt;
          fx.obj.rotation.z += fx.spinz * dt;
          if (fx.t - fx.trail > 0.12) { fx.trail = fx.t; this.smoke.puff(fx.x, yy, fx.z, 0.5, 0.6); }
          break;
        }
        case "rocket": {
          // fly along the path with a low parabolic lob; orient the nose along
          // the instantaneous velocity; drop smoke puffs as an exhaust trail.
          const px = fx.ax + (fx.bx - fx.ax) * p;
          const pz = fx.az + (fx.bz - fx.az) * p;
          const lin = fx.ay + (fx.by - fx.ay) * p;
          const py = lin + fx.arc * 4 * p * (1 - p);   // parabola peaking mid-flight
          fx.obj.position.set(px, py, pz);
          // aim the nose at a point slightly ahead on the arc
          const p2 = Math.min(1, p + 0.06);
          const nx = fx.ax + (fx.bx - fx.ax) * p2;
          const nz = fx.az + (fx.bz - fx.az) * p2;
          const ny = (fx.ay + (fx.by - fx.ay) * p2) + fx.arc * 4 * p2 * (1 - p2);
          fx.obj.lookAt(nx, ny, nz);
          fx.obj.material.opacity = 0.98;
          if (fx.t - fx.trail > 0.02) { fx.trail = fx.t; this.smoke.puff(px, py, pz, 0.34, 0.5); }
          break;
        }
        case "streak":
          // dash afterimage: hold briefly then fade out
          fx.obj.material.opacity = (fx.startA ?? 0.6) * (1 - p);
          break;
        case "flash":
          fx.obj.scale.setScalar(1 + p * 2.2);
          fx.obj.material.opacity = 0.95 * (1 - p);
          break;
        case "arc":
          // crackle: re-roll the jitter every few frames, flicker the fade
          fx.flick -= dt;
          if (fx.flick <= 0) { fx.flick = 0.035; this.jitterArc(fx.obj, fx); }
          fx.obj.material.opacity = (1 - p) * (0.65 + Math.random() * 0.35);
          break;
        case "ring":
          fx.obj.scale.setScalar(0.4 + p * fx.maxScale * 2.4);
          fx.obj.material.opacity = 0.9 * (1 - p);
          break;
        case "hoop": {
          // thin ring lerped from `from` to `to` world radius, fading out
          const s = fx.from + (fx.to - fx.from) * (1 - (1 - p) * (1 - p)); // ease-out
          fx.obj.scale.setScalar(s);
          fx.obj.material.opacity = (fx.startA ?? 0.9) * (1 - p);
          break;
        }
        case "dome": {
          // pop in fast (first 25%), hold, then swell slightly and fade
          const pop = Math.min(1, p / 0.25);
          const swell = 1 + p * 0.12;
          fx.obj.scale.set(fx.r * swell, fx.r * 0.62 * swell, fx.r * swell);
          fx.obj.material.opacity = 0.32 * pop * (1 - p * p);
          break;
        }
        case "soul": {
          // drift up and fade, gently swelling then shrinking
          fx.obj.position.y = fx.y0 + p * 1.6;
          fx.obj.scale.setScalar(1.6 * (1 - p * 0.5));
          fx.obj.material.opacity = 0.9 * (1 - p * p);
          break;
        }
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
