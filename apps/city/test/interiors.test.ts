import { describe, expect, it } from "vitest";
import { LAYOUTS, layoutFor, planFor } from "../src/interiors";
import { findPath, free } from "../src/plan";
import { ROOM_SIZE } from "../src/places";

const PUBLIC = Object.keys(LAYOUTS);

describe("interiors", () => {
  it("every public room has a layout, and every piece sits inside its room", () => {
    for (const k of Object.keys(ROOM_SIZE)) if (k !== "home" && k !== "crew_house") expect(LAYOUTS[k], k).toBeTruthy();
    for (const k of PUBLIC) {
      const { w, h } = ROOM_SIZE[k]!;
      for (const d of LAYOUTS[k]!.decor) {
        expect(d.x, `${k} ${d.kind}`).toBeGreaterThanOrEqual(0);
        expect(d.y, `${k} ${d.kind}`).toBeGreaterThanOrEqual(0);
        expect(d.x + (d.w ?? 1), `${k} ${d.kind}`).toBeLessThanOrEqual(w);
        expect(d.y + (d.d ?? 1), `${k} ${d.kind}`).toBeLessThanOrEqual(h);
      }
    }
  });

  it("where the rooms put newcomers (front and centre) is free, and every seat can be reached from there", () => {
    for (const k of PUBLIC) {
      const p = planFor(k)!;
      const { w, h } = ROOM_SIZE[k]!;
      const door = { x: Math.floor(w / 2), y: h - 1 };
      expect(free(p, door), `${k} door`).toBe(true);
      for (const s of p.seats) {
        const path = findPath(p, door, s);
        expect(path.at(-1), `${k} seat ${s.id}`).toEqual({ x: s.x, y: s.y });
      }
    }
  });

  it("seat ids are unique in a room and match the rooms' rule", () => {
    for (const k of PUBLIC) {
      const ids = planFor(k)!.seats.map((s) => s.id);
      expect(new Set(ids).size, k).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z0-9_-]{1,40}$/);
    }
  });

  it("the NO Bunker is its own colour", () => {
    expect(layoutFor("bunker:x:no")!.look.wall).not.toBe(layoutFor("bunker:x:yes")!.look.wall);
  });
});
