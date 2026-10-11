import { CATALOGUE } from "@bp/core";
import { expect, it } from "vitest";
import { furnitureGeometry } from "../src/furnitureGeometry";
import { footprintSize, pieceHeight } from "../src/furniture";

it("detailed furniture stays inside its validated footprint at every rotation", () => {
  for (const p of CATALOGUE.values()) {
    if (p.layer !== "floor" && p.layer !== "rug") continue;
    for (const rot of [0, 90, 180, 270]) {
      const geo = furnitureGeometry(p.id, p.w * 0.94, pieceHeight(p.id), p.d * 0.94, "#8b7355");
      geo.rotateY(rot * Math.PI / 180);
      geo.computeBoundingBox();
      const f = footprintSize(p.id, rot);
      const bounds = geo.boundingBox!;
      expect(Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x)), p.id).toBeLessThanOrEqual(f.w / 2);
      expect(Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z)), p.id).toBeLessThanOrEqual(f.d / 2);
      expect(geo.getAttribute("color").count).toBe(geo.getAttribute("position").count);
      geo.dispose();
    }
  }
});
