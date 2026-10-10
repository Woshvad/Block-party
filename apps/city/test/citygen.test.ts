import { describe, expect, it } from "vitest";
import { CITY_SIZE, GRID, LANDMARKS, SQUARE, blockRect, carLoop, fillCity, roads, zoneOf } from "../src/citygen";

const onRoad = (x: number, z: number) =>
  roads().some((r) => (r.along === "x" ? Math.abs(z - r.a) < GRID.road / 2 : Math.abs(x - r.a) < GRID.road / 2)) &&
  // Tower Square paves over the roads inside it.
  !(Math.abs(x - SQUARE.x) < SQUARE.w / 2 && Math.abs(z - SQUARE.z) < SQUARE.d / 2);

describe("the city plan", () => {
  it("blocks and roads tile the city exactly", () => {
    expect(CITY_SIZE).toBe(46);
    const last = blockRect(GRID.blocks - 1, GRID.blocks - 1);
    expect(last.x + last.w / 2 + GRID.road).toBeCloseTo(CITY_SIZE / 2);
    for (let i = 0; i < GRID.blocks; i++) for (let j = 0; j < GRID.blocks; j++) expect(onRoad(blockRect(i, j).x, blockRect(i, j).z)).toBe(false);
  });

  it("is the same city every time (seeded), and different seeds differ", () => {
    expect(fillCity(7)).toEqual(fillCity(7));
    expect(JSON.stringify(fillCity(7))).not.toBe(JSON.stringify(fillCity(8)));
  });

  it("nothing is built on a road, and nothing leaves the city", () => {
    for (const l of fillCity()) {
      expect(onRoad(l.x, l.z), `${l.kind} at ${l.x.toFixed(1)},${l.z.toFixed(1)}`).toBe(false);
      expect(Math.abs(l.x)).toBeLessThan(CITY_SIZE / 2);
      expect(Math.abs(l.z)).toBeLessThan(CITY_SIZE / 2);
    }
  });

  it("every place stands inside the city, off the roads, and nothing filler is built on a landmark block", () => {
    for (const [k, p] of Object.entries(LANDMARKS)) {
      expect(Math.abs(p.x), k).toBeLessThan(CITY_SIZE / 2);
      expect(onRoad(p.x, p.z), k).toBe(false);
    }
    for (let i = 0; i < GRID.blocks; i++)
      for (let j = 0; j < GRID.blocks; j++) {
        const z = zoneOf(i, j);
        if (z === "landmark" || z === "square" || z === "water") {
          const b = blockRect(i, j);
          expect(fillCity().filter((l) => Math.abs(l.x - b.x) < b.w / 2 && Math.abs(l.z - b.z) < b.d / 2)).toEqual([]);
        }
      }
  });

  it("no filler lot is built on the Diner", () => {
    const d = LANDMARKS.diner;
    for (const l of fillCity()) expect(Math.hypot(l.x - d.x, l.z - d.z), l.kind).toBeGreaterThan(1.5);
  });

  it("cars drive on the road, not through blocks", () => {
    const loop = carLoop(0, 0);
    for (const p of loop) expect(onRoad(p.x, p.z) || Math.abs(p.x) >= CITY_SIZE / 2 - GRID.road).toBe(true);
  });
});
