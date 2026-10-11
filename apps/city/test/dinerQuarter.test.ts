import { describe, expect, it } from "vitest";
import { buildDinerQuarter, DINER_QUARTER, isDinerShop } from "../src/dinerArchitecture";
import { DINER_BLOCK, fillBlock, fillCity, LANDMARKS } from "../src/citygen";
import { lotPlacements } from "../src/kitcity";

describe("the diner showcase block", () => {
  it("replaces exactly five filler shops, leaving all other kit placements intact", () => {
    const city = fillCity();
    const custom = city.filter(isDinerShop);
    expect(custom).toHaveLength(5);
    expect(custom).toEqual(fillBlock(DINER_BLOCK.bx, DINER_BLOCK.bz).filter(isDinerShop));
    expect(lotPlacements(custom)).toEqual([]);
    expect(lotPlacements(city)).toEqual(lotPlacements(city.filter((l) => !isDinerShop(l))));
    expect(lotPlacements(city).length).toBeGreaterThan(100);
  });

  it("keeps every new surface inside the original block and within a small geometry budget", () => {
    const result = buildDinerQuarter();
    let triangles = 0;
    for (const geometry of Object.values(result)) {
      geometry.computeBoundingBox();
      const bounds = geometry.boundingBox!;
      expect(bounds.min.x).toBeGreaterThanOrEqual(DINER_QUARTER.x - 5);
      expect(bounds.max.x).toBeLessThanOrEqual(DINER_QUARTER.x + 5);
      expect(bounds.min.z).toBeGreaterThanOrEqual(DINER_QUARTER.z - 5);
      expect(bounds.max.z).toBeLessThanOrEqual(DINER_QUARTER.z + 5);
      expect(bounds.max.y).toBeLessThan(5);
      expect(geometry.getAttribute("color").count).toBe(geometry.getAttribute("position").count);
      triangles += geometry.getAttribute("position").count / 3;
      geometry.dispose();
    }
    expect(triangles).toBeLessThan(18000);
    expect(LANDMARKS.diner.x).toBeCloseTo(DINER_QUARTER.x - 10 / 3);
    expect(LANDMARKS.diner.z).toBeCloseTo(DINER_QUARTER.z - 10 / 3);
  });
});
