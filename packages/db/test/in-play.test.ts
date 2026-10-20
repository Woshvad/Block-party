import { randomUUID } from "node:crypto";
import { type FeedMarket, type KnownMarket, type OddsProvider, TOWER, auraCenti } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TowerError, cityCalls, createCrew, createDb, createInvite, ensureSystemAccounts, inPlayMarkets, inRoom, makeCall, marketView, myTickets, pollOdds, recordVisit, redeemInvite } from "../src";
import { makeResident } from "./helpers";

// The Watch Party Hall's in-play calls: a match keeps a live price after
// kickoff, and a call made in the Hall locks 2 minutes later at the earliest,
// for half the Aura. The market stays frozen for everything else.

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 10 });
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;
let base = new Date("2032-03-01T09:00:00Z").getTime();
const fresh = () => (base += 30 * D);

// A feed whose prices the test sets by hand, and that remembers what it was asked about.
function feed() {
  const ms = new Map<string, FeedMarket>();
  const asked: KnownMarket[][] = [];
  const provider: OddsProvider & { fail?: boolean } = {
    source: "test",
    async fetch(_now, known = []) {
      asked.push([...known]);
      if (provider.fail) throw new Error("feed down");
      return [...ms.values()].map((m) => ({ ...m }));
    },
  };
  // A match kicking off an hour after t, settled two hours later.
  const match = (t: number, over: Partial<FeedMarket> = {}) => {
    const m: FeedMarket = { externalId: randomUUID(), question: "Home side wins?", category: "sports", ladder: null, freezesAt: new Date(t + H), settlesBy: new Date(t + 3 * H), price: 50, resolved: null, voided: false, ...over };
    ms.set(m.externalId, m);
    return m;
  };
  return { provider, ms, asked, match };
}
const idOf = async (ext: string) => (await client`SELECT id FROM markets WHERE external_id = ${ext}`)[0]!.id as string;
const marketRow = async (ext: string) => (await client`SELECT * FROM markets WHERE external_id = ${ext}`)[0]!;
const callRow = async (id: string) => (await client`SELECT * FROM calls WHERE id = ${id}`)[0]!;
const at = (t: number) => ({ now: new Date(t) });
const inHall = (userId: string, t: number) => recordVisit(db, { userId, room: "watch_party#1", event: "start", at: new Date(t) });

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof TowerError) return e.code;
    throw e;
  }
}
async function sqlCode(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("a match in play", () => {
  it("keeps a live price and ticks after kickoff, stays frozen at its kickoff price, and stops when the feed stops carrying it", async () => {
    const t = fresh();
    const f = feed();
    const m = f.match(t);
    await pollOdds(db, f.provider, at(t));
    const k = t + H;
    // Kickoff: the feed now carries it in play, moving.
    m.inPlay = true;
    m.price = 62;
    expect(await pollOdds(db, f.provider, at(k + MIN))).toMatchObject({ ok: true, ticked: 1 });
    let row = await marketRow(m.externalId);
    expect(row).toMatchObject({ status: "frozen", in_feed: false, in_play: true, live_price: 62, price: 50 });
    m.price = 70;
    await pollOdds(db, f.provider, at(k + 2 * MIN));
    expect((await marketRow(m.externalId)).live_price).toBe(70);
    const ticks = await client`SELECT price FROM market_ticks WHERE market_id = ${row.id} ORDER BY id`;
    expect(ticks.map((x) => x.price)).toEqual([50, 62, 70]);
    // Listed for the Hall, at its live price; never on the Floor.
    expect((await inPlayMarkets(db)).find((x) => x.id === row.id)).toMatchObject({ price: 70, question: "Home side wins?" });
    // The feed stops carrying it at all (Polymarket: it stopped trading, and
    // the listing never carries a market past kickoff).
    f.ms.delete(m.externalId);
    await pollOdds(db, f.provider, at(k + 3 * MIN));
    row = await marketRow(m.externalId);
    expect(row).toMatchObject({ status: "frozen", in_play: false, live_price: null, price: 50 });
    expect((await inPlayMarkets(db)).some((x) => x.id === row.id)).toBe(false);
    // Back in play, then carried as plain frozen (a feed that says so): out again.
    f.ms.set(m.externalId, m);
    await pollOdds(db, f.provider, at(k + 4 * MIN));
    expect((await marketRow(m.externalId)).in_play).toBe(true);
    m.inPlay = undefined;
    await pollOdds(db, f.provider, at(k + 5 * MIN));
    expect(await marketRow(m.externalId)).toMatchObject({ status: "frozen", in_play: false, live_price: null });
    // The result lands as ever.
    m.resolved = true;
    await pollOdds(db, f.provider, at(t + 4 * H));
    expect(await marketRow(m.externalId)).toMatchObject({ status: "resolved", in_play: false });
  });

  it("only a match we hold plays on: not crypto, not a ladder, not one the feed opens in play, not before kickoff", async () => {
    const t = fresh();
    const f = feed();
    const coin = f.match(t, { category: "crypto", question: "BTC up?" });
    const rung = f.match(t, { ladder: "goals-ladder" });
    const early = f.match(t, { freezesAt: new Date(t + 5 * H), settlesBy: new Date(t + 6 * H) });
    await pollOdds(db, f.provider, at(t));
    const stranger = f.match(t, { inPlay: true });
    for (const m of [coin, rung, early]) m.inPlay = true;
    await pollOdds(db, f.provider, at(t + H + MIN));
    for (const m of [coin, rung, early]) expect((await marketRow(m.externalId)).in_play).toBe(false);
    expect(await client`SELECT 1 FROM markets WHERE external_id = ${stranger.externalId}`).toHaveLength(0);
  });

  it("asks the feed about matches frozen at kickoff in the last few hours, and nothing else", async () => {
    const t = fresh();
    const f = feed();
    const now = f.match(t);
    const old = f.match(t - 5 * H, { freezesAt: new Date(t - 4 * H - MIN), settlesBy: new Date(t + 3 * H) });
    const coin = f.match(t, { category: "crypto" });
    const rung = f.match(t, { ladder: "goals-ladder" });
    const later = f.match(t, { freezesAt: new Date(t + 5 * H), settlesBy: new Date(t + 6 * H) });
    await pollOdds(db, f.provider, at(t - 5 * H));
    await pollOdds(db, f.provider, at(t + H + MIN));
    await pollOdds(db, f.provider, at(t + H + 2 * MIN));
    const asked = new Map(f.asked.at(-1)!.map((k) => [k.externalId, k.inPlay]));
    expect(asked.get(now.externalId)).toBe(true);
    for (const m of [old, coin, rung, later]) expect(asked.get(m.externalId)).toBe(false);
  });
});

describe("in-play calls in the Watch Party Hall", () => {
  async function kickedOff() {
    const t = fresh();
    const f = feed();
    const m = f.match(t);
    await pollOdds(db, f.provider, at(t));
    const k = t + H;
    m.inPlay = true;
    m.price = 60;
    await pollOdds(db, f.provider, at(k + MIN));
    return { f, m, k, id: await idOf(m.externalId) };
  }

  it("waits 2 minutes, locks on the next tick within 2 points, and scores half the Aura", async () => {
    const { f, m, k, id } = await kickedOff();
    const u = await makeResident(db);
    await inHall(u, k);
    const tickets = (await myTickets(db, u, at(k + MIN))).tickets;
    const made = k + MIN + 5 * S;
    // Even on a Slate card's match: an in-play call is off the Slate, and takes a ticket.
    const c = await makeCall(db, u, { marketId: id, side: "yes", chance: 75, seenPrice: 60, inPlay: true }, { now: new Date(made), onSlate: async () => true });
    expect(c).toMatchObject({ status: "pending", inPlay: true, onSlate: false, ticket: true });
    expect((await myTickets(db, u, at(made))).tickets).toBe(tickets - 1);
    m.price = 61;
    await pollOdds(db, f.provider, at(k + 2 * MIN));
    // A second short of 2 minutes: still waiting.
    await pollOdds(db, f.provider, at(made + TOWER.inPlayDelaySeconds * S - S));
    expect((await callRow(c.id)).status).toBe("pending");
    await pollOdds(db, f.provider, at(made + TOWER.inPlayDelaySeconds * S));
    expect(await callRow(c.id)).toMatchObject({ status: "locked", locked_price: 61, half: true, in_play: true });
    // Full time: YES, scored at half.
    m.inPlay = undefined;
    m.resolved = true;
    await pollOdds(db, f.provider, at(k + 3 * H));
    expect((await callRow(c.id)).aura_centi).toBe(auraCenti(true, 61, 75, true));
  });

  it("the price moved by then: dropped, and the ticket comes back", async () => {
    const { f, m, k, id } = await kickedOff();
    const u = await makeResident(db);
    await inHall(u, k);
    const tickets = (await myTickets(db, u, at(k + MIN))).tickets;
    const made = k + MIN + 5 * S;
    const c = await makeCall(db, u, { marketId: id, side: "no", chance: 40, seenPrice: 60, inPlay: true }, at(made));
    m.price = 70; // a goal
    await pollOdds(db, f.provider, at(made + TOWER.inPlayDelaySeconds * S + S));
    expect((await callRow(c.id)).status).toBe("price_moved");
    expect((await myTickets(db, u, at(made + 3 * MIN))).tickets).toBe(tickets);
  });

  it("the match stops playing before it locks: dropped, ticket back", async () => {
    const { f, m, k, id } = await kickedOff();
    const u = await makeResident(db);
    await inHall(u, k);
    const tickets = (await myTickets(db, u, at(k + MIN))).tickets;
    const c = await makeCall(db, u, { marketId: id, side: "yes", chance: 80, seenPrice: 60, inPlay: true }, at(k + MIN + 5 * S));
    m.inPlay = undefined;
    await pollOdds(db, f.provider, at(k + 2 * MIN));
    expect((await callRow(c.id)).status).toBe("expired");
    expect((await myTickets(db, u, at(k + 3 * MIN))).tickets).toBe(tickets);
  });

  it("a postponed match reopens: a waiting in-play call is dropped, never locked as an ordinary call", async () => {
    const { f, m, k, id } = await kickedOff();
    const u = await makeResident(db);
    await inHall(u, k);
    const c = await makeCall(db, u, { marketId: id, side: "yes", chance: 75, seenPrice: 60, inPlay: true }, at(k + MIN + 5 * S));
    m.inPlay = undefined;
    m.freezesAt = new Date(k + 2 * H);
    m.settlesBy = new Date(k + 4 * H);
    expect(await pollOdds(db, f.provider, at(k + 4 * MIN))).toMatchObject({ ok: true, locked: 0 });
    expect(await marketRow(m.externalId)).toMatchObject({ status: "open", in_feed: true, in_play: false, live_price: null });
    expect((await callRow(c.id)).status).toBe("expired");
  });

  it("refuses: outside the Hall, after leaving it, a Tail, a stale price, a match not in play, a second call, a paused feed", async () => {
    const { f, m, k, id } = await kickedOff();
    const call = (u: string, over: Record<string, unknown> = {}, when = k + MIN + 5 * S) =>
      code(makeCall(db, u, { marketId: id, side: "yes", chance: 75, seenPrice: 60, inPlay: true, ...over }, at(when)));
    const away = await makeResident(db);
    const tickets = (await myTickets(db, away, at(k))).tickets;
    expect(await call(away)).toBe("NOT_IN_HALL");
    expect((await myTickets(db, away, at(k + 2 * MIN))).tickets).toBe(tickets);
    // In another place: still not the Hall.
    await recordVisit(db, { userId: away, room: "tower#1", event: "start", at: new Date(k) });
    expect(await call(away)).toBe("NOT_IN_HALL");
    const left = await makeResident(db);
    await inHall(left, k);
    await recordVisit(db, { userId: left, room: "watch_party#1", event: "end", at: new Date(k + 30 * S) });
    expect(await call(left)).toBe("NOT_IN_HALL");

    const u = await makeResident(db);
    await inHall(u, k);
    const fren = await makeResident(db);
    expect(await call(u, { inPlay: "yes" })).toBe("INVALID_INPUT");
    expect(await call(u, { via: "tail", viaUserId: fren, side: undefined })).toBe("INVALID_INPUT");
    expect(await call(u, { seenPrice: 50, chance: 70 })).toBe("PRICE_MOVED"); // the kickoff price, not the live one
    // Without inPlay it's a call on a frozen market, as ever.
    expect(await call(u, { inPlay: undefined })).toBe("MARKET_CLOSED");
    expect(await call(u)).toBe("OK");
    expect(await call(u)).toBe("ALREADY_CALLED");

    // Odds paused: no in-play calls either.
    const v = await makeResident(db);
    await inHall(v, k);
    expect(await call(v, {}, k + MIN + TOWER.feedPausedAfterSeconds * S + S)).toBe("FEED_PAUSED");
    // The feed stops carrying it in play: closed.
    m.inPlay = undefined;
    await pollOdds(db, f.provider, at(k + 2 * MIN));
    expect(await call(v, {}, k + 2 * MIN + S)).toBe("MARKET_CLOSED");
  });

  it("refuses an in-play call before kickoff, and one on a market that never plays on", async () => {
    const t = fresh();
    const f = feed();
    const m = f.match(t);
    const coin = f.match(t, { category: "crypto" });
    await pollOdds(db, f.provider, at(t));
    const u = await makeResident(db);
    await inHall(u, t);
    expect(await code(makeCall(db, u, { marketId: await idOf(m.externalId), side: "yes", chance: 70, seenPrice: 50, inPlay: true }, at(t + MIN)))).toBe("MARKET_CLOSED");
    coin.inPlay = true;
    await pollOdds(db, f.provider, at(t + H + MIN));
    expect(await code(makeCall(db, u, { marketId: await idOf(coin.externalId), side: "yes", chance: 70, seenPrice: 50, inPlay: true }, at(t + H + MIN + S)))).toBe("MARKET_CLOSED");
  });

  it("a call made before kickoff stays the only one: no second call in play", async () => {
    const t = fresh();
    const f = feed();
    const m = f.match(t);
    await pollOdds(db, f.provider, at(t));
    const id = await idOf(m.externalId);
    const u = await makeResident(db);
    const pre = await makeCall(db, u, { marketId: id, side: "yes", chance: 70, seenPrice: 50 }, at(t + MIN));
    await pollOdds(db, f.provider, at(t + 2 * MIN));
    expect((await callRow(pre.id)).status).toBe("locked");
    m.inPlay = true;
    m.price = 55;
    await pollOdds(db, f.provider, at(t + H + MIN));
    await inHall(u, t + H);
    expect(await code(makeCall(db, u, { marketId: id, side: "no", chance: 40, seenPrice: 55, inPlay: true }, at(t + H + MIN + S)))).toBe("ALREADY_CALLED");
  });

  it("never moves the City or Crew bars: those are the city's view before kickoff", async () => {
    const t = fresh();
    const f = feed();
    const m = f.match(t);
    await pollOdds(db, f.provider, at(t));
    const id = await idOf(m.externalId);
    // Ten neighbours call it before kickoff: the City bar shows 70.
    const before = await Promise.all(Array.from({ length: TOWER.cityBarMin }, () => makeResident(db)));
    const u = await makeResident(db);
    const neighbours: string[] = [...before, u];
    await client`UPDATE users SET proof_of_neighbour_at = ${new Date(t - D).toISOString()}::timestamptz WHERE id IN ${client(neighbours)}`;
    // Three of them are your crew.
    await createCrew(db, before[0]!, { name: `Hall ${randomUUID().slice(0, 6)}` });
    for (const x of [before[1]!, before[2]!, u]) await redeemInvite(db, x, (await createInvite(db, before[0]!)).code);
    for (const b of before) await makeCall(db, b, { marketId: id, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + MIN), onSlate: async () => false });
    await pollOdds(db, f.provider, at(t + 2 * MIN));
    const k = t + H;
    m.inPlay = true;
    m.price = 60;
    await pollOdds(db, f.provider, at(k + MIN));
    await inHall(u, k);
    const made = k + MIN + 5 * S;
    const c = await makeCall(db, u, { marketId: id, side: "yes", chance: 95, seenPrice: 60, inPlay: true }, at(made));
    await pollOdds(db, f.provider, at(made + TOWER.inPlayDelaySeconds * S));
    expect((await callRow(c.id)).status).toBe("locked");
    expect((await cityCalls(db, [id])).map((x) => x.userId).sort()).toEqual([...before].sort());
    expect(await cityCalls(db, [id], { atFreeze: true })).toHaveLength(TOWER.cityBarMin);
    // Your market view: the live price, in play, your call, the bar from
    // before kickoff, and no gap between that bar and a live price.
    const v = await marketView(db, u, id, { now: new Date(made + 3 * MIN), onSlate: async () => false });
    expect(v).toMatchObject({ inPlay: true, world: 60, status: "frozen", city: 70, crew: 70, vibeGap: null, counts: { city: TOWER.cityBarMin, crew: 3 }, mine: { id: c.id, status: "locked", inPlay: true } });
  });
});

describe("what the database holds to", () => {
  it("an in-play call never locks inside 2 minutes, always locks for half, and never changes kind", async () => {
    const t = fresh();
    const f = feed();
    const m = f.match(t);
    await pollOdds(db, f.provider, at(t));
    m.inPlay = true;
    m.price = 60;
    const k = t + H;
    await pollOdds(db, f.provider, at(k + MIN));
    const id = await idOf(m.externalId);
    const u = await makeResident(db);
    await inHall(u, k);
    const made = new Date(k + MIN + 5 * S);
    const c = await makeCall(db, u, { marketId: id, side: "yes", chance: 75, seenPrice: 60, inPlay: true }, { now: made });
    const tickAt = async (ms: number) => (await client`INSERT INTO market_ticks (market_id, price, at) VALUES (${id}, 60, ${new Date(made.getTime() + ms).toISOString()}::timestamptz) RETURNING id`)[0]!.id as string;
    const lock = (tick: string, half: boolean) => client`UPDATE calls SET status = 'locked', tick_id = ${tick}, locked_price = 60, locked_at = ${made.toISOString()}::timestamptz, half = ${half} WHERE id = ${c.id}`;
    expect(await sqlCode(lock(await tickAt(119 * S), true))).toBe("23000");
    expect(await sqlCode(lock(await tickAt(120 * S), false))).toBe("23514"); // calls_in_play: half, always
    expect(await sqlCode(client`UPDATE calls SET in_play = false WHERE id = ${c.id}`)).toBe("23000");
    expect(await sqlCode(lock(await tickAt(121 * S), true))).toBe("OK");
    // Never on the Slate, never a Tail.
    const v = await makeResident(db);
    expect(await sqlCode(client`INSERT INTO calls (user_id, market_id, side, chance, seen_price, on_slate, in_play, created_at) VALUES (${v}, ${id}, 'yes', 70, 60, true, true, now())`)).toBe("23514");
    expect(await sqlCode(client`INSERT INTO calls (user_id, market_id, side, chance, seen_price, via, via_user_id, in_play, created_at) VALUES (${v}, ${id}, 'yes', 70, 60, 'tail', ${u}, true, now())`)).toBe("23514");
  });

  it("only a frozen match plays on, and only with a live price", async () => {
    const t = fresh();
    const f = feed();
    const open = f.match(t);
    const coin = f.match(t, { category: "crypto", freezesAt: new Date(t - MIN) });
    await pollOdds(db, f.provider, at(t));
    expect(await sqlCode(client`UPDATE markets SET in_play = true, live_price = 50 WHERE external_id = ${open.externalId}`)).toBe("23514");
    expect(await sqlCode(client`UPDATE markets SET in_play = true, live_price = 50 WHERE external_id = ${coin.externalId}`)).toBe("23514");
    await pollOdds(db, f.provider, at(t + H + MIN));
    expect(await sqlCode(client`UPDATE markets SET in_play = true WHERE external_id = ${open.externalId}`)).toBe("23514");
    expect(await sqlCode(client`UPDATE markets SET in_play = true, live_price = 50 WHERE external_id = ${open.externalId}`)).toBe("OK");
  });
});

describe("in the room", () => {
  it("is in a place from a visit's start to its end, any copy, for 6 hours at most without an end", async () => {
    const t = fresh();
    const u = await makeResident(db);
    expect(await inRoom(db, u, "watch_party", new Date(t))).toBe(false);
    await recordVisit(db, { userId: u, room: "watch_party#3", event: "start", at: new Date(t) });
    expect(await inRoom(db, u, "watch_party", new Date(t + MIN))).toBe(true);
    expect(await inRoom(db, u, "watch_party", new Date(t - MIN))).toBe(false);
    expect(await inRoom(db, u, "tower", new Date(t + MIN))).toBe(false);
    expect(await inRoom(db, u, "watch_party", new Date(t + 6 * H - MIN))).toBe(true);
    expect(await inRoom(db, u, "watch_party", new Date(t + 6 * H + MIN))).toBe(false);
    await recordVisit(db, { userId: u, room: "watch_party#3", event: "end", at: new Date(t + 2 * MIN) });
    expect(await inRoom(db, u, "watch_party", new Date(t + MIN))).toBe(true);
    expect(await inRoom(db, u, "watch_party", new Date(t + 3 * MIN))).toBe(false);
  });
});
