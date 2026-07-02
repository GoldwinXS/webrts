// DOM HUD: resource bar, selection panel, command card, minimap, toasts.
import { FP, fpToTile } from "../core/fixed.js";
import { UNITS, BUILDINGS, PLAYER_COLORS } from "../core/data.js";

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
    this.minimap.addEventListener("pointerdown", (e) => this.minimapClick(e));
    this.minimap.addEventListener("pointermove", (e) => { if (e.buttons & 1) this.minimapClick(e); });

    // mute toggle
    this.$mute = document.getElementById("btn-mute");
    this.updateMuteIcon();
    this.$mute.addEventListener("click", () => {
      this.audio.setMuted(!this.audio.muted);
      this.updateMuteIcon();
    });

    document.getElementById("hud").classList.remove("hidden");
  }

  updateMuteIcon() {
    this.$mute.classList.toggle("muted", this.audio.muted);
    this.$mute.title = this.audio.muted ? "Unmute" : "Mute";
  }

  // ---------- per-frame ----------

  update() {
    const s = this.sim.supplyOf(this.pid);
    this.$minerals.textContent = this.sim.minerals[this.pid];
    this.$supply.textContent = `${s.used} / ${s.cap}`;
    this.$supply.classList.toggle("warn", s.used >= s.cap);
    this.drawMinimap();
    this.refreshSelection();
  }

  // ---------- selection panel + command card ----------

  refreshSelection() {
    const sel = [...this.renderer.selection]
      .map((id) => this.sim.byId.get(id))
      .filter(Boolean);
    const mine = sel.filter((e) => e.owner === this.pid);

    // summary
    if (!sel.length) {
      this.$selPanel.innerHTML = "";
      this.$cmdCard.innerHTML = "";
      this.cardSig = "";
      return;
    }
    const counts = {};
    for (const e of sel) counts[e.type] = (counts[e.type] || 0) + 1;
    let html = "";
    for (const [type, n] of Object.entries(counts)) {
      const name = UNITS[type]?.name || BUILDINGS[type]?.name || "Minerals";
      html += `<div class="sel-row"><span>${name}</span><b>${n > 1 ? "x" + n : ""}</b></div>`;
    }
    if (sel.length === 1) {
      const e = sel[0];
      if (e.type === "mineral") html += `<div class="sel-sub">${e.amount} remaining</div>`;
      else html += `<div class="sel-sub">${Math.max(0, e.hp | 0)} / ${e.maxHp} HP</div>`;
      if (e.building && !e.done) {
        const pct = ((e.progress / BUILDINGS[e.type].buildTime) * 100) | 0;
        html += `<div class="sel-sub">Constructing ${pct}%</div>`;
      }
      if (e.building && e.queue?.length) {
        const q = e.queue[0];
        const pct = (100 - (q.remaining / UNITS[q.type].buildTime) * 100) | 0;
        html += `<div class="sel-sub">Training ${UNITS[q.type].name} ${pct}% (queue ${e.queue.length})</div>`;
      }
    }
    this.$selPanel.innerHTML = html;

    // command card: rebuild only when the *structure* changes, so buttons
    // keep hover/focus state between the 100ms HUD refreshes
    const workers = mine.filter((e) => e.type === "worker");
    const combat = mine.filter((e) => e.unit);
    const building = mine.find((e) => e.building && e.done);
    const sig = `${workers.length > 0}|${combat.length > 0}|${building ? building.id : 0}`;
    if (sig === this.cardSig) return;
    this.cardSig = sig;

    let card = "";
    if (workers.length) {
      for (const [key, d] of Object.entries(BUILDINGS)) {
        card += this.btn(`build-${key}`, `${d.name}`, `${d.cost}`);
      }
    }
    if (building) {
      for (const t of BUILDINGS[building.type].trains || []) {
        const d = UNITS[t];
        card += this.btn(`train-${t}`, `${d.name}`, `${d.cost} · ${d.supply} supply`);
      }
    }
    if (combat.length) {
      card += this.btn("attack", "Attack-move", "A");
      card += this.btn("stop", "Stop", "S");
    }
    this.$cmdCard.innerHTML = card;
    for (const b of this.$cmdCard.querySelectorAll("button")) {
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      b.addEventListener("click", () => this.command(b.dataset.cmd, building));
    }
  }

  btn(cmd, label, sub) {
    return `<button data-cmd="${cmd}"><span>${label}</span><small>${sub}</small></button>`;
  }

  command(cmd, building) {
    if (cmd.startsWith("build-")) this.input?.startPlacing(cmd.slice(6));
    else if (cmd.startsWith("train-") && building) {
      const t = cmd.slice(6);
      const d = UNITS[t];
      const s = this.sim.supplyOf(this.pid);
      if (!this.sim.canAfford(this.pid, d.cost)) { this.audio.error(); return this.toast("Not enough minerals"); }
      if (s.used + d.supply > s.cap) { this.audio.error(); return this.toast("Need more supply - build a Supply Depot"); }
      this.game.issue({ t: "train", buildingId: building.id, unit: t });
      this.audio.trained();
    } else if (cmd === "attack") this.input?.setAttackMode(true);
    else if (cmd === "stop") {
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
      if (e.owner === this.pid || f === 2 || (e.building && f >= 1)) {
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
