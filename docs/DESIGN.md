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

## 7. Faction architecture (all three)

The sim was single-faction (the Cogs). Faction support is additive:
- Every UNITS/BUILDINGS/ABILITIES/UPGRADES entry carries `faction: "cogs"|"ooze"|
  "prism"`. Type keys stay globally unique, so the sim's spawn/combat/tech code
  is UNCHANGED — it still looks up by type key.
- A `FACTIONS` map declares each faction's `start` building, `worker` type, and
  worker `build` list (what the worker can construct — replaces the hardcoded
  order array in hud.js). Also display `name` and `blurb`.
- `sim.factions[pid]` (from `opts.factions`, default `["cogs","cogs"]`) picks the
  start building + workers per player. A faction picker feeds it via the menu +
  the net start message; determinism unaffected (static per game).
- Command card, AI build order, and tooltips read the player's faction.

## 8. Faction: The Ooze (full spec — Phase 3)

Translucent gooey aliens. Acid greens / bruised purples, wobbly translucent
shells, spore puffs. **Cheap, numerous, self-healing, morph-based.** Names: goo /
critter / body-horror-cute, one or two syllables (Nip, Spit, Maw, Mote…).

### Signature mechanics
1. **Regeneration** — every Ooze unit regenerates HP when it hasn't taken damage
   for ~3s (`regenDelay`), at a slow base rate, DOUBLED while standing on Goo.
2. **Goo field** — a `Uint8Array(w*h)` creep grid. The Nucleus and Goo Vents
   ooze Goo outward (radius grows over time to a cap). **Ooze buildings may only
   be placed on Goo** (except the first Nucleus + Vents). Ooze ground units on
   Goo get +regen and +~20% move speed; off Goo they're slower (fragile when
   caught in the open). Rendered as a translucent creep overlay that darkens the
   ground and grows organically. Deterministic (integer radius per tick).
3. **Morph** — production and tech are morphs, not "trained from a factory":
   - Buildings rise by **consuming a Mote** (the worker melts into the site;
     no worker babysitting — it becomes the building over `buildTime`).
   - **Nip → Maw**: a Nip can morph into a heavy Maw for extra cost + time.
   - **Sluice burrow**: toggle to a stationary acid-mortar (the siege role).
4. **Broods** — the Den morphs Nips **two at a time** per cycle (swarm feel).

### Roster (stats tuned vs the Cogs; costs in Scrap / Oil, supply, ticks)
| key | name | role | cost | hp | dmg (air) | range | spd | sup | notes |
|---|---|---|---|---|---|---|---|---|---|
| mote | **Mote** | worker | 50 | 40 | 3 | melee | 66 | 1 | melts into buildings |
| nip | **Nip** | swarm melee | 40 | 40 | 5 | melee | 74 | 1 | morphs 2/cycle; →Maw |
| spit | **Spit** | ranged + AA | 65 | 45 | 5 (7) | 4.2 | 60 | 1 | the anti-air answer |
| maw | **Maw** | heavy melee | 40 (morph) | 160 | 17 | melee | 52 | 3 | morph from a Nip |
| sluice | **Sluice** | siege | 150 / 50 | 130 | 20→ burrow AoE | 1→7 | 42 | 3 | burrow = anchor role |
| wisp | **Wisp** | flyer | 110 / 50 | 90 | 8 (8) | 4 | 78 | 2 | hits ground + air |

### Buildings (all require Goo except Nucleus/Vent)
| key | name | ~cost | role |
|---|---|---|---|
| nucleus | **Nucleus** | 400 | start; morphs Motes; drop-off; oozes Goo |
| pod | **Pod** | 100 | +8 supply |
| vent | **Goo Vent** | 75 | spreads Goo to claim expansion ground |
| den | **Den** | 150 | morphs Nips (×2) + Spits; Carapace/Adrenal upgrades |
| sump | **Sump** | 75 | on Oil (refinery) |
| warren | **Warren** | 150 / 100 | morphs Maws + Sluices; needs Den |
| roost | **Roost** | 150 / 125 | morphs Wisps; needs Warren |
| barb | **Barb** | 100 | static defense (ground+air); needs Den |

### Abilities / upgrades
- **Sluice: Burrow** (toggle; anchor-role siege, minRange, splash) — via *Burrow Tech* (Warren).
- **Maw: Engulf** (short lunge + splash — the Ooze "leap").
- **Wisp: Spore Cloud** (targeted AoE slow/damage).
- Upgrades: **Carapace** (+hp, retro), **Adrenal** (attack-rate), **Burrow Tech**,
  **Membrane** (Wisp speed).

### Counters / identity vs Cogs
Ooze wins by numbers + sustain + map control (Goo). It's fragile per-unit and
weak off-Goo, so the Cogs' ranged/siege (Zapper/Thumper) punish it in the open,
while Ooze regeneration + broods grind out attrition and its cheap swarm floods
undefended flanks. Anti-air is Spit + Wisp; siege is the burrowed Sluice.
