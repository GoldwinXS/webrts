// Campaign CINEMATICS: a frame-driven scripted-scene player.
//
// Missions may declare `cinematics: { name: [steps...] }` and `introCinematic:
// "name"`. The CampaignRunner owns ONE CinematicPlayer and drives it from its
// per-frame update() (no real async — everything is a small state machine ticked
// once per rendered frame). Triggers fire cinematics via ctx.playCinematic(name);
// that is fire-and-forget (queued) with ctx.isCinematicRunning() as a guard.
//
// While a cinematic plays:
//   * black LETTERBOX bars slide in top/bottom (CSS transition)
//   * the HUD is hidden via a body class `.cinematic` (CSS hides #hud)
//   * player input is BLOCKED by a full-screen overlay (pointer-events:auto) plus
//     a capture-phase keydown swallow (Escape / the Skip button both skip)
//   * the SIM is PAUSED by default — the runner consults blocksSim() in the frame
//     loop and skips game.update() while a scene runs, UNLESS a { simRun: true }
//     step has toggled stepping on (for choreographed fights).
//
// STEP OPS (FROZEN) — each step is one object, run sequentially. `at` accepts a
// marker NAME string OR a {x,y} tile object (resolved via the runner's marker()).
//   { cam:  { at?, x?, y?, dist?, yaw?, dur } }   eased tween of camera tx/tz/dist/yaw
//   { say:  { speaker, text, dur? } }             cinematic dialogue (bottom-center)
//   { label:{ text, dur? } }                      big centered title-card text
//   { wait: ms }
//   { fade: { out: true|false, dur? } }           fade to / from black
//   { spawn:{ pid, type, at, n?, tag? } }         spawn units (or building) near at
//   { move: { tag?|type?, pid?, to, attack? } }   order units to walk / attack-move
//   { kill: { tag?|at?, radius? } }               remove units (hp=0)
//   { fx:   { kind:"poof"|"ring"|"arc", at, to? } } render fx via the fx surface
//   { simRun: true|false }                         toggle sim stepping mid-scene
//
// SKIP semantics (Skip button or Escape, and normal end): all remaining
// state-changing steps (spawn/kill/move/simRun) are applied INSTANTLY; cam/say/
// label/wait/fade are dropped; HUD/letterbox/input/fade are restored; the sim is
// resumed. The camera is LEFT at its last cam-step position (documented choice).

import { FP, tileToFp } from "../core/fixed.js";
import { BUILDINGS } from "../core/data.js";

const EASE = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2); // in-out quad

export class CinematicPlayer {
  // host: the CampaignRunner. We read host.sim / host.game / host.renderer and
  // call host.marker(name) to resolve marker names. host.hud is hidden via CSS.
  constructor(host) {
    this.host = host;
    this.running = false;
    this._queue = [];              // pending cinematic names
    this._steps = null;            // current step list
    this._i = 0;                   // index into _steps
    this._stepState = null;        // per-step scratch (tween progress, timers)
    this._simRun = false;          // does the sim tick during this scene?
    this._tags = new Map();        // tag -> [entity ids] spawned this scene
    this._inputLocked = false;     // ctx.lockInput() state (independent of scenes)
    this.buildDom();
  }

  // ---- DOM: letterbox bars, cinematic dialogue, label, fade, input overlay --
  buildDom() {
    let root = document.getElementById("cinematic-layer");
    if (!root) {
      root = document.createElement("div");
      root.id = "cinematic-layer";
      document.body.appendChild(root);
    }
    root.innerHTML = `
      <div id="cin-bar-top" class="cin-bar cin-bar-top"></div>
      <div id="cin-bar-bot" class="cin-bar cin-bar-bot"></div>
      <div id="cin-fade" class="cin-fade"></div>
      <div id="cin-label" class="cin-label hidden"></div>
      <div id="cin-dialogue" class="cin-dialogue hidden">
        <div class="cin-dlg-speaker"></div>
        <div class="cin-dlg-text"></div>
      </div>
      <div id="cin-input-block" class="cin-input-block hidden"></div>
      <button id="cin-skip" class="cin-skip hidden">Skip</button>
    `;
    this.root = root;
    this.$barTop = root.querySelector("#cin-bar-top");
    this.$barBot = root.querySelector("#cin-bar-bot");
    this.$fade = root.querySelector("#cin-fade");
    this.$label = root.querySelector("#cin-label");
    this.$dlg = root.querySelector("#cin-dialogue");
    this.$dlgSpeaker = root.querySelector(".cin-dlg-speaker");
    this.$dlgText = root.querySelector(".cin-dlg-text");
    this.$inputBlock = root.querySelector("#cin-input-block");
    this.$skip = root.querySelector("#cin-skip");

    this.$skip.addEventListener("click", () => this.skip());
    // capture-phase keydown swallow: only Escape passes (as a skip); everything
    // else is eaten while a scene runs OR input is locked.
    this._onKey = (e) => {
      if (!this.running && !this._inputLocked) return;
      if (e.key === "Escape") { if (this.running) this.skip(); e.preventDefault(); e.stopPropagation(); return; }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", this._onKey, true);
  }

  // ---- public: queue / query -----------------------------------------------
  isRunning() { return this.running; }

  // Fire-and-forget: queue a named cinematic from the mission's `cinematics` map.
  play(name) {
    const m = this.host.mission;
    const steps = m && m.cinematics && m.cinematics[name];
    if (!steps) { console.warn("cinematic not found:", name); return; }
    this._queue.push(steps);
    if (!this.running) this.begin(this._queue.shift());
  }

  // Does the sim need to be PAUSED right now? (runner consults this in the loop.)
  blocksSim() { return this.running && !this._simRun; }

  // ---- non-cinematic input lock (cheap reuse of the overlay) ----------------
  lockInput(on) {
    this._inputLocked = !!on;
    // only show the bare overlay when locked AND no scene is running (a scene
    // manages its own overlay). Keeps the two uses from fighting.
    if (!this.running) {
      this.$inputBlock.classList.toggle("hidden", !this._inputLocked);
    }
  }

  // ---- scene lifecycle ------------------------------------------------------
  begin(steps) {
    this.running = true;
    this._steps = steps;
    this._i = 0;
    this._stepState = null;
    this._simRun = false;              // sim paused by default
    this._tags.clear();
    // show letterbox + hide HUD + block input
    document.body.classList.add("cinematic");
    this.$barTop.classList.add("in");
    this.$barBot.classList.add("in");
    this.$inputBlock.classList.remove("hidden");
    this.$skip.classList.remove("hidden");
  }

  // Called once per rendered frame by the runner. dt in seconds.
  update(dt) {
    if (!this.running) return;
    // advance the current step; when it reports done, move to the next.
    let guard = 0;
    while (this.running && guard++ < 64) {
      if (this._i >= this._steps.length) { this.finish(false); return; }
      const step = this._steps[this._i];
      if (this._stepState === null) this._stepState = this.enterStep(step);
      const done = this.tickStep(step, this._stepState, dt);
      if (!done) return;               // step still running; wait for next frame
      this._stepState = null;
      this._i++;
      // loop to immediately enter instantaneous next steps (spawn/move/simRun/etc.)
    }
  }

  // ---- per-step: enter (init scratch) --------------------------------------
  enterStep(step) {
    const cam = this.host.renderer && this.host.renderer.camera;
    if (step.cam && cam) {
      const target = this.resolveTile(step.cam.at, step.cam);
      return {
        t: 0,
        dur: Math.max(0, step.cam.dur || 0) / 1000,
        fromX: cam.tx, fromZ: cam.tz, fromDist: cam.dist, fromYaw: cam.yaw,
        toX: target ? target.x + 0.5 : cam.tx,
        toZ: target ? target.y + 0.5 : cam.tz,
        toDist: step.cam.dist !== undefined ? step.cam.dist : cam.dist,
        toYaw: step.cam.yaw !== undefined ? step.cam.yaw : cam.yaw,
        haveTarget: !!target || step.cam.dist !== undefined || step.cam.yaw !== undefined,
      };
    }
    if (step.say) {
      const text = step.say.text || "";
      const dur = step.say.dur !== undefined ? step.say.dur : (text.length * 50 + 1200);
      this.showDialogue(step.say.speaker || "", text);
      return { t: 0, dur: dur / 1000, typed: 0, full: text };
    }
    if (step.label) {
      const text = step.label.text || "";
      const dur = step.label.dur !== undefined ? step.label.dur : 2200;
      this.$label.textContent = text;
      this.$label.classList.remove("hidden");
      this.$label.classList.add("in");
      return { t: 0, dur: dur / 1000, label: true };
    }
    if (step.wait !== undefined) return { t: 0, dur: Math.max(0, step.wait) / 1000 };
    if (step.fade) {
      const dur = (step.fade.dur !== undefined ? step.fade.dur : 500) / 1000;
      // toggle the CSS transition target; the div's opacity is driven by class.
      this.$fade.style.transition = `opacity ${dur}s ease`;
      this.$fade.classList.toggle("on", !!step.fade.out);
      return { t: 0, dur };
    }
    // instantaneous state-changing steps: apply now, no wait.
    if (step.spawn) { this.applySpawn(step.spawn); return { instant: true }; }
    if (step.move) { this.applyMove(step.move); return { instant: true }; }
    if (step.kill) { this.applyKill(step.kill); return { instant: true }; }
    if (step.fx) { this.applyFx(step.fx); return { instant: true }; }
    if (step.simRun !== undefined) { this._simRun = !!step.simRun; return { instant: true }; }
    return { instant: true };          // unknown step: skip harmlessly
  }

  // ---- per-step: tick (returns true when the step is finished) --------------
  tickStep(step, st, dt) {
    if (st.instant) return true;
    st.t += dt;
    // camera tween
    if (step.cam) {
      const cam = this.host.renderer && this.host.renderer.camera;
      if (!cam) return true;
      if (st.dur <= 0) {
        if (st.haveTarget) { cam.tx = st.toX; cam.tz = st.toZ; cam.dist = st.toDist; cam.targetDist = st.toDist; cam.yaw = st.toYaw; cam.clamp(); cam.updateTransform(); }
        return true;
      }
      const k = EASE(Math.min(1, st.t / st.dur));
      cam.tx = st.fromX + (st.toX - st.fromX) * k;
      cam.tz = st.fromZ + (st.toZ - st.fromZ) * k;
      cam.dist = st.fromDist + (st.toDist - st.fromDist) * k;
      cam.targetDist = cam.dist;
      cam.yaw = st.fromYaw + (st.toYaw - st.fromYaw) * k;
      cam.clamp();
      cam.updateTransform();
      return st.t >= st.dur;
    }
    // dialogue: typewriter reveal, hold until dur
    if (step.say) {
      if (st.typed < st.full.length) {
        st.typed = Math.min(st.full.length, st.typed + 2);
        this.$dlgText.textContent = st.full.slice(0, st.typed);
      }
      if (st.t >= st.dur) { this.hideDialogue(); return true; }
      return false;
    }
    if (step.label) {
      if (st.t >= st.dur) { this.$label.classList.add("hidden"); this.$label.classList.remove("in"); return true; }
      return false;
    }
    // wait / fade: just run the timer
    return st.t >= st.dur;
  }

  // ---- step operations ------------------------------------------------------
  resolveTile(at, fallbackXY) {
    // `at` may be a marker NAME string, a {x,y} tile object, or undefined; if
    // undefined we allow x/y on the fallback object (used by cam steps).
    if (typeof at === "string") return this.host.marker(at) || null;
    if (at && typeof at === "object" && at.x !== undefined) return { x: at.x, y: at.y };
    if (fallbackXY && fallbackXY.x !== undefined && fallbackXY.y !== undefined) {
      return { x: fallbackXY.x, y: fallbackXY.y };
    }
    return null;
  }

  applySpawn(s) {
    const sim = this.host.sim;
    const tile = this.resolveTile(s.at, s);
    if (!tile) return;
    const pid = s.pid !== undefined ? s.pid : 1;
    const n = Math.max(1, s.n || 1);
    const ids = [];
    const isBuilding = !!BUILDINGS[s.type];
    for (let k = 0; k < n; k++) {
      let e;
      if (isBuilding) {
        // building: place done at the tile (only one makes sense; loop still ok)
        e = sim.spawnBuilding(pid, s.type, tile.x, tile.y, true);
      } else {
        // fan spawns out around the origin so they don't stack on one tile.
        const ox = (k % 3) - 1, oy = ((k / 3) | 0) - 1;
        const tx = tile.x + ox, ty = tile.y + oy;
        e = sim.spawnUnit(pid, s.type, tileToFp(tx), tileToFp(ty));
      }
      if (e) ids.push(e.id);
    }
    if (s.tag) {
      const prev = this._tags.get(s.tag) || [];
      this._tags.set(s.tag, prev.concat(ids));
    }
  }

  applyMove(m) {
    const sim = this.host.sim;
    const to = this.resolveTile(m.to, m.to);
    if (!to) return;
    let ids = [];
    if (m.tag) ids = (this._tags.get(m.tag) || []).slice();
    else {
      // by type (and optional pid): every live matching unit.
      for (const e of sim.entities) {
        if (!e.unit || e.hp <= 0) continue;
        if (m.pid !== undefined && e.owner !== m.pid) continue;
        if (m.type && e.type !== m.type) continue;
        ids.push(e.id);
      }
    }
    if (!ids.length) return;
    const kind = m.attack ? "attackmove" : "move";
    // single-player scripted: issue via the real command path (game.issue) so
    // the sim's own order handling runs. q:0 = replace orders.
    this.host.game.issue({ t: kind, ids, x: tileToFp(to.x), y: tileToFp(to.y), q: 0 });
  }

  applyKill(k) {
    const sim = this.host.sim;
    if (k.tag) {
      const ids = this._tags.get(k.tag) || [];
      for (const id of ids) { const e = sim.byId.get(id); if (e) this.killEntity(e); }
      this._tags.delete(k.tag);
      return;
    }
    const at = this.resolveTile(k.at, k.at);
    if (!at) return;
    const r = k.radius !== undefined ? k.radius : 2;
    const cx = tileToFp(at.x), cy = tileToFp(at.y);
    const r2 = (r * FP) * (r * FP);
    for (const e of sim.entities.slice()) {
      if (e.owner === -1 || e.hp <= 0) continue;
      const dx = e.x - cx, dy = e.y - cy;
      if (dx * dx + dy * dy <= r2) this.killEntity(e);
    }
  }

  killEntity(e) {
    const sim = this.host.sim;
    if (e.building) sim.setFootprint(e, 0);
    e.hp = 0;
    sim.byId.delete(e.id);
    sim.entities = sim.entities.filter((x) => sim.byId.has(x.id));
  }

  applyFx(f) {
    const r = this.host.renderer;
    if (!r || !r.fx) return;
    const at = this.resolveTile(f.at, f.at);
    if (!at) return;
    // world coords: 1 tile = 1.0 world unit, tile center = tile + 0.5
    const wx = at.x + 0.5, wz = at.y + 0.5;
    if (f.kind === "poof") { r.fx.spawnPoof(wx, wz, f.color || 0xffffff); return; }
    if (f.kind === "ring") { r.fx.shockRing(wx, wz, f.color || 0xffb347, f.scale || 2, f.dur || 0.5); return; }
    if (f.kind === "arc") {
      const to = this.resolveTile(f.to, f.to) || at;
      r.fx.spawnArc(wx, wz, to.x + 0.5, to.y + 0.5, f.color || 0x9feeff);
      return;
    }
  }

  // ---- dialogue helpers (cinematic bar) ------------------------------------
  showDialogue(speaker, text) {
    this.$dlgSpeaker.textContent = speaker;
    this.$dlgText.textContent = "";
    this.$dlg.classList.remove("hidden");
    this.$dlg.classList.add("in");
  }
  hideDialogue() {
    this.$dlg.classList.add("hidden");
    this.$dlg.classList.remove("in");
  }

  // ---- skip / finish --------------------------------------------------------
  // Apply all remaining STATE-CHANGING steps instantly, drop presentational ones.
  skip() {
    if (!this.running) return;
    // finish the current step's state effect if it was a state-changer mid-enter
    // (enterStep already applied instantaneous ones before returning).
    for (let j = this._i; j < this._steps.length; j++) {
      const step = this._steps[j];
      if (j === this._i && this._stepState && !this._stepState.instant) {
        // presentational step in progress — drop it.
      }
      if (step.spawn) this.applySpawn(step.spawn);
      else if (step.move) this.applyMove(step.move);
      else if (step.kill) this.applyKill(step.kill);
      else if (step.simRun !== undefined) this._simRun = !!step.simRun;
      // cam/say/label/wait/fade/fx are dropped on skip.
    }
    this.finish(true);
  }

  finish(skipped) {
    this.running = false;
    this._steps = null;
    this._i = 0;
    this._stepState = null;
    this._simRun = false;              // resume normal sim stepping
    // restore HUD / letterbox / input / fade / dialogue / label
    document.body.classList.remove("cinematic");
    this.$barTop.classList.remove("in");
    this.$barBot.classList.remove("in");
    this.$fade.classList.remove("on");
    this.$skip.classList.add("hidden");
    this.$label.classList.add("hidden");
    this.$label.classList.remove("in");
    this.hideDialogue();
    // input overlay stays only if a non-cinematic lock is active.
    this.$inputBlock.classList.toggle("hidden", !this._inputLocked);
    // Camera is LEFT at the last cam-step position (documented choice) — no reset.
    // start the next queued scene, if any.
    if (this._queue.length) this.begin(this._queue.shift());
  }

  destroy() {
    window.removeEventListener("keydown", this._onKey, true);
    this.root && this.root.remove();
  }
}
