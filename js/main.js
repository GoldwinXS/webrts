// Boot: menu -> Game (vs AI, host, or join) -> loop.
import * as THREE from "three";
import { Game } from "./game.js";
import { Renderer } from "./render/renderer.js";
import { Input } from "./ui/input.js";
import { Hud } from "./ui/hud.js";
import { Net, makeCode } from "./net/net.js";
import { GameAudio } from "./audio.js";
import { rebind } from "./ui/keys.js";
import { TICK_MS, UNITS, BUILDINGS } from "./core/data.js";
import { FP, HALF, tileToFp } from "./core/fixed.js";

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

// ---------- dev gallery / showcase ----------

// Flatten the map to a clean lowland stage, wipe the default start entities,
// reveal all fog, and disable the AI. Must run before the Renderer is built
// so its height grid comes out flat.
function prepShowcase(game) {
  const sim = game.sim, m = sim.map;
  m.height.fill(0);
  m.rock.fill(0);
  m.rampTiles?.fill(0);
  m.barrierKind?.fill(0);
  m.losBlock?.fill(0);
  m.decos && (m.decos.length = 0);
  sim.blocked.fill(0);
  sim.entities.length = 0;
  sim.byId.clear();
  sim.nextId = 1;
  sim.fog[0].fill(2);
  sim.fog[1].fill(2);
  game.ai = null;                 // nothing plays player 1
  sim.noGameOver = true;          // player 1 has no buildings; don't declare a winner
  sim.minerals = [99999, 99999];  // so you can freely train from the gallery
  sim.gas = [99999, 99999];
}

// Lay out one of every unit and building (both team colours), with floating
// name labels, and frame the camera on the collection.
function buildShowcase(game, renderer) {
  const sim = game.sim;
  const cx = sim.map.w >> 1, cz = sim.map.h >> 1;
  const label = (text, wx, wz, y, color) => makeLabel(renderer.scene, text, wx, wz, y, color);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // buildings row (player 0)
  const buildings = ["hq", "depot", "barracks", "factory", "starport", "turret", "refinery"];
  const bz = cz - 8;
  buildings.forEach((type, i) => {
    const bx = cx - 18 + i * 6;
    const d = BUILDINGS[type];
    const off = d.size >> 1;
    if (type === "refinery") {
      // refineries render on a geyser — give it one to sit on
      const gey = sim.addEntity({ type: "geyser", owner: -1, x: tileToFp(bx), y: tileToFp(bz), hp: 0, maxHp: 0, amount: 2500, radius: (FP * 0.45) | 0, geyser: true });
      const b = sim.spawnBuilding(0, type, bx - off, bz - off, true);
      b.geyserId = gey.id;
    } else {
      sim.spawnBuilding(0, type, bx - off, bz - off, true);
    }
    label(cap(d.name), bx, bz, 3.2, "#cfe8ff");
  });

  // unit rows: player 0 (your colour) and player 1 (enemy colour), far enough
  // apart that idle auto-acquire never triggers (no combat in the gallery)
  const units = ["worker", "marine", "brute", "tank", "wraith", "banshee"];
  const rowFor = (pid, uz, tint) => units.forEach((type, i) => {
    const ux = cx - 15 + i * 6;
    sim.spawnUnit(pid, type, tileToFp(ux), tileToFp(uz));
    if (pid === 0) label(cap(UNITS[type].name), ux, uz, 2.4, tint);
  });
  label("YOUR FORCES", cx, cz - 3.2, 2.2, "#8fd0ff");
  rowFor(0, cz, "#cfe8ff");
  label("ENEMY COLOURS", cx, cz + 11, 2.2, "#ff9f94");
  rowFor(1, cz + 14, "#ffd0c8");

  // a resource pair to inspect
  sim.addEntity({ type: "mineral", owner: -1, x: tileToFp(cx - 3), y: tileToFp(cz + 5), hp: 0, maxHp: 0, amount: 1500, radius: (FP * 0.4) | 0 });
  sim.addEntity({ type: "geyser", owner: -1, x: tileToFp(cx + 3), y: tileToFp(cz + 5), hp: 0, maxHp: 0, amount: 2500, radius: (FP * 0.45) | 0, geyser: true });
  label("Minerals", cx - 3, cz + 5, 1.6, "#8fe3d8");
  label("Vespene", cx + 3, cz + 5, 1.6, "#a7e87c");

  // frame the camera on the whole collection
  const cam = renderer.camera;
  cam.tx = cx; cam.tz = cz + 2;
  cam.dist = 46; cam.targetDist = 46;
  cam.yaw = 0;
  cam.clamp(); cam.updateTransform();
}

// A floating text label as a camera-facing sprite (canvas texture).
function makeLabel(scene, text, wx, wz, y, color = "#e6edf3") {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const ctx = c.getContext("2d");
  ctx.font = "600 30px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const tw = ctx.measureText(text).width + 28;
  ctx.fillStyle = "rgba(8,12,18,0.72)";
  const x0 = 128 - tw / 2;
  ctx.beginPath(); ctx.roundRect(x0, 14, tw, 36, 8); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  spr.scale.set(4, 1, 1);
  spr.position.set(wx, y, wz);
  spr.renderOrder = 6;
  scene.add(spr);
  return spr;
}

function startGame(mode, seed, netConn, opts, showcase) {
  menu.classList.add("hidden");
  const game = new Game(mode, seed, netConn, opts);
  if (showcase) prepShowcase(game);
  const renderer = new Renderer($("game"), game.sim, game.localPlayer);
  if (showcase) buildShowcase(game, renderer);
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
    saveReplay: () => game.exportReplay(),
  };

  if (showcase) hud?.toastInfo?.("Dev Gallery - drag-select and right-click to move units. Reload to exit.");
  else showMapStatus(hud, game.sim, opts);
}

// ---------- menu wiring ----------

$("btn-skirmish").addEventListener("click", () => {
  startGame("ai", (Math.random() * 0x7fffffff) | 0, null, readMapOpts());
});

$("btn-showcase").addEventListener("click", () => {
  // seed/opts irrelevant — the map gets flattened into a clean stage
  startGame("ai", 12345, null, {}, true);
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
$("btn-replay")?.addEventListener("click", () => {
  try { window.RTS?.saveReplay?.(); } catch (e) { console.error("Replay save failed:", e); }
});
