import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  GM,
  type StreakState,
  addDays,
  advanceStreak,
  cityDay,
  cityWeekday,
  daysBetween,
  dripFor,
  nextBell,
  streakBonus,
  streakView,
} from "../src";

const fresh = (hodlDays: number = GM.hodlDayAtMoveIn): StreakState => ({ current: 0, longest: 0, lastDay: null, hodlDays });

function play(days: string[], start = fresh()) {
  let s = start;
  let bonus = 0;
  const log = [];
  for (const d of days) {
    const r = advanceStreak(s, d);
    s = r.state;
    bonus += r.bonus;
    log.push(r);
  }
  return { s, bonus, log };
}

describe("city clock", () => {
  it("uses UTC, not local time", () => {
    expect(cityDay(new Date("2026-10-08T23:59:59.999Z"))).toBe("2026-10-08");
    expect(cityDay(new Date("2026-10-09T00:00:00.000Z"))).toBe("2026-10-09");
    expect(cityDay(new Date("2026-10-08T20:00:00-07:00"))).toBe("2026-10-09"); // LA evening is next city day
  });

  it("the bell is the next UTC midnight", () => {
    expect(nextBell(new Date("2026-10-08T00:00:00Z")).toISOString()).toBe("2026-10-09T00:00:00.000Z");
    expect(nextBell(new Date("2026-10-08T23:59:59Z")).toISOString()).toBe("2026-10-09T00:00:00.000Z");
  });

  it("crosses months, years and leap days", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(daysBetween("2026-01-01", "2027-01-01")).toBe(365);
    expect(daysBetween("2028-01-01", "2029-01-01")).toBe(366);
    expect(daysBetween("2026-10-09", "2026-10-08")).toBe(-1);
  });

  it("knows the weekday (Saturday rent, Sunday stamps)", () => {
    expect(cityWeekday("2026-10-10")).toBe(6);
    expect(cityWeekday("2026-10-11")).toBe(0);
  });

  it.each(["2026-02-30", "2026-13-01", "26-10-08", "2026-10-8", "", "2026-10-08T00:00"])("rejects %s", (bad) => {
    expect(() => addDays(bad, 1)).toThrow(RangeError);
  });

  it("addDays and daysBetween are inverses", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40_000 }), fc.integer({ min: -5000, max: 5000 }), (offset, n) => {
        const d = addDays("2000-01-01", offset);
        return daysBetween(d, addDays(d, n)) === n;
      }),
    );
  });
});

describe("drip and broke floor", () => {
  it("pays 50, or 100 under 100 GM net worth", () => {
    expect(dripFor(100)).toEqual({ amount: 50, brokeFloor: false });
    expect(dripFor(99)).toEqual({ amount: 100, brokeFloor: true });
    expect(dripFor(0)).toEqual({ amount: 100, brokeFloor: true });
    expect(dripFor(5000)).toEqual({ amount: 50, brokeFloor: false });
  });

  it("streak bonus is +5 a day, capped at +25 from day 5", () => {
    expect([1, 2, 3, 4, 5, 6, 100].map(streakBonus)).toEqual([5, 10, 15, 20, 25, 25, 25]);
  });
});

describe("streaks", () => {
  it("counts consecutive days", () => {
    const { s, log } = play(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(s).toMatchObject({ current: 3, longest: 3, lastDay: "2026-10-03" });
    expect(log.map((l) => l.bonus)).toEqual([5, 10, 15]);
  });

  it("is a no-op when the same day is recorded twice", () => {
    const a = advanceStreak(fresh(), "2026-10-01");
    const b = advanceStreak(a.state, "2026-10-01");
    expect(b.changed).toBe(false);
    expect(b.bonus).toBe(0);
    expect(b.state).toBe(a.state);
  });

  it("refuses to go back in time", () => {
    const a = advanceStreak(fresh(), "2026-10-05");
    expect(() => advanceStreak(a.state, "2026-10-04")).toThrow(RangeError);
  });

  it("a Hodl Day covers a missed day and keeps the streak", () => {
    const { s, log } = play(["2026-10-01", "2026-10-02", "2026-10-04"]);
    expect(s).toMatchObject({ current: 3, hodlDays: 0 });
    expect(log[2]!.coveredDays).toEqual(["2026-10-03"]);
  });

  it("two Hodl Days cover two missed days", () => {
    const { s, log } = play(["2026-10-01", "2026-10-04"], fresh(2));
    expect(s).toMatchObject({ current: 2, hodlDays: 0 });
    expect(log[1]!.coveredDays).toEqual(["2026-10-02", "2026-10-03"]);
  });

  it("not enough Hodl Days: the streak quietly restarts and none are spent", () => {
    const { s, log } = play(["2026-10-01", "2026-10-02", "2026-10-05"]); // 2 missed, 1 held
    expect(s).toMatchObject({ current: 1, longest: 2, hodlDays: 1 });
    expect(log[2]).toMatchObject({ broken: true, coveredDays: [] });
  });

  it("grants a free Hodl Day at every 7-day streak, up to 2 held", () => {
    const days = Array.from({ length: 21 }, (_, i) => addDays("2026-10-01", i));
    const { s, log } = play(days, fresh(0));
    expect(log.filter((l) => l.hodlGranted).map((l) => l.state.current)).toEqual([7, 14]); // 21 skipped: already holding 2
    expect(s.hodlDays).toBe(2);
  });

  it("awards streak cards at 7, 30, 100 and 365", () => {
    const days = Array.from({ length: 365 }, (_, i) => addDays("2026-01-01", i));
    const { log } = play(days);
    expect(log.flatMap((l) => l.cards)).toEqual([7, 30, 100, 365]);
  });

  describe("matches the plan's weekly math", () => {
    it("casual: 4 days a week earns +50 a week", () => {
      const weeks = [0, 7, 14, 21].map((w) => [0, 1, 2, 3].map((d) => addDays("2026-10-05", w + d)));
      let s = fresh();
      for (const week of weeks) {
        const r = play(week, s);
        expect(r.bonus).toBe(50);
        s = r.s;
      }
    });

    it("active: every day earns +175 a week once settled", () => {
      const days = Array.from({ length: 28 }, (_, i) => addDays("2026-10-05", i));
      const { log } = play(days);
      const weekly = [0, 1, 2, 3].map((w) => log.slice(w * 7, w * 7 + 7).reduce((a, l) => a + l.bonus, 0));
      expect(weekly).toEqual([125, 175, 175, 175]);
    });
  });

  describe("properties over random play histories", () => {
    const history = fc
      .array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 120 })
      .map((gaps) => {
        let d = "2026-01-01";
        return gaps.map((g) => (d = addDays(d, g)));
      });

    it("invariants always hold", () => {
      fc.assert(
        fc.property(history, fc.integer({ min: 0, max: 2 }), (days, startHodl) => {
          let s = fresh(startHodl);
          for (const d of days) {
            const r = advanceStreak(s, d);
            const gap = s.lastDay ? daysBetween(s.lastDay, d) - 1 : 0;
            if (r.state.hodlDays < 0 || r.state.hodlDays > GM.hodlDayMax) return false;
            if (r.state.current < 1 || r.state.longest < r.state.current) return false;
            if (r.bonus !== streakBonus(r.state.current)) return false;
            // Either the gap was fully covered and the streak grew, or it broke and nothing was spent.
            if (r.broken) {
              if (r.state.current !== 1 || r.coveredDays.length !== 0) return false;
              if (r.state.hodlDays !== s.hodlDays + (r.hodlGranted ? 1 : 0)) return false;
            } else if (s.lastDay) {
              if (r.coveredDays.length !== gap || r.state.current !== s.current + 1) return false;
              if (r.state.hodlDays !== s.hodlDays - gap + (r.hodlGranted ? 1 : 0)) return false;
            }
            s = r.state;
          }
          return true;
        }),
        { numRuns: 2000 },
      );
    });

    it("the Today view agrees with what playing today would do", () => {
      fc.assert(
        fc.property(history, fc.integer({ min: 0, max: 4 }), (days, wait) => {
          const { s } = play(days);
          const today = addDays(s.lastDay!, wait);
          const view = streakView(s, today);
          const r = advanceStreak(s, today);
          if (wait === 0) return view.playedToday && !r.changed;
          return view.alive === !r.broken && view.hodlNeeded === r.coveredDays.length && (view.alive ? view.streak === s.current : view.streak === 0);
        }),
        { numRuns: 2000 },
      );
    });
  });
});
