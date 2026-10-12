import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type FeedMarket, type GammaEvent, type GammaMarket, type KnownMarket, type OddsProvider, auraCenti, cityDay, mintAccountFor, polymarketProvider, userAccountId } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TowerError,
  createDb,
  ensureSystemAccounts,
  feedStatus,
  grantOwedStreakDays,
  makeCall,
  marketView,
  myTickets,
  openMarkets,
  pollOdds,
  sayGm,
  setPrefs,
  touchActivity,
  blockUser,
  createCrew,
  createInvite,
  redeemInvite,
  receipt,
  rightList,
  receiptBinder,
  settleCalls,
  npcCalls,
  todaySlate,
} from "../src";
import { makeResident, releaseTogether } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
let base = new Date("2031-01-06T09:00:00Z").getTime();
const fresh = () => (base += 30 * D);

// A feed whose prices the test sets by hand.
function feed() {
  const ms = new Map<string, FeedMarket>();
  const provider: OddsProvider & { fail?: boolean } = {
    source: "test",
    async fetch() {
      if (provider.fail) throw new Error("feed down");
      return [...ms.values()].map((m) => ({ ...m }));
    },
  };
  const add = (t: number, over: Partial<FeedMarket> = {}) => {
    const m: FeedMarket = { externalId: randomUUID(), question: "Will it?", category: "crypto", ladder: null, freezesAt: new Date(t + 10 * H), settlesBy: new Date(t + 12 * H), price: 50, resolved: null, voided: false, ...over };
    ms.set(m.externalId, m);
    return m;
  };
  return { provider, ms, add };
}
const idOf = async (ext: string) => (await client`SELECT id FROM markets WHERE external_id = ${ext}`)[0]!.id as string;
const pon = (ids: string[]) => client`UPDATE users SET proof_of_neighbour_at = now() WHERE id IN ${client(ids)}`;
const callRow = async (id: string) => (await client`SELECT * FROM calls WHERE id = ${id}`)[0]!;

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof TowerError) return e.code;
    throw e;
  }
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("the odds feed", () => {
  it("stores markets and a tick per poll; politics is read-only; freezes and resolutions land; final stays final", async () => {
    const t = fresh();
    const f = feed();
    const a = f.add(t);
    const pol = f.add(t, { category: "politics", question: "Will a senator...?" });
    expect(await pollOdds(db, f.provider, { now: new Date(t) })).toMatchObject({ ok: true, ticked: 2 });
    a.price = 55;
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    const ticks = await client`SELECT price FROM market_ticks WHERE market_id = ${await idOf(a.externalId)} ORDER BY id`;
    expect(ticks.map((x) => x.price)).toEqual([50, 55]);
    expect((await client`SELECT info_only FROM markets WHERE external_id = ${pol.externalId}`)[0]!.info_only).toBe(true);
    await pollOdds(db, f.provider, { now: new Date(t + 11 * H) });
    expect((await client`SELECT status FROM markets WHERE external_id = ${a.externalId}`)[0]!.status).toBe("frozen");
    a.resolved = true;
    await pollOdds(db, f.provider, { now: new Date(t + 13 * H) });
    a.resolved = false; // a feed that changes its mind changes nothing
    a.voided = true;
    await pollOdds(db, f.provider, { now: new Date(t + 14 * H) });
    expect((await client`SELECT status, outcome FROM markets WHERE external_id = ${a.externalId}`)[0]).toMatchObject({ status: "resolved", outcome: true });
    // No ticks once it's not open.
    expect(await client`SELECT 1 FROM market_ticks WHERE market_id = ${await idOf(a.externalId)}`).toHaveLength(2);
  });

  it("junk from the feed is skipped, not stored; a failing feed is recorded and pauses the odds", async () => {
    const t = fresh();
    const f = feed();
    for (const bad of [{ price: 0 }, { price: 100 }, { price: 50.5 }, { externalId: "" }, { question: "" }, { freezesAt: new Date("nope") }, { settlesBy: new Date(t - D) }]) f.add(t, bad as Partial<FeedMarket>);
    f.add(t);
    expect(await pollOdds(db, f.provider, { now: new Date(t) })).toMatchObject({ ok: true, ticked: 1, bad: 7 });
    expect((await feedStatus(db, { now: new Date(t + MIN) })).paused).toBe(false);
    f.provider.fail = true;
    expect(await pollOdds(db, f.provider, { now: new Date(t + 2 * MIN) })).toMatchObject({ ok: false });
    expect((await feedStatus(db, { now: new Date(t + 4 * MIN) })).paused).toBe(true);
    // A poll stamped after "now" (clock skew, or a test elsewhere) says nothing about now.
    f.provider.fail = false;
    await pollOdds(db, f.provider, { now: new Date(t + 365 * D) });
    expect((await feedStatus(db, { now: new Date(t + 5 * MIN) })).paused).toBe(true);
  });

  it("a poller that finds another one running skips; a repeat poll for the same moment adds no tick", async () => {
    const t = fresh();
    const f = feed();
    const a = f.add(t);
    const held = await client.reserve();
    await held`SELECT pg_advisory_lock(${0x70110dd5})`;
    try {
      expect(await pollOdds(db, f.provider, { now: new Date(t) })).toMatchObject({ ok: true, skipped: true });
    } finally {
      await held`SELECT pg_advisory_unlock(${0x70110dd5})`;
      held.release();
    }
    await pollOdds(db, f.provider, { now: new Date(t) });
    await pollOdds(db, f.provider, { now: new Date(t) });
    expect(await client`SELECT 1 FROM market_ticks WHERE market_id = ${await idOf(a.externalId)}`).toHaveLength(1);
  });

  it("a market the feed drops leaves the Floor and takes no calls until it's back", async () => {
    const t = fresh();
    const f = feed();
    const [a, b] = [f.add(t), f.add(t)];
    await pollOdds(db, f.provider, { now: new Date(t) });
    const [ia, ib] = [await idOf(a.externalId), await idOf(b.externalId)];
    const floor = async (at: number) => (await openMarkets(db, { now: new Date(at), limit: 200 })).map((m) => m.id);
    expect(await floor(t + 1000)).toEqual(expect.arrayContaining([ia, ib]));
    // b drops out of the listing (an extreme price, or out of the top 20): its price goes stale.
    f.ms.delete(b.externalId);
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    expect(await floor(t + MIN + 1000)).toContain(ia);
    expect(await floor(t + MIN + 1000)).not.toContain(ib);
    const u = await makeResident(db);
    expect(await code(makeCall(db, u, { marketId: ib, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + MIN + 1000) }))).toBe("MARKET_CLOSED");
    expect(await myTickets(db, u, { now: new Date(t) })).toMatchObject({ tickets: 3 });
    // Back in the listing: callable again.
    f.ms.set(b.externalId, b);
    await pollOdds(db, f.provider, { now: new Date(t + 2 * MIN) });
    expect(await floor(t + 2 * MIN + 1000)).toContain(ib);
    expect(await code(makeCall(db, u, { marketId: ib, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + 2 * MIN + 1000) }))).toBe("OK");
  });

  it("a market past its freeze is frozen whether the feed lists it or not, and leaves the Floor at once", async () => {
    const t = fresh();
    const f = feed();
    const early = f.add(t, { freezesAt: new Date(t + H), settlesBy: new Date(t + 2 * H) });
    const late = f.add(t, { freezesAt: new Date(t + 5 * H), settlesBy: new Date(t + 6 * H) });
    await pollOdds(db, f.provider, { now: new Date(t) });
    const [ie, il] = [await idOf(early.externalId), await idOf(late.externalId)];
    const u = await makeResident(db);
    const c = await makeCall(db, u, { marketId: ie, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + 1000) });
    // Past its freeze, before any poll has noticed: already off the Floor.
    expect((await openMarkets(db, { now: new Date(t + H + 1000), limit: 200 })).map((m) => m.id)).not.toContain(ie);
    // The feed stops listing it before it freezes (Polymarket drops frozen markets).
    f.ms.delete(early.externalId);
    await pollOdds(db, f.provider, { now: new Date(t + 2 * H) });
    expect((await client`SELECT status, in_feed FROM markets WHERE id = ${ie}`)[0]).toMatchObject({ status: "frozen", in_feed: false });
    expect((await callRow(c.id)).status).toBe("expired");
    expect(await myTickets(db, u, { now: new Date(t) })).toMatchObject({ tickets: 3 });
    // So the open rows on the Floor are the live ones, however many have frozen before them.
    const listed = (await openMarkets(db, { now: new Date(t + 2 * H + 1000), limit: 200 })).map((m) => m.id);
    expect(listed).toContain(il);
    expect(listed).not.toContain(ie);
  });

  it("the credit line names the feed the odds came from", async () => {
    const t = fresh();
    const f = feed();
    f.add(t);
    await pollOdds(db, f.provider, { now: new Date(t) });
    expect(await feedStatus(db, { now: new Date(t + MIN) })).toMatchObject({ paused: false, credit: "Sample odds · Not real" });
  });
});

describe("making a call", () => {
  async function setup(over: Partial<FeedMarket> = {}) {
    const t = fresh();
    const f = feed();
    const m = f.add(t, over);
    await pollOdds(db, f.provider, { now: new Date(t) });
    return { t, f, m, id: await idOf(m.externalId), u: await makeResident(db) };
  }

  it("waits in the mempool, then locks at the next tick within 2 points", async () => {
    const { t, f, m, id, u } = await setup();
    const c = await makeCall(db, u, { marketId: id, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + 10_000) });
    expect(c).toMatchObject({ status: "pending", ticket: true });
    m.price = 52;
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    expect(await callRow(c.id)).toMatchObject({ status: "locked", locked_price: 52, half: false });
  });

  it("no sniping: a call confirmed at a tick's own moment waits for the next tick", async () => {
    const { t, f, m, id, u } = await setup();
    const c = await makeCall(db, u, { marketId: id, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + MIN) });
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    expect((await callRow(c.id)).status).toBe("pending");
    m.price = 51;
    await pollOdds(db, f.provider, { now: new Date(t + 2 * MIN) });
    expect(await callRow(c.id)).toMatchObject({ status: "locked", locked_price: 51 });
  });

  it("price moved more than 2: dropped, ticket back, and you can call again", async () => {
    const { t, f, m, id, u } = await setup();
    const c = await makeCall(db, u, { marketId: id, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + 10_000) });
    expect((await myTickets(db, u, { now: new Date(t) })).tickets).toBe(2);
    m.price = 53;
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    expect((await callRow(c.id)).status).toBe("price_moved");
    expect((await myTickets(db, u, { now: new Date(t) })).tickets).toBe(3);
    expect(await code(makeCall(db, u, { marketId: id, side: "yes", chance: 70, seenPrice: 53 }, { now: new Date(t + MIN + 1000) }))).toBe("OK");
  });

  it("one call per market, no edits, even racing", async () => {
    const { t, id, u } = await setup();
    // The barrier locks the ticket row, so it has to exist before the racers start.
    await client`INSERT INTO tickets (user_id, balance, as_of) VALUES (${u}, 3, ${new Date(t).toISOString().slice(0, 10)})`;
    const res = await releaseTogether(client, "SELECT 1 FROM tickets WHERE user_id = $1 FOR UPDATE", [u], 1, [70, 80, 60, 90].map((ch) => () => code(makeCall(db, u, { marketId: id, side: "yes", chance: ch, seenPrice: 50 }, { now: new Date(t + 1000) }))));
    expect(res.map((r) => (r.ok ? r.v : "THREW")).sort()).toEqual(["ALREADY_CALLED", "ALREADY_CALLED", "ALREADY_CALLED", "OK"]);
    expect((await myTickets(db, u, { now: new Date(t) })).tickets).toBe(2); // the refused ones didn't cost a ticket
  });

  it("refuses: the wrong side of the price, junk, a price far from the market, closed, read-only, no resident, odds paused", async () => {
    const { t, f, id, u } = await setup();
    const now = { now: new Date(t + 1000) };
    expect(await code(makeCall(db, u, { marketId: id, side: "yes", chance: 40, seenPrice: 50 }, now))).toBe("INVALID_INPUT");
    expect(await code(makeCall(db, u, { marketId: id, side: "no", chance: 60, seenPrice: 50 }, now))).toBe("INVALID_INPUT");
    expect(await code(makeCall(db, u, { marketId: id, side: "yes", chance: 50, seenPrice: 50 }, now))).toBe("INVALID_INPUT");
    for (const bad of [{ side: "maybe" }, { chance: 100 }, { chance: 70.5 }, { chance: "70" }, { seenPrice: 0 }, { seenPrice: null }])
      expect(await code(makeCall(db, u, { marketId: id, side: "yes", chance: 70, seenPrice: 50, ...bad }, now))).toBe("INVALID_INPUT");
    for (const bad of [null, "x", randomUUID()]) expect(await code(makeCall(db, u, { marketId: bad, side: "yes", chance: 70, seenPrice: 50 }, now))).toBe("NO_SUCH_MARKET");
    expect(await code(makeCall(db, u, { marketId: id, side: "yes", chance: 70, seenPrice: 45 }, now))).toBe("PRICE_MOVED");
    expect(await code(makeCall(db, u, { marketId: id, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + 10 * H) }))).toBe("MARKET_CLOSED");
    const pol = f.add(t, { category: "politics" });
    await pollOdds(db, f.provider, { now: new Date(t + 1000) });
    expect(await code(makeCall(db, u, { marketId: await idOf(pol.externalId), side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + 2000) }))).toBe("INFO_ONLY");
    const [noRes] = await client`INSERT INTO users (age_ack_at) VALUES (now()) RETURNING id`;
    expect(await code(makeCall(db, noRes!.id, { marketId: id, side: "yes", chance: 70, seenPrice: 50 }, now))).toBe("NO_RESIDENT");
    expect(await code(makeCall(db, u, { marketId: id, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + 5 * MIN) }))).toBe("FEED_PAUSED");
  });

  it("the last 30 minutes earn half; the Slate is exempt and takes no ticket", async () => {
    const { t, f, id, u } = await setup();
    const late = new Date(t + 10 * H - 20 * MIN);
    await pollOdds(db, f.provider, { now: late });
    const c = await makeCall(db, u, { marketId: id, side: "no", chance: 30, seenPrice: 50 }, { now: new Date(late.getTime() + 1000) });
    const v = await makeResident(db);
    const s = await makeCall(db, v, { marketId: id, side: "no", chance: 30, seenPrice: 50 }, { now: new Date(late.getTime() + 1000), onSlate: async () => true });
    expect(s.ticket).toBe(false);
    await pollOdds(db, f.provider, { now: new Date(late.getTime() + MIN) });
    expect((await callRow(c.id)).half).toBe(true);
    expect((await callRow(s.id)).half).toBe(false);
    expect((await myTickets(db, v, { now: late })).tickets).toBe(3);
  });

  it("a call that can never lock expires and gives its ticket back", async () => {
    const { t, f, m, id, u } = await setup();
    await pollOdds(db, f.provider, { now: new Date(t + 10 * H - 2 * MIN) });
    const c = await makeCall(db, u, { marketId: id, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + 10 * H - 1000) });
    m.price = 51;
    await pollOdds(db, f.provider, { now: new Date(t + 10 * H) }); // frozen at this poll: no tick
    expect((await callRow(c.id)).status).toBe("expired");
    expect((await myTickets(db, u, { now: new Date(t) })).tickets).toBe(3);
    // And one stranded by a silent feed for 5+ minutes.
    const s2 = await setup();
    const c2 = await makeCall(db, s2.u, { marketId: s2.id, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(s2.t + 1000) });
    const other = feed();
    other.add(s2.t);
    await pollOdds(db, other.provider, { now: new Date(s2.t + 6 * MIN) }); // a poll that doesn't carry its market
    expect((await callRow(c2.id)).status).toBe("expired");
  });
});

describe("tickets", () => {
  it("3 a day, stacking to 9, and never spent twice by racing calls", async () => {
    const t = fresh();
    const f = feed();
    const ms = Array.from({ length: 6 }, () => f.add(t));
    await pollOdds(db, f.provider, { now: new Date(t) });
    const u = await makeResident(db);
    await makeCall(db, u, { marketId: await idOf(ms[5]!.externalId), side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(t) }); // creates the row: 2 left
    const ids = await Promise.all(ms.slice(0, 5).map((m) => idOf(m.externalId)));
    const res = await releaseTogether(client, "SELECT 1 FROM tickets WHERE user_id = $1 FOR UPDATE", [u], ids.length, ids.map((id) => () => code(makeCall(db, u, { marketId: id, side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(t + 1000) }))));
    expect(res.filter((r) => r.ok && r.v === "OK")).toHaveLength(2);
    expect(res.filter((r) => r.ok && r.v === "NO_TICKETS")).toHaveLength(3);
    expect((await myTickets(db, u, { now: new Date(t + D) })).tickets).toBe(3);
    expect((await myTickets(db, u, { now: new Date(t + 10 * D) })).tickets).toBe(9);
  });
});

describe("Tail and Fade", () => {
  async function scene() {
    const t = fresh();
    const f = feed();
    const m = f.add(t);
    await pollOdds(db, f.provider, { now: new Date(t) });
    const id = await idOf(m.externalId);
    const [a, b] = [await makeResident(db), await makeResident(db)];
    await makeCall(db, a, { marketId: id, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + 1000) });
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    return { t, f, id, a, b };
  }
  const fren = async (x: string, y: string) => {
    const [p, q] = x < y ? [x, y] : [y, x];
    await client`INSERT INTO frens (a, b) VALUES (${p}, ${q})`;
  };

  it("a Tail copies a fren's side; a Fade takes the other one and pings them", async () => {
    const { t, id, a, b } = await scene();
    expect(await code(makeCall(db, b, { marketId: id, via: "tail", viaUserId: a, chance: 70, seenPrice: 50 }, { now: new Date(t + 2 * MIN) }))).toBe("NOT_FRENS");
    await fren(a, b);
    const tail = await makeCall(db, b, { marketId: id, via: "tail", viaUserId: a, side: "no", chance: 65, seenPrice: 50 }, { now: new Date(t + 2 * MIN) });
    expect(tail.side).toBe("yes"); // their side, whatever was sent
    const c = await makeResident(db);
    await setPrefs(db, a, { alerts: ["faded"] });
    const fade = await makeCall(db, c, { marketId: id, via: "fade", viaUserId: a, chance: 30, seenPrice: 50 }, { now: new Date(t + 2 * MIN) });
    expect(fade.side).toBe("no");
    expect((await client`SELECT kind FROM notifications WHERE user_id = ${a}`).map((r) => r.kind)).toEqual(["faded"]);
  });

  it("2 tails a day; nothing to tail; never yourself, never across a block, never on the Slate", async () => {
    const { t, f, id, a, b } = await scene();
    await fren(a, b);
    expect(await code(makeCall(db, b, { marketId: id, via: "tail", viaUserId: b, chance: 70, seenPrice: 50 }, { now: new Date(t + 2 * MIN) }))).toBe("INVALID_INPUT");
    expect(await code(makeCall(db, b, { marketId: id, via: "tail", viaUserId: a, chance: 70, seenPrice: 50 }, { now: new Date(t + 2 * MIN), onSlate: async () => true }))).toBe("INVALID_INPUT");
    const more = Array.from({ length: 2 }, () => f.add(t));
    await pollOdds(db, f.provider, { now: new Date(t + 2 * MIN) });
    const ids = await Promise.all(more.map((m) => idOf(m.externalId)));
    expect(await code(makeCall(db, b, { marketId: ids[0], via: "tail", viaUserId: a, chance: 70, seenPrice: 50 }, { now: new Date(t + 3 * MIN) }))).toBe("NOTHING_TO_TAIL");
    for (const mid of ids) await makeCall(db, a, { marketId: mid, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + 3 * MIN) });
    await pollOdds(db, f.provider, { now: new Date(t + 4 * MIN) });
    expect(await code(makeCall(db, b, { marketId: id, via: "tail", viaUserId: a, chance: 70, seenPrice: 50 }, { now: new Date(t + 5 * MIN) }))).toBe("OK");
    expect(await code(makeCall(db, b, { marketId: ids[0], via: "tail", viaUserId: a, chance: 70, seenPrice: 50 }, { now: new Date(t + 5 * MIN) }))).toBe("OK");
    expect(await code(makeCall(db, b, { marketId: ids[1], via: "tail", viaUserId: a, chance: 70, seenPrice: 50 }, { now: new Date(t + 5 * MIN) }))).toBe("TOO_MANY_TAILS");
    expect((await myTickets(db, b, { now: new Date(t + 5 * MIN) })).tickets).toBe(1); // the refused tail cost nothing
    const c = await makeResident(db);
    await blockUser(db, a, c);
    expect(await code(makeCall(db, c, { marketId: id, via: "fade", viaUserId: a, chance: 30, seenPrice: 50 }, { now: new Date(t + 5 * MIN) }))).toBe("BLOCKED");
  });
});

describe("the Floor: World, City, Crew", () => {
  it("City shows from 10 neighbours, Crew from 3 crewmates; the Vibe Gap is City minus World", async () => {
    const t = fresh();
    const f = feed();
    const m = f.add(t, { price: 10 });
    await pollOdds(db, f.provider, { now: new Date(t) });
    const id = await idOf(m.externalId);
    const people = await Promise.all(Array.from({ length: 10 }, () => makeResident(db)));
    await pon(people);
    await createCrew(db, people[0]!, { name: `Floor ${randomUUID().slice(0, 6)}` });
    for (const u of people.slice(1, 3)) await redeemInvite(db, u, (await createInvite(db, people[0]!)).code);
    for (const [i, u] of people.entries()) await makeCall(db, u, { marketId: id, side: "yes", chance: 55 + i, seenPrice: 10 }, { now: new Date(t + 1000) });
    // A caller without Proof of Neighbour never moves the City bar.
    await makeCall(db, await makeResident(db), { marketId: id, side: "yes", chance: 99, seenPrice: 10 }, { now: new Date(t + 1000) });
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    const v = await marketView(db, people[0]!, id, { now: new Date(t + 2 * MIN) });
    expect(v).toMatchObject({ world: 10, city: 60, crew: 56, vibeGap: 50, blurred: false, counts: { city: 10, crew: 3 } });
    expect(v.mine).toMatchObject({ side: "yes", chance: 55, status: "locked" });
    // A crewmate leaves: 2 left, so the Crew bar goes quiet.
    const { leaveCrew } = await import("../src");
    await leaveCrew(db, people[2]!);
    expect(await marketView(db, people[0]!, id, { now: new Date(t + 2 * MIN) })).toMatchObject({ crew: null, counts: { crew: 2 } });
    // Below the thresholds the bars stay empty.
    const loner = await makeResident(db);
    const m2 = f.add(t);
    await pollOdds(db, f.provider, { now: new Date(t + 3 * MIN) });
    const id2 = await idOf(m2.externalId);
    for (const u of people.slice(0, 9)) await makeCall(db, u, { marketId: id2, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + 4 * MIN) });
    await pollOdds(db, f.provider, { now: new Date(t + 5 * MIN) });
    expect(await marketView(db, loner, id2, { now: new Date(t + 6 * MIN) })).toMatchObject({ city: null, crew: null, vibeGap: null });
  });

  it("Lock to see: on the Slate the crowd is blurred until you lock; Chart-brain hides it too", async () => {
    const t = fresh();
    const f = feed();
    const m = f.add(t);
    await pollOdds(db, f.provider, { now: new Date(t) });
    const id = await idOf(m.externalId);
    const slate = { onSlate: async () => true };
    const people = await Promise.all(Array.from({ length: 10 }, () => makeResident(db)));
    await pon(people);
    for (const u of people) await makeCall(db, u, { marketId: id, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + 1000), ...slate });
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    const me = await makeResident(db);
    expect(await marketView(db, me, id, { now: new Date(t + 2 * MIN), ...slate })).toMatchObject({ blurred: true, city: null, counts: null });
    expect(await marketView(db, people[0]!, id, { now: new Date(t + 2 * MIN), ...slate })).toMatchObject({ blurred: false, city: 70 });
    const brain = people[1]!;
    for (let k = 0; k <= 100; k++) await touchActivity(db, brain, { now: new Date(t + 2 * MIN + k * MIN) });
    expect(await marketView(db, brain, id, { now: new Date(t + 102 * MIN) })).toMatchObject({ blurred: true, city: null });
  });
});

describe("database guards (bypassing app code)", () => {
  it("no edits to a locked call, no deletes, locks only at a real tick of the same market, final markets stay final", async () => {
    const t = fresh();
    const f = feed();
    const [m, other] = [f.add(t), f.add(t, { price: 30 })];
    await pollOdds(db, f.provider, { now: new Date(t) });
    const id = await idOf(m.externalId);
    const u = await makeResident(db);
    const c = await makeCall(db, u, { marketId: id, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + 1000) });
    const [otherTick] = await client`SELECT id FROM market_ticks WHERE market_id = ${await idOf(other.externalId)}`;
    await expect(client`UPDATE calls SET status = 'locked', tick_id = ${otherTick!.id}, locked_price = 30, locked_at = now() WHERE id = ${c.id}`).rejects.toThrow(/real tick/);
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    await expect(client`UPDATE calls SET side = 'no', chance = 30 WHERE id = ${c.id}`).rejects.toThrow(/never edited/);
    await expect(client`UPDATE calls SET locked_price = 99 WHERE id = ${c.id}`).rejects.toThrow();
    await expect(client`DELETE FROM calls WHERE id = ${c.id}`).rejects.toThrow(/never deleted/);
    await client`UPDATE calls SET aura_centi = 100 WHERE id = ${c.id}`;
    await expect(client`UPDATE calls SET aura_centi = 9999 WHERE id = ${c.id}`).rejects.toThrow(/once/);
    await expect(client`INSERT INTO calls (user_id, market_id, side, chance, seen_price, status, created_at) VALUES (${u}, ${await idOf(other.externalId)}, 'yes', 60, 30, 'locked', now())`).rejects.toThrow();
    await expect(client`UPDATE market_ticks SET price = 99 WHERE market_id = ${id}`).rejects.toThrow(/never changed/);
    await client`UPDATE markets SET status = 'resolved', outcome = true WHERE id = ${id}`;
    await expect(client`UPDATE markets SET outcome = false WHERE id = ${id}`).rejects.toThrow(/final/);
    await expect(client`DELETE FROM markets WHERE id = ${id}`).rejects.toThrow();
  });
});

describe("settling, receipts and the Right List", () => {
  const fren = async (x: string, y: string) => {
    const [p, q] = x < y ? [x, y] : [y, x];
    await client`INSERT INTO frens (a, b) VALUES (${p}, ${q})`;
  };

  it("scores every locked call once: Aura exact, a Tail scores 0, a voided market scores nobody", async () => {
    const t = fresh();
    const f = feed();
    const m = f.add(t);
    const v = f.add(t);
    await pollOdds(db, f.provider, { now: new Date(t) });
    const [id, vid] = [await idOf(m.externalId), await idOf(v.externalId)];
    const [a, b, c] = [await makeResident(db), await makeResident(db), await makeResident(db)];
    await fren(a, c);
    const ca = await makeCall(db, a, { marketId: id, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + 1000) });
    const cb = await makeCall(db, b, { marketId: id, side: "no", chance: 30, seenPrice: 50 }, { now: new Date(t + 1000) });
    const cv = await makeCall(db, b, { marketId: vid, side: "no", chance: 30, seenPrice: 50 }, { now: new Date(t + 1000) });
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    const cc = await makeCall(db, c, { marketId: id, via: "tail", viaUserId: a, chance: 90, seenPrice: 50 }, { now: new Date(t + 2 * MIN) });
    await pollOdds(db, f.provider, { now: new Date(t + 3 * MIN) });
    m.resolved = true;
    v.voided = true;
    const r = await pollOdds(db, f.provider, { now: new Date(t + 12 * H) });
    expect(r).toMatchObject({ settled: 3 });
    expect((await callRow(ca.id)).aura_centi).toBe(1600);
    expect((await callRow(cb.id)).aura_centi).toBe(-2400);
    expect((await callRow(cc.id)).aura_centi).toBe(0);
    expect((await callRow(cv.id)).aura_centi).toBeNull();
    expect((await settleCalls(db, { now: new Date(t + 13 * H) })).settled).toBe(0);
    // The Tail's receipt never shows Aura.
    expect((await receipt(db, cc.id, { now: new Date(t + 2 * D) }))!.aura).toBeNull();
    expect((await receipt(db, ca.id, { now: new Date(t + 2 * D) }))!.aura).toBe(16);
  });

  it("a call in the last 30 minutes settles at half", async () => {
    const t = fresh();
    const f = feed();
    const m = f.add(t);
    await pollOdds(db, f.provider, { now: new Date(t + 10 * H - 25 * MIN) });
    const id = await idOf(m.externalId);
    const u = await makeResident(db);
    const c = await makeCall(db, u, { marketId: id, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + 10 * H - 24 * MIN) });
    await pollOdds(db, f.provider, { now: new Date(t + 10 * H - 23 * MIN) });
    m.resolved = true;
    await pollOdds(db, f.provider, { now: new Date(t + 12 * H) });
    expect((await callRow(c.id)).aura_centi).toBe(800);
  });

  it("racing settlers score each call exactly once", async () => {
    const t = fresh();
    const f = feed();
    const m = f.add(t);
    await pollOdds(db, f.provider, { now: new Date(t) });
    const id = await idOf(m.externalId);
    const us = await Promise.all(Array.from({ length: 8 }, () => makeResident(db)));
    for (const u of us) await makeCall(db, u, { marketId: id, side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(t + 1000) });
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    await client`UPDATE markets SET status = 'resolved', outcome = false, resolved_at = ${new Date(t + 12 * H).toISOString()} WHERE id = ${id}`;
    const res = await Promise.all(Array.from({ length: 4 }, () => settleCalls(db)));
    expect(res.reduce((a, r) => a + r.settled, 0)).toBe(8);
  });

  it("your streak grows with your first locked call of the day", async () => {
    const t = fresh();
    const f = feed();
    const ms = [f.add(t), f.add(t)];
    await pollOdds(db, f.provider, { now: new Date(t) });
    const u = await makeResident(db);
    for (const m of ms) await makeCall(db, u, { marketId: await idOf(m.externalId), side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(t + 1000) });
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    const [s] = await client`SELECT current, last_day FROM streaks WHERE user_id = ${u}`;
    expect(s).toMatchObject({ current: 1, last_day: new Date(t).toISOString().slice(0, 10) });
  });

  it("a receipt is sealed until the bell, then stamped; a Tail's shows no Aura; only locked calls have one", async () => {
    const t = fresh();
    const f = feed();
    const m = f.add(t);
    await pollOdds(db, f.provider, { now: new Date(t) });
    const id = await idOf(m.externalId);
    const [a, b] = [await makeResident(db), await makeResident(db)];
    const ca = await makeCall(db, a, { marketId: id, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + 1000) });
    const cb = await makeCall(db, b, { marketId: id, side: "no", chance: 30, seenPrice: 50 }, { now: new Date(t + 1000) });
    expect(await receipt(db, ca.id, { now: new Date(t + 2000) })).toBeNull(); // still pending
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    m.resolved = true;
    const settledAt = new Date(t + 12 * H); // 21:00 UTC
    await pollOdds(db, f.provider, { now: settledAt });
    const sealed = await receipt(db, ca.id, { now: new Date(settledAt.getTime() + H) });
    expect(sealed).toMatchObject({ stamp: "IN THE MEMPOOL", aura: null, side: "yes", chance: 70, world: 50, city: null });
    expect(sealed!.bellAt.toISOString()).toBe(new Date(t + D - 9 * H).toISOString()); // the next 00:00 UTC
    const after = new Date(t + D);
    expect(await receipt(db, ca.id, { now: after })).toMatchObject({ stamp: "CALLED IT", aura: 16 });
    expect(await receipt(db, cb.id, { now: after })).toMatchObject({ stamp: "REKT", aura: -24 });
    const json = JSON.stringify(await receipt(db, ca.id, { now: after }));
    expect(json).not.toMatch(/wallet|usdc|amount|real/i);
  });

  it("the Right List: 10 settled to appear, steady beats a hot streak, revealed results only, rusty after 14 days", async () => {
    const t = fresh();
    const f = feed();
    const ms = Array.from({ length: 13 }, () => f.add(t, { freezesAt: new Date(t + 2 * H), settlesBy: new Date(t + 3 * H) }));
    await pollOdds(db, f.provider, { now: new Date(t) });
    const ids = await Promise.all(ms.map((m) => idOf(m.externalId)));
    const [steady, few, meh] = [await makeResident(db), await makeResident(db), await makeResident(db)];
    await pon([steady, few, meh]);
    const topUp = (u: string) => client`INSERT INTO tickets (user_id, balance, as_of) VALUES (${u}, 9, ${new Date(t).toISOString().slice(0, 10)}) ON CONFLICT (user_id) DO UPDATE SET balance = 9`;
    // steady: 12 calls at YES 60 (all YES); few: 3 calls at YES 99
    await client`UPDATE tickets SET balance = 9 WHERE user_id = ${steady}`;
    for (const [i, id] of ids.entries()) {
      if (i % 3 === 0) {
        await topUp(steady);
        await topUp(meh);
      }
      if (i < 12) await makeCall(db, steady, { marketId: id, side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(t + 1000) });
      if (i >= 2) await makeCall(db, meh, { marketId: id, side: "yes", chance: 52, seenPrice: 50 }, { now: new Date(t + 1000) });
      if (i < 3) await makeCall(db, few, { marketId: id, side: "yes", chance: 99, seenPrice: 50 }, { now: new Date(t + 1000) });
    }
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    // steady tails meh on the 13th market: a Tail never counts on the Right List.
    const [p, q] = steady < meh ? [steady, meh] : [meh, steady];
    await client`INSERT INTO frens (a, b) VALUES (${p}, ${q})`;
    await topUp(steady);
    await makeCall(db, steady, { marketId: ids[12], via: "tail", viaUserId: meh, chance: 60, seenPrice: 50 }, { now: new Date(t + 2 * MIN) });
    await pollOdds(db, f.provider, { now: new Date(t + 3 * MIN) });
    for (const m of ms) m.resolved = true;
    await pollOdds(db, f.provider, { now: new Date(t + 4 * H) });
    expect((await rightList(db, { now: new Date(t + 5 * H), userId: steady })).me).toBeNull(); // not revealed before the bell
    const after = await rightList(db, { now: new Date(t + D), userId: steady });
    expect(after.me).toMatchObject({ settled: 12, rusty: false });
    expect(after.me!.perCall).toBeCloseTo((12 * 900) / 27 / 100, 6); // +9 a call over 12+15
    expect(after.rows.some((r) => r.userId === few)).toBe(false); // 3 settled isn't enough
    expect(after.rows.find((r) => r.userId === steady)!.handle).toBeTruthy();
    const order = after.rows.filter((r) => r.userId === steady || r.userId === meh).map((r) => r.userId);
    expect(order).toEqual([steady, meh]); // +9 a call beats +1.96
    expect(after.rows.find((r) => r.userId === meh)!.rank).toBeGreaterThan(after.me!.rank);
    // Without Proof of Neighbour you're not on the Aura boards.
    await client`UPDATE users SET proof_of_neighbour_at = NULL WHERE id = ${meh}`;
    expect((await rightList(db, { now: new Date(t + D) })).rows.some((r) => r.userId === meh)).toBe(false);
    const later = await rightList(db, { now: new Date(t + 20 * D), season: after.season, userId: steady });
    expect(later.me).toMatchObject({ settled: 12, rusty: true }); // still listed, marked rusty
  });

  it("the Receipt Binder: your 9 best CALLED ITs of the season, by Aura, revealed only, never a Tail or a REKT", async () => {
    const t = fresh();
    const f = feed();
    const ms = Array.from({ length: 13 }, (_, i) => f.add(t, { question: `Q${i}?`, freezesAt: new Date(t + 2 * H), settlesBy: new Date(t + 3 * H) }));
    await pollOdds(db, f.provider, { now: new Date(t) });
    const ids = await Promise.all(ms.map((m) => idOf(m.externalId)));
    const [me, fren] = [await makeResident(db), await makeResident(db)];
    await pon([me, fren]);
    const topUp = (u: string) => client`INSERT INTO tickets (user_id, balance, as_of) VALUES (${u}, 9, ${new Date(t).toISOString().slice(0, 10)}) ON CONFLICT (user_id) DO UPDATE SET balance = 9`;
    // 12 YES calls, more sure each time (more Aura when right); market 12 is a Tail of my fren.
    for (const [i, id] of ids.slice(0, 12).entries()) {
      if (i % 3 === 0) {
        await topUp(me);
        await topUp(fren);
      }
      await makeCall(db, me, { marketId: id, side: "yes", chance: 55 + i * 3, seenPrice: 50 }, { now: new Date(t + 1000) });
    }
    await makeCall(db, fren, { marketId: ids[12]!, side: "yes", chance: 95, seenPrice: 50 }, { now: new Date(t + 1000) });
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    const [p, q] = me < fren ? [me, fren] : [fren, me];
    await client`INSERT INTO frens (a, b) VALUES (${p}, ${q})`;
    await topUp(me);
    await makeCall(db, me, { marketId: ids[12]!, via: "tail", viaUserId: fren, chance: 95, seenPrice: 50 }, { now: new Date(t + 2 * MIN) });
    // My fren: one right (12), one REKT (1), and a Tail of me (0). Only the right one belongs in a binder.
    await topUp(fren);
    await makeCall(db, fren, { marketId: ids[1]!, side: "yes", chance: 90, seenPrice: 50 }, { now: new Date(t + 2 * MIN) });
    await makeCall(db, fren, { marketId: ids[0]!, via: "tail", viaUserId: me, chance: 95, seenPrice: 50 }, { now: new Date(t + 2 * MIN) });
    await pollOdds(db, f.provider, { now: new Date(t + 3 * MIN) });
    // Markets 1 and 4 resolve NO (REKT); the rest, and the tailed one, YES.
    ms.forEach((m, i) => (m.resolved = i !== 1 && i !== 4));
    await pollOdds(db, f.provider, { now: new Date(t + 4 * H) });

    expect((await receiptBinder(db, me, { now: new Date(t + 5 * H) })).receipts).toEqual([]); // sealed until the bell
    const { receipts } = await receiptBinder(db, me, { now: new Date(t + D) });
    expect(receipts).toHaveLength(9);
    // The surest right calls first: markets 11 down to 3 (1 and 4 were REKT; the tail never counts).
    expect(receipts.map((r) => r.question)).toEqual(["Q11?", "Q10?", "Q9?", "Q8?", "Q7?", "Q6?", "Q5?", "Q3?", "Q2?"]);
    expect(receipts.every((r) => r.aura > 0)).toBe(true);
    for (let i = 1; i < receipts.length; i++) expect(receipts[i - 1]!.aura).toBeGreaterThanOrEqual(receipts[i]!.aura);
    expect(JSON.stringify(receipts)).not.toMatch(/wallet|usdc|amount|real/i);
    // Someone else's binder isn't mine, and holds no REKT and no Tail even with room to spare.
    expect((await receiptBinder(db, fren, { now: new Date(t + D) })).receipts.map((r) => r.question)).toEqual(["Q12?"]);
  });
});

describe("streak days and the poll", () => {
  // Waits until `n` sessions are queued on a row lock.
  async function lockWaiters(n: number) {
    const deadline = Date.now() + 10_000;
    // loop-bound: gives up after 10 seconds
    for (;;) {
      const [row] = await client`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (row!.n >= n) return;
      if (Date.now() > deadline) throw new Error(`only ${row!.n}/${n} sessions are waiting on a lock`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  const settle = <T,>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

  it("a gm and the poll minting on the same shard can't deadlock: streak days are granted after the poll commits", async () => {
    const t = fresh();
    const f = feed();
    const [mx, my] = [f.add(t), f.add(t)];
    await pollOdds(db, f.provider, { now: new Date(t) });
    // Two residents whose GM is minted from the same shard.
    const byShard = new Map<string, string>();
    let pair: [string, string] | null = null;
    for (let i = 0; i < 200 && !pair; i++) {
      const u = await makeResident(db);
      const shard = mintAccountFor(userAccountId(u));
      const other = byShard.get(shard);
      if (other) pair = [other, u];
      else byShard.set(shard, u);
    }
    const [x, y] = pair!;
    await makeCall(db, x, { marketId: await idOf(mx.externalId), side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(t + 1000) });
    await makeCall(db, y, { marketId: await idOf(my.externalId), side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(t + 1000) });
    // Hold y's resident row. y's gm queues on it first; then the poll locks x's
    // call (x's streak mint used to take the shard here) and reaches y's.
    const at = new Date(t + MIN);
    const barrier = await client.reserve();
    await barrier`BEGIN`;
    await barrier`SELECT 1 FROM users WHERE id = ${y} FOR UPDATE`;
    let gm: ReturnType<typeof settle<Awaited<ReturnType<typeof sayGm>>>>;
    let poll: ReturnType<typeof settle<Awaited<ReturnType<typeof pollOdds>>>>;
    try {
      gm = settle(sayGm(db, y, { now: at }));
      await lockWaiters(1);
      poll = settle(pollOdds(db, f.provider, { now: at }));
      await lockWaiters(2);
    } finally {
      await barrier`COMMIT`;
      barrier.release();
    }
    const [g, p] = await Promise.all([gm, poll]);
    expect(g.ok ? "ok" : String((g.e as { cause?: { code?: string } })?.cause?.code ?? g.e)).toBe("ok");
    expect(p.ok ? "ok" : String((p.e as { cause?: { code?: string } })?.cause?.code ?? p.e)).toBe("ok");
    expect(p).toMatchObject({ v: { locked: 2 } });
    const day = new Date(t).toISOString().slice(0, 10);
    for (const u of [x, y]) expect((await client`SELECT current, last_day FROM streaks WHERE user_id = ${u}`)[0]).toMatchObject({ current: 1, last_day: day });
    expect(await client`SELECT 1 FROM daily_gm WHERE user_id = ${y} AND city_day = ${day}`).toHaveLength(1);
  });

  it("a streak day whose grant fails after the poll commits is granted by the next poll", async () => {
    const t = fresh();
    const f = feed();
    const [mx, my] = [f.add(t), f.add(t)];
    await pollOdds(db, f.provider, { now: new Date(t) });
    const [x, y] = [await makeResident(db), await makeResident(db)];
    await makeCall(db, x, { marketId: await idOf(mx.externalId), side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(t + 1000) });
    await makeCall(db, y, { marketId: await idOf(my.externalId), side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(t + 1000) });
    // y's streak row is held, and this poll gives up on a lock after 200 ms,
    // so y's grant fails once the poll has locked both calls and committed.
    await client`INSERT INTO streaks (user_id) VALUES (${y}) ON CONFLICT DO NOTHING`;
    const impatient = createDb(process.env.TEST_DATABASE_URL!, { max: 2, connection: { lock_timeout: 200 } });
    const barrier = await client.reserve();
    await barrier`BEGIN`;
    await barrier`SELECT 1 FROM streaks WHERE user_id = ${y} FOR UPDATE`;
    let first: Awaited<ReturnType<typeof settle<Awaited<ReturnType<typeof pollOdds>>>>>;
    try {
      first = await settle(pollOdds(impatient.db, f.provider, { now: new Date(t + MIN) }));
    } finally {
      await barrier`COMMIT`;
      barrier.release();
      await impatient.close();
    }
    expect(first.ok ? "ok" : String((first.e as { cause?: { code?: string } })?.cause?.code ?? first.e)).toBe("55P03"); // lock_not_available
    expect((await client`SELECT status FROM calls WHERE user_id IN ${client([x, y])}`).map((r) => r.status)).toEqual(["locked", "locked"]);
    const day = new Date(t).toISOString().slice(0, 10);
    const streak = async (u: string) => (await client`SELECT current, last_day FROM streaks WHERE user_id = ${u}`)[0];
    expect(await streak(x)).toMatchObject({ current: 1, last_day: day });
    expect(await streak(y)).toMatchObject({ current: 0, last_day: null });

    // The next poll has nothing new to lock, and grants y's day all the same.
    await pollOdds(db, f.provider, { now: new Date(t + 2 * MIN) });
    expect(await streak(y)).toMatchObject({ current: 1, last_day: day });
    expect(await client`SELECT 1 FROM gm_transactions WHERE idempotency_key = ${`streak_bonus:${y}:${day}`}`).toHaveLength(1);
    expect(await client`SELECT 1 FROM streak_grants WHERE user_id IN ${client([x, y])}`).toHaveLength(0);
  });

  it("an owed streak day that a later day has already passed is dropped, not retried by every poll", async () => {
    const t = fresh();
    const f = feed();
    f.add(t);
    const u = await makeResident(db);
    const [day, next] = [new Date(t).toISOString().slice(0, 10), new Date(t + D).toISOString().slice(0, 10)];
    // A day owed from a poll whose grant never ran, after the next day counted.
    await client`INSERT INTO streaks (user_id) VALUES (${u}) ON CONFLICT DO NOTHING`;
    await client`UPDATE streaks SET current = 1, longest = 1, last_day = ${next} WHERE user_id = ${u}`;
    await client`INSERT INTO streak_grants (user_id, city_day) VALUES (${u}, ${day})`;
    expect(await pollOdds(db, f.provider, { now: new Date(t + D + MIN) })).toMatchObject({ ok: true });
    expect((await client`SELECT current, last_day FROM streaks WHERE user_id = ${u}`)[0]).toMatchObject({ current: 1, last_day: next });
    expect(await client`SELECT 1 FROM streak_grants WHERE user_id = ${u}`).toHaveLength(0);
  });

  it("a resident's owed days count in order: while an earlier one fails, a later one waits", async () => {
    const t = fresh();
    const u = await makeResident(db);
    const [day, next] = [new Date(t).toISOString().slice(0, 10), new Date(t + D).toISOString().slice(0, 10)];
    await client`INSERT INTO streak_grants (user_id, city_day) VALUES (${u}, ${day}), (${u}, ${next})`;
    // The earlier day's note is held, so its grant (which clears the note) gives up.
    const impatient = createDb(process.env.TEST_DATABASE_URL!, { max: 2, connection: { lock_timeout: 200 } });
    const barrier = await client.reserve();
    await barrier`BEGIN`;
    await barrier`SELECT 1 FROM streak_grants WHERE user_id = ${u} AND city_day = ${day} FOR UPDATE`;
    let failed: Awaited<ReturnType<typeof grantOwedStreakDays>>;
    try {
      failed = await grantOwedStreakDays(impatient.db);
    } finally {
      await barrier`COMMIT`;
      barrier.release();
      await impatient.close();
    }
    expect(String((failed?.e as { cause?: { code?: string } })?.cause?.code)).toBe("55P03");
    expect((await client`SELECT current FROM streaks WHERE user_id = ${u}`)[0]).toMatchObject({ current: 0 });
    // Next time both count, the earlier first.
    expect(await grantOwedStreakDays(db)).toBeNull();
    expect((await client`SELECT current, last_day FROM streaks WHERE user_id = ${u}`)[0]).toMatchObject({ current: 2, last_day: next });
    expect((await client`SELECT city_day FROM streak_days WHERE user_id = ${u} ORDER BY city_day`).map((r) => r.city_day)).toEqual([day, next]);
  });
});

// The live provider on real Gamma payloads (recorded 2026-10-11, see
// packages/core/test/fixtures), driven through pollOdds to settlement.
describe("the live Polymarket feed, on recorded Gamma payloads", () => {
  const fixture = <T,>(name: string): T => JSON.parse(readFileSync(join(__dirname, "..", "..", "core", "test", "fixtures", name), "utf8")) as T;
  const listing: Record<string, GammaEvent[]> = { crypto: fixture("gamma-events-crypto.json"), sports: fixture("gamma-events-sports.json") };
  const market = (k: string) => fixture<GammaMarket[]>(`gamma-market-${k}.json`)[0]!;
  const [resolvedYes, resolvedNo, voided, proposed] = [market("resolved-yes"), market("resolved-no"), market("void"), market("proposed")];
  const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

  it("live markets lock, then settle as Gamma reports them: YES scores, a 50/50 voids, a proposed result waits until it resolves", async () => {
    const at = Date.parse("2026-10-11T19:00:00Z"); // when the payloads were recorded
    // Gamma as recorded, plus whatever has closed since: a closed market shows
    // up closed in its event, and in /markets?closed=true&id=...
    const closed = new Map<string, GammaMarket>();
    const gamma = (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/events") return ok((listing[u.searchParams.get("tag_slug")!] ?? []).map((e) => ({ ...e, markets: (e.markets ?? []).map((m) => closed.get(m.id) ?? m) })));
      return ok(u.searchParams.getAll("id").flatMap((id) => (closed.has(id) ? [closed.get(id)!] : [])));
    };
    const provider = polymarketProvider({ fetch: gamma, log: () => {} });
    expect(await pollOdds(db, provider, { now: new Date(at) })).toMatchObject({ ok: true, ticked: 8 });
    const row = async (ext: string) => (await client`SELECT id, price, status, outcome FROM markets WHERE source = 'polymarket' AND external_id = ${ext}`)[0]!;
    const [btc, reach, margin] = [await row("pm:5330080"), await row("pm:5170735"), await row("pm:5304665")];
    expect([btc.price, reach.price, margin.price]).toEqual([46, 57, 34]);
    const [a, b, c] = [await makeResident(db), await makeResident(db), await makeResident(db)];
    const ca = await makeCall(db, a, { marketId: btc.id, side: "yes", chance: 70, seenPrice: 46 }, { now: new Date(at + 1000) });
    const cb = await makeCall(db, b, { marketId: reach.id, side: "no", chance: 40, seenPrice: 57 }, { now: new Date(at + 1000) });
    const cc = await makeCall(db, c, { marketId: margin.id, side: "yes", chance: 50, seenPrice: 34 }, { now: new Date(at + 1000) });
    await pollOdds(db, provider, { now: new Date(at + MIN) });
    for (const x of [ca, cb, cc]) expect((await callRow(x.id)).status).toBe("locked");
    expect(await marketView(db, a, btc.id, { now: new Date(at + MIN) })).toMatchObject({ source: "Odds via Polymarket · Not affiliated" });
    expect((await feedStatus(db, { now: new Date(at + MIN) })).credit).toBe("Odds via Polymarket · Not affiliated");

    // They close: Gamma's records of a market that resolved YES, a fight
    // cancelled and paid 50/50, and a result still proposed, for the three.
    closed.set("5330080", { ...resolvedYes, id: "5330080" });
    closed.set("5170735", { ...voided, id: "5170735" });
    closed.set("5304665", { ...proposed, id: "5304665" });
    expect(await pollOdds(db, provider, { now: new Date(at + 2 * MIN) })).toMatchObject({ ok: true, settled: 1 });
    expect(await row("pm:5330080")).toMatchObject({ status: "resolved", outcome: true });
    expect(await row("pm:5170735")).toMatchObject({ status: "void", outcome: null });
    expect(await row("pm:5304665")).toMatchObject({ status: "frozen", outcome: null });
    expect((await callRow(ca.id)).aura_centi).toBe(auraCenti(true, 46, 70));
    expect((await callRow(cb.id)).aura_centi).toBeNull();
    expect((await callRow(cc.id)).aura_centi).toBeNull();

    // Polls later, UMA settles the proposed one NO: now it scores.
    await pollOdds(db, provider, { now: new Date(at + 3 * MIN) });
    expect(await row("pm:5304665")).toMatchObject({ status: "frozen" });
    closed.set("5304665", { ...resolvedNo, id: "5304665" });
    expect(await pollOdds(db, provider, { now: new Date(at + 4 * MIN) })).toMatchObject({ ok: true, settled: 1 });
    expect(await row("pm:5304665")).toMatchObject({ status: "resolved", outcome: false });
    expect((await callRow(cc.id)).aura_centi).toBe(auraCenti(false, 34, 50));
  });

  it("a Slate card the listing drops stays callable at its live price; one Gamma stops trading goes dark, for the cast too", async () => {
    // A day of its own, far from the other tests' Slates.
    const at = Date.UTC(2040, 0, 1 + Math.floor(Math.random() * 3000), 9);
    const tag = String(Math.floor(Math.random() * 1e9));
    const gm = (id: string, yes: string, extra: Record<string, unknown> = {}) => ({
      id,
      question: `Will ${id} happen?`,
      outcomes: '["Yes", "No"]',
      outcomePrices: `["${yes}", "${(1 - Number(yes)).toFixed(2)}"]`,
      endDate: new Date(at + 20 * H).toISOString(),
      closed: false,
      acceptingOrders: true,
      ...extra,
    });
    const [card, other, filler] = [`${tag}1`, `${tag}2`, `${tag}3`];
    // What the listing shows, and what /markets?closed=false&id=... answers.
    let listed = [gm(card, "0.46"), gm(other, "0.5"), gm(filler, "0.5")];
    const trading = new Map([[card, gm(card, "0.40")], [other, gm(other, "0.5")]]);
    const gamma = (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/events") return ok(u.searchParams.get("tag_slug") === "crypto" ? listed.map((m) => ({ slug: `e${m.id}`, markets: [m] })) : []);
      if (u.searchParams.get("closed") === "false") return ok(u.searchParams.getAll("id").flatMap((id) => (trading.has(id) ? [trading.get(id)!] : [])));
      return ok([]);
    };
    const provider = polymarketProvider({ fetch: gamma, log: () => {} });
    await pollOdds(db, provider, { now: new Date(at) });
    const row = async (ext: string) => (await client`SELECT id, price, status, in_feed FROM markets WHERE source = 'polymarket' AND external_id = ${`pm:${ext}`}`)[0]!;
    const [cardRow, otherRow] = [await row(card), await row(other)];
    const day = cityDay(new Date(at));
    await client`INSERT INTO slates (city_day, modifier, published_at) VALUES (${day}, 'none', ${new Date(at).toISOString()})`;
    await client`INSERT INTO slate_cards (city_day, slot, tier, market_id) VALUES (${day}, 1, 'coin_flip', ${cardRow.id}), (${day}, 2, 'coin_flip', ${otherRow.id})`;

    // The ladder moves on: the listing drops both. The card is looked up by
    // id and carried at its trading price; so is the other card.
    listed = [gm(filler, "0.5")];
    await pollOdds(db, provider, { now: new Date(at + MIN) });
    expect(await row(card)).toMatchObject({ price: 40, status: "open", in_feed: true });
    const u = await makeResident(db);
    const c = await makeCall(db, u, { marketId: cardRow.id, side: "yes", chance: 60, seenPrice: 40 }, { now: new Date(at + MIN + 1000) });
    await pollOdds(db, provider, { now: new Date(at + 2 * MIN) });
    expect(await callRow(c.id)).toMatchObject({ status: "locked", locked_price: 40 });

    // Gamma stops taking orders on the other card: off the feed, and nobody
    // (the cast included) calls it at the stale price.
    trading.set(other, gm(other, "0.5", { acceptingOrders: false }));
    await pollOdds(db, provider, { now: new Date(at + 3 * MIN) });
    expect(await row(other)).toMatchObject({ status: "open", in_feed: false });
    await npcCalls(db, { now: new Date(at + 3 * MIN + 1000) });
    expect(await client`SELECT 1 FROM calls WHERE market_id = ${otherRow.id}`).toHaveLength(0);
    expect(await client`SELECT 1 FROM calls WHERE market_id = ${cardRow.id} AND user_id <> ${u}`).not.toHaveLength(0); // the carried card it does call
    const slate = await todaySlate(db, u, { now: new Date(at + 3 * MIN + 1000) });
    expect(slate!.credit).toBe("Odds via Polymarket · Not affiliated");
    expect(slate!.cards.map((x) => [x.marketId, x.open])).toEqual([
      [cardRow.id, true],
      [otherRow.id, false],
    ]);
    expect(await marketView(db, u, otherRow.id, { now: new Date(at + 3 * MIN + 1000) })).toMatchObject({ status: "open", inFeed: false });
  });

  it("after a switch of feed, the old feed's markets leave the Floor and freeze on time", async () => {
    const t = fresh();
    const [old, next] = [feed(), feed()];
    const oldProvider: OddsProvider = { source: `old-${randomUUID().slice(0, 8)}`, fetch: (n) => old.provider.fetch(n) };
    const nextProvider: OddsProvider = { source: `next-${randomUUID().slice(0, 8)}`, fetch: (n) => next.provider.fetch(n) };
    const soon = old.add(t, { freezesAt: new Date(t + 2 * MIN), settlesBy: new Date(t + H) });
    const later = old.add(t);
    next.add(t);
    await pollOdds(db, oldProvider, { now: new Date(t) });
    const [soonId, laterId] = [await idOf(soon.externalId), await idOf(later.externalId)];
    // ODDS_SOURCE changes: only the new feed polls from now on.
    await pollOdds(db, nextProvider, { now: new Date(t + MIN) });
    expect((await client`SELECT in_feed FROM markets WHERE id = ${laterId}`)[0]!.in_feed).toBe(false);
    expect((await openMarkets(db, { now: new Date(t + MIN) })).map((m) => m.id)).not.toContain(laterId);
    const u = await makeResident(db);
    expect(await code(makeCall(db, u, { marketId: laterId, side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(t + MIN + 1000) }))).toBe("MARKET_CLOSED");
    await pollOdds(db, nextProvider, { now: new Date(t + 3 * MIN) });
    expect((await client`SELECT status FROM markets WHERE id = ${soonId}`)[0]!.status).toBe("frozen");
  });

  it("tells the feed which markets something rides on, and which must stay live", async () => {
    const f = feed();
    let known: readonly KnownMarket[] = [];
    const provider: OddsProvider = { source: `riding-${randomUUID().slice(0, 8)}`, fetch: async (now, k = []) => ((known = k), f.provider.fetch(now)) };
    const t = Date.UTC(2045, 0, 1 + Math.floor(Math.random() * 3000), 9); // a day with no other Slate
    const [quiet, pending, locked, slated] = [f.add(t), f.add(t), f.add(t), f.add(t)];
    await pollOdds(db, provider, { now: new Date(t) });
    const u = await makeResident(db);
    await makeCall(db, u, { marketId: await idOf(locked.externalId), side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(t + 1000) });
    await pollOdds(db, provider, { now: new Date(t + MIN) }); // locks it
    await makeCall(db, u, { marketId: await idOf(pending.externalId), side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(t + MIN + 1000) });
    const day = cityDay(new Date(t));
    await client`INSERT INTO slates (city_day, modifier, published_at) VALUES (${day}, 'none', ${new Date(t).toISOString()})`;
    await client`INSERT INTO slate_cards (city_day, slot, tier, market_id) VALUES (${day}, 1, 'coin_flip', ${await idOf(slated.externalId)})`;
    // The poll asks about all four, with what rides on each.
    for (const m of [quiet, pending, locked, slated]) f.ms.delete(m.externalId);
    await pollOdds(db, provider, { now: new Date(t + 2 * MIN) });
    const flags = Object.fromEntries(known.map((k) => [k.externalId, [k.held, k.live]]));
    expect(flags[quiet.externalId]).toEqual([false, false]);
    expect(flags[pending.externalId]).toEqual([true, true]);
    expect(flags[locked.externalId]).toEqual([true, false]);
    expect(flags[slated.externalId]).toEqual([true, true]);
  });
});
