// Boot: menu -> Game (vs AI, host, or join) -> loop.
import * as THREE from "three";
import { Game } from "./game.js";
import { Renderer } from "./render/renderer.js";
import { Input } from "./ui/input.js";
import { Hud } from "./ui/hud.js";
import { Net, makeCode } from "./net/net.js";
import { Lobby } from "./net/lobby.js";
import { GameAudio } from "./audio.js";
import { rebind } from "./ui/keys.js";
import { TICK_MS, UNITS, BUILDINGS, FACTIONS } from "./core/data.js";
import { FP, HALF, tileToFp } from "./core/fixed.js";
import { CampaignRunner, mountCampaign, buildCustomMapFor } from "./campaign/campaign.js";

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
const optGroups = ["spawns", "expansions", "theme", "faction", "aifaction", "aidifficulty"];

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
  // factions: [localPlayer(0), enemy(1)]. Ignored by generateMap, read by Sim.
  opts.factions = [selectedVal("faction") || "cogs", selectedVal("aifaction") || "cogs"];
  // AI difficulty is a LOCAL-ONLY skirmish setting (Easy/Normal/Hard). It's
  // read by Game -> AI in mode "ai" only; the host flow strips it before
  // sending over the wire (see btn-host) since the client runs no AI.
  opts.aidifficulty = selectedVal("aidifficulty") || "normal";
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

  // roster derives from the SELECTED faction (Cogs or Ooze), so the gallery
  // showcases whichever faction you picked in the menu.
  const fac = (sim.factions && sim.factions[0]) || "cogs";
  // buildings row (player 0) — every constructable building of this faction
  const buildings = FACTIONS[fac].build;
  const bz = cz - 8;
  buildings.forEach((type, i) => {
    const bx = cx - Math.floor(buildings.length / 2) * 6 + i * 6;
    const d = BUILDINGS[type];
    const off = d.size >> 1;
    if (d.onGeyser) {
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
  const units = Object.keys(UNITS).filter((k) => UNITS[k].faction === fac);
  const rowFor = (pid, uz, tint) => units.forEach((type, i) => {
    const ux = cx - Math.floor(units.length / 2) * 6 + i * 6;
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
  label("Scrap", cx - 3, cz + 5, 1.6, "#8fe3d8");
  label("Oil", cx + 3, cz + 5, 1.6, "#a7e87c");

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

function startGame(mode, seed, netConn, opts, showcase, campaignMission) {
  menu.classList.add("hidden");
  document.getElementById("campaign-select")?.classList.add("hidden");
  const game = new Game(mode, seed, netConn, opts);
  if (showcase) prepShowcase(game);
  // Campaign: run the mission's setup BEFORE the Renderer is built (so its
  // height grid / entity meshes reflect the scripted state), exactly like
  // prepShowcase. runSetup returns mission scratch state carried into the runner.
  let campaignState = null;
  if (campaignMission) campaignState = CampaignRunner.runSetup(campaignMission, game);
  const renderer = new Renderer($("game"), game.sim, game.localPlayer);
  if (showcase) buildShowcase(game, renderer);
  const hud = new Hud(game, renderer, audio);
  const input = new Input(game, renderer, hud, audio);
  hud.input = input;
  // debug/verification handle (read-only use only — the sim is lockstep)
  window.webrts = { game, renderer, hud, input };

  // Campaign runner: constructed after the Renderer/HUD exist so it can drive
  // the dialogue bar, objective tracker, and end panel. Its update() is called
  // each frame below. Only ever set for campaign missions — skirmish/MP is
  // completely unaffected.
  let campaign = null;
  if (campaignMission) {
    // ai:false missions are pure scripted-spawn levels — strip the AI brain so
    // player 1 does nothing on its own (the runner spawns waves via triggers).
    if (campaignMission.ai === false) game.ai = null;
    campaign = new CampaignRunner(campaignMission, { game, renderer, hud, audio }, campaignState);
    window.webrts && (window.webrts.campaign = campaign); // debug/verification handle
  }

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
  let camPrevAlpha = 0;
  function frame(now) {
    // Campaign cinematics PAUSE the sim: when the runner reports blocksSim(),
    // skip game.update() this frame (no ticks advance) but keep rendering +
    // driving the campaign layer so the scene plays. alpha holds so interpolation
    // freezes cleanly. Skirmish/MP never sets `campaign`, so this is a no-op there.
    let alpha;
    if (campaign && campaign.blocksSim()) {
      alpha = camPrevAlpha;
    } else {
      alpha = game.update(now);
      camPrevAlpha = alpha;
    }
    input.update(1 / 60);
    // campaign layer: evaluate triggers/objectives/win-lose off the live sim
    // (after the sim has stepped this frame). Cheap; only runs in campaign.
    if (campaign) campaign.update();
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
  // seed/opts irrelevant — the map gets flattened into a clean stage. Pass the
  // picked faction so the gallery showcases Cogs OR Ooze.
  const fac = selectedVal("faction") || "cogs";
  startGame("ai", 12345, null, { factions: [fac, fac] }, true);
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
  // Also advertise this open game in the serverless lobby (if the player left
  // "List publicly" checked). The lobby only DISCOVERS the code — the match
  // connection itself is exactly the same as a manual host.
  postCurrentGame(code);
  net.onOpen = () => {
    // host picks the seed AND the map options; both sides start identically.
    const seed = (Math.random() * 0x7fffffff) | 0;
    const opts = readMapOpts();
    // aidifficulty is a local-only skirmish knob and there's no AI in a
    // networked match — strip it from the wire message (only map-affecting opts
    // need to cross for lockstep determinism).
    const { aidifficulty, ...netOpts } = opts;
    net.send({ k: "start", seed, opts: netOpts });
    tearDownLobby();          // match starting: unpost + free the lobby id
    startGame("host", seed, net, opts);
  };
});

// The shared join-by-code path. Both the manual "Join" button and clicking a
// lobby room row funnel through here, so the match connection / lockstep is
// identical regardless of how the code was discovered.
async function joinByCode(code) {
  if (typeof Peer === "undefined") return say("PeerJS failed to load - check your connection", true);
  code = (code || "").trim().toUpperCase();
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
    if (msg.k === "start") { tearDownLobby(); startGame("client", msg.seed, net, msg.opts || {}); }
  };
  net.onOpen = () => say("Connected - starting...");
  net.onClose = () => say("Connection failed or host left", true);
  setTimeout(() => {
    if (!window.RTS) say("No response from host - check the code", true);
  }, 8000);
}

$("btn-join").addEventListener("click", () => joinByCode($("join-code").value));

// ---------- serverless lobby wiring ----------
// A second, independent Peer instance (see lobby.js) discovers open matches
// over the PeerJS broker. It NEVER touches the match Net class, so any lobby
// failure leaves manual codes fully working.
const LIST_PUBLIC_KEY = "webrts-list-public";
const listPublicEl = $("list-public");
if (listPublicEl) {
  try {
    const saved = localStorage.getItem(LIST_PUBLIC_KEY);
    if (saved !== null) listPublicEl.checked = saved === "1";
  } catch {}
  listPublicEl.addEventListener("change", () => {
    try { localStorage.setItem(LIST_PUBLIC_KEY, listPublicEl.checked ? "1" : "0"); } catch {}
  });
}

let lobby = null;
let latestRooms = [];

function esc(s) {
  // DOM-safe: room names are untrusted free text. We only ever set them via
  // textContent (below) so this is belt-and-suspenders; never innerHTML a name.
  return String(s == null ? "" : s);
}

function ageText(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  return m + (m === 1 ? " min ago" : " min ago");
}

function renderRooms() {
  const box = $("lobby-rooms");
  if (!box) return;
  box.textContent = "";
  if (!latestRooms.length) {
    const empty = document.createElement("div");
    empty.className = "lobby-empty";
    empty.textContent = lobby && lobby.role === "offline"
      ? "Lobby unavailable - you can still create or join by code."
      : "No open matches right now. Create one, or join by code.";
    box.appendChild(empty);
    return;
  }
  for (const r of latestRooms) {
    const row = document.createElement("div");
    row.className = "lobby-room";
    const body = document.createElement("div");
    body.className = "lobby-room-body";
    const name = document.createElement("div");
    name.className = "lobby-room-name";
    name.textContent = esc(r.name);                 // textContent => no HTML injection
    const sub = document.createElement("div");
    sub.className = "lobby-room-sub";
    const bits = [];
    if (r.map) bits.push(esc(r.map));
    if (r.faction) bits.push(esc(r.faction));
    bits.push(ageText(r.ts || Date.now()));
    sub.textContent = bits.join("  -  ");
    body.appendChild(name);
    body.appendChild(sub);
    const join = document.createElement("div");
    join.className = "lobby-room-join";
    join.textContent = "Join";
    row.appendChild(body);
    row.appendChild(join);
    row.addEventListener("click", () => joinByCode(r.code));
    box.appendChild(row);
  }
}

function setLobbyState(role) {
  const el = $("lobby-state");
  if (!el) return;
  el.classList.remove("is-host", "is-client", "is-offline");
  if (role === "host") { el.textContent = "Lobby: connected (host)"; el.classList.add("is-host"); }
  else if (role === "client") { el.textContent = "Lobby: connected"; el.classList.add("is-client"); }
  else if (role === "connecting") { el.textContent = "Lobby: connecting..."; }
  else { el.textContent = "Lobby: offline - use codes"; el.classList.add("is-offline"); }
}

// Summarize the currently-selected map options for a room listing.
function mapSummary(opts) {
  const themeIdx = opts.theme;
  const theme = (typeof themeIdx === "number" && THEME_NAMES[themeIdx]) ? THEME_NAMES[themeIdx] : "random theme";
  const spawns = opts.spawns ? opts.spawns + " spawns" : "random spawns";
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${cap(theme)} - ${cap(spawns)}`;
}

// Advertise the open game we just created (if "List publicly" is on).
function postCurrentGame(code) {
  if (!lobby || !listPublicEl || !listPublicEl.checked) return;
  const opts = readMapOpts();
  const faction = (opts.factions && opts.factions[0]) || "";
  const player = "Player";
  const room = { code, name: `${player}'s game`, map: mapSummary(opts), faction };
  lobby.post(room);
  const mine = $("lobby-mine");
  if (mine) {
    mine.classList.remove("hidden");
    mine.textContent = "";
    const b = document.createElement("b");
    b.textContent = code;
    mine.appendChild(document.createTextNode("Listed as "));
    mine.appendChild(b);
    mine.appendChild(document.createTextNode(" - waiting for an opponent"));
  }
}

// Match starting or leaving the menu: unpost + destroy the lobby peer so we
// free the well-known id and never strand a ghost host.
function tearDownLobby() {
  const mine = $("lobby-mine");
  if (mine) mine.classList.add("hidden");
  if (lobby) { try { lobby.unpost(); } catch {} try { lobby.destroy(); } catch {} lobby = null; }
}

function startLobby() {
  if (lobby || typeof Peer === "undefined") return;
  lobby = new Lobby();
  lobby.onStatus = (role) => setLobbyState(role);
  lobby.onRooms = (rooms) => { latestRooms = rooms || []; renderRooms(); };
  setLobbyState("connecting");
  lobby.start();
}

$("btn-lobby-refresh")?.addEventListener("click", () => {
  if (lobby && lobby.role !== "offline") {
    // client asks the host for a fresh list; host just re-renders its own table
    if (lobby.role === "client") lobby._sendToHost({ k: "list" });
    renderRooms();
  } else {
    startLobby();
  }
});

// periodic age re-render so "X min ago" stays fresh
setInterval(() => { if (!menu.classList.contains("hidden") && latestRooms.length) renderRooms(); }, 30000);

// Boot the lobby once PeerJS is available. It runs quietly in the background;
// if the broker is unreachable it degrades to "offline" and codes still work.
startLobby();

// ---------- campaign wiring ----------
// The campaign is entirely self-contained: it only constructs a Game when the
// player picks a mission. Mission sims run as local single-player ("ai" mode,
// but the runner may null the AI or script waves itself). Skirmish/MP untouched.
function startCampaignMission(mission) {
  // Force the mission's faction matchup + fixed seed/opts for a hand-tuned feel.
  const opts = Object.assign({}, mission.mapOpts || {});
  opts.factions = mission.factions || ["cogs", "cogs"];
  if (mission.aiDifficulty) opts.aidifficulty = mission.aiDifficulty;
  // Optional hand-authored ASCII map: build it and hand it to the Sim as
  // opts.customMap (Sim uses it verbatim, skipping generateMap). mapSeed then
  // only seeds sim randomness. Missions without `map` generate procedurally.
  try {
    const customMap = buildCustomMapFor(mission);
    if (customMap) opts.customMap = customMap;
  } catch (e) {
    console.error("Custom mission map failed to build; falling back to procedural:", e);
  }
  // mode "ai" gives us player 0 = local, player 1 = AI. Missions with ai:false
  // still use "ai" mode but the runner strips the AI so player 1 stays scripted.
  const seed = mission.mapSeed | 0;
  startGame("ai", seed, null, opts, false, mission);
}
mountCampaign(startCampaignMission);

$("btn-again")?.addEventListener("click", () => location.reload());
$("btn-replay")?.addEventListener("click", () => {
  try { window.RTS?.saveReplay?.(); } catch (e) { console.error("Replay save failed:", e); }
});
