import { describe, expect, it } from "vitest";
import type { CityHall, CityMarket, MarketRow, Roof, RoofRightRow } from "../src/api";
import { LAYOUTS } from "../src/interiors";
import { type FeedStatus, wrap, crewsBoard, dinerBoard, feedAfter, hallBoard, matchBoard, oddsBoard, rightListBoard, roofBoards, roofRefreshIn, stackBoard } from "../src/roomfeeds";

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

describe("the Watch Party's City markets", () => {
  const city = (id: string, inHours: number, place: string | null = "watch_party"): CityMarket => ({ id, question: `${id}: 60+ in the Hall at full time?`, kind: place ? "headcount" : "manual", place, threshold: place ? 60 : null, locksAt: new Date(now + inHours * 3_600_000).toISOString(), bellDay: "2026-10-10" });
  const sports = Array.from({ length: 8 }, (_, i) => mk(`s${i}`, "sports", 50, i + 1));

  it("share the screen under the matches: the Hall's own, still open, soonest first, two at most", () => {
    const b = matchBoard(sports, now, live, [city("late", 5), city("roof", 1, "roof"), city("locked", -1), city("manual", 1, null), city("soon", 2), city("later", 6)]);
    expect(b.rows).toHaveLength(6);
    expect(b.rows.slice(0, 4).map((r) => r.left)).toEqual(["Q s0?", "Q s1?", "Q s2?", "Q s3?"]);
    expect(b.rows.slice(4)).toEqual([
      { left: "City · soon: 60+ in the Hall at full time?", right: "GM · locks in 2h 0m", tone: "plain" },
      { left: "City · late: 60+ in the Hall at full time?", right: "GM · locks in 5h 0m", tone: "plain" },
    ]);
    expect(b.title).toBe("WATCH PARTY · ON TONIGHT");
    expect(b.foot).toBe(POLYMARKET_CREDIT); // the credit is for the odds; City rows say GM
  });

  it("with no match on, the Hall's market still shows under the honest empty line", () => {
    const b = matchBoard([], now, live, [city("soon", 2)]);
    expect(b.rows.map((r) => r.left)).toEqual(["No match on right now. Grab a beanbag.", "City · soon: 60+ in the Hall at full time?"]);
  });

  it("without any, the screen is exactly what it was", () => {
    expect(matchBoard(sports, now, live, [city("roof", 1, "roof")])).toEqual(matchBoard(sports, now, live));
  });
});

describe("the Watch Party's matches in play", () => {
  const playing = (id: string, price: number) => ({ id, question: `${id} wins?`, price, kickoffAt: new Date(now - 3_600_000).toISOString(), settlesBy: new Date(now + 3_600_000).toISOString(), source: POLYMARKET_CREDIT });
  const sports = Array.from({ length: 8 }, (_, i) => mk(`s${i}`, "sports", 50, i + 1));
  const city = { id: "c", question: "60+ in the Hall at full time?", kind: "headcount", place: "watch_party", threshold: 60, locksAt: new Date(now + 2 * 3_600_000).toISOString(), bellDay: "2026-10-10" } satisfies CityMarket;

  it("come first, live, three at most, then tonight's matches and the Hall's market", () => {
    const b = matchBoard(sports, now, live, [city], [playing("Arsenal", 63), playing("Lakers", 41), playing("Chiefs", 55), playing("Celtics", 70)]);
    expect(b.title).toBe("WATCH PARTY · LIVE NOW");
    expect(b.rows).toHaveLength(6);
    expect(b.rows.slice(0, 3)).toEqual([
      { left: "LIVE · Arsenal wins?", right: "63% YES · in play", tone: "plain" },
      { left: "LIVE · Lakers wins?", right: "41% YES · in play", tone: "plain" },
      { left: "LIVE · Chiefs wins?", right: "55% YES · in play", tone: "plain" },
    ]);
    expect(b.rows.slice(3).map((r) => r.left)).toEqual(["Q s0?", "Q s1?", "City · 60+ in the Hall at full time?"]);
  });

  it("with nothing else on, a live match is enough: no empty line", () => {
    const b = matchBoard([], now, live, [], [playing("Arsenal", 63)]);
    expect(b.rows.map((r) => r.left)).toEqual(["LIVE · Arsenal wins?"]);
    expect(b.title).toBe("WATCH PARTY · LIVE NOW");
  });

  it("without any, the screen is exactly what it was", () => {
    expect(matchBoard(sports, now, live, [city], [])).toEqual(matchBoard(sports, now, live, [city]));
  });
});

describe("the Roof's boards", () => {
  // now is 12:00 UTC on 2026-10-10, so the last bell rang at 00:00 that day.
  const bellAt = "2026-10-10T00:00:00.000Z";
  const roof = (over: Partial<Roof> = {}): Roof => ({ bellAt, season: 3, rightList: { rows: [], bot: null }, seasonStack: { rows: [] }, crews: { bellDay: "2026-10-09", bellScores: [], league: null }, ...over });
  const row = (rank: number, handle: string, perCall: number, extra: Partial<RoofRightRow> = {}): RoofRightRow => ({ rank, handle, npc: null, perCall, spread: 1.2, rusty: false, ...extra });
  const nothing = (rank: number) => row(rank, "NOTHING-9000", -4.4, { npc: "NPC · AI", spread: 0.8 });
  const bot = (rank: number) => ({ rank, perCall: -4.4, spread: 0.8 });
  const got = (r: Roof) => ({ roof: r, failed: false });

  it("loading, then failing with nothing to show: honest on every board", () => {
    for (const b of Object.values(roofBoards({ roof: null, failed: false }, now))) {
      expect(b.rows).toEqual([{ left: "Loading the boards…", tone: "plain" }]);
      expect(b.dim).toBeFalsy();
    }
    for (const b of Object.values(roofBoards({ roof: null, failed: true }, now))) {
      expect(b.rows).toEqual([{ left: "Can't reach the boards right now.", tone: "plain" }]);
      expect([b.dim, b.foot]).toEqual([true, "Trying again soon."]);
    }
    expect(Object.values(roofBoards({ roof: null, failed: false }, now)).map((b) => b.title)).toEqual(["THE RIGHT LIST", "SEASON STACK", "CREWS"]);
  });

  it("empty boards say so and never invent a row", () => {
    const b = roofBoards(got(roof()), now);
    expect(b.right_list.rows).toEqual([{ left: "Nobody's on it yet. Calls settle, then the list fills.", tone: "plain" }]);
    expect(b.right_list.foot).toBe("10 settled calls in a season to make the list.");
    expect(b.stack.rows).toEqual([{ left: "Nobody's on the stack yet this season.", tone: "plain" }]);
    expect(b.crews.rows.map((r) => r.left)).toEqual(["No Bell Scores from the last bell.", "The first League table lands at Sunday's bell."]);
    for (const x of Object.values(b)) expect(x.dim).toBeFalsy();
  });

  it("the Right List: Aura per call ± spread as the plan writes it, the cast labelled, rusty marked, the line above NOTHING-9000", () => {
    const b = rightListBoard(got(roof({ rightList: { rows: [row(1, "ada", 6.24), row(2, "The Contrarian", 1.1, { npc: "NPC · AI" }), row(3, "jo", 0.01, { rusty: true }), nothing(4), row(5, "kemi", -1.46)], bot: bot(4) } })), now);
    expect(b.title).toBe("THE RIGHT LIST · SEASON 3");
    expect(b.rows.map((r) => [r.left, r.right])).toEqual([
      ["#1 @ada", "+6.2 per call ± 1.2"],
      ["#2 The Contrarian · NPC · AI", "+1.1 per call ± 1.2"],
      ["#3 @jo · rusty", "0.0 per call ± 1.2"],
      ["#4 NOTHING-9000 · NPC · AI", "−4.4 per call ± 0.8"],
      ["#5 @kemi", "−1.5 per call ± 1.2"],
    ]);
    expect(b.rows.map((r) => !!r.rule)).toEqual([false, false, false, true, false]);
    expect(b.rows.every((r) => r.tone === "plain")).toBe(true);
    expect(b.foot).toBe("Everyone above the line beat a bot that says no to everything.");
  });

  it("a bot ranked below the board comes last, under the top five, with its line", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, `r${i + 1}`, 9 - i));
    const b = rightListBoard(got(roof({ rightList: { rows, bot: bot(40) } })), now);
    expect(b.rows.map((r) => r.left)).toEqual(["#1 @r1", "#2 @r2", "#3 @r3", "#4 @r4", "#5 @r5", "#40 NOTHING-9000 · NPC · AI"]);
    expect(b.rows[5]).toEqual({ left: "#40 NOTHING-9000 · NPC · AI", right: "−4.4 per call ± 0.8", tone: "plain", rule: true });
    // Its row sent down with the rest (ranked 8th) still moves up under the top five.
    const sent = rightListBoard(got(roof({ rightList: { rows: [...rows.slice(0, 7), nothing(8), ...rows.slice(7)], bot: bot(8) } })), now);
    expect(sent.rows.map((r) => r.left).at(-1)).toBe("#8 NOTHING-9000 · NPC · AI");
    expect(sent.rows.filter((r) => r.rule)).toHaveLength(1);
  });

  it("rows the API left out for this reader are gaps in the ranks, never renumbered", () => {
    const b = rightListBoard(got(roof({ rightList: { rows: [row(1, "ada", 5), row(4, "jo", 2)], bot: null } })), now);
    expect(b.rows.map((r) => r.left)).toEqual(["#1 @ada", "#4 @jo"]);
  });

  it("the Season Stack: GM won and lost, by handle", () => {
    const b = stackBoard(got(roof({ seasonStack: { rows: [{ rank: 1, handle: "sol", profit: 1240 }, { rank: 2, handle: "ada", profit: 0 }, { rank: 3, handle: "jo", profit: -80 }] } })), now);
    expect(b.title).toBe("SEASON STACK · SEASON 3");
    expect(b.rows.map((r) => [r.left, r.right])).toEqual([["#1 @sol", "+1,240 GM"], ["#2 @ada", "0 GM"], ["#3 @jo", "−80 GM"]]);
    expect(b.foot).toBe("GM won on City markets and duels. Real money is never ranked.");
  });

  it("the crews: the last bell's top Bell Scores, then each size group's League champions", () => {
    const crews: Roof["crews"] = { bellDay: "2026-10-09", bellScores: [{ rank: 1, name: "Night Owls", score: 7.5 }, { rank: 2, name: "gm Gang", score: 4 }, { rank: 3, name: "Roof Rats", score: 2.25 }], league: { week: "2026-09-28", champions: [{ sizeGroup: "small", name: "Night Owls" }, { sizeGroup: "large", name: "Big Tent" }] } };
    const b = crewsBoard(got(roof({ crews })), now);
    expect(b.rows.map((r) => [r.left, r.right])).toEqual([
      ["#1 Night Owls", "Bell Score 7.5"],
      ["#2 gm Gang", "Bell Score 4"],
      ["#3 Roof Rats", "Bell Score 2.25"],
      ["Night Owls", "League champs · 3–10"],
      ["Big Tent", "League champs · 26–50"],
    ]);
    expect(b.foot).toBe("Last bell's Bell Scores · League week of Sep 28");
    const nobody = crewsBoard(got(roof({ crews: { ...crews, league: { week: "2026-09-28", champions: [] } } })), now);
    expect(nobody.rows.at(-1)!.left).toBe("No League champions that week.");
  });

  it("boards from before the last bell dim and say so; a failed refresh of today's changes nothing", () => {
    const old = roof({ bellAt: "2026-10-09T00:00:00.000Z", seasonStack: { rows: [{ rank: 1, handle: "sol", profit: 5 }] } });
    for (const b of Object.values(roofBoards({ roof: old, failed: true }, now))) expect([b.dim, b.foot]).toEqual([true, "From before the last bell. Refreshing…"]);
    expect(stackBoard(got(old), now).rows[0]!.left).toBe("#1 @sol"); // still there, dimmed
    // They only move at the bell, so today's boards stand after a failed refresh.
    expect(roofBoards({ roof: roof(), failed: true }, now)).toEqual(roofBoards(got(roof()), now));
  });

  it("fetches again every 5 minutes, and a minute and a half after each bell", () => {
    expect(roofRefreshIn(now)).toBe(5 * 60_000);
    expect(roofRefreshIn(now, roof())).toBe(5 * 60_000);
    const bell = Date.parse("2026-10-11T00:00:00Z");
    expect(roofRefreshIn(bell - 60_000, roof())).toBe(150_000);
    expect(roofRefreshIn(bell + 30_000)).toBe(5 * 60_000);
  });

  it("boards the server still has from before the last bell (its runner isn't done) are asked for every minute", () => {
    const old = roof({ bellAt: "2026-10-09T00:00:00.000Z" });
    expect(roofRefreshIn(now, old)).toBe(60_000);
    for (const b of Object.values(roofBoards(got(old), now))) expect([b.dim, b.foot]).toEqual([true, "From before the last bell. Refreshing…"]);
    // Once the answer is tonight's, back to every 5 minutes.
    const bell = Date.parse("2026-10-11T00:00:00Z");
    expect(roofRefreshIn(bell + 120_000, roof())).toBe(60_000);
    expect(roofRefreshIn(bell + 120_000, roof({ bellAt: "2026-10-11T00:00:00.000Z" }))).toBe(5 * 60_000);
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
    expect(feedsIn("roof")).toEqual(["crews", "right_list", "stack"]); // the Right List beside the Season Stack
    for (const d of Object.values(LAYOUTS).flatMap((l) => l.decor)) if (d.feed) expect(d.kind).toBe("screen");
  });
});
