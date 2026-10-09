import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BUYABLE_IDS, CATALOGUE, MOODS, NEVER_SAY, PLACE_ADVERTS, REGION_EVENINGS, TEMPLATES, TRAITS, bigNights, cityWeek, freeWillPick, homeAdverts, napsOn } from "../src";

describe("naps", () => {
  it("any Rested piece does it, the cheapest the same as the dearest", () => {
    const beds = [...CATALOGUE.values()].filter((p) => p.mood === "rested").map((p) => p.id);
    expect(beds).toEqual(expect.arrayContaining(["kit_neon_bed", "double_bed", "lambo_bed", "hammock"]));
    for (const b of beds) expect(napsOn(b)).toBe(true);
    for (const x of ["sofa", "tv", "stool", "nope", ""]) expect(napsOn(x)).toBe(false);
  });

  it("the nap ping says nothing about money", () => {
    for (const t of TEMPLATES.nap_done) expect(NEVER_SAY.test(t)).toBe(false);
  });
});

describe("free will", () => {
  const all = Object.values(PLACE_ADVERTS).flat();

  it("REKT or Tilted heads for Cozy; Rested doesn't want another nap", () => {
    const adverts = [{ id: "bed", mood: "rested" as const }, { id: "sofa", mood: "cozy" as const }];
    expect(freeWillPick({ moods: ["rekt"], traits: [], adverts, seed: 1 })).toBe("sofa");
    expect(freeWillPick({ moods: ["tilted"], traits: [], adverts, seed: 2 })).toBe("sofa");
    expect(freeWillPick({ moods: [], traits: [], adverts, seed: 3 })).toBe("bed");
    expect(freeWillPick({ moods: ["rested"], traits: [], adverts: [{ id: "bed", mood: "rested" }], seed: 1 })).toBeNull();
  });

  it("traits pull: a Roof Rat takes the ledge", () => {
    expect(freeWillPick({ moods: [], traits: ["roof_rat"], adverts: all, seed: 9 })).toBe("roof:ledge");
    expect(freeWillPick({ moods: [], traits: ["copium_regular"], adverts: all, seed: 9 })).toBe("diner:booth");
  });

  it("always picks something on offer (or nothing), never throws, for any input", () => {
    fc.assert(
      fc.property(
        fc.subarray([...MOODS]),
        fc.subarray([...TRAITS], { maxLength: 3 }),
        fc.subarray(all),
        fc.integer(),
        (moods, traits, adverts, seed) => {
          const r = freeWillPick({ moods, traits, adverts, seed });
          expect(r === null || adverts.some((a) => a.id === r)).toBe(true);
        },
      ),
      { seed: 18, numRuns: 2000 },
    );
  });

  it("ties spread a crowd across the chairs", () => {
    const chairs = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, mood: "cozy" as const }));
    const picks = new Set(Array.from({ length: 50 }, (_, s) => freeWillPick({ moods: [], traits: [], adverts: chairs, seed: s })));
    expect(picks.size).toBe(5);
  });

  it("home adverts come from placed furniture's own mood", () => {
    expect(homeAdverts([{ itemId: "a", pieceId: "sofa" }, { itemId: "b", pieceId: "stool" }, { itemId: "c", pieceId: "kit_cozy_bed" }])).toEqual([
      { id: "a", mood: "cozy" },
      { id: "c", mood: "rested" },
    ]);
    // Every buyable mood piece offers the same mood at every price.
    for (const id of BUYABLE_IDS) expect([undefined, "cozy", "rested"]).toContain(CATALOGUE.get(id)!.mood);
  });
});

describe("one clock, three evenings", () => {
  const W = 7 * 86_400_000;
  const t0 = new Date(Date.UTC(2029, 0, 1)); // a Monday

  it("weeks turn over on Monday 00:00 UTC", () => {
    expect(cityWeek(new Date(t0.getTime() - 1))).toBe(cityWeek(t0) - 1);
    expect(cityWeek(new Date(t0.getTime() + W - 1))).toBe(cityWeek(t0));
  });

  it("each rotating big night visits all three regions in any three weeks, never two in one region the same week", () => {
    for (let k = 0; k < 60; k++) {
      const weeks = [0, 1, 2].map((i) => bigNights(new Date(t0.getTime() + (k + i) * W)));
      for (const place of ["diner", "watch_party"]) {
        const regions = weeks.map((b) => (b.find((x) => x.place === place) as { region: string }).region);
        expect(new Set(regions).size).toBe(3);
      }
      const rot = weeks[0]!.filter((x) => x.kind === "rotating") as Array<{ region: string; hourUtc: number }>;
      expect(new Set(rot.map((r) => r.region)).size).toBe(rot.length);
      for (const r of rot) expect(r.hourUtc).toBe(REGION_EVENINGS[r.region as keyof typeof REGION_EVENINGS]);
    }
  });

  it("bell-tied big nights never move", () => {
    const a = bigNights(t0).filter((x) => x.kind === "bell");
    const b = bigNights(new Date(t0.getTime() + 5 * W)).filter((x) => x.kind === "bell");
    expect(a).toEqual(b);
    expect(a.map((x) => x.place).sort()).toEqual(["city_hall", "crew_row", "faucet", "roof", "tower"]);
  });

  it("works for dates before 1970-01-05 too", () => {
    for (const d of [new Date(0), new Date(-1e12)]) expect(bigNights(d).filter((x) => x.kind === "rotating")).toHaveLength(2);
  });
});
