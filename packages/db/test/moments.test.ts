import { randomUUID } from "node:crypto";
import { type FeedMarket, MOMENTS, type OddsProvider, type TowerMoment, parseMoment, swingBucket } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, ensureSystemAccounts, pickTowerMoments, pollOdds } from "../src";
import { raceAt } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
// Days of their own, far from every other file's markets: picking looks at
// every sports market in the database, whatever its feed.
let base = Date.UTC(2060, 0, 1 + Math.floor(Math.random() * 3000), 9);
const fresh = () => (base += 3 * D);

// A feed whose prices and results the test sets by hand. Every poll stores a
// tick per open market it carries, as the real feed's polls do.
function feed() {
  const ms = new Map<string, FeedMarket>();
  const provider: OddsProvider = {
    source: "moments-test",
    async fetch() {
      return [...ms.values()].map((m) => ({ ...m }));
    },
  };
  const add = (t: number, over: Partial<FeedMarket> = {}) => {
    const m: FeedMarket = { externalId: randomUUID(), question: `Will side ${ms.size + 1} win tonight?`, category: "sports", ladder: null, freezesAt: new Date(t + 10 * H), settlesBy: new Date(t + 12 * H), price: 50, resolved: null, voided: false, ...over };
    ms.set(m.externalId, m);
    return m;
  };
  const poll = async (t: number, prices: Array<[FeedMarket, number]> = []) => {
    for (const [m, p] of prices) m.price = p;
    expect(await pollOdds(db, provider, { now: new Date(t) })).toMatchObject({ ok: true, skipped: false });
  };
  return { add, poll };
}
const idOf = async (m: FeedMarket) => (await client`SELECT id FROM markets WHERE source = 'moments-test' AND external_id = ${m.externalId}`)[0]!.id as string;
const pick = (t: number) => pickTowerMoments(db, { now: new Date(t) });
const rows = async (m: FeedMarket) => client`SELECT kind, bucket, from_price, to_price, outcome FROM tower_moments WHERE market_id = ${await idOf(m)} ORDER BY at`;
const moves = (ms: TowerMoment[]) => ms.map((m) => [m.marketId, m.from, m.to]);

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("results", () => {
  it("a sports result is a moment once, ever, with where the price last stood; voids, other categories and old news aren't", async () => {
    const t = fresh();
    const f = feed();
    const [win, lose, voided, crypto, old] = [f.add(t, { price: 34 }), f.add(t, { price: 71 }), f.add(t), f.add(t, { category: "crypto" }), f.add(t)];
    await f.poll(t);
    old.resolved = true;
    await f.poll(t + MIN);
    // 16 minutes on, `old` is old news.
    Object.assign(win, { resolved: true });
    Object.assign(lose, { resolved: false });
    Object.assign(voided, { voided: true });
    Object.assign(crypto, { resolved: true });
    await f.poll(t + 17 * MIN);
    const got = await pick(t + 17 * MIN);
    const expected: TowerMoment[] = [
      { id: expect.any(String) as unknown as string, kind: "settled", marketId: await idOf(win), question: win.question, outcome: "yes", from: 34, at: t + 17 * MIN },
      { id: expect.any(String) as unknown as string, kind: "settled", marketId: await idOf(lose), question: lose.question, outcome: "no", from: 71, at: t + 17 * MIN },
    ];
    expect([...got].sort((a, b) => a.marketId.localeCompare(b.marketId))).toEqual(expected.sort((a, b) => a.marketId.localeCompare(b.marketId)));
    // Every one is a payload the rooms accept, as it is.
    for (const m of got) expect(parseMoment(m)).toEqual(m);
    expect(await rows(win)).toEqual([{ kind: "settled", bucket: 0, from_price: 34, to_price: null, outcome: true }]);
    // Never again, however many polls see it.
    expect(await pick(t + 18 * MIN)).toEqual([]);
    expect(await pick(t + 30 * MIN)).toEqual([]);
    for (const m of [voided, crypto, old]) expect(await rows(m)).toEqual([]);
  });
});

describe("swings", () => {
  it("15 points within 30 minutes of ticks is a swing; not 14, not a move spread wider, not another category, not once it's closed", async () => {
    const t = fresh();
    const f = feed();
    const big = f.add(t, { price: 41 });
    const small = f.add(t, { price: 50 });
    const slow = f.add(t, { price: 40 });
    const crypto = f.add(t, { category: "crypto", price: 20 });
    const kickoff = f.add(t, { price: 30, freezesAt: new Date(t + 25 * MIN) });
    await f.poll(t);
    await f.poll(t + 10 * MIN, [[slow, 47]]);
    await f.poll(t + 20 * MIN, [[big, 52], [slow, 50], [crypto, 50], [kickoff, 50]]);
    // 31 minutes in: the window starts at t + 1 minute, after slow's 40.
    await f.poll(t + 31 * MIN, [[big, 63], [small, 64], [slow, 55]]);
    const got = await pick(t + 31 * MIN);
    expect(got).toEqual([{ id: expect.any(String), kind: "swing", marketId: await idOf(big), question: big.question, from: 41, to: 63, at: t + 31 * MIN }]);
    expect(parseMoment(got[0])).toEqual(got[0]);
    expect(await rows(big)).toEqual([{ kind: "swing", bucket: swingBucket(t + 31 * MIN), from_price: 41, to_price: 63, outcome: null }]);
    for (const m of [small, slow, crypto, kickoff]) expect(await rows(m)).toEqual([]);
  });

  it("one swing per market an hour, across the hour's edge too; after that it can swing again", async () => {
    const t = Math.ceil(fresh() / H) * H - 2 * MIN; // two minutes to the hour
    const f = feed();
    const m = f.add(t, { price: 30 });
    await f.poll(t - 5 * MIN);
    await f.poll(t, [[m, 50]]);
    expect(moves(await pick(t))).toEqual([[await idOf(m), 30, 50]]);
    // Next poll: still the same swing in the window. Nothing new.
    await f.poll(t + MIN);
    expect(await pick(t + MIN)).toEqual([]);
    // Into the next hour it swings back down: a new hour's bucket, but not an hour since the last.
    await f.poll(t + 4 * MIN, [[m, 30]]);
    expect(swingBucket(t + 4 * MIN)).toBe(swingBucket(t) + 1);
    expect(await pick(t + 4 * MIN)).toEqual([]);
    await f.poll(t + 40 * MIN);
    await f.poll(t + 59 * MIN, [[m, 50]]);
    expect(await pick(t + 59 * MIN)).toEqual([]);
    // Over an hour since the last one: a moment again.
    await f.poll(t + 61 * MIN, [[m, 31]]);
    expect(moves(await pick(t + 61 * MIN))).toEqual([[await idOf(m), 50, 31]]);
    expect((await rows(m)).map((r) => [r.from_price, r.to_price])).toEqual([[30, 50], [50, 31]]);
  });
});

describe("the cap and racing", () => {
  // Two results and four swings of different sizes, all in one poll.
  async function busyPoll() {
    const t = fresh();
    const f = feed();
    const results = [f.add(t, { price: 40 }), f.add(t, { price: 60 })];
    const swings = [f.add(t, { price: 20 }), f.add(t, { price: 30 }), f.add(t, { price: 40 }), f.add(t, { price: 50 })];
    await f.poll(t);
    for (const r of results) r.resolved = true;
    await f.poll(t + 5 * MIN, swings.map((s, i): [FeedMarket, number] => [s, s.price + 15 + i * 5])); // 15, 20, 25, 30 points
    return { t: t + 5 * MIN, results: await Promise.all(results.map(idOf)), swings: await Promise.all(swings.map(idOf)), f };
  }

  it("at most 3 a poll: results first, then the biggest swings; the rest come with the next poll", async () => {
    const { t, results, swings, f } = await busyPoll();
    const first = await pick(t);
    expect(first).toHaveLength(MOMENTS.perPoll);
    expect(first.slice(0, 2).map((m) => m.marketId).sort()).toEqual([...results].sort());
    expect(moves(first.slice(2))).toEqual([[swings[3], 50, 80]]); // the biggest
    // The same poll again (an overlapping cron) adds nothing: its 3 are taken.
    expect(await pick(t)).toEqual([]);
    // The next poll: the other three, biggest first.
    await f.poll(t + MIN);
    expect(moves(await pick(t + MIN))).toEqual([
      [swings[2], 40, 65],
      [swings[1], 30, 50],
      [swings[0], 20, 35],
    ]);
    await f.poll(t + 2 * MIN);
    expect(await pick(t + 2 * MIN)).toEqual([]);
  });

  it("racing pickers for one poll announce each moment once, and 3 between them", async () => {
    const { t, results, swings } = await busyPoll();
    const outs = await raceAt(client, "tower_moments", 4, [0, 1, 2, 3].map(() => () => pick(t)));
    for (const o of outs) expect(o.ok).toBe(true);
    const picked = outs.flatMap((o) => (o.ok ? o.v : []));
    expect(picked).toHaveLength(MOMENTS.perPoll);
    expect(new Set(picked.map((m) => m.marketId)).size).toBe(MOMENTS.perPoll);
    expect(picked.map((m) => m.marketId).sort()).toEqual([...results, swings[3]!].sort());
    const [{ n }] = await client`SELECT count(*)::int AS n FROM tower_moments WHERE at = ${new Date(t).toISOString()}`;
    expect(n).toBe(MOMENTS.perPoll);
  });

  it("refuses a date that isn't one, without throwing synchronously", async () => {
    const bad = pickTowerMoments(db, { now: new Date("nope") });
    expect(bad).toBeInstanceOf(Promise);
    await expect(bad).rejects.toThrow(TypeError);
    await expect(pickTowerMoments(db, { now: "2060-01-01" as unknown as Date })).rejects.toThrow(TypeError);
  });
});

describe("database guards (bypassing app code)", () => {
  it("a second result for a market, a second swing in one hour, and a moment of the wrong shape are refused", async () => {
    const t = fresh();
    const f = feed();
    const m = f.add(t);
    await f.poll(t);
    const id = await idOf(m);
    const at = new Date(t).toISOString();
    await client`INSERT INTO tower_moments (market_id, kind, bucket, from_price, outcome, at) VALUES (${id}, 'settled', 0, 50, true, ${at})`;
    await expect(client`INSERT INTO tower_moments (market_id, kind, bucket, from_price, outcome, at) VALUES (${id}, 'settled', 0, 50, false, ${at})`).rejects.toMatchObject({ code: "23505" });
    await client`INSERT INTO tower_moments (market_id, kind, bucket, from_price, to_price, at) VALUES (${id}, 'swing', 7, 30, 50, ${at})`;
    await expect(client`INSERT INTO tower_moments (market_id, kind, bucket, from_price, to_price, at) VALUES (${id}, 'swing', 7, 50, 70, ${at})`).rejects.toMatchObject({ code: "23505" });
    for (const [kind, bucket, from, to, outcome] of [
      ["settled", 1, 50, null, true], // a result's bucket is 0: once ever
      ["settled", 0, 50, 60, true],
      ["settled", 0, 50, null, null],
      ["swing", 8, 30, null, null],
      ["swing", 8, 30, 50, true],
      ["swing", 8, 0, 50, null],
      ["swing", 8, 30, 100, null],
      ["goal", 8, 30, 50, null],
    ] as const) {
      await expect(client`INSERT INTO tower_moments (market_id, kind, bucket, from_price, to_price, outcome, at) VALUES (${id}, ${kind}, ${bucket}, ${from}, ${to}, ${outcome}, ${at})`, `${kind} ${bucket} ${from} ${to} ${outcome}`).rejects.toMatchObject({ code: "23514" });
    }
  });
});
