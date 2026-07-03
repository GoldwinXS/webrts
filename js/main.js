// Boot: menu -> Game (vs AI, host, or join) -> loop.
import { Game } from "./game.js";
import { Renderer } from "./render/renderer.js";
import { Input } from "./ui/input.js";
import { Hud } from "./ui/hud.js";
import { Net, makeCode } from "./net/net.js";
import { GameAudio } from "./audio.js";
import { rebind } from "./ui/keys.js";
import { TICK_MS } from "./core/data.js";

const audio = new GameAudio();
document.addEventListener("pointerdown", () => audio.init(), { once: true });
document.addEventListener("keydown", () => audio.init(), { once: true });

const $ = (id) => document.getElementById(id);
const menu = $("menu");
const menuMsg = $("menu-msg");
let net = null;

function say(msg, isError) {
  menuMsg.textContent = msg;
  menuMsg.classList.toggle("error", !!isError);
}

// ---------- map options (segmented glass selectors) ----------
// Each group's selected data-val is stored as a string; "random" means the map
// generator resolves it from the rng, so we OMIT the key entirely for random.
const MAPOPT_KEY = "webrts-mapopts";
const optGroups = ["spawns", "expansions", "theme"];

function selectedVal(group) {
  const active = document.querySelector(`#opt-${group} .seg-btn.is-active`);
  return active ? active.dataset.val : "random";
}

// Build the opts object passed to generateMap. Random => key ABSENT (theme
// "random" omitted too). {} means "all random" = old default behavior.
function readMapOpts() {
  const opts = {};
  const spawns = selectedVal("spawns");
  if (spawns !== "random") opts.spawns = spawns;            // "cross" | "close"
  const expansions = selectedVal("expansions");
  if (expansions !== "random") opts.expansions = parseInt(expansions, 10); // 0|1|2
  const theme = selectedVal("theme");
  if (theme !== "random") opts.theme = parseInt(theme, 10); // 0|1|2
  return opts;
}

function saveMapOpts() {
  const sel = {};
  for (const g of optGroups) sel[g] = selectedVal(g);
  try { localStorage.setItem(MAPOPT_KEY, JSON.stringify(sel)); } catch {}
}

function loadMapOpts() {
  let sel;
  try { sel = JSON.parse(localStorage.getItem(MAPOPT_KEY) || "null"); } catch { sel = null; }
  if (!sel) return;
  for (const g of optGroups) {
    if (!sel[g]) continue;
    const btns = document.querySelectorAll(`#opt-${g} .seg-btn`);
    let matched = null;
    btns.forEach((b) => { if (b.dataset.val === sel[g]) matched = b; });
    if (matched) btns.forEach((b) => b.classList.toggle("is-active", b === matched));
  }
}

// Wire up segmented buttons: click selects (one active per group) + persists.
for (const g of optGroups) {
  const groupEl = document.getElementById(`opt-${g}`);
  if (!groupEl) continue;
  groupEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    groupEl.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    saveMapOpts();
  });
}
loadMapOpts();

const THEME_NAMES = ["verdant", "ashen", "frozen"];

// Subtle status line after game start: resolved theme + spawn style.
function showMapStatus(hud, sim, opts) {
  const themeName = sim.map.themeName || THEME_NAMES[sim.map.theme] || "?";
  const spawnStyle = opts && opts.spawns ? opts.spawns : "random";
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  hud?.toastInfo?.(`Map: ${cap(themeName)} - ${cap(spawnStyle)} spawns`);
}

function startGame(mode, seed, netConn, opts) {
  menu.classList.add("hidden");
  const game = new Game(mode, seed, netConn, opts);
  const renderer = new Renderer($("game"), game.sim, game.localPlayer);
  const hud = new Hud(game, renderer, audio);
  const input = new Input(game, renderer, hud, audio);
  hud.input = input;

  game.onEvents = (events) => {
    renderer.consumeEvents(events);
    for (const ev of events) {
      switch (ev.t) {
        case "shot":
          if (ev.tOwner === game.localPlayer) hud.notifyAttack(ev.tx, ev.ty);
          if (renderer.entityVisible({ owner: ev.owner, x: ev.fx, y: ev.fy, unit: true })) {
            if (ev.ranged) audio.shot(); else audio.melee();
          }
          break;
        case "death":
          if (renderer.entityVisible({ owner: ev.owner, x: ev.x, y: ev.y, unit: !ev.building, building: ev.building })) {
            if (ev.building) audio.buildingDeath(); else audio.unitDeath();
          }
          break;
        case "complete":
          if (ev.owner === game.localPlayer) { hud.toastInfo("Construction complete"); audio.complete(); }
          break;
        case "trained":
          if (ev.owner === game.localPlayer) audio.trained();
          break;
        case "gameover":
          hud.gameOver(ev.winner);
          if (ev.winner === game.localPlayer) audio.victory(); else audio.defeat();
          break;
      }
    }
  };
  game.onStall = (stalled) => hud.setStatus(stalled ? "Waiting for opponent..." : "");
  game.onDesync = () => hud.setStatus("DESYNC DETECTED - game state has diverged");
  if (netConn) {
    netConn.onClose = () => hud.setStatus("Opponent disconnected");
  }

  let hudTimer = 0;
  function frame(now) {
    const alpha = game.update(now);
    input.update(1 / 60);
    renderer.render(Math.min(1, alpha));
    if (now - hudTimer > 100) { hud.update(); hudTimer = now; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // rAF is suspended in hidden tabs; keep the sim ticking so an alt-tabbed
  // player doesn't stall a lockstep match (or pause their AI game).
  setInterval(() => {
    if (document.visibilityState === "hidden") game.update(performance.now());
  }, TICK_MS);

  // debug / verification handle (+ console keybinding: RTS.rebind("idleWorker", ["f1","u"]))
  window.RTS = {
    game, sim: game.sim, renderer, input, hud, rebind,
    step(n = 1) { for (let i = 0; i < n; i++) game.tryStep(); },
  };

  showMapStatus(hud, game.sim, opts);
}

// ---------- menu wiring ----------

$("btn-skirmish").addEventListener("click", () => {
  startGame("ai", (Math.random() * 0x7fffffff) | 0, null, readMapOpts());
});

$("btn-host").addEventListener("click", async () => {
  if (typeof Peer === "undefined") return say("PeerJS failed to load - check your connection", true);
  const code = makeCode();
  say(`Creating match...`);
  net = new Net();
  try {
    await net.host(code);
  } catch (err) {
    return say(`Could not reach matchmaking broker (${err.type || err})`, true);
  }
  say(`Match code: ${code} - waiting for opponent...`);
  $("code-display").textContent = code;
  $("code-display").classList.remove("hidden");
  net.onOpen = () => {
    // host picks the seed AND the map options; both sides start identically.
    const seed = (Math.random() * 0x7fffffff) | 0;
    const opts = readMapOpts();
    net.send({ k: "start", seed, opts });
    startGame("host", seed, net, opts);
  };
});

$("btn-join").addEventListener("click", async () => {
  if (typeof Peer === "undefined") return say("PeerJS failed to load - check your connection", true);
  const code = $("join-code").value.trim().toUpperCase();
  if (code.length < 4) return say("Enter the 5-letter match code", true);
  say("Connecting...");
  net = new Net();
  try {
    await net.join(code);
  } catch (err) {
    return say(`Could not connect (${err.type || err})`, true);
  }
  net.onMessage = (msg) => {
    // the join flow ignores local options; use exactly what the host sent so
    // both sides construct an identical map (lockstep requirement).
    if (msg.k === "start") startGame("client", msg.seed, net, msg.opts || {});
  };
  net.onOpen = () => say("Connected - starting...");
  net.onClose = () => say("Connection failed or host left", true);
  setTimeout(() => {
    if (!window.RTS) say("No response from host - check the code", true);
  }, 8000);
});

$("btn-again")?.addEventListener("click", () => location.reload());
