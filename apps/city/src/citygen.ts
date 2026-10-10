// The city board's plan, SimCity style: a street grid of blocks, our
// landmarks on their own blocks, and every other block zoned and filled with
// lots (houses, shops, offices, parks). Pure and seeded: the same city on
// every phone, and testable without a GPU.

export const GRID = { blocks: 4, block: 9, road: 2 } as const;
export const CITY_SIZE = GRID.blocks * GRID.block + (GRID.blocks + 1) * GRID.road; // 46

export type Zone = "residential" | "commercial" | "office" | "industrial" | "park" | "water" | "landmark" | "square";
export type Rect = { x: number; z: number; w: number; d: number }; // centre and size, world units

// A block's rectangle (without the roads around it).
export function blockRect(bx: number, bz: number): Rect {
  const step = GRID.block + GRID.road;
  const x0 = -CITY_SIZE / 2 + GRID.road + bx * step;
  const z0 = -CITY_SIZE / 2 + GRID.road + bz * step;
  return { x: x0 + GRID.block / 2, z: z0 + GRID.block / 2, w: GRID.block, d: GRID.block };
}

// Road centre lines: N+1 avenues each way, spanning the city.
export function roads(): { a: number; along: "x" | "z" }[] {
  const out: { a: number; along: "x" | "z" }[] = [];
  const step = GRID.block + GRID.road;
  for (let i = 0; i <= GRID.blocks; i++) {
    const a = -CITY_SIZE / 2 + GRID.road / 2 + i * step;
    out.push({ a, along: "x" }, { a, along: "z" });
  }
  return out;
}

// Which block is what. Tower Square takes the four middle blocks (and the
// roads between them); the rest are landmarks or zoned for filler.
export const ZONING: Zone[][] = [
  // bz = 0 (north)
  ["water", "landmark", "office", "office"],
  ["residential", "square", "square", "landmark"],
  ["residential", "square", "square", "commercial"],
  ["residential", "residential", "park", "industrial"],
].map((row) => row as Zone[]);
export const zoneOf = (bx: number, bz: number): Zone => ZONING[bz]![bx]!;

export const DINER_BLOCK = { bx: 3, bz: 2 } as const;

export type PlaceKey = "tower" | "roof" | "city_hall" | "watch_party" | "gm_wall" | "faucet" | "diner" | "crew_row";

// Where our places stand (the pin goes above).
const sq = (() => {
  const a = blockRect(1, 1);
  const b = blockRect(2, 2);
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
})();
export const SQUARE: Rect = { x: sq.x, z: sq.z, w: GRID.block * 2 + GRID.road, d: GRID.block * 2 + GRID.road };
export const LANDMARKS: Record<PlaceKey, { x: number; z: number; pinY: number }> = {
  tower: { x: sq.x, z: sq.z, pinY: 19.5 },
  roof: { x: sq.x, z: sq.z, pinY: 22 },
  city_hall: { ...xz(blockRect(1, 0)), pinY: 7 },
  watch_party: { ...xz(blockRect(3, 1)), pinY: 6 },
  gm_wall: { x: sq.x - 6, z: sq.z + 6.5, pinY: 4 },
  faucet: { x: sq.x + 6, z: sq.z + 6, pinY: 3.5 },
  // The Diner takes the commercial block's corner lot (the generator leaves it empty).
  diner: { x: blockRect(3, 2).x - GRID.block / 3, z: blockRect(3, 2).z - GRID.block / 3, pinY: 4 },
  crew_row: { ...xz(blockRect(0, 2)), pinY: 5 },
};
function xz(r: Rect) {
  return { x: r.x, z: r.z };
}

// --- Filler lots ----------------------------------------------------------------

export type Lot =
  | { kind: "house"; x: number; z: number; w: number; d: number; h: number; color: string; roof: string; yaw: number }
  | { kind: "shop"; x: number; z: number; w: number; d: number; h: number; color: string; awning: string; yaw: number }
  | { kind: "office"; x: number; z: number; w: number; d: number; h: number; color: string; glass: string }
  | { kind: "tree"; x: number; z: number; s: number }
  | { kind: "parking"; x: number; z: number; w: number; d: number }
  | { kind: "pool"; x: number; z: number; w: number; d: number }
  | { kind: "factory"; x: number; z: number; model: string; yaw: number; scale: number };

// mulberry32
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;

const HOUSE = ["#f2d7c3", "#f4c0d1", "#c0dd97", "#b5d4f4", "#fac775", "#e8e1d4", "#d3c6f0", "#f5b7a0"];
const ROOF = ["#b5533c", "#8a4b3a", "#5c6b7a", "#7a4a2a", "#3d5a8a"];
const SHOP = ["#e8e1d4", "#f2d7c3", "#c9d6e3", "#f4f1ea", "#e6d2b5"];
const AWNING = ["#e24b4a", "#378add", "#1d9e75", "#ef9f27", "#d4537e", "#534ab7"];
const OFFICE = ["#c9d6e3", "#a9b8c8", "#d8d3c8", "#8fa3b8", "#b9c4cf"];
const GLASS = ["#5a7fa8", "#4a6b8f", "#6f8fae", "#3f5f7f"];

// Lots on one block, by zone. Houses face the street they're on.
export function fillBlock(bx: number, bz: number, seed = 7): Lot[] {
  const r = rng(seed * 1000 + bx * 31 + bz * 7);
  const b = blockRect(bx, bz);
  const zone = zoneOf(bx, bz);
  const out: Lot[] = [];
  const cell = GRID.block / 3; // 3×3 lots
  const lotAt = (i: number, j: number) => ({ x: b.x - GRID.block / 2 + cell * (i + 0.5), z: b.z - GRID.block / 2 + cell * (j + 0.5) });
  const facing = (i: number, j: number) => (j === 2 ? 0 : j === 0 ? Math.PI : i === 0 ? -Math.PI / 2 : Math.PI / 2);
  if (zone === "residential") {
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const p = lotAt(i, j);
        if (i === 1 && j === 1) {
          out.push(r() < 0.5 ? { kind: "pool", x: p.x, z: p.z, w: 1.6, d: 1.1 } : { kind: "tree", x: p.x, z: p.z, s: 1.2 });
          continue;
        }
        out.push({ kind: "house", x: p.x, z: p.z, w: 1.7 + r() * 0.4, d: 1.5 + r() * 0.4, h: 1 + r() * 0.5, color: pick(r, HOUSE), roof: pick(r, ROOF), yaw: facing(i, j) });
        out.push({ kind: "tree", x: p.x + (r() - 0.5) * 2, z: p.z + (r() < 0.5 ? -1.1 : 1.1), s: 0.6 + r() * 0.4 });
      }
  } else if (zone === "commercial") {
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const p = lotAt(i, j);
        if (i === 1 && j === 1) {
          out.push({ kind: "parking", x: p.x, z: p.z, w: cell * 0.95, d: cell * 0.95 });
          continue;
        }
        if (bx === DINER_BLOCK.bx && bz === DINER_BLOCK.bz && i === 0 && j === 0) continue; // the Diner's lot
        out.push({ kind: "shop", x: p.x, z: p.z, w: cell * 0.9, d: cell * 0.85, h: 1.6 + Math.floor(r() * 3) * 0.9, color: pick(r, SHOP), awning: pick(r, AWNING), yaw: facing(i, j) });
      }
  } else if (zone === "office") {
    const half = GRID.block / 2;
    for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const x = b.x - half / 2 + i * half;
      const z = b.z - half / 2 + j * half;
      out.push({ kind: "office", x, z, w: half * 0.72, d: half * 0.72, h: 5 + r() * 9, color: pick(r, OFFICE), glass: pick(r, GLASS) });
    }
  } else if (zone === "industrial") {
    // Factories on the four quarters, yard kit (chimneys, tanks, containers, a water tower) between.
    const half = GRID.block / 2;
    const sheds = ["building-a", "building-b", "building-c", "building-d", "building-e", "building-f", "building-g", "building-h", "building-i", "building-j"];
    for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const x = b.x - half / 2 + i * half;
      const z = b.z - half / 2 + j * half;
      out.push({ kind: "factory", x, z: z - 0.5, model: pick(r, sheds), yaw: j === 1 ? 0 : Math.PI, scale: 1.7 });
    }
    out.push({ kind: "factory", x: b.x, z: b.z, model: "water-tower", yaw: 0, scale: 1.6 });
    out.push({ kind: "factory", x: b.x + 2.9, z: b.z + 0.6, model: "chimney-large", yaw: 0, scale: 1.8 });
    out.push({ kind: "factory", x: b.x - 2.9, z: b.z + 0.6, model: "detail-tank-large", yaw: 0, scale: 1.2 });
    out.push({ kind: "factory", x: b.x + 1.4, z: b.z + 3.6, model: "shipping-container-a", yaw: Math.PI / 2, scale: 1.1 });
    out.push({ kind: "factory", x: b.x - 1.4, z: b.z + 3.6, model: "shipping-container-b", yaw: Math.PI / 2, scale: 1.1 });
  } else if (zone === "park") {
    for (let k = 0; k < 14; k++) out.push({ kind: "tree", x: b.x + (r() - 0.5) * (GRID.block - 1.5), z: b.z + (r() - 0.5) * (GRID.block - 1.5), s: 0.7 + r() * 0.7 });
    out.push({ kind: "pool", x: b.x, z: b.z, w: 3, d: 2 });
  }
  return out;
}

export function fillCity(seed = 7): Lot[] {
  const out: Lot[] = [];
  for (let bz = 0; bz < GRID.blocks; bz++) for (let bx = 0; bx < GRID.blocks; bx++) out.push(...fillBlock(bx, bz, seed));
  return out;
}

// Car loops: each car drives round one block, on the right-hand lane.
export function carLoop(bx: number, bz: number): { x: number; z: number }[] {
  const b = blockRect(bx, bz);
  const o = GRID.block / 2 + GRID.road * 0.3;
  return [
    { x: b.x - o, z: b.z - o },
    { x: b.x + o, z: b.z - o },
    { x: b.x + o, z: b.z + o },
    { x: b.x - o, z: b.z + o },
  ];
}
