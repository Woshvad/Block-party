import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RENT, SHIFT, addDays, cityWeekday, halvingBurn, halvingDue, seasonLastDay, isSublet, rentSplit, saturdaysBetween, scoreShift, seasonEndedAt, seasonOf, shiftPay, shiftPuzzle } from "../src";

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

describe("the Halving", () => {
  it("halves and burns the excess above 2,000, rounding for the player", () => {
    expect([0, 1999, 2000, 2001, 2002, 5000, 5001, 1_000_000].map(halvingBurn)).toEqual([0, 0, 0, 0, 1, 1500, 1500, 499_000]);
    for (const bad of [NaN, -5, 2500.5, Infinity]) expect(halvingBurn(bad)).toBe(0);
  });

  it("never takes you below 2,000 and always leaves at least half the excess", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 10_000_000 }), (b) => {
      const after = b - halvingBurn(b);
      return b <= 2000 ? after === b : after >= 2000 && after - 2000 >= (b - 2000) / 2 && after - 2000 <= (b - 2000) / 2 + 0.5;
    }));
  });

  it("knows a season's last bell", () => {
    expect(seasonEndedAt("2026-11-02", seasonOf)).toBe(1); // season 1 ran 2026-10-05 .. 2026-11-01
    expect(seasonEndedAt("2026-11-01", seasonOf)).toBeNull();
    expect(seasonEndedAt("2026-11-03", seasonOf)).toBeNull();
    expect(seasonEndedAt("2026-11-30", seasonOf)).toBe(2);
    expect(seasonEndedAt("2026-10-05", seasonOf)).toBeNull(); // season 0 (pre-launch) never halves
  });
});

describe("when the Halving is due", () => {
  it("at the season's last bell and up to 7 days late, never earlier, never later", () => {
    expect(halvingDue("2026-11-01")).toBeNull(); // last day of season 1, bell hasn't rung
    expect(halvingDue("2026-11-02")).toBe(1);
    expect(halvingDue("2026-11-08")).toBe(1); // 6 days late
    expect(halvingDue("2026-11-09")).toBeNull(); // 7 days late: skipped
    expect(halvingDue("2026-10-20")).toBeNull(); // season 1 itself
    expect(halvingDue("2026-09-01")).toBeNull(); // before launch
  });

  it("a season's last day is the day before the next one starts", () => {
    expect(seasonLastDay(1)).toBe("2026-11-01");
    expect(seasonOf(seasonLastDay(5))).toBe(5);
    expect(seasonOf(addDays(seasonLastDay(5), 1))).toBe(6);
  });
});
