import { randomUUID } from "node:crypto";
import type { FeedMarket, OddsProvider } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TowerError,
  createDb,
  ensureSystemAccounts,
  feedStatus,
  makeCall,
  marketView,
  myTickets,
  pollOdds,
  setPrefs,
  touchActivity,
  blockUser,
  createCrew,
  createInvite,
  redeemInvite,
  receipt,
  rightList,
  settleCalls,
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
    await createCrew(db, people[0]!, { name: `Floor ${randomUUID().slice(0, 6)}` });
    for (const u of people.slice(1, 3)) await redeemInvite(db, u, (await createInvite(db, people[0]!)).code);
    for (const [i, u] of people.entries()) await makeCall(db, u, { marketId: id, side: "yes", chance: 55 + i, seenPrice: 10 }, { now: new Date(t + 1000) });
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
    const later = await rightList(db, { now: new Date(t + 20 * D), season: after.season, userId: steady });
    expect(later.me).toMatchObject({ settled: 12, rusty: true }); // still listed, marked rusty
  });
});
