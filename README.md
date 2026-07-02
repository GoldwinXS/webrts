# webRTS

A StarCraft-inspired 3D real-time strategy game that runs entirely in the
browser. Vanilla JS + Three.js, no build step — deployable on any static host,
including GitHub Pages, with working PvP multiplayer.

## Features

- **3D battlefield** — Three.js scene with an RTS camera (pan, rotate, zoom),
  fog of war baked into the terrain, health bars, selection rings, tracer fire
- **Classic economy** — workers mine mineral patches and return them to your
  Command Post; supply caps your army; buildings construct in place
- **Base building** — Command Post (trains workers), Supply Depot (+8 supply),
  Barracks (trains Marines and Brutes)
- **Combat** — attack-move, auto-acquisition, ranged and melee units;
  destroy every enemy building to win
- **Skirmish AI** — rule-based opponent that expands its economy, keeps supply
  ahead, and sends growing attack waves
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

## Roadmap

- More unit types (air, siege) and a second resource
- Rally points, control groups, hotkey rebinding
- Better pathing under congestion (flow fields)
- Replays (free with lockstep: record the command stream)
- Lobby improvements: rematch, spectators
