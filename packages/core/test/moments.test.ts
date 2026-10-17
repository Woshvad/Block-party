import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MOMENTS, type TowerMoment, hasScreen, parseMoment, swingBucket, swingOf } from "../src";

const T = 1_800_000_000_000;
const MIN = 60_000;
const MARKET = "0b7e8c1a-3f2d-4c5b-9a8e-7d6c5b4a3f2e";
const swing: TowerMoment = { id: "m1", kind: "swing", marketId: MARKET, question: "Will Lagos FC win?", from: 41, to: 63, at: T };
const settled: TowerMoment = { id: "m2", kind: "settled", marketId: MARKET, question: "Will Lagos FC win?", outcome: "yes", from: 34, at: T };
// Ticks a minute apart, oldest first, ending at T.
const ticks = (...prices: number[]) => prices.map((price, i) => ({ price, at: T - (prices.length - 1 - i) * MIN }));

describe("the swing rule", () => {
  it("15 points within the window is a swing, from the price farthest from now; 14 isn't", () => {
    expect(swingOf(ticks(41, 45, 52, 63), T)).toEqual({ from: 41, to: 63 });
    expect(swingOf(ticks(63, 55, 48), T)).toEqual({ from: 63, to: 48 }); // down counts too
    expect(swingOf(ticks(50, 64), T)).toBeNull(); // 14 points
    expect(swingOf(ticks(50, 65), T)).toEqual({ from: 50, to: 65 }); // exactly 15
    // Up and back: it's where the price is now that counts, against the farthest point.
    expect(swingOf(ticks(40, 70, 42), T)).toEqual({ from: 70, to: 42 });
    expect(swingOf(ticks(40, 56, 48), T)).toBeNull(); // 16 up, then half of it back: 8 from either end
  });

  it("only the last 30 minutes count, both ends included, and nothing after now", () => {
    const at = (price: number, minutesAgo: number) => ({ price, at: new Date(T - minutesAgo * MIN) });
    expect(swingOf([at(40, MOMENTS.swingWindowMinutes), at(60, 0)], T)).toEqual({ from: 40, to: 60 });
    expect(swingOf([at(40, MOMENTS.swingWindowMinutes + 1 / 60), at(60, 0)], T)).toBeNull();
    expect(swingOf([at(40, 5), at(60, -1)], T)).toBeNull(); // a tick from after now is ignored
    expect(swingOf([at(60, 0)], T)).toBeNull(); // one tick is no move
    expect(swingOf([], T)).toBeNull();
  });

  it("ties go to the earliest price; junk prices are skipped", () => {
    // 30 and 70 are both 20 from 50: the earlier one is where it came from.
    expect(swingOf(ticks(70, 30, 50), T)).toEqual({ from: 70, to: 50 });
    expect(swingOf([...ticks(40, 60), { price: 0, at: T - MIN / 2 }, { price: 150, at: T - MIN / 3 }], T)).toEqual({ from: 40, to: 60 });
  });

  it("is a move of at least 15 between real ticks in the window, ending at the latest (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ price: fc.integer({ min: 1, max: 99 }), ago: fc.integer({ min: -5, max: 40 }) }), { maxLength: 40 }), (raw) => {
        const list = raw.map((r) => ({ price: r.price, at: T - r.ago * MIN }));
        const inWindow = list.filter((k) => k.at <= T && k.at >= T - MOMENTS.swingWindowMinutes * MIN).sort((a, b) => a.at - b.at);
        const s = swingOf(list, T);
        if (!s) return inWindow.every((k) => Math.abs(k.price - inWindow[inWindow.length - 1]!.price) < MOMENTS.swingPoints);
        return s.to === inWindow[inWindow.length - 1]!.price && Math.abs(s.to - s.from) >= MOMENTS.swingPoints && inWindow.some((k) => k.price === s.from);
      }),
    );
  });

  it("swings are bucketed by the hour", () => {
    expect(swingBucket(new Date(T))).toBe(swingBucket(T));
    const hour = MOMENTS.swingEveryMinutes * MIN;
    const start = Math.ceil(T / hour) * hour;
    expect(swingBucket(start - 1)).toBe(swingBucket(start) - 1);
    expect(swingBucket(start + hour - 1)).toBe(swingBucket(start));
  });
});

describe("the payload the rooms accept", () => {
  it("a swing and a result come through, rebuilt from the known fields only", () => {
    expect(parseMoment(swing)).toEqual(swing);
    expect(parseMoment(settled)).toEqual(settled);
    expect(parseMoment({ ...swing, extra: "x".repeat(10_000), __proto__: { evil: 1 } })).toEqual(swing);
    expect(parseMoment({ ...swing, marketId: MARKET.toUpperCase(), question: "  Will Lagos FC win?  " })).toEqual(swing);
    const { from: _from, ...noFrom } = settled;
    expect(parseMoment(noFrom)).toEqual(noFrom); // a result's last price is optional
  });

  it("refuses junk, the wrong fields for the kind, and anything too big", () => {
    const bad: unknown[] = [
      null,
      "moment",
      [],
      42,
      { ...swing, id: "" },
      { ...swing, id: "x".repeat(MOMENTS.idChars + 1) },
      { ...swing, id: "has space" },
      { ...swing, kind: "goal" },
      { ...swing, marketId: "not-a-uuid" },
      { ...swing, question: "" },
      { ...swing, question: "   " },
      { ...swing, question: "q".repeat(MOMENTS.questionChars + 1) },
      { ...swing, question: "line\nbreak" },
      { ...swing, question: 7 },
      { ...swing, at: 0 },
      { ...swing, at: 1.5 },
      { ...swing, at: "now" },
      { ...swing, from: 0 },
      { ...swing, to: 100 },
      { ...swing, to: 41 }, // no move
      { ...swing, to: undefined },
      { ...swing, outcome: "yes" },
      { ...settled, outcome: undefined },
      { ...settled, outcome: "maybe" },
      { ...settled, to: 99 },
      { ...settled, from: 50.5 },
    ];
    for (const b of bad) expect(parseMoment(b), JSON.stringify(b)).toBeNull();
    expect(parseMoment({ ...swing, question: "q".repeat(MOMENTS.questionChars) })).not.toBeNull();
  });

  it("the largest valid moment fits the rooms' size cap", () => {
    // "€" is 3 bytes of UTF-8 for each character the length counts: the most there is.
    const big: TowerMoment = { id: "x".repeat(MOMENTS.idChars), kind: "settled", marketId: MARKET, question: "€".repeat(MOMENTS.questionChars), from: 99, outcome: "yes", at: Number.MAX_SAFE_INTEGER };
    expect(parseMoment(big)).not.toBeNull();
    expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeLessThanOrEqual(MOMENTS.bodyBytes);
  });

  it("only the Watch Party has a screen", () => {
    expect(hasScreen("watch_party")).toBe(true);
    for (const p of ["diner", "tower", "roof", "watch_party:2", "home:watch_party", ""]) expect(hasScreen(p), p).toBe(false);
  });
});
