import { type Plan, type Seat, makePlan } from "./plan";
import { ROOM_SIZE } from "./places";
import type { FeedKey } from "./roomfeeds";

// What's inside each public place: a layout in tiles (x across, y from the
// back wall forward), what blocks walking, and which tiles are seats. Pure
// data: drawn by Interior.tsx, walked around by plan.ts, tested for sense.

export type DecorKind =
  | "counter" | "stool" | "booth_bench" | "table" | "round_table" | "screen" | "sign" | "plant" | "podium" | "ballot" | "bell"
  | "fountain" | "railing" | "sofa" | "beanbag" | "lamp" | "mural" | "house" | "jukebox" | "flag" | "bench" | "war_table" | "rug" | "string_lights";

export type Decor = {
  kind: DecorKind;
  x: number;
  y: number;
  w?: number; // tiles across (default 1)
  d?: number; // tiles deep (default 1)
  color?: string;
  label?: string; // signs, screens, murals
  feed?: FeedKey; // screens: a live board (see roomfeeds.ts), the label until it loads
  blocks?: boolean; // default: true, except seats, rugs and wall pieces
  seat?: string; // a seat id: you can sit here
  facing?: number; // seats: which way you face (yaw)
};

export type Look = { wall: string; wall2: string; floor: string; floor2: string };
export type Layout = { look: Look; decor: Decor[] };

const N = 0; // facing the back wall (north, -z)
const S = Math.PI; // facing the front
const E = Math.PI / 2;
const W = -Math.PI / 2;

// Wall-mounted and flat pieces never block the floor.
const WALL_KINDS = new Set<DecorKind>(["screen", "sign", "mural", "house", "string_lights", "rug", "railing"]);
export const blocksWalk = (d: Decor) => (d.seat ? false : (d.blocks ?? !WALL_KINDS.has(d.kind)));

const benchRow = (y: number, xs: number[], prefix: string, facing: number, color: string): Decor[] => xs.map((x, i) => ({ kind: "bench", x, y, seat: `${prefix}${i + 1}`, facing, color }));

export const LAYOUTS: Record<string, Layout> = {
  diner: {
    look: { wall: "#f3dccb", wall2: "#d4473f", floor: "#f4f1ea", floor2: "#2c2c2a" },
    decor: [
      { kind: "sign", x: 4, y: 0, w: 6, label: "GWEI DINER", color: "#ff5d73" },
      { kind: "screen", x: 0, y: 0, w: 4, label: "ALPHA", color: "#f4f1ea", feed: "diner" },
      { kind: "counter", x: 3, y: 1, w: 8, color: "#d4473f" },
      ...[3, 5, 7, 9].map((x, i): Decor => ({ kind: "stool", x, y: 2, seat: `stool${i + 1}`, facing: N, color: "#d4473f" })),
      // Booths: bench, table, bench; along both side walls.
      ...[4, 6, 8].flatMap((y, i): Decor[] => [
        { kind: "booth_bench", x: 0, y, seat: `booth${i + 1}a`, facing: E, color: "#d4473f" },
        { kind: "table", x: 1, y, color: "#f4f1ea" },
        { kind: "booth_bench", x: 2, y, seat: `booth${i + 1}b`, facing: W, color: "#d4473f" },
        { kind: "booth_bench", x: 11, y, seat: `booth${i + 4}a`, facing: E, color: "#d4473f" },
        { kind: "table", x: 12, y, color: "#f4f1ea" },
        { kind: "booth_bench", x: 13, y, seat: `booth${i + 4}b`, facing: W, color: "#d4473f" },
      ]),
      { kind: "jukebox", x: 13, y: 0, color: "#ef9f27" },
      { kind: "plant", x: 11, y: 0 }, // the chalkboard has the corner
    ],
  },
  tower: {
    look: { wall: "#2b2357", wall2: "#534ab7", floor: "#3a3270", floor2: "#30295e" },
    decor: [
      { kind: "screen", x: 2, y: 0, w: 12, label: "THE ODDS WALL", color: "#1d9e75", feed: "odds" },
      { kind: "sign", x: 0, y: 0, w: 2, label: "TOWER", color: "#8f7cff" },
      ...[[3, 5], [8, 5], [12, 5], [5, 9], [10, 9]].flatMap(([x, y], i): Decor[] => [
        { kind: "round_table", x: x!, y: y!, color: "#e8e1d4" },
        { kind: "stool", x: x! - 1, y: y!, seat: `t${i + 1}a`, facing: E, color: "#8f7cff" },
        { kind: "stool", x: x! + 1, y: y!, seat: `t${i + 1}b`, facing: W, color: "#8f7cff" },
      ]),
      { kind: "plant", x: 0, y: 15 },
      { kind: "plant", x: 15, y: 15 },
      { kind: "rug", x: 6, y: 12, w: 4, d: 3, color: "#534ab7" },
    ],
  },
  roof: {
    look: { wall: "#9fb3c8", wall2: "#7a8fa6", floor: "#6f7b88", floor2: "#66717d" },
    decor: [
      { kind: "string_lights", x: 0, y: 0, w: 20, color: "#fac775" },
      { kind: "railing", x: 0, y: 0, w: 20, color: "#2c2c2a" },
      { kind: "bell", x: 9, y: 2, w: 2, d: 2, color: "#d4a017" },
      ...benchRow(7, [5, 7, 12, 14], "front", N, "#8a5a2b"),
      ...benchRow(10, [4, 7, 12, 15], "back", N, "#8a5a2b"),
      { kind: "plant", x: 0, y: 3 },
      { kind: "plant", x: 19, y: 3 },
      { kind: "plant", x: 0, y: 12 },
      { kind: "plant", x: 19, y: 12 },
      { kind: "lamp", x: 3, y: 2 },
      { kind: "lamp", x: 16, y: 2 },
    ],
  },
  city_hall: {
    look: { wall: "#e8e1d4", wall2: "#8fb1e0", floor: "#b08355", floor2: "#9c7148" },
    decor: [
      { kind: "sign", x: 5, y: 0, w: 6, label: "CITY HALL", color: "#378add" },
      { kind: "screen", x: 11, y: 0, w: 5, label: "NOTICEBOARD", color: "#378add", feed: "hall" },
      { kind: "podium", x: 7, y: 1, w: 2, color: "#7a4a2a" },
      { kind: "flag", x: 4, y: 1, color: "#378add" },
      { kind: "flag", x: 10, y: 1, color: "#e24b4a" }, // clear of the noticeboard
      { kind: "ballot", x: 13, y: 3, color: "#f4f1ea" },
      { kind: "rug", x: 6, y: 3, w: 4, d: 7, color: "#b23a3a" },
      ...benchRow(5, [2, 3, 4, 11, 12, 13], "row1-", N, "#7a4a2a"),
      ...benchRow(7, [2, 3, 4, 11, 12, 13], "row2-", N, "#7a4a2a"),
      ...benchRow(9, [2, 3, 4, 11, 12, 13], "row3-", N, "#7a4a2a"),
      { kind: "plant", x: 0, y: 11 },
      { kind: "plant", x: 15, y: 11 },
    ],
  },
  watch_party: {
    look: { wall: "#1f2433", wall2: "#33264f", floor: "#2d3b5a", floor2: "#263250" },
    decor: [
      { kind: "screen", x: 3, y: 0, w: 14, label: "WATCH PARTY", color: "#378add", feed: "match" },
      ...[3, 7, 12, 16].map((x, i): Decor => ({ kind: "sofa", x, y: 5, w: 2, seat: `sofa${i + 1}`, facing: N, color: ["#8f5bd1", "#d4537e", "#3ab5c9", "#ef9f27"][i] })),
      ...[2, 5, 8, 11, 14, 17].map((x, i): Decor => ({ kind: "beanbag", x, y: 9, seat: `bean${i + 1}`, facing: N, color: ["#e24b4a", "#97c459", "#f2d04b", "#378add", "#d4537e", "#1d9e75"][i] })),
      { kind: "counter", x: 0, y: 12, w: 4, color: "#e8e1d4" },
      { kind: "plant", x: 19, y: 13 },
    ],
  },
  gm_wall: {
    look: { wall: "#fff2c9", wall2: "#f2d04b", floor: "#c9dfae", floor2: "#bfd6a2" },
    decor: [
      { kind: "mural", x: 1, y: 0, w: 10, label: "gm", color: "#ef9f27" },
      ...benchRow(4, [2, 4, 7, 9], "bench", N, "#8a5a2b"),
      { kind: "plant", x: 0, y: 7 },
      { kind: "plant", x: 11, y: 7 },
      { kind: "lamp", x: 0, y: 2 },
      { kind: "lamp", x: 11, y: 2 },
    ],
  },
  faucet: {
    look: { wall: "#dbeaf6", wall2: "#85b7eb", floor: "#e8e1d4", floor2: "#ddd5c6" },
    decor: [
      { kind: "sign", x: 3, y: 0, w: 4, label: "THE FAUCET", color: "#378add" },
      { kind: "fountain", x: 4, y: 2, w: 2, d: 2, color: "#85b7eb" },
      { kind: "bench", x: 1, y: 3, seat: "bench1", facing: E, color: "#8a5a2b" },
      { kind: "bench", x: 8, y: 3, seat: "bench2", facing: W, color: "#8a5a2b" },
      { kind: "plant", x: 0, y: 0 },
      { kind: "plant", x: 9, y: 0 },
    ],
  },
  crew_row: {
    look: { wall: "#c9b8a6", wall2: "#a8937e", floor: "#9a9a94", floor2: "#8f8f89" },
    decor: [
      ...[0, 5, 10, 15, 20, 25].map((x, i): Decor => ({ kind: "house", x, y: 0, w: 5, color: ["#efc6a8", "#f4c0d1", "#c0dd97", "#b5d4f4", "#fac775", "#d3c6f0"][i], label: String(i + 1) })),
      ...[2, 7, 12, 17, 22, 27].map((x): Decor => ({ kind: "lamp", x, y: 2 })),
      ...[4, 14, 24].map((x, i): Decor => ({ kind: "bench", x, y: 5, seat: `bench${i + 1}`, facing: N, color: "#8a5a2b" })),
      ...[9, 19].map((x): Decor => ({ kind: "plant", x, y: 5 })),
    ],
  },
  bunker: {
    look: { wall: "#26302a", wall2: "#3b4a3f", floor: "#1e2420", floor2: "#232a25" },
    decor: [
      { kind: "screen", x: 2, y: 0, w: 8, label: "BUNKER", color: "#1d9e75" },
      { kind: "war_table", x: 4, y: 4, w: 4, d: 2, color: "#3b4a3f" },
      ...[4, 5, 6, 7].flatMap((x, i): Decor[] => [
        { kind: "stool", x, y: 3, seat: `n${i + 1}`, facing: S, color: "#5c6b3a" },
        { kind: "stool", x, y: 6, seat: `s${i + 1}`, facing: N, color: "#5c6b3a" },
      ]),
      { kind: "lamp", x: 0, y: 0 },
      { kind: "lamp", x: 11, y: 0 },
    ],
  },
};

// How high each kind of seat is, so a seated resident sits on it, not in it.
export const SEAT_H: Partial<Record<DecorKind, number>> = { stool: 0.66, bench: 0.46, booth_bench: 0.48, sofa: 0.44, beanbag: 0.32 };

// The layout for a room ("bunker:<id>:yes" uses the bunker's, tinted by side).
export function layoutFor(place: string): Layout | null {
  const kind = place.split(":")[0]!;
  const l = LAYOUTS[kind];
  if (!l) return null;
  if (kind === "bunker" && place.endsWith(":no")) {
    return { look: { ...l.look, wall: "#33201f", wall2: "#4a2b2a", floor: "#241a19", floor2: "#2a1f1e" }, decor: l.decor.map((d) => (d.kind === "screen" ? { ...d, color: "#e24b4a" } : d)) };
  }
  return l;
}

export function planFor(place: string): Plan | null {
  const size = ROOM_SIZE[place.split(":")[0]!];
  const l = layoutFor(place);
  if (!size || !l) return null;
  const seats: Seat[] = l.decor.filter((d) => d.seat).map((d) => ({ id: d.seat!, x: d.x, y: d.y, facing: d.facing ?? 0, h: SEAT_H[d.kind] ?? 0.45 }));
  return makePlan(size.w, size.h, l.decor.filter(blocksWalk).map((d) => ({ x: d.x, y: d.y, w: d.w ?? 1, d: d.d ?? 1 })), seats);
}
