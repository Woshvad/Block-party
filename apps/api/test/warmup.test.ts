import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { type WarmupFeed, type WarmupResult, nextWindowAt, windowStart } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CronResult, runMinute } from "../src/cron";
import { SECRET, call, client, close, db, makeApp, ready, resident } from "./harness";

beforeAll(ready);
afterAll(close);

const MIN = 60_000;
// Each test has a feed (and so windows) of its own. Its clock starts on a
// quarter hour some hours back, never ahead: sessions are checked against
// it, and a clock days ahead would find every one expired. The cron runs a
// minute past, clear of the sweeps and the daily pings.
let base = Math.floor((Date.now() - 6 * 60 * MIN) / (15 * MIN)) * 15 * MIN;
const fresh = () => (base -= 12 * 60 * MIN);

// A feed the test drives: this window and the next, and the results it's given.
function feed() {
  const source = `api-warmup-${randomUUID().slice(0, 8)}`;
  const results = new Map<string, WarmupResult>();
  const idOf = (start: number) => `${source}:${start}`;
  const window = (start: Date) => ({ externalId: idOf(start.getTime()), question: "Bitcoin Up or Down?", startsAt: start, endsAt: new Date(start.getTime() + 15 * MIN), open: true });
  const provider: WarmupFeed = {
    source,
    async fetch(now, pending = []) {
      return { windows: [window(windowStart(now)), window(nextWindowAt(now))], results: pending.flatMap((id) => (results.has(id) ? [results.get(id)!] : [])) };
    },
  };
  return { provider, source, settle: (start: number, outcome: "up" | "down") => results.set(idOf(start), { externalId: idOf(start), outcome, voided: false }) };
}

// An app on the test's own clock and feed.
function world(over: { features?: Record<string, boolean>; warmup?: WarmupFeed | null } = {}) {
  const f = feed();
  const clock = { now: new Date(0) };
  const app = makeApp({ now: () => clock.now, features: over.features ?? { duels: true, towerLights: true, warmup: true }, ...(over.warmup === null ? {} : { warmup: over.warmup ?? f.provider }) });
  const poll = () => call("POST", "/internal/warmup/poll", { via: app, headers: { "x-internal-secret": SECRET } });
  return { f, clock, app, poll };
}
const arrived = (userId: string, at: number) => client`UPDATE users SET created_at = ${new Date(at).toISOString()}::timestamptz WHERE id = ${userId}`;
const job = (results: CronResult[], name: string) => results.find((r) => r.job === name);

describe("the warm-up switched off (FEATURE_WARMUP, off by default)", () => {
  it("nothing is reachable: every route refuses, and the cron never polls", async () => {
    const t = fresh();
    const off = world({ features: { duels: true, towerLights: true } });
    off.clock.now = new Date(t + 30_000);
    const me = await resident();
    await arrived(me.userId, t - 30 * MIN);
    expect((await call("GET", "/v1/warmup", { via: off.app })).status).toBe(401); // a session first, as everywhere
    for (const r of [await call("GET", "/v1/warmup", { token: me.token, via: off.app }), await call("POST", "/v1/warmup/calls", { token: me.token, via: off.app, body: { side: "up" } }), await off.poll()]) {
      expect([r.status, r.body.error.code]).toEqual([503, "WARMUP_NOT_YET"]);
    }
    expect((await client`SELECT count(*)::int AS n FROM warmup_polls WHERE source = ${off.f.source}`)[0]!.n).toBe(0);
    expect((await client`SELECT count(*)::int AS n FROM warmup_calls WHERE user_id = ${me.userId}`)[0]!.n).toBe(0);
    // The cron polls only when it's handed the feed, and it's handed it only with the switch on.
    expect(job(await runMinute(db, new Date(t + MIN), {}), "warmup")).toBeUndefined();
    expect((await client`SELECT count(*)::int AS n FROM warmup_polls WHERE source = ${off.f.source}`)[0]!.n).toBe(0);
    expect(job(await runMinute(db, new Date(t + MIN), { warmup: off.f.provider }), "warmup")).toMatchObject({ status: "fulfilled", value: { ok: true, windows: 2 } });
  });

  it("both entrypoints hand the feed and the switch over only when FEATURE_WARMUP is \"on\"", () => {
    const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    const node = readFileSync(new URL("../src/node.ts", import.meta.url), "utf8");
    expect(worker).toContain('const warmupFor = (env: Env) => (env.FEATURE_WARMUP === "on" ? warmupFeedFor(env.ODDS_SOURCE) : undefined);');
    expect(worker).toContain('warmup: env.FEATURE_WARMUP === "on" }');
    expect(node).toContain('const WARMUP_FEED = process.env.FEATURE_WARMUP === "on" ? warmupFeedFor(process.env.ODDS_SOURCE) : undefined;');
    expect(node).toContain('warmup: process.env.FEATURE_WARMUP === "on" }');
    // Off by default: the deployed config doesn't set it.
    expect(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")).not.toMatch(/"FEATURE_WARMUP"\s*:\s*"on"/);
  });
});

describe("the warm-up over HTTP", () => {
  it("a newcomer calls UP in the first 2 minutes; the window settles into the reel, a mood and the push; GM never moves", async () => {
    const t = fresh();
    const w = world();
    const me = await resident();
    await arrived(me.userId, t - 30 * MIN);
    await call("PATCH", "/v1/notifications/prefs", { token: me.token, body: { alerts: ["warmup_settled"] } });
    const gm = (await call("GET", "/v1/me", { token: me.token })).body.gm;

    w.clock.now = new Date(t);
    expect((await w.poll()).body).toMatchObject({ ok: true, windows: 2 });
    w.clock.now = new Date(t + 30_000);
    const card = await call("GET", "/v1/warmup", { token: me.token, via: w.app });
    expect(card.status).toBe(200);
    expect(card.body).toMatchObject({ eligible: true, reason: null, day: 0, left: 3, feed: { live: true, credit: "Sample window · Not real" }, fallback: null, mine: [] });
    expect(card.body.window).toMatchObject({ startsAt: new Date(t).toISOString(), entryClosesAt: new Date(t + 2 * MIN).toISOString(), endsAt: new Date(t + 15 * MIN).toISOString() });
    // A free call, never a real one.
    expect(JSON.stringify(card.body)).not.toMatch(/back it for real|wallet|usdc|deposit/i);

    expect((await call("POST", "/v1/warmup/calls", { token: me.token, via: w.app, body: { side: "sideways" } })).status).toBe(400);
    const made = await call("POST", "/v1/warmup/calls", { token: me.token, via: w.app, body: { side: "up" } });
    expect([made.status, made.body]).toMatchObject([201, { side: "up", day: 0, left: 2, newcomers: 1 }]);
    const again = await call("POST", "/v1/warmup/calls", { token: me.token, via: w.app, body: { side: "down" } });
    expect([again.status, again.body.error.code]).toEqual([409, "ALREADY_TODAY"]);
    expect((await call("GET", "/v1/warmup", { token: me.token, via: w.app })).body.mine).toEqual([expect.objectContaining({ side: "up", stamp: null, newcomers: 1, reel: null })]);

    w.clock.now = new Date(t + 16 * MIN);
    w.f.settle(t, "up");
    expect((await w.poll()).body).toMatchObject({ ok: true, resolved: 1, settled: 1 });
    const after = await call("GET", "/v1/warmup", { token: me.token, via: w.app });
    expect(after.body).toMatchObject({ eligible: false, reason: "used_today", left: 2 });
    expect(after.body.mine[0]).toMatchObject({ side: "up", stamp: "called_it", reel: { result: "up", newcomers: 1, calledIt: 1, bot: { name: "NOTHING-9000", side: "down", stamp: "rekt" } } });
    expect((await call("GET", "/v1/moods", { token: me.token, via: w.app })).body.active.map((m: { mood: string }) => m.mood)).toContain("called_it");
    expect((await client`SELECT kind FROM notifications WHERE user_id = ${me.userId}`).map((r) => r.kind)).toEqual(["warmup_settled"]);
    expect((await call("GET", "/v1/me", { token: me.token })).body.gm).toBe(gm);
  });

  it("refusals say why: the window closed, the feed is down, not a newcomer; guests can play", async () => {
    const t = fresh();
    const w = world();
    const me = await resident();
    await arrived(me.userId, t - 30 * MIN);
    w.clock.now = new Date(t + MIN);
    await w.poll();
    w.clock.now = new Date(t + 2 * MIN);
    const closed = await call("POST", "/v1/warmup/calls", { token: me.token, via: w.app, body: { side: "up" } });
    expect([closed.status, closed.body.error]).toMatchObject([409, { code: "WINDOW_CLOSED", message: `Calls close 2 minutes into a window. The next one opens at ${new Date(t + 15 * MIN).toISOString().slice(11, 16)} UTC.` }]);
    expect((await call("GET", "/v1/warmup", { token: me.token, via: w.app })).body).toMatchObject({ window: null, nextWindowAt: new Date(t + 15 * MIN).toISOString() });
    // No feed configured (no ODDS_SOURCE): never a window, only the fallback.
    const bare = world({ warmup: null });
    bare.clock.now = new Date(t + 15 * MIN + 30_000);
    const down = await call("POST", "/v1/warmup/calls", { token: me.token, via: bare.app, body: { side: "up" } });
    expect([down.status, down.body.error.code]).toEqual([503, "FEED_DOWN"]);
    expect((await call("GET", "/v1/warmup", { token: me.token, via: bare.app })).body).toMatchObject({ eligible: true, window: null, feed: { live: false, credit: null } });
    expect((await bare.poll()).body.error.code).toBe("WARMUP_FEED_DISABLED");
    // Old hands don't get one.
    const old = await resident();
    await arrived(old.userId, t - 5 * 24 * 60 * MIN);
    w.clock.now = new Date(t + 15 * MIN);
    await w.poll();
    const notNew = await call("POST", "/v1/warmup/calls", { token: old.token, via: w.app, body: { side: "up" } });
    expect([notNew.status, notNew.body.error.code]).toEqual([403, "NOT_NEW"]);
    // A guest, before moving in.
    const guest = await call("POST", "/v1/auth/guest", { body: { ageAck: true } });
    await arrived(guest.body.userId, t);
    const g = await call("POST", "/v1/warmup/calls", { token: guest.body.sessionToken, via: w.app, body: { side: "down" } });
    expect([g.status, g.body]).toMatchObject([201, { side: "down", day: 0 }]);
  });
});
