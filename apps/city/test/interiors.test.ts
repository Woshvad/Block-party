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

  it("screens, signs and murals on the back wall never overlap", () => {
    for (const k of PUBLIC) {
      const panels = LAYOUTS[k]!.decor.filter((d) => d.y === 0 && (d.kind === "screen" || d.kind === "sign" || d.kind === "mural")).sort((a, b) => a.x - b.x);
      for (let i = 1; i < panels.length; i++) expect(panels[i]!.x, `${k} ${panels[i]!.label}`).toBeGreaterThanOrEqual(panels[i - 1]!.x + (panels[i - 1]!.w ?? 1));
    }
  });

  it("nothing tall stands between the Roof's leaderboards and the benches", () => {
    // The bell and lamps are taller than a screen's bottom edge: they keep
    // clear of the 3 rows in front of the screens.
    const roof = LAYOUTS.roof!.decor;
    const screens = roof.filter((d) => d.kind === "screen");
    expect(screens).toHaveLength(3);
    for (const tall of roof.filter((d) => d.kind === "bell" || d.kind === "lamp")) {
      for (const s of screens) {
        const inFront = tall.y < 4 && tall.x < s.x + (s.w ?? 1) && tall.x + (tall.w ?? 1) > s.x;
        expect(inFront, `${tall.kind} at ${tall.x},${tall.y} in front of ${s.label}`).toBe(false);
      }
    }
  });

  it("the NO Bunker is its own colour", () => {
    expect(layoutFor("bunker:x:no")!.look.wall).not.toBe(layoutFor("bunker:x:yes")!.look.wall);
  });
});
