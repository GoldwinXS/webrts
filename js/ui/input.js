// Mouse/keyboard -> commands. Owns selection (client-side only) and the
// building-placement ghost. All game mutations go through game.issue().
import * as THREE from "three";
import { FP, fpToTile } from "../core/fixed.js";
import { UNITS, BUILDINGS } from "../core/data.js";
import { KEYS } from "./keys.js";

export class Input {
  constructor(game, renderer, hud, audio) {
    this.game = game;
    this.renderer = renderer;
    this.hud = hud;
    this.audio = audio;
    this.sim = game.sim;
    this.pid = game.localPlayer;

    this.selection = renderer.selection;   // shared Set of entity ids
    this.keys = new Set();
    // start at screen center and inactive — a (0,0) default sits in the
    // edge-pan corner and yanked the camera up-left the moment a game began
    this.mouse = { x: innerWidth / 2, y: innerHeight / 2, inside: false };
    this.drag = null;
    this.attackMode = false;
    this.placing = null;                   // building type being placed
    this.ghost = null;
    this.groups = {};                      // digit -> Set of entity ids
    this.lastRecall = { key: null, time: 0 };
    this.lastClick = { id: 0, time: 0 };   // double-click detection
    this.idleCycle = 0;                    // idle-worker rotation index
    this.baseCycle = 0;                    // Backspace base rotation
    this.camSlots = [null, null, null, null]; // F5-F8 camera locations
    this.patrolMode = false;

    this.ray = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    const canvas = renderer.renderer.domElement;
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    canvas.addEventListener("pointerup", (e) => this.onUp(e));
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      renderer.camera.zoom(e.deltaY > 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });
    // swallow wheel everywhere else in-game (except scrollable panels) so
    // browser gestures never steal focus, especially in fullscreen
    window.addEventListener("wheel", (e) => {
      if (!e.target.closest?.("#settings, #sel-panel, #menu")) e.preventDefault();
    }, { passive: false });
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    document.addEventListener("mouseleave", () => (this.mouse.inside = false));
    document.addEventListener("mouseenter", () => (this.mouse.inside = true));
  }

  // ---------- picking ----------

  groundAt(sx, sy) {
    this.ray.setFromCamera(
      { x: (sx / innerWidth) * 2 - 1, y: -(sy / innerHeight) * 2 + 1 },
      this.renderer.camera.cam);
    const pt = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(this.groundPlane, pt)) return null;
    return { x: (pt.x * FP) | 0, y: (pt.z * FP) | 0, wx: pt.x, wz: pt.z };
  }

  entityAt(sx, sy) {
    this.ray.setFromCamera(
      { x: (sx / innerWidth) * 2 - 1, y: -(sy / innerHeight) * 2 + 1 },
      this.renderer.camera.cam);
    const groups = [...this.renderer.meshes.values()].filter((g) => g.visible);
    const hits = this.ray.intersectObjects(groups, true);
    for (const h of hits) {
      const id = h.object.userData.eid;
      if (id !== undefined) {
        const e = this.sim.byId.get(id);
        if (e) return e;
      }
    }
    return null;
  }

  // ---------- events ----------

  onMove(e) {
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    this.mouse.inside = true;
    if (this.drag) {
      this.drag.cx = e.clientX; this.drag.cy = e.clientY;
      this.hud.drawSelectBox(this.drag);
    }
    if (this.drag?.rotate) {
      this.renderer.camera.rotate((e.movementX || 0) * 0.005);
    }
    if (this.placing) this.updateGhost();
  }

  onDown(e) {
    if (e.button === 1) {
      this.drag = { rotate: true };
      e.preventDefault();
      return;
    }
    if (e.button === 0) {
      if (this.placing) { this.confirmPlace(); return; }
      if (this.attackMode) {
        const g = this.groundAt(e.clientX, e.clientY);
        const target = this.entityAt(e.clientX, e.clientY);
        this.issueAttack(g, target, e.shiftKey);
        this.setAttackMode(false);
        return;
      }
      if (this.patrolMode) {
        const g = this.groundAt(e.clientX, e.clientY);
        const ids = this.mySelectedUnitIds();
        if (g && ids.length) {
          this.game.issue({ t: "patrol", ids, x: g.x, y: g.y, q: e.shiftKey ? 1 : 0 });
          this.renderer.orderPing(g.wx, g.wz, "#6bb8ff");
          this.audio.ack();
        }
        this.setPatrolMode(false);
        return;
      }
      this.drag = { sx: e.clientX, sy: e.clientY, cx: e.clientX, cy: e.clientY };
    } else if (e.button === 2) {
      if (this.placing) { this.cancelPlace(); return; }
      if (this.attackMode) { this.setAttackMode(false); return; }
      if (this.patrolMode) { this.setPatrolMode(false); return; }
      this.rightClick(e.clientX, e.clientY, e.shiftKey);
    }
  }

  onUp(e) {
    if (this.drag?.rotate) { this.drag = null; return; }
    if (e.button !== 0 || !this.drag) return;
    const d = this.drag;
    this.drag = null;
    this.hud.drawSelectBox(null);
    const moved = Math.hypot(d.cx - d.sx, d.cy - d.sy);
    const additive = this.keys.has("shift");
    if (!additive) this.selection.clear();

    if (moved < 6) {
      const hit = this.entityAt(e.clientX, e.clientY);
      if (hit && (hit.owner === this.pid || hit.type === "mineral" || hit.owner >= 0)) {
        this.selection.add(hit.id);
        if (hit.owner === this.pid) this.audio.select();

        // double-click a unit or building: select all of its type on screen
        const now = performance.now();
        if ((hit.unit || hit.building) && hit.owner === this.pid &&
            this.lastClick.id === hit.id && now - this.lastClick.time < 400) {
          this.selectTypeOnScreen(hit.type);
        }
        this.lastClick = { id: hit.id, time: now };
      }
    } else {
      // box select own units by projecting to screen space
      const x0 = Math.min(d.sx, d.cx), x1 = Math.max(d.sx, d.cx);
      const y0 = Math.min(d.sy, d.cy), y1 = Math.max(d.sy, d.cy);
      const v = new THREE.Vector3();
      for (const ent of this.sim.entities) {
        if (ent.owner !== this.pid || !ent.unit) continue;
        v.set(ent.x / FP, 0.4, ent.y / FP).project(this.renderer.camera.cam);
        const sx = (v.x + 1) / 2 * innerWidth, sy = (-v.y + 1) / 2 * innerHeight;
        if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) this.selection.add(ent.id);
      }
      if (this.selection.size) this.audio.select();
    }
    this.hud.refreshSelection();
  }

  rightClick(sx, sy, shift) {
    const ids = this.mySelectedUnitIds();
    const q = shift ? 1 : 0;
    let target = this.entityAt(sx, sy);
    const g = this.groundAt(sx, sy);

    // a click near (not exactly on) a mineral patch snaps to it
    if ((!target || target.type !== "mineral") && g) {
      const near = this.sim.nearestEntity(g.x, g.y, FP * 1.4,
        (e) => e.type === "mineral" && e.amount > 0);
      if (near && !(target && target.owner >= 0)) target = near;
    }

    // no units selected but finished buildings are: set rally on ALL of them
    if (!ids.length) {
      const buildings = this.mySelected().filter((e) => e.building && e.done);
      if (buildings.length && g) {
        const onMineral = target?.type === "mineral";
        // rallying onto minerals snaps the flag to the patch itself
        const rx = onMineral ? target.x : g.x;
        const ry = onMineral ? target.y : g.y;
        for (const b of buildings) {
          this.game.issue({ t: "rally", buildingId: b.id, x: rx, y: ry, targetId: onMineral ? target.id : 0 });
        }
        this.renderer.orderPing(rx / FP, ry / FP, onMineral ? "#63e8db" : "#7cff6b");
        this.audio.rally();
        this.hud.toastInfo(onMineral
          ? "Rally set: workers will mine"
          : buildings.length > 1 ? `Rally set for ${buildings.length} buildings` : "Rally point set");
      }
      return;
    }

    // own unfinished building: send workers to (resume) constructing it
    if (target && target.building && target.owner === this.pid && !target.done) {
      const wids = this.mySelectedWorkers().map((w) => w.id);
      if (wids.length) {
        this.game.issue({ t: "resume", ids: wids, targetId: target.id, q });
        this.renderer.orderPing(target.x / FP, target.y / FP, "#ffb347");
        this.audio.ack();
        // non-workers in the selection just move next to the site
        const others = ids.filter((id) => !wids.includes(id));
        if (others.length && g) this.game.issue({ t: "move", ids: others, x: g.x, y: g.y, q });
        return;
      }
    }

    if (target && target.type === "mineral") {
      this.game.issue({ t: "gather", ids, targetId: target.id, q });
      this.renderer.orderPing(target.x / FP, target.y / FP, "#63e8db");
      this.audio.gatherAck();
    } else if (target && target.owner >= 0 && target.owner !== this.pid) {
      this.game.issue({ t: "attack", ids, targetId: target.id, q });
      this.audio.attackAck();
    } else if (g) {
      this.game.issue({ t: "move", ids, x: g.x, y: g.y, q });
      this.renderer.orderPing(g.wx, g.wz, q ? "#c9ff6b" : "#7cff6b");
      this.audio.ack();
    }
  }

  issueAttack(g, target, shift) {
    const ids = this.mySelectedUnitIds();
    const q = shift ? 1 : 0;
    if (!ids.length) return;
    if (target && target.owner >= 0 && target.owner !== this.pid) {
      this.game.issue({ t: "attack", ids, targetId: target.id, q });
      this.audio.attackAck();
    } else if (g) {
      this.game.issue({ t: "attackmove", ids, x: g.x, y: g.y, q });
      this.renderer.orderPing(g.wx, g.wz, "#ff6b5f");
      this.audio.attackAck();
    }
  }

  onKey(e, down) {
    const k = e.key.toLowerCase();
    this.keys.add(k);
    if (!down) return;
    if (k === "escape") {
      if (this.placing) this.cancelPlace();
      else if (this.attackMode) this.setAttackMode(false);
      else if (this.patrolMode) this.setPatrolMode(false);
      else { this.selection.clear(); this.hud.refreshSelection(); }
      return;
    }
    if (k === "tab") {
      e.preventDefault();
      this.hud.cycleSubgroup(e.shiftKey ? -1 : 1);
      return;
    }
    if (k === " ") {
      e.preventDefault();
      this.centerOnSelection();
      return;
    }
    if (KEYS.idleWorker.includes(k) && !e.repeat) {
      e.preventDefault();
      this.selectIdleWorker();
      return;
    }
    if (KEYS.selectArmy.includes(k) && !e.repeat) {
      e.preventDefault();
      this.selectArmy();
      return;
    }
    // camera locations: Ctrl+F5-F8 saves, F5-F8 recalls
    const camSlot = KEYS.cameraSlots.indexOf(k);
    if (camSlot >= 0) {
      e.preventDefault();   // F5 would reload the page
      const cam = this.renderer.camera;
      if (e.ctrlKey) {
        this.camSlots[camSlot] = { tx: cam.tx, tz: cam.tz, yaw: cam.yaw, dist: cam.dist };
        this.hud.toastInfo(`Camera ${camSlot + 5} saved`);
      } else if (this.camSlots[camSlot]) {
        const s = this.camSlots[camSlot];
        cam.tx = s.tx; cam.tz = s.tz; cam.yaw = s.yaw;
        cam.dist = s.dist; cam.targetDist = s.dist;
        cam.clamp(); cam.updateTransform();
      }
      return;
    }
    if (KEYS.cycleBase.includes(k)) {
      e.preventDefault();
      this.cycleBase();
      return;
    }

    // control groups (e.code, so Shift+digit works on every layout):
    // Ctrl/Alt+digit assigns, Shift+digit adds, digit recalls,
    // double-tap centers the camera. Buildings are allowed in groups.
    const digit = e.code?.startsWith("Digit") ? e.code.slice(5) : null;
    if (digit && digit >= "1" && digit <= "9") {
      const ids = this.mySelected().map((u) => u.id);
      if (e.ctrlKey || e.altKey) {
        e.preventDefault();
        if (ids.length) {
          this.groups[digit] = new Set(ids);
          this.hud.toastInfo(`Group ${digit} set (${ids.length})`);
          this.audio.select();
        }
        return;
      }
      if (e.shiftKey) {
        if (ids.length) {
          const grp = this.groups[digit] || (this.groups[digit] = new Set());
          ids.forEach((id) => grp.add(id));
          this.hud.toastInfo(`Group ${digit}: ${grp.size} member${grp.size > 1 ? "s" : ""}`);
          this.audio.select();
        }
        return;
      }
      const grp = this.groups[digit];
      if (grp) {
        grp.forEach((id) => { if (!this.sim.byId.has(id)) grp.delete(id); });
        const alive = [...grp];
        if (!alive.length) return;
        this.selection.clear();
        alive.forEach((id) => this.selection.add(id));
        this.hud.refreshSelection();
        this.audio.select();
        const now = performance.now();
        if (this.lastRecall.key === digit && now - this.lastRecall.time < 450) {
          let cx = 0, cy = 0;
          for (const id of alive) { const u = this.sim.byId.get(id); cx += u.x; cy += u.y; }
          this.renderer.camera.jumpTo(cx / alive.length / FP, cy / alive.length / FP);
        }
        this.lastRecall = { key: digit, time: now };
      }
      return;
    }

    // grid hotkeys from the command card (QWER / AS)
    if (!e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat) {
      const cmd = this.hud.hotkeys?.[k];
      if (cmd) this.hud.command(cmd);
    }
  }

  setAttackMode(on) {
    this.attackMode = on;
    if (on) this.patrolMode = false;
    document.body.classList.toggle("attack-cursor", on || this.patrolMode);
    this.hud.setHint(on ? "Attack-move: click a target or location (right-click / Esc to cancel)" : "");
  }

  setPatrolMode(on) {
    this.patrolMode = on;
    if (on) this.attackMode = false;
    document.body.classList.toggle("attack-cursor", on || this.attackMode);
    this.hud.setHint(on ? "Patrol: click the far point of the route (right-click / Esc to cancel)" : "");
  }

  // F2: every combat unit (workers stay on the line)
  selectArmy() {
    const army = this.sim.entities.filter((e) =>
      e.owner === this.pid && e.unit && e.type !== "worker");
    if (!army.length) { this.hud.toastInfo("No army units"); return; }
    this.selection.clear();
    army.forEach((u) => this.selection.add(u.id));
    this.hud.refreshSelection();
    this.audio.select();
  }

  // Space: center the camera on the current selection
  centerOnSelection() {
    const sel = this.mySelected();
    if (!sel.length) return;
    let cx = 0, cy = 0;
    for (const e of sel) { cx += e.x; cy += e.y; }
    this.renderer.camera.jumpTo(cx / sel.length / FP, cy / sel.length / FP);
  }

  // Backspace: hop the camera between our bases
  cycleBase() {
    const bases = this.sim.entities.filter((e) =>
      e.owner === this.pid && e.type === "hq");
    if (!bases.length) return;
    const b = bases[this.baseCycle % bases.length];
    this.baseCycle++;
    this.renderer.camera.jumpTo(b.x / FP, b.y / FP);
  }

  // ---------- building placement ----------

  startPlacing(type) {
    this.cancelPlace();
    const d = BUILDINGS[type];
    if (!d) return;
    this.placing = type;
    const geo = new THREE.BoxGeometry(d.size, 0.8, d.size);
    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0x7cff6b, transparent: true, opacity: 0.35 });
    this.ghost = new THREE.Mesh(geo, this.ghostMat);
    this.renderer.scene.add(this.ghost);
    this.updateGhost();
    this.hud.setHint(`Place ${d.name} (left-click to confirm, right-click / Esc to cancel)`);
  }

  updateGhost() {
    if (!this.ghost) return;
    const g = this.groundAt(this.mouse.x, this.mouse.y);
    if (!g) return;
    const d = BUILDINGS[this.placing];
    const tx = fpToTile(g.x) - (d.size >> 1), ty = fpToTile(g.y) - (d.size >> 1);
    this.ghostTile = { tx, ty };
    const gy = this.renderer.heightAt ? this.renderer.heightAt(tx + d.size / 2, ty + d.size / 2) : 0;
    this.ghost.position.set(tx + d.size / 2, gy + 0.4, ty + d.size / 2);
    const ok = this.sim.canPlace(this.placing, tx, ty) && this.sim.canAfford(this.pid, d.cost);
    this.ghostMat.color.set(ok ? 0x7cff6b : 0xff5f4c);
  }

  confirmPlace() {
    const d = BUILDINGS[this.placing];
    const { tx, ty } = this.ghostTile || {};
    const worker = this.mySelectedWorkers()[0];
    if (!worker) { this.hud.toast("Select a worker first"); this.audio.error(); return; }
    if (!this.sim.canAfford(this.pid, d.cost)) { this.hud.toast("Not enough minerals"); this.audio.error(); return; }
    if (!this.sim.canPlace(this.placing, tx, ty)) { this.hud.toast("Can't build there"); this.audio.error(); return; }
    this.game.issue({ t: "build", workerId: worker.id, building: this.placing, tx, ty });
    this.audio.place();
    this.cancelPlace();
  }

  cancelPlace() {
    if (this.ghost) {
      this.renderer.scene.remove(this.ghost);
      this.ghost.geometry.dispose();
      this.ghostMat.dispose();
    }
    this.ghost = null;
    this.placing = null;
    this.hud.setHint("");
  }

  // select every own unit of a type that is currently on screen
  selectTypeOnScreen(type) {
    const v = new THREE.Vector3();
    for (const ent of this.sim.entities) {
      if (ent.owner !== this.pid || ent.type !== type) continue;
      v.set(ent.x / FP, 0.4, ent.y / FP).project(this.renderer.camera.cam);
      if (v.x >= -1 && v.x <= 1 && v.y >= -1 && v.y <= 1 && v.z < 1) {
        this.selection.add(ent.id);
      }
    }
    this.hud.refreshSelection();
    this.audio.select();
  }

  // cycle through idle workers, centering the camera on each
  selectIdleWorker() {
    const idle = this.sim.entities.filter((e) =>
      e.owner === this.pid && e.type === "worker" && e.order.kind === "idle");
    if (!idle.length) { this.hud.toastInfo("No idle workers"); return; }
    const w = idle[this.idleCycle % idle.length];
    this.idleCycle++;
    this.selection.clear();
    this.selection.add(w.id);
    this.renderer.camera.jumpTo(w.x / FP, w.y / FP);
    this.hud.refreshSelection();
    this.audio.select();
  }

  // ---------- helpers ----------

  mySelected() {
    return [...this.selection]
      .map((id) => this.sim.byId.get(id))
      .filter((e) => e && e.owner === this.pid);
  }
  mySelectedUnitIds() { return this.mySelected().filter((e) => e.unit).map((e) => e.id); }
  mySelectedWorkers() { return this.mySelected().filter((e) => e.type === "worker"); }

  // called every frame for camera pan
  update(dt) {
    const cam = this.renderer.camera;
    const s = cam.panSpeed * dt;
    let dx = 0, dz = 0;
    if (this.keys.has("arrowleft")) dx -= s;
    if (this.keys.has("arrowright")) dx += s;
    if (this.keys.has("arrowup")) dz -= s;
    if (this.keys.has("arrowdown")) dz += s;
    // camera rotation (default ,/. — Q/E belong to the grid hotkeys)
    if (KEYS.rotateLeft.some((x) => this.keys.has(x))) cam.rotate(-1.6 * dt);
    if (KEYS.rotateRight.some((x) => this.keys.has(x))) cam.rotate(1.6 * dt);
    const edge = 16;
    if (this.mouse.inside && !this.drag) {
      if (this.mouse.x < edge) dx -= s;
      if (this.mouse.x > innerWidth - edge) dx += s;
      if (this.mouse.y < edge) dz -= s;
      if (this.mouse.y > innerHeight - edge) dz += s;
    }
    if (dx || dz) cam.pan(dx, dz);
    cam.update(dt);   // smooth zoom

    // prune dead ids from selection
    for (const id of this.selection) {
      if (!this.sim.byId.has(id)) this.selection.delete(id);
    }
  }
}
