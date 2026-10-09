import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_LAW_TARGETS, LAWS, addDays, cityWeekday, copiumPriceUnder, electionClock, electionWinner, getLaw, weekStart } from "../src";

describe("the weekly calendar", () => {
  it("weeks start on Monday", () => {
    expect(weekStart("2026-10-12")).toBe("2026-10-12"); // Monday
    expect(weekStart("2026-10-18")).toBe("2026-10-12"); // Sunday
    expect(weekStart("2026-10-11")).toBe("2026-10-05"); // the Sunday before
    fc.assert(fc.property(fc.integer({ min: 0, max: 5000 }), (o) => {
      const d = addDays("2026-01-01", o);
      const w = weekStart(d);
      return cityWeekday(w) === 1 && w <= d && addDays(w, 7) > d;
    }));
  });

  it("candidacy Monday to Thursday, voting Friday 00:00 to Sunday 23:00, then counted", () => {
    const at = (iso: string) => electionClock(new Date(iso)).phase;
    expect(at("2026-10-12T00:00:00Z")).toBe("candidacy");
    expect(at("2026-10-15T23:59:59Z")).toBe("candidacy");
    expect(at("2026-10-16T00:00:00Z")).toBe("voting");
    expect(at("2026-10-18T22:59:59Z")).toBe("voting");
    expect(at("2026-10-18T23:00:00Z")).toBe("counted");
    expect(at("2026-10-18T23:59:59Z")).toBe("counted");
    expect(at("2026-10-19T00:00:00Z")).toBe("candidacy"); // the next election
    const c = electionClock(new Date("2026-10-14T12:00:00Z"));
    expect(c).toMatchObject({ week: "2026-10-12", termWeek: "2026-10-19" });
    expect(c.swornIn.toISOString()).toBe("2026-10-19T00:00:00.000Z");
  });
});

describe("counting", () => {
  const d = (m: number) => new Date(Date.UTC(2026, 9, 12, 0, m));
  it("most votes wins; a tie goes to whoever declared first; no votes, no Mayor", () => {
    expect(electionWinner([{ candidateId: "a", votes: 3, declaredAt: d(5) }, { candidateId: "b", votes: 5, declaredAt: d(9) }])).toBe("b");
    expect(electionWinner([{ candidateId: "late", votes: 4, declaredAt: d(9) }, { candidateId: "early", votes: 4, declaredAt: d(1) }])).toBe("early");
    expect(electionWinner([{ candidateId: "a", votes: 0, declaredAt: d(1) }])).toBeNull();
    expect(electionWinner([])).toBeNull();
  });

  it("the winner never depends on the order the tally arrives in", () => {
    fc.assert(fc.property(fc.array(fc.record({ id: fc.string({ minLength: 1, maxLength: 4 }), votes: fc.integer({ min: 0, max: 9 }), at: fc.integer({ min: 0, max: 50 }) }), { maxLength: 8 }), (xs) => {
      const uniq = [...new Map(xs.map((x) => [x.id, x])).values()].map((x) => ({ candidateId: x.id, votes: x.votes, declaredAt: d(x.at) }));
      return electionWinner(uniq) === electionWinner([...uniq].reverse());
    }));
  });
});

describe("laws", () => {
  it("no law touches rent, stamps, Tower Lights, the drip, furniture prices, caps or real trades", () => {
    for (const law of LAWS) {
      for (const t of law.touches) expect(FORBIDDEN_LAW_TARGETS as readonly string[], law.id).not.toContain(t);
      for (const k of Object.keys(law.effects)) expect(k, law.id).toMatch(/^(copiumDiscount|ridesFree|placeTrait)$/);
    }
    expect(new Set(LAWS.map((l) => l.id)).size).toBe(LAWS.length);
  });

  it("Copium Subsidy takes 30% off, rounding up, and never makes Copium free", () => {
    expect(copiumPriceUnder(getLaw("copium_subsidy"), 30)).toBe(21);
    expect(copiumPriceUnder(getLaw("gas_holiday"), 30)).toBe(30);
    expect(copiumPriceUnder(null, 30)).toBe(30);
    expect(copiumPriceUnder({ id: "x", name: "x", touches: [], effects: { copiumDiscount: 1 } }, 30)).toBe(30); // nonsense ignored
    expect(copiumPriceUnder({ id: "x", name: "x", touches: [], effects: { copiumDiscount: 0.99 } }, 30)).toBe(1);
  });

  it("getLaw refuses garbage", () => {
    for (const bad of [undefined, null, 1, "", "rent_holiday", "__proto__"]) expect(getLaw(bad)).toBeNull();
  });
});
