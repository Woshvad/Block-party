import { describe, expect, it } from "vitest";
import { AREAS, HUNT_CLUES, HUNT_PLACE_NAMES, HUNT_PLACES, HUNT_TROPHIES, areaOf, getPiece, huntClue, huntTrophies, isArea, isHuntPlace, pickHuntDay, seededRandomInt } from "../src";

// Words that give a place away even without its full name.
const GIVEAWAYS: Record<string, string[]> = { city_hall: ["hall"], tower: ["prediction"], watch_party: ["watch"], gm_wall: ["wall"], diner: ["gwei"] };
const nameOf = (p: string) => HUNT_PLACE_NAMES[p as keyof typeof HUNT_PLACE_NAMES].replace(/^the /i, "").toLowerCase();
const says = (clue: string, word: string) => new RegExp(`\\b${word}\\b`, "i").test(clue);

describe("the hunt's places", () => {
  it("are every place you can ride to except the street, and nothing private", () => {
    expect([...HUNT_PLACES].sort()).toEqual(AREAS.filter((a) => a !== "street").sort());
    for (const p of HUNT_PLACES) {
      expect(isArea(p)).toBe(true);
      expect(areaOf(p)).toBe(p); // a public room of its own, not a door on the street
    }
    for (const p of ["street", "home", "crew_row", "crew_house", "bunker"]) expect(isHuntPlace(p)).toBe(false);
  });

  it("refuses garbage, prototype keys included", () => {
    for (const bad of ["narnia", "__proto__", "toString", "", " diner", "DINER", null, undefined, 1, {}, []]) expect(isHuntPlace(bad)).toBe(false);
    expect(isHuntPlace("diner")).toBe(true);
  });

  it("each has a name to say mid-sentence", () => {
    expect(Object.keys(HUNT_PLACE_NAMES).sort()).toEqual([...HUNT_PLACES].sort());
  });
});

describe("the clue bank", () => {
  it("every place has 4 or more clues, all different and short", () => {
    expect(Object.keys(HUNT_CLUES).sort()).toEqual([...HUNT_PLACES].sort());
    const all = HUNT_PLACES.flatMap((p) => HUNT_CLUES[p]);
    for (const p of HUNT_PLACES) expect(HUNT_CLUES[p].length, p).toBeGreaterThanOrEqual(4);
    expect(new Set(all).size).toBe(all.length);
    for (const c of all) expect(c.length, c).toBeLessThanOrEqual(80);
  });

  it("no clue names its own place, or gives it away", () => {
    for (const p of HUNT_PLACES) {
      for (const c of HUNT_CLUES[p]) {
        expect(says(c, nameOf(p)), `${p}: ${c}`).toBe(false);
        for (const w of GIVEAWAYS[p] ?? []) expect(says(c, w), `${p}: ${c}`).toBe(false);
      }
    }
  });

  it("no clue names another hunt place either (it would send people the wrong way)", () => {
    for (const p of HUNT_PLACES) for (const c of HUNT_CLUES[p]) for (const q of HUNT_PLACES) expect(says(c, nameOf(q)), `${p}: ${c}`).toBe(false);
  });

  it("the check catches a name, so the tests above can fail", () => {
    expect(says("Meet me at the Diner.", nameOf("diner"))).toBe(true);
    expect(says("City Hall votes tonight", nameOf("city_hall"))).toBe(true);
    expect(says("the gm wall again", nameOf("gm_wall"))).toBe(true);
  });
});

describe("picking the day", () => {
  it("never picks yesterday's place, and spreads evenly over the rest", () => {
    const rand = seededRandomInt(41);
    for (const yesterday of HUNT_PLACES) {
      const seen = new Map<string, number>();
      for (let i = 0; i < 6000; i++) {
        const d = pickHuntDay(rand, yesterday);
        seen.set(d.place, (seen.get(d.place) ?? 0) + 1);
      }
      expect(seen.has(yesterday), yesterday).toBe(false);
      expect(seen.size).toBe(HUNT_PLACES.length - 1);
      for (const [p, n] of seen) expect(n, `${yesterday} -> ${p}`).toBeGreaterThan(800); // 1000 each if fair
    }
  });

  it("with no yesterday, any place can come up; the clue is one of that place's", () => {
    const rand = seededRandomInt(7);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const d = pickHuntDay(rand, null);
      seen.add(d.place);
      expect(Number.isSafeInteger(d.clueIndex)).toBe(true);
      expect(d.clueIndex).toBeGreaterThanOrEqual(0);
      expect(d.clueIndex).toBeLessThan(HUNT_CLUES[d.place].length);
    }
    expect(seen.size).toBe(HUNT_PLACES.length);
  });

  it("the same seed gives the same days (tests can pin it)", () => {
    const a = seededRandomInt(99);
    const b = seededRandomInt(99);
    for (let i = 0; i < 50; i++) expect(pickHuntDay(a, "roof")).toEqual(pickHuntDay(b, "roof"));
  });
});

describe("clues and trophies", () => {
  it("huntClue reads the stored index, wrapping one past the end of the bank", () => {
    const clues = HUNT_CLUES.diner;
    expect(huntClue("diner", 0)).toBe(clues[0]);
    expect(huntClue("diner", 2)).toBe(clues[2]);
    expect(huntClue("diner", clues.length)).toBe(clues[0]);
    expect(huntClue("diner", -1)).toBe(clues[clues.length - 1]);
    for (const bad of [NaN, 1.5, Infinity]) expect(huntClue("diner", bad)).toBe(clues[0]);
  });

  it("a trophy on the first find and another at 7", () => {
    expect(HUNT_TROPHIES.map((t) => t.finds)).toEqual([1, 7]);
    const [map, magnifier] = HUNT_TROPHIES.map((t) => t.pieceId);
    expect(huntTrophies(0)).toEqual({ earned: [], next: { ...HUNT_TROPHIES[0], toGo: 1 } });
    expect(huntTrophies(1)).toEqual({ earned: [map], next: { ...HUNT_TROPHIES[1], toGo: 6 } });
    expect(huntTrophies(6).next?.toGo).toBe(1);
    expect(huntTrophies(7)).toEqual({ earned: [map, magnifier], next: null });
    expect(huntTrophies(40)).toEqual({ earned: [map, magnifier], next: null });
    for (const bad of [-3, NaN, 2.5, Infinity]) expect(huntTrophies(bad)).toEqual(huntTrophies(0));
  });

  it("the trophies are earned-only home pieces, never for sale", () => {
    for (const t of HUNT_TROPHIES) {
      const piece = getPiece(t.pieceId);
      expect(piece?.band, t.pieceId).toBe("earned");
      expect(piece?.price).toBeNull();
    }
  });
});
