import { CATALOGUE, ROOM_SIZE as HOME_SIZE, type RoomKind, validatePlacement } from "@bp/core";
import type { Placement, PlacedItem } from "./api";
import { OUTFIT } from "./palette";

// How each piece looks: a block sized by its footprint, a height by kind, and
// one of the 16 colours. Pure helpers, shared by the home editor and the live room.

export const pieceOf = (id: string) => CATALOGUE.get(id) ?? null;

const HEIGHTS: [RegExp, number][] = [
  [/rug/, 0.03],
  [/bed|hammock/, 0.5],
  [/stool|guestbook/, 0.5],
  [/desk|table|counter/, 0.75],
  [/sofa|couch|beanbag/, 0.8],
  [/lamp|neon_lamp|gm_lamp/, 1.5],
  [/server_rack|arcade/, 1.8],
  [/statue|bull|bear/, 1.4],
  [/plant|cactus|monstera/, 0.9],
  [/tv|aquarium/, 0.95],
  [/trophy/, 0.9],
];
export function pieceHeight(id: string): number {
  for (const [re, h] of HEIGHTS) if (re.test(id)) return h;
  return 0.7;
}

// Colour 0 is each piece's own natural colour (by kit style for kit pieces);
// 1 to 15 are the shared palette.
const NATURAL: [RegExp, string][] = [
  [/^kit_neon_/, "#6d4fd8"],
  [/^kit_minimal_/, "#e8e6df"],
  [/bed|hammock|sofa/, "#c98b6b"],
  [/desk|table|stool|guestbook|counter/, "#8a5a2b"],
  [/lamp/, "#f2d04b"],
  [/rug/, "#c46a5a"],
  [/poster|mural|sign|neon/, "#534ab7"],
  [/plant|cactus|monstera/, "#3b8a3e"],
  [/tv|crt|server|arcade/, "#2c2c2a"],
  [/aquarium/, "#3ab5c9"],
  [/bull|trophy/, "#d4a017"],
  [/bear/, "#7a4a2a"],
];
export function pieceColor(pieceId: string, color: number): string {
  if (color > 0 && color < 16) return OUTFIT[color - 1]!;
  for (const [re, c] of NATURAL) if (re.test(pieceId)) return c;
  return "#b9a58c";
}

export const WALL_COLORS: Record<string, string> = { plaster: "#efc6a8", brick: "#b5654a", neon_grid: "#2b1a4f", wood: "#a0703f", terminal_green: "#123a26", candle_red: "#5a1f1f" };
export const FLOOR_COLORS: Record<string, string> = { boards: "#b08355", concrete: "#9a9a94", checker: "#3a3a42", carpet: "#6b4f8a", tatami: "#c9b77a", glass_led: "#2d3b5a" };

export const homeSize = (tier: string) => HOME_SIZE[(tier in HOME_SIZE ? tier : "tenement") as RoomKind];

// The footprint turned with the piece.
export function footprintSize(id: string, rot: number) {
  const p = pieceOf(id);
  const w = p?.w ?? 1;
  const d = p?.d ?? 1;
  return rot === 90 || rot === 270 ? { w: d, d: w } : { w, d };
}

// Checks a placement exactly as the API will, against everything else in the room.
export function checkPlacement(tier: string, pieceId: string, placement: Placement, placed: PlacedItem[], movingItemId?: string): string | null {
  const piece = pieceOf(pieceId);
  if (!piece) return "unknown piece";
  const others = placed.filter((p) => p.itemId !== movingItemId).flatMap((p) => {
    const op = pieceOf(p.pieceId);
    return op ? [{ piece: op, placement: p.placement }] : [];
  });
  try {
    validatePlacement((tier in HOME_SIZE ? tier : "tenement") as RoomKind, piece, placement, others as never);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "can't go there";
  }
}

// First free spot for a new piece (scanning the floor, or along the walls).
export function firstFreeSpot(tier: string, pieceId: string, placed: PlacedItem[]): Placement | null {
  const piece = pieceOf(pieceId);
  if (!piece || piece.layer === "wardrobe") return null;
  const size = homeSize(tier);
  if (piece.layer === "wall") {
    for (const wall of ["n", "w", "e", "s"] as const) {
      const len = wall === "n" || wall === "s" ? size.w : size.d;
      for (let offset = 0; offset <= len - piece.w; offset++) {
        const pl: Placement = { layer: "wall", wall, offset, color: 0 };
        if (!checkPlacement(tier, pieceId, pl, placed)) return pl;
      }
    }
    return null;
  }
  for (let y = 0; y < size.d; y++)
    for (let x = 0; x < size.w; x++)
      for (const rot of [0, 90] as const) {
        const pl: Placement = { layer: piece.layer as "floor" | "rug", x, y, rot, color: 0 };
        if (!checkPlacement(tier, pieceId, pl, placed)) return pl;
      }
  return null;
}

export const nextRot = (r: number) => (((r + 90) % 360) as 0 | 90 | 180 | 270);
