import { randomUUID } from "node:crypto";
import { CAST, type FeedMarket, type OddsProvider, addDays, cityAccountId, cityDay, cityWeekday, userAccountId } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CityMarketError,
  burn,
  collectRent,
  createCityMarket,
  createDb,
  ensureSystemAccounts,
  getBalance,
  grantMood,
  headcount,
  makeCall,
  openGmStakes,
  pollOdds,
  recordVisit,
  reel,
  resolveCityMarket,
  runBell,
  sayGm,
  seasonStack,
  settleCityMarkets,
  stakeCity,
  supplyStats,
} from "../src";
import { makeResident, releaseTogether } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
let day0 = Date.parse("2038-04-05T00:00:00Z");
const freshDay = () => (day0 += 4 * D);
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const bal = (u: string) => getBalance(db, userAccountId(u));

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof CityMarketError) return e.code;
    if ((e as { code?: string })?.code === "NO_TICKETS") return "NO_TICKETS";
    throw e;
  }
}
async function staffer() {
  const s = await makeResident(db);
  await client`INSERT INTO staff (user_id, role) VALUES (${s}, 'moderator')`;
  return s;
}
const ponned = async () => {
  const u = await makeResident(db);
  await client`UPDATE users SET proof_of_neighbour_at = now() WHERE id = ${u}`;
  return u;
};
// A Tower market so residents can make "a call that day".
async function towerDay(d0: number) {
  const ms = new Map<string, FeedMarket>();
  const provider: OddsProvider = { source: "city-test", fetch: async () => [...ms.values()].map((m) => ({ ...m })) };
  const m: FeedMarket = { externalId: randomUUID(), question: "Any?", category: "sports", ladder: null, freezesAt: new Date(d0 + 16 * H), settlesBy: new Date(d0 + 20 * H), price: 50, resolved: null, voided: false };
  ms.set(m.externalId, m);
  await pollOdds(db, provider, { now: new Date(d0 + 9 * H - MIN) });
  const [row] = await client`SELECT id FROM markets WHERE external_id = ${m.externalId}`;
  return {
    callToday: async (u: string) => {
      await client`INSERT INTO tickets (user_id, balance, as_of) VALUES (${u}, 9, ${dayOf(d0)}) ON CONFLICT (user_id) DO UPDATE SET balance = 9, as_of = ${dayOf(d0)}`;
      await makeCall(db, u, { marketId: row!.id, side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(d0 + 9 * H - MIN + 1000) });
    },
    lock: () => pollOdds(db, provider, { now: new Date(d0 + 9 * H) }),
  };
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("writing City markets", () => {
  it("staff only, with a real question, place and threshold; locks 2 hours before the bell", async () => {
    const d0 = freshDay();
    const s = await staffer();
    const nobody = await makeResident(db);
    const ok = { question: "20+ neighbours on the Roof at the bell?", kind: "headcount", bellDay: dayOf(d0), place: "roof", threshold: 20 };
    expect(await code(createCityMarket(db, nobody, ok, { now: new Date(d0) }))).toBe("NOT_STAFF");
    const m = await createCityMarket(db, s, ok, { now: new Date(d0) });
    expect(m.locksAt.toISOString()).toBe(new Date(d0 + 22 * H).toISOString());
    expect(m.measureAt!.toISOString()).toBe(new Date(d0 + D).toISOString());
    for (const bad of [{ question: "?" }, { kind: "vibes" }, { bellDay: "2000-01-01" }, { bellDay: "junk" }, { place: "home:x" }, { threshold: 0 }, { threshold: 2.5 }, { measureAt: new Date(d0).toISOString() }])
      expect(await code(createCityMarket(db, s, { ...ok, ...bad }, { now: new Date(d0) }))).toBe("INVALID_INPUT");
  });

  it("never writes a market that's already locked (nobody could stake on it)", async () => {
    const d0 = freshDay();
    const s = await staffer();
    const manual = { question: "Will the Mayor pick Gas Holiday?", kind: "manual", bellDay: dayOf(d0) };
    expect((await createCityMarket(db, s, manual, { now: new Date(d0 + 22 * H - 1000) })).locksAt.toISOString()).toBe(new Date(d0 + 22 * H).toISOString());
    expect(await code(createCityMarket(db, s, manual, { now: new Date(d0 + 22 * H) }))).toBe("INVALID_INPUT");
    expect(await code(createCityMarket(db, s, manual, { now: new Date(d0 + 23 * H) }))).toBe("INVALID_INPUT");
    // Tomorrow's bell is fine at the same moment.
    expect((await createCityMarket(db, s, { ...manual, bellDay: dayOf(d0 + D) }, { now: new Date(d0 + 23 * H) })).id).toBeTruthy();
  });
});

describe("the headcount", () => {
  it("counts Proof of Neighbour residents who called that day and were in the room at the moment; nobody else", async () => {
    const d0 = freshDay();
    const t = await towerDay(d0);
    const bell = new Date(d0 + D);
    const [inA, inB, noPon, noCall, leftEarly, elsewhere] = [await ponned(), await ponned(), await makeResident(db), await ponned(), await ponned(), await ponned()];
    for (const u of [inA, inB, noPon, leftEarly, elsewhere]) await t.callToday(u);
    await t.lock();
    const room = `roof#${Math.floor(Math.random() * 1e6)}`;
    for (const u of [inA, inB, noPon, noCall, leftEarly, CAST.nothing_9000.id]) await recordVisit(db, { userId: u, room, event: "start", at: new Date(bell.getTime() - 30 * MIN) });
    await recordVisit(db, { userId: leftEarly, room, event: "end", at: new Date(bell.getTime() - MIN) });
    await recordVisit(db, { userId: elsewhere, room: `tower#${Math.floor(Math.random() * 1e6)}`, event: "start", at: new Date(bell.getTime() - 30 * MIN) });
    expect(await headcount(db, "roof", bell, dayOf(d0))).toBe(2);
  });
});

describe("staking and settling", () => {
  it("stakes inside the cap with a ticket, once per market, until it locks", async () => {
    // Today, for real: the cap counts days since you moved in.
    const d0 = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    const s = await staffer();
    const m = await createCityMarket(db, s, { question: "Will staff say yes?", kind: "manual", bellDay: dayOf(d0 + D) }, { now: new Date(d0) }); // tomorrow's bell: open whatever the hour
    const fresh = await makeResident(db); // day 0: cap is 100 (and 200 before PoN anyway)
    const at = new Date();
    expect(await code(stakeCity(db, fresh, { marketId: m.id, side: "yes", stake: 101 }, { now: at }))).toBe("OVER_CAP");
    const before = await bal(fresh);
    expect(await stakeCity(db, fresh, { marketId: m.id, side: "yes", stake: 100 }, { now: at })).toMatchObject({ stake: 100 });
    expect((await bal(fresh)) - before).toBe(-100);
    expect(await getBalance(db, cityAccountId(m.id))).toBe(100);
    expect(await code(stakeCity(db, fresh, { marketId: m.id, side: "no", stake: 5 }, { now: at }))).toBe("ALREADY_IN");
    const late = await makeResident(db);
    expect(await code(stakeCity(db, late, { marketId: m.id, side: "no", stake: 5 }, { now: new Date(d0 + D + 22 * H) }))).toBe("LOCKED");
    const tilted = await makeResident(db);
    await grantMood(db, tilted, "tilted", { now: at });
    expect(await code(stakeCity(db, tilted, { marketId: m.id, side: "no", stake: 11 }, { now: at }))).toBe("OVER_CAP");
    for (const bad of [{ side: "maybe" }, { stake: 0 }, { stake: 1.5 }, { marketId: "x" }]) expect(await code(stakeCity(db, tilted, { marketId: m.id, side: "no", stake: 5, ...bad }, { now: at }))).toMatch(/INVALID_INPUT|NO_SUCH_MARKET/);
  });

  it("racing stakes by one resident: one gets in; tickets run out", async () => {
    const d0 = freshDay();
    const s = await staffer();
    const ms = await Promise.all(Array.from({ length: 4 }, (_, i) => createCityMarket(db, s, { question: `Will thing ${i} happen?`, kind: "manual", bellDay: dayOf(d0) }, { now: new Date(d0) })));
    const u = await makeResident(db);
    const at = new Date(d0 + 10 * H);
    const res = await releaseTogether(client, "SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [u], 1, [1, 2, 3].map(() => () => code(stakeCity(db, u, { marketId: ms[0]!.id, side: "yes", stake: 10 }, { now: at }))));
    expect(res.map((r) => (r.ok ? r.v : "THREW")).sort()).toEqual(["ALREADY_IN", "ALREADY_IN", "OK"]);
    expect(await code(stakeCity(db, u, { marketId: ms[1]!.id, side: "yes", stake: 10 }, { now: at }))).toBe("OK");
    expect(await code(stakeCity(db, u, { marketId: ms[2]!.id, side: "yes", stake: 10 }, { now: at }))).toBe("OK");
    expect(await code(stakeCity(db, u, { marketId: ms[3]!.id, side: "yes", stake: 10 }, { now: at }))).toBe("NO_TICKETS");
  });

  it("two stakes at once can't both use the same balance for the 25% cap", async () => {
    const d0 = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    const s = await staffer();
    const [m1, m2] = await Promise.all([1, 2].map((i) => createCityMarket(db, s, { question: `Race market ${i}?`, kind: "manual", bellDay: dayOf(d0 + D) }, { now: new Date(d0) })));
    const u = await makeResident(db);
    const { burn } = await import("../src");
    await burn(db, { accountId: userAccountId(u), amount: (await bal(u)) - 400, kind: "test", idempotencyKey: `cap:${u}` }); // 400: cap 100, then 75
    const res = await releaseTogether(client, "SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [u], 2, [m1!, m2!].map((m) => () => code(stakeCity(db, u, { marketId: m.id, side: "yes", stake: 100 }, { now: new Date() }))));
    expect(res.map((r) => (r.ok ? r.v : "THREW")).sort()).toEqual(["OK", "OVER_CAP"]);
  });

  it("at the bell winners split the losers' stakes minus the bell burn; nothing created; once", async () => {
    const d0 = freshDay();
    const s = await staffer();
    const m = await createCityMarket(db, s, { question: "Will the manual one go yes?", kind: "manual", bellDay: dayOf(d0) }, { now: new Date(d0) });
    const [a, b, c] = [await ponned(), await ponned(), await ponned()];
    const at = new Date(d0 + 10 * H);
    await stakeCity(db, a, { marketId: m.id, side: "yes", stake: 40 }, { now: at });
    await stakeCity(db, b, { marketId: m.id, side: "yes", stake: 100 }, { now: at });
    await stakeCity(db, c, { marketId: m.id, side: "no", stake: 80 }, { now: at });
    const [a0, b0, c0] = [await bal(a), await bal(b), await bal(c)];
    const burned0 = (await supplyStats(db)).destroyed;
    // Unresolved at its bell: it waits.
    await runBell(db, { now: new Date(d0 + D + 5 * MIN), only: ["tower"] });
    expect((await client`SELECT status FROM city_markets WHERE id = ${m.id}`)[0]!.status).toBe("open");
    expect(await code(resolveCityMarket(db, a, m.id, "yes"))).toBe("NOT_STAFF");
    await resolveCityMarket(db, s, m.id, "yes");
    expect(await code(resolveCityMarket(db, s, m.id, "no"))).toBe("WRONG_STATE"); // final
    await runBell(db, { now: new Date(d0 + 2 * D + 5 * MIN), only: ["tower"] });
    // Losers' 80 split 40:100 → a +22, b +57 (−1 bell burn on a win over 50); dust 1.
    expect((await bal(a)) - a0).toBe(40 + 22);
    expect((await bal(b)) - b0).toBe(100 + 57 - 1);
    expect((await bal(c)) - c0).toBe(0);
    expect((await supplyStats(db)).destroyed - burned0).toBe(1 + 1);
    expect(await getBalance(db, cityAccountId(m.id))).toBe(0);
    await runBell(db, { now: new Date(d0 + 3 * D + 5 * MIN), only: ["tower"] });
    expect((await bal(a)) - a0).toBe(62); // settled once
    // The Season Stack ranks GM profit.
    const stack = await seasonStack(db, { now: new Date(d0 + 2 * D) });
    const row = (u: string) => stack.rows.find((r) => r.userId === u);
    expect(row(b)!.profit).toBe(56);
    expect(row(a)!.profit).toBe(22);
    expect(row(c)!.profit).toBe(-80);
    expect(row(b)!.rank).toBeLessThan(row(a)!.rank);
  });

  it("a headcount market settles itself; a voided one refunds everyone; a one-sided one too", async () => {
    const d0 = freshDay();
    const t = await towerDay(d0);
    const s = await staffer();
    const hc = await createCityMarket(db, s, { question: "2+ on the Roof at the bell?", kind: "headcount", bellDay: dayOf(d0), place: "roof", threshold: 2 }, { now: new Date(d0) });
    const vm = await createCityMarket(db, s, { question: "Will this get voided?", kind: "manual", bellDay: dayOf(d0) }, { now: new Date(d0) });
    const [x, y, z] = [await ponned(), await ponned(), await ponned()];
    const at = new Date(d0 + 10 * H);
    await stakeCity(db, x, { marketId: hc.id, side: "yes", stake: 50 }, { now: at });
    await stakeCity(db, y, { marketId: hc.id, side: "no", stake: 50 }, { now: at });
    await stakeCity(db, z, { marketId: vm.id, side: "yes", stake: 40 }, { now: at });
    for (const u of [x, y]) await t.callToday(u);
    await t.lock();
    const room = `roof#${Math.floor(Math.random() * 1e6)}`;
    for (const u of [x, y]) await recordVisit(db, { userId: u, room, event: "start", at: new Date(d0 + D - 10 * MIN) });
    await resolveCityMarket(db, s, vm.id, "void");
    const [x0, y0, z0] = [await bal(x), await bal(y), await bal(z)];
    await runBell(db, { now: new Date(d0 + D + 5 * MIN), only: ["tower"] });
    expect((await client`SELECT status, outcome FROM city_markets WHERE id = ${hc.id}`)[0]).toEqual({ status: "settled", outcome: true });
    expect((await bal(x)) - x0).toBe(100);
    expect((await bal(y)) - y0).toBe(0);
    expect((await bal(z)) - z0).toBe(40); // refunded
    expect((await client`SELECT status FROM city_markets WHERE id = ${vm.id}`)[0]!.status).toBe("refunded");
    const r = await reel(db, x, { now: new Date(d0 + D + 10 * MIN) });
    expect(r!.cityMarkets).toEqual(expect.arrayContaining([{ question: "2+ on the Roof at the bell?", result: "yes" }, { question: "Will this get voided?", result: "void" }]));
  });
});

describe("a stake is still the staker's GM", () => {
  // Real days from today, so ledger timestamps (set by Postgres) and the city
  // clock agree, as in the rent tests.
  const today = cityDay();
  const toSat = ((6 - cityWeekday(today) + 7) % 7) || 7; // days to the next Saturday, 1..7
  const day = (n: number, hour = 12) => new Date(Date.parse(`${addDays(today, n)}T00:00:00Z`) + hour * H);
  const burnTo = async (u: string, gm: number) => burn(db, { accountId: userAccountId(u), amount: (await bal(u)) - gm, kind: "test", idempotencyKey: `burn_to:${u}` });

  it("for the broke floor: 120 GM with 30 of it staked still gets the plain drip", async () => {
    const s = await staffer();
    const m = await createCityMarket(db, s, { question: "Does the drip see stakes?", kind: "manual", bellDay: addDays(today, 3) }, { now: new Date() });
    const u = await makeResident(db);
    await burnTo(u, 120);
    await stakeCity(db, u, { marketId: m.id, side: "yes", stake: 30 }, { now: new Date() }); // the 25% cap
    expect(await bal(u)).toBe(90);
    expect(await openGmStakes(db, u)).toBe(30);
    expect(await sayGm(db, u, { now: day(1) })).toMatchObject({ drip: 50, brokeFloor: false });
  });

  it("for rent: a stake over the Saturday bell isn't the couch; the rent waits until the stake comes home", async () => {
    const s = await staffer();
    const bellDay = addDays(today, toSat + 2); // settles after the Saturday
    const m = await createCityMarket(db, s, { question: "Does rent see stakes?", kind: "manual", bellDay }, { now: new Date() });
    const u = await makeResident(db);
    await burnTo(u, 300);
    await stakeCity(db, u, { marketId: m.id, side: "yes", stake: 75 }, { now: new Date() });
    const saturday = addDays(today, toSat);
    // 225 in the wallet and 75 staked: they can pay, just not yet. No couch, no charge.
    expect(await collectRent(db, u, { now: day(toSat, 1) })).toEqual([{ saturday, status: "owed", amount: 0 }]);
    expect(await bal(u)).toBe(225);
    expect(await client`SELECT 1 FROM rent_charges WHERE user_id = ${u}`).toHaveLength(0);
    // The market is voided at its bell and the stake comes home.
    await resolveCityMarket(db, s, m.id, "void");
    await settleCityMarkets(db, bellDay, day(toSat + 3, 0));
    expect(await openGmStakes(db, u)).toBe(0);
    await sayGm(db, u, { now: day(toSat + 1) }); // still around: the next Saturday isn't a sublet
    // The next Saturday: the owed week is paid first (350 -> 100), then this week is the couch.
    const next = await collectRent(db, u, { now: day(toSat + 7, 1) });
    expect(next.map((o) => [o.saturday, o.status, o.amount])).toEqual([
      [saturday, "paid", 250],
      [addDays(saturday, 7), "couch", 0],
    ]);
    expect(await bal(u)).toBe(100);
  });

  it("until it settles", async () => {
    const d0 = freshDay();
    const s = await staffer();
    const m = await createCityMarket(db, s, { question: "Does a settled stake still count?", kind: "manual", bellDay: dayOf(d0) }, { now: new Date(d0) });
    const [a, b] = [await ponned(), await ponned()];
    const at = new Date(d0 + 10 * H);
    await stakeCity(db, a, { marketId: m.id, side: "yes", stake: 40 }, { now: at });
    await stakeCity(db, b, { marketId: m.id, side: "no", stake: 60 }, { now: at });
    expect([await openGmStakes(db, a), await openGmStakes(db, b)]).toEqual([40, 60]);
    await resolveCityMarket(db, s, m.id, "no");
    await settleCityMarkets(db, dayOf(d0), new Date(d0 + D + 5 * MIN));
    expect([await openGmStakes(db, a), await openGmStakes(db, b)]).toEqual([0, 0]);
  });
});
