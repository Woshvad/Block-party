import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RENT, SHIFT, addDays, cityWeekday, isSublet, rentSplit, saturdaysBetween, scoreShift, shiftPay, shiftPuzzle } from "../src";

describe("rent", () => {
  it("splits 10% to the Purse, the rest burns, nothing lost", () => {
    expect(rentSplit(250)).toEqual({ burn: 225, purse: 25 });
    fc.assert(fc.property(fc.integer({ min: 1, max: 100_000 }), (a) => {
      const s = rentSplit(a);
      return s.burn + s.purse === a && s.purse === Math.floor(a / 10) && s.burn >= 0;
    }));
  });

  it("finds every Saturday in a range, inclusive", () => {
    expect(saturdaysBetween("2026-10-08", "2026-10-31")).toEqual(["2026-10-10", "2026-10-17", "2026-10-24", "2026-10-31"]);
    expect(saturdaysBetween("2026-10-10", "2026-10-10")).toEqual(["2026-10-10"]);
    expect(saturdaysBetween("2026-10-11", "2026-10-16")).toEqual([]);
    expect(saturdaysBetween("2026-10-31", "2026-10-01")).toEqual([]);
    fc.assert(fc.property(fc.integer({ min: 0, max: 3000 }), fc.integer({ min: 0, max: 200 }), (o, len) => {
      const from = addDays("2026-01-01", o);
      const s = saturdaysBetween(from, addDays(from, len));
      return s.every((d) => cityWeekday(d) === 6) && s.length >= Math.floor(len / 7) && s.length <= Math.floor(len / 7) + 1;
    }));
  });

  it("sublet starts after 7 full days away, not before", () => {
    const sat = "2026-10-17";
    expect(isSublet(addDays(sat, -7), sat)).toBe(false); // last seen 6 full days before
    expect(isSublet(addDays(sat, -8), sat)).toBe(true); // 7 full days away
    expect(isSublet(sat, sat)).toBe(false);
    expect(RENT.tenement).toBe(250);
  });
});

describe("Mod Shift mini-game", () => {
  it("pays 10 to 12 by score; no score pays the base", () => {
    expect([null, 0, 6, 7, 8, 9, 10].map(shiftPay)).toEqual([10, 10, 10, 11, 11, 12, 12]);
  });

  it("puzzles are deterministic per seed and differ across seeds", () => {
    expect(shiftPuzzle(7)).toEqual(shiftPuzzle(7));
    const distinct = new Set(Array.from({ length: 50 }, (_, s) => JSON.stringify(shiftPuzzle(s).answers)));
    expect(distinct.size).toBeGreaterThan(40);
  });

  it("the items never leak the answers", () => {
    for (let s = 0; s < 100; s++) {
      for (const item of shiftPuzzle(s).items) expect(Object.keys(item)).toEqual(["text"]);
    }
  });

  it("scores right answers and nothing else", () => {
    const { answers } = shiftPuzzle(123);
    expect(scoreShift(123, answers)).toBe(10);
    expect(scoreShift(123, answers.map((a) => !a))).toBe(0);
    const oneWrong = [...answers];
    oneWrong[0] = !oneWrong[0];
    expect(scoreShift(123, oneWrong)).toBe(9);
  });

  it("malformed answers score 0 (no partial credit for junk)", () => {
    const { answers } = shiftPuzzle(5);
    for (const bad of [null, "all", {}, [], answers.slice(1), [...answers, true], answers.map((a) => (a ? 1 : 0)), answers.map(String)]) {
      expect(scoreShift(5, bad)).toBe(0);
    }
  });

  it("guessing all one way doesn't pay the top rate on average", () => {
    let total = 0;
    for (let s = 0; s < 2000; s++) total += shiftPay(scoreShift(s, Array(SHIFT.items).fill(true)));
    expect(total / 2000).toBeLessThan(10.5);
  });

  it("2 shifts a day at an average score matches the plan's weekly 154 GM", () => {
    expect(7 * SHIFT.perDay * shiftPay(8)).toBe(154);
  });
});
