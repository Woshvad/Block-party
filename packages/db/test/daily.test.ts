import { randomUUID } from "node:crypto";
import { GM, LedgerError, addDays, userAccountId } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DailyError,
  burn,
  buyHodlDay,
  createDb,
  ensureSystemAccounts,
  getBalance,
  gmNetWorth,
  grantMoveIn,
  mint,
  openUserAccount,
  reconcile,
  recordStreakDay,
  sayGm,
  schema,
  today,
} from "../src";
import { raceAt } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const race = <T,>(table: string, n: number, racers: Array<() => Promise<T>>) => raceAt(client, table, n, racers);

// Real "now" plus whole days, so ledger timestamps (set by Postgres) and the
// city clock stay on the same timeline.
const DAY = 86_400_000;
const at = (days: number, hour = 12) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};

async function resident(opts: { moveIn?: boolean; gm?: number } = {}) {
  const [u] = await db.insert(schema.users).values({ ageAckAt: new Date() }).returning();
  const acct = await openUserAccount(db, u!.id);
  if (opts.moveIn) await db.transaction((tx) => grantMoveIn(tx, u!.id));
  if (opts.gm) await mint(db, { accountId: acct, amount: opts.gm, kind: "test_seed", idempotencyKey: randomUUID() });
  return { id: u!.id, acct };
}

const n = async (q: string, ...p: unknown[]) => (await client.unsafe(q, p as never[]))[0]!.n as number;
async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof DailyError || e instanceof LedgerError) return e.code;
    throw e;
  }
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(async () => {
  expect(await reconcile(db)).toEqual([]);
  await close();
});

describe("gm and the drip", () => {
  it("pays 50 once per city day", async () => {
    const r = await resident({ gm: 500 });
    const first = await sayGm(db, r.id, { now: at(0, 1) });
    expect(first).toMatchObject({ already: false, drip: 50, brokeFloor: false, balance: 550 });
    const again = await sayGm(db, r.id, { now: at(0, 23) });
    expect(again).toMatchObject({ already: true, drip: 50, balance: 550 });
    const tomorrow = await sayGm(db, r.id, { now: at(1, 0) });
    expect(tomorrow).toMatchObject({ already: false, balance: 600 });
  });

  it("the city day turns at 00:00 UTC, not at midnight local time", async () => {
    const r = await resident({ gm: 500 });
    const d = at(5, 0);
    await sayGm(db, r.id, { now: new Date(d.getTime() - 1) }); // 23:59:59.999 the day before
    const res = await sayGm(db, r.id, { now: d }); // 00:00 UTC
    expect(res.already).toBe(false);
  });

  it("broke floor: 100 GM under 100 net worth, exactly at the line pays 50", async () => {
    const broke = await resident({ gm: 99 });
    expect((await sayGm(db, broke.id)).drip).toBe(100);
    const line = await resident({ gm: 100 });
    expect((await sayGm(db, line.id)).drip).toBe(50);
    const zero = await resident();
    expect(await sayGm(db, zero.id)).toMatchObject({ drip: 100, brokeFloor: true, balance: 100 });
  });

  it("furniture bought in the last 7 days still counts, so a sofa never doubles the drip", async () => {
    const r = await resident({ gm: 1000 });
    await burn(db, { accountId: r.acct, amount: 950, kind: "furniture", idempotencyKey: randomUUID() });
    expect(await gmNetWorth(db, r.id)).toBe(1000);
    expect((await sayGm(db, r.id, { now: at(0) })).drip).toBe(50);
    expect(await gmNetWorth(db, r.id, at(6))).toBe(1050);
    // a week later the sofa no longer counts: net worth is the 100 balance... plus today's drips
    expect((await sayGm(db, r.id, { now: at(8) })).drip).toBe(50); // balance is 100 now: at the line
  });

  it("after the lookback, a resident spent down below 100 hits the broke floor", async () => {
    const r = await resident({ gm: 500 });
    await burn(db, { accountId: r.acct, amount: 480, kind: "decor", idempotencyKey: randomUUID() });
    expect((await sayGm(db, r.id, { now: at(3) })).drip).toBe(50); // 20 + 480 still counts
    expect((await sayGm(db, r.id, { now: at(9) })).drip).toBe(100); // 70 balance, decor aged out
  });

  it("rides and other burns never count toward net worth", async () => {
    const r = await resident({ gm: 150 });
    await burn(db, { accountId: r.acct, amount: 100, kind: "ride", idempotencyKey: randomUUID() });
    expect(await gmNetWorth(db, r.id)).toBe(50);
    expect((await sayGm(db, r.id)).drip).toBe(100);
  });

  it("unknown residents are refused", async () => {
    expect(await code(sayGm(db, randomUUID()))).toBe("UNKNOWN_USER");
  });

  it("a payout landing as they tap gm counts once: net worth is read under the wallet's lock", async () => {
    const r = await resident({ gm: 60 });
    const waiters = async (k: number) => {
      const deadline = Date.now() + 10_000;
      // loop-bound: polls until k sessions wait on a lock, or the deadline
      while ((await n(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)) < k) {
        if (Date.now() > deadline) throw new Error(`only some of ${k} waiters arrived`);
        await new Promise((res) => setTimeout(res, 10));
      }
    };
    // Something holds the wallet; a bell payout of 500 queues on it, then the gm tap.
    const barrier = await client.reserve();
    await barrier`BEGIN`;
    await barrier`SELECT 1 FROM gm_accounts WHERE id = ${r.acct} FOR NO KEY UPDATE`;
    let payout: Promise<unknown>;
    let gm: ReturnType<typeof sayGm>;
    try {
      payout = mint(db, { accountId: r.acct, amount: 500, kind: "test_payout", idempotencyKey: randomUUID() });
      await waiters(1);
      gm = sayGm(db, r.id);
      await waiters(2);
    } finally {
      await barrier`COMMIT`;
      barrier.release();
    }
    await payout!;
    // 560 by the time it's read: the plain drip, not the broke floor's 100.
    expect(await gm!).toMatchObject({ drip: 50, brokeFloor: false, balance: 610 });
  });

  it("20 racing gm taps pay one drip, and every tap succeeds", async () => {
    const r = await resident({ gm: 500 });
    const settled = await race("daily_gm", 20, Array.from({ length: 20 }, () => () => sayGm(db, r.id)));
    expect(settled.filter((s) => !s.ok)).toEqual([]);
    const results = settled.map((s) => (s as { v: Awaited<ReturnType<typeof sayGm>> }).v);
    expect(results.filter((x) => !x.already)).toHaveLength(1);
    expect(await getBalance(db, r.acct)).toBe(550);
  });

  it("the database refuses a second gm for the same day", async () => {
    const r = await resident({ gm: 500 });
    await sayGm(db, r.id);
    await expect(client`INSERT INTO daily_gm (user_id, city_day, drip, broke_floor, net_worth, tx_id)
      SELECT user_id, city_day, drip, broke_floor, net_worth, tx_id FROM daily_gm WHERE user_id = ${r.id}`).rejects.toThrow(/daily_gm_user_id_city_day_pk/);
  });
});

describe("streak", () => {
  it("pays the bonus on each played day, capped at +25", async () => {
    const r = await resident();
    const bonuses = [];
    for (let d = 0; d < 7; d++) bonuses.push((await recordStreakDay(db, r.id, { now: at(d) })).bonus);
    expect(bonuses).toEqual([5, 10, 15, 20, 25, 25, 25]);
    expect(await getBalance(db, r.acct)).toBe(125);
  });

  it("a second call the same day changes nothing and pays nothing", async () => {
    const r = await resident();
    await recordStreakDay(db, r.id, { now: at(0, 1) });
    const again = await recordStreakDay(db, r.id, { now: at(0, 22) });
    expect(again).toMatchObject({ changed: false, bonus: 0 });
    expect(await getBalance(db, r.acct)).toBe(5);
  });

  it("a Hodl Day covers a gap and the calendar shows it", async () => {
    const r = await resident({ moveIn: true });
    await recordStreakDay(db, r.id, { now: at(0) });
    await recordStreakDay(db, r.id, { now: at(1) });
    const res = await recordStreakDay(db, r.id, { now: at(3) });
    expect(res.state).toMatchObject({ current: 3, hodlDays: 0 });
    const cal = await client`SELECT city_day::text AS d, kind FROM streak_days WHERE user_id = ${r.id} ORDER BY city_day`;
    expect(cal.map((c) => c.kind)).toEqual(["played", "played", "hodl", "played"]);
  });

  it("not enough Hodl Days: quiet restart, none spent", async () => {
    const r = await resident({ moveIn: true });
    await recordStreakDay(db, r.id, { now: at(0) });
    const res = await recordStreakDay(db, r.id, { now: at(4) });
    expect(res).toMatchObject({ broken: true, bonus: 5 });
    expect(res.state).toMatchObject({ current: 1, longest: 1, hodlDays: 1 });
  });

  it("a 7-day streak grants a free Hodl Day and the 7-day card", async () => {
    const r = await resident({ moveIn: true });
    for (let d = 0; d < 7; d++) await recordStreakDay(db, r.id, { now: at(d) });
    const t = await today(db, r.id, { now: at(6) });
    expect(t).toMatchObject({ streak: 7, hodlDays: 2, playedToday: true });
    expect(await n(`SELECT count(*)::int AS n FROM badges WHERE user_id=$1 AND badge='streak_7'`, r.id)).toBe(1);
  });

  it("refuses to record a day before the last played day", async () => {
    const r = await resident();
    await recordStreakDay(db, r.id, { now: at(2) });
    await expect(recordStreakDay(db, r.id, { now: at(1) })).rejects.toThrow(RangeError);
    expect(await getBalance(db, r.acct)).toBe(5);
  });

  it("10 racing first calls of the day pay one bonus", async () => {
    const r = await resident();
    const settled = await race("streak_days", 10, Array.from({ length: 10 }, () => () => recordStreakDay(db, r.id)));
    expect(settled.filter((s) => !s.ok)).toEqual([]);
    expect(await getBalance(db, r.acct)).toBe(5);
    expect(await n(`SELECT count(*)::int AS n FROM streak_days WHERE user_id=$1`, r.id)).toBe(1);
  });
});

describe("Hodl Days", () => {
  it("costs 150 GM, burned, and stops at 2 held", async () => {
    const r = await resident({ moveIn: true }); // 1000 GM, 1 Hodl Day
    expect(await buyHodlDay(db, r.id, randomUUID())).toEqual({ replayed: false, hodlDays: 2 });
    expect(await getBalance(db, r.acct)).toBe(850);
    expect(await code(buyHodlDay(db, r.id, randomUUID()))).toBe("HODL_FULL");
    expect(await getBalance(db, r.acct)).toBe(850);
  });

  it("a retried purchase charges once, even after the cap is reached", async () => {
    const r = await resident({ moveIn: true });
    const k = randomUUID();
    await buyHodlDay(db, r.id, k);
    expect(await buyHodlDay(db, r.id, k)).toEqual({ replayed: true, hodlDays: 2 });
    expect(await getBalance(db, r.acct)).toBe(850);
  });

  it("a retried purchase below the cap charges once and grants once", async () => {
    const r = await resident({ gm: 1000 }); // 0 Hodl Days held
    const k = randomUUID();
    expect(await buyHodlDay(db, r.id, k)).toEqual({ replayed: false, hodlDays: 1 });
    expect(await buyHodlDay(db, r.id, k)).toEqual({ replayed: true, hodlDays: 1 });
    expect((await today(db, r.id)).hodlDays).toBe(1);
    expect(await getBalance(db, r.acct)).toBe(850);
  });

  it("move-in run twice pays once and grants one Hodl Day", async () => {
    const r = await resident({ moveIn: true });
    await db.transaction((tx) => grantMoveIn(tx, r.id));
    expect(await getBalance(db, r.acct)).toBe(1000);
    expect((await today(db, r.id)).hodlDays).toBe(1);
  });

  it("can't be bought without the GM, and nothing changes", async () => {
    const r = await resident({ gm: 149 });
    expect(await code(buyHodlDay(db, r.id, randomUUID()))).toBe("INSUFFICIENT_FUNDS");
    expect(await getBalance(db, r.acct)).toBe(149);
    expect((await today(db, r.id)).hodlDays).toBe(0);
  });

  it("5 racing purchases from 0 held: exactly 2 go through", async () => {
    const r = await resident({ gm: 1000 });
    await recordStreakDay(db, r.id); // creates the streak row so the barrier has something to lock on
    const settled = await race("gm_transactions", 1, Array.from({ length: 5 }, () => () => code(buyHodlDay(db, r.id, randomUUID()))));
    const outcomes = settled.map((s) => (s.ok ? s.v : "THREW"));
    expect(outcomes.filter((o) => o === "OK")).toHaveLength(2);
    expect(outcomes.filter((o) => o === "HODL_FULL")).toHaveLength(3);
    expect(await getBalance(db, r.acct)).toBe(1000 + 5 - 300);
  });

  it("the database refuses a third Hodl Day", async () => {
    const r = await resident({ moveIn: true });
    await expect(client`UPDATE streaks SET hodl_days = 3 WHERE user_id = ${r.id}`).rejects.toThrow(/streaks_hodl_range/);
  });
});

describe("the plan's weekly math, end to end", () => {
  it("casual (4 days a week): +200 drip, +50 streak bonus", async () => {
    const r = await resident({ gm: 800 });
    const before = await getBalance(db, r.acct);
    for (let d = 0; d < 4; d++) {
      await sayGm(db, r.id, { now: at(d) });
      await recordStreakDay(db, r.id, { now: at(d) });
    }
    expect((await getBalance(db, r.acct)) - before).toBe(200 + 50);
  });

  it("active (7 days, settled streak): +350 drip, +175 streak bonus", async () => {
    const r = await resident({ gm: 2000 });
    for (let d = 0; d < 7; d++) await recordStreakDay(db, r.id, { now: at(d) }); // build the streak first
    const before = await getBalance(db, r.acct);
    for (let d = 7; d < 14; d++) {
      await sayGm(db, r.id, { now: at(d) });
      await recordStreakDay(db, r.id, { now: at(d) });
    }
    expect((await getBalance(db, r.acct)) - before).toBe(350 + 175);
  });
});

describe("Today sheet", () => {
  it("shows gm, streak, Hodl Days and the next bell", async () => {
    const r = await resident({ moveIn: true });
    const t0 = await today(db, r.id, { now: at(0, 10) });
    expect(t0).toMatchObject({ saidGm: false, streak: 0, alive: false, hodlDays: 1 });
    expect(t0.bellAt.toISOString()).toBe(`${addDays(t0.cityDay, 1)}T00:00:00.000Z`);

    await sayGm(db, r.id, { now: at(0, 10) });
    await recordStreakDay(db, r.id, { now: at(0, 10) });
    expect(await today(db, r.id, { now: at(0, 11) })).toMatchObject({ saidGm: true, streak: 1, playedToday: true });
    // skip a day: still alive thanks to the Hodl Day, which would be spent today
    expect(await today(db, r.id, { now: at(2) })).toMatchObject({ saidGm: false, streak: 1, alive: true, hodlNeeded: 1 });
    // skip two: gone
    expect(await today(db, r.id, { now: at(3) })).toMatchObject({ streak: 0, alive: false });
  });

  it("matches the economy constants the plan sets", () => {
    expect(GM).toMatchObject({ moveInGift: 1000, drip: 50, brokeFloorDrip: 100, hodlDayPrice: 150, streakBonusCap: 25 });
  });
});
