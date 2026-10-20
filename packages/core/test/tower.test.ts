import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TOWER, auraCenti, chanceOnSide, median, mockLivePrice, mockPrice, mockProvider, oddsCredit, sampleMarkets, sideOpen, sliderStart, ticketsAfter, vibeGap } from "../src";

describe("Aura", () => {
  it("matches the plan's worked examples", () => {
    expect(auraCenti(true, 50, 70)).toBe(1600); // +16
    expect(auraCenti(false, 50, 70)).toBe(-2400); // −24
    expect(auraCenti(true, 50, 99)).toBe(2499); // about +25
    expect(auraCenti(false, 50, 99)).toBe(-7301); // about −73
  });

  it("hugging the market scores exactly zero either way", () => {
    for (let m = 1; m <= 99; m++) {
      expect(auraCenti(true, m, m)).toBe(0);
      expect(auraCenti(false, m, m)).toBe(0);
    }
  });

  it("stays within −100 and +100", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.integer({ min: 1, max: 99 }), fc.integer({ min: 1, max: 99 }), fc.boolean(), (o, m, y, h) => {
        const a = auraCenti(o, m, y, h);
        expect(Math.abs(a)).toBeLessThanOrEqual(10_000);
      }),
      { seed: 23, numRuns: 5000 },
    );
  });

  it("saying what you really believe always scores best (a proper score)", () => {
    // For a true belief p and any other report y, expected Aura at p ≥ at y.
    const expected = (p: number, m: number, y: number) => (p / 100) * auraCenti(true, m, y) + (1 - p / 100) * auraCenti(false, m, y);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 99 }), fc.integer({ min: 1, max: 99 }), fc.integer({ min: 1, max: 99 }), (p, m, y) => {
        expect(expected(p, m, p)).toBeGreaterThanOrEqual(expected(p, m, y) - 1e-9);
      }),
      { seed: 24, numRuns: 5000 },
    );
  });

  it("a half call rounds toward zero, never rounding a loss into a gain", () => {
    expect(auraCenti(true, 50, 70, true)).toBe(800);
    expect(auraCenti(false, 50, 70, true)).toBe(-1200);
    expect(auraCenti(true, 50, 51, true)).toBe(Math.trunc(99 / 2));
    fc.assert(
      fc.property(fc.boolean(), fc.integer({ min: 1, max: 99 }), fc.integer({ min: 1, max: 99 }), (o, m, y) => {
        const full = auraCenti(o, m, y);
        const half = auraCenti(o, m, y, true);
        expect(Math.sign(half) === Math.sign(full) || half === 0).toBe(true);
        expect(Math.abs(half)).toBeLessThanOrEqual(Math.abs(full));
      }),
      { seed: 25, numRuns: 3000 },
    );
  });

  it("refuses anything that isn't a whole percent", () => {
    for (const bad of [0, 100, 50.5, NaN, -1, Infinity]) {
      expect(() => auraCenti(true, bad, 50)).toThrow();
      expect(() => auraCenti(true, 50, bad)).toThrow();
    }
  });
});

describe("the slider", () => {
  it("moves only on your side of the price, and starts 10 points past it", () => {
    expect(chanceOnSide("yes", 40, 41)).toBe(true);
    expect(chanceOnSide("yes", 40, 40)).toBe(false);
    expect(chanceOnSide("yes", 40, 39)).toBe(false);
    expect(chanceOnSide("no", 40, 39)).toBe(true);
    expect(chanceOnSide("no", 40, 40)).toBe(false);
    for (const bad of [0, 100, 45.5, "60", null]) expect(chanceOnSide("yes", 40, bad)).toBe(false);
    expect(sliderStart("yes", 40)).toBe(50);
    expect(sliderStart("no", 40)).toBe(30);
    expect(sliderStart("yes", 95)).toBe(99);
    expect(sliderStart("no", 4)).toBe(1);
    expect(sideOpen("yes", 99)).toBe(false);
    expect(sideOpen("no", 1)).toBe(false);
  });

  it("the starting point is always a legal chance on that side", () => {
    for (let m = 1; m <= 99; m++)
      for (const side of ["yes", "no"] as const) if (sideOpen(side, m)) expect(chanceOnSide(side, m, sliderStart(side, m))).toBe(true);
  });
});

describe("tickets", () => {
  it("3 a day, stacking up to 9", () => {
    expect(ticketsAfter(0, 1)).toBe(3);
    expect(ticketsAfter(2, 1)).toBe(5);
    expect(ticketsAfter(7, 1)).toBe(9);
    expect(ticketsAfter(0, 10)).toBe(9);
    expect(ticketsAfter(4, 0)).toBe(4);
    expect(ticketsAfter(12, 0)).toBe(TOWER.ticketsMax);
  });
});

describe("the crowd", () => {
  it("the city's median and the Vibe Gap", () => {
    expect(median([])).toBeNull();
    expect(median([61])).toBe(61);
    expect(median([10, 90, 50])).toBe(50);
    expect(median([10, 20])).toBe(15);
    expect(vibeGap(8, 61)).toBe(53);
    expect(vibeGap(8, null)).toBeNull();
  });
});

describe("the mock feed", () => {
  const spec = { externalId: "m1", question: "Will it?", category: "crypto" as const, openAt: new Date("2029-01-01T00:00Z"), freezesAt: new Date("2029-01-01T20:00Z"), settlesBy: new Date("2029-01-01T22:00Z"), start: 50 };

  it("is a pure function of the minute, stays between 3 and 97, and stops at the freeze", () => {
    const at = new Date("2029-01-01T05:30Z");
    expect(mockPrice(spec, at)).toBe(mockPrice(spec, new Date(at.getTime() + 30_000)));
    for (let h = 0; h < 24; h++) {
      const p = mockPrice(spec, new Date(spec.openAt.getTime() + h * 3_600_000));
      expect(p).toBeGreaterThanOrEqual(3);
      expect(p).toBeLessThanOrEqual(97);
    }
    expect(mockPrice(spec, new Date("2029-01-01T21:00Z"))).toBe(mockPrice(spec, spec.freezesAt));
    expect(mockPrice({ ...spec, openAt: new Date(0) }, new Date("2100-01-01"))).toBeGreaterThanOrEqual(3); // bounded work even far out
  });

  it("resolves after settlesBy, voids when told to, and hides markets not yet open", async () => {
    const p = mockProvider(() => [spec, { ...spec, externalId: "v", voided: true }, { ...spec, externalId: "later", openAt: new Date("2030-01-01") }]);
    const before = await p.fetch(new Date("2029-01-01T21:00Z"));
    expect(before.map((m) => m.externalId)).toEqual(["m1", "v"]);
    expect(before.every((m) => m.resolved === null && !m.voided)).toBe(true);
    const after = await p.fetch(new Date("2029-01-01T23:00Z"));
    expect(typeof after[0]!.resolved).toBe("boolean");
    expect(after[1]).toMatchObject({ resolved: null, voided: true });
  });

  it("plays a match on from kickoff until it settles, at a price that carries on from the freeze", async () => {
    const match = { ...spec, externalId: "match", category: "sports" as const, inPlay: true };
    const p = mockProvider(() => [match, { ...match, externalId: "plain", inPlay: undefined }, { ...match, externalId: "off", voided: true }]);
    const before = await p.fetch(new Date("2029-01-01T19:59Z"));
    expect(before.some((m) => m.inPlay)).toBe(false);
    // At kickoff the live price is where the frozen one stopped.
    const kickoff = await p.fetch(spec.freezesAt);
    expect(kickoff.find((m) => m.externalId === "match")).toMatchObject({ inPlay: true, price: mockPrice(match, spec.freezesAt) });
    // Later it moves on its own, and only the match plays on.
    const prices = new Set<number>();
    for (let min = 1; min <= 90; min += 10) {
      const fs = await p.fetch(new Date(spec.freezesAt.getTime() + min * 60_000));
      expect(fs.filter((m) => m.inPlay).map((m) => m.externalId)).toEqual(["match"]);
      prices.add(fs.find((m) => m.externalId === "match")!.price);
      expect(mockLivePrice(match, new Date(spec.freezesAt.getTime() + min * 60_000))).toBe(fs.find((m) => m.externalId === "match")!.price);
    }
    expect(prices.size).toBeGreaterThan(1);
    // Settled: a result, no longer in play.
    const after = await p.fetch(new Date("2029-01-01T22:00Z"));
    expect(after.find((m) => m.externalId === "match")).toMatchObject({ resolved: expect.any(Boolean) });
    expect(after.some((m) => m.inPlay)).toBe(false);
  });

  it("a match settles where its play ended, not where it kicked off", async () => {
    let differs = 0;
    for (let i = 0; i < 40; i++) {
      const match = { ...spec, externalId: `settle-${i}`, category: "sports" as const, inPlay: true };
      const [m] = await mockProvider(() => [match]).fetch(match.settlesBy);
      const end = mockLivePrice(match, match.settlesBy);
      expect(m!.resolved).toBe(end >= 50);
      if (mockPrice(match, match.freezesAt) >= 50 !== end >= 50) differs++;
    }
    expect(differs).toBeGreaterThan(0); // so the kickoff price alone would have got some wrong
  });

  it("the sample feed has a pickup game in play most of the day, the same for every poller", async () => {
    const p = mockProvider(() => sampleMarkets(new Date()));
    let playing = 0;
    for (let min = 0; min < 24 * 60; min += 15) {
      const at = new Date(Date.UTC(2029, 0, 1) + min * 60_000);
      const fs = await mockProvider(() => sampleMarkets(at)).fetch(at);
      const live = fs.filter((m) => m.inPlay && m.externalId.startsWith("sample:pickup:"));
      expect(live.length).toBeLessThanOrEqual(1);
      if (live.length) playing++;
      // Every pickup game is a sports match, never a ladder.
      for (const m of fs.filter((x) => x.externalId.startsWith("sample:pickup:"))) expect(m).toMatchObject({ category: "sports", ladder: null });
    }
    expect(playing / 96).toBeGreaterThan(0.6); // two hours in every three
    const at = new Date("2029-01-01T07:10:00Z");
    expect(sampleMarkets(at).map((s) => s.externalId)).toEqual(sampleMarkets(new Date("2029-01-01T07:50:00Z")).map((s) => s.externalId));
    expect(p.source).toBe("mock");
  });

  it("is credited as sample odds, never as Polymarket's", () => {
    expect(oddsCredit(mockProvider(() => []).source)).toBe("Sample odds · Not real");
    expect(oddsCredit("polymarket")).toBe("Odds via Polymarket · Not affiliated");
  });
});

describe("the Bunkers", () => {
  it("a YES and a NO room per market, on the Tower's floor", async () => {
    const { areaOf, bunkerPlace, parseBunker, PLACE_RE } = await import("../src");
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const p = bunkerPlace(id.toUpperCase(), "yes");
    expect(p).toBe(`bunker:${id}:yes`);
    expect(PLACE_RE.test(p)).toBe(true);
    expect(areaOf(p)).toBe("tower");
    expect(parseBunker(p)).toEqual({ marketId: id, side: "yes" });
    for (const bad of ["bunker", `bunker:${id}`, `bunker:${id}:maybe`, `bunker:nope:yes`, `bunker:${id}:yes:extra`, `tower:${id}:yes`]) expect(parseBunker(bad)).toBeNull();
  });
});
