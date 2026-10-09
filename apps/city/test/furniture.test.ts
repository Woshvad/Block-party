import { CATALOGUE, kitLayout } from "@bp/core";
import { describe, expect, it } from "vitest";
import type { PlacedItem, Placement } from "../src/api";
import { checkPlacement, firstFreeSpot, footprintSize, nextRot, pieceColor, pieceHeight } from "../src/furniture";

const kit = (): PlacedItem[] => kitLayout("cozy").map((k, i) => ({ itemId: `i${i}`, pieceId: k.pieceId, room: "tenement", placement: k.placement as Placement }));

describe("furniture", () => {
  it("the move-in kit is a valid room, by the API's own rule", () => {
    const placed = kit();
    for (const p of placed) expect(checkPlacement("tenement", p.pieceId, p.placement, placed, p.itemId)).toBeNull();
  });

  it("refuses collisions and spots outside the room, like the API", () => {
    const placed = kit();
    const bed = placed.find((p) => p.pieceId === "kit_cozy_bed")!;
    expect(checkPlacement("tenement", "stool", { ...(bed.placement as Placement & { layer: "floor" }), layer: "floor" }, placed)).toMatch(/already there/);
    expect(checkPlacement("tenement", "stool", { layer: "floor", x: 8, y: 0, rot: 0, color: 0 }, placed)).toMatch(/outside/);
    expect(checkPlacement("tenement", "stool", { layer: "floor", x: 4, y: 6, rot: 0, color: 99 }, placed)).toMatch(/colour/);
    // A rug can go under furniture: different layers never collide.
    expect(checkPlacement("tenement", "kit_neon_rug", { layer: "rug", x: 0, y: 0, rot: 0, color: 1 }, placed)).toBeNull();
  });

  it("firstFreeSpot always finds a valid spot, or says there's none", () => {
    for (const id of CATALOGUE.keys()) {
      const spot = firstFreeSpot("tenement", id, kit());
      if (CATALOGUE.get(id)!.layer === "wardrobe") expect(spot).toBeNull();
      else if (spot) expect(checkPlacement("tenement", id, spot, kit())).toBeNull();
    }
  });

  it("a full room reports no spot instead of looping", () => {
    const placed: PlacedItem[] = [];
    for (let n = 0; n < 100; n++) {
      const spot = firstFreeSpot("tenement", "stool", placed);
      if (!spot) break;
      placed.push({ itemId: `s${n}`, pieceId: "stool", room: "tenement", placement: spot });
    }
    expect(placed).toHaveLength(64);
    expect(firstFreeSpot("tenement", "stool", placed)).toBeNull();
  });

  it("rotation swaps the footprint and cycles", () => {
    expect(footprintSize("kit_cozy_bed", 0)).toEqual({ w: 2, d: 3 });
    expect(footprintSize("kit_cozy_bed", 90)).toEqual({ w: 3, d: 2 });
    expect([0, 90, 180, 270].map(nextRot)).toEqual([90, 180, 270, 0]);
    expect(pieceHeight("kit_cozy_rug")).toBeLessThan(0.1);
  });

  it("every colour index gives a real colour; 0 is the piece's own", () => {
    for (const id of CATALOGUE.keys()) for (let c = 0; c < 16; c++) expect(pieceColor(id, c)).toMatch(/^#[0-9a-f]{6}$/);
    expect(pieceColor("kit_cozy_desk", 0)).not.toBe(pieceColor("kit_cozy_lamp", 0));
  });
});
