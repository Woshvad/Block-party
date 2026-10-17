import { randomUUID } from "node:crypto";
import { MAKE_GOOD, type ModerationProvider, cityDay, signTelegramInitData, userAccountId } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAKE_GOOD_UNDER_REVIEW,
  MakeGoodError,
  burn,
  collectMakeGood,
  createDb,
  createGuest,
  createMakeGood,
  economyReport,
  ensureSystemAccounts,
  getBalance,
  myMakeGoods,
  openReports,
  reconcile,
  reviewModerationItem,
  runModerationBatch,
  sayGm,
  signInWithTelegram,
  staffMakeGoods,
  supplyStats,
} from "../src";
import { makeResident, raceAt } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const DAY = 86_400_000;
const HOUR = 3_600_000;
const race = <T,>(table: string, n: number, racers: Array<() => Promise<T>>) => raceAt(client, table, n, racers);
const bal = (u: string) => getBalance(db, userAccountId(u));
const key = () => randomUUID();
const clock = async () => new Date(((await client`SELECT clock_timestamp() AS t`) as unknown as [{ t: string }])[0].t);

// Make-goods are city-wide and never two within 7 days of each other, so each
// test sends its own in a month of its own, long after everyone here moved in.
const BASE = Date.now() + 60 * DAY;
const slot = (k: number) => new Date(BASE + k * 30 * DAY);

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof MakeGoodError) return e.code;
    if ((e as { code?: string }).code) return (e as { code: string }).code;
    throw e;
  }
}

async function staffer() {
  const u = await makeResident(db);
  await client`INSERT INTO staff (user_id, role) VALUES (${u}, 'moderator')`;
  return u;
}

const SORRY = "The city's sorry about the outage.";

beforeAll(() => ensureSystemAccounts(db));
afterAll(async () => {
  expect(await reconcile(db)).toEqual([]);
  await close();
});

describe("staff send a make-good", () => {
  it("staff only, refused the way every other staff tool refuses", async () => {
    const [mod, someone] = [await staffer(), await makeResident(db)];
    const theirs = await openReports(db, someone).catch((e: { code: string; message: string }) => e);
    const mine = await createMakeGood(db, someone, { reason: SORRY, amount: 100 }, { now: slot(0) }).catch((e: MakeGoodError) => e);
    expect(mine).toBeInstanceOf(MakeGoodError);
    expect([(mine as MakeGoodError).code, (mine as MakeGoodError).message]).toEqual([(theirs as { code: string }).code, (theirs as { message: string }).message]);
    expect(await code(staffMakeGoods(db, someone))).toBe("NOT_STAFF");
    expect(await code(staffMakeGoods(db, mod))).toBe("OK");
  });

  it("a whole number of GM up to 200, and a short reason through the chat filter; nothing is made otherwise", async () => {
    const mod = await staffer();
    const before = (await client`SELECT count(*)::int AS n FROM make_goods`)[0]!.n;
    const send = (input: { reason?: unknown; amount?: unknown }, blockedWords?: string[]) => code(createMakeGood(db, mod, input, { now: slot(0), ...(blockedWords ? { blockedWords } : {}) }));
    for (const amount of [0, -5, 201, 1.5, "100", null, undefined, NaN]) expect(await send({ reason: SORRY, amount }), String(amount)).toBe("INVALID_INPUT");
    for (const reason of [undefined, 42, "", "   ", "oops", "x".repeat(MAKE_GOOD.reasonMaxChars + 1), "\u200b\u200b\u200b\u200b\u200b\u200b"]) expect(await send({ reason, amount: 100 })).toBe("INVALID_INPUT");
    expect(await send({ reason: `key: ${"ab".repeat(32)}`, amount: 100 })).toBe("MODERATED"); // a private key
    expect(await send({ reason: "Sorry! Connect your wallet to claim", amount: 100 })).toBe("MODERATED");
    expect(await send({ reason: "Sorry about the b4dw0rd outage", amount: 100 }, ["badword"])).toBe("MODERATED");
    expect((await client`SELECT count(*)::int AS n FROM make_goods`)[0]!.n).toBe(before);
  });

  it("records who made it and when, cleans the reason, and queues it for the AI check", async () => {
    const mod = await staffer();
    const m = await createMakeGood(db, mod, { reason: "  The city's\u200b sorry\n about the outage.  ", amount: 120 }, { now: slot(1) });
    expect(m).toMatchObject({ reason: SORRY, amount: 120, createdBy: mod, createdAt: slot(1), closesAt: new Date(slot(1).getTime() + 14 * DAY), collected: 0, paid: 0 });
    const [row] = await client`SELECT created_by, created_at FROM make_goods WHERE id = ${m.id}`;
    expect([row!.created_by, new Date(row!.created_at).getTime()]).toEqual([mod, slot(1).getTime()]);
    expect([...(await client`SELECT kind, author_id, text, status FROM moderation_items WHERE ref = ${m.id}`)]).toEqual([{ kind: "make_good", author_id: mod, text: SORRY, status: "pending" }]);
  });

  it("never two within 7 days of each other, whichever is written first", async () => {
    const mod = await staffer();
    expect(await code(createMakeGood(db, mod, { reason: SORRY, amount: 50 }, { now: slot(2) }))).toBe("OK");
    expect(await code(createMakeGood(db, mod, { reason: SORRY, amount: 50 }, { now: new Date(slot(2).getTime() + 7 * DAY - 1) }))).toBe("TOO_SOON");
    expect(await code(createMakeGood(db, mod, { reason: SORRY, amount: 50 }, { now: new Date(slot(2).getTime() - 7 * DAY + 1) }))).toBe("TOO_SOON");
    expect(await code(createMakeGood(db, mod, { reason: SORRY, amount: 50 }, { now: new Date(slot(2).getTime() + 7 * DAY) }))).toBe("OK");
  });

  it("two staff sending one at once make one (the lock)", async () => {
    const [a, b] = [await staffer(), await staffer()];
    const settled = await race("make_goods", 2, [a, b].map((s) => () => createMakeGood(db, s, { reason: SORRY, amount: 75 }, { now: slot(3) })));
    expect(settled.filter((r) => r.ok)).toHaveLength(1);
    const lost = settled.find((r) => !r.ok) as { e: MakeGoodError } | undefined;
    expect(lost?.e.code).toBe("TOO_SOON");
    expect((await client`SELECT count(*)::int AS n FROM make_goods WHERE created_at = ${slot(3).toISOString()}::timestamptz`)[0]!.n).toBe(1);
  });

  it("the staff list counts who collected and how much went out", async () => {
    const [mod, x, y] = [await staffer(), await makeResident(db), await makeResident(db)];
    const m = await createMakeGood(db, mod, { reason: SORRY, amount: 40 }, { now: slot(4) });
    for (const u of [x, y]) await collectMakeGood(db, u, m.id, key(), { now: new Date(slot(4).getTime() + HOUR) });
    await collectMakeGood(db, x, m.id, key(), { now: new Date(slot(4).getTime() + 2 * HOUR) }); // a second tap pays nothing
    const listed = (await staffMakeGoods(db, mod)).find((r) => r.id === m.id);
    expect(listed).toMatchObject({ reason: SORRY, amount: 40, createdBy: mod, collected: 2, paid: 80 });
  });
});

describe("residents collect it", () => {
  it("once each, as GM minted under its own kind; staff collect the same as anyone", async () => {
    const [mod, u] = [await staffer(), await makeResident(db)];
    const m = await createMakeGood(db, mod, { reason: SORRY, amount: 100 }, { now: slot(5) });
    const later = new Date(slot(5).getTime() + DAY);
    expect((await myMakeGoods(db, u, { now: later })).map((x) => [x.id, x.reason, x.amount])).toEqual([[m.id, SORRY, 100]]);
    const before = await bal(u);
    const first = await collectMakeGood(db, u, m.id, key(), { now: later });
    expect(first).toEqual({ makeGoodId: m.id, amount: 100, already: false, balance: before + 100 });
    const again = await collectMakeGood(db, u, m.id.toUpperCase(), key(), { now: new Date(later.getTime() + HOUR) });
    expect(again).toEqual({ makeGoodId: m.id, amount: 100, already: true, balance: before + 100 });
    expect(await bal(u)).toBe(before + 100);
    expect(await myMakeGoods(db, u, { now: later })).toEqual([]);
    const tx = await client`SELECT t.kind, t.idempotency_key, e.amount::int AS amount FROM gm_entries e JOIN gm_transactions t ON t.id = e.tx_id WHERE e.account_id = ${userAccountId(u)} AND t.kind = 'make_good'`;
    expect([...tx]).toEqual([{ kind: "make_good", idempotency_key: `make_good:${m.id}:${u}`, amount: 100 }]);
    // Staff get no extra.
    expect(await collectMakeGood(db, mod, m.id, key(), { now: later })).toMatchObject({ amount: 100, already: false });
  });

  it("a retry or two devices at once never pays twice (the resident's lock)", async () => {
    const [mod, u] = [await staffer(), await makeResident(db)];
    const m = await createMakeGood(db, mod, { reason: SORRY, amount: 150 }, { now: slot(6) });
    const later = new Date(slot(6).getTime() + HOUR);
    const before = await bal(u);
    const settled = await race("make_good_collections", 5, Array.from({ length: 5 }, () => () => collectMakeGood(db, u, m.id, key(), { now: later })));
    expect(settled.map((r) => (r.ok ? r.v.already : (r.e as Error).message))).toEqual(expect.arrayContaining([false, true, true, true, true]));
    expect(settled.every((r) => r.ok && r.v.balance === before + 150)).toBe(true);
    expect(await bal(u)).toBe(before + 150);
    expect((await client`SELECT count(*)::int AS n FROM make_good_collections WHERE make_good_id = ${m.id}`)[0]!.n).toBe(1);
  });

  it("nothing for guests, accounts that haven't moved in, newcomers since, or anyone outside the 14 days", async () => {
    const [mod, u] = [await staffer(), await makeResident(db)];
    const m = await createMakeGood(db, mod, { reason: SORRY, amount: 100 }, { now: slot(7) });
    const guest = (await createGuest(db, { ageAck: true })).userId;
    const initData = await signTelegramInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 90_000_000 + Math.floor(Math.random() * 1e6) }) }, "mg:BOT");
    const claimed = (await signInWithTelegram(db, { initData, botToken: "mg:BOT", ageAck: true })).userId; // claimed, never moved in
    const later = new Date(slot(7).getTime() + DAY);
    // A guest with a resident written straight in, past move-in's own checks, is still a guest.
    const ghost = (await createGuest(db, { ageAck: true })).userId;
    await client`INSERT INTO residents (user_id, handle, name, look, traits, goal, backstory, starter_item, kit_style)
      VALUES (${ghost}, ${`g${ghost.slice(0, 8)}`}, 'Ghost', '{}'::jsonb, ARRAY['builder','lurker','ape'], 'homebody', 'og_kid', 'og_kid_cap', 'cozy')`;
    for (const nobody of [guest, claimed, ghost]) {
      expect(await myMakeGoods(db, nobody, { now: later })).toEqual([]);
      expect(await code(collectMakeGood(db, nobody, m.id, key(), { now: later }))).toBe("NO_RESIDENT");
    }
    // Before it goes out it doesn't exist; from 14 days on it's closed.
    expect(await myMakeGoods(db, u, { now: new Date(slot(7).getTime() - 1) })).toEqual([]);
    expect(await code(collectMakeGood(db, u, m.id, key(), { now: new Date(slot(7).getTime() - 1) }))).toBe("NO_SUCH_MAKE_GOOD");
    expect(await myMakeGoods(db, u, { now: new Date(slot(7).getTime() + 14 * DAY) })).toEqual([]);
    expect(await code(collectMakeGood(db, u, m.id, key(), { now: new Date(slot(7).getTime() + 14 * DAY) }))).toBe("TOO_LATE");
    expect(await code(collectMakeGood(db, u, randomUUID(), key(), { now: later }))).toBe("NO_SUCH_MAKE_GOOD");
    expect(await code(collectMakeGood(db, u, "not-a-uuid", key(), { now: later }))).toBe("NO_SUCH_MAKE_GOOD");
    expect(await code(collectMakeGood(db, u, m.id, "", { now: later }))).toBe("INVALID_INPUT");
    expect(await bal(u)).toBe(1000);
  });

  it("a resident who moved in after it went out gets nothing", async () => {
    const mod = await staffer();
    // Sent now (weeks away from every other test's), by the database's own
    // clock, which stamps move-ins: the staffer is in, the newcomer isn't yet.
    const sent = new Date((await clock()).getTime() + 2);
    const m = await createMakeGood(db, mod, { reason: SORRY, amount: 100 }, { now: sent });
    const newcomer = await makeResident(db);
    const later = new Date(sent.getTime() + HOUR);
    expect(await myMakeGoods(db, newcomer, { now: later })).toEqual([]);
    expect(await code(collectMakeGood(db, newcomer, m.id, key(), { now: later }))).toBe("NOT_ELIGIBLE");
    expect((await myMakeGoods(db, mod, { now: later })).map((x) => x.id)).toEqual([m.id]); // moved in before it
  });
});

describe("the supply stays honest", () => {
  it("collected GM is created GM: in the supply stats and the Drip Committee's report, under make_good", async () => {
    const [mod, u] = [await staffer(), await makeResident(db)];
    const m = await createMakeGood(db, mod, { reason: SORRY, amount: 90 }, { now: slot(8) });
    // The database's clock stamps the entries, so the window comes from it too.
    const s0 = await supplyStats(db);
    const from = await clock();
    await collectMakeGood(db, u, m.id, key(), { now: new Date(slot(8).getTime() + HOUR) });
    const to = new Date((await clock()).getTime() + 1);
    const s1 = await supplyStats(db);
    expect([s1.created - s0.created, s1.destroyed - s0.destroyed, s1.circulating - s0.circulating]).toEqual([90, 0, 90]);
    const r = await economyReport(db, { from, to });
    expect(r.created).toEqual({ make_good: 90 });
    expect(r.totalCreated).toBe(90);
  });

  it("the broke floor counts a collected make-good like any other GM", async () => {
    const [mod, u] = [await staffer(), await makeResident(db)];
    await burn(db, { accountId: userAccountId(u), amount: 950, kind: "test_burn", idempotencyKey: key() }); // down to 50
    const m = await createMakeGood(db, mod, { reason: SORRY, amount: 100 }, { now: slot(9) });
    const later = new Date(slot(9).getTime() + HOUR);
    await collectMakeGood(db, u, m.id, key(), { now: later });
    // 150 GM is over the floor: the ordinary drip, not the broke floor's.
    expect(await sayGm(db, u, { now: later })).toMatchObject({ cityDay: cityDay(later), drip: 50, brokeFloor: false, balance: 200 });
  });
});

describe("the reason, after it's sent", () => {
  const flag = (word: string): ModerationProvider => ({ classify: async (ts) => ts.map((t) => ({ flagged: t.includes(word), categories: ["harassment"] })) });

  it("the AI check can take it down (the GM still goes out) and other staff can put it back", async () => {
    const [mod, other, u] = [await staffer(), await staffer(), await makeResident(db)];
    const tag = randomUUID().slice(0, 6);
    const m = await createMakeGood(db, mod, { reason: `Sorry ${tag}, the outage`, amount: 60 }, { now: slot(10) });
    await client`UPDATE moderation_items SET status = 'clean' WHERE status = 'pending' AND text NOT LIKE ${`%${tag}%`}`;
    await runModerationBatch(db, flag(tag));
    const later = new Date(slot(10).getTime() + HOUR);
    expect((await myMakeGoods(db, u, { now: later })).map((x) => x.reason)).toEqual([MAKE_GOOD_UNDER_REVIEW]);
    expect(await collectMakeGood(db, u, m.id, key(), { now: later })).toMatchObject({ amount: 60, already: false });
    const [item] = await client`SELECT id FROM moderation_items WHERE ref = ${m.id}`;
    expect(await code(reviewModerationItem(db, mod, item!.id, "restore"))).toBe("NOT_STAFF"); // not their own
    await reviewModerationItem(db, other, item!.id, "restore");
    expect((await staffMakeGoods(db, other)).find((r) => r.id === m.id)?.reason).toBe(`Sorry ${tag}, the outage`);
  });

  it("the record can't be rewritten or deleted, and the database holds the cap", async () => {
    const mod = await staffer();
    const [m] = await client`SELECT id FROM make_goods ORDER BY created_at LIMIT 1`;
    await expect(client`UPDATE make_goods SET amount = 1 WHERE id = ${m!.id}`).rejects.toThrow(/fixed once made/);
    await expect(client`UPDATE make_goods SET created_by = ${mod} WHERE id = ${m!.id}`).rejects.toThrow(/fixed once made/);
    await expect(client`UPDATE make_goods SET created_at = now() WHERE id = ${m!.id}`).rejects.toThrow(/fixed once made/);
    await expect(client`DELETE FROM make_goods WHERE id = ${m!.id}`).rejects.toThrow(/append-only/);
    await expect(client`UPDATE make_good_collections SET amount = 1`).rejects.toThrow(/append-only/);
    await expect(client`DELETE FROM make_good_collections`).rejects.toThrow(/append-only/);
    await expect(client`INSERT INTO make_goods (reason, amount, created_by) VALUES (${SORRY}, 201, ${mod})`).rejects.toThrow(/make_goods_amount/);
  });
});
