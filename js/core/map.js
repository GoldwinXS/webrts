// Deterministic map generation. Rotationally symmetric (180deg) so both
// players get identical terrain. Produces the passability grid and the
// spawn layout (start locations + mineral clusters).
import { makeRng, tileToFp } from "./fixed.js";
import { MAP_W, MAP_H } from "./data.js";

export function generateMap(seed) {
  const rng = makeRng(seed);
  const rock = new Uint8Array(MAP_W * MAP_H);

  const starts = [
    { x: 8, y: 8 },
    { x: MAP_W - 9, y: MAP_H - 9 },
  ];

  // Random rock blobs in one half, mirrored to the other.
  const blobs = 10;
  for (let i = 0; i < blobs; i++) {
    const bx = 4 + (rng() % (MAP_W - 8));
    const by = 4 + (rng() % ((MAP_H >> 1) - 4));
    const size = 2 + (rng() % 4);
    for (let j = 0; j < size * 3; j++) {
      const x = bx + (rng() % (size * 2)) - size;
      const y = by + (rng() % (size * 2)) - size;
      if (x < 1 || y < 1 || x >= MAP_W - 1 || y >= MAP_H - 1) continue;
      rock[y * MAP_W + x] = 1;
      rock[(MAP_H - 1 - y) * MAP_W + (MAP_W - 1 - x)] = 1; // mirror
    }
  }

  // Clear generous areas around both starts and the center lane.
  for (const s of starts) clearArea(rock, s.x, s.y, 7);
  clearLane(rock, starts[0], starts[1], 2);

  // Mineral clusters: 6 patches arced around each start, plus 2 mirrored
  // expansion clusters mid-map.
  const minerals = [];
  const arc = [
    [-4, -2], [-4, 0], [-4, 2], [-2, -4], [0, -4], [2, -4],
  ];
  for (const [dx, dy] of arc) {
    minerals.push({ x: tileToFp(starts[0].x + dx), y: tileToFp(starts[0].y + dy) });
    minerals.push({ x: tileToFp(starts[1].x - dx), y: tileToFp(starts[1].y - dy) });
  }
  const expansions = [
    { x: 10, y: MAP_H - 11 },
    { x: MAP_W - 11, y: 10 },
  ];
  for (const e of expansions) {
    clearArea(rock, e.x, e.y, 4);
    for (const [dx, dy] of [[-2, -1], [-2, 1], [-1, -2], [1, -2]]) {
      minerals.push({ x: tileToFp(e.x + dx), y: tileToFp(e.y + dy) });
    }
  }

  return { w: MAP_W, h: MAP_H, rock, starts, minerals };
}

function clearArea(rock, cx, cy, r) {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H) rock[y * MAP_W + x] = 0;
    }
  }
}

// Clear a straight corridor between two points so the map is always connected.
function clearLane(rock, a, b, halfWidth) {
  const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 2;
  for (let i = 0; i <= steps; i++) {
    const x = a.x + (((b.x - a.x) * i / steps) | 0);
    const y = a.y + (((b.y - a.y) * i / steps) | 0);
    clearArea(rock, x, y, halfWidth);
  }
}
