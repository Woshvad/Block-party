import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WALL_MARGIN, findPath, free, makePlan, nearestFree, toWorld } from "../src/plan";

describe("findPath", () => {
  it("walks around a sofa instead of through it", () => {
    // A 3-wide sofa across the middle of a 7×5 room.
    const p = makePlan(7, 5, [{ x: 2, y: 2, w: 3, d: 1 }]);
    const path = findPath(p, { x: 3, y: 0 }, { x: 3, y: 4 });
    expect(path.at(-1)).toEqual({ x: 3, y: 4 });
    for (const t of path) expect(free(p, t)).toBe(true);
    expect(path.length).toBeGreaterThan(4); // the straight line would be 4 steps
  });

  it("never squeezes diagonally between two blocked tiles", () => {
    const p = makePlan(3, 3, [
      { x: 1, y: 0, w: 1, d: 1 },
      { x: 0, y: 1, w: 1, d: 1 },
    ]);
    // From (0,0) the only ways out are diagonal past both corners: refused.
    expect(findPath(p, { x: 0, y: 0 }, { x: 2, y: 2 })).toEqual([]);
  });

  it("a blocked target goes to the nearest free tile; a sealed-off one gives no path", () => {
    const p = makePlan(5, 5, [{ x: 2, y: 2, w: 1, d: 1 }]);
    const path = findPath(p, { x: 0, y: 0 }, { x: 2, y: 2 });
    expect(free(p, path.at(-1)!)).toBe(true);
    const sealed = makePlan(5, 5, [
      { x: 3, y: 0, w: 1, d: 5 },
    ]);
    expect(findPath(sealed, { x: 0, y: 0 }, { x: 4, y: 4 }).at(-1)?.x ?? 0).toBeLessThan(3);
  });

  it("any room, any walk: every step is free, adjacent, and never cuts a corner", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 20 }),
        fc.integer({ min: 3, max: 16 }),
        fc.array(fc.record({ x: fc.integer({ min: 0, max: 19 }), y: fc.integer({ min: 0, max: 15 }), w: fc.integer({ min: 1, max: 4 }), d: fc.integer({ min: 1, max: 3 }) }), { maxLength: 12 }),
        fc.record({ x: fc.integer({ min: -2, max: 22 }), y: fc.integer({ min: -2, max: 18 }) }),
        fc.record({ x: fc.integer({ min: -2, max: 22 }), y: fc.integer({ min: -2, max: 18 }) }),
        (w, h, blocks, a, b) => {
          const p = makePlan(w, h, blocks);
          const start = nearestFree(p, a);
          const path = findPath(p, a, b);
          let prev = start;
          for (const t of path) {
            if (!free(p, t) || !prev) return false;
            const dx = t.x - prev.x;
            const dy = t.y - prev.y;
            if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return false;
            if (dx && dy && (!free(p, { x: prev.x + dx, y: prev.y }) || !free(p, { x: prev.x, y: prev.y + dy }))) return false;
            prev = t;
          }
          return true;
        },
      ),
      { seed: 5, numRuns: 400 },
    );
  });
});

describe("toWorld", () => {
  it("keeps every tile, edges included, a body's width off the walls", () => {
    for (const [w, h] of [[8, 8], [16, 12], [30, 8]] as const)
      for (let x = 0; x < w; x++)
        for (let y = 0; y < h; y++) {
          const p = toWorld({ w, h }, { x, y });
          expect(Math.abs(p.x)).toBeLessThanOrEqual(w / 2 - WALL_MARGIN + 1e-9);
          expect(Math.abs(p.z)).toBeLessThanOrEqual(h / 2 - WALL_MARGIN + 1e-9);
        }
  });
});
