import { describe, expect, it } from "vitest";
import { cityTotal, cityTotalLabel } from "../src/neighbours";

describe("neighbours in the city now", () => {
  it("adds up the places' live headcounts", () => {
    expect(cityTotal({ tower: 4, diner: 7, roof: 0 })).toEqual({ n: 11, partial: false });
    expect(cityTotalLabel(cityTotal({ tower: 4, diner: 7, roof: 0 }))).toBe("11 neighbours in the city now");
    expect(cityTotalLabel(cityTotal({ tower: 1 }))).toBe("1 neighbour in the city now");
    expect(cityTotalLabel(cityTotal({ tower: 1200, diner: 34 }))).toBe("1,234 neighbours in the city now");
  });

  it("a real zero is shown as zero", () => {
    expect(cityTotalLabel(cityTotal({ tower: 0, diner: 0 }))).toBe("0 neighbours in the city now");
  });

  it("unknown is not zero: no counts, or only failed ones, show nothing", () => {
    expect(cityTotal({})).toBeNull(); // before the first poll, or after a failed one
    expect(cityTotal({ tower: null, diner: null })).toBeNull();
    expect(cityTotalLabel(cityTotal({ tower: null }))).toBeNull();
    expect(cityTotalLabel(null)).toBeNull();
  });

  it("a place whose count failed makes the total a floor, not a smaller number passed off as all", () => {
    expect(cityTotal({ tower: 4, diner: null })).toEqual({ n: 4, partial: true });
    expect(cityTotalLabel(cityTotal({ tower: 4, diner: null }))).toBe("4+ neighbours in the city now");
    expect(cityTotalLabel(cityTotal({ tower: 1, diner: null }))).toBe("1+ neighbours in the city now");
  });

  it("junk counts count as unknown, never as people", () => {
    expect(cityTotal({ tower: -3, diner: 2.5, roof: Number.NaN, gm_wall: Infinity, faucet: 2 })).toEqual({ n: 2, partial: true });
    expect(cityTotal({ tower: "5" as unknown as number })).toBeNull();
  });
});
