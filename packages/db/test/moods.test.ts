import { randomUUID } from "node:crypto";
import { userAccountId } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MoodError,
  createDb,
  endCozy,
  ensureSystemAccounts,
  getBalance,
  grantMood,
  maybeTilt,
  moodState,
  reconcile,
  setHideCandleColor,
  touchActivity,
  useCopium,
} from "../src";
import { makeResident, releaseTogether } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const T0 = new Date("2026-10-20T08:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * MIN);
const state = (u: string, min: number) => moodState(db, u, { now: at(min) });
const moodsOf = async (u: string, min: number) => (await state(u, min)).active.map((a) => a.mood).sort();

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof MoodError) return e.code;
    if ((e as { code?: string }).code) return (e as { code: string }).code;
    throw e;
  }
}

// Traits change mood timings, so tests that time moods pin them.
const plainTraits = (u: string) => client`UPDATE residents SET traits = '{ape,builder,lurker}' WHERE user_id = ${u}`;

// Play continuously from `from` to `to` minutes, one touch a minute.
async function play(u: string, from: number, to: number) {
  for (let m = from; m <= to; m++) await touchActivity(db, u, { now: at(m) });
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(async () => {
  expect(await reconcile(db)).toEqual([]);
  await close();
});

describe("the play clock", () => {
  it("splits sessions on an hour away and throttles writes to once a minute", async () => {
    const u = await makeResident(db);
    await touchActivity(db, u, { now: at(0) });
    await touchActivity(db, u, { now: new Date(at(0).getTime() + 30_000) }); // within the minute: no write
    await touchActivity(db, u, { now: at(59) });
    await touchActivity(db, u, { now: at(118) }); // 59 min after the last touch: same session
    await touchActivity(db, u, { now: at(178) }); // 60 min after: new session
    const rows = await client`SELECT started_at, last_seen_at FROM play_sessions WHERE user_id = ${u} ORDER BY started_at`;
    expect(rows.map((r) => [(+new Date(r.started_at) - +T0) / MIN, (+new Date(r.last_seen_at) - +T0) / MIN])).toEqual([
      [0, 118],
      [178, 178],
    ]);
  });

  it("a late, out-of-order touch never rewinds the clock", async () => {
    const u = await makeResident(db);
    await touchActivity(db, u, { now: at(10) });
    await touchActivity(db, u, { now: at(5) });
    const [r] = await client`SELECT last_seen_at FROM play_sessions WHERE user_id = ${u}`;
    expect(+new Date(r!.last_seen_at)).toBe(+at(10));
  });

  it("writes at most once a minute", async () => {
    const u = await makeResident(db);
    await touchActivity(db, u, { now: at(0) });
    await touchActivity(db, u, { now: new Date(at(0).getTime() + 59_000) });
    const [r] = await client`SELECT last_seen_at FROM play_sessions WHERE user_id = ${u}`;
    expect(+new Date(r!.last_seen_at)).toBe(+at(0)); // the second touch never reached the database
  });

  it("two racing requests, the later one landing first: the clock never goes back", async () => {
    const u = await makeResident(db);
    await touchActivity(db, u, { now: at(0) });
    // Both pass the throttle (each is 5+ minutes after at(0)), then queue on
    // the lock. at(10) is provably queued before at(5) starts, so it goes first.
    const barrier = await client.reserve();
    await barrier`BEGIN`;
    await barrier`SELECT 1 FROM users WHERE id = ${u} FOR UPDATE`;
    const waiters = async (n: number) => {
      for (let i = 0; i < 300; i++) {
        const [w] = await client`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (w!.n >= n) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("never queued");
    };
    const later = touchActivity(db, u, { now: at(10) });
    await waiters(1);
    const earlier = touchActivity(db, u, { now: at(5) });
    await waiters(2);
    await barrier`COMMIT`;
    barrier.release();
    await Promise.all([later, earlier]);
    const [r] = await client`SELECT last_seen_at FROM play_sessions WHERE user_id = ${u}`;
    expect(+new Date(r!.last_seen_at)).toBe(+at(10));
  });

  it("10 racing first touches make one session", async () => {
    const u = await makeResident(db);
    await releaseTogether(client, "SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [u], 10, Array.from({ length: 10 }, () => () => touchActivity(db, u, { now: at(0) })));
    const [n] = await client`SELECT count(*)::int AS n FROM play_sessions WHERE user_id = ${u}`;
    expect(n!.n).toBe(1);
  });

  it("Chart-brain after 90 minutes of play; an hour away clears it", async () => {
    const u = await makeResident(db);
    await play(u, 0, 89);
    expect(await moodsOf(u, 89)).not.toContain("chart_brain");
    await play(u, 90, 95);
    const s = await state(u, 95);
    expect(s.active.map((a) => a.mood)).toContain("chart_brain");
    expect(s.chartBrain).toEqual({ hideCrowdBars: true, realityCheck: true });
    await play(u, 156, 157); // came back 61 minutes later
    expect(await moodsOf(u, 157)).not.toContain("chart_brain");
  });

  it("a nap never clears Chart-brain", async () => {
    const u = await makeResident(db);
    await play(u, 0, 100);
    await grantMood(db, u, "rested", { now: at(100) }); // napped in their own bed
    expect(await moodsOf(u, 101)).toEqual(["chart_brain", "rested"]);
  });

  it("Rested after 6+ hours away, for about 90 minutes", async () => {
    const u = await makeResident(db);
    await play(u, 0, 5);
    await play(u, 5 + 6 * 60, 5 + 6 * 60 + 2);
    expect(await moodsOf(u, 5 + 6 * 60 + 2)).toContain("rested");
    expect(await moodsOf(u, 5 + 6 * 60 + 2)).not.toContain("chart_brain");
  });
});

describe("REKT, Copium and Cozy", () => {
  it("REKT lasts until the bell and comes with a free Copium", async () => {
    const u = await makeResident(db);
    await grantMood(db, u, "rekt", { now: at(0) });
    const s = await state(u, 1);
    expect(s.active.map((a) => a.mood)).toEqual(["rekt"]);
    expect(s.copium.free).toBe(1);
    expect(await moodsOf(u, 16 * 60)).toEqual([]); // 2026-10-21T00:00 bell passed
  });

  it("the free Copium clears it at no cost; the next one costs 30 GM, burned", async () => {
    const u = await makeResident(db);
    await grantMood(db, u, "rekt", { now: at(0) });
    expect(await useCopium(db, u, randomUUID(), { now: at(1) })).toMatchObject({ paid: false, cleared: ["rekt"] });
    expect(await getBalance(db, userAccountId(u))).toBe(1000);
    await maybeTilt(db, u, { lostSnap: true }, { now: at(2) });
    expect(await useCopium(db, u, randomUUID(), { now: at(3) })).toMatchObject({ paid: true, cleared: ["tilted"] });
    expect(await getBalance(db, userAccountId(u))).toBe(970);
    expect(await moodsOf(u, 4)).toEqual([]);
  });

  it("Copium is never spent when there's nothing to clear", async () => {
    const u = await makeResident(db);
    expect(await code(useCopium(db, u, randomUUID(), { now: at(0) }))).toBe("NOTHING_TO_CLEAR");
    expect(await getBalance(db, userAccountId(u))).toBe(1000);
  });

  it("a retried Copium doesn't charge or clear twice", async () => {
    const u = await makeResident(db);
    await maybeTilt(db, u, { rektSquares: 5 }, { now: at(0) });
    const k = randomUUID();
    const a = await useCopium(db, u, k, { now: at(1) });
    const b = await useCopium(db, u, k, { now: at(2) });
    expect(b).toEqual({ ...a, replayed: true });
    expect(await getBalance(db, userAccountId(u))).toBe(970);
    // Someone else's key can't be used to read their result.
    const other = await makeResident(db);
    expect(await code(useCopium(db, other, k, { now: at(3) }))).toBe("NOTHING_TO_CLEAR");
  });

  it("5 racing Copiums on one REKT: one clears it, the rest find nothing", async () => {
    const u = await makeResident(db);
    await grantMood(db, u, "rekt", { now: at(0) });
    const res = await releaseTogether(client, "SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [u], 5, Array.from({ length: 5 }, () => () => code(useCopium(db, u, randomUUID(), { now: at(1) }))));
    expect(res.map((r) => (r.ok ? r.v : "THREW")).sort()).toEqual(["NOTHING_TO_CLEAR", "NOTHING_TO_CLEAR", "NOTHING_TO_CLEAR", "NOTHING_TO_CLEAR", "OK"]);
    expect(await getBalance(db, userAccountId(u))).toBe(1000); // the free one was used
  });

  it("an hour of Cozy clears REKT; 59 minutes doesn't", async () => {
    const u = await makeResident(db);
    await plainTraits(u); // random traits once drew Copium Regular here and halved the timer
    await grantMood(db, u, "rekt", { now: at(0) });
    await grantMood(db, u, "cozy", { now: at(10) });
    expect(await moodsOf(u, 69)).toEqual(["cozy", "rekt"]);
    expect(await moodsOf(u, 70)).toEqual(["cozy"]);
    const [row] = await client`SELECT cleared_by, cleared_at FROM moods WHERE user_id = ${u} AND mood = 'rekt'`;
    expect(row!.cleared_by).toBe("cozy");
    expect(+new Date(row!.cleared_at)).toBe(+at(70));
  });

  it("a Copium Regular's REKT clears in 30 minutes of Cozy; their Tilted still takes the full hour", async () => {
    const u = await makeResident(db);
    await client`UPDATE residents SET traits = '{ape,builder,copium_regular}' WHERE user_id = ${u}`;
    await grantMood(db, u, "rekt", { now: at(0) });
    await maybeTilt(db, u, { rektSquares: 4 }, { now: at(0) });
    await grantMood(db, u, "cozy", { now: at(0) });
    expect(await moodsOf(u, 30)).toEqual(["cozy", "tilted"]);
    expect(await moodsOf(u, 60)).toEqual(["cozy"]);
  });

  it("Cozy lasts an hour after the crew splits up, and only overlap counts", async () => {
    const u = await makeResident(db);
    await plainTraits(u);
    await grantMood(db, u, "cozy", { now: at(0) });
    await endCozy(db, u, { now: at(20) });
    expect(await moodsOf(u, 79)).toEqual(["cozy"]);
    expect(await moodsOf(u, 80)).toEqual([]);
    await grantMood(db, u, "rekt", { now: at(100) });
    expect(await moodsOf(u, 200)).toEqual(["rekt"]); // the earlier Cozy never overlapped it
  });
});

describe("Tilted", () => {
  it("caps stakes, blocks Snaps and share prompts, and pauses real trades until the bell", async () => {
    const u = await makeResident(db);
    expect(await maybeTilt(db, u, { rektSquares: 3 }, { now: at(0) })).toBe(false);
    expect(await maybeTilt(db, u, { gmLostToday: 300, gmAtStartOfDay: 1000 }, { now: at(0) })).toBe(true);
    // Keyed once (as the bell's grid tilt is): a re-run tilts nobody new, and says so.
    expect(await maybeTilt(db, u, { rektSquares: 4 }, { now: at(0), once: `test:${u}` })).toBe(true);
    expect(await maybeTilt(db, u, { rektSquares: 4 }, { now: at(0), once: `test:${u}` })).toBe(false);
    const s = await state(u, 1);
    expect(s.tilt).toEqual({
      tilted: true,
      gmStakeCap: 10,
      snapsAllowed: false,
      sharePromptsAllowed: false,
      realTradesPausedUntil: new Date("2026-10-21T00:00:00.000Z"),
    });
  });

  it("Copium lifts the mood and its GM limits, but the trade pause still waits for the bell", async () => {
    const u = await makeResident(db);
    await maybeTilt(db, u, { lostSnap: true }, { now: at(0) });
    await useCopium(db, u, randomUUID(), { now: at(5) });
    const s = await state(u, 6);
    expect(s.tilt).toMatchObject({ tilted: false, gmStakeCap: null, snapsAllowed: true, realTradesPausedUntil: new Date("2026-10-21T00:00:00.000Z") });
    expect((await state(u, 16 * 60 + 1)).tilt.realTradesPausedUntil).toBeNull(); // after the bell
  });

  it("a second trigger the same day keeps the first start (the pause can't be dodged) and never stacks rows", async () => {
    const u = await makeResident(db);
    await maybeTilt(db, u, { lostSnap: true }, { now: at(0) });
    await maybeTilt(db, u, { lostSnap: true }, { now: at(30) });
    const rows = await client`SELECT started_at FROM moods WHERE user_id = ${u} AND mood = 'tilted'`;
    expect(rows).toHaveLength(1);
    expect(+new Date(rows[0]!.started_at)).toBe(+at(0));
  });

  it("tilting again after the bell starts a fresh tilt (expired rows are closed, not blocking)", async () => {
    const u = await makeResident(db);
    await maybeTilt(db, u, { lostSnap: true }, { now: at(0) });
    await maybeTilt(db, u, { lostSnap: true }, { now: at(17 * 60) }); // next day
    const rows = await client`SELECT cleared_by FROM moods WHERE user_id = ${u} AND mood = 'tilted' ORDER BY started_at`;
    expect(rows.map((r) => r.cleared_by)).toEqual(["expired", null]);
    expect((await state(u, 17 * 60 + 1)).tilt.realTradesPausedUntil).toEqual(new Date("2026-10-22T00:00:00.000Z"));
  });
});

describe("the candle", () => {
  it("shows the newest mood and the colour, unless hidden; the mood always shows", async () => {
    const u = await makeResident(db);
    await grantMood(db, u, "rekt", { now: at(0) });
    await grantMood(db, u, "cozy", { now: at(5) });
    expect((await state(u, 6)).candle).toEqual({ mood: "cozy", color: "doji", hideColor: false });
    await setHideCandleColor(db, u, true);
    expect((await state(u, 6)).candle).toEqual({ mood: "cozy", color: null, hideColor: true });
    expect(await code(setHideCandleColor(db, u, "yes"))).toBe("INVALID_INPUT");
  });
});

describe("database guards", () => {
  it("one open row per mood; no negative Copium credits; ends after it starts", async () => {
    const u = await makeResident(db);
    await grantMood(db, u, "cozy", { now: at(0) });
    await expect(client`INSERT INTO moods (user_id, mood, started_at) VALUES (${u}, 'cozy', ${at(1).toISOString()})`).rejects.toThrow(/moods_one_open/);
    await expect(client`INSERT INTO copium_credits (user_id, free) VALUES (${u}, -1)`).rejects.toThrow(/copium_credits_free/);
    await expect(client`INSERT INTO moods (user_id, mood, started_at, ends_at) VALUES (${u}, 'rekt', ${at(5).toISOString()}, ${at(1).toISOString()})`).rejects.toThrow(/moods_ends_after_start/);
  });
});
