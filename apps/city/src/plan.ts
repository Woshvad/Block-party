// A room's floor plan in tiles: what's blocked (furniture) and where the
// seats are. Paths go around furniture, never through it and never cutting
// a corner past it, and nobody stands closer to a wall than a body's width.
// Pure and allocation-light, so it runs on a phone and is easy to test.

export type Tile = { x: number; y: number };
export type Seat = { id: string; x: number; y: number; facing: number; h?: number }; // facing: yaw in radians; h: seat height
export type Plan = { w: number; h: number; blocked: Uint8Array; seats: Seat[] };

export function makePlan(w: number, h: number, blocks: { x: number; y: number; w: number; d: number }[] = [], seats: Seat[] = []): Plan {
  const blocked = new Uint8Array(w * h);
  for (const b of blocks)
    for (let i = 0; i < b.w; i++)
      for (let j = 0; j < b.d; j++) {
        const x = b.x + i;
        const y = b.y + j;
        if (x >= 0 && y >= 0 && x < w && y < h) blocked[y * w + x] = 1;
      }
  // A seat is always somewhere you can stand.
  for (const s of seats) if (s.x >= 0 && s.y >= 0 && s.x < w && s.y < h) blocked[s.y * w + s.x] = 0;
  return { w, h, blocked, seats };
}

export const inside = (p: Plan, t: Tile) => t.x >= 0 && t.y >= 0 && t.x < p.w && t.y < p.h;
export const free = (p: Plan, t: Tile) => inside(p, t) && p.blocked[t.y * p.w + t.x] === 0;
const clampTile = (p: Plan, t: Tile): Tile => ({ x: Math.min(p.w - 1, Math.max(0, Math.round(t.x))), y: Math.min(p.h - 1, Math.max(0, Math.round(t.y))) });

// The closest free tile (breadth-first), or null in a room with no floor left.
export function nearestFree(p: Plan, t0: Tile): Tile | null {
  const t = clampTile(p, t0);
  if (free(p, t)) return t;
  const seen = new Uint8Array(p.w * p.h);
  const queue: Tile[] = [t];
  seen[t.y * p.w + t.x] = 1;
  for (let i = 0; i < queue.length; i++) {
    // loop-bound: each tile is queued at most once
    const c = queue[i]!;
    for (const [dx, dy] of DIRS4) {
      const n = { x: c.x + dx, y: c.y + dy };
      if (!inside(p, n) || seen[n.y * p.w + n.x]) continue;
      if (free(p, n)) return n;
      seen[n.y * p.w + n.x] = 1;
      queue.push(n);
    }
  }
  return null;
}

const DIRS4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
const DIRS8 = [...DIRS4, [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

// A* over the grid with diagonal steps (but no squeezing between two
// blocked tiles). Returns the tiles to walk through, start excluded, ending
// at the target, or at the nearest free tile to it. [] when already there.
export function findPath(p: Plan, from0: Tile, to0: Tile): Tile[] {
  const from = nearestFree(p, from0);
  const to = nearestFree(p, to0);
  if (!from || !to) return [];
  if (from.x === to.x && from.y === to.y) return [];
  const n = p.w * p.h;
  const g = new Float32Array(n).fill(Infinity);
  const f = new Float32Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const idx = (x: number, y: number) => y * p.w + x;
  const h = (x: number, y: number) => {
    const dx = Math.abs(x - to.x);
    const dy = Math.abs(y - to.y);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  const open: number[] = [idx(from.x, from.y)];
  g[open[0]!] = 0;
  f[open[0]!] = h(from.x, from.y);
  const goal = idx(to.x, to.y);
  while (open.length) {
    // loop-bound: every tile closes at most once
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (f[open[i]!]! < f[open[bi]!]!) bi = i;
    const cur = open[bi]!;
    open[bi] = open[open.length - 1]!;
    open.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % p.w;
    const cy = (cur - cx) / p.w;
    for (const [dx, dy] of DIRS8) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!free(p, { x: nx, y: ny })) continue;
      // No cutting corners: a diagonal needs both side tiles free.
      if (dx && dy && (!free(p, { x: cx + dx, y: cy }) || !free(p, { x: cx, y: cy + dy }))) continue;
      const ni = idx(nx, ny);
      if (closed[ni]) continue;
      const cost = g[cur]! + (dx && dy ? Math.SQRT2 : 1);
      if (cost < g[ni]!) {
        g[ni] = cost;
        f[ni] = cost + h(nx, ny);
        came[ni] = cur;
        open.push(ni);
      }
    }
  }
  if (came[goal] === -1) return [];
  const out: Tile[] = [];
  for (let c = goal; c !== idx(from.x, from.y); c = came[c]!) out.push({ x: c % p.w, y: Math.floor(c / p.w) });
  return out.reverse();
}

// Tile to world (the room is centred on the origin), kept a body's width
// off the walls: even the edge tiles stand clear of them.
export const WALL_MARGIN = 0.62;
export function toWorld(p: Pick<Plan, "w" | "h">, t: Tile): { x: number; z: number } {
  const x = t.x - p.w / 2 + 0.5;
  const z = t.y - p.h / 2 + 0.5;
  return { x: Math.min(p.w / 2 - WALL_MARGIN, Math.max(-p.w / 2 + WALL_MARGIN, x)), z: Math.min(p.h / 2 - WALL_MARGIN, Math.max(-p.h / 2 + WALL_MARGIN, z)) };
}
export const toTile = (p: Pick<Plan, "w" | "h">, x: number, z: number): Tile => ({ x: Math.floor(x + p.w / 2), y: Math.floor(z + p.h / 2) });
