import { LOOK_PARTS } from "@bp/core";
import { describe, expect, it } from "vitest";
import { BODY, GLASSES_NAMES, HAIR_NAMES, HAT_NAMES, geo, glassesGeo, hairGeo, hatGeo, triangles } from "../src/chibi/parts";

describe("chibi parts", () => {
  it("one shape for every hair, hat and glasses a resident can pick, and every one builds", () => {
    expect(hairGeo).toHaveLength(LOOK_PARTS.hair.length - 1); // "none" has no shape
    expect(hatGeo).toHaveLength(LOOK_PARTS.hat.length - 1);
    expect(glassesGeo).toHaveLength(LOOK_PARTS.glasses.length - 1);
    expect([HAIR_NAMES.length, HAT_NAMES.length, GLASSES_NAMES.length]).toEqual([hairGeo.length, hatGeo.length, glassesGeo.length]);
    for (const g of [...hairGeo, ...hatGeo, ...glassesGeo, ...Object.values(geo)]) {
      expect(g).toBeTruthy();
      expect(g.getAttribute("position").count).toBeGreaterThan(0);
      expect(g.getAttribute("normal")).toBeTruthy();
      g.computeBoundingBox();
      for (const v of [g.boundingBox!.min, g.boundingBox!.max]) expect([v.x, v.y, v.z].every(Number.isFinite)).toBe(true);
    }
  });

  it("hair never comes down over the eyes: the front stays above the eye line", () => {
    // The eyes sit around the head's equator (y = 0). Hair that is outside the
    // head, in front of the face (|x| < 0.15), must stay above that line; hair
    // inside the head is hidden by it.
    const R = BODY.headR;
    const surfaceZ = (x: number, y: number) => R * Math.sqrt(Math.max(0, 1 - (x / (1.06 * R)) ** 2 - (y / (0.96 * R)) ** 2));
    for (const [i, g] of hairGeo.entries()) {
      const p = g.getAttribute("position");
      for (let k = 0; k < p.count; k++) {
        const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
        if (z > 0 && Math.abs(x) < 0.15 && z > surfaceZ(x, y) - 0.005) expect(y, `${HAIR_NAMES[i]} at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`).toBeGreaterThan(0.06);
      }
    }
  });
});

describe("triangle budget", () => {
  it("the most expensive resident stays inside the plan's 3,000 triangles, outlines included", () => {
    const max = (gs: { index: unknown }[]) => Math.max(...gs.map((g) => triangles(g as never)));
    // Outlined: head, body, hair, hat. Not outlined: face, glasses, limbs, shoes, shadow.
    const worst =
      2 * (triangles(geo.head) + triangles(geo.body) + max(hairGeo) + max(hatGeo)) +
      triangles(geo.face) + max(glassesGeo) + 2 * (triangles(geo.leg) + triangles(geo.arm) + triangles(geo.shoe)) + triangles(geo.blob);
    expect(worst).toBeLessThanOrEqual(3000);
  });
});
