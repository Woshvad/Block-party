import { randomUUID } from "node:crypto";
import { type FeedMarket, type Modifier, NOTHING_DAY_TILE, addDays, cityDay, modifierFor } from "@bp/core";
import { createCrew, createInvite, makeCall, npcCalls, pollOdds, publishSlate, redeemInvite, runBell } from "@bp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, client, close, db, makeApp, ready, resident } from "./harness";

beforeAll(ready);
afterAll(close);

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const PRICES = [80, 50, 60, 30, 20, 8];

// A Slate day a few days ahead (sessions last 30 days) whose modifier is the
// one wanted, one per test, with clocks for during the day and after its bell.
let offset = 3;
function dayWith(modifier: Modifier) {
  let day = addDays(cityDay(new Date()), offset++);
  while (modifierFor(day) !== modifier) day = addDays(cityDay(new Date()), offset++);
  return day;
}
async function slateDay(modifier: Modifier) {
  const day = dayWith(modifier);
  const d0 = Date.parse(`${day}T00:00:00Z`);
  const at = (h: number) => new Date(d0 + h * H);
  const feed = new Map<string, FeedMarket>();
  const provider = { source: "modifiers-api-test", fetch: async () => [...feed.values()].map((m) => ({ ...m })) };
  const ms = PRICES.map((price) => {
    const m: FeedMarket = { externalId: randomUUID(), question: `Modifier ${price}?`, category: "sports", ladder: null, freezesAt: at(16), settlesBy: at(20), price, resolved: null, voided: false };
    feed.set(m.externalId, m);
    return m;
  });
  await pollOdds(db, provider, { now: at(9) });
  await publishSlate(db, { now: at(9) });
  const ids = await Promise.all(ms.map(async (m) => (await client`SELECT id FROM markets WHERE external_id = ${m.externalId}`)[0]!.id as string));
  const slot = async (i: number) => (await client`SELECT slot FROM slate_cards WHERE city_day = ${day} AND market_id = ${ids[i]!}`)[0]!.slot as number;
  return {
    day,
    ids,
    slot,
    call: (u: string, i: number, side: "yes" | "no", chance: number) => makeCall(db, u, { marketId: ids[i], side, chance, seenPrice: PRICES[i]! }, { now: at(9) }),
    lock: () => pollOdds(db, provider, { now: at(9 + 1 / 60) }),
    // Every card settles YES, then the bell's Tower and modifier steps run.
    settleAndRing: async () => {
      for (const m of ms) m.resolved = true;
      await pollOdds(db, provider, { now: at(21) });
      return runBell(db, { now: new Date(d0 + D + 5 * MIN), only: ["tower", "modifier"] });
    },
    during: makeApp({ now: () => at(9.5) }),
    after: makeApp({ now: () => new Date(d0 + D + 10 * MIN) }),
  };
}
const pon = (ids: string[]) => client`UPDATE users SET proof_of_neighbour_at = now() WHERE id IN ${client(ids)}`;

describe("Contrarian Day over HTTP", () => {
  it("the grid, the receipt and the reel show the gold border from the bell on", async () => {
    const s = await slateDay("contrarian_day");
    const me = await resident();
    const crowd = await Promise.all(Array.from({ length: 10 }, () => resident()));
    await pon([me.userId, ...crowd.map((c) => c.userId)]);
    for (const c of crowd) await s.call(c.userId, 1, "yes", 60);
    const mine = await s.call(me.userId, 1, "no", 40);
    await s.lock();

    const sealed = await call("GET", `/v1/slate/${s.day}/grid`, { token: me.token, via: s.during });
    expect([sealed.status, sealed.body.sealed]).toEqual([200, true]);
    expect(JSON.stringify(sealed.body)).not.toMatch(/contrarian/);

    expect((await s.settleAndRing()).ran.modifier).toMatchObject({ modifier: "contrarian_day", majorities: 1 });
    const want = [false, false, false, false, false, false];
    want[await s.slot(1)] = true;
    const grid = await call("GET", `/v1/slate/${s.day}/grid`, { token: me.token, via: s.after });
    expect(grid.body).toMatchObject({ sealed: false, modifier: "contrarian_day", contrarian: want, nothing: null });

    const status = await call("GET", `/v1/tower/calls/${mine.id}`, { token: me.token, via: s.after });
    const r = await call("GET", status.body.receiptLink, { via: s.after });
    expect([r.status, r.body.contrarian, r.body.stamp]).toEqual([200, true, "REKT"]);
    const crowdCall = (await client`SELECT id FROM calls WHERE user_id = ${crowd[0]!.userId} AND market_id = ${s.ids[1]!}`)[0]!.id as string;
    const theirs = await call("GET", (await call("GET", `/v1/tower/calls/${crowdCall}`, { token: crowd[0]!.token, via: s.after })).body.receiptLink, { via: s.after });
    expect(theirs.body.contrarian).toBe(false);

    const reel = await call("GET", `/v1/reel?day=${s.day}`, { token: me.token, via: s.after });
    expect(reel.body).toMatchObject({ modifier: "contrarian_day", beatTheBot: null, grid: { contrarian: want } });
    expect(reel.body.slate.find((c: { slot: number }) => c.slot === want.indexOf(true))).toMatchObject({ cityMajority: "yes" });
  });
});

describe("NOTHING Day over HTTP", () => {
  it("the winner's grid says they beat the bot, the banner tile is in their storage, and the reel counts them", async () => {
    const s = await slateDay("nothing_day");
    const [winner, loser] = [await resident(), await resident()];
    await npcCalls(db, { now: new Date(Date.parse(`${s.day}T09:00:00Z`)) });
    await s.call(winner.userId, 1, "yes", 60);
    await s.call(loser.userId, 1, "no", 10);
    await s.call(loser.userId, 2, "no", 10);
    await s.lock();
    expect((await s.settleAndRing()).ran.modifier).toMatchObject({ modifier: "nothing_day", winners: 1, tiles: 1 });

    const won = await call("GET", `/v1/slate/${s.day}/grid`, { token: winner.token, via: s.after });
    expect(won.body).toMatchObject({ modifier: "nothing_day", contrarian: null, nothing: { beat: true, tile: true } });
    expect(won.body.nothing.squares).toHaveLength(6);
    expect((await call("GET", `/v1/slate/${s.day}/grid`, { token: loser.token, via: s.after })).body.nothing).toMatchObject({ beat: false, tile: false });

    const home = await call("GET", "/v1/home", { token: winner.token });
    expect(home.body.storage.map((x: { pieceId: string }) => x.pieceId)).toContain(NOTHING_DAY_TILE);
    expect((await call("GET", "/v1/home", { token: loser.token })).body.storage.map((x: { pieceId: string }) => x.pieceId)).not.toContain(NOTHING_DAY_TILE);
    expect((await call("GET", `/v1/reel?day=${s.day}`, { token: loser.token, via: s.after })).body).toMatchObject({ modifier: "nothing_day", beatTheBot: 1 });
  });
});

describe("Blind Slate over HTTP", () => {
  it("a syndicate, or a duel between crewmates, on today's cards is a 409 that gives nothing away", async () => {
    const s = await slateDay("blind_slate");
    const [a, b] = [await resident(), await resident()];
    await createCrew(db, a.userId, { name: `Blind ${randomUUID().slice(0, 6)}` });
    await redeemInvite(db, b.userId, (await createInvite(db, a.userId)).code);
    await s.call(a.userId, 1, "yes", 60);
    await s.call(b.userId, 1, "no", 40);
    await s.lock();
    const syn = await call("POST", "/v1/syndicates", { token: b.token, body: { marketId: s.ids[2], side: "yes" }, via: s.during });
    expect([syn.status, syn.body.error.code]).toEqual([409, "BLIND_SLATE"]);
    const duel = await call("POST", "/v1/duels", { token: a.token, body: { marketId: s.ids[1], opponentId: b.userId }, via: s.during });
    expect([duel.status, duel.body.error.code]).toEqual([409, "BLIND_SLATE"]);
    expect(JSON.stringify(duel.body)).not.toMatch(/NOT_ACROSS|other side/); // refused before the sides are compared
  });
});
