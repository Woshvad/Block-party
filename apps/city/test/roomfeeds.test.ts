import { describe, expect, it } from "vitest";
import type { CityHall, MarketRow } from "../src/api";
import { LAYOUTS } from "../src/interiors";
import { POLYMARKET_CREDIT, wrap, dinerBoard, hallBoard, matchBoard, oddsBoard } from "../src/roomfeeds";

const now = Date.parse("2026-10-10T12:00:00Z");
const mk = (id: string, category: string, price: number, inHours: number): MarketRow => ({ id, question: `Q ${id}?`, category, price, freezesAt: new Date(now + inHours * 3_600_000).toISOString(), infoOnly: category === "politics" });

describe("the Odds Wall", () => {
  const ms = [mk("c1", "crypto", 62, 5), mk("c2", "crypto", 30, 1), mk("s1", "sports", 45, 3), mk("p1", "politics", 80, 9), mk("old", "crypto", 50, -1)];

  it("shows open markets only, every category up top, soonest first, credited", () => {
    const b = oddsBoard(ms, now);
    expect(b.rows.map((r) => r.left)).toEqual(["Q c2?", "Q s1?", "Q p1?", "Q c1?"]);
    expect(b.foot).toBe(POLYMARKET_CREDIT);
  });

  it("colours odds: green at 50%+, red below", () => {
    const b = oddsBoard([mk("a", "crypto", 50, 1), mk("b", "sports", 49, 2)], now);
    expect(b.rows.map((r) => r.tone)).toEqual(["up", "down"]);
    expect(b.rows[0]!.right).toMatch(/^50% YES/);
  });

  it("caps rows, clips long questions, and says so when the feed is empty", () => {
    const many = Array.from({ length: 20 }, (_, i) => mk(String(i), "crypto", 50, i + 1));
    expect(oddsBoard(many, now).rows).toHaveLength(6);
    expect(oddsBoard([{ ...mk("x", "crypto", 50, 1), question: "x".repeat(200) }], now).rows[0]!.left.length).toBeLessThanOrEqual(52);
    expect(oddsBoard([], now).rows[0]!.left).toMatch(/paused/);
  });
});

describe("the Watch Party screen", () => {
  it("shows sports only, or an honest empty line", () => {
    expect(matchBoard([mk("c", "crypto", 50, 1), mk("s", "sports", 50, 2)], now).rows.map((r) => r.left)).toEqual(["Q s?"]);
    expect(matchBoard([mk("c", "crypto", 50, 1)], now).rows[0]!.left).toMatch(/No match/);
  });
});

describe("City Hall's noticeboard", () => {
  it("says there's no Mayor or Law rather than inventing one", () => {
    const b = hallBoard({ mayor: null, law: null, election: null }, now);
    expect(b.rows.map((r) => r.right)).toEqual(["No Mayor yet", "None this week"]);
  });

  it("ranks candidates by votes and shows the polls closing", () => {
    const hall: CityHall = {
      mayor: { userId: "u", handle: "mayor" },
      law: { id: "gas_holiday", name: "Gas Holiday" },
      election: { week: "2026-W41", phase: "voting", votingOpens: "2026-10-09T00:00:00Z", pollsClose: new Date(now + 3_600_000).toISOString(), candidates: [{ candidateId: "a", handle: "ann", pitch: "p", votes: 3 }, { candidateId: "b", handle: "bo", pitch: "p", votes: 9 }], turnout: 12, youVoted: true },
    };
    const b = hallBoard(hall, now);
    expect(b.rows.map((r) => r.left)).toEqual(["Mayor", "Law of the Week", "Election 2026-W41", "@bo", "@ann"]);
    expect(b.rows[2]!.right).toMatch(/Polls close/);
    expect(b.foot).toMatch(/You voted/);
  });
});

describe("Hash Brown's chalkboard", () => {
  it("is the same all day, changes between days, and is labelled fiction", () => {
    expect(dinerBoard("2026-10-10")).toEqual(dinerBoard("2026-10-10"));
    const days = new Set(Array.from({ length: 10 }, (_, i) => dinerBoard(`2026-10-${10 + i}`).rows[0]!.left));
    expect(days.size).toBeGreaterThan(1);
    expect(dinerBoard("2026-10-10").foot).toMatch(/fiction/i);
  });
});

describe("wrap", () => {
  it("keeps every word, never past the width unless one word is longer", () => {
    expect(wrap("the grill says the bell rings at midnight", 12)).toEqual(["the grill", "says the", "bell rings", "at midnight"]);
    expect(wrap("supercalifragilistic ok", 5)).toEqual(["supercalifragilistic", "ok"]);
  });
});

describe("room screens", () => {
  it("wire the right feeds into the right rooms", () => {
    const feedsIn = (place: string) => LAYOUTS[place]!.decor.filter((d) => d.feed).map((d) => d.feed);
    expect(feedsIn("tower")).toEqual(["odds"]);
    expect(feedsIn("watch_party")).toEqual(["match"]);
    expect(feedsIn("city_hall")).toEqual(["hall"]);
    expect(feedsIn("diner")).toEqual(["diner"]);
    for (const d of Object.values(LAYOUTS).flatMap((l) => l.decor)) if (d.feed) expect(d.kind).toBe("screen");
  });
});
