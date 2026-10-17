import { randomUUID } from "node:crypto";
import type { FeedMarket, OddsProvider, TowerMoment } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type CronResult, runMinute } from "../src/cron";
import type { RoomsClient } from "../src/rooms-client";
import { client, close, db, fakeRooms, ready } from "./harness";

beforeAll(ready);
afterAll(close);

const MIN = 60_000;
// Days of their own (picking looks at every sports market in the database),
// at a minute past nine: no sweeps, no daily pings, no Ratio prompt.
let base = Date.UTC(2061, 0, 1 + Math.floor(Math.random() * 3000), 9, 1);
const fresh = () => (base += 3 * 24 * 60 * MIN);

// A feed whose prices and results the test sets by hand.
function feed() {
  const ms = new Map<string, FeedMarket>();
  const provider: OddsProvider = {
    source: "api-moments-test",
    async fetch() {
      return [...ms.values()].map((m) => ({ ...m }));
    },
  };
  const add = (t: number, over: Partial<FeedMarket> = {}) => {
    const m: FeedMarket = { externalId: randomUUID(), question: `Will side ${ms.size + 1} win tonight?`, category: "sports", ladder: null, freezesAt: new Date(t + 10 * 60 * MIN), settlesBy: new Date(t + 12 * 60 * MIN), price: 50, resolved: null, voided: false, ...over };
    ms.set(m.externalId, m);
    return m;
  };
  return { provider, add };
}
const idOf = async (m: FeedMarket) => (await client`SELECT id FROM markets WHERE source = 'api-moments-test' AND external_id = ${m.externalId}`)[0]!.id as string;
const job = (results: CronResult[], name: string) => results.find((r) => r.job === name);
// A rooms Worker that records the moments it takes (or refuses them all).
function rooms(refuse?: Error) {
  const sent: Array<{ place: string; moment: TowerMoment }> = [];
  const client: RoomsClient = {
    ...fakeRooms,
    moment: async (place, moment) => {
      if (refuse) throw refuse;
      sent.push({ place, moment });
    },
  };
  return { client, sent };
}

describe("the minute cron's big moments", () => {
  it("after a poll, the Watch Party gets its moments, the most important last", async () => {
    const t = fresh();
    const f = feed();
    const swing = f.add(t, { price: 41 });
    const result = f.add(t, { price: 70 });
    const r = rooms();
    expect(job(await runMinute(db, new Date(t), { odds: f.provider, rooms: r.client }), "odds")).toMatchObject({ status: "fulfilled", value: { ok: true } });
    expect(r.sent).toEqual([]);
    swing.price = 63;
    result.resolved = true;
    const results = await runMinute(db, new Date(t + 10 * MIN), { odds: f.provider, rooms: r.client });
    expect(job(results, "odds")).toMatchObject({ status: "fulfilled", value: { ok: true, skipped: false } });
    const [swingId, resultId] = [await idOf(swing), await idOf(result)];
    // The result outranks the swing, so it goes last: it's the one the rooms keep.
    expect(r.sent.map((s) => [s.place, s.moment.marketId, s.moment.kind])).toEqual([
      ["watch_party", swingId, "swing"],
      ["watch_party", resultId, "settled"],
    ]);
    expect(r.sent[0]!.moment).toMatchObject({ from: 41, to: 63, at: t + 10 * MIN });
    expect(r.sent[1]!.moment).toMatchObject({ outcome: "yes", from: 70 });
    // The next poll has nothing new to say.
    await runMinute(db, new Date(t + 11 * MIN), { odds: f.provider, rooms: r.client });
    expect(r.sent).toHaveLength(2);
  });

  it("rooms that refuse a moment are logged, the odds job is still fine, and the moment isn't sent again", async () => {
    const t = fresh();
    const f = feed();
    const m = f.add(t);
    await runMinute(db, new Date(t), { odds: f.provider });
    m.resolved = false;
    const down = rooms(new Error("rooms /internal/moment failed: 503"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const results = await runMinute(db, new Date(t + MIN), { odds: f.provider, rooms: down.client });
      expect(job(results, "odds")).toMatchObject({ status: "fulfilled", value: { ok: true, skipped: false } });
      const logged = warn.mock.calls.filter(([msg]) => String(msg).startsWith("moments: the rooms didn't take moment"));
      expect(logged).toHaveLength(1);
      expect(logged[0]![1]).toMatchObject({ marketId: await idOf(m), place: "watch_party", error: "rooms /internal/moment failed: 503" });
    } finally {
      warn.mockRestore();
    }
    // Best effort: it was recorded as announced, so a working Worker later doesn't get it.
    const up = rooms();
    await runMinute(db, new Date(t + 2 * MIN), { odds: f.provider, rooms: up.client });
    expect(up.sent).toEqual([]);
    expect(await client`SELECT kind FROM tower_moments WHERE market_id = ${await idOf(m)}`).toEqual([{ kind: "settled" }]);
  });

  it("without the rooms, or after a poll that failed, nothing is picked: a result still reaches the rooms next time", async () => {
    const t = fresh();
    const f = feed();
    const m = f.add(t, { price: 30 });
    await runMinute(db, new Date(t), { odds: f.provider });
    m.resolved = true;
    expect(job(await runMinute(db, new Date(t + MIN), { odds: f.provider }), "odds")).toMatchObject({ status: "fulfilled", value: { ok: true } });
    expect(await client`SELECT 1 FROM tower_moments WHERE market_id = ${await idOf(m)}`).toHaveLength(0);
    // The feed goes down for a poll: the rooms are there, but there's no poll to follow.
    const r = rooms();
    const down: OddsProvider = { source: f.provider.source, fetch: async () => Promise.reject(new Error("feed down")) };
    expect(job(await runMinute(db, new Date(t + 2 * MIN), { odds: down, rooms: r.client }), "odds")).toMatchObject({ status: "fulfilled", value: { ok: false } });
    expect(r.sent).toEqual([]);
    await runMinute(db, new Date(t + 3 * MIN), { odds: f.provider, rooms: r.client });
    expect(r.sent.map((s) => [s.moment.marketId, s.moment.outcome])).toEqual([[await idOf(m), "yes"]]);
  });
});
