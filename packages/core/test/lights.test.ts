import { describe, expect, it } from "vitest";
import { lightsReserve, topBid } from "../src";

describe("Tower Lights", () => {
  it("1,000 GM reserve until a week of winners, then half the median winning bid", () => {
    expect(lightsReserve([])).toBe(1000);
    expect(lightsReserve([5000, 5000, 5000, 5000, 5000, 5000])).toBe(1000);
    expect(lightsReserve([1000, 1200, 3000, 1500, 2000, 1100, 1300])).toBe(650);
    expect(lightsReserve([1, 1, 1, 1, 1, 1, 1])).toBe(1); // never zero
  });

  it("the top bid: the most, then the earliest", () => {
    expect(topBid([])).toBeNull();
    expect(topBid([{ amount: 1500, at: 3 }, { amount: 2000, at: 9 }, { amount: 2000, at: 4 }])).toEqual({ amount: 2000, at: 4 });
  });
});
