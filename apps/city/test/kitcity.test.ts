import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cityPlacements, roadPlacements } from "../src/kitcity";

describe("the kit city", () => {
  it("every model it places is a real file in public/assets", () => {
    const urls = new Set(cityPlacements().map((p) => p.url));
    expect(urls.size).toBeGreaterThan(20);
    for (const u of urls) expect(existsSync(new URL(`../public${u}`, import.meta.url)), u).toBe(true);
  });

  it("covers the roads with tiles and never stacks two tiles on one spot", () => {
    const r = roadPlacements();
    const spots = new Set(r.map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`));
    expect(spots.size).toBe(r.length);
    expect(r.length).toBeGreaterThan(150);
  });

  it("the packs' CC0 licences ship with them", () => {
    for (const p of ["roads", "commercial", "suburban"]) expect(existsSync(new URL(`../public/assets/kenney/${p}/License.txt`, import.meta.url)), p).toBe(true);
  });

  it("asks for the road models before any building, so the streets draw first", () => {
    // Kit.tsx gives each model its own Suspense and asks for them in this order.
    const order = [...new Set(cityPlacements().map((p) => p.url))];
    const firstOther = order.findIndex((u) => !u.includes("/roads/"));
    const roadModels = new Set(roadPlacements().map((p) => p.url));
    expect(order.slice(0, roadModels.size).every((u) => roadModels.has(u))).toBe(true);
    expect(firstOther).toBeGreaterThanOrEqual(roadModels.size);
  });
});
