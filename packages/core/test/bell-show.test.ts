import { describe, expect, it } from "vitest";
import { bellScoreMilli, bellStampFor } from "../src";

describe("the bell show", () => {
  it("Bell Stamps: 25 GM a night, 150 on Sundays", () => {
    expect(bellStampFor("2031-03-09")).toBe(150); // a Sunday
    expect(bellStampFor("2031-03-10")).toBe(25);
  });

  it("Bell Score: chips times stacked multipliers; no chips, no score", () => {
    expect(bellScoreMilli({ chips: 4, longShots: 0, snapsWon: 0, chainDays: 0 })).toBe(4000);
    expect(bellScoreMilli({ chips: 4, longShots: 1, snapsWon: 0, chainDays: 0 })).toBe(6000);
    expect(bellScoreMilli({ chips: 4, longShots: 2, snapsWon: 1, chainDays: 7 })).toBe(Math.round(4 * 2.25 * 2 * 1.25 * 1000));
    expect(bellScoreMilli({ chips: 4, longShots: 0, snapsWon: 0, chainDays: 6 })).toBe(4000);
    expect(bellScoreMilli({ chips: 0, longShots: 3, snapsWon: 2, chainDays: 30 })).toBe(0);
  });
});
