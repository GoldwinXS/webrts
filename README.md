# webRTS

A StarCraft-inspired 3D real-time strategy game that runs entirely in the
browser. Vanilla JS + Three.js, no build step — deployable on any static host,
including GitHub Pages, with working PvP multiplayer.

## Three factions

- **The Cogs** — industrious robots. Build, repair, out-tech. Siege tanks,
  stimmed marines, rocket barrages.
- **The Ooze** — gooey swarm. Creep spreads organically tile-by-tile from the
  Nucleus and Goo Vents (and crumbles back when they die); Ooze units heal on
  it, move faster on it, and buildings must be planted on it.
- **The Tempest** — living lightning in floating armor. Regenerating shields,
  a power field that gates building placement, chain lightning, blink dashes,
  phase-shifted ghosts, and the Fulminar's channeled lightning storm.

## Features

- **3D battlefield** — Three.js scene with an RTS camera (pan, rotate, zoom),
  fog of war baked into the terrain, health bars, selection rings, tracer fire
- **Classic economy** — workers mine mineral patches and return them to your
  Command Post; supply caps your army; buildings construct in place
- **Base building** — Hub (trains Bolt workers), Battery (+8 supply),
  Assembly (trains Zappers and Clanks)
- **Combat** — attack-move, auto-acquisition, ranged and melee units;
  destroy every enemy building to win
- **SC2-style maps** — curved lanes with enforced chokepoints, contested gold
  expansions (richer trips, smaller pool), neutral watchtowers that grant
  vision to whoever holds them, themed biomes (verdant / ashen / frozen)
- **Skirmish AI** — rule-based opponent for all three factions that expands
  its economy, keeps supply ahead, and sends growing attack waves
- **PvP multiplayer** — deterministic lockstep over a direct WebRTC data
  channel (PeerJS public broker for the handshake only). Share a 5-letter
  match code; no game server anywhere.

## How multiplayer works with no server

The simulation is fully deterministic: integer/fixed-point math, a seeded
PRNG, and strictly ordered updates. Both browsers run the identical sim and
exchange only player *commands*, scheduled a few ticks ahead (the classic
StarCraft/Age of Empires lockstep model). Checksums are compared periodically
to detect desyncs. This is why the sim (`js/core/`) never touches floats,
`Math.random()`, or iteration orders that could differ between machines.

## Run locally

Any static file server:

```
python -m http.server 1338
# or: npx serve .
```

Open http://localhost:1338. No build step — edit and refresh.

## Deploy to GitHub Pages

Push this folder to a GitHub repo, then Settings -> Pages -> deploy from
branch `main`, root folder. The game (including multiplayer) works from the
`github.io` URL as-is.

## Controls

| Input | Action |
| --- | --- |
| Left-drag / click | Select units (Shift adds) |
| Right-click | Move / gather / attack, context-sensitive |
| A | Attack-move (then click a target or location) |
| S | Stop |
| Ctrl/Alt+1-9 | Set control group (exclusive: a unit lives in one group) |
| Shift+1-9 | Add to group (steals from other groups) |
| Delete | Remove selected units/buildings |
| Arrows / screen edge | Pan camera |
| Q / E or middle-drag | Rotate camera |
| Wheel | Zoom |
| Esc | Cancel placement / attack mode / selection |

## Layout

```
index.html            page, menu, HUD skeleton
css/style.css         all styling
js/main.js            boot, menu wiring, main loop
js/game.js            fixed-tick driver + lockstep netcode
js/core/fixed.js      fixed-point math, seeded PRNG, hashing
js/core/data.js       balance data (units, buildings, costs)
js/core/map.js        symmetric map generation
js/core/path.js       A* pathfinding + LOS smoothing
js/core/sim.js        the deterministic simulation
js/core/ai.js         skirmish AI
js/render/camera.js   RTS camera
js/render/renderer.js Three.js presentation layer
js/ui/input.js        mouse/keyboard -> commands, selection, placement
js/ui/hud.js          resource bar, command card, minimap, toasts
js/net/net.js         PeerJS transport (host / join by code)
```

## Documentation

- [docs/DEVLOG.md](docs/DEVLOG.md) — the story of the build: why lockstep,
  the verification numbers, and the three bugs
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — technical reference with
  diagrams: lockstep protocol, determinism rules, sim structure, balance data

## Roadmap

- Better pathing under congestion (flow fields)
- Lobby improvements: rematch, spectators
- Adaptive input delay based on network latency

## Recent improvements

- **Replay system** — save replays from the game-over screen
- **AI improvements** — builds starports + air units, turrets for defense,
  researches afterburners, kites with marines, retreats when outnumbered
- **Performance** — spatial hash grid for O(n) entity queries, pooled A*
  pathfinding buffers, single-pass AI entity bucketing
- **Determinism** — comprehensive checksum covers ability timers, building
  queues, worker cargo, and order state
- **Graphics quality settings** — Low/Medium/High presets in settings
- **Attack notifications** — audio alert + visual toast when under attack
