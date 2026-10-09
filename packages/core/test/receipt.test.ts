import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RIGHT_LIST, receiptToken, revealAt, rightListScore, rightListSpread, verifyReceiptToken } from "../src";

const S = "r".repeat(40);

describe("receipt links", () => {
  it("round-trip, short, and refuse forgery, other secrets and junk", async () => {
    const id = randomUUID();
    const t = await receiptToken(id, S);
    expect(t.length).toBeLessThan(60);
    expect(await verifyReceiptToken(t, S)).toBe(id);
    expect(await verifyReceiptToken(t, "x".repeat(40))).toBeNull();
    const other = await receiptToken(randomUUID(), S);
    expect(await verifyReceiptToken(`${t.split(".")[0]}.${other.split(".")[1]}`, S)).toBeNull(); // a MAC from another call
    for (const junk of [null, 5, "", "abc", `${t}x`, t.toUpperCase(), "a".repeat(81), `${"0".repeat(32)}.${"A".repeat(22)}`]) expect(await verifyReceiptToken(junk, S)).toBeNull();
    await expect(receiptToken(id, "short")).rejects.toThrow();
  });

  it("no tampered token ever verifies", async () => {
    const t = await receiptToken(randomUUID(), S);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: t.length - 1 }), fc.constantFrom(..."0123456789abcdefABCDEF-_"), async (i, ch) => {
        fc.pre(t[i] !== ch && t[i] !== ".");
        expect(await verifyReceiptToken(t.slice(0, i) + ch + t.slice(i + 1), S)).toBeNull();
      }),
      { seed: 26, numRuns: 300 },
    );
  });

  it("results land at the next bell", () => {
    expect(revealAt(new Date("2031-01-01T13:00:00Z")).toISOString()).toBe("2031-01-02T00:00:00.000Z");
  });
});

describe("the Right List", () => {
  it("Aura ÷ (settled calls + 15): a hot streak of 3 can't beat a steady 40", () => {
    const hot = rightListScore(3 * 2400, 3); // +24 three times
    const steady = rightListScore(40 * 800, 40); // +8 forty times
    expect(steady).toBeGreaterThan(hot);
    expect(rightListScore(0, 0)).toBe(0);
    expect(RIGHT_LIST.minSettled).toBe(10);
  });

  it("a new season starts from 25% of last season's Aura per call, fading as calls come in", () => {
    const fresh = rightListScore(0, 0, { auraCenti: 40 * 800, settled: 40 });
    expect(fresh).toBeCloseTo(0.25 * 8, 6);
    const later = rightListScore(100 * 0, 100, { auraCenti: 40 * 800, settled: 40 });
    expect(later).toBeLessThan(fresh);
    expect(rightListScore(0, 0, { auraCenti: 0, settled: 0 })).toBe(0);
  });

  it("the spread", () => {
    expect(rightListSpread([])).toBe(0);
    expect(rightListSpread([500])).toBe(0);
    expect(rightListSpread([500, 500, 500])).toBe(0);
    expect(rightListSpread([1000, -1000])).toBeGreaterThan(0);
  });
});
