import { describe, expect, it } from "vitest";
import { due } from "../src/clock";

describe("redraws on a scene clock", () => {
  it("draws first, then once per period", () => {
    expect(due(null, 0, 1.2)).toBe(true);
    expect(due(5, 5.5, 1.2)).toBe(false);
    expect(due(5, 6.2, 1.2)).toBe(true);
  });

  it("draws at once when the clock has started again (the board hidden, then shown)", () => {
    // Last drawn 300 s in; shown again, the clock reads 0.2 s.
    expect(due(300, 0.2, 1.2)).toBe(true);
  });
});
