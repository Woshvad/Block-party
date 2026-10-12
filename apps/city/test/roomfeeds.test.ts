import { describe, expect, it } from "vitest";
import type { CityHall, MarketRow } from "../src/api";
import { LAYOUTS } from "../src/interiors";
import { type FeedStatus, wrap, dinerBoard, feedAfter, hallBoard, matchBoard, oddsBoard } from "../src/roomfeeds";

// What /v1/tower/feed says, per source (oddsCredit in @bp/core).
const POLYMARKET_CREDIT = "Odds via Polymarket · Not affiliated";
const SAMPLE_CREDIT = "Sample odds · Not real";

const now = Date.parse("2026-10-10T12:00:00Z");
const mk = (id: string, category: string, price: number, inHours: number): MarketRow => ({ id, question: `Q ${id}?`, category, price, freezesAt: new Date(now + inHours * 3_600_000).toISOString(), infoOnly: category === "politics" });
const live: FeedStatus = { paused: false, lastTickAt: new Date(now - 30_000).toISOString(), credit: POLYMARKET_CREDIT };
// Early on the same local day as `now`, whatever the machine's time zone.
const pausedAt = new Date(new Date(now).setHours(0, 1, 0, 0)).toISOString();
const paused: FeedStatus = { paused: true, lastTickAt: pausedAt, credit: POLYMARKET_CREDIT };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

describe("the Odds Wall", () => {
  const ms = [mk("c1", "crypto", 62, 5), mk("c2", "crypto", 30, 1), mk("s1", "sports", 45, 3), mk("p1", "politics", 80, 9), mk("old", "crypto", 50, -1)];

  it("shows open markets only, every category up top, soonest first, credited", () => {
    const b = oddsBoard(ms, now, live);
    expect(b.rows.map((r) => r.left)).toEqual(["Q c2?", "Q s1?", "Q p1?", "Q c1?"]);
    expect(b.foot).toBe(POLYMARKET_CREDIT);
    expect(b.dim).toBeFalsy();
  });

  it("paints prices neutral: a level is not a move up or down", () => {
    const b = oddsBoard([mk("a", "crypto", 50, 1), mk("b", "sports", 49, 2), mk("c", "politics", 97, 3)], now, live);
    expect(b.rows.map((r) => r.tone)).toEqual(["plain", "plain", "plain"]);
    expect(b.rows[0]!.right).toMatch(/^50% YES/);
  });

  it("caps rows, clips long questions, and says so when there's nothing open", () => {
    const many = Array.from({ length: 20 }, (_, i) => mk(String(i), "crypto", 50, i + 1));
    expect(oddsBoard(many, now, live).rows).toHaveLength(6);
    expect(oddsBoard([{ ...mk("x", "crypto", 50, 1), question: "x".repeat(200) }], now, live).rows[0]!.left.length).toBeLessThanOrEqual(52);
    expect(oddsBoard([], now, live).rows[0]!.left).toMatch(/No open markets/);
    expect(oddsBoard([], now, paused).rows[0]!.left).toMatch(/paused/);
  });

  it("when the feed is paused, dims the wall and says since when, credit kept", () => {
    const b = oddsBoard(ms, now, paused);
    expect(b.dim).toBe(true);
    expect(b.foot).toBe(`Paused since ${hhmm(pausedAt)} · ${POLYMARKET_CREDIT}`);
    expect(b.rows.map((r) => r.left)).toEqual(["Q c2?", "Q s1?", "Q p1?", "Q c1?"]);
  });

  it("an unknown feed (never fetched) never counts as live, and credits nobody", () => {
    const b = oddsBoard(ms, now, null);
    expect(b.dim).toBe(true);
    expect(b.foot).toBe("Odds paused");
    expect(oddsBoard(ms, now, { paused: true, lastTickAt: null, credit: POLYMARKET_CREDIT }).foot).toBe(`Odds paused · ${POLYMARKET_CREDIT}`);
  });

  it("a pause from an earlier day gives the date too", () => {
    const old = new Date(now - 3 * 86_400_000).toISOString();
    const day = new Date(old).toLocaleDateString([], { month: "short", day: "numeric" });
    expect(oddsBoard(ms, now, { paused: true, lastTickAt: old, credit: POLYMARKET_CREDIT }).foot).toBe(`Paused since ${day} ${hhmm(old)} · ${POLYMARKET_CREDIT}`);
  });

  it("sample odds never carry Polymarket's name: the credit is the API's", () => {
    const sample: FeedStatus = { ...live, credit: SAMPLE_CREDIT };
    expect(oddsBoard(ms, now, sample).foot).toBe(SAMPLE_CREDIT);
    expect(matchBoard([mk("s", "sports", 50, 2)], now, sample).foot).toBe(SAMPLE_CREDIT);
    expect(oddsBoard(ms, now, { ...sample, paused: true }).foot).toBe(`Paused since ${hhmm(sample.lastTickAt!)} · ${SAMPLE_CREDIT}`);
    expect(oddsBoard(ms, now, { ...live, credit: null }).foot).toBeUndefined();
  });
});

describe("the feed behind the walls", () => {
  it("is live only when both the prices and the feed status came back", () => {
    expect(feedAfter(null, true, live)).toEqual(live);
    expect(feedAfter(live, true, paused)).toEqual(paused);
  });

  it("a failed refresh counts as paused since the last good one", () => {
    expect(feedAfter(live, false, live)).toEqual({ paused: true, lastTickAt: live.lastTickAt, credit: POLYMARKET_CREDIT });
    expect(feedAfter(live, true, null)).toEqual({ paused: true, lastTickAt: live.lastTickAt, credit: POLYMARKET_CREDIT });
    expect(feedAfter(null, false, null)).toEqual({ paused: true, lastTickAt: null, credit: null });
  });
});

describe("the Watch Party screen", () => {
  it("shows sports only, or an honest empty line", () => {
    expect(matchBoard([mk("c", "crypto", 50, 1), mk("s", "sports", 50, 2)], now, live).rows.map((r) => r.left)).toEqual(["Q s?"]);
    expect(matchBoard([mk("c", "crypto", 50, 1)], now, live).rows[0]!.left).toMatch(/No match/);
  });

  it("only matches before the bell are on tonight", () => {
    // now is 12:00 UTC; the bell is at 00:00 UTC, 12 hours away.
    const b = matchBoard([mk("tonight", "sports", 50, 6), mk("tomorrow", "sports", 50, 20), mk("next_month", "sports", 50, 24 * 30)], now, live);
    expect(b.title).toBe("WATCH PARTY · ON TONIGHT");
    expect(b.rows.map((r) => r.left)).toEqual(["Q tonight?"]);
  });

  it("with nothing tonight, later matches show as coming up, never as tonight", () => {
    const b = matchBoard([mk("next_month", "sports", 50, 24 * 30), mk("tomorrow", "sports", 50, 20)], now, live);
    expect(b.title).toBe("WATCH PARTY · COMING UP");
    expect(b.rows.map((r) => r.left)).toEqual(["Q tomorrow?", "Q next_month?"]);
  });

  it("dims with the feed like the Odds Wall", () => {
    const b = matchBoard([mk("s", "sports", 50, 2)], now, paused);
    expect(b.dim).toBe(true);
    expect(b.foot).toMatch(/^Paused since /);
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
