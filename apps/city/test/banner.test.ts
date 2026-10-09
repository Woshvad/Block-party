import { DEFAULT_BANNER, validateBanner } from "@bp/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { paintAt } from "../src/banner";

describe("paintAt", () => {
  it("any sequence of paints keeps a banner the API accepts", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 7 }), fc.integer({ min: 0, max: 15 }), fc.integer({ min: 0, max: 15 })), { maxLength: 80 }), (strokes) => {
        let b = DEFAULT_BANNER;
        for (const [r, c, color] of strokes) b = paintAt(b, r, c, color);
        validateBanner(b);
        return true;
      }),
      { seed: 11, numRuns: 300 },
    );
  });

  it("changes only the painted tile", () => {
    const b = paintAt(DEFAULT_BANNER, 2, 5, 12);
    expect(b[2]).toBe("00000c0000000000");
    expect(b.filter((r, i) => i !== 2 && r !== DEFAULT_BANNER[i])).toHaveLength(0);
  });
});
