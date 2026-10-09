import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MODIFIERS, type SlateCandidate, eligible, gridText, modifierFor, pickSlate, slateNumber, square, tierOf } from "../src";

const DAY = "2031-03-10";
const at = (h: number) => new Date(Date.parse(`${DAY}T00:00:00Z`) + h * 3_600_000);
const cand = (id: string, price: number, over: Partial<SlateCandidate> = {}): SlateCandidate => ({ id, category: "sports", ladder: null, price, freezesAt: at(16), settlesBy: at(20), infoOnly: false, ...over });

describe("tiers", () => {
  it("Lock over 70, Coin Flip 40-70, Spicy 15-40, Long Shot 5-15; nothing outside", () => {
    expect([99, 71, 70, 40, 39, 15, 14, 5, 4, 1].map(tierOf)).toEqual(["lock", "lock", "coin_flip", "coin_flip", "spicy", "spicy", "long_shot", "long_shot", null, null]);
  });
});

describe("eligibility", () => {
  it("callable 15+ hours, settled before the next bell, never politics or the Odds Wall", () => {
    expect(eligible(cand("a", 50), DAY)).toBe(true);
    expect(eligible(cand("a", 50, { freezesAt: at(14) }), DAY)).toBe(false);
    expect(eligible(cand("a", 50, { settlesBy: at(24) }), DAY)).toBe(false);
    expect(eligible(cand("a", 50, { category: "politics" }), DAY)).toBe(false);
    expect(eligible(cand("a", 50, { infoOnly: true }), DAY)).toBe(false);
  });
});

describe("picking the six", () => {
  it("a full menu fills every tier in order", () => {
    const pool = [cand("L", 80), cand("C1", 50), cand("C2", 60), cand("S1", 30), cand("S2", 20), cand("X", 8), cand("extra", 50)];
    const s = pickSlate(pool, DAY);
    expect(s.map((x) => x.tier)).toEqual(["lock", "coin_flip", "coin_flip", "spicy", "spicy", "long_shot"]);
    expect(s.find((x) => x.slot === 0)!.id).toBe("L");
    expect(s.find((x) => x.slot === 5)!.id).toBe("X");
  });

  it("a missing tier is filled from the nearest one", () => {
    const pool = [cand("C1", 50), cand("C2", 60), cand("C3", 45), cand("S1", 30), cand("S2", 20), cand("S3", 25)];
    const s = pickSlate(pool, DAY);
    expect(s).toHaveLength(6);
    expect(tierOf(pool.find((c) => c.id === s.find((x) => x.slot === 0)!.id)!.price)).toBe("coin_flip"); // no Lock: a Coin Flip
    expect(tierOf(pool.find((c) => c.id === s.find((x) => x.slot === 5)!.id)!.price)).toBe("spicy"); // no Long Shot: a Spicy
  });

  it("every rule holds for any menu, and the menu's order never matters", () => {
    const arb = fc.array(
      fc.record({
        id: fc.uuid(),
        category: fc.constantFrom("crypto", "sports", "culture", "politics", "other") as fc.Arbitrary<SlateCandidate["category"]>,
        ladder: fc.option(fc.constantFrom("btc", "eth", "sol"), { nil: null }),
        price: fc.integer({ min: 1, max: 99 }),
        freezesAt: fc.integer({ min: 10, max: 23 }).map(at),
        settlesBy: fc.integer({ min: 20, max: 30 }).map(at),
        infoOnly: fc.boolean(),
      }),
      { maxLength: 40 },
    );
    fc.assert(
      fc.property(arb, (pool) => {
        const s = pickSlate(pool, DAY);
        const picked = s.map((x) => pool.find((c) => c.id === x.id)!);
        expect(s.length).toBeLessThanOrEqual(6);
        expect(new Set(s.map((x) => x.id)).size).toBe(s.length);
        expect(new Set(s.map((x) => x.slot)).size).toBe(s.length);
        for (const c of picked) expect(eligible(c, DAY)).toBe(true);
        for (const l of ["btc", "eth", "sol"]) expect(picked.filter((c) => c.ladder === l).length).toBeLessThanOrEqual(2);
        const elig = pool.filter((c) => eligible(c, DAY) && tierOf(c.price) !== null);
        if (elig.filter((c) => c.category !== "crypto").length >= 2 && s.length === 6) expect(picked.filter((c) => c.category !== "crypto").length).toBeGreaterThanOrEqual(2);
        expect(pickSlate([...pool].reverse(), DAY)).toEqual(s);
      }),
      { seed: 25, numRuns: 1500 },
    );
  });

  it("two crypto-heavy days still carry 2 non-crypto cards when there are any", () => {
    const pool = [cand("L", 80, { category: "crypto" }), cand("C1", 50, { category: "crypto" }), cand("C2", 60, { category: "crypto" }), cand("S1", 30, { category: "crypto" }), cand("S2", 20, { category: "crypto" }), cand("X", 8, { category: "crypto" }), cand("n1", 55), cand("n2", 25)];
    const s = pickSlate(pool, DAY);
    expect(s.filter((x) => x.id.startsWith("n"))).toHaveLength(2);
  });
});

describe("the modifier, the number and the grid", () => {
  it("one modifier a day, every kind turns up", () => {
    const seen = new Set(Array.from({ length: 60 }, (_, i) => modifierFor(new Date(Date.UTC(2031, 0, 1 + i)).toISOString().slice(0, 10))));
    expect([...seen].sort()).toEqual([...MODIFIERS].sort());
    expect(modifierFor(DAY)).toBe(modifierFor(DAY));
  });

  it("squares by Aura, gold only for a Long Shot YES that hit", () => {
    expect(square(null, "lock", true)).toBe("black");
    expect(square({ side: "yes", auraCenti: 1600 }, "lock", true)).toBe("green");
    expect(square({ side: "yes", auraCenti: 150 }, "lock", true)).toBe("white");
    expect(square({ side: "no", auraCenti: -201 }, "spicy", true)).toBe("red");
    expect(square({ side: "yes", auraCenti: 5000 }, "long_shot", true)).toBe("gold");
    expect(square({ side: "no", auraCenti: 300 }, "long_shot", false)).toBe("green");
    expect(square({ side: "yes", auraCenti: null }, "lock", null)).toBe("pending");
    expect(square({ side: "yes", auraCenti: null }, "lock", null, true)).toBe("void");
  });

  it("the share line", () => {
    expect(slateNumber("2026-10-05")).toBe(1);
    expect(gridText("2026-10-06", ["green", "white", "red", "black", "green", "gold"])).toBe("Block Party #2 🟩⬜🟥⬛🟩🟨");
  });
});
