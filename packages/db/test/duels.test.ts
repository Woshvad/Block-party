import { randomUUID } from "node:crypto";
import { CAST, type FeedMarket, type OddsProvider, duelAccountId, userAccountId } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DuelError,
  blockUser,
  cancelOffer,
  challenge,
  createDb,
  duelLines,
  ensureSystemAccounts,
  getBalance,
  grantMood,
  makeCall,
  moodState,
  openGmStakes,
  pollOdds,
  respond,
  retreat,
  runLastCall,
  setDuelPrefs,
  settleDuels,
  snap,
  supplyStats,
  runBell,
  reel,
  dailyClose,
  createCrew,
} from "../src";
import { makeResident, releaseTogether } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
let day0 = Date.parse("2036-01-07T00:00:00Z");
const freshDay = () => (day0 += 9 * D);

function feed() {
  const ms = new Map<string, FeedMarket>();
  const provider: OddsProvider = { source: "duel-test", fetch: async () => [...ms.values()].map((m) => ({ ...m })) };
  const add = (d0: number, over: Partial<FeedMarket> = {}) => {
    const m: FeedMarket = { externalId: randomUUID(), question: "Duel me?", category: "sports", ladder: null, freezesAt: new Date(d0 + 16 * H), settlesBy: new Date(d0 + 20 * H), price: 50, resolved: null, voided: false, ...over };
    ms.set(m.externalId, m);
    return m;
  };
  return { provider, add };
}
const idOf = async (ext: string) => (await client`SELECT id FROM markets WHERE external_id = ${ext}`)[0]!.id as string;
const bal = (u: string) => getBalance(db, userAccountId(u));
const escrow = (d: string) => getBalance(db, duelAccountId(d));
async function duelist() {
  const u = await makeResident(db);
  await client`UPDATE users SET proof_of_neighbour_at = now() WHERE id = ${u}`;
  await setDuelPrefs(db, u, { duelsOn: true });
  return u;
}
async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof DuelError) return e.code;
    throw e;
  }
}
// A market with a and b on opposite sides (a YES, b NO), locked at 09:01.
async function scene(over: Partial<FeedMarket> = {}) {
  const d0 = freshDay();
  const f = feed();
  const m = f.add(d0, over);
  await pollOdds(db, f.provider, { now: new Date(d0 + 9 * H - MIN) });
  const id = await idOf(m.externalId);
  const [a, b] = [await duelist(), await duelist()];
  await makeCall(db, a, { marketId: id, side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(d0 + 9 * H - MIN + 1000) });
  await makeCall(db, b, { marketId: id, side: "no", chance: 40, seenPrice: 50 }, { now: new Date(d0 + 9 * H - MIN + 1000) });
  await pollOdds(db, f.provider, { now: new Date(d0 + 9 * H) });
  await pollOdds(db, f.provider, { now: new Date(d0 + 10 * H - MIN) }); // the feed is live at 10:00
  return { d0, f, m, id, a, b, at: new Date(d0 + 10 * H) };
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("a duel, start to finish", () => {
  it("antes, two Snaps, and the winner takes the pot; no GM created, none lost", async () => {
    const s = await scene();
    const [a0, b0] = [await bal(s.a), await bal(s.b)];
    const supply0 = await supplyStats(db);
    const d = await challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: s.at });
    expect(await escrow(d.id)).toBe(10);
    expect(await respond(db, s.b, d.id, true, { now: s.at })).toMatchObject({ status: "active" });
    expect(await escrow(d.id)).toBe(20);
    expect(await snap(db, s.a, d.id, { now: s.at })).toMatchObject({ stake: 20 });
    expect(await code(snap(db, s.a, d.id, { now: s.at }))).toBe("SNAP_USED");
    expect(await snap(db, s.b, d.id, { now: s.at })).toMatchObject({ stake: 40 });
    expect(await escrow(d.id)).toBe(80);
    s.m.resolved = true; // YES: a wins
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 21 * H) });
    expect(await settleDuels(db, { now: new Date(s.d0 + 21 * H) })).toMatchObject({ settled: 1 });
    expect((await bal(s.a)) - a0).toBe(40);
    expect((await bal(s.b)) - b0).toBe(-40);
    expect(await escrow(d.id)).toBe(0);
    const supply1 = await supplyStats(db);
    expect(supply1.created - supply0.created).toBe(0);
    expect(supply1.destroyed - supply0.destroyed).toBe(0);
    // b lost holding a Snap: tilted.
    expect((await moodState(db, s.b, { now: new Date(s.d0 + 21 * H + MIN) })).tilt.tilted).toBe(true);
    expect((await moodState(db, s.a, { now: new Date(s.d0 + 21 * H + MIN) })).tilt.tilted).toBe(false);
    expect(await settleDuels(db, { now: new Date(s.d0 + 22 * H) })).toMatchObject({ settled: 0 }); // once
  });

  it("duel stakes still count as each side's GM (rent, the broke floor) until the duel settles", async () => {
    const s = await scene();
    const staked = async () => [await openGmStakes(db, s.a), await openGmStakes(db, s.b)];
    const d = await challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: s.at });
    expect(await staked()).toEqual([10, 0]); // an offer holds only the challenger's ante
    await respond(db, s.b, d.id, true, { now: s.at });
    await snap(db, s.b, d.id, { now: s.at });
    expect(await staked()).toEqual([20, 20]);
    s.m.resolved = false; // NO: b wins
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 21 * H) });
    await settleDuels(db, { now: new Date(s.d0 + 21 * H) });
    expect(await staked()).toEqual([0, 0]);
  });

  it("retreat: the ante to the opponent, the rest burns, their stake comes back", async () => {
    const s = await scene();
    const [a0, b0] = [await bal(s.a), await bal(s.b)];
    const burned0 = (await supplyStats(db)).destroyed;
    const d = await challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: s.at });
    await respond(db, s.b, d.id, true, { now: s.at });
    await snap(db, s.a, d.id, { now: s.at });
    await snap(db, s.b, d.id, { now: s.at });
    expect(await retreat(db, s.a, d.id, { now: s.at })).toMatchObject({ status: "retreated", burned: 30, lost: 40 });
    expect((await bal(s.a)) - a0).toBe(-40);
    expect((await bal(s.b)) - b0).toBe(10);
    expect((await supplyStats(db)).destroyed - burned0).toBe(30);
    expect(await escrow(d.id)).toBe(0);
    expect(await code(snap(db, s.b, d.id, { now: s.at }))).toBe("WRONG_STATE");
  });

  it("a voided market gives both stakes back", async () => {
    const s = await scene();
    const [a0, b0] = [await bal(s.a), await bal(s.b)];
    const d = await challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: s.at });
    await respond(db, s.b, d.id, true, { now: s.at });
    await snap(db, s.b, d.id, { now: s.at });
    s.m.voided = true;
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 21 * H) });
    await settleDuels(db, { now: new Date(s.d0 + 21 * H) });
    expect([await bal(s.a), await bal(s.b), await escrow(d.id)]).toEqual([a0, b0, 0]);
  });

  it("decline, take back, or let it lapse: the ante always comes home", async () => {
    const s = await scene();
    const a0 = await bal(s.a);
    const d1 = await challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: s.at });
    expect(await respond(db, s.b, d1.id, false, { now: s.at })).toMatchObject({ status: "declined" });
    expect(await bal(s.a)).toBe(a0);
    // A new pair for the take-back and the lapse (one duel per pair a week).
    const [c, e] = [await duelist(), await duelist()];
    await makeCall(db, c, { marketId: s.id, side: "no", chance: 40, seenPrice: 50 }, { now: s.at });
    await makeCall(db, e, { marketId: s.id, side: "no", chance: 40, seenPrice: 50 }, { now: s.at });
    await pollOdds(db, s.f.provider, { now: new Date(s.at.getTime() + MIN) });
    const later = new Date(s.at.getTime() + 2 * MIN);
    const d2 = await challenge(db, s.a, { marketId: s.id, opponentId: c }, { now: later });
    expect(await code(cancelOffer(db, s.b, d2.id))).toBe("NOT_YOURS");
    await cancelOffer(db, s.a, d2.id, { now: later });
    const d3 = await challenge(db, s.a, { marketId: s.id, opponentId: e }, { now: later });
    expect(await code(respond(db, s.b, d3.id, true, { now: later }))).toBe("NOT_YOURS");
    await settleDuels(db, { now: new Date(s.d0 + 16 * H + MIN) }); // the market locked: the offer lapses
    expect((await client`SELECT status FROM duels WHERE id = ${d3.id}`)[0]!.status).toBe("expired");
    expect(await bal(s.a)).toBe(a0);
  });
});

describe("the guards", () => {
  it("opt-in, across a market, PoN, 300 GM, no blocks, never the cast, markets that settle by the bell", async () => {
    const s = await scene();
    expect(await code(challenge(db, s.a, { marketId: s.id, opponentId: s.a }, { now: s.at }))).toBe("INVALID_INPUT");
    expect(await code(challenge(db, s.a, { marketId: s.id, opponentId: CAST.nothing_9000.id }, { now: s.at }))).toBe("INVALID_INPUT");
    expect(await code(challenge(db, s.a, { marketId: "x", opponentId: s.b }, { now: s.at }))).toBe("INVALID_INPUT");
    const same = await duelist();
    await makeCall(db, same, { marketId: s.id, side: "yes", chance: 60, seenPrice: 50 }, { now: s.at });
    const stranger = await duelist(); // never called it
    await pollOdds(db, s.f.provider, { now: new Date(s.at.getTime() + MIN) });
    const at = new Date(s.at.getTime() + 2 * MIN);
    expect(await code(challenge(db, s.a, { marketId: s.id, opponentId: same }, { now: at }))).toBe("NOT_ACROSS");
    expect(await code(challenge(db, s.a, { marketId: s.id, opponentId: stranger }, { now: at }))).toBe("NOT_ACROSS");
    await setDuelPrefs(db, s.b, { duelsOn: false });
    expect(await code(challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: at }))).toBe("DUELS_OFF");
    await setDuelPrefs(db, s.b, { duelsOn: true });
    await client`UPDATE users SET proof_of_neighbour_at = NULL WHERE id = ${s.a}`;
    expect(await code(challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: at }))).toBe("NEEDS_PON");
    await client`UPDATE users SET proof_of_neighbour_at = now() WHERE id = ${s.a}`;
    const poor = await duelist();
    await makeCall(db, poor, { marketId: s.id, side: "yes", chance: 60, seenPrice: 50 }, { now: at });
    await pollOdds(db, s.f.provider, { now: new Date(at.getTime() + MIN) });
    const { burn } = await import("../src");
    await burn(db, { accountId: userAccountId(poor), amount: (await bal(poor)) - 299, kind: "test", idempotencyKey: `poor:${poor}` });
    expect(await code(challenge(db, poor, { marketId: s.id, opponentId: s.b }, { now: new Date(at.getTime() + 2 * MIN) }))).toBe("NOT_ENOUGH_GM");
    await blockUser(db, s.b, s.a);
    expect(await code(challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: at }))).toBe("BLOCKED");
    const late = await scene({ settlesBy: new Date(Date.parse("2099-01-01")) });
    expect(await code(challenge(db, late.a, { marketId: late.id, opponentId: late.b }, { now: late.at }))).toBe("MARKET_CLOSED");
    expect(await code(setDuelPrefs(db, s.a, { duelsOn: "yes" }))).toBe("INVALID_INPUT");
  });

  it("one duel per pair a week (even if declined), 3 open at a time", async () => {
    const s = await scene();
    const d = await challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: s.at });
    await respond(db, s.b, d.id, false, { now: s.at });
    expect(await code(challenge(db, s.b, { marketId: s.id, opponentId: s.a }, { now: s.at }))).toBe("PAIR_THIS_WEEK");
    const rivals = await Promise.all(Array.from({ length: 4 }, () => duelist()));
    for (const r of rivals) await makeCall(db, r, { marketId: s.id, side: "no", chance: 40, seenPrice: 50 }, { now: s.at });
    await pollOdds(db, s.f.provider, { now: new Date(s.at.getTime() + MIN) });
    const at = new Date(s.at.getTime() + 2 * MIN);
    const res = await releaseTogether(client, "SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [s.a], 1, rivals.map((r) => () => code(challenge(db, s.a, { marketId: s.id, opponentId: r }, { now: at }))));
    expect(res.filter((r) => r.ok && r.v === "OK")).toHaveLength(3);
    expect(res.filter((r) => r.ok && r.v === "TOO_MANY_OPEN")).toHaveLength(1);
  });

  it("no Snap while tilted; no Snap or Retreat once the market locks; the cap holds", async () => {
    const s = await scene();
    const d = await challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: s.at });
    await respond(db, s.b, d.id, true, { now: s.at });
    await grantMood(db, s.a, "tilted", { now: s.at });
    expect(await code(snap(db, s.a, d.id, { now: new Date(s.at.getTime() + MIN) }))).toBe("TILTED");
    const frozen = new Date(s.d0 + 16 * H + MIN);
    expect(await code(snap(db, s.b, d.id, { now: frozen }))).toBe("MARKET_CLOSED");
    expect(await code(retreat(db, s.b, d.id, { now: frozen }))).toBe("MARKET_CLOSED");
    expect(await code(snap(db, randomUUID(), d.id, { now: s.at }))).toBe("NOT_YOURS");
    expect(await code(snap(db, s.b, "nope", { now: s.at }))).toBe("NO_SUCH_DUEL");
  });

  it("no Snap against a tilted opponent either: it would double their stake past the cap", async () => {
    const s = await scene();
    const d = await challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: s.at });
    await respond(db, s.b, d.id, true, { now: s.at });
    await grantMood(db, s.b, "tilted", { now: s.at });
    const [b0, e0] = [await bal(s.b), await escrow(d.id)];
    expect(await code(snap(db, s.a, d.id, { now: new Date(s.at.getTime() + MIN) }))).toBe("TILTED");
    expect([await bal(s.b), await escrow(d.id)]).toEqual([b0, e0]);
    expect((await client`SELECT stake_opponent FROM duels WHERE id = ${d.id}`)[0]!.stake_opponent).toBe(10);
  });

  it("a Snap the other side can't cover is refused, and nothing moves", async () => {
    const s = await scene();
    const d = await challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: s.at });
    await respond(db, s.b, d.id, true, { now: s.at });
    const { burn } = await import("../src");
    await burn(db, { accountId: userAccountId(s.b), amount: (await bal(s.b)) - 5, kind: "test", idempotencyKey: `drain:${s.b}` });
    const [a0, e0] = [await bal(s.a), await escrow(d.id)];
    expect(await code(snap(db, s.a, d.id, { now: s.at }))).toBe("CANT_COVER");
    expect([await bal(s.a), await escrow(d.id)]).toEqual([a0, e0]);
  });
});

describe("Last Call and races", () => {
  it("at 23:00 the live pot doubles once more, never past 80 each, and only once", async () => {
    const s = await scene();
    const d = await challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: s.at });
    await respond(db, s.b, d.id, true, { now: s.at });
    await snap(db, s.a, d.id, { now: s.at });
    await snap(db, s.b, d.id, { now: s.at });
    expect(await runLastCall(db, { now: new Date(s.d0 + 22 * H) })).toEqual({ doubled: 0, skipped: 0 }); // not yet
    await runLastCall(db, { now: new Date(s.d0 + 23 * H) });
    expect(await escrow(d.id)).toBe(160);
    await runLastCall(db, { now: new Date(s.d0 + 23 * H + MIN) });
    expect(await escrow(d.id)).toBe(160);
    expect((await client`SELECT stake_challenger, stake_opponent FROM duels WHERE id = ${d.id}`)[0]).toEqual({ stake_challenger: 80, stake_opponent: 80 });
  });

  it("two Last Call runners at once still double the pot only once", async () => {
    const s = await scene();
    const d = await challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: s.at });
    await respond(db, s.b, d.id, true, { now: s.at });
    const res = await releaseTogether(client, "SELECT 1 FROM duels WHERE id = $1 FOR UPDATE", [d.id], 2, [1, 2].map(() => () => runLastCall(db, { now: new Date(s.d0 + 23 * H) })));
    expect(res.every((r) => r.ok)).toBe(true);
    expect(await escrow(d.id)).toBe(40);
  });

  it("no Last Call for a tilted player or one who can't cover it", async () => {
    const s = await scene();
    const d = await challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: s.at });
    await respond(db, s.b, d.id, true, { now: s.at });
    await grantMood(db, s.b, "tilted", { now: new Date(s.d0 + 22 * H) });
    await runLastCall(db, { now: new Date(s.d0 + 23 * H) });
    expect(await escrow(d.id)).toBe(20);
    const t = await scene();
    const d2 = await challenge(db, t.a, { marketId: t.id, opponentId: t.b }, { now: t.at });
    await respond(db, t.b, d2.id, true, { now: t.at });
    const { burn } = await import("../src");
    await burn(db, { accountId: userAccountId(t.b), amount: (await bal(t.b)) - 3, kind: "test", idempotencyKey: `lc:${t.b}` });
    expect(await runLastCall(db, { now: new Date(t.d0 + 23 * H) })).toMatchObject({ skipped: expect.any(Number) });
    expect(await escrow(d2.id)).toBe(20);
  });

  it("racing Snaps by one player, and a Snap racing a Retreat: the books always balance", async () => {
    const s = await scene();
    const d = await challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: s.at });
    await respond(db, s.b, d.id, true, { now: s.at });
    const res = await releaseTogether(client, "SELECT 1 FROM duels WHERE id = $1 FOR UPDATE", [d.id], 3, [1, 2, 3].map(() => () => code(snap(db, s.a, d.id, { now: s.at }))));
    expect(res.map((r) => (r.ok ? r.v : "THREW")).sort()).toEqual(["OK", "SNAP_USED", "SNAP_USED"]);
    expect(await escrow(d.id)).toBe(40);
    const [a0, b0] = [await bal(s.a), await bal(s.b)];
    const burned0 = (await supplyStats(db)).destroyed;
    const both = await releaseTogether(client, "SELECT 1 FROM duels WHERE id = $1 FOR UPDATE", [d.id], 2, [() => code(snap(db, s.b, d.id, { now: s.at })), () => code(retreat(db, s.a, d.id, { now: s.at }))]);
    expect(both.every((r) => r.ok)).toBe(true);
    const after = (await bal(s.a)) - a0 + ((await bal(s.b)) - b0) + ((await supplyStats(db)).destroyed - burned0) + (await escrow(d.id));
    expect(after).toBe(40); // everything that was in the pot is accounted for
    expect(await escrow(d.id)).toBe(0);
  });
});

describe("in the reel", () => {
  it("names only residents who allow it", async () => {
    const s = await scene();
    await setDuelPrefs(db, s.a, { allowNaming: true });
    const d = await challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: s.at });
    await respond(db, s.b, d.id, true, { now: s.at });
    await snap(db, s.b, d.id, { now: s.at });
    s.m.resolved = true;
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 21 * H) });
    await settleDuels(db, { now: new Date(s.d0 + 21 * H) });
    const lines = await duelLines(db, new Date(s.d0), new Date(s.d0 + D));
    const [ah] = await client`SELECT handle FROM residents WHERE user_id = ${s.a}`;
    expect(lines).toEqual([{ winner: `@${ah!.handle}`, loser: "a neighbour", snap: true, pot: 40 }]);
  });
});

describe("at the bell", () => {
  it("duels settle at the bell: a won Snap doubles the crew's Bell Score, and the reel and the paper print it", async () => {
    const s = await scene();
    await createCrew(db, s.a, { name: `Snap ${randomUUID().slice(0, 6)}` });
    await setDuelPrefs(db, s.a, { allowNaming: true });
    await setDuelPrefs(db, s.b, { allowNaming: true });
    const d = await challenge(db, s.a, { marketId: s.id, opponentId: s.b }, { now: s.at });
    await respond(db, s.b, d.id, true, { now: s.at });
    await snap(db, s.a, d.id, { now: s.at });
    s.m.resolved = true;
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 21 * H) });
    const r = await runBell(db, { now: new Date(s.d0 + D + 5 * MIN), only: ["tower", "close"] });
    expect(r.ran.tower).toMatchObject({ duelsSettled: 1 });
    const [score] = await client`SELECT chips, score_milli FROM crew_bell_scores WHERE crew_id = (SELECT crew_id FROM crew_members WHERE user_id = ${s.a} AND left_at IS NULL)`;
    expect(score).toEqual({ chips: 1, score_milli: 2000 }); // 1 chip × 2 for the won Snap
    const [ah] = await client`SELECT handle FROM residents WHERE user_id = ${s.a}`;
    const [bh] = await client`SELECT handle FROM residents WHERE user_id = ${s.b}`;
    const rl = await reel(db, s.a, { now: new Date(s.d0 + D + 10 * MIN) });
    expect(rl!.duels).toEqual([{ winner: `@${ah!.handle}`, loser: `@${bh!.handle}`, snap: false, pot: 40 }]);
    const paper = await dailyClose(db, s.a, new Date(s.d0).toISOString().slice(0, 10));
    expect(paper!.pages.crews!.some((i) => i.key === "crews.duel" && i.values.winner === `@${ah!.handle}`)).toBe(true);
  });
});
