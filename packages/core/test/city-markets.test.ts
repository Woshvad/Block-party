import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bellBurnOn, cityStakeCap, settleCity } from "../src";

describe("City market stakes", () => {
  it("the cap: 25% of your GM, 100 + 10 a day up to 800, 200 before Proof of Neighbour, 10 while tilted", () => {
    expect(cityStakeCap({ balance: 1000, residentDays: 0, pon: true, tilted: false })).toBe(100);
    expect(cityStakeCap({ balance: 1000, residentDays: 30, pon: true, tilted: false })).toBe(250); // 25% of 1,000
    expect(cityStakeCap({ balance: 10_000, residentDays: 30, pon: true, tilted: false })).toBe(400);
    expect(cityStakeCap({ balance: 100_000, residentDays: 365, pon: true, tilted: false })).toBe(800);
    expect(cityStakeCap({ balance: 100_000, residentDays: 365, pon: false, tilted: false })).toBe(200);
    expect(cityStakeCap({ balance: 100_000, residentDays: 365, pon: true, tilted: true })).toBe(10);
    expect(cityStakeCap({ balance: 3, residentDays: 9, pon: true, tilted: false })).toBe(0);
    expect(cityStakeCap({ balance: 1000, residentDays: -5, pon: true, tilted: false })).toBe(100);
  });

  it("the bell burn: 2% of a win over 50, capped at 500", () => {
    expect([50, 51, 100, 1000, 25_000, 100_000].map(bellBurnOn)).toEqual([0, 1, 2, 20, 500, 500]);
  });
});

describe("settling a City market", () => {
  it("winners split the losers' stakes by stake, minus the bell burn", () => {
    const r = settleCity(
      [
        { id: "a", side: "yes", stake: 100 },
        { id: "b", side: "yes", stake: 300 },
        { id: "c", side: "no", stake: 200 },
      ],
      true,
    );
    // a: 100 + 50 (no burn at 50); b: 300 + 150 − 3; c: 0
    expect([...r.payouts.entries()]).toEqual([
      ["a", 150],
      ["b", 447],
      ["c", 0],
    ]);
    expect(r.burned).toBe(3);
    expect(r.dust).toBe(0);
  });

  it("a one-sided market gives everyone their stake back", () => {
    const r = settleCity([{ id: "a", side: "yes", stake: 100 }, { id: "b", side: "yes", stake: 7 }], false);
    expect([...r.payouts.values()]).toEqual([100, 7]);
    expect(r.burned + r.dust).toBe(0);
  });

  it("no GM is ever created: paid + burned + dust = staked, and nobody gets less than nothing", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ side: fc.constantFrom("yes", "no") as fc.Arbitrary<"yes" | "no">, stake: fc.integer({ min: 1, max: 800 }) }), { minLength: 1, maxLength: 60 }),
        fc.boolean(),
        (ps, outcome) => {
          const positions = ps.map((p, i) => ({ id: String(i), ...p }));
          const r = settleCity(positions, outcome);
          const paid = [...r.payouts.values()].reduce((a, b) => a + b, 0);
          const staked = positions.reduce((a, p) => a + p.stake, 0);
          expect(paid + r.burned + r.dust).toBe(staked);
          for (const p of positions) {
            const got = r.payouts.get(p.id)!;
            expect(got).toBeGreaterThanOrEqual(0);
            if (p.side === (outcome ? "yes" : "no")) expect(got).toBeGreaterThanOrEqual(p.stake); // a winner never loses GM
          }
        },
      ),
      { seed: 32, numRuns: 3000 },
    );
  });
});
