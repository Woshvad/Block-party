import { HUNT_PLACES, HUNT_TROPHIES } from "@bp/core";
import { describe, expect, it } from "vitest";
import type { Whereabouts } from "../src/api";
import { foundByLine, huntState, searchPrompt, searchResult, spotName, trophyLine, yesterdayLine } from "../src/hunt";

const now = Date.parse("2026-10-17T12:00:00Z");
const at = (area: string, extra: Partial<Whereabouts> = {}): Whereabouts => ({ area, arrived: true, arriveAt: null, from: "street", ...extra });
const [map, magnifier] = HUNT_TROPHIES;

describe("the Daily clue card", () => {
  it("names every place you can search, and nothing else", () => {
    for (const p of HUNT_PLACES) expect(spotName(p)).toMatch(/^(the [A-Za-z]|City Hall)/);
    expect(spotName("diner")).toBe("the Diner");
    for (const p of ["street", "home", "narnia", ""]) expect(spotName(p)).toBe("the street");
  });

  it("says how many found it today", () => {
    expect(foundByLine(0)).toBe("Nobody's found it yet today");
    expect(foundByLine(1)).toBe("Found by 1 neighbour today");
    expect(foundByLine(12)).toBe("Found by 12 neighbours today");
    for (const bad of [-1, NaN, 2.5]) expect(foundByLine(bad)).toBe("Nobody's found it yet today");
  });

  it("your state: not searched, found, or not here", () => {
    expect(huntState({ searched: null }).kind).toBe("open");
    expect(huntState({ searched: { place: "roof", found: true } })).toEqual({ kind: "found", text: "Found it ✓", detail: "It was at the Roof." });
    expect(huntState({ searched: { place: "faucet", found: false } })).toEqual({ kind: "missed", text: "Not here, try again tomorrow", detail: "You searched the Faucet." });
  });

  it("trophy progress counts down to the next trophy", () => {
    expect(trophyLine(0)).toBe(`Your first find wins ${map!.name}`);
    expect(trophyLine(1)).toBe(`1 find · 6 more for ${magnifier!.name}`);
    expect(trophyLine(6)).toBe(`6 finds · 1 more for ${magnifier!.name}`);
    expect(trophyLine(7)).toBe("7 finds · all 2 trophies won");
    expect(trophyLine(30)).toBe("30 finds · all 2 trophies won");
  });

  it("yesterday's answer, or that there wasn't one", () => {
    expect(yesterdayLine({ place: "city_hall", clue: "x", finders: 4 })).toBe("City Hall · found by 4");
    expect(yesterdayLine({ place: "diner", clue: "x", finders: 0 })).toBe("The Diner · found by 0");
    expect(yesterdayLine(null)).toBe("No hunt yesterday.");
  });

  it("the Search button says where you are, and asks before the day's one search", () => {
    expect(searchPrompt(at("diner"), now)).toEqual({ can: true, place: "diner", name: "the Diner", confirm: "One search a day. Search the Diner?" });
    expect(searchPrompt(at("city_hall"), now)).toMatchObject({ can: true, confirm: "One search a day. Search City Hall?" });
  });

  it("on the street it points to the city board; on the way it says wait", () => {
    expect(searchPrompt(at("street"), now)).toEqual({ can: false, hint: expect.stringMatching(/city board/), board: true });
    const walking = at("tower", { arrived: false, arriveAt: "2026-10-17T12:00:30Z" });
    expect(searchPrompt(walking, now)).toEqual({ can: false, hint: "You're on your way to the Tower. Search when you get there.", board: false });
    expect(searchPrompt(at("street", { arrived: false, arriveAt: "2026-10-17T12:00:30Z" }), now)).toMatchObject({ can: false, board: false });
    // Once the arrival time passes you're there, without asking the city again.
    expect(searchPrompt(walking, Date.parse("2026-10-17T12:00:30Z"))).toMatchObject({ can: true, place: "tower" });
    expect(searchPrompt(undefined, now)).toMatchObject({ can: false, board: false });
    expect(searchPrompt(null, now)).toMatchObject({ can: false });
  });

  it("the result says found (and any trophy) or not here", () => {
    expect(searchResult({ day: "d", place: "roof", found: false, finds: 0, trophies: [] })).toBe("Not at the Roof. Try again tomorrow.");
    expect(searchResult({ day: "d", place: "roof", found: true, finds: 3, trophies: [] })).toBe("Found it! ✓");
    expect(searchResult({ day: "d", place: "roof", found: true, finds: 1, trophies: [map!.pieceId] })).toBe(`Found it! ✓ You won ${map!.name}: it's in your home storage.`);
    expect(searchResult({ day: "d", place: "roof", found: true, finds: 7, trophies: [magnifier!.pieceId, "nope"] })).toBe(`Found it! ✓ You won ${magnifier!.name}: it's in your home storage.`);
  });
});
