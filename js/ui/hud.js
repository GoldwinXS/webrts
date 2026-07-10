// DOM HUD: resource bar, selection panel, command card, minimap, toasts.
import { FP, fpToTile } from "../core/fixed.js";
import { UNITS, BUILDINGS, FACTIONS, PLAYER_COLORS, MAX_QUEUE, ABILITIES, UPGRADES, UPGRADE_BITS } from "../core/data.js";
import { THEMES } from "../core/map.js";
import { KEYS, DEFAULTS, rebind, resetBinds } from "./keys.js";

// One-line blurbs for the command-card tooltips (so you know what a button does
// before clicking). Keyed by internal type/ability/upgrade key.
const UNIT_DESC = {
  worker: "Gathers Scrap and Oil, and builds structures.",
  marine: "Cheap ranged trooper. Hits ground and air.",
  brute: "Heavy melee bruiser. Leaps onto enemies for splash damage.",
  tank: "Long-range siege. Devastating in Anchor Mode; can't hit air.",
  wraith: "Fast, fragile flyer. Hits both ground and air.",
  banshee: "Gunship flyer with heavy ground damage; can't hit air.",
  // Ooze
  mote: "Ooze worker: gathers Scrap (minerals), melts into buildings.",
  nip: "Cheap Ooze melee swarm unit.",
  spit: "Ranged Ooze assault unit; attacks ground.",
  maw: "Heavy Ooze melee bruiser; Engulf leaps onto enemies.",
  sluice: "Ooze artillery. Burrow for long-range splash bombardment.",
  wisp: "Ooze flying support; can attack ground.",
};
const BLDG_DESC = {
  hq: "Command center. Trains Bearings and collects Scrap/Oil.",
  depot: "Raises your supply cap so you can field more units.",
  barracks: "Trains Zappers and Clanks; researches infantry upgrades.",
  refinery: "Built on an Oil seep. Bearings harvest Oil from it.",
  factory: "Trains Thumpers; researches vehicle upgrades. Needs an Assembly.",
  starport: "Trains Darts and Rumbles; researches Afterburners. Needs a Foundry.",
  turret: "Static defense. Fires on ground and air. Needs an Assembly.",
  // Ooze
  nucleus: "Ooze command center. Trains Motes.",
  den: "Ooze unit production; morphs Nips two at a time (Broods).",
  goovent: "Ooze gas extraction. Spreads goo in a radius.",
  warren: "Ooze defensive structure; researches Burrow Tech. Fires on ground + air.",
  roost: "Ooze air production building; researches Membrane.",
};
const ABIL_DESC = {
  stim: "Burst of speed and attack rate for a short time, at the cost of HP.",
  leap: "Clank leaps to a target area, dealing splash damage on landing.",
  siege: "Anchor down to fire at long range with splash; can't move while anchored.",
  burners: "Brief speed burst to reposition the Dart.",
  barrage: "Rumble channels a volley of rockets onto a target area.",
  // Ooze
  burrow: "Burrow to fire at long range with splash; immobile while burrowed.",
  engulf: "Maw lunges at a target, dealing splash damage on landing.",
};
const UPG_DESC = {
  stims: "Unlocks the Overclock ability for Zappers.",
  plating: "Adds HP to all Zappers and Clanks, current and future.",
  siegetech: "Unlocks Anchor Mode for Thumpers.",
  servos: "Thumpers move noticeably faster.",
  afterburners: "Unlocks the Afterburners ability for Darts.",
  // Ooze
  carapace: "Adds HP to all Ooze ground units, current and future.",
  adrenal: "Increases attack speed of Nips, Spits, and Maws.",
  burrowtech: "Unlocks Burrow ability for Sluices.",
  membrane: "Increases speed of Wisps.",
};
const CMD_DESC = {
  attack: "Move toward a point, attacking any enemies encountered on the way.",
  stop: "Cancel current orders and hold still.",
  hold: "Hold this ground: fire on enemies in range but never give chase.",
  patrol: "Patrol back and forth between here and a chosen point.",
};

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

    // Floating tooltip for command-card buttons (created once, positioned on hover).
    this.$cmdTip = document.createElement("div");
    this.$cmdTip.id = "cmd-tooltip";
    this.$cmdTip.className = "hidden";
    document.getElementById("hud").appendChild(this.$cmdTip);

    this.minimap = document.getElementById("minimap");
    this.mmCtx = this.minimap.getContext("2d");
    this.buildMinimapPalette();
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
    // Keyboard lock (Chrome/Edge): while fullscreen, deliver Escape to the
    // game instead of instantly leaving fullscreen — so Esc cancels placement
    // and targeting like a desktop RTS, and only exits fullscreen when the
    // input cascade has nothing left to cancel. No-op where unsupported.
    document.addEventListener("fullscreenchange", () => {
      if (document.fullscreenElement) navigator.keyboard?.lock?.(["Escape"]);
      else navigator.keyboard?.unlock?.();
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

    // Graphics quality selector
    this.$quality = document.getElementById("opt-quality");
    const QKEY = "webrts-quality";
    let qVal = "medium";
    try { qVal = localStorage.getItem(QKEY) || "medium"; } catch {}
    this.$quality.querySelectorAll(".seg-btn").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.val === qVal));
    this.applyQuality(qVal);
    this.$quality.addEventListener("click", (e) => {
      const btn = e.target.closest(".seg-btn");
      if (!btn) return;
      this.$quality.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      const v = btn.dataset.val;
      try { localStorage.setItem(QKEY, v); } catch {}
      this.applyQuality(v);
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

  applyQuality(level) {
    const r = this.renderer;
    if (!r) return;
    if (level === "low") {
      r.renderer.shadowMap.enabled = false;
      if (r.sun) r.sun.castShadow = false;
      if (r.bloom) r.bloom.strength = 0;
      r.renderer.setPixelRatio(Math.min(devicePixelRatio, 1));
    } else if (level === "high") {
      r.renderer.shadowMap.enabled = true;
      if (r.sun) r.sun.castShadow = true;
      if (r.sun) r.sun.shadow.mapSize.set(4096, 4096);
      if (r.bloom) r.bloom.strength = 0.5;
      r.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    } else {
      r.renderer.shadowMap.enabled = true;
      if (r.sun) r.sun.castShadow = true;
      if (r.sun) r.sun.shadow.mapSize.set(2048, 2048);
      if (r.bloom) r.bloom.strength = 0.35;
      r.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    }
    r.renderer.setSize(innerWidth, innerHeight);
    if (r.composer) r.composer.setSize(innerWidth, innerHeight);
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
      ["Command-card grid", `${kc("Q")}${kc("W")}${kc("E")}${kc("R")}${kc("T")} ${kc("A")}${kc("S")}${kc("D")}${kc("F")} ${kc("Z")}${kc("X")}${kc("C")}`],
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
    const gasEl = document.getElementById("res-gas");
    if (gasEl) gasEl.textContent = this.sim.gas ? this.sim.gas[this.pid] : 0;
    this.$supply.textContent = `${s.used} / ${s.cap}`;
    this.$supply.classList.toggle("warn", s.used >= s.cap);

    // idle-worker button: visible only when someone is slacking
    const idle = this.sim.entities.filter((e) =>
      e.owner === this.pid && UNITS[e.type]?.isWorker && e.order.kind === "idle").length;
    this.$idle.classList.toggle("hidden", idle === 0);
    if (idle > 0) this.$idle.querySelector("b").textContent = idle;

    this.drawMinimap();
    this.refreshSelection();
    this.updateAbilityCooldowns();
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
      if (e.unit) { const st = this.abilityStatus(e); if (st) html += `<div class="sel-sub status ability">${st}</div>`; }
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
        // research items carry {research} instead of {type}; chip shows "R%".
        const total = item.research ? UPGRADES[item.research].time : UNITS[item.type].buildTime;
        const glyph = item.research ? "R" : UNITS[item.type].name.charAt(0);
        const attrs = `class="q-item${i === 0 ? " q-head" : ""}" data-cancel="${b.id}:${i}" title="Cancel (click)"`;
        if (i === 0) {
          const pct = (100 - (item.remaining / total) * 100) | 0;
          chips += `<span ${attrs}>${item.research ? "R" : ""}${pct}%</span>`;
        } else {
          chips += `<span ${attrs}>${glyph}</span>`;
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
    for (const chip of this.$selPanel.querySelectorAll(".q-item[data-cancel]")) {
      chip.addEventListener("pointerdown", (e) => e.stopPropagation());
      chip.addEventListener("click", () => {
        const [bid, idx] = chip.dataset.cancel.split(":").map(Number);
        this.game.issue({ t: "cancel", buildingId: bid, index: idx });
        this.audio.ack();
        this.refreshSelection();
      });
    }

    // ---- command card: grid hotkeys (QWER row, AS pinned for combat) ----
    const anyUnits = mine.some((e) => e.unit);
    // abilities available for the active subgroup (type matches + research owned)
    const abilList = this.abilitiesFor(mine);
    // ready-boolean per ability (some selected unit of that type off cooldown):
    // folded into the signature so the card re-renders when cd state flips.
    const readySig = abilList.map((ab) => this.abilityReady(mine, ab) ? 1 : 0).join("");
    const sig = `${types.join(",")}|${this.activeType}|${anyUnits}|${abilList.map((a) => a.key).join("")}|${readySig}`;
    if (sig === this.cardSig) return;
    this.cardSig = sig;

    const slots = [];
    if (UNITS[this.activeType]?.isWorker) {
      // the player's faction decides what its worker can build
      const fac = FACTIONS[this.sim.factions ? this.sim.factions[this.pid] : "cogs"] || FACTIONS.cogs;
      const order = fac.build;
      // builds fill the top row, overflowing onto z/x/c (a/s/d/f stay combat)
      const keys = ["q", "w", "e", "r", "t", "z", "x", "c"];
      order.forEach((b, i) => {
        const d = BUILDINGS[b];
        if (!d) return;
        const cost = d.gasCost ? `${d.cost}m ${d.gasCost}g` : `${d.cost}`;
        slots.push({ key: keys[i], cmd: `build-${b}`, label: d.name, sub: cost });
      });
    }
    const activeBuilding = mine.find((e) => e.type === this.activeType && e.building && e.done);
    if (activeBuilding) {
      const keys = ["q", "w", "e", "r"];
      const trains = BUILDINGS[activeBuilding.type].trains || [];
      trains.forEach((t, i) => {
        const d = UNITS[t];
        const cost = d.gasCost ? `${d.cost}m ${d.gasCost}g` : `${d.cost}`;
        slots.push({ key: keys[i], cmd: `train-${t}`, label: d.name, sub: `${cost} · ${d.supply} supply` });
      });
      // research buttons on R/T (slots after the train buttons), hidden once
      // owned. Only upgrades that research at THIS building type appear.
      const resKeys = ["r", "t"]; let ri = 0;
      for (const [upg, up] of Object.entries(UPGRADES)) {
        if (up.building !== activeBuilding.type) continue;
        if (this.sim.upgrades[this.pid] & up.bit) continue; // already owned
        if (ri >= resKeys.length) break;
        const queued = this.sim.upgradeQueued(this.pid, upg);
        const cost = up.gasCost ? `${up.cost}m ${up.gasCost}g` : `${up.cost}`;
        slots.push({
          key: resKeys[ri++], cmd: `research-${upg}`, label: up.name,
          sub: queued ? "Researching..." : cost, disabled: queued,
        });
      }
    }
    // ---- ability buttons on Z/X/C for the active unit subgroup ----
    for (const ab of abilList) {
      const ready = this.abilityReady(mine, ab);
      slots.push({
        key: ab.key, cmd: `ability-${ab.name}`, label: ABILITIES[ab.name].name,
        sub: ab.sub, cls: ready ? "" : "cooldown",
      });
    }
    // ---- morph buttons for Ooze units ----
    if (this.activeType === "nip") {
      const md = UNITS.maw;
      if (md) {
        const canAfford = this.sim.canAfford(this.pid, md.cost, md.gasCost || 0);
        slots.push({
          key: "x", cmd: "morph-nip-maw", label: "Morph to Maw",
          sub: md.gasCost ? `${md.cost}m ${md.gasCost}g` : `${md.cost}`,
          cls: canAfford ? "" : "cooldown",
        });
      }
    }
    if (anyUnits) {
      slots.push({ key: "a", cmd: "attack", label: "Attack-move", sub: "all units" });
      slots.push({ key: "s", cmd: "stop", label: "Stop", sub: "all units" });
      slots.push({ key: "d", cmd: "hold", label: "Hold Position", sub: "all units" });
      slots.push({ key: "f", cmd: "patrol", label: "Patrol", sub: "all units" });
    }

    // Physical key -> card grid cell (row, col). The card is keyboard-shaped:
    // a button always renders at the position of the key that triggers it.
    const GRID_POS = {
      q: [1, 1], w: [1, 2], e: [1, 3], r: [1, 4], t: [1, 5],
      a: [2, 1], s: [2, 2], d: [2, 3], f: [2, 4], g: [2, 5],
      z: [3, 1], x: [3, 2], c: [3, 3], v: [3, 4], b: [3, 5],
    };
    // Collapse EMPTY rows so the card is only as tall as it needs to be (a Hub
    // with just the worker button no longer reserves 3 rows and floats high).
    // Columns are preserved (keys still line up L-R); only the used rows are
    // remapped to consecutive positions, keeping physical top-to-bottom order.
    const usedRows = [...new Set(slots.map((s) => GRID_POS[s.key]?.[0]).filter(Boolean))].sort();
    const rowMap = {};
    usedRows.forEach((r, i) => { rowMap[r] = i + 1; });
    this.$cmdCard.style.gridTemplateRows = `repeat(${usedRows.length || 1}, 58px)`;

    this.hotkeys = {};
    let card = "";
    for (const s of slots) {
      this.hotkeys[s.key] = s.cmd;
      const cls = [s.cls, s.disabled ? "cooldown" : ""].filter(Boolean).join(" ");
      const pos = GRID_POS[s.key];
      const at = pos ? ` style="grid-row:${rowMap[pos[0]]};grid-column:${pos[1]}"` : "";
      // ability buttons get a cooldown sweep + countdown, updated each frame
      const cd = s.cmd.startsWith("ability-") ? `<i class="cd-fill"></i><b class="cd-num"></b>` : "";
      card += `<button data-cmd="${s.cmd}"${cls ? ` class="${cls}"` : ""}${at}><kbd>${s.key.toUpperCase()}</kbd><span>${s.label}</span><small>${s.sub}</small>${cd}</button>`;
    }
    this.$cmdCard.innerHTML = card;
    for (const b of this.$cmdCard.querySelectorAll("button")) {
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      b.addEventListener("click", () => this.command(b.dataset.cmd));
      b.addEventListener("pointerenter", () => this.showCmdTip(b));
      b.addEventListener("pointerleave", () => this.hideCmdTip());
    }
  }

  // Build the tooltip HTML for a command-card button from its data-cmd.
  cmdTipHTML(cmd) {
    const dash = cmd.indexOf("-");
    const verb = dash < 0 ? cmd : cmd.slice(0, dash);
    const key = dash < 0 ? null : cmd.slice(dash + 1);
    const wrap = (title, body, stats) =>
      `<b>${title}</b>${body ? `<p>${body}</p>` : ""}${stats ? `<small>${stats}</small>` : ""}`;
    const rangedFP = FP * 1.5;
    if ((verb === "train" || verb === "build") && key) {
      if (UNITS[key]) {
        const u = UNITS[key];
        const stats = `HP ${u.hp} · DMG ${u.dmg}${u.dmgAir ? ` (air ${u.dmgAir})` : ""}`
          + ` · ${u.range > rangedFP ? "Ranged" : "Melee"}${u.fly ? " · Flyer" : ""} · ${u.supply} supply`;
        return wrap(u.name, UNIT_DESC[key], stats);
      }
      if (BUILDINGS[key]) {
        const b = BUILDINGS[key];
        const tr = (b.trains || []).map((t) => UNITS[t].name).join(", ");
        const stats = `HP ${b.hp}${b.supply ? ` · +${b.supply} supply` : ""}${tr ? ` · Trains ${tr}` : ""}`;
        return wrap(b.name, BLDG_DESC[key], stats);
      }
    }
    if (verb === "research" && key && UPGRADES[key])
      return wrap(UPGRADES[key].name, UPG_DESC[key]);
    if (verb === "ability" && key && ABILITIES[key])
      return wrap(ABILITIES[key].name, ABIL_DESC[key], `Cooldown ${Math.round(ABILITIES[key].cd / 10)}s`);
    if (CMD_DESC[verb]) {
      const titles = { attack: "Attack-move", stop: "Stop", hold: "Hold Position", patrol: "Patrol" };
      return wrap(titles[verb] || verb, CMD_DESC[verb]);
    }
    return "";
  }

  showCmdTip(button) {
    const html = this.cmdTipHTML(button.dataset.cmd);
    if (!html) return;
    this.$cmdTip.innerHTML = html;
    this.$cmdTip.classList.remove("hidden");
    // position centered above the button, clamped to the viewport
    const r = button.getBoundingClientRect();
    const tw = this.$cmdTip.offsetWidth, th = this.$cmdTip.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, innerWidth - tw - 8));
    const top = Math.max(8, r.top - th - 10);
    this.$cmdTip.style.left = `${left}px`;
    this.$cmdTip.style.top = `${top}px`;
  }

  hideCmdTip() { this.$cmdTip.classList.add("hidden"); }

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

  // Ability/state status line for a single selected unit ("Sieged", etc.).
  abilityStatus(e) {
    const t = this.sim.tick;
    if (e.type === "tank" && t < e.transformUntil) return "Transforming";
    if (e.type === "tank" && e.sieged) return "Sieged";
    if (e.type === "marine" && t < e.stimUntil) return "Stimmed";
    if (e.type === "wraith" && t < e.burnUntil) return "Afterburners";
    if (e.type === "brute" && e.leapUntil) return "Leaping";
    if (e.type === "banshee" && e.channelUntil) return "Barraging";
    // Ooze states
    if (e.type === "sluice" && t < e.transformUntil) return "Burrowing";
    if (e.type === "sluice" && e.burrowed) return "Burrowed";
    if (e.type === "maw" && e.leapUntil) return "Engulfing";
    return "";
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

  // Which abilities are available for the active-type units in `mine`? Returns
  // [{name, key, sub, targeted}] on the Z/X/C grid (z = first ability of type).
  abilitiesFor(mine) {
    const type = this.activeType;
    if (!type) return [];
    const list = [];
    const keys = ["z", "x", "c"];
    for (const [name, a] of Object.entries(ABILITIES)) {
      if (a.unit !== type) continue;
      // research-gated abilities only show once the player owns the upgrade
      if (a.requires && !(this.sim.upgrades[this.pid] & UPGRADE_BITS[a.requires])) continue;
      const sub = a.toggle ? "toggle" : a.targeted ? "target" : "instant";
      list.push({ name, key: keys[list.length] || "z", sub, targeted: !!a.targeted });
      if (list.length >= keys.length) break;
    }
    return list;
  }

  // Per-frame: paint a shrinking cooldown sweep + seconds countdown on each
  // ability button so you can SEE when the ability comes back (the fastest-ready
  // unit of that type in the selection drives the display).
  updateAbilityCooldowns() {
    const btns = this.$cmdCard.querySelectorAll('button[data-cmd^="ability-"]');
    if (!btns.length) return;
    const mine = [...this.renderer.selection]
      .map((id) => this.sim.byId.get(id))
      .filter((e) => e && e.owner === this.pid && e.type === this.activeType);
    for (const b of btns) {
      const a = ABILITIES[b.dataset.cmd.slice(8)];
      if (!a) continue;
      let rem = Infinity;
      for (const e of mine) if (e.type === a.unit) rem = Math.min(rem, e.abilityCd | 0);
      if (!isFinite(rem)) rem = 0;
      const fill = b.querySelector(".cd-fill");
      const num = b.querySelector(".cd-num");
      if (rem > 0) {
        b.classList.add("cooldown");
        if (fill) fill.style.height = `${Math.max(0, Math.min(1, rem / (a.cd || 1))) * 100}%`;
        if (num) num.textContent = Math.ceil(rem / 10);   // 10 sim ticks per second
      } else {
        b.classList.remove("cooldown");
        if (fill) fill.style.height = "0%";
        if (num) num.textContent = "";
      }
    }
  }

  // True if any selected unit of the ability's type is off cooldown (so the
  // button is active). Used to toggle the `cooldown` CSS class.
  abilityReady(mine, ab) {
    const a = ABILITIES[ab.name];
    return mine.some((e) => e.type === a.unit && e.abilityCd === 0 &&
      !(e.type === "tank" && this.sim.tick < e.transformUntil) &&
      !(e.type === "sluice" && this.sim.tick < e.transformUntil) &&
      !e.leapUntil && !e.channelUntil);
  }

  command(cmd) {
    if (cmd.startsWith("build-")) {
      const b = BUILDINGS[cmd.slice(6)];
      if (b?.requires && !this.sim.hasBuilding(this.pid, b.requires)) {
        this.audio.error();
        return this.toast(`Requires ${BUILDINGS[b.requires].name}`);
      }
      if (b && !this.sim.canAfford(this.pid, b.cost, b.gasCost || 0)) {
        this.audio.error();
        return this.toast(b.gasCost && this.sim.gas[this.pid] < b.gasCost ? "Not enough oil" : "Not enough scrap");
      }
      this.input?.startPlacing(cmd.slice(6));
    }
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
      if (!this.sim.canAfford(this.pid, d.cost, d.gasCost || 0)) {
        this.audio.error();
        return this.toast(d.gasCost && this.sim.gas[this.pid] < d.gasCost ? "Not enough oil" : "Not enough scrap");
      }
      // supply is claimed when production starts, so queuing is allowed —
      // just warn that the queue will stall until a depot finishes
      if (s.used + d.supply > s.cap) this.toastInfo("Queued - waiting on supply");
      this.game.issue({ t: "train", buildingId: candidates[0].id, unit: t });
      this.recentTrains.push({ bid: candidates[0].id, until: now + 600 });
      this.audio.trained();
    } else if (cmd.startsWith("research-")) {
      this.doResearch(cmd.slice(9));
    } else if (cmd.startsWith("ability-")) {
      this.doAbility(cmd.slice(8));
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
    } else if (cmd === "morph-nip-maw") {
      const md = UNITS.maw;
      if (!md) return;
      if (!this.sim.canAfford(this.pid, md.cost, md.gasCost || 0)) {
        this.audio.error();
        return this.toast("Not enough resources to morph");
      }
      const ids = this.input?.mySelectedUnitIds()?.filter(id => {
        const e = this.sim.byId.get(id);
        return e && e.owner === this.pid && e.type === "nip";
      }) || [];
      if (!ids.length) return;
      this.game.issue({ t: "ooze_morph", ids: [ids[0]], fromType: "nip", targetType: "maw" });
      this.audio.ack();
    }
  }

  // Queue an upgrade at a selected finished building of the right type.
  doResearch(upg) {
    const up = UPGRADES[upg];
    if (!up) return;
    if (this.sim.upgrades[this.pid] & up.bit) return; // owned
    if (this.sim.upgradeQueued(this.pid, upg)) { this.audio.error(); return this.toast("Already researching"); }
    if (!this.sim.canAfford(this.pid, up.cost, up.gasCost || 0)) {
      this.audio.error();
      return this.toast(up.gasCost && this.sim.gas[this.pid] < up.gasCost ? "Not enough oil" : "Not enough scrap");
    }
    // pick the selected building of the matching type with the shortest queue
    const b = this.mineOfType(up.building).filter((e) => e.building && e.done && e.queue.length < MAX_QUEUE)
      .sort((a, c) => a.queue.length - c.queue.length || a.id - c.id)[0];
    if (!b) { this.audio.error(); return this.toast("Production queue full"); }
    this.game.issue({ t: "research", buildingId: b.id, research: upg });
    this.audio.trained();
    this.cardSig = ""; // re-render to show "Researching..."
  }

  // Issue an ability for all valid selected units of its type. Targeted
  // abilities enter target mode instead of firing immediately.
  doAbility(name) {
    const a = ABILITIES[name];
    if (!a) return;
    const ids = this.mineOfType(a.unit)
      .filter((e) => e.abilityCd === 0 &&
        !(e.type === "tank" && this.sim.tick < e.transformUntil) &&
        !e.leapUntil && !e.channelUntil)
      .map((e) => e.id);
    if (!ids.length) { this.audio.error(); return; }
    if (a.targeted) {
      this.input?.setTargetMode({ ability: name, ids });
    } else {
      this.game.issue({ t: "ability", ids, ability: name });
      this.abilitySound(name);
      this.cardSig = ""; // reflect the fresh cooldown on the card
    }
  }

  // small per-ability audio cue on issue
  abilitySound(name) {
    if (name === "stim") this.audio.stim?.();
    else if (name === "burners") this.audio.burners?.();
    else if (name === "leap") this.audio.leap?.();
    else if (name === "barrage") this.audio.barrage?.();
    else if (name === "siege") this.audio.siegeUp?.(); // toggle: up/down sound also on event
  }

  // selected own entities of a given type
  mineOfType(type) {
    return [...this.renderer.selection]
      .map((id) => this.sim.byId.get(id))
      .filter((e) => e && e.owner === this.pid && e.type === type);
  }

  // ---------- minimap ----------

  // Theme-derived minimap palette (matches the bright battlefield instead of
  // the old hardcoded near-black). Ground gets one tone per elevation level so
  // height reads at a glance; explored-but-hidden is dimmed+cooled; unexplored
  // is a soft haze derived from the theme fog (same language as the 3D view).
  buildMinimapPalette() {
    const th = THEMES[this.sim.map.theme || 0] || THEMES[0];
    const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const lift = (c, k) => c.map((v) => Math.min(255, v + (255 - v) * k));
    const css = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
    // explored-but-hidden: dimmed 62% and pulled toward a cool slate
    const dimmed = (c) => css(mix(c, [58, 72, 94], 0.42).map((v) => v * 0.9));
    this.mmGround = [];                              // [lvl] -> [explored, visible]
    for (let lvl = 0; lvl <= 3; lvl++) {
      const tone = lift(mix(th.ground, th.groundHi, Math.min(1, lvl / 3)), lvl * 0.10);
      this.mmGround.push([dimmed(tone), css(tone)]);
    }
    const rockC = [(th.rock >> 16) & 255, (th.rock >> 8) & 255, th.rock & 255];
    this.mmRock = [dimmed(rockC), css(rockC)];
    const fogC = [(th.fog >> 16) & 255, (th.fog >> 8) & 255, th.fog & 255];
    this.mmUnexplored = css(fogC.map((v) => v * 0.82)); // soft haze, below visible-tone brightness
  }

  drawMinimap() {
    const { w, h, rock, height } = this.sim.map;
    const S = this.minimap.width / w;
    const ctx = this.mmCtx;
    const fog = this.sim.fog[this.pid];
    ctx.fillStyle = this.mmUnexplored;
    ctx.fillRect(0, 0, this.minimap.width, this.minimap.height);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const f = fog[i];
        if (f === 0) continue;
        const vis = f === 2 ? 1 : 0;
        ctx.fillStyle = rock[i]
          ? this.mmRock[vis]
          : this.mmGround[height ? Math.min(3, height[i]) : 0][vis];
        ctx.fillRect(x * S, y * S, S + 0.5, S + 0.5);
        // creep coverage at a glance (visible tiles only, same policy as
        // the world overlay — hidden goo doesn't leak)
        if (vis && this.sim.gooGrid && this.sim.gooGrid[i]) {
          ctx.fillStyle = "rgba(90,200,60,0.55)";
          ctx.fillRect(x * S, y * S, S + 0.5, S + 0.5);
        }
      }
    }
    for (const e of this.sim.entities) {
      const tx = fpToTile(e.x), ty = fpToTile(e.y);
      const f = fog[ty * w + tx];
      if (e.type === "mineral") {
        if (f >= 1) { ctx.fillStyle = "#0e9c8d"; ctx.fillRect(tx * S, ty * S, S, S); }
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

    // camera target (dark ink — white was invisible on the bright minimap)
    const cam = this.renderer.camera;
    ctx.strokeStyle = "rgba(20,30,42,0.85)";
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
    const cam = this.renderer.camera;
    const d = Math.hypot(cam.tx - txFp / 256, cam.tz - tyFp / 256);
    if (d > 16) {
      this.audio.underAttack();
      const now = performance.now();
      if (!this._lastAttackAlert || now - this._lastAttackAlert > 5000) {
        this._lastAttackAlert = now;
        this.toastInfo("⚠ Under attack!", true);
      }
    }
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
    this.renderer.orderPing(wx, wy, "#0b3d20");
  }

  // ---------- feedback ----------

  toast(msg) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    this.$toasts.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  toastInfo(msg, warning) {
    const el = document.createElement("div");
    el.className = "toast info" + (warning ? " toast-warn" : "");
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
