import { randomUUID } from "node:crypto";
import { CAST, type FeedMarket, type Modifier, NOTHING_DAY_TILE, type OddsProvider, auraCenti, modifierFor, nothingCall } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DuelError,
  SyndicateError,
  challenge,
  createCrew,
  createDb,
  createInvite,
  ensureSystemAccounts,
  makeCall,
  marketView,
  myGrid,
  npcCalls,
  pollOdds,
  proposeSyndicate,
  publishSlate,
  receipt,
  redeemInvite,
  reel,
  runBell,
  shakeSyndicate,
  stepModifier,
} from "../src";
import { makeResident, raceAt } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const PRICES = [80, 50, 60, 30, 20, 8];
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
// A fresh city day per test whose Slate draws the modifier we want, far from
// every other test file's days.
let day0 = Date.parse("2055-01-04T00:00:00Z");
function dayWith(modifier: Modifier) {
  do day0 += D;
  while (modifierFor(dayOf(day0)) !== modifier);
  return day0;
}

function feed() {
  const ms = new Map<string, FeedMarket>();
  const provider: OddsProvider = { source: "modifiers-test", fetch: async () => [...ms.values()].map((m) => ({ ...m })) };
  // Callable to 16:00, settled by 20:00 of the day.
  const add = (d0: number, price: number) => {
    const m: FeedMarket = { externalId: randomUUID(), question: `Q ${price}?`, category: "sports", ladder: null, freezesAt: new Date(d0 + 16 * H), settlesBy: new Date(d0 + 20 * H), price, resolved: null, voided: false };
    ms.set(m.externalId, m);
    return m;
  };
  return { provider, add, ms };
}
const idOf = async (ext: string) => (await client`SELECT id FROM markets WHERE external_id = ${ext}`)[0]!.id as string;

// A day whose Slate is out at 09:00 with the six cards (by market, in PRICES order).
async function slateDay(modifier: Modifier, beforePublish?: (d0: number, ids: string[]) => Promise<void>) {
  const d0 = dayWith(modifier);
  const f = feed();
  const ms = PRICES.map((p) => f.add(d0, p));
  await pollOdds(db, f.provider, { now: new Date(d0 + 9 * H - 2 * MIN) });
  const ids = await Promise.all(ms.map((m) => idOf(m.externalId)));
  if (beforePublish) await beforePublish(d0, ids);
  await publishSlate(db, { now: new Date(d0 + 9 * H - MIN) });
  const slot = async (i: number) => (await client`SELECT slot FROM slate_cards WHERE city_day = ${dayOf(d0)} AND market_id = ${ids[i]!}`)[0]!.slot as number;
  return {
    d0,
    day: dayOf(d0),
    f,
    ms,
    ids,
    slot,
    at: (h: number) => new Date(d0 + h * H),
    poll: (h: number) => pollOdds(db, f.provider, { now: new Date(d0 + h * H) }),
    // Every card settles YES (or as given) by 21:00.
    settle: async (outcomes: boolean[] = PRICES.map(() => true)) => {
      ms.forEach((m, i) => (m.resolved = outcomes[i]!));
      await pollOdds(db, f.provider, { now: new Date(d0 + 21 * H) });
    },
    afterBell: new Date(d0 + D + 5 * MIN),
    ring: (only: Array<"tower" | "modifier"> = ["tower", "modifier"]) => runBell(db, { now: new Date(d0 + D + 5 * MIN), only }),
  };
}
type SlateDay = Awaited<ReturnType<typeof slateDay>>;

const people = (n: number) => Promise.all(Array.from({ length: n }, () => makeResident(db)));
const pon = (ids: string[]) => client`UPDATE users SET proof_of_neighbour_at = now() WHERE id IN ${client(ids)}`;
const call = (s: SlateDay, u: string, i: number, side: "yes" | "no", chance: number, h = 9) => makeCall(db, u, { marketId: s.ids[i], side, chance, seenPrice: PRICES[i]! }, { now: s.at(h) });
const opened = async (s: SlateDay, u: string) => {
  const g = await myGrid(db, u, s.day, { now: s.afterBell });
  if (g?.sealed !== false) throw new Error("the grid should be open after the bell");
  return g;
};
const tiles = async (u: string) => (await client`SELECT source FROM items WHERE owner_user_id = ${u} AND piece_id = ${NOTHING_DAY_TILE}`).map((r) => r.source);
async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof DuelError || e instanceof SyndicateError) return e.code;
    throw e;
  }
}
async function crewOf(n: number) {
  const members = await people(n);
  await createCrew(db, members[0]!, { name: `Mods ${randomUUID().slice(0, 6)}` });
  for (const u of members.slice(1)) await redeemInvite(db, u, (await createInvite(db, members[0]!)).code);
  return members;
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("Contrarian Day: calls against the city majority get a gold border", () => {
  it("on the grid, the receipt and the reel, once the bell has counted; no City bar or a tie is no majority; only neighbours count", async () => {
    const s = await slateDay("contrarian_day");
    const [me, outsider] = [await makeResident(db), await makeResident(db)];
    const yes = await people(7);
    const no = await people(3);
    const strangers = await people(3); // no Proof of Neighbour: never counted
    await pon([me, ...yes, ...no]);
    // The Coin Flip at 50: 7 neighbours YES, 4 NO (me among them).
    const yesCall = await call(s, yes[0]!, 1, "yes", 60);
    for (const u of yes.slice(1)) await call(s, u, 1, "yes", 60);
    for (const u of no) await call(s, u, 1, "no", 40);
    const mine = await call(s, me, 1, "no", 40);
    // An outsider takes NO too: not counted, but still against the city.
    const outCall = await call(s, outsider, 1, "no", 45);
    // The other Coin Flip at 60: 5 YES to 5 NO, a tie. Strangers and the cast don't break it.
    for (const u of yes.slice(0, 5)) await call(s, u, 2, "yes", 70);
    for (const u of [...no, yes[5]!]) await call(s, u, 2, "no", 50);
    const tieCall = await call(s, me, 2, "no", 50);
    for (const u of strangers) await call(s, u, 2, "yes", 70);
    // The Lock at 80: 4 neighbours, so no City bar and no majority.
    for (const u of no) await call(s, u, 0, "no", 70);
    const lockCall = await call(s, me, 0, "yes", 90);
    await npcCalls(db, { now: s.at(9) }); // NOTHING-9000: NO on every card
    await s.poll(9 + 1 / 60);

    // Before the bell: sealed, no border anywhere.
    expect(await myGrid(db, me, s.day, { now: s.at(22) })).toMatchObject({ sealed: true });
    expect(await receipt(db, mine.id, { now: s.at(22) })).toMatchObject({ contrarian: false });

    await s.settle();
    const rang = await s.ring();
    expect(rang.ran.modifier).toEqual({ modifier: "contrarian_day", cards: 6, majorities: 1 });
    const recorded = await client`SELECT market_id, yes, no, majority FROM contrarian_cards WHERE city_day = ${s.day}`;
    const row = (i: number) => recorded.find((r) => r.market_id === s.ids[i]);
    expect(row(1)).toMatchObject({ yes: 7, no: 4, majority: "yes" });
    expect(row(2)).toMatchObject({ yes: 5, no: 5, majority: null });
    expect(row(0)).toMatchObject({ yes: 1, no: 3, majority: null });
    expect(row(3)).toMatchObject({ yes: 0, no: 0, majority: null });

    const want = [false, false, false, false, false, false];
    want[await s.slot(1)] = true;
    expect((await opened(s, me)).contrarian).toEqual(want);
    expect((await opened(s, outsider)).contrarian).toEqual(want);
    expect((await opened(s, yes[0]!)).contrarian).toEqual([false, false, false, false, false, false]);
    expect(await receipt(db, mine.id, { now: s.afterBell })).toMatchObject({ contrarian: true, stamp: "REKT" }); // the border isn't about winning
    expect(await receipt(db, outCall.id, { now: s.afterBell })).toMatchObject({ contrarian: true });
    for (const c of [yesCall, tieCall, lockCall]) expect(await receipt(db, c.id, { now: s.afterBell })).toMatchObject({ contrarian: false });

    const r = await reel(db, me, { now: s.afterBell, bellDay: s.day });
    const coinFlip = await s.slot(1);
    expect(r!.modifier).toBe("contrarian_day");
    expect(r!.slate.find((c) => c.slot === 0)).toMatchObject({ cityMajority: null }); // the Lock
    expect(r!.slate.find((c) => c.slot === coinFlip)).toMatchObject({ cityMajority: "yes" });
    expect(r!.grid).toMatchObject({ contrarian: want, nothing: null });

    // Recorded once and kept: a replayed step keeps the first count, and the rows never change.
    expect((await s.ring()).ran.modifier).toBe("already done");
    await stepModifier(db, s.day, s.afterBell);
    expect(await client`SELECT 1 FROM contrarian_cards WHERE city_day = ${s.day}`).toHaveLength(6);
    await expect(client`UPDATE contrarian_cards SET majority = 'no', no = 99 WHERE city_day = ${s.day}`).rejects.toThrow(/never changes/);
    await expect(client`DELETE FROM contrarian_cards WHERE city_day = ${s.day}`).rejects.toThrow(/never changes/);
    await expect(client`INSERT INTO contrarian_cards (city_day, market_id, yes, no, majority, recorded_at) VALUES (${s.day}, ${randomUUID()}, 1, 0, 'yes', now())`).rejects.toThrow(/contrarian_cards_slate_card_fk/);
  });

  it("the majority is the count when the card froze, not when you locked; a Proof of Neighbour after the bell changes nothing", async () => {
    const s = await slateDay("contrarian_day");
    const me = await makeResident(db);
    const early = await people(10);
    const late = await people(12);
    const outsiders = await people(6);
    await pon([me, ...early, ...late]);
    // 09:00: ten neighbours say YES.
    const earlyCall = await call(s, early[0]!, 1, "yes", 60);
    for (const u of early.slice(1)) await call(s, u, 1, "yes", 60);
    await s.poll(9 + 1 / 60);
    // 10:00: I lock NO, against a city that's 10 to 0 YES at that moment.
    await s.poll(10 - 1 / 60);
    const mine = await call(s, me, 1, "no", 40, 10);
    await s.poll(10 + 1 / 60);
    // 11:00: twelve more say NO, and outsiders pile on YES (they don't count).
    await s.poll(11 - 1 / 60);
    for (const u of late) await call(s, u, 1, "no", 40, 11);
    for (const u of outsiders) await call(s, u, 1, "yes", 60, 11);
    await s.poll(11 + 1 / 60);

    await s.settle();
    await s.ring();
    expect((await client`SELECT yes, no, majority FROM contrarian_cards WHERE city_day = ${s.day} AND market_id = ${s.ids[1]!}`)[0]).toMatchObject({ yes: 10, no: 13, majority: "no" });
    expect(await receipt(db, mine.id, { now: s.afterBell })).toMatchObject({ contrarian: false }); // with the final majority
    expect(await receipt(db, earlyCall.id, { now: s.afterBell })).toMatchObject({ contrarian: true }); // with the city at 09:00, against it at the freeze

    // After the bell, the outsiders pass Proof of Neighbour (now 16 YES to 13
    // NO) and some neighbours lose it: the borders the bell gave stay.
    await pon(outsiders);
    await client`UPDATE users SET proof_of_neighbour_at = NULL WHERE id IN ${client(late.slice(0, 5))}`;
    const later = new Date(s.afterBell.getTime() + H);
    expect(await receipt(db, mine.id, { now: later })).toMatchObject({ contrarian: false });
    expect(await receipt(db, earlyCall.id, { now: later })).toMatchObject({ contrarian: true });
    const g = await myGrid(db, early[0]!, s.day, { now: later });
    expect(g).toMatchObject({ sealed: false });
    expect((g as { contrarian: boolean[] }).contrarian[await s.slot(1)]).toBe(true);
  });

  it("a card still taking calls at the bell has no final count, so no row", async () => {
    const s = await slateDay("contrarian_day");
    const crowd = await people(10);
    await pon(crowd);
    for (const u of crowd) await call(s, u, 0, "yes", 90);
    await s.poll(9 + 1 / 60);
    // The feed moves the Lock's freeze past the bell.
    s.ms[0]!.freezesAt = new Date(s.d0 + D + 2 * H);
    s.ms[0]!.settlesBy = new Date(s.d0 + D + 3 * H);
    await s.poll(10);
    s.ms.forEach((m, i) => i > 0 && (m.resolved = true));
    await pollOdds(db, s.f.provider, { now: s.at(21) });
    expect((await s.ring()).ran.modifier).toEqual({ modifier: "contrarian_day", cards: 5, majorities: 0 });
    expect(await client`SELECT 1 FROM contrarian_cards WHERE city_day = ${s.day} AND market_id = ${s.ids[0]!}`).toHaveLength(0);
  });

  it("any other day, the same calls get no border and nothing is recorded", async () => {
    for (const modifier of ["nothing_day", "blind_slate"] as const) {
      const s = await slateDay(modifier);
      const me = await makeResident(db);
      const crowd = await people(10);
      await pon([me, ...crowd]);
      for (const u of crowd) await call(s, u, 1, "yes", 60);
      const mine = await call(s, me, 1, "no", 40);
      await s.poll(9 + 1 / 60);
      await s.settle();
      await s.ring();
      expect(await client`SELECT 1 FROM contrarian_cards WHERE city_day = ${s.day}`).toHaveLength(0);
      expect(await opened(s, me)).toMatchObject({ contrarian: null });
      expect(await receipt(db, mine.id, { now: s.afterBell })).toMatchObject({ contrarian: false });
      expect((await reel(db, me, { now: s.afterBell, bellDay: s.day }))!.slate.every((c) => !("cityMajority" in c))).toBe(true);
    }
  });
});

describe("NOTHING Day: beat the bot's grid for a banner tile", () => {
  // Every card settles YES, so NOTHING-9000's NOs all lose some Aura.
  const botAura = PRICES.reduce((a, p) => a + auraCenti(true, p, nothingCall(p)!.chance), 0);

  it("settled at the bell, once: more Aura than the bot wins the tile; a tie, a worse grid, no calls and the cast don't", async () => {
    const s = await slateDay("nothing_day");
    const [winner, loser, twin, idle] = [await makeResident(db), await makeResident(db), await makeResident(db), await makeResident(db)];
    await npcCalls(db, { now: s.at(9) }); // NOTHING-9000: NO on every card
    await call(s, winner, 1, "yes", 60); // +9 when YES hits
    await call(s, loser, 1, "no", 10);
    await call(s, loser, 2, "no", 10);
    // The twin calls exactly what the bot calls: the same grid, a tie.
    for (const [i, p] of PRICES.entries()) await call(s, twin, i, "no", nothingCall(p)!.chance);
    await s.poll(9 + 1 / 60);
    // The Contrarian calls at noon against the city, and with every card YES its grid beats the bot's too.
    await s.poll(12 - 1 / 60);
    await npcCalls(db, { now: s.at(12) });
    await s.poll(12 + 1 / 60);
    await s.settle();

    // The Tower step has scored the day; the modifier step hasn't run yet.
    await s.ring(["tower"]);
    expect((await opened(s, winner)).nothing).toEqual({ squares: expect.any(Array), aura: botAura / 100, beat: null, tile: false });
    expect(await tiles(winner)).toEqual([]);

    const rang = await s.ring(["modifier"]);
    expect(rang.ran.modifier).toEqual({ modifier: "nothing_day", botAura: botAura / 100, winners: 1, tiles: 1 });
    expect(await tiles(winner)).toEqual(["earned"]);
    const g = await opened(s, winner);
    expect(g.nothing).toMatchObject({ aura: botAura / 100, beat: true, tile: true });
    expect(g.nothing!.squares).toHaveLength(6);
    expect(g.nothing!.squares.every((x) => x === "red" || x === "white" || x === "green")).toBe(true); // a NO on every card, never a black square
    for (const u of [loser, twin, idle]) {
      expect((await opened(s, u)).nothing).toMatchObject({ beat: false, tile: false });
      expect(await tiles(u)).toEqual([]);
    }
    expect((await opened(s, idle)).aura).toBeNull();
    const wins = await client`SELECT user_id, aura_centi, bot_aura_centi, tile FROM nothing_day_wins WHERE city_day = ${s.day}`;
    expect(wins).toEqual([{ user_id: winner, aura_centi: 900, bot_aura_centi: botAura, tile: true }]);
    expect(await tiles(CAST.contrarian.id)).toEqual([]);
    expect((await reel(db, winner, { now: s.afterBell, bellDay: s.day }))).toMatchObject({ modifier: "nothing_day", beatTheBot: 1, grid: { contrarian: null } });

    // A replayed bell, or the step run again after a crash before it was recorded: nothing new.
    expect((await s.ring(["modifier"])).ran.modifier).toBe("already done");
    expect(await stepModifier(db, s.day, s.afterBell)).toEqual({ modifier: "nothing_day", botAura: botAura / 100, winners: 0, tiles: 0 });
    expect(await client`SELECT 1 FROM nothing_day_wins WHERE city_day = ${s.day}`).toHaveLength(1);
    expect(await tiles(winner)).toEqual(["earned"]);

    // The record never changes, never pays the cast, and is always a real win.
    await expect(client`UPDATE nothing_day_wins SET tile = false WHERE city_day = ${s.day}`).rejects.toThrow(/never changes/);
    await expect(client`DELETE FROM nothing_day_wins WHERE city_day = ${s.day}`).rejects.toThrow(/never changes/);
    await expect(client`INSERT INTO nothing_day_wins (city_day, user_id, aura_centi, bot_aura_centi, tile, at) VALUES (${s.day}, ${CAST.contrarian.id}, 100, 0, false, now())`).rejects.toThrow(/never earns/);
    await expect(client`INSERT INTO nothing_day_wins (city_day, user_id, aura_centi, bot_aura_centi, tile, at) VALUES (${s.day}, ${loser}, 0, 0, false, now())`).rejects.toThrow(/nothing_day_wins_beat/);
  });

  it("a second NOTHING Day win is recorded, but the tile comes once", async () => {
    const winner = await makeResident(db);
    for (const first of [true, false]) {
      const s = await slateDay("nothing_day");
      await npcCalls(db, { now: s.at(9) });
      await call(s, winner, 1, "yes", 60);
      await s.poll(9 + 1 / 60);
      await s.settle();
      expect((await s.ring()).ran.modifier).toMatchObject({ winners: 1, tiles: first ? 1 : 0 });
      expect((await opened(s, winner)).nothing).toMatchObject({ beat: true, tile: first });
    }
    expect(await tiles(winner)).toEqual(["earned"]);
    expect(await client`SELECT tile FROM nothing_day_wins WHERE user_id = ${winner} ORDER BY city_day`).toEqual([{ tile: true }, { tile: false }]);
  });

  it("no grid from the bot, nothing to beat", async () => {
    const s = await slateDay("nothing_day");
    const me = await makeResident(db);
    await call(s, me, 1, "yes", 60);
    await s.poll(9 + 1 / 60);
    await s.settle();
    expect((await s.ring()).ran.modifier).toEqual({ modifier: "nothing_day", botAura: null, winners: 0, tiles: 0 });
    expect((await opened(s, me)).nothing).toEqual({ squares: ["black", "black", "black", "black", "black", "black"], aura: null, beat: false, tile: false });
    expect(await tiles(me)).toEqual([]);
  });

  it("two runs racing pay one tile and record one win", async () => {
    const s = await slateDay("nothing_day");
    const me = await makeResident(db);
    await npcCalls(db, { now: s.at(9) });
    await call(s, me, 1, "yes", 60);
    await s.poll(9 + 1 / 60);
    await s.settle();
    await s.ring(["tower"]);
    const res = await raceAt(client, "nothing_day_wins", 2, [0, 1].map(() => () => stepModifier(db, s.day, s.afterBell)));
    expect(res.every((r) => r.ok)).toBe(true);
    expect(res.reduce((a, r) => a + (r.ok ? (r.v as { winners: number }).winners : 0), 0)).toBe(1);
    expect(await client`SELECT 1 FROM nothing_day_wins WHERE city_day = ${s.day}`).toHaveLength(1);
    expect(await tiles(me)).toEqual(["earned"]);
  });
});

describe("modifiers never touch Aura, GM or real trades", () => {
  // Everything a modifier could be tempted to move: each call's Aura, every
  // ledger row and balance, and every real trade.
  const snapshot = async (ids: string[]) => ({
    calls: await client`SELECT id, status, aura_centi, half FROM calls WHERE market_id IN ${client(ids)} ORDER BY id`,
    ledger: await client`SELECT
      (SELECT count(*) FROM gm_transactions)::int AS transactions,
      (SELECT count(*) FROM gm_entries)::int AS entries,
      (SELECT md5(coalesce(string_agg(id || ':' || balance, ',' ORDER BY id), '')) FROM gm_accounts) AS balances,
      (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t.id), '')) FROM real_trades t) AS trades`,
  });

  it.each(["contrarian_day", "nothing_day", "blind_slate"] as const)("%s: the bell's modifier step leaves them exactly as they were", async (modifier) => {
    const s = await slateDay(modifier);
    const me = await makeResident(db);
    const crowd = await people(10);
    await pon([me, ...crowd]);
    await npcCalls(db, { now: s.at(9) });
    for (const u of crowd) await call(s, u, 1, "yes", 60);
    await call(s, me, 1, "no", 40); // against the city
    await call(s, me, 2, "yes", 70); // beats the bot's NO
    await s.poll(9 + 1 / 60);
    await s.settle();
    await s.ring(["tower"]);
    const before = await snapshot(s.ids);
    expect(before.calls.every((c) => c.aura_centi !== null)).toBe(true);
    const rang = await s.ring(["modifier"]);
    expect(rang.ran.modifier).toMatchObject({ modifier });
    expect(await snapshot(s.ids)).toEqual(before);
  });
});

describe("Blind Slate: even your crew's sides stay hidden until the bell", () => {
  it("no Crew bar on a Blind Slate card, even after you lock; it's back after the bell", async () => {
    const s = await slateDay("blind_slate");
    const crew = await crewOf(3);
    for (const u of crew) await call(s, u, 1, "yes", 70);
    await s.poll(9 + 1 / 60);
    expect(await marketView(db, crew[0]!, s.ids[1]!, { now: s.at(9.1) })).toMatchObject({ blurred: false, crew: null, counts: { crew: 3 } });
    // (No bell run here: the Tower step would walk this crew's gm chain from
    // today's date to the test's far-off day. The bar is back by the clock.)
    await s.settle();
    expect(await marketView(db, crew[0]!, s.ids[1]!, { now: s.afterBell })).toMatchObject({ crew: 70 });
  });

  it("no syndicate on a Blind Slate card, nor a shake on one proposed before the Slate went out; off the Slate, and on other days, as before", async () => {
    const crew = await crewOf(3);
    let early = "";
    const s = await slateDay("blind_slate", async (d0, ids) => {
      early = (await proposeSyndicate(db, crew[0]!, { marketId: ids[1], side: "yes" }, { now: new Date(d0 + 9 * H - 2 * MIN) })).id;
    });
    expect(await code(shakeSyndicate(db, crew[1]!, early, {}, { now: s.at(9) }))).toBe("BLIND_SLATE");
    expect(await code(proposeSyndicate(db, crew[1]!, { marketId: s.ids[2], side: "no" }, { now: s.at(9) }))).toBe("BLIND_SLATE");
    // A Tower market that isn't on today's Slate.
    const off = s.f.add(s.d0, 45);
    await s.poll(9);
    expect(await code(proposeSyndicate(db, crew[1]!, { marketId: await idOf(off.externalId), side: "no" }, { now: s.at(9) }))).toBe("OK");

    const other = await slateDay("contrarian_day");
    expect(await code(proposeSyndicate(db, crew[2]!, { marketId: other.ids[1], side: "yes" }, { now: other.at(9) }))).toBe("OK");
  });

  it("no duel between crewmates on a Blind Slate card, checked before the sides; anyone else, or another day, as before", async () => {
    const s = await slateDay("blind_slate");
    const [a, b, c] = await crewOf(3);
    const stranger = await makeResident(db);
    await call(s, a!, 1, "yes", 60);
    await call(s, b!, 1, "no", 40); // across from a
    await call(s, c!, 1, "yes", 60); // on a's side: the refusal mustn't say so
    await call(s, stranger!, 1, "no", 40);
    await s.poll(9 + 1 / 60);
    const now = { now: s.at(9.1) };
    expect(await code(challenge(db, a!, { marketId: s.ids[1], opponentId: b }, now))).toBe("BLIND_SLATE");
    expect(await code(challenge(db, a!, { marketId: s.ids[1], opponentId: c }, now))).toBe("BLIND_SLATE");
    expect(await code(challenge(db, a!, { marketId: s.ids[1], opponentId: stranger }, now))).toBe("DUELS_OFF"); // not crew: the usual checks

    const other = await slateDay("nothing_day");
    await call(other, a!, 1, "yes", 60);
    await call(other, b!, 1, "no", 40);
    await other.poll(9 + 1 / 60);
    expect(await code(challenge(db, a!, { marketId: other.ids[1], opponentId: b }, { now: other.at(9.1) }))).toBe("DUELS_OFF");
  });
});
