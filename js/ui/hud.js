// DOM HUD: resource bar, selection panel, command card, minimap, toasts.
import { FP, fpToTile } from "../core/fixed.js";
import { UNITS, BUILDINGS, PLAYER_COLORS, MAX_QUEUE } from "../core/data.js";
import { KEYS, DEFAULTS, rebind, resetBinds } from "./keys.js";

export class Hud {
  constructor(game, renderer, audio) {
    this.game = game;
    this.sim = game.sim;
    this.renderer = renderer;
    this.audio = audio;
    this.pid = game.localPlayer;
    this.input = null; // set by main.js after Input is constructed
    this.cardSig = ""; // structural signature; card DOM rebuilt only on change
    this.blips = [];   // minimap under-attack markers
    this.activeType = null; // Tab-cycled subgroup driving the command card
    this.hotkeys = {}; // grid key -> command, rebuilt with the card
    this.recentTrains = []; // {bid, until} — issued but not yet in a queue

    this.$minerals = document.getElementById("res-minerals");
    this.$supply = document.getElementById("res-supply");
    this.$selPanel = document.getElementById("sel-panel");
    this.$cmdCard = document.getElementById("cmd-card");
    this.$hint = document.getElementById("hint");
    this.$toasts = document.getElementById("toasts");
    this.$selectBox = document.getElementById("select-box");
    this.$status = document.getElementById("net-status");

    this.minimap = document.getElementById("minimap");
    this.mmCtx = this.minimap.getContext("2d");
    this.minimap.addEventListener("pointerdown", (e) => { if (e.button === 0) this.minimapClick(e); });
    this.minimap.addEventListener("pointermove", (e) => { if (e.buttons & 1) this.minimapClick(e); });
    this.minimap.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.minimapOrder(e);
    });

    // idle worker button
    this.$idle = document.getElementById("btn-idle");
    this.$idle.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.$idle.addEventListener("click", () => this.input?.selectIdleWorker());

    // fullscreen toggle — edge scrolling only works reliably in fullscreen.
    // navigationUI:"hide" asks the browser not to reveal its chrome on
    // top-edge hover (a hint; support varies).
    document.getElementById("btn-fullscreen").addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen({ navigationUI: "hide" });
    });

    // mute toggle
    this.$mute = document.getElementById("btn-mute");
    this.updateMuteIcon();
    this.$mute.addEventListener("click", () => {
      this.audio.setMuted(!this.audio.muted);
      this.updateMuteIcon();
      this.syncSettings();
    });

    this.initSettings();

    document.getElementById("hud").classList.remove("hidden");
  }

  updateMuteIcon() {
    this.$mute.classList.toggle("muted", this.audio.muted);
    this.$mute.title = this.audio.muted ? "Unmute" : "Mute";
  }

  // ---------- settings modal ----------

  initSettings() {
    this.$settings = document.getElementById("settings");
    this.$volume = document.getElementById("set-volume");
    this.$volumeVal = document.getElementById("set-volume-val");
    this.$setMute = document.getElementById("set-mute");

    document.getElementById("btn-settings").addEventListener("click", () => this.openSettings());
    document.getElementById("btn-settings-close").addEventListener("click", () => this.closeSettings());
    document.getElementById("settings-backdrop").addEventListener("click", () => this.closeSettings());

    // master volume slider (0..100 -> 0..1)
    this.$volume.addEventListener("input", () => {
      const v = this.$volume.value / 100;
      this.audio.setVolume(v);
      this.$volumeVal.textContent = `${this.$volume.value}%`;
    });

    // mute toggle inside the modal
    this.$setMute.addEventListener("click", () => {
      this.audio.setMuted(!this.audio.muted);
      this.updateMuteIcon();
      this.syncSettings();
    });

    // reset all keybinds to their defaults
    document.getElementById("btn-reset-binds").addEventListener("click", () => {
      resetBinds();
      this.listening = null;
      this.buildKeybindTable();
      this.toastInfo("Keybindings reset to defaults");
    });

    // row currently capturing a key: { action, slotIndex? } or null
    this.listening = null;

    // While the settings modal is open, swallow game hotkeys. input.js
    // registers its keydown handler on window WITHOUT capture (bubble phase),
    // so this capture-phase listener runs first; stopImmediatePropagation()
    // then prevents the event from ever reaching input.js. When a row is
    // listening we let captureRebind() consume the key instead. Escape still
    // closes the modal (handled here) when we are not mid-listen.
    window.addEventListener("keydown", (e) => this.onSettingsKey(e), true);

    this.buildKeybindTable();
    this.syncSettings();
  }

  // capture-phase keydown while the settings modal is visible
  onSettingsKey(e) {
    if (this.$settings.classList.contains("hidden")) return; // modal closed: ignore
    // Block the event from reaching input.js's window listener. input.js
    // registers in the bubble phase; this handler runs in the capture phase,
    // which always precedes bubble on the same target. stopImmediatePropagation
    // is required (not just stopPropagation): both listeners sit on `window`,
    // and plain stopPropagation does NOT suppress sibling listeners on the very
    // same target — only listeners on other nodes in the tree.
    e.stopImmediatePropagation();
    if (this.listening) {
      // a row is waiting for its new key
      e.preventDefault();
      this.captureRebind(e);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      this.closeSettings();
    }
  }

  // reflect current audio state into the modal controls
  syncSettings() {
    const pct = Math.round((this.audio.volume ?? 0.5) * 100);
    this.$volume.value = pct;
    this.$volumeVal.textContent = `${pct}%`;
    this.$setMute.textContent = this.audio.muted ? "Off" : "On";
    this.$setMute.classList.toggle("off", this.audio.muted);
  }

  openSettings() { this.syncSettings(); this.$settings.classList.remove("hidden"); }
  closeSettings() {
    this.listening = null;
    this.$settings.classList.add("hidden");
  }

  // Rebindable actions and their display labels. cameraSlots is expanded into
  // four sub-rows (one per slot) by buildKeybindTable.
  static REBINDABLE = [
    ["idleWorker", "Idle worker"],
    ["selectArmy", "Select army"],
    ["cameraSlots", "Camera slots"],   // rendered as 4 sub-rows
    ["cycleBase", "Cycle bases"],
    ["rotateLeft", "Rotate left"],
    ["rotateRight", "Rotate right"],
  ];

  // Keys that game systems own and that must never be rebound onto. Digits and
  // arrow keys are handled separately (ranges), see isReserved().
  static FIXED_KEYS = new Set([
    "q", "w", "e", "r", "a", "s", "d", "f",
    "tab", "shift", "space", " ", "escape", "backspace",
  ]);

  // is `key` reserved by a fixed game binding (not counting `exceptAction`'s
  // own current binding)?
  isReserved(key) {
    if (Hud.FIXED_KEYS.has(key)) return "a fixed game control";
    if (/^[1-9]$/.test(key)) return "control groups";
    if (/^arrow/.test(key)) return "camera pan";
    return null;
  }

  // is `key` already used by another rebindable action? Returns that action's
  // label, or null. `self` is {action, slotIndex} to skip the row's own key.
  conflictWith(key, self) {
    for (const [action, label] of Hud.REBINDABLE) {
      const keys = KEYS[action] || [];
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] !== key) continue;
        // Skip the row's own binding: for a single-binding action the whole
        // binding is replaced, so any of its keys is "self"; for cameraSlots
        // only the exact slot being edited is self (other slots still clash).
        if (self && action === self.action &&
            (self.slotIndex == null || self.slotIndex === i)) continue;
        return label;
      }
    }
    return null;
  }

  // interactive keybind editor: rebindable rows capture a key on click,
  // fixed rows remain a read-only reference.
  buildKeybindTable() {
    const table = document.getElementById("keybind-table");
    if (!table) return;
    const chip = (k) => `<kbd>${k.toUpperCase()}</kbd>`;
    const chips = (arr) => arr.map(chip).join("");

    // one interactive row. `label`, action key, optional slotIndex (for
    // cameraSlots), and the array of keys to display as chips.
    const rowEl = (label, action, slotIndex, keys) => {
      const row = document.createElement("div");
      row.className = "keybind-row rebindable";
      row.dataset.action = action;
      if (slotIndex != null) row.dataset.slot = String(slotIndex);
      const act = document.createElement("span");
      act.className = "kb-action";
      act.textContent = label;
      const keysEl = document.createElement("span");
      keysEl.className = "kb-keys";
      keysEl.innerHTML = keys.length ? chips(keys) : `<span class="kb-listen">unbound</span>`;
      row.append(act, keysEl);
      row.addEventListener("click", () => this.startListening(action, slotIndex, row));
      return row;
    };

    const staticRow = (label, keysHtml) => {
      const row = document.createElement("div");
      row.className = "keybind-row";
      row.innerHTML = `<span class="kb-action">${label}</span><span class="kb-keys">${keysHtml}</span>`;
      return row;
    };
    const sep = (text) => {
      const el = document.createElement("div");
      el.className = "keybind-sep";
      el.textContent = text;
      return el;
    };

    table.innerHTML = "";
    table.append(sep("Rebindable"));
    table.append(rowEl("Idle worker", "idleWorker", null, KEYS.idleWorker));
    table.append(rowEl("Select army", "selectArmy", null, KEYS.selectArmy));
    for (let i = 0; i < 4; i++) {
      table.append(rowEl(`Camera ${i + 1}`, "cameraSlots", i, [KEYS.cameraSlots[i]]));
    }
    table.append(rowEl("Cycle bases", "cycleBase", null, KEYS.cycleBase));
    table.append(rowEl("Rotate left", "rotateLeft", null, KEYS.rotateLeft));
    table.append(rowEl("Rotate right", "rotateRight", null, KEYS.rotateRight));

    const kc = (k) => `<kbd>${k}</kbd>`;
    const fixed = [
      ["Command-card grid", `${kc("Q")}${kc("W")}${kc("E")}${kc("A")}${kc("S")}${kc("D")}${kc("F")}`],
      ["Cycle subgroup", kc("Tab")],
      ["Queue orders", kc("Shift")],
      ["Set control group", `${kc("Ctrl")}+${kc("1-9")}`],
      ["Add to group", `${kc("Shift")}+${kc("1-9")}`],
      ["Recall group", `${kc("1-9")} (dbl-tap centers)`],
      ["Center on selection", kc("Space")],
      ["Pan camera", `${kc("Arrows")} / edge`],
      ["Zoom", kc("Wheel")],
      ["Save camera slot", `${kc("Ctrl")}+ slot key`],
    ];
    table.append(sep("Fixed"));
    for (const [a, k] of fixed) table.append(staticRow(a, k));
  }

  // put a row into "listening" mode: the next keydown becomes its binding
  startListening(action, slotIndex, row) {
    // cancel any other listening row first
    this.clearListening();
    this.listening = { action, slotIndex, row };
    row.classList.add("listening");
    row.querySelector(".kb-keys").innerHTML = `<span class="kb-listen">press a key…</span>`;
  }

  // restore the currently-listening row to its normal rendered state
  clearListening() {
    if (!this.listening) return;
    const { action, slotIndex, row } = this.listening;
    this.listening = null;
    const keys = slotIndex != null ? [KEYS.cameraSlots[slotIndex]] : KEYS[action];
    row.classList.remove("listening");
    const keysEl = row.querySelector(".kb-keys");
    const chip = (k) => `<kbd>${k.toUpperCase()}</kbd>`;
    keysEl.innerHTML = keys.length ? keys.map(chip).join("") : `<span class="kb-listen">unbound</span>`;
    this.clearWarn(row);
  }

  clearWarn(row) {
    const w = row.nextElementSibling;
    if (w && w.classList.contains("keybind-warn")) w.remove();
  }

  showWarn(row, msg) {
    this.clearWarn(row);
    const w = document.createElement("div");
    w.className = "keybind-warn";
    w.textContent = msg;
    row.after(w);
  }

  // consume a keydown for the listening row (called from onSettingsKey)
  captureRebind(e) {
    const listen = this.listening;
    if (!listen) return;
    if (e.key === "Escape") { this.clearListening(); return; } // cancel, no change
    const key = e.key.toLowerCase();
    // ignore bare modifier presses — wait for a real key
    if (["shift", "control", "alt", "meta"].includes(key)) return;

    const self = { action: listen.action, slotIndex: listen.slotIndex };
    const reserved = this.isReserved(key);
    if (reserved) { this.showWarn(listen.row, `"${key}" is reserved for ${reserved}`); return; }
    const conflict = this.conflictWith(key, self);
    if (conflict) { this.showWarn(listen.row, `"${key}" is already used by ${conflict}`); return; }

    // apply the rebind
    if (listen.action === "cameraSlots") {
      const arr = [...KEYS.cameraSlots];
      arr[listen.slotIndex] = key;
      rebind("cameraSlots", arr);
    } else {
      // multi-key actions collapse to the single captured key
      rebind(listen.action, [key]);
    }
    // rebuild wipes listening + warnings and re-renders from KEYS
    this.listening = null;
    this.buildKeybindTable();
  }

  // ---------- per-frame ----------

  update() {
    const s = this.sim.supplyOf(this.pid);
    this.$minerals.textContent = this.sim.minerals[this.pid];
    this.$supply.textContent = `${s.used} / ${s.cap}`;
    this.$supply.classList.toggle("warn", s.used >= s.cap);

    // idle-worker button: visible only when someone is slacking
    const idle = this.sim.entities.filter((e) =>
      e.owner === this.pid && e.type === "worker" && e.order.kind === "idle").length;
    this.$idle.classList.toggle("hidden", idle === 0);
    if (idle > 0) this.$idle.querySelector("b").textContent = idle;

    this.drawMinimap();
    this.refreshSelection();
  }

  // ---------- selection panel + command card ----------

  refreshSelection() {
    const sel = [...this.renderer.selection]
      .map((id) => this.sim.byId.get(id))
      .filter(Boolean);
    const mine = sel.filter((e) => e.owner === this.pid);

    if (!sel.length) {
      this.$selPanel.innerHTML = "";
      this.$cmdCard.innerHTML = "";
      this.cardSig = "";
      this.activeType = null;
      this.hotkeys = {};
      return;
    }

    // subgroups: distinct owned types in selection order; Tab cycles these
    const types = [];
    for (const e of mine) if (!types.includes(e.type)) types.push(e.type);
    if (!this.activeType || !types.includes(this.activeType)) this.activeType = types[0] || null;

    // ---- info panel ----
    const counts = {};
    for (const e of sel) counts[e.type] = (counts[e.type] || 0) + 1;
    let html = "";
    for (const [type, n] of Object.entries(counts)) {
      const name = UNITS[type]?.name || BUILDINGS[type]?.name || "Minerals";
      const active = type === this.activeType && types.length > 1;
      html += `<div class="sel-row${active ? " active" : ""}" data-type="${type}"><span>${name}</span><b>${n > 1 ? "x" + n : ""}</b></div>`;
    }
    if (types.length > 1) html += `<div class="sel-sub">Tab cycles subgroup</div>`;
    if (sel.length === 1) {
      const e = sel[0];
      if (e.type === "mineral") html += `<div class="sel-sub">${e.amount} remaining</div>`;
      else html += `<div class="sel-sub">${Math.max(0, e.hp | 0)} / ${e.maxHp} HP</div>`;
      if (e.unit) html += `<div class="sel-sub status">${this.orderLabel(e)}</div>`;
      if (e.building && !e.done) {
        const pct = ((e.progress / BUILDINGS[e.type].buildTime) * 100) | 0;
        html += `<div class="sel-sub">Constructing ${pct}%</div>`;
      }
    }

    // build-queue chips: one row per selected own finished building of the
    // active type (cap 4). Chips update live via the 100ms innerHTML refresh.
    const queueBuildings = mine
      .filter((e) => e.type === this.activeType && e.building && e.done)
      .slice(0, 4);
    const showRow = queueBuildings.length > 1 || sel.length > 1;
    for (const b of queueBuildings) {
      const q = b.queue || [];
      if (!q.length && !showRow) continue;   // sole selection, empty queue -> nothing
      const name = BUILDINGS[b.type].name;
      let chips = "";
      q.forEach((item, i) => {
        if (i === 0) {
          const pct = (100 - (item.remaining / UNITS[item.type].buildTime) * 100) | 0;
          chips += `<span class="q-item q-head">${pct}%</span>`;
        } else {
          chips += `<span class="q-item">${UNITS[item.type].name.charAt(0)}</span>`;
        }
      });
      html += `<div class="queue-row"><span class="q-name">${name}</span><span class="q-items">${chips}</span></div>`;
    }

    this.$selPanel.innerHTML = html;
    for (const row of this.$selPanel.querySelectorAll(".sel-row[data-type]")) {
      row.addEventListener("click", () => {
        this.activeType = row.dataset.type;
        this.cardSig = "";
        this.refreshSelection();
      });
    }

    // ---- command card: grid hotkeys (QWER row, AS pinned for combat) ----
    const anyUnits = mine.some((e) => e.unit);
    const sig = `${types.join(",")}|${this.activeType}|${anyUnits}`;
    if (sig === this.cardSig) return;
    this.cardSig = sig;

    const slots = [];
    if (this.activeType === "worker") {
      const order = ["depot", "barracks", "hq"];
      const keys = ["q", "w", "e"];
      order.forEach((b, i) =>
        slots.push({ key: keys[i], cmd: `build-${b}`, label: BUILDINGS[b].name, sub: `${BUILDINGS[b].cost}` }));
    }
    const activeBuilding = mine.find((e) => e.type === this.activeType && e.building && e.done);
    if (activeBuilding) {
      const keys = ["q", "w", "e", "r"];
      (BUILDINGS[activeBuilding.type].trains || []).forEach((t, i) => {
        const d = UNITS[t];
        slots.push({ key: keys[i], cmd: `train-${t}`, label: d.name, sub: `${d.cost} · ${d.supply} supply` });
      });
    }
    if (anyUnits) {
      slots.push({ key: "a", cmd: "attack", label: "Attack-move", sub: "all units" });
      slots.push({ key: "s", cmd: "stop", label: "Stop", sub: "all units" });
      slots.push({ key: "d", cmd: "hold", label: "Hold Position", sub: "all units" });
      slots.push({ key: "f", cmd: "patrol", label: "Patrol", sub: "all units" });
    }

    this.hotkeys = {};
    let card = "";
    for (const s of slots) {
      this.hotkeys[s.key] = s.cmd;
      card += `<button data-cmd="${s.cmd}"><kbd>${s.key.toUpperCase()}</kbd><span>${s.label}</span><small>${s.sub}</small></button>`;
    }
    this.$cmdCard.innerHTML = card;
    for (const b of this.$cmdCard.querySelectorAll("button")) {
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      b.addEventListener("click", () => this.command(b.dataset.cmd));
    }
  }

  // Tab cycles which subgroup of the selection drives the command card.
  cycleSubgroup(dir = 1) {
    const sel = [...this.renderer.selection]
      .map((id) => this.sim.byId.get(id))
      .filter((e) => e && e.owner === this.pid);
    const types = [];
    for (const e of sel) if (!types.includes(e.type)) types.push(e.type);
    if (types.length < 2) return;
    const i = types.indexOf(this.activeType);
    this.activeType = types[(i + dir + types.length) % types.length];
    this.cardSig = "";
    this.refreshSelection();
    this.audio.select();
  }

  orderLabel(e) {
    const o = e.order;
    switch (o.kind) {
      case "idle": return "Idle";
      case "move": return "Moving";
      case "attackmove": return "Attack-moving";
      case "attack": return "Attacking";
      case "build": {
        const site = this.sim.byId.get(o.targetId);
        return site ? `Constructing ${BUILDINGS[site.type].name}` : "Constructing";
      }
      case "gather":
        return o.phase === "return" ? "Returning minerals"
          : o.phase === "mining" ? "Mining" : "Heading to minerals";
      case "patrol": return "Patrolling";
      case "hold": return "Holding position";
      default: return "";
    }
  }

  command(cmd) {
    if (cmd.startsWith("build-")) this.input?.startPlacing(cmd.slice(6));
    else if (cmd.startsWith("train-")) {
      const t = cmd.slice(6);
      const d = UNITS[t];
      // among selected finished buildings that can train t, pick the one
      // with the shortest queue — hotkeying 3 barracks together macros right.
      // Issued commands take a tick to land in queues, so count our own
      // just-issued trains too or rapid presses would stack on one building.
      const now = performance.now();
      this.recentTrains = this.recentTrains.filter((r) => r.until > now);
      const pending = (bid) => this.recentTrains.filter((r) => r.bid === bid).length;
      const load = (e) => e.queue.length + pending(e.id);
      const candidates = [...this.renderer.selection]
        .map((id) => this.sim.byId.get(id))
        .filter((e) => e && e.owner === this.pid && e.building && e.done &&
          (BUILDINGS[e.type].trains || []).includes(t) && load(e) < MAX_QUEUE)
        .sort((a, b) => load(a) - load(b) || a.id - b.id);
      if (!candidates.length) { this.audio.error(); return this.toast("Production queues are full"); }
      const s = this.sim.supplyOf(this.pid);
      if (!this.sim.canAfford(this.pid, d.cost)) { this.audio.error(); return this.toast("Not enough minerals"); }
      // supply is claimed when production starts, so queuing is allowed —
      // just warn that the queue will stall until a depot finishes
      if (s.used + d.supply > s.cap) this.toastInfo("Queued - waiting on supply");
      this.game.issue({ t: "train", buildingId: candidates[0].id, unit: t });
      this.recentTrains.push({ bid: candidates[0].id, until: now + 600 });
      this.audio.trained();
    } else if (cmd === "attack") {
      if (this.input?.mySelectedUnitIds().length) this.input.setAttackMode(true);
    } else if (cmd === "patrol") {
      if (this.input?.mySelectedUnitIds().length) this.input.setPatrolMode(true);
    } else if (cmd === "hold") {
      const ids = this.input?.mySelectedUnitIds() || [];
      if (ids.length) { this.game.issue({ t: "hold", ids }); this.audio.ack(); }
    } else if (cmd === "stop") {
      const ids = this.input?.mySelectedUnitIds() || [];
      if (ids.length) { this.game.issue({ t: "stop", ids }); this.audio.ack(); }
    }
  }

  // ---------- minimap ----------

  drawMinimap() {
    const { w, h, rock } = this.sim.map;
    const S = this.minimap.width / w;
    const ctx = this.mmCtx;
    const fog = this.sim.fog[this.pid];
    ctx.fillStyle = "#06090d";
    ctx.fillRect(0, 0, this.minimap.width, this.minimap.height);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const f = fog[i];
        if (f === 0) continue;
        ctx.fillStyle = rock[i]
          ? (f === 2 ? "#3d444d" : "#262b31")
          : (f === 2 ? "#28402c" : "#182920");
        ctx.fillRect(x * S, y * S, S + 0.5, S + 0.5);
      }
    }
    for (const e of this.sim.entities) {
      const tx = fpToTile(e.x), ty = fpToTile(e.y);
      const f = fog[ty * w + tx];
      if (e.type === "mineral") {
        if (f >= 1) { ctx.fillStyle = "#4adfd2"; ctx.fillRect(tx * S, ty * S, S, S); }
        continue;
      }
      if (e.owner === this.pid || f === 2 || (e.building && (e.seenBy & (1 << this.pid)))) {
        ctx.fillStyle = PLAYER_COLORS[e.owner];
        const size = e.building ? S * e.size : Math.max(2, S);
        ctx.fillRect(tx * S - size / 2 + S / 2, ty * S - size / 2 + S / 2, size, size);
      }
    }
    // under-attack blips: flashing red circles fading over 3s
    const now = performance.now();
    this.blips = this.blips.filter((b) => now - b.t < 3000);
    for (const b of this.blips) {
      const age = (now - b.t) / 3000;
      if (Math.sin(age * 24) < 0) continue;   // flash
      ctx.strokeStyle = `rgba(255,80,60,${1 - age})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(b.x * S, b.y * S, 5 + age * 6, 0, Math.PI * 2);
      ctx.stroke();
    }

    // camera target
    const cam = this.renderer.camera;
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 1;
    const vw = cam.dist * 0.9 * S, vh = cam.dist * 0.6 * S;
    ctx.strokeRect(cam.tx * S - vw / 2, cam.tz * S - vh / 2, vw, vh);
  }

  // called when one of our entities takes a hit
  notifyAttack(txFp, tyFp) {
    const tx = fpToTile(txFp), ty = fpToTile(tyFp);
    const last = this.blips[this.blips.length - 1];
    if (last && Math.abs(last.x - tx) < 5 && Math.abs(last.y - ty) < 5) return;
    this.blips.push({ x: tx, y: ty, t: performance.now() });
    // audible alarm only if the fight is off-screen
    const cam = this.renderer.camera;
    const d = Math.hypot(cam.tx - txFp / 256, cam.tz - tyFp / 256);
    if (d > 16) this.audio.underAttack();
  }

  minimapClick(e) {
    const r = this.minimap.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * this.sim.map.w;
    const y = (e.clientY - r.top) / r.height * this.sim.map.h;
    this.renderer.camera.jumpTo(x, y);
  }

  // right-click on the minimap: order selected units there
  minimapOrder(e) {
    const ids = this.input?.mySelectedUnitIds() || [];
    if (!ids.length) return;
    const r = this.minimap.getBoundingClientRect();
    const wx = (e.clientX - r.left) / r.width * this.sim.map.w;
    const wy = (e.clientY - r.top) / r.height * this.sim.map.h;
    const fx = Math.round(wx * FP), fy = Math.round(wy * FP);
    if (this.input.attackMode) {
      this.game.issue({ t: "attackmove", ids, x: fx, y: fy, q: e.shiftKey ? 1 : 0 });
      this.input.setAttackMode(false);
      this.audio.attackAck();
    } else {
      this.game.issue({ t: "move", ids, x: fx, y: fy, q: e.shiftKey ? 1 : 0 });
      this.audio.ack();
    }
    this.renderer.orderPing(wx, wy, "#7cff6b");
  }

  // ---------- feedback ----------

  toast(msg) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    this.$toasts.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  toastInfo(msg) {
    const el = document.createElement("div");
    el.className = "toast info";
    el.textContent = msg;
    this.$toasts.appendChild(el);
    setTimeout(() => el.remove(), 1600);
  }

  setHint(text) {
    this.$hint.textContent = text;
    this.$hint.classList.toggle("hidden", !text);
  }

  setStatus(text) {
    this.$status.textContent = text;
    this.$status.classList.toggle("hidden", !text);
  }

  drawSelectBox(drag) {
    const el = this.$selectBox;
    if (!drag || drag.rotate) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    el.style.left = Math.min(drag.sx, drag.cx) + "px";
    el.style.top = Math.min(drag.sy, drag.cy) + "px";
    el.style.width = Math.abs(drag.cx - drag.sx) + "px";
    el.style.height = Math.abs(drag.cy - drag.sy) + "px";
  }

  gameOver(winner) {
    const el = document.getElementById("gameover");
    el.classList.remove("hidden");
    el.querySelector("h1").textContent = winner === this.pid ? "VICTORY" : "DEFEAT";
    el.querySelector("h1").className = winner === this.pid ? "win" : "lose";
  }
}
