import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAST } from "../src/cast";
import { type GammaEvent, type GammaMarket, closedOutcome } from "../src/polymarket";
import {
  WARMUP,
  accountDay,
  entryClosesAt,
  isWarmupSide,
  isWindow,
  mockWarmupFeed,
  nextWindowAt,
  polymarketWarmupFeed,
  takingCalls,
  toWarmupWindow,
  warmupCredit,
  warmupEligibility,
  warmupFeedFor,
  warmupReel,
  warmupResultOf,
  warmupSlug,
  warmupStamp,
  windowStart,
} from "../src/warmup";

const t = (iso: string) => new Date(`2026-10-19T${iso}Z`);
const MIN = 60_000;
const DAY = 86_400_000;

describe("the 15-minute windows", () => {
  it("start on the quarter hour, and the next one is 15 minutes on", () => {
    expect(windowStart(t("10:00:00")).toISOString()).toBe("2026-10-19T10:00:00.000Z");
    expect(windowStart(t("10:14:59.999")).toISOString()).toBe("2026-10-19T10:00:00.000Z");
    expect(windowStart(t("10:15:00")).toISOString()).toBe("2026-10-19T10:15:00.000Z");
    expect(windowStart(t("23:59:59")).toISOString()).toBe("2026-10-19T23:45:00.000Z");
    expect(nextWindowAt(t("10:01:00")).toISOString()).toBe("2026-10-19T10:15:00.000Z");
    expect(nextWindowAt(t("23:50:00")).toISOString()).toBe("2026-10-20T00:00:00.000Z");
  });

  it("take calls only in their first 2 minutes", () => {
    const start = t("10:15:00");
    expect(entryClosesAt(start).toISOString()).toBe("2026-10-19T10:17:00.000Z");
    expect(takingCalls(start, t("10:14:59.999"))).toBe(false);
    expect(takingCalls(start, start)).toBe(true);
    expect(takingCalls(start, t("10:16:59.999"))).toBe(true);
    expect(takingCalls(start, t("10:17:00"))).toBe(false);
    expect(takingCalls(start, t("10:29:00"))).toBe(false);
    // Over a whole hour, 2 minutes in every 15 are open.
    let open = 0;
    for (let s = 0; s < 3600; s++) {
      const at = new Date(t("10:00:00").getTime() + s * 1000);
      if (takingCalls(windowStart(at), at)) open++;
    }
    expect(open).toBe(4 * WARMUP.entryMinutes * 60);
  });

  it("are a quarter hour long and start on one", () => {
    expect(isWindow(t("10:00:00"), t("10:15:00"))).toBe(true);
    expect(isWindow(t("10:05:00"), t("10:20:00"))).toBe(false);
    expect(isWindow(t("10:00:00"), t("10:05:00"))).toBe(false);
    expect(isWindow(new Date("nope"), t("10:15:00"))).toBe(false);
  });

  it("are named by their start in Unix seconds", () => {
    expect(warmupSlug(t("10:00:00"))).toBe("btc-updown-15m-1792404000");
  });
});

describe("who gets a warm-up", () => {
  const arrived = t("09:30:00");
  it("counts days from the first tap: 24 hours each", () => {
    expect(accountDay(arrived, arrived)).toBe(0);
    expect(accountDay(arrived, new Date(arrived.getTime() + DAY - 1))).toBe(0);
    expect(accountDay(arrived, new Date(arrived.getTime() + DAY))).toBe(1);
    expect(accountDay(arrived, new Date(arrived.getTime() + 3 * DAY))).toBe(3);
    // A server clock a moment behind the database's still reads day 0.
    expect(accountDay(arrived, new Date(arrived.getTime() - 5_000))).toBe(0);
  });

  it("one a day for the first 3 days, so 3 at most; a skipped day is gone", () => {
    const at = (d: number) => new Date(arrived.getTime() + d * DAY + 60 * MIN);
    expect(warmupEligibility(arrived, at(0), [])).toEqual({ ok: true, day: 0, left: 3 });
    expect(warmupEligibility(arrived, at(0), [0])).toEqual({ ok: false, reason: "used_today", day: 0, left: 2 });
    expect(warmupEligibility(arrived, at(1), [0])).toEqual({ ok: true, day: 1, left: 2 });
    expect(warmupEligibility(arrived, at(2), [0, 1])).toEqual({ ok: true, day: 2, left: 1 });
    expect(warmupEligibility(arrived, at(2), [0, 1, 2])).toEqual({ ok: false, reason: "used_today", day: 2, left: 0 });
    expect(warmupEligibility(arrived, at(2), [])).toEqual({ ok: true, day: 2, left: 1 });
    expect(warmupEligibility(arrived, at(3), [])).toEqual({ ok: false, reason: "not_new", day: 3, left: 0 });
    expect(warmupEligibility(arrived, new Date(arrived.getTime() + 3 * DAY), [])).toMatchObject({ ok: false, reason: "not_new" });
    expect(warmupEligibility(arrived, new Date(arrived.getTime() + 3 * DAY - 1), [0, 1])).toMatchObject({ ok: true, day: 2 });
  });

  it("whatever order the days come in, no resident ever gets more than 3", () => {
    // Every minute of the first 4 days, taking one whenever allowed.
    const used: number[] = [];
    for (let m = 0; m < 4 * 24 * 60; m++) {
      const e = warmupEligibility(arrived, new Date(arrived.getTime() + m * MIN), used);
      if (e.ok) used.push(e.day);
    }
    expect(used).toEqual([0, 1, 2]);
    expect(used.length).toBe(WARMUP.max);
  });

  it("knows its sides", () => {
    expect(isWarmupSide("up")).toBe(true);
    expect(isWarmupSide("down")).toBe(true);
    for (const x of ["UP", "yes", "", null, undefined, 1, {}]) expect(isWarmupSide(x)).toBe(false);
  });
});

describe("settling", () => {
  it("stamps a call against what Bitcoin did; a void is a void", () => {
    expect(warmupStamp("up", "up", false)).toBe("called_it");
    expect(warmupStamp("down", "up", false)).toBe("rekt");
    expect(warmupStamp("down", "down", false)).toBe("called_it");
    expect(warmupStamp("up", null, true)).toBe("void");
    expect(warmupStamp("up", null, false)).toBeNull();
  });

  it("the reel counts the window's newcomers, and NOTHING-9000 always called DOWN", () => {
    const up = warmupReel("up", false, ["up", "up", "down"]);
    expect(up).toEqual({ result: "up", voided: false, newcomers: 3, up: 2, down: 1, calledIt: 2, bot: { name: CAST.nothing_9000.name, label: "NPC · AI", side: "down", stamp: "rekt" } });
    expect(warmupReel("down", false, ["up"])).toMatchObject({ calledIt: 0, bot: { stamp: "called_it" } });
    expect(warmupReel(null, true, ["up", "down"])).toMatchObject({ result: null, voided: true, calledIt: 0, up: 1, down: 1, bot: { stamp: "void" } });
  });
});

// Real Gamma payloads, recorded 19 October 2026 at 10:04 UTC and trimmed to
// the fields we read: /events?slug=...&slug=... for the window then running
// (10:00 to 10:15) and the next; /markets?closed=true&slug=... for two that
// had resolved, one Down and one Up; and a window that had ended at 10:00
// but was still trading, its result not in yet.
const fixture = <T,>(name: string): T => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8")) as T;
const listed = fixture<GammaEvent[]>("gamma-warmup-events.json");
const closed = fixture<GammaMarket[]>("gamma-warmup-closed.json");
const ended = fixture<GammaEvent[]>("gamma-warmup-ended.json")[0]!.markets![0]!;
const recordedAt = t("10:04:00");
const [down, up] = closed as [GammaMarket, GammaMarket];

describe("recorded Gamma windows", () => {
  it("maps the running window and the next one", () => {
    const ws = listed.flatMap((e) => e.markets ?? []).map(toWarmupWindow);
    expect(ws.map((w) => [w!.externalId, w!.startsAt.toISOString(), w!.endsAt.toISOString(), w!.open])).toEqual([
      ["pm:5868483", "2026-10-19T10:00:00.000Z", "2026-10-19T10:15:00.000Z", true],
      ["pm:5868628", "2026-10-19T10:15:00.000Z", "2026-10-19T10:30:00.000Z", true],
    ]);
    expect(ws[0]!.question).toBe("Bitcoin Up or Down - October 19, 6:00AM-6:15AM ET");
    expect(windowStart(recordedAt).getTime()).toBe(ws[0]!.startsAt.getTime());
    expect(takingCalls(ws[0]!.startsAt, recordedAt)).toBe(false); // 4 minutes in
    expect(takingCalls(ws[1]!.startsAt, t("10:15:30"))).toBe(true);
  });

  it("refuses anything that isn't one of the series", () => {
    const m = listed[0]!.markets![0]!;
    expect(toWarmupWindow({ ...m, outcomes: '["Yes", "No"]' })).toBeNull();
    expect(toWarmupWindow({ ...m, outcomes: '["Down", "Up"]' })).toBeNull();
    expect(toWarmupWindow({ ...m, slug: "eth-updown-15m-1792404000" })).toBeNull();
    expect(toWarmupWindow({ ...m, eventStartTime: "2026-10-19T10:05:00Z" })).toBeNull(); // not on the quarter hour
    expect(toWarmupWindow({ ...m, endDate: "2026-10-19T11:00:00Z" })).toBeNull(); // an hourly window
    expect(toWarmupWindow({ ...m, eventStartTime: undefined })).toBeNull();
    expect(toWarmupWindow({ ...m, closed: true })).toMatchObject({ open: false });
    expect(toWarmupWindow({ ...m, acceptingOrders: false })).toMatchObject({ open: false });
    expect(toWarmupWindow(null as unknown as GammaMarket)).toBeNull();
  });

  it("reads results by the Tower's rules: Up, Down, a 50/50 void, and a result not final yet waits", () => {
    expect(warmupResultOf(up)).toEqual({ externalId: "pm:5866801", outcome: "up", voided: false });
    expect(warmupResultOf(down)).toEqual({ externalId: "pm:5866083", outcome: "down", voided: false });
    // Ended but still trading: nothing to say yet.
    expect(warmupResultOf(ended)).toBeNull();
    // The same payload as the recorded result, changed only where it says:
    expect(warmupResultOf({ ...up, outcomePrices: '["0.5", "0.5"]' })).toEqual({ externalId: "pm:5866801", outcome: null, voided: true });
    expect(warmupResultOf({ ...up, umaResolutionStatus: "proposed" })).toEqual({ externalId: "pm:5866801", outcome: null, voided: false });
    expect(warmupResultOf({ ...up, umaResolutionStatus: "disputed" })).toMatchObject({ outcome: null, voided: false });
    expect(warmupResultOf({ ...up, outcomePrices: '["0.9995", "0.0005"]' })).toMatchObject({ outcome: null, voided: false });
    expect(warmupResultOf({ ...up, outcomes: '["Yes", "No"]' })).toBeNull();
    // The Tower's reader, left as it was, doesn't take an Up/Down market for a YES/NO one.
    expect(closedOutcome(up)).toBeNull();
  });
});

describe("the live warm-up feed", () => {
  const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  const bad = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) });
  // Gamma as recorded: the two windows by slug, and closed markets by id.
  function gamma(opts: { urls?: string[]; events?: () => ReturnType<typeof ok>; lookup?: () => ReturnType<typeof ok> } = {}) {
    return (url: string) => {
      opts.urls?.push(url);
      const u = new URL(url);
      if (u.pathname === "/events") return opts.events ? opts.events() : ok(listed);
      if (opts.lookup) return opts.lookup();
      const ids = u.searchParams.getAll("id");
      return ok(closed.filter((m) => ids.includes(m.id)));
    };
  }

  it("asks for this window and the next by slug, and the ended ones by id among the closed", async () => {
    const urls: string[] = [];
    const f = polymarketWarmupFeed({ fetch: gamma({ urls }), log: () => {} });
    const r = await f.fetch(recordedAt, ["pm:5866083", "pm:5866801", "pm:5867770", "sample:x"]);
    expect(f.source).toBe("polymarket");
    expect(r.windows.map((w) => w.externalId)).toEqual(["pm:5868483", "pm:5868628"]);
    expect(r.results).toEqual([
      { externalId: "pm:5866083", outcome: "down", voided: false },
      { externalId: "pm:5866801", outcome: "up", voided: false },
    ]);
    const [events, lookup] = urls.map((u) => new URL(u));
    expect(events!.pathname).toBe("/events");
    expect(events!.searchParams.getAll("slug")).toEqual(["btc-updown-15m-1792404000", "btc-updown-15m-1792404900"]);
    expect(lookup!.pathname).toBe("/markets");
    expect(lookup!.searchParams.get("closed")).toBe("true");
    expect(lookup!.searchParams.getAll("id")).toEqual(["5866083", "5866801", "5867770"]);
  });

  it("asks at an address of the poll's own, so Gamma's 5-minute cache can't hold a result back", async () => {
    // Seen 19 October: Gamma answers with Cache-Control: public, max-age=300.
    // Asked the same address every 10 seconds, the 15:00 window's result
    // (resolved at 15:01:20) came back at 15:05:03. For the 15:15 window, a
    // fresh address had it at 15:17:34, while the same one still said "not
    // yet" from a cache 159 seconds old.
    const pending = ["pm:5866083", "pm:5866801"];
    const first: string[] = [];
    const next: string[] = [];
    await polymarketWarmupFeed({ fetch: gamma({ urls: first }) }).fetch(recordedAt, pending);
    await polymarketWarmupFeed({ fetch: gamma({ urls: next }) }).fetch(new Date(recordedAt.getTime() + MIN), pending);
    expect(first.map((u) => new URL(u).searchParams.get("poll"))).toEqual([String(recordedAt.getTime()), String(recordedAt.getTime())]);
    expect(next.filter((u) => first.includes(u))).toEqual([]);
    // The same two questions all the same.
    expect(next.map((u) => new URL(u).searchParams.getAll("slug").concat(new URL(u).searchParams.getAll("id")))).toEqual(first.map((u) => new URL(u).searchParams.getAll("slug").concat(new URL(u).searchParams.getAll("id"))));
  });

  it("nothing pending: no lookup at all", async () => {
    const urls: string[] = [];
    await polymarketWarmupFeed({ fetch: gamma({ urls }) }).fetch(recordedAt);
    expect(urls.map((u) => new URL(u).pathname)).toEqual(["/events"]);
  });

  it("a failed or empty window request lists no window (a failed poll) but keeps the results; a failed lookup only waits", async () => {
    const logs: string[] = [];
    const log = (l: string) => logs.push(l);
    // The series paused or changed shape, while the ended window's result is in.
    const resolved = [{ externalId: "pm:5866083", outcome: "down", voided: false }];
    expect(await polymarketWarmupFeed({ fetch: gamma({ events: bad }), log }).fetch(recordedAt, ["pm:5866083"])).toEqual({ windows: [], results: resolved });
    expect(await polymarketWarmupFeed({ fetch: gamma({ events: () => ok([]) }), log }).fetch(recordedAt, ["pm:5866083"])).toEqual({ windows: [], results: resolved });
    const unreadable = () => ok([{ slug: "x", markets: [{ id: "1", question: "?" }] }]);
    expect(await polymarketWarmupFeed({ fetch: gamma({ events: unreadable }), log }).fetch(recordedAt, ["pm:5866083"])).toEqual({ windows: [], results: resolved });
    expect(await polymarketWarmupFeed({ fetch: () => Promise.reject(new Error("offline")), log }).fetch(recordedAt, ["pm:5866083"])).toEqual({ windows: [], results: [] });
    expect(logs).toEqual([
      "polymarket warm-up: the window request failed",
      "polymarket warm-up: no readable window in 0 events",
      "polymarket warm-up: no readable window in 1 events",
      "polymarket warm-up: looking up 1 ended windows failed",
      "polymarket warm-up: the window request failed",
    ]);
    logs.length = 0;
    const r = await polymarketWarmupFeed({ fetch: gamma({ lookup: bad }), log }).fetch(recordedAt, ["pm:5866083"]);
    expect(r.windows).toHaveLength(2);
    expect(r.results).toEqual([]);
    expect(logs).toEqual(["polymarket warm-up: looking up 1 ended windows failed"]);
  });

  it("asks about at most 100 ended windows a poll", async () => {
    const urls: string[] = [];
    await polymarketWarmupFeed({ fetch: gamma({ urls }) }).fetch(recordedAt, Array.from({ length: 150 }, (_, i) => `pm:${i}`));
    expect(new URL(urls[1]!).searchParams.getAll("id")).toHaveLength(WARMUP.lookupsPerPoll);
  });
});

describe("the sample feed and the credit", () => {
  it("lists this window and the next, and settles each a minute after it ends", async () => {
    const f = mockWarmupFeed();
    const r = await f.fetch(t("10:01:00"));
    expect(f.source).toBe("mock");
    expect(r.windows.map((w) => [w.externalId, w.startsAt.toISOString(), w.open])).toEqual([
      ["sample:btc-updown-15m-1792404000", "2026-10-19T10:00:00.000Z", true],
      ["sample:btc-updown-15m-1792404900", "2026-10-19T10:15:00.000Z", true],
    ]);
    expect(r.windows[0]!.question).toBe("Bitcoin up or down, 10:00 to 10:15 UTC? (sample)");
    const id = r.windows[0]!.externalId;
    expect((await f.fetch(t("10:15:59"), [id])).results).toEqual([]);
    const [res] = (await f.fetch(t("10:16:00"), [id, "pm:1", "sample:junk"])).results;
    expect(res).toMatchObject({ externalId: id, voided: false });
    expect(isWarmupSide(res!.outcome)).toBe(true);
    // The same answer every time.
    expect((await f.fetch(t("11:00:00"), [id])).results[0]!.outcome).toBe(res!.outcome);
  });

  it("follows ODDS_SOURCE, and only Polymarket's windows carry its name", () => {
    expect(warmupFeedFor("polymarket")?.source).toBe("polymarket");
    expect(warmupFeedFor("mock")?.source).toBe("mock");
    expect(warmupFeedFor(undefined)).toBeUndefined();
    expect(warmupFeedFor("other")).toBeUndefined();
    expect(warmupCredit("polymarket")).toBe("Window from Polymarket · Not affiliated");
    expect(warmupCredit("mock")).toBe("Sample window · Not real");
  });
});
