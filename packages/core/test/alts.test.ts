import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { altFlag, marketPairFlows } from "../src";

describe("alt checks", () => {
  it("over 500 one way with under 20% back is flagged; the direction is the bigger flow", () => {
    expect(altFlag({ a: "a", b: "b", ab: 500, ba: 0 })).toBeNull();
    expect(altFlag({ a: "a", b: "b", ab: 501, ba: 0 })).toEqual({ from: "a", to: "b", amount: 501, back: 0 });
    expect(altFlag({ a: "a", b: "b", ab: 1000, ba: 199 })).toEqual({ from: "a", to: "b", amount: 1000, back: 199 });
    expect(altFlag({ a: "a", b: "b", ab: 1000, ba: 200 })).toBeNull(); // 20% back: a fair rivalry
    expect(altFlag({ a: "a", b: "b", ab: 50, ba: 900 })).toEqual({ from: "b", to: "a", amount: 900, back: 50 });
  });

  it("a City market's losers pay winners by stake", () => {
    const f = marketPairFlows(
      [
        { userId: "w1", side: "yes", stake: 100 },
        { userId: "w2", side: "yes", stake: 300 },
        { userId: "l1", side: "no", stake: 200 },
      ],
      true,
    );
    expect(f).toEqual([
      { from: "l1", to: "w1", amount: 50 },
      { from: "l1", to: "w2", amount: 150 },
    ]);
    expect(marketPairFlows([{ userId: "x", side: "no", stake: 10 }], true)).toEqual([]);
  });

  it("pair flows never exceed what the losers staked", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ userId: fc.constantFrom("a", "b", "c", "d"), side: fc.constantFrom("yes", "no") as fc.Arbitrary<"yes" | "no">, stake: fc.integer({ min: 1, max: 800 }) }), { maxLength: 20 }), fc.boolean(), (ps, o) => {
        const lost = ps.filter((p) => p.side !== (o ? "yes" : "no")).reduce((a, p) => a + p.stake, 0);
        expect(marketPairFlows(ps, o).reduce((a, f) => a + f.amount, 0)).toBeLessThanOrEqual(lost);
      }),
      { seed: 38, numRuns: 2000 },
    );
  });
});
