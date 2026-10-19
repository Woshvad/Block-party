import { randomUUID } from "node:crypto";
import { WARMUP, type WarmupFeed, type WarmupResult, type WarmupWindow, nextWindowAt, userAccountId, windowStart } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WarmupError,
  createCityMarket,
  createDb,
  createGuest,
  ensureSystemAccounts,
  getBalance,
  makeWarmup,
  moodState,
  openCityMarkets,
  pollWarmup,
  rightList,
  setPrefs,
  settleWarmups,
  useCopium,
  warmupState,
} from "../src";
import { makeResident, raceAt } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 20 });
beforeAll(() => ensureSystemAccounts(db));
afterAll(() => close());

const MIN = 60_000;
const DAY = 86_400_000;
// Each test gets days of its own, far from anything else in the shared
// database, starting on a quarter hour (10:00 UTC). Windows are kept per
// feed, and every test has a feed of its own.
let base = Date.UTC(2044, 0, 1 + Math.floor(Math.random() * 2000), 10, 0);
const fresh = () => (base += 6 * DAY);
const at = (ms: number) => new Date(ms);

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof WarmupError) return e.code;
    throw e;
  }
}
async function refused(q: Promise<unknown>) {
  try {
    await q;
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

// A moved-in resident (or a guest) who arrived at `arrivedAt`.
async function newcomer(arrivedAt: number, opts: { guest?: boolean } = {}) {
  const id = opts.guest ? (await createGuest(db, { ageAck: true })).userId : await makeResident(db);
  await client`UPDATE users SET created_at = ${at(arrivedAt)} WHERE id = ${id}`;
  return id;
}

// A feed the test drives by hand: it lists this window and the next, and
// answers for the ended windows it's asked about with whatever results the
// test has set (plus `early`, results nobody asked for).
function scripted() {
  const source = `warmup-test-${randomUUID().slice(0, 8)}`;
  const results = new Map<string, WarmupResult>();
  const s = {
    source,
    results,
    early: [] as WarmupResult[],
    asked: [] as string[][],
    fail: false,
    listing: true,
    trading: true,
    idOf: (start: number) => `${source}:${start}`,
    window(start: Date): WarmupWindow {
      return { externalId: s.idOf(start.getTime()), question: "Bitcoin Up or Down?", startsAt: start, endsAt: new Date(start.getTime() + 15 * MIN), open: s.trading };
    },
    result(start: number, r: "up" | "down" | "void" | "waiting") {
      const externalId = s.idOf(start);
      results.set(externalId, { externalId, outcome: r === "up" || r === "down" ? r : null, voided: r === "void" });
    },
    feed: null as unknown as WarmupFeed,
  };
  s.feed = {
    source,
    async fetch(now, pending = []) {
      s.asked.push([...pending]);
      if (s.fail) throw new Error("gamma is down");
      return {
        windows: s.listing ? [s.window(windowStart(now)), s.window(nextWindowAt(now))] : [],
        results: [...pending.flatMap((id) => (results.has(id) ? [results.get(id)!] : [])), ...s.early],
      };
    },
  };
  return s;
}

const opts = (s: { source: string }, now: number) => ({ now: at(now), source: s.source });
const windowRow = async (s: { source: string }, start: number) =>
  (await client`SELECT id, status, outcome, trading FROM warmup_windows WHERE source = ${s.source} AND starts_at = ${at(start)}`)[0];
const callOf = async (id: string) => (await client`SELECT * FROM warmup_calls WHERE id = ${id}`)[0]!;

describe("the warm-up feed", () => {
  it("a poll stores this window and the next, once each, and nothing on the Tower", async () => {
    const t = fresh();
    const s = scripted();
    const towerBefore = (await client`SELECT count(*)::int AS n FROM markets`)[0]!.n;
    expect(await pollWarmup(db, s.feed, { now: at(t + 5 * MIN) })).toMatchObject({ ok: true, skipped: false, windows: 2, resolved: 0, voided: 0, bad: 0, settled: 0 });
    expect(await pollWarmup(db, s.feed, { now: at(t + 6 * MIN) })).toMatchObject({ ok: true, windows: 2 });
    const rows = await client`SELECT starts_at, ends_at, status, trading FROM warmup_windows WHERE source = ${s.source} ORDER BY starts_at`;
    expect(rows.map((r) => [r.starts_at.getTime(), r.ends_at.getTime(), r.status, r.trading])).toEqual([
      [t, t + 15 * MIN, "open", true],
      [t + 15 * MIN, t + 30 * MIN, "open", true],
    ]);
    // Kept apart: the Tower's markets (the Floor, the Slate, the City bar) never see a window.
    expect((await client`SELECT count(*)::int AS n FROM markets`)[0]!.n).toBe(towerBefore);
  });

  it("a failed fetch is recorded and the feed reads down; a good poll brings it back; 3 quiet minutes and it's down again", async () => {
    const t = fresh();
    const s = scripted();
    const u = await newcomer(t - 60 * MIN);
    s.fail = true;
    expect(await pollWarmup(db, s.feed, { now: at(t) })).toEqual({ ok: false, skipped: false });
    expect((await client`SELECT ok, error FROM warmup_polls WHERE source = ${s.source}`)[0]).toEqual({ ok: false, error: "gamma is down" });
    expect((await warmupState(db, u, opts(s, t + 30_000))).feed).toEqual({ live: false, credit: "Sample window · Not real" });
    s.fail = false;
    await pollWarmup(db, s.feed, { now: at(t + MIN) });
    expect((await warmupState(db, u, opts(s, t + MIN))).feed.live).toBe(true);
    expect((await warmupState(db, u, opts(s, t + MIN + WARMUP.feedPausedAfterSeconds * 1000))).feed.live).toBe(true);
    expect((await warmupState(db, u, opts(s, t + MIN + WARMUP.feedPausedAfterSeconds * 1000 + 1))).feed.live).toBe(false);
    // A poll stamped later than now is no proof the feed is alive.
    expect((await warmupState(db, u, opts(s, t + 30_000))).feed.live).toBe(false);
  });

  it("junk from the feed is skipped and counted, and a feed that isn't one is refused outright", async () => {
    const t = fresh();
    const s = scripted();
    const junk: WarmupFeed = {
      source: s.source,
      fetch: async () => ({
        windows: [
          { externalId: "a", question: "Q?", startsAt: at(t + 5 * MIN), endsAt: at(t + 20 * MIN), open: true }, // not on the quarter hour
          { externalId: "b", question: "Q?", startsAt: at(t), endsAt: at(t + 60 * MIN), open: true }, // an hour long
          { externalId: "", question: "Q?", startsAt: at(t), endsAt: at(t + 15 * MIN), open: true },
          { externalId: "c", question: "Q?", startsAt: at(t), endsAt: at(t + 15 * MIN), open: "yes" } as unknown as WarmupWindow,
          null as unknown as WarmupWindow,
        ],
        results: [{ externalId: "d", outcome: "up", voided: true }, { externalId: "e", outcome: "sideways", voided: false } as unknown as WarmupResult],
      }),
    };
    expect(await pollWarmup(db, junk, { now: at(t) })).toMatchObject({ ok: true, windows: 0, bad: 7 });
    expect((await client`SELECT count(*)::int AS n FROM warmup_windows WHERE source = ${s.source}`)[0]!.n).toBe(0);
    const shapeless = { source: s.source, fetch: async () => ({ windows: "nope" }) } as unknown as WarmupFeed;
    expect(await pollWarmup(db, shapeless, { now: at(t + MIN) })).toEqual({ ok: false, skipped: false });
    await expect(pollWarmup(db, { fetch: async () => ({ windows: [], results: [] }) } as unknown as WarmupFeed)).rejects.toThrow(/needs a warm-up feed/);
  });

  it("asks only about ended windows someone called, newest first", async () => {
    const t = fresh();
    const s = scripted();
    const [a, b] = [await newcomer(t - 60 * MIN), await newcomer(t + 15 * MIN - 60 * MIN)];
    await pollWarmup(db, s.feed, { now: at(t) });
    await makeWarmup(db, a, { side: "up" }, opts(s, t + MIN));
    await pollWarmup(db, s.feed, { now: at(t + 15 * MIN) });
    await makeWarmup(db, b, { side: "down" }, opts(s, t + 16 * MIN));
    await pollWarmup(db, s.feed, { now: at(t + 14 * MIN) }); // the first hasn't ended yet
    expect(s.asked.at(-1)).toEqual([]);
    await pollWarmup(db, s.feed, { now: at(t + 31 * MIN) });
    // Both ended; the window nobody called (10:30) isn't asked about.
    expect(s.asked.at(-1)).toEqual([s.idOf(t + 15 * MIN), s.idOf(t)]);
  });
});

describe("window timing and the 2-minute entry", () => {
  it("calls are taken from a window's first moment until 2 minutes in", async () => {
    const t = fresh();
    const s = scripted();
    const start = t + 15 * MIN;
    const [early, first, last, late] = [await newcomer(t - 60 * MIN), await newcomer(t - 60 * MIN), await newcomer(t - 60 * MIN), await newcomer(t - 60 * MIN)];
    await pollWarmup(db, s.feed, { now: at(start - MIN) });
    const closed = makeWarmup(db, early, { side: "up" }, opts(s, start - 1));
    await expect(closed).rejects.toMatchObject({ code: "WINDOW_CLOSED", message: expect.stringContaining(`opens at ${at(start).toISOString().slice(11, 16)} UTC`) });
    expect(await makeWarmup(db, first, { side: "up" }, opts(s, start))).toMatchObject({ side: "up", startsAt: at(start), endsAt: at(start + 15 * MIN), day: 0, left: 2, newcomers: 1 });
    await pollWarmup(db, s.feed, { now: at(start + MIN) });
    expect(await makeWarmup(db, last, { side: "down" }, opts(s, start + 2 * MIN - 1))).toMatchObject({ side: "down", newcomers: 2 });
    await expect(makeWarmup(db, late, { side: "up" }, opts(s, start + 2 * MIN))).rejects.toMatchObject({ code: "WINDOW_CLOSED", message: expect.stringContaining(`opens at ${at(start + 15 * MIN).toISOString().slice(11, 16)} UTC`) });
    // The card says the same: the window while it takes calls, then the next one's time.
    const open = await warmupState(db, late, opts(s, start + 30_000));
    expect(open.window).toMatchObject({ startsAt: at(start), entryClosesAt: at(start + 2 * MIN), endsAt: at(start + 15 * MIN) });
    const after = await warmupState(db, late, opts(s, start + 2 * MIN));
    expect(after.window).toBeNull();
    expect(after.nextWindowAt).toEqual(at(start + 15 * MIN));
  });

  it("no live feed, or a window it doesn't list or that's stopped trading: refused, and the card offers a City market", async () => {
    const t = fresh();
    const s = scripted();
    const u = await newcomer(t - 60 * MIN);
    // Nothing polled yet, and no feed at all.
    expect(await code(makeWarmup(db, u, { side: "up" }, opts(s, t)))).toBe("FEED_DOWN");
    expect(await code(makeWarmup(db, u, { side: "up" }, { now: at(t) }))).toBe("FEED_DOWN");
    // A good poll, but 4 minutes old.
    await pollWarmup(db, s.feed, { now: at(t - 4 * MIN) });
    expect(await code(makeWarmup(db, u, { side: "up" }, opts(s, t)))).toBe("FEED_DOWN");
    // Polled, but the feed didn't list this window.
    const s2 = scripted();
    s2.listing = false;
    await pollWarmup(db, s2.feed, { now: at(t) });
    expect(await code(makeWarmup(db, u, { side: "up" }, opts(s2, t + 10_000)))).toBe("FEED_DOWN");
    // Listed, then Polymarket stopped taking orders on it.
    const s3 = scripted();
    await pollWarmup(db, s3.feed, { now: at(t) });
    s3.trading = false;
    await pollWarmup(db, s3.feed, { now: at(t + 10_000) });
    expect((await windowRow(s3, t))!.trading).toBe(false);
    expect(await code(makeWarmup(db, u, { side: "up" }, opts(s3, t + 20_000)))).toBe("FEED_DOWN");

    const staffer = await makeResident(db);
    await client`INSERT INTO staff (user_id, role) VALUES (${staffer}, 'moderator')`;
    const m = await createCityMarket(db, staffer, { question: "20+ on the Roof at the warm-up's bell?", kind: "manual", bellDay: at(t).toISOString().slice(0, 10) }, { now: at(t) });
    const card = await warmupState(db, u, opts(s3, t + 20_000));
    expect(card).toMatchObject({ eligible: true, window: null, feed: { live: true } });
    const soonest = (await openCityMarkets(db, { now: at(t + 20_000) })).sort((a, b) => a.locksAt.getTime() - b.locksAt.getTime())[0]!;
    expect(card.fallback).toEqual({ id: soonest.id, question: soonest.question, locksAt: soonest.locksAt });
    expect(card.fallback).not.toBeNull();
    expect(soonest.locksAt.getTime()).toBeLessThanOrEqual(m.locksAt.getTime());
    // With a window to call there's no fallback.
    await pollWarmup(db, s.feed, { now: at(t) });
    expect((await warmupState(db, u, opts(s, t + 30_000))).fallback).toBeNull();
  });

  it("refuses junk sides, unknown residents and bad options", async () => {
    const t = fresh();
    const s = scripted();
    const u = await newcomer(t);
    for (const side of [undefined, "UP", "yes", 1, null]) expect(await code(makeWarmup(db, u, { side }, opts(s, t)))).toBe("INVALID_INPUT");
    expect(await code(makeWarmup(db, randomUUID(), { side: "up" }, opts(s, t)))).toBe("UNKNOWN_USER");
    expect(await code(warmupState(db, randomUUID(), opts(s, t)))).toBe("UNKNOWN_USER");
    expect(await code(warmupState(db, u, { now: new Date("nope") }))).toBe("INVALID_INPUT");
    expect(await code(warmupState(db, u, { source: "" }))).toBe("INVALID_INPUT");
    expect(await code(warmupState(db, "nope"))).toBe("INVALID_INPUT");
  });
});

describe("3 per resident, first 3 days only", () => {
  // Polls just before `t` and calls in the window starting at `t`.
  async function callAt(s: ReturnType<typeof scripted>, u: string, t: number, side: "up" | "down" = "up") {
    await pollWarmup(db, s.feed, { now: at(t) });
    return makeWarmup(db, u, { side }, opts(s, t + 30_000));
  }

  it("one a day for the first 3 days; a second the same day and anything on day 3 are refused", async () => {
    const t = fresh();
    const s = scripted();
    const u = await newcomer(t - 30 * MIN);
    expect(await callAt(s, u, t)).toMatchObject({ day: 0, left: 2 });
    await pollWarmup(db, s.feed, { now: at(t + 15 * MIN) });
    await expect(makeWarmup(db, u, { side: "down" }, opts(s, t + 15 * MIN + 30_000))).rejects.toMatchObject({ code: "ALREADY_TODAY", message: "One warm-up a day. Your next one opens tomorrow." });
    expect(await warmupState(db, u, opts(s, t + 16 * MIN))).toMatchObject({ eligible: false, reason: "used_today", day: 0, left: 2 });
    expect(await callAt(s, u, t + DAY)).toMatchObject({ day: 1, left: 1 });
    expect(await callAt(s, u, t + 2 * DAY)).toMatchObject({ day: 2, left: 0 });
    await pollWarmup(db, s.feed, { now: at(t + 2 * DAY + 15 * MIN) });
    await expect(makeWarmup(db, u, { side: "up" }, opts(s, t + 2 * DAY + 15 * MIN + 30_000))).rejects.toMatchObject({ code: "ALREADY_TODAY", message: "That was your last warm-up." });
    // 72 hours after the first tap: no longer a newcomer.
    await pollWarmup(db, s.feed, { now: at(t + 3 * DAY) });
    expect(await code(makeWarmup(db, u, { side: "up" }, opts(s, t + 3 * DAY)))).toBe("NOT_NEW");
    expect(await warmupState(db, u, opts(s, t + 3 * DAY))).toMatchObject({ eligible: false, reason: "not_new", left: 0 });
    expect((await client`SELECT count(*)::int AS n FROM warmup_calls WHERE user_id = ${u}`)[0]!.n).toBe(WARMUP.max);
  });

  it("a skipped day doesn't come back; an old account never gets one", async () => {
    const t = fresh();
    const s = scripted();
    const u = await newcomer(t - 30 * MIN);
    expect(await callAt(s, u, t + 2 * DAY)).toMatchObject({ day: 2, left: 0 });
    expect(await warmupState(db, u, opts(s, t + 2 * DAY + MIN))).toMatchObject({ eligible: false, left: 0 });
    const old = await newcomer(t - 10 * DAY);
    await pollWarmup(db, s.feed, { now: at(t + 3 * DAY) });
    expect(await code(makeWarmup(db, old, { side: "up" }, opts(s, t + 3 * DAY)))).toBe("NOT_NEW");
  });

  it("a window across the change of day takes one call, not two", async () => {
    const t = fresh();
    const s = scripted();
    // Arrived a minute into a window, so the next day starts a minute into one.
    const u = await newcomer(t - DAY + MIN);
    await pollWarmup(db, s.feed, { now: at(t) });
    expect(await makeWarmup(db, u, { side: "up" }, opts(s, t + 30_000))).toMatchObject({ day: 0 });
    expect(await code(makeWarmup(db, u, { side: "down" }, opts(s, t + 90_000)))).toBe("ALREADY_IN");
    expect((await client`SELECT count(*)::int AS n FROM warmup_calls WHERE user_id = ${u}`)[0]!.n).toBe(1);
  });

  it("guests get warm-ups too: the first 15 minutes come before moving in", async () => {
    const t = fresh();
    const s = scripted();
    const g = await newcomer(t - MIN, { guest: true });
    expect(await callAt(s, g, t, "down")).toMatchObject({ side: "down", day: 0 });
  });

  it("racing calls by one resident make one", async () => {
    const t = fresh();
    const s = scripted();
    const u = await newcomer(t - 30 * MIN);
    await pollWarmup(db, s.feed, { now: at(t) });
    const results = await raceAt(client, "warmup_calls", 4, Array.from({ length: 4 }, (_, i) => () => makeWarmup(db, u, { side: i % 2 ? "up" : "down" }, opts(s, t + 30_000))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r.ok ? null : (r.e as WarmupError).code))).toEqual(["ALREADY_TODAY", "ALREADY_TODAY", "ALREADY_TODAY"]);
    expect((await client`SELECT count(*)::int AS n FROM warmup_calls WHERE user_id = ${u}`)[0]!.n).toBe(1);
  });

  it("the database refuses a fourth, a call outside the 2 minutes or on the wrong day, and any edit or delete", async () => {
    const t = fresh();
    const s = scripted();
    const u = await newcomer(t - 30 * MIN);
    const c = await callAt(s, u, t);
    const w = (await windowRow(s, t))!.id;
    const insert = (day: number, createdAt: number, window = w) => client`INSERT INTO warmup_calls (user_id, window_id, side, account_day, created_at) VALUES (${u}, ${window}, 'up', ${day}, ${at(createdAt)})`;
    // A fourth, on day 3, in the first minute of a real window.
    await pollWarmup(db, s.feed, { now: at(t + 3 * DAY) });
    expect(await refused(insert(3, t + 3 * DAY + MIN, (await windowRow(s, t + 3 * DAY))!.id))).toBe("23514");
    expect(await refused(insert(1, t + 3 * MIN))).toBe("23000"); // not the day it was taken on
    expect(await refused(insert(1, t + DAY + 3 * MIN))).toBe("23000"); // outside the window's first 2 minutes
    expect(await refused(client`INSERT INTO warmup_calls (user_id, window_id, side, account_day, created_at, stamp, settled_at) VALUES (${u}, ${w}, 'up', 0, ${at(t + MIN)}, 'called_it', ${at(t + MIN)})`)).toBe("23000");
    expect(await refused(client`UPDATE warmup_calls SET side = 'down' WHERE id = ${c.id}`)).toBe("23000");
    expect(await refused(client`UPDATE warmup_calls SET stamp = 'called_it', settled_at = now() WHERE id = ${c.id}`)).toBe("23000"); // the window hasn't resolved
    expect(await refused(client`DELETE FROM warmup_calls WHERE id = ${c.id}`)).toBe("23000");
    expect(await refused(client`DELETE FROM warmup_windows WHERE id = ${w}`)).toBe("23000");
    expect(await refused(client`UPDATE warmup_windows SET starts_at = starts_at + interval '15 minutes', ends_at = ends_at + interval '15 minutes' WHERE id = ${w}`)).toBe("23000");
    await client`UPDATE warmup_windows SET status = 'resolved', outcome = 'down', resolved_at = now() WHERE id = ${w}`;
    expect(await refused(client`UPDATE warmup_windows SET outcome = 'up' WHERE id = ${w}`)).toBe("23000");
    // A stamp must be the window's result: DOWN happened, so an UP call is REKT.
    expect(await refused(client`UPDATE warmup_calls SET stamp = 'called_it', settled_at = now() WHERE id = ${c.id}`)).toBe("23000");
    expect(await refused(client`UPDATE warmup_calls SET stamp = 'rekt', settled_at = now() WHERE id = ${c.id}`)).toBe("OK");
    expect(await refused(client`UPDATE warmup_calls SET stamp = 'void' WHERE id = ${c.id}`)).toBe("23000");
  });
});

describe("settling and voids", () => {
  // Three newcomers call the window starting at `t`: two UP, one DOWN.
  async function threeIn(s: ReturnType<typeof scripted>, t: number) {
    const [a, b, c] = [await newcomer(t - 30 * MIN), await newcomer(t - 30 * MIN), await newcomer(t - 30 * MIN)];
    await setPrefs(db, a, { alerts: ["warmup_settled"] });
    await setPrefs(db, c, { alerts: ["warmup_settled"] });
    await pollWarmup(db, s.feed, { now: at(t) });
    const calls = [await makeWarmup(db, a, { side: "up" }, opts(s, t + MIN)), await makeWarmup(db, b, { side: "up" }, opts(s, t + MIN)), await makeWarmup(db, c, { side: "down" }, opts(s, t + MIN))];
    return { a, b, c, calls };
  }
  const pushes = async (u: string) => (await client`SELECT kind FROM notifications WHERE user_id = ${u}`).map((r) => r.kind);
  const moods = async (u: string, t: number) => (await moodState(db, u, { now: at(t) })).active.map((m) => m.mood);

  it("UP happened: UP callers CALLED IT, DOWN callers REKT with a free Copium, within 5 to 20 minutes, and the reel counts them", async () => {
    const t = fresh();
    const s = scripted();
    const { a, b, c, calls } = await threeIn(s, t);
    // Ended, but the result isn't in: nothing settles.
    expect(await pollWarmup(db, s.feed, { now: at(t + 15 * MIN) })).toMatchObject({ resolved: 0, settled: 0 });
    expect((await warmupState(db, a, opts(s, t + 15 * MIN))).mine[0]).toMatchObject({ stamp: null, newcomers: 3, reel: null });
    s.result(t, "up");
    expect(await pollWarmup(db, s.feed, { now: at(t + 16 * MIN) })).toMatchObject({ resolved: 1, voided: 0, settled: 3 });
    expect(await windowRow(s, t)).toMatchObject({ status: "resolved", outcome: "up" });
    const [ca, cb, cc] = await Promise.all(calls.map((x) => callOf(x.id)));
    expect([ca!.stamp, cb!.stamp, cc!.stamp]).toEqual(["called_it", "called_it", "rekt"]);
    for (const x of [ca!, cb!, cc!]) {
      const took = x.settled_at.getTime() - x.created_at.getTime();
      expect(took).toBeGreaterThanOrEqual(5 * MIN);
      expect(took).toBeLessThanOrEqual(20 * MIN);
    }
    expect(await moods(a, t + 17 * MIN)).toContain("called_it");
    expect(await moods(c, t + 17 * MIN)).toContain("rekt");
    expect((await moodState(db, c, { now: at(t + 17 * MIN) })).copium.free).toBe(1);
    expect((await moodState(db, a, { now: at(t + 17 * MIN) })).copium.free).toBe(0);
    // The opt-in push, only for those who switched it on.
    expect(await pushes(a)).toEqual(["warmup_settled"]);
    expect(await pushes(b)).toEqual([]);
    expect(await pushes(c)).toEqual(["warmup_settled"]);
    const card = await warmupState(db, c, opts(s, t + 17 * MIN));
    expect(card.mine[0]).toMatchObject({ side: "down", stamp: "rekt", newcomers: 3 });
    expect(card.mine[0]!.reel).toEqual({ result: "up", voided: false, newcomers: 3, up: 2, down: 1, calledIt: 2, bot: { name: "NOTHING-9000", label: "NPC · AI", side: "down", stamp: "rekt" } });
    // Settled is settled: another poll changes nothing.
    expect(await pollWarmup(db, s.feed, { now: at(t + 18 * MIN) })).toMatchObject({ resolved: 0, settled: 0 });
    expect((await moodState(db, c, { now: at(t + 18 * MIN) })).copium.free).toBe(1);
  });

  it("a 50/50 void stamps VOID: no mood, no Copium, still the push", async () => {
    const t = fresh();
    const s = scripted();
    const { a, c, calls } = await threeIn(s, t);
    s.result(t, "void");
    expect(await pollWarmup(db, s.feed, { now: at(t + 16 * MIN) })).toMatchObject({ resolved: 0, voided: 1, settled: 3 });
    expect((await Promise.all(calls.map((x) => callOf(x.id)))).map((x) => x.stamp)).toEqual(["void", "void", "void"]);
    expect(await moods(a, t + 17 * MIN)).not.toContain("called_it");
    expect(await moods(c, t + 17 * MIN)).not.toContain("rekt");
    expect((await moodState(db, c, { now: at(t + 17 * MIN) })).copium.free).toBe(0);
    expect(await pushes(c)).toEqual(["warmup_settled"]);
    expect((await warmupState(db, a, opts(s, t + 17 * MIN))).mine[0]!.reel).toMatchObject({ result: null, voided: true, calledIt: 0, bot: { stamp: "void" } });
  });

  it("a result still proposed waits, and settles once it's final", async () => {
    const t = fresh();
    const s = scripted();
    const { calls } = await threeIn(s, t);
    s.result(t, "waiting");
    expect(await pollWarmup(db, s.feed, { now: at(t + 16 * MIN) })).toMatchObject({ resolved: 0, voided: 0, settled: 0 });
    expect(await windowRow(s, t)).toMatchObject({ status: "open", outcome: null });
    s.result(t, "down");
    expect(await pollWarmup(db, s.feed, { now: at(t + 19 * MIN) })).toMatchObject({ resolved: 1, settled: 3 });
    expect((await Promise.all(calls.map((x) => callOf(x.id)))).map((x) => x.stamp)).toEqual(["rekt", "rekt", "called_it"]);
  });

  it("a result for a window that hasn't ended yet is ignored", async () => {
    const t = fresh();
    const s = scripted();
    const { calls } = await threeIn(s, t);
    s.early = [{ externalId: s.idOf(t), outcome: "up", voided: false }];
    expect(await pollWarmup(db, s.feed, { now: at(t + 10 * MIN) })).toMatchObject({ resolved: 0, settled: 0 });
    expect(await windowRow(s, t)).toMatchObject({ status: "open" });
    expect((await callOf(calls[0]!.id)).stamp).toBeNull();
    // Once it has ended, the same answer counts.
    expect(await pollWarmup(db, s.feed, { now: at(t + 15 * MIN) })).toMatchObject({ resolved: 1, settled: 3 });
  });

  it("racing settlers stamp each call once: one mood, one Copium, one push", async () => {
    const t = fresh();
    const s = scripted();
    const u = await newcomer(t - 30 * MIN);
    await setPrefs(db, u, { alerts: ["warmup_settled"] });
    await pollWarmup(db, s.feed, { now: at(t) });
    const c = await makeWarmup(db, u, { side: "up" }, opts(s, t + MIN));
    // Resolved without the poll's own settling, so two settlers can race for it.
    await client`UPDATE warmup_windows SET status = 'resolved', outcome = 'down', resolved_at = ${at(t + 16 * MIN)} WHERE source = ${s.source} AND starts_at = ${at(t)}`;
    const results = await raceAt(client, "warmup_calls", 2, [() => settleWarmups(db, { now: at(t + 16 * MIN) }), () => settleWarmups(db, { now: at(t + 16 * MIN) })]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => (r.ok ? r.v.settled : -1)).sort()).toEqual([0, 1]);
    expect((await callOf(c.id)).stamp).toBe("rekt");
    expect((await moodState(db, u, { now: at(t + 17 * MIN) })).copium.free).toBe(1);
    expect(await pushes(u)).toEqual(["warmup_settled"]);
  });
});

describe("a warm-up never touches the ledger or Aura", () => {
  const snapshot = async (u: string) => {
    const [l] = await client`SELECT (SELECT count(*)::int FROM gm_entries) AS entries, (SELECT count(*)::int FROM gm_transactions) AS txs, (SELECT COALESCE(SUM(balance), 0)::text FROM gm_accounts) AS supply`;
    const [a] = await client`SELECT count(*)::int AS calls, COALESCE(SUM(aura_centi), 0)::int AS aura FROM calls WHERE user_id = ${u}`;
    const streak = (await client`SELECT * FROM streaks WHERE user_id = ${u}`).map((r) => ({ ...r }));
    return { ...l, ...a, streak, balance: await getBalance(db, userAccountId(u)), rightList: (await rightList(db, { userId: u })).me };
  };

  it("made, settled REKT, its free Copium used: not one GM or Aura point moves", async () => {
    const t = fresh();
    const s = scripted();
    const u = await newcomer(t - 30 * MIN);
    const before = await snapshot(u);
    expect(before.balance).toBeGreaterThan(0); // the move-in gift, so a stray burn would show
    await pollWarmup(db, s.feed, { now: at(t) });
    await makeWarmup(db, u, { side: "up" }, opts(s, t + MIN));
    s.result(t, "down");
    expect(await pollWarmup(db, s.feed, { now: at(t + 16 * MIN) })).toMatchObject({ settled: 1 });
    expect((await moodState(db, u, { now: at(t + 17 * MIN) })).copium.free).toBe(1);
    expect(await useCopium(db, u, randomUUID(), { now: at(t + 17 * MIN) })).toMatchObject({ paid: false, price: 0, cleared: ["rekt"] });
    // A CALLED IT on day 1 as well.
    await pollWarmup(db, s.feed, { now: at(t + DAY) });
    await makeWarmup(db, u, { side: "down" }, opts(s, t + DAY + MIN));
    s.result(t + DAY, "down");
    expect(await pollWarmup(db, s.feed, { now: at(t + DAY + 16 * MIN) })).toMatchObject({ settled: 1 });
    expect(await snapshot(u)).toEqual(before);
  });
});
