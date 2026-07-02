# webRTS Devlog — Building a Multiplayer 3D RTS in One Session

*2026-07-02. This is the story of v1: a StarCraft-inspired 3D RTS with working
PvP multiplayer, built and verified in a single sitting, deployable as plain
static files. Written to be turned into a video/article — the numbers, the
architecture, and the three bugs are all real.*

## The premise

Goal: a classic RTS — workers, minerals, supply, barracks, marines — that runs
in a browser and supports **player-vs-player over the internet**, hosted on
**GitHub Pages**.

That last requirement is the interesting one. GitHub Pages serves static
files. No game server, no websocket relay, no matchmaking backend, nothing.
So how do two players fight each other in real time with nowhere to put a
server?

## The trick is 25 years old

StarCraft (1998) and Age of Empires (1997) had the same problem in a
different costume: 90s modems couldn't ship the positions of 800 units to 8
players many times per second. Their answer — **deterministic lockstep** —
solves the no-server problem too:

1. Both machines run the *entire game simulation* locally, in perfect sync.
2. Nobody ever transmits game state. Only **commands** cross the wire:
   "player 2 told units 17, 23, 41 to attack-move to (312, 448)."
3. Commands issued at tick T execute at tick T+3 on *both* machines, hiding
   network latency. A tick only advances once both players' commands for it
   have arrived.

Bandwidth is a few commands per second regardless of army size. And because
there is no state to relay, there is no server. The only non-static piece is
the WebRTC handshake — one browser needs to find the other once. A free
public PeerJS broker does that introduction; after the handshake all traffic
is a direct peer-to-peer data channel. GitHub Pages never sees a packet of
gameplay.

The price: the simulation must be **bit-for-bit identical** on both machines,
forever. One stray `Math.random()`, one float that rounds differently, one
iteration order that differs — and the two games silently diverge until one
player's marines are shooting at units the other player doesn't have.

## Rules of the sim

Everything under `js/core/` obeys four laws (from `sim.js`'s header comment):

- **Integers only.** Positions are fixed-point: 1 tile = 256 units (`FP=256`).
  Distances use integer square root (Newton's method). No `Math.sin`, no
  `Math.pow`, no floats in game state, ever.
- **Seeded randomness.** A mulberry32 PRNG built on `Math.imul` — integer ops
  are identical on every JS engine. The host picks the seed; both sides
  generate the same map and the same rolls from it.
- **Ordered everything.** Entities update in creation order. Commands apply
  in (player, order-sent) order. A* breaks cost ties by node index. Pairwise
  collision pushes iterate `i < j` by id.
- **Renderer reads, never writes.** Three.js interpolates between the last
  two ticks for smooth 60fps motion on top of a 10Hz sim, but a render frame
  cannot touch sim state. Players interact only through commands.

Desync insurance: every 50 ticks each side sends an FNV-1a hash of
(tick, minerals, every entity's id/x/y/hp). Mismatch → "DESYNC DETECTED"
banner instead of a silently forked reality.

## What went in the box

~2,600 lines across 16 files, no build step, no dependencies beyond Three.js
(import map) and PeerJS (script tag):

| System | Where | Notes |
| --- | --- | --- |
| Fixed-point math, PRNG, hashing | `core/fixed.js` | the determinism toolbox |
| Symmetric map gen | `core/map.js` | 48x48 tiles, 180°-rotational symmetry, 20 mineral patches |
| Pathfinding | `core/path.js` | A*, 8-dir, no corner cutting, LOS smoothing |
| Simulation | `core/sim.js` | economy, construction, combat, fog, win check |
| Skirmish AI | `core/ai.js` | rule-based, same command pipeline as a human |
| Lockstep driver | `game.js` | 100ms ticks, 3-tick input delay, hash exchange |
| Transport | `net/net.js` | PeerJS host/join by 5-letter code |
| Renderer | `render/renderer.js` | fog baked into ground texture, health bars, tracers |
| Camera, input, HUD | `render/camera.js`, `ui/` | box select, attack-move, placement ghost, minimap |

Gameplay: Workers (mine 8 minerals/trip), Marines (ranged), Brutes (melee
tank); Command Post trains workers and receives minerals, Supply Depot +8
supply, Barracks trains the army. Fog of war with explored-but-dark memory.
Destroy every enemy building to win. The AI saturates 14 workers, keeps
supply ahead, expands to 3 barracks, and attacks with growing waves (first
around 2:00, +4 units per wave).

## Verification — trust nothing, measure everything

Run headless in the live page via a `window.RTS.step(n)` debug handle:

- **Determinism:** two sims, same seed, identical scripted commands (a move
  at tick 50, a train at tick 200), stepped 1,000 ticks side by side →
  checksums `3905063728` == `3905063728`. Bit-identical.
- **Economy:** 5 workers mined **418 minerals in 60 sim-seconds**; a worker
  walked to a placement site and raised a depot 0→180 build ticks; supply
  10→18.
- **Combat:** 4 marines vs 4 brutes at point-blank — brutes win (as costed),
  death events fire, corpses removed from both sim and scene.
- **AI:** left alone for 100 sim-seconds it trained 19 units and queued its
  first attack wave on schedule.
- **Multiplayer:** two `Net` instances in one page did the full real-world
  loop against the public broker — match code `EQ6PL` registered, WebRTC
  data channel opened, a command bundle arrived intact.
- **Rendering:** 4,510 triangles, 17 draw calls, 100% non-black pixels
  sampled off the WebGL framebuffer.

## Three bugs (all caught by the verification pass)

1. **The missing method.** `sim.step()` called `updateBuilding()` — which was
   never written. Training queues didn't exist until tick-stepping crashed
   the sim. *Lesson: a clean architecture diagram is not a working program.*
2. **The center-tile blind spot.** `nearestFree()` searched rings at radius
   1..9 around a tile but never checked the tile itself — fine for its
   original caller (which only asked about blocked tiles), wrong for unit
   spawn placement. Classic reuse-without-rechecking-assumptions.
3. **The alt-tab stall.** Browsers suspend `requestAnimationFrame` in hidden
   tabs. The game loop lived in rAF — so an alt-tabbed player would freeze
   their sim and *stall their opponent's game* (lockstep waits for their
   commands). Found because the preview tab happened to be backgrounded
   during testing; fixed with a `setInterval` fallback that keeps the sim
   ticking while hidden. This one would have been miserable to debug in a
   live match.

## What's deliberately missing (v1 honesty)

- Balance is a first guess; nobody has lost to the AI yet who didn't want to.
- Pathing degrades under congestion (no flow fields, units shove each other).
- One resource, three units, three buildings — the StarCraft skeleton, not
  the StarCraft body.
- Lockstep has only been latency-tested loopback; real cross-continent games
  may want the input delay adaptive instead of fixed at 300ms.
- No replays yet — though lockstep makes them almost free (record the
  command stream + seed, replay it through the sim).

## The takeaway

The hard part of "multiplayer RTS on static hosting" is not networking code —
`net.js` is 80 lines. The hard part is the discipline of determinism: every
line of the sim written knowing that a single nondeterministic operation
anywhere breaks everything, invisibly, later. Retrofitting that onto an
existing game is a rewrite. Baking it in from line one is just... a style
guide.

That's why the 1998 trick still wins in 2026.
