// The webRTS CAMPAIGN runner. Owns everything campaign-specific: mission select
// UI, mission boot (mirrors main.js startGame's "ai" path), the per-tick
// trigger/objective/win-lose engine, the in-mission dialogue bar + objective
// tracker + intro/victory cards, and localStorage progress.
//
// Skirmish/MP are UNTOUCHED: this code only runs when the player clicks a
// campaign mission. main.js calls into it via a tiny surface:
//   Campaign.mount({ startMission })   — wires the menu button + panel
//   Campaign.attach(session)           — hands the runner a live Game/Renderer/
//                                         Hud so it can drive the loop each frame
// and the frame loop calls campaign.update(sim) once per rendered frame.
//
// The mission Sim runs single-player with noGameOver = true; we drive the end
// ourselves from mission.winWhen / loseWhen, exactly as the brief requires.

import { FP, tileToFp } from "../core/fixed.js";
import { UNITS, BUILDINGS, FACTIONS } from "../core/data.js";
import { ACTS, MISSIONS, MISSION_BY_ID, FIRST_MISSION } from "./missions.js";

const PROGRESS_KEY = "webrts-campaign";
const $ = (id) => document.getElementById(id);

// ---------- progress persistence -------------------------------------------

function loadProgress() {
  try {
    const p = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "null");
    if (p && typeof p === "object") return { completed: p.completed || {}, unlocked: p.unlocked || {} };
  } catch {}
  return { completed: {}, unlocked: {} };
}
function saveProgress(p) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch {}
}

// A mission is unlocked if it's the first, already completed, explicitly
// unlocked, or the previous non-stub mission in order is completed.
function isUnlocked(mission, progress) {
  if (mission.stub) return false;
  if (mission.id === FIRST_MISSION) return true;
  if (progress.completed[mission.id] || progress.unlocked[mission.id]) return true;
  const idx = MISSIONS.indexOf(mission);
  for (let i = idx - 1; i >= 0; i--) {
    if (MISSIONS[i].stub) continue;
    return !!progress.completed[MISSIONS[i].id];
  }
  return false;
}

function markComplete(missionId) {
  const p = loadProgress();
  p.completed[missionId] = true;
  // unlock the next non-stub mission
  const idx = MISSIONS.findIndex((m) => m.id === missionId);
  for (let i = idx + 1; i < MISSIONS.length; i++) {
    if (MISSIONS[i].stub) continue;
    p.unlocked[MISSIONS[i].id] = true;
    break;
  }
  saveProgress(p);
}

// ===========================================================================
// The live runner: created per mission, drives the in-game campaign layer.
// ===========================================================================

export class CampaignRunner {
  constructor(mission, session, state) {
    this.mission = mission;
    this.sim = session.game.sim;
    this.game = session.game;
    this.renderer = session.renderer;
    this.hud = session.hud;
    this.audio = session.audio;
    this.ended = false;

    // mutable mission scratch (waves counter, spawn origins, etc. — missions
    // read/write via ctx, which shares this object). Carried over from the
    // pre-renderer setup pass so counters/origins set in setup() persist.
    this.state = state || {};

    // trigger fire-once tracking
    this._fired = new Set();

    // dialogue queue: [{speaker, text}] shown one at a time in the bar
    this._dlgQueue = [];
    this._dlgUntil = 0;     // wall-clock ms the current line auto-dismisses
    this._dlgActive = false;

    this.ctx = this.buildCtx();
    this.buildDom();

    // intro card (title + blurb) + first spoken line
    this.showIntro();
  }

  // ---- ctx: the scripting surface handed to setup/triggers ----------------
  buildCtx() {
    const self = this;
    const sim = this.sim;
    return {
      get sim() { return self.sim; },
      get game() { return self.game; },
      get tick() { return self.sim.tick; },
      state: this.state,
      player: 0,
      enemy: 1,

      // speak a raw line (queued, typewriter bar)
      say: (speaker, text) => self.queueLine(speaker, text),
      // speak a keyed line from mission.dialogue
      line: (key) => {
        const d = self.mission.dialogue && self.mission.dialogue[key];
        if (d) self.queueLine(d.speaker, d.text);
      },
      toast: (msg) => self.hud?.toastInfo?.(msg),

      // mark an objective done early / reveal one (objectives auto-check too)
      objectiveDone: (id) => self.forceObjective(id, true),

      // reveal the whole map (fog -> visible for the player)
      reveal: () => { sim.fog[0].fill(2); },

      // ---- entity scripting (raw, showcase-style; bypasses the command pipe)
      // Remove every entity a player owns (units + buildings). Used to strip an
      // enemy for a tutorial or to clear the default AI base before scripting.
      clearPlayer: (pid) => self.clearPlayer(pid),

      // Spawn one unit for `pid` at TILE coords (converted to fp centers).
      spawnFor: (pid, type, tx, ty) => sim.spawnUnit(pid, type, tileToFp(tx | 0), tileToFp(ty | 0)),

      // Spawn a hostile wave of `n` units of `type` at the mission's ooze-origin
      // and attack-move them toward the player's start. Bumps _wavesDone by the
      // given wave index so objectives/win can track progress.
      spawnWave: (type, n, waveIndex) => self.spawnWave(type, n, waveIndex),

      // Pre-place a small, pre-damaged enemy base for an assault mission.
      woundEnemyBase: (pid) => self.woundEnemyBase(pid),

      FP, tileToFp,
    };
  }

  // ---- mission boot ordering ---------------------------------------------
  // setup() runs from main.js BEFORE the Renderer is built (like prepShowcase),
  // so we expose it as a static entry the boot code calls directly. The runner
  // constructor then does the AFTER-renderer wiring (DOM, intro, triggers).
  //
  // Pre-renderer setup: construct a bare ctx (no hud/renderer needed — setup
  // only touches sim entities/fog/resources) and run the mission's setup. The
  // returned `state` object is handed to the runner so wave counters etc. carry
  // over. Mirrors how prepShowcase mutates a fresh Game before the Renderer.
  static runSetup(mission, game) {
    const state = {};
    const sim = game.sim;
    const stub = {
      sim, game, state, player: 0, enemy: 1, FP, tileToFp,
      say() {}, line() {}, toast() {}, reveal: () => sim.fog[0].fill(2),
      objectiveDone() {},
      clearPlayer(pid) { CampaignRunner._clearPlayer(sim, pid); },
      spawnFor: (pid, type, tx, ty) => sim.spawnUnit(pid, type, tileToFp(tx | 0), tileToFp(ty | 0)),
      woundEnemyBase: (pid) => CampaignRunner._woundEnemyBase(sim, pid),
      spawnWave() {},   // waves never fire during setup
    };
    // disable the sim's own winner detection — the runner drives win/lose
    sim.noGameOver = true;
    if (mission.setup) mission.setup(stub);
    return state;
  }

  // ---- per-frame update (called from the main loop) -----------------------
  update() {
    if (this.ended) { this.tickDialogue(); return; }
    const sim = this.sim, m = this.mission;

    // evaluate triggers (tick-gated and condition-gated)
    for (let i = 0; i < (m.triggers || []).length; i++) {
      const tr = m.triggers[i];
      if (tr.once && this._fired.has(i)) continue;
      let go = false;
      if (typeof tr.at === "number") go = sim.tick >= tr.at;
      else if (tr.at) go = !!tr.at(sim.tick);
      if (!go && tr.when) go = !!tr.when(sim, this.state);
      if (go) {
        if (tr.once) this._fired.add(i);
        try { tr.run(this.ctx); } catch (e) { console.error("trigger error", e); }
      }
    }

    // refresh objective states in the tracker
    this.refreshObjectives();

    // win / lose
    if (!this.ended) {
      if (m.loseWhen && m.loseWhen(sim, this.state)) this.endMission(false);
      else if (m.winWhen && m.winWhen(sim, this.state)) this.endMission(true);
    }

    this.tickDialogue();
  }

  // ---- objectives ---------------------------------------------------------
  refreshObjectives() {
    const objs = this.mission.objectives || [];
    for (const o of objs) {
      if (this._forcedObj && this._forcedObj[o.id]) { o._done = true; continue; }
      o._done = !!(o.check && o.check(this.sim, this.state));
    }
    this.renderObjectives();
  }
  forceObjective(id, done) {
    this._forcedObj = this._forcedObj || {};
    this._forcedObj[id] = done;
  }

  // ---- entity scripting helpers (shared by ctx) ---------------------------
  clearPlayer(pid) { CampaignRunner._clearPlayer(this.sim, pid); }

  // Static form so the pre-renderer setup stub and the live runner share it.
  static _clearPlayer(sim, pid) {
    for (const e of sim.entities) {
      if (e.owner === pid) {
        if (e.building) sim.setFootprint(e, 0);
        e.hp = 0;
        sim.byId.delete(e.id);
      }
    }
    sim.entities = sim.entities.filter((e) => sim.byId.has(e.id));
  }

  spawnWave(type, n, waveIndex) {
    const sim = this.sim;
    const from = this.state._oozeFrom || { x: sim.map.w - 6, y: sim.map.h - 6 };
    const target = sim.map.starts[0];
    const ids = [];
    for (let i = 0; i < n; i++) {
      // fan the spawns out around the origin so they don't stack on one tile
      const ox = (i % 3) - 1, oy = ((i / 3) | 0) - 1;
      const tx = Math.max(1, Math.min(sim.map.w - 2, from.x + ox));
      const ty = Math.max(1, Math.min(sim.map.h - 2, from.y + oy));
      const u = sim.spawnUnit(1, type, tileToFp(tx), tileToFp(ty));
      ids.push(u.id);
    }
    // attack-move the whole wave at the player's Hub via the real command path
    this.game.issue({ t: "attackmove", ids, x: tileToFp(target.x), y: tileToFp(target.y), q: 0 });
    if (typeof waveIndex === "number") this.state._wavesDone = waveIndex;
  }

  // Pre-place a small, pre-damaged ooze base near the enemy start so an assault
  // mission opens with a visible nest to raze. Raw showcase-style placement.
  woundEnemyBase(pid) { CampaignRunner._woundEnemyBase(this.sim, pid); }

  static _woundEnemyBase(sim, pid) {
    const fac = FACTIONS[sim.factions[pid]] || FACTIONS.ooze;
    const s = sim.map.starts[pid];
    // The Sim already spawned a default start building + workers for pid; wipe
    // those and lay a hand-built battered nest instead.
    CampaignRunner._clearPlayer(sim, pid);
    const place = (type, tx, ty, hpFrac = 1) => {
      const b = sim.spawnBuilding(pid, type, tx, ty, true);
      if (hpFrac < 1) b.hp = Math.max(1, (b.maxHp * hpFrac) | 0);
      return b;
    };
    // core nest (Nucleus) + a couple of battered support structures
    place(fac.start, s.x - 1, s.y - 1, 0.65);          // wounded Nucleus
    place("den",  s.x + 3, s.y - 1, 0.5);              // cracked Den
    place("pod",  s.x - 1, s.y + 3, 0.7);              // dented Pod
    // a handful of workers so the easy AI has an economy to rebuild from
    for (let i = 0; i < 4; i++) {
      const u = sim.spawnUnit(pid, fac.worker, tileToFp(s.x + 2 + (i % 2)), tileToFp(s.y + 2 + ((i / 2) | 0)));
      sim.autoGather(u);
    }
    // a couple of defenders loitering in the nest
    sim.spawnUnit(pid, "nip", tileToFp(s.x + 1), tileToFp(s.y + 1));
    sim.spawnUnit(pid, "nip", tileToFp(s.x + 2), tileToFp(s.y + 1));
  }

  // ---- DOM: dialogue bar, objective tracker, intro + victory cards --------
  buildDom() {
    // container the campaign layer lives in (added once, cleared per mission)
    let root = $("campaign-layer");
    if (!root) {
      root = document.createElement("div");
      root.id = "campaign-layer";
      document.body.appendChild(root);
    }
    root.innerHTML = `
      <div id="cmp-objectives" class="cmp-objectives"></div>
      <div id="cmp-dialogue" class="cmp-dialogue hidden">
        <div class="cmp-dlg-speaker"></div>
        <div class="cmp-dlg-text"></div>
      </div>
    `;
    root.classList.remove("hidden");
    this.$objectives = $("cmp-objectives");
    this.$dialogue = $("cmp-dialogue");
    this.$dlgSpeaker = this.$dialogue.querySelector(".cmp-dlg-speaker");
    this.$dlgText = this.$dialogue.querySelector(".cmp-dlg-text");
    // click the bar to dismiss the current line early / advance the queue
    this.$dialogue.addEventListener("click", () => { this._dlgUntil = 0; });
    this.renderObjectives();
  }

  renderObjectives() {
    if (!this.$objectives) return;
    const objs = this.mission.objectives || [];
    const check = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 8.5 L6.5 12 L13 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const dot = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="3.4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
    const rows = objs.map((o) => {
      const done = !!o._done;
      const cls = "cmp-obj" + (done ? " done" : "") + (o.optional ? " optional" : "");
      return `<div class="${cls}"><span class="cmp-obj-mark">${done ? check : dot}</span><span class="cmp-obj-text">${escapeHtml(o.text)}${o.optional ? " (optional)" : ""}</span></div>`;
    }).join("");
    this.$objectives.innerHTML = `<div class="cmp-obj-title">Objectives</div>${rows}`;
  }

  // ---- dialogue bar (queue + typewriter) ----------------------------------
  queueLine(speaker, text) {
    this._dlgQueue.push({ speaker, text });
  }
  tickDialogue() {
    const now = performance.now();
    if (this._dlgActive) {
      // typewriter reveal, then hold until auto-dismiss / click
      if (this._typeI < this._typeFull.length) {
        // reveal ~2 chars per frame at 60fps => full line in <1s for short lines
        this._typeI = Math.min(this._typeFull.length, this._typeI + 2);
        this.$dlgText.textContent = this._typeFull.slice(0, this._typeI);
        // while typing, keep pushing the auto-dismiss out
        this._dlgUntil = now + 6000;
      }
      if (now >= this._dlgUntil) {
        this._dlgActive = false;
        this.$dialogue.classList.add("hidden");
      }
      return;
    }
    // nothing showing: pop the next queued line
    if (this._dlgQueue.length) {
      const line = this._dlgQueue.shift();
      this._dlgActive = true;
      this._typeFull = line.text;
      this._typeI = 0;
      this.$dlgSpeaker.textContent = line.speaker;
      this.$dlgText.textContent = "";
      this.$dialogue.classList.remove("hidden");
      this._dlgUntil = now + 6000;
    }
  }

  // ---- intro / victory cards ----------------------------------------------
  showIntro() {
    const m = this.mission;
    const card = document.createElement("div");
    card.id = "cmp-intro";
    card.className = "cmp-card";
    card.innerHTML = `
      <div class="cmp-card-kicker">${escapeHtml(actLabel(m.act))} — Mission</div>
      <div class="cmp-card-title">${escapeHtml(m.title)}</div>
      <div class="cmp-card-blurb">${escapeHtml(m.blurb)}</div>
      <div class="cmp-card-hint">click to begin</div>
    `;
    $("campaign-layer").appendChild(card);
    const dismiss = () => {
      card.classList.add("out");
      setTimeout(() => card.remove(), 400);
      // first spoken line + intro dialogue chain
      if (m.intro) this.queueLine(m.intro.speaker, m.intro.text);
    };
    card.addEventListener("click", dismiss);
    // auto-dismiss after ~4.5s
    this._introTimer = setTimeout(dismiss, 4500);
  }

  endMission(won) {
    if (this.ended) return;
    this.ended = true;
    // final line(s): outro on win, then any act stinger
    const m = this.mission;
    if (won) {
      // freeze combat outcomes but keep the loop alive so dialogue plays
      this.sim.noGameOver = true;
      if (m.dialogue && m.dialogue.win) this.queueLine(m.dialogue.win.speaker, m.dialogue.win.text);
      if (m.outro) this.queueLine(m.outro.speaker, m.outro.text);
      if (m.stinger) for (const key of m.stinger) {
        const d = m.dialogue && m.dialogue[key];
        if (d) this.queueLine(d.speaker, d.text);
      }
      markComplete(m.id);
      this.audio?.victory?.();
    } else {
      this.audio?.defeat?.();
    }
    // show the end panel after a short beat so the win line is readable
    setTimeout(() => this.showEndPanel(won), won ? 900 : 400);
  }

  showEndPanel(won) {
    const panel = document.createElement("div");
    panel.id = "cmp-end";
    panel.className = "cmp-end";
    const m = this.mission;
    const idx = MISSIONS.findIndex((x) => x.id === m.id);
    let nextPlayable = null;
    for (let i = idx + 1; i < MISSIONS.length; i++) {
      if (!MISSIONS[i].stub) { nextPlayable = MISSIONS[i]; break; }
    }
    const title = won ? "MISSION COMPLETE" : "MISSION FAILED";
    const cls = won ? "win" : "lose";
    const cont = won && nextPlayable
      ? `<button id="cmp-next" class="menu-btn primary">Next Mission</button>`
      : (won ? `<button id="cmp-continue" class="menu-btn primary">Continue</button>` : `<button id="cmp-retry" class="menu-btn primary">Retry</button>`);
    panel.innerHTML = `
      <div class="menu-box cmp-end-box">
        <h1 class="${cls}">${title}</h1>
        <p class="cmp-end-sub">${escapeHtml(m.title)}</p>
        ${cont}
        <button id="cmp-select" class="menu-btn">Mission Select</button>
      </div>
    `;
    document.body.appendChild(panel);
    panel.querySelector("#cmp-next")?.addEventListener("click", () => location.reload());
    panel.querySelector("#cmp-continue")?.addEventListener("click", () => location.reload());
    panel.querySelector("#cmp-retry")?.addEventListener("click", () => location.reload());
    panel.querySelector("#cmp-select")?.addEventListener("click", () => location.reload());
  }
}

// ---------- static UI: mission-select panel & menu button -------------------

let _startMission = null;

// Wire the "Campaign" button + mission-select panel into the existing menu.
// startMission(mission) is provided by main.js (it owns Game construction).
export function mountCampaign(startMission) {
  _startMission = startMission;
  buildMissionSelect();
  const btn = $("btn-campaign");
  if (btn) btn.addEventListener("click", openMissionSelect);
  const back = $("cmp-back");
  if (back) back.addEventListener("click", closeMissionSelect);
}

function openMissionSelect() {
  renderMissionList();
  $("menu")?.classList.add("hidden");
  $("campaign-select")?.classList.remove("hidden");
}
function closeMissionSelect() {
  $("campaign-select")?.classList.add("hidden");
  $("menu")?.classList.remove("hidden");
}

// Build the (hidden) mission-select overlay once.
function buildMissionSelect() {
  if ($("campaign-select")) return;
  const overlay = document.createElement("div");
  overlay.id = "campaign-select";
  overlay.className = "hidden";
  overlay.innerHTML = `
    <div class="menu-box cmp-select-box">
      <div class="menu-hero">
        <h1>Campaign</h1>
        <p class="tagline">The Cogs, the Ooze, and a scrap pile with teeth.</p>
      </div>
      <div id="cmp-mission-list" class="cmp-mission-list"></div>
      <button id="cmp-back" class="menu-btn">Back</button>
    </div>
  `;
  document.body.appendChild(overlay);
}

function renderMissionList() {
  const list = $("cmp-mission-list");
  if (!list) return;
  const progress = loadProgress();
  const lock = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 7 V5 a2.5 2.5 0 0 1 5 0 V7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
  const check = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M3 8.5 L6.5 12 L13 4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const play = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M5 3.5 L12 8 L5 12.5 Z" fill="currentColor"/></svg>`;

  let html = "";
  for (const actMeta of ACTS) {
    const missions = MISSIONS.filter((m) => m.act === actMeta.act);
    if (!missions.length) continue;
    html += `<div class="cmp-act"><div class="cmp-act-title">${escapeHtml(actMeta.title)}</div><div class="cmp-act-sub">${escapeHtml(actMeta.subtitle)}</div></div>`;
    for (const m of missions) {
      const unlocked = isUnlocked(m, progress);
      const completed = !!progress.completed[m.id];
      const stub = !!m.stub;
      const state = stub ? "stub" : (!unlocked ? "locked" : (completed ? "done" : "ready"));
      const mark = state === "done" ? check : (state === "ready" ? play : lock);
      const clickable = state === "ready" || state === "done";
      html += `
        <div class="cmp-mission ${state}" ${clickable ? `data-mission="${m.id}"` : ""}>
          <span class="cmp-mission-mark">${mark}</span>
          <span class="cmp-mission-body">
            <span class="cmp-mission-title">${escapeHtml(m.title)}</span>
            <span class="cmp-mission-blurb">${escapeHtml(m.blurb)}</span>
          </span>
        </div>`;
    }
  }
  list.innerHTML = html;
  list.querySelectorAll(".cmp-mission[data-mission]").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.getAttribute("data-mission");
      const mission = MISSION_BY_ID[id];
      if (mission && _startMission) _startMission(mission);
    });
  });
}

// ---------- helpers ---------------------------------------------------------

function actLabel(act) {
  const a = ACTS.find((x) => x.act === act);
  return a ? a.title.split("—")[0].trim() : `Act ${act}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// expose progress query for the boot path if it ever wants it
export { loadProgress, MISSION_BY_ID };
