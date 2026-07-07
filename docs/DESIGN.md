# webRTS — Design Bible ("Chibi Sci-Fi")

The north star for the visual + faction overhaul. Everything — menu, units,
buildings, upgrades, terrain, UI — must trace back to the rules here so the game
reads as ONE cohesive world instead of a pile of disjointed parts.

## 1. The world

A bright, toy-like sci-fi skirmish fought on small floating battle-arenas /
pocket planets. Cute on the surface, real StarCraft-grade systems underneath.

Touchstones: **Clash Royale's readability × Pikmin's charm × StarCraft's
depth**, rendered in rounded low-poly.

## 2. Visual language (applies to EVERYTHING)

- **Rounded low-poly.** Chunky, beveled shapes. No sharp menacing edges. Chibi
  proportions: big cabins/heads, small bases, stubby limbs. Silhouettes must
  read instantly at RTS zoom.
- **Bright, soft light.** Hemispheric sky light + warm key + gentle ambient.
  **Kill the near-black fog/sky** (old themes used `0x070a10`). Fog is light and
  airy, pastel-tinted per biome. The game should feel sunny, not grimdark.
- **Toon-ish shading.** 2–3 step soft banding + a gentle rim light for
  cuteness, rather than realistic PBR. Subtle, not hard cel.
- **Faction = hue family + material.** Player team color is an ACCENT (visor
  glow / team stripe), never the whole unit.
- **UI.** Rounded panels, chunky friendly buttons, geometric sans, playful
  iconography. **SVG icons or plain text — never emoji** (user preference).

## 3. The three factions (fully asymmetric)

The timeless RTS triangle, cute-ified. Each plays fundamentally differently
(own macro mechanic, production style, roster).

### Naming lexicon (no StarCraft names — own identity, 2026-07-06)
Display names only; internal type keys (worker/marine/... ) are frozen (sim,
net protocol, replays, AI all reference them).

| key | display | | key | display |
| --- | --- | --- | --- | --- |
| worker | **Bolt** | | hq | **Hub** |
| marine | **Zapper** | | depot | **Battery** (supply = charge) |
| brute | **Clank** | | barracks | **Assembly** |
| tank | **Thumper** | | refinery | **Pumpjack** |
| wraith | **Dart** | | factory | **Foundry** |
| banshee | **Rumble** | | starport | **Hangar** |
| | | | turret | **Sentry** |

Upgrades/abilities: Stim Pack→**Overclock** (robots overheat, perfect fit),
Combat Plating→**Tin Plating**, Siege Tech→**Anchor Tech**, Siege
Mode→**Anchor Mode**. "Vespene"→plain **Gas**. Naming rule for new content:
robot parts / machine noises / toolbox words — cute, mechanical, one word.

### The Cogs — robots (THE CURRENT FACTION, reworked first)
Industrious tin/plastic robots. Domes, antennae, treads, rivets. Warm metals +
team-color visors. **Identity: build, repair, salvage.** Everything mechanical,
so ONE heal source (a Tinker/Repair Drone) sustains the whole army — this is how
we fix the "stim with no medic" problem. Signature macro: repair & salvage
wrecks; modular add-ons.
- Existing units map straight over: worker→Bolt drone, marine→Trooper,
  brute→Bruiser, tank→Crawler, wraith/banshee→hover-drones.

### The Ooze — gooey aliens (Phase 3)
Organic blobs/slimes. **Identity: swarm, grow, regenerate.** Units grown from
biomass, cheap, self-heal, morph/merge into bigger forms. Signature macro:
spreading "goo" territory; morph tech instead of separate unit buildings.

### The Prism — crystal folk (Phase 4)
Geometric crystal beings. **Identity: energy, shields, teleport.** Expensive,
shielded, powered by energy/shard nodes; warp-in production; blink/positional
play. Signature macro: energy grid that must be powered/defended.

## 4. Grid hotkeys (positional)

CORRECTED DIAGNOSIS (2026-07-06): the live hotkey system is hud.js
`refreshCard()` — it already assigns grid letters (q,w,e,r,t,g,v / a,s,d,f
combat / z,x,c abilities) and input.js dispatches via `hud.hotkeys[key]`.
(`HOTKEYS` in data.js is a dead export — nothing imports it.) The actual bug is
LAYOUT: `#cmd-card` is a 3-column auto-flow CSS grid, so buttons land wherever
they fall in append order — the "R" button can render where your finger expects
"A". Fix: keyboard-shaped card — 5 columns x 3 rows, every button explicitly
placed at its physical key's cell, unused cells left as gaps:

```
Q W E R T
A S D F G
Z X C V B
```

Combat stays pinned on A/S/D/F, abilities on Z/X/C, builds/trains fill the top
row. The key on screen is the key under your finger, always.

## 5. Route-first map generation (Phase 2)

Current generator is structure-first (stamp plateaus → center island → grow
barriers → connectivity is emergent), which reads as boxy with weird spawns.
Invert it:

1. Place base nodes (mains, naturals, expansions) as a GRAPH.
2. Plan the LANES between them first — guaranteed pathways linking every base and
   both players, with intended chokes.
3. Grow terrain/elevation/decoration AROUND the reserved lanes.
4. Dynamic params: lane count, lane width, openness, choke tightness, expansion
   count, vertical drama — so maps feel varied but always sensible.

Keep full integer determinism (both lockstep clients regenerate identically).

## 6. Phased roadmap

- **Phase 1 — Identity on the Cogs.** Bright palette + toon lighting, rounded
  material pass, menu + HUD restyle, positional grid hotkeys, Cog unit/ability
  cohesion (repair/heal), chibi terrain palette. Ship a great single-faction game.
- **Phase 2 — Route-first map generation.** Rewrite generation as above.
- **Phase 3 — The Ooze.** Full 3-faction mechanics doc, then implement Ooze
  (units, buildings, AI, balance).
- **Phase 4 — The Prism.** Implement, cross-faction balance, full upgrade/ability
  icon set, polish.
