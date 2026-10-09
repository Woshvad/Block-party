import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AWAY, type AwayPeer, TRAITS, type Trait, awayPlaceAt, awayStory, recap, slotOf } from "../src";

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 12, 10, 0); // a Monday, 10:00 UTC

describe("away life", () => {
  it("is repeatable: the same resident and slot always land in the same place", () => {
    fc.assert(fc.property(fc.uuid(), fc.integer({ min: 0, max: 10_000 }), (u, k) => {
      const s = slotOf(T0) + k;
      return awayPlaceAt(u, ["ape", "lurker", "roof_rat"], s, T0) === awayPlaceAt(u, ["ape", "lurker", "roof_rat"], s, T0);
    }));
  });

  it("traits pull: a Roof Rat is on the roof far more than someone without the trait", () => {
    const share = (traits: Trait[]) => {
      let roof = 0;
      const n = 4000;
      for (let i = 0; i < n; i++) if (awayPlaceAt(`user${i}`, traits, slotOf(T0) + (i % 40), T0) === "roof") roof++;
      return roof / n;
    };
    expect(share(["roof_rat", "ape", "builder"])).toBeGreaterThan(share(["lurker", "ape", "builder"]) * 2);
  });

  it("after 7 days away, the resident stays home", () => {
    const lastSeen = T0;
    for (let d = 0; d < 20; d++) {
      const s = slotOf(lastSeen + 7 * 24 * H + 1 + d * H);
      expect(awayPlaceAt(`u${d}`, ["roof_rat", "ape", "hype_man"], s, lastSeen)).toBe("home");
    }
  });

  it("a short break writes no story, even one that crosses a slot boundary", () => {
    expect(awayStory({ userId: "a", traits: [] }, T0, T0 + 14 * 60_000)).toEqual([]);
    const from = T0 + 14 * 60_000; // 10:14 to 10:28 crosses 10:15
    for (let i = 0; i < 50; i++) expect(awayStory({ userId: `s${i}`, traits: ["roof_rat", "ape", "hype_man"] }, from, from + 14 * 60_000)).toEqual([]);
  });

  it("a long absence is bounded: one 'stayed home' event and no more", () => {
    const events = awayStory({ userId: "a", traits: ["roof_rat", "ape", "hype_man"] }, T0, T0 + 60 * 24 * H);
    expect(events.filter((e) => e.key === "away.stayed_home")).toHaveLength(1);
    expect(events.at(-1)!.key).toBe("away.stayed_home");
    expect(Math.max(...events.map((e) => e.at)) - T0).toBeLessThanOrEqual(7 * 24 * H + 15 * 60_000);
  });

  it("events are templates with values, never finished English", () => {
    const events = awayStory({ userId: "b", traits: ["copium_regular", "contrarian", "night_owl"] }, T0, T0 + 48 * H);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.key).toMatch(/^away\.[a-z_]+$/);
      expect(Object.values(e.values).every((v) => typeof v === "string" || typeof v === "number")).toBe(true);
    }
  });

  it("meetings are mutual: if a met b, b met a, in the same slot and place", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 72 }), fc.subarray([...TRAITS], { minLength: 3, maxLength: 3 }), fc.subarray([...TRAITS], { minLength: 3, maxLength: 3 }), (hours, ta, tb) => {
        const a: AwayPeer = { userId: "aaa", traits: ta, lastSeen: T0, awayUntil: T0 + hours * H };
        const b: AwayPeer = { userId: "bbb", traits: tb, lastSeen: T0, awayUntil: T0 + hours * H };
        const fromA = awayStory(a, T0, T0 + hours * H, [b]).filter((e) => e.key === "away.met_resident");
        const fromB = awayStory(b, T0, T0 + hours * H, [a]).filter((e) => e.key === "away.met_resident");
        return JSON.stringify(fromA.map((e) => [e.at, e.values.place])) === JSON.stringify(fromB.map((e) => [e.at, e.values.place]));
      }),
      { numRuns: 200 },
    );
  });

  it("you can't meet someone while they're online (outside their away window)", () => {
    const b: AwayPeer = { userId: "bbb", traits: ["roof_rat", "ape", "hype_man"], lastSeen: T0 + 30 * H, awayUntil: T0 + 40 * H };
    const events = awayStory({ userId: "aaa", traits: ["roof_rat", "ape", "hype_man"] }, T0, T0 + 24 * H, [b]);
    expect(events.filter((e) => e.key === "away.met_resident")).toEqual([]);
  });

  it("the recap keeps the highlights short, meetings first, in time order", () => {
    const peers: AwayPeer[] = Array.from({ length: 6 }, (_, i) => ({ userId: `p${i}`, traits: ["roof_rat", "ape", "hype_man"], lastSeen: T0, awayUntil: T0 + 72 * H }));
    const events = awayStory({ userId: "me", traits: ["roof_rat", "ape", "hype_man"] }, T0, T0 + 72 * H, peers);
    const r = recap(events);
    expect(r.highlights.length).toBeLessThanOrEqual(AWAY.recapMaxEvents);
    expect(r.highlights.map((e) => e.at)).toEqual([...r.highlights.map((e) => e.at)].sort((x, y) => x - y));
    // Built by hand so it can't pass vacuously: ten wanderings, then a meeting last.
    const built = [
      ...Array.from({ length: 10 }, (_, i) => ({ key: "away.went_to" as const, at: T0 + i * H, values: { place: "roof" as const } })),
      { key: "away.met_resident" as const, at: T0 + 20 * H, values: { userId: "fren", place: "roof" as const } },
    ];
    expect(recap(built).highlights.map((e) => e.key)).toContain("away.met_resident");
    expect(r.favouritePlace).not.toBeNull();
    expect(recap([])).toEqual({ highlights: [], counts: { places: 0, people: 0, npcs: 0 }, favouritePlace: null });
  });
});
