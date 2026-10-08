import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BACKSTORIES,
  BUYABLE_IDS,
  CATALOGUE,
  KIT_STYLES,
  type Piece,
  type Placement,
  PlacementError,
  ROOM_SIZE,
  STARTER_IDS,
  STREAK_PIECES,
  crewRooms,
  getPiece,
  kitFor,
  kitLayout,
  validatePlacement,
} from "../src";

// Prices are frozen once released. Adding a piece means adding a line here;
// changing a released price must fail this test.
const RELEASED_PRICES: Record<string, number> = {
  stool: 15, cactus: 15, plant_small: 20, poster_wagmi: 20, poster_ngmi: 20, mug_rack: 20, floor_lamp: 25,
  cushion_pile: 25, side_table: 30, rug_runner: 30, string_lights: 30, beanbag: 35, rug_round: 40, crate_shelf: 45,
  desk_chair: 50, wall_clock_candle: 80, lava_lamp: 90, plant_monstera: 110, coffee_table: 120, mini_fridge: 140,
  bookshelf: 150, rug_shag: 160, armchair: 180, neon_sign_gm: 220, hammock: 260, sofa: 300, gaming_desk: 350,
  double_bed: 400, aquarium: 450, mural_genesis: 800, server_rack: 900, crt_wall: 1200, arcade_cabinet: 1500,
  golden_bull: 2400, bear_statue: 2400, lambo_bed: 3000, guestbook: 60, trophy_wall: 150, slate_board: 200, tv: 300,
};

const piece = (id: string) => getPiece(id)!;
const reason = (fn: () => unknown) => {
  try {
    fn();
    return "OK";
  } catch (e) {
    if (e instanceof PlacementError) return e.reason;
    throw e;
  }
};

describe("catalogue", () => {
  it("released prices never change", () => {
    const now = Object.fromEntries(BUYABLE_IDS.map((id) => [id, piece(id).price]));
    expect(now).toEqual(RELEASED_PRICES);
  });

  it("has about 40 pieces for sale, inside the plan's bands", () => {
    expect(BUYABLE_IDS.length).toBeGreaterThanOrEqual(38);
    expect(BUYABLE_IDS.length).toBeLessThanOrEqual(45);
    const bands: Record<string, [number, number]> = { basic: [15, 60], everyday: [60, 600], statement: [600, 3000], working: [60, 400] };
    for (const id of BUYABLE_IDS) {
      const { band, price } = piece(id);
      const [lo, hi] = bands[band]!;
      expect(price, id).toBeGreaterThanOrEqual(lo);
      expect(price, id).toBeLessThanOrEqual(hi);
    }
  });

  it("the move-in gift can furnish a room from basics", () => {
    const basics = BUYABLE_IDS.filter((id) => piece(id).band === "basic").map((id) => piece(id).price!);
    expect(basics.reduce((a, b) => a + b, 0)).toBeLessThan(1000);
  });

  it("working pieces match the plan's prices", () => {
    expect(Object.fromEntries(BUYABLE_IDS.filter((id) => piece(id).band === "working").map((id) => [id, piece(id).price]))).toEqual({
      guestbook: 60,
      trophy_wall: 150,
      slate_board: 200,
      tv: 300,
    });
  });

  it("kit, starter and earned pieces are never for sale", () => {
    for (const p of CATALOGUE.values()) {
      if (["kit", "starter", "earned"].includes(p.band)) expect(p.price, p.id).toBeNull();
      else expect(p.price, p.id).not.toBeNull();
    }
  });

  it("every kit style has bed, desk, lamp, rug and poster", () => {
    for (const s of KIT_STYLES) expect(kitFor(s).map((id) => id.split("_").at(-1))).toEqual(["bed", "desk", "lamp", "rug", "poster"]);
  });

  it("every backstory's starter item is in the catalogue and unsellable", () => {
    for (const b of Object.values(BACKSTORIES)) {
      expect(STARTER_IDS).toContain(b.starterItem);
      expect(piece(b.starterItem).price).toBeNull();
    }
  });

  it("streak cards map to earned pieces", () => {
    for (const id of Object.values(STREAK_PIECES)) expect(piece(id).band).toBe("earned");
  });

  it("a bed always offers Rested and a sofa Cozy, whatever the price", () => {
    for (const id of ["double_bed", "lambo_bed", "kit_neon_bed", "kit_cozy_bed"]) expect(piece(id).mood).toBe("rested");
    for (const id of ["sofa", "beanbag", "armchair"]) expect(piece(id).mood).toBe("cozy");
  });

  it("getPiece refuses garbage", () => {
    for (const bad of [undefined, null, 1, "nope", "__proto__", "constructor", {}]) expect(getPiece(bad)).toBeNull();
  });

  it("every piece fits in the smallest room", () => {
    for (const p of CATALOGUE.values()) {
      if (p.layer === "wardrobe") continue;
      expect(Math.max(p.w, p.d), p.id).toBeLessThanOrEqual(ROOM_SIZE.tenement.w);
    }
  });
});

describe("placement", () => {
  const F = (x: number, y: number, rot = 0, color = 0) => ({ layer: "floor", x, y, rot, color });
  const R = (x: number, y: number) => ({ layer: "rug", x, y, rot: 0, color: 0 });
  const W = (wall: string, offset: number, color = 0) => ({ layer: "wall", wall, offset, color });
  const put = (id: string, pl: unknown, others: Array<{ piece: Piece; placement: Placement }> = [], room: "tenement" | "lounge" = "tenement") =>
    reason(() => validatePlacement(room, piece(id), pl, others));
  const placed = (id: string, pl: unknown) => ({ piece: piece(id), placement: validatePlacement("tenement", piece(id), pl, []) });

  it("keeps pieces inside the room, accounting for rotation", () => {
    // sofa is 3x1: at x=5 it fills 5..7 (fits), at x=6 it doesn't
    expect(put("sofa", F(5, 0))).toBe("OK");
    expect(put("sofa", F(6, 0))).toBe("outside the room");
    // turned 90 it's 1x3: x=7 fits, y=6 doesn't
    expect(put("sofa", F(7, 5, 90))).toBe("OK");
    expect(put("sofa", F(7, 6, 90))).toBe("outside the room");
    expect(put("sofa", F(-1, 0))).toBe("outside the room");
  });

  it("refuses overlaps on the same layer, allows rugs under furniture", () => {
    const bed = placed("double_bed", F(0, 0)); // 2x3: (0..1, 0..2)
    expect(put("stool", F(1, 2), [bed])).toBe("something is already there");
    expect(put("stool", F(2, 2), [bed])).toBe("OK");
    expect(put("rug_round", R(1, 1), [bed])).toBe("OK");
    const rug = placed("rug_round", R(4, 4));
    expect(put("rug_runner", R(5, 2), [rug])).toBe("something is already there");
  });

  it("wall pieces stay on the wall and don't overlap there", () => {
    expect(put("trophy_wall", W("n", 5))).toBe("OK");
    expect(put("trophy_wall", W("n", 6))).toBe("off the wall");
    const tw = placed("trophy_wall", W("n", 0)); // n:0..2
    expect(put("poster_wagmi", W("n", 2), [tw])).toBe("something is already there");
    expect(put("poster_wagmi", W("s", 2), [tw])).toBe("OK");
  });

  it("refuses garbage, wrong layers, colours and rotations", () => {
    for (const bad of [null, [], "x", {}, F(0, 0, 45), F(0, 0, 0, 16), F(0, 0, 0, -1), F(0.5, 0), F(NaN, 0), { ...F(0, 0), x: "1" }, W("up", 0), W("n", 0, 1.5)]) {
      expect(put("stool", bad)).not.toBe("OK");
    }
    expect(put("stool", W("n", 0))).toMatch(/floor layer/);
    expect(put("poster_wagmi", F(0, 0))).toMatch(/wall layer/);
    expect(put("rug_round", F(0, 0))).toMatch(/rug layer/);
    expect(put("tee_exit_liquidity", F(0, 0))).toMatch(/wearables/);
  });

  it("returns a clean copy: extra fields never get stored", () => {
    const out = validatePlacement("tenement", piece("stool"), { ...F(1, 1), evil: "x", __proto__: { admin: true } }, []);
    expect(out).toEqual({ layer: "floor", x: 1, y: 1, rot: 0, color: 0 });
  });

  it("bigger rooms allow bigger layouts", () => {
    expect(put("sofa", F(7, 9), [], "lounge")).toBe("OK");
    expect(put("sofa", F(7, 9), [], "tenement")).toBe("outside the room");
  });

  it("the move-in kit layout is valid in every style", () => {
    for (const s of KIT_STYLES) {
      const done: Array<{ piece: Piece; placement: Placement }> = [];
      for (const k of kitLayout(s)) {
        expect(reason(() => validatePlacement("tenement", piece(k.pieceId), k.placement, done)), k.pieceId).toBe("OK");
        done.push({ piece: piece(k.pieceId), placement: k.placement });
      }
    }
  });

  it("whatever it accepts never overlaps (random layouts)", () => {
    const floorIds = BUYABLE_IDS.filter((id) => piece(id).layer === "floor");
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.constantFrom(...floorIds), x: fc.integer({ min: 0, max: 7 }), y: fc.integer({ min: 0, max: 7 }), rot: fc.constantFrom(0, 90, 180, 270) }), { maxLength: 30 }),
        (tries) => {
          const done: Array<{ piece: Piece; placement: Placement }> = [];
          for (const t of tries) {
            try {
              done.push({ piece: piece(t.id), placement: validatePlacement("tenement", piece(t.id), { layer: "floor", x: t.x, y: t.y, rot: t.rot, color: 0 }, done) });
            } catch (e) {
              if (!(e instanceof PlacementError)) throw e;
            }
          }
          const seen = new Set<string>();
          for (const d of done) {
            const pl = d.placement as { x: number; y: number; rot: number };
            const turned = pl.rot === 90 || pl.rot === 270;
            const w = turned ? d.piece.d : d.piece.w;
            const dd = turned ? d.piece.w : d.piece.d;
            for (let i = 0; i < w; i++)
              for (let j = 0; j < dd; j++) {
                const c = `${pl.x + i},${pl.y + j}`;
                if (seen.has(c) || pl.x + i > 7 || pl.y + j > 7) return false;
                seen.add(c);
              }
          }
          return true;
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("Crew House rooms", () => {
  it("start with a Lounge and a Trophy Room, grow at 11 and 26 members", () => {
    expect(crewRooms(3)).toEqual(["lounge", "trophy_room"]);
    expect(crewRooms(10)).toHaveLength(2);
    expect(crewRooms(11)).toHaveLength(3);
    expect(crewRooms(25)).toHaveLength(3);
    expect(crewRooms(26)).toHaveLength(4);
  });
});
