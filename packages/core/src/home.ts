import { BACKSTORIES, KIT_STYLES, type KitStyle } from "./resident";

// --- Catalogue ------------------------------------------------------------

export type Layer = "floor" | "rug" | "wall" | "wardrobe";
export type Band = "basic" | "everyday" | "statement" | "working" | "earned" | "kit" | "starter";
// Ledger kinds that count toward net worth for the broke floor (see daily.ts).
export type BurnKind = "furniture" | "decor";

export type Piece = {
  id: string;
  band: Band;
  layer: Layer;
  w: number; // footprint across (wall pieces: width along the wall)
  d: number; // footprint deep (1 for wall pieces)
  price: number | null; // null: never sold (kit, starter, earned)
  burnKind: BurnKind;
  mood?: "rested" | "cozy";
};

const p = (id: string, band: Band, layer: Layer, w: number, d: number, price: number | null, burnKind: BurnKind = "furniture", mood?: Piece["mood"]): Piece => ({
  id,
  band,
  layer,
  w,
  d,
  price,
  burnKind,
  ...(mood ? { mood } : {}),
});

// A piece's price never changes once it's out. RELEASED_PRICES in the tests
// pins every one; changing a price fails the build.
const BUYABLE: Piece[] = [
  // basics: 15 to 60
  p("stool", "basic", "floor", 1, 1, 15),
  p("cactus", "basic", "floor", 1, 1, 15, "decor"),
  p("plant_small", "basic", "floor", 1, 1, 20, "decor"),
  p("poster_wagmi", "basic", "wall", 1, 1, 20, "decor"),
  p("poster_ngmi", "basic", "wall", 1, 1, 20, "decor"),
  p("mug_rack", "basic", "wall", 1, 1, 20, "decor"),
  p("floor_lamp", "basic", "floor", 1, 1, 25),
  p("cushion_pile", "basic", "floor", 1, 1, 25, "furniture", "cozy"),
  p("side_table", "basic", "floor", 1, 1, 30),
  p("rug_runner", "basic", "rug", 1, 3, 30, "decor"),
  p("string_lights", "basic", "wall", 2, 1, 30, "decor"),
  p("beanbag", "basic", "floor", 1, 1, 35, "furniture", "cozy"),
  p("rug_round", "basic", "rug", 2, 2, 40, "decor"),
  p("crate_shelf", "basic", "floor", 2, 1, 45),
  p("desk_chair", "basic", "floor", 1, 1, 50),
  // everyday: 60 to 600
  p("wall_clock_candle", "everyday", "wall", 1, 1, 80, "decor"),
  p("lava_lamp", "everyday", "floor", 1, 1, 90, "decor"),
  p("plant_monstera", "everyday", "floor", 1, 1, 110, "decor"),
  p("coffee_table", "everyday", "floor", 2, 2, 120),
  p("mini_fridge", "everyday", "floor", 1, 1, 140),
  p("bookshelf", "everyday", "floor", 2, 1, 150),
  p("rug_shag", "everyday", "rug", 3, 2, 160, "decor"),
  p("armchair", "everyday", "floor", 1, 1, 180, "furniture", "cozy"),
  p("neon_sign_gm", "everyday", "wall", 2, 1, 220, "decor"),
  p("hammock", "everyday", "floor", 3, 1, 260, "furniture", "rested"),
  p("sofa", "everyday", "floor", 3, 1, 300, "furniture", "cozy"),
  p("gaming_desk", "everyday", "floor", 2, 1, 350),
  p("double_bed", "everyday", "floor", 2, 3, 400, "furniture", "rested"),
  p("aquarium", "everyday", "floor", 2, 1, 450, "decor"),
  // statement: 600 to 3,000
  p("mural_genesis", "statement", "wall", 3, 1, 800, "decor"),
  p("server_rack", "statement", "floor", 1, 2, 900),
  p("crt_wall", "statement", "wall", 3, 1, 1200, "decor"),
  p("arcade_cabinet", "statement", "floor", 1, 1, 1500),
  p("golden_bull", "statement", "floor", 2, 2, 2400, "decor"),
  p("bear_statue", "statement", "floor", 2, 2, 2400, "decor"),
  p("lambo_bed", "statement", "floor", 2, 4, 3000, "furniture", "rested"),
  // working pieces: one of each per home, the same everywhere
  p("guestbook", "working", "floor", 1, 1, 60),
  p("trophy_wall", "working", "wall", 3, 1, 150, "decor"),
  p("slate_board", "working", "wall", 2, 1, 200),
  p("tv", "working", "floor", 2, 1, 300),
];

const KIT: Piece[] = KIT_STYLES.flatMap((s) => [
  p(`kit_${s}_bed`, "kit", "floor", 2, 3, null, "furniture", "rested"),
  p(`kit_${s}_desk`, "kit", "floor", 2, 1, null),
  p(`kit_${s}_lamp`, "kit", "floor", 1, 1, null),
  p(`kit_${s}_rug`, "kit", "rug", 2, 2, null, "decor"),
  p(`kit_${s}_poster`, "kit", "wall", 1, 1, null, "decor"),
]);

// Backstory starter items: cosmetic, never sold, the same value for everyone.
export const STARTER_ITEM_VALUE = 40;
const STARTER: Piece[] = [
  p("poster_airdrop_baby", "starter", "wall", 1, 1, null, "decor"),
  p("poster_bear_survivor", "starter", "wall", 1, 1, null, "decor"),
  p("tee_exit_liquidity", "starter", "wardrobe", 0, 0, null),
  p("cap_og_kid", "starter", "wardrobe", 0, 0, null),
];

// Earned-only: never priced, the best-looking things in the city.
const EARNED: Piece[] = [
  p("gm_lamp_30", "earned", "floor", 1, 1, null),
  p("neon_100", "earned", "wall", 2, 1, null, "decor"),
  p("called_it_trophy", "earned", "floor", 1, 1, null),
  p("league_banner", "earned", "wall", 3, 1, null, "decor"),
  // The Daily Clue Hunt's trophies (HUNT_TROPHIES in hunt.ts).
  p("poster_clue_map", "earned", "wall", 1, 1, null, "decor"),
  p("magnifier_trophy", "earned", "floor", 1, 1, null),
];

export const CATALOGUE: ReadonlyMap<string, Piece> = new Map([...BUYABLE, ...KIT, ...STARTER, ...EARNED].map((x) => [x.id, x]));
export const BUYABLE_IDS = BUYABLE.map((x) => x.id);
export const STARTER_IDS = STARTER.map((x) => x.id);

export const kitFor = (style: KitStyle) => KIT.filter((k) => k.id.startsWith(`kit_${style}_`)).map((k) => k.id);

// Streak cards that come with an earned piece.
export const STREAK_PIECES: Record<number, string> = { 30: "gm_lamp_30", 100: "neon_100" };

export function getPiece(id: unknown): Piece | null {
  return typeof id === "string" ? (CATALOGUE.get(id) ?? null) : null;
}

// Every backstory's starter item exists in the catalogue.
for (const b of Object.values(BACKSTORIES)) {
  if (!CATALOGUE.has(b.starterItem)) throw new Error(`starter item ${b.starterItem} missing from catalogue`);
}

// --- Finishes -------------------------------------------------------------

export const WALL_FINISHES = ["plaster", "brick", "neon_grid", "wood", "terminal_green", "candle_red"] as const;
export const FLOOR_FINISHES = ["boards", "concrete", "checker", "carpet", "tatami", "glass_led"] as const;

// --- Rooms ----------------------------------------------------------------

export type RoomKind = "tenement" | "lounge" | "trophy_room" | "den" | "rooftop";
export const ROOM_SIZE: Record<RoomKind, { w: number; d: number }> = {
  tenement: { w: 8, d: 8 },
  lounge: { w: 10, d: 10 },
  trophy_room: { w: 10, d: 10 },
  den: { w: 10, d: 10 },
  rooftop: { w: 10, d: 10 },
};

// Crew House rooms grow with the League's size bands (11 and 26 members).
export function crewRooms(members: number): RoomKind[] {
  const rooms: RoomKind[] = ["lounge", "trophy_room"];
  if (members >= 11) rooms.push("den");
  if (members >= 26) rooms.push("rooftop");
  return rooms;
}

// --- Placement ------------------------------------------------------------

export type Wall = "n" | "e" | "s" | "w";
export type Placement =
  | { layer: "floor" | "rug"; x: number; y: number; rot: 0 | 90 | 180 | 270; color: number }
  | { layer: "wall"; wall: Wall; offset: number; color: number };

export const COLORS = 16;

export class PlacementError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "PlacementError";
  }
}

const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;

// Cells a floor or rug piece covers, or the span it takes on a wall.
function footprint(piece: Piece, pl: Placement): string[] {
  if (pl.layer === "wall") {
    return Array.from({ length: piece.w }, (_, i) => `${pl.wall}:${pl.offset + i}`);
  }
  const turned = pl.rot === 90 || pl.rot === 270;
  const w = turned ? piece.d : piece.w;
  const d = turned ? piece.w : piece.d;
  const cells: string[] = [];
  for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) cells.push(`${pl.x + i},${pl.y + j}`);
  return cells;
}

// Checks one placement's shape and bounds, then that it doesn't collide with
// anything already in the room on the same layer. Rugs sit under furniture.
export function validatePlacement(
  room: RoomKind,
  piece: Piece,
  input: unknown,
  others: ReadonlyArray<{ piece: Piece; placement: Placement }>,
): Placement {
  if (piece.layer === "wardrobe") throw new PlacementError("wearables aren't placed in rooms");
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new PlacementError("bad placement");
  const i = input as Record<string, unknown>;
  if (i.layer !== piece.layer) throw new PlacementError(`this piece goes on the ${piece.layer} layer`);
  if (!isInt(i.color, 0, COLORS - 1)) throw new PlacementError("bad colour");
  const size = ROOM_SIZE[room];
  let pl: Placement;
  if (piece.layer === "wall") {
    const wall = i.wall;
    if (wall !== "n" && wall !== "e" && wall !== "s" && wall !== "w") throw new PlacementError("bad wall");
    const length = wall === "n" || wall === "s" ? size.w : size.d;
    if (!isInt(i.offset, 0, length - piece.w)) throw new PlacementError("off the wall");
    pl = { layer: "wall", wall, offset: i.offset, color: i.color };
  } else {
    if (i.rot !== 0 && i.rot !== 90 && i.rot !== 180 && i.rot !== 270) throw new PlacementError("bad rotation");
    const turned = i.rot === 90 || i.rot === 270;
    const w = turned ? piece.d : piece.w;
    const d = turned ? piece.w : piece.d;
    if (!isInt(i.x, 0, size.w - w) || !isInt(i.y, 0, size.d - d)) throw new PlacementError("outside the room");
    pl = { layer: piece.layer as "floor" | "rug", x: i.x, y: i.y, rot: i.rot, color: i.color };
  }
  const mine = new Set(footprint(piece, pl));
  for (const o of others) {
    if (o.placement.layer !== pl.layer) continue;
    if (footprint(o.piece, o.placement).some((c) => mine.has(c))) throw new PlacementError("something is already there");
  }
  return pl;
}

// Default spots for the move-in kit in a tenement, so you move in furnished.
export function kitLayout(style: KitStyle): Array<{ pieceId: string; placement: Placement }> {
  return [
    { pieceId: `kit_${style}_bed`, placement: { layer: "floor", x: 0, y: 0, rot: 0, color: 0 } },
    { pieceId: `kit_${style}_desk`, placement: { layer: "floor", x: 6, y: 0, rot: 0, color: 0 } },
    { pieceId: `kit_${style}_lamp`, placement: { layer: "floor", x: 7, y: 2, rot: 0, color: 0 } },
    { pieceId: `kit_${style}_rug`, placement: { layer: "rug", x: 3, y: 3, rot: 0, color: 0 } },
    { pieceId: `kit_${style}_poster`, placement: { layer: "wall", wall: "n", offset: 3, color: 0 } },
  ];
}
