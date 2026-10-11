import { randomUUID } from "node:crypto";
import { type FeedMarket, type OddsProvider, addDays, userAccountId } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BellShowError,
  bellStatus,
  claimBellStamp,
  createCrew,
  createDb,
  createInvite,
  ensureSystemAccounts,
  getBalance,
  makeCall,
  moodState,
  pollOdds,
  publishSlate,
  redeemInvite,
  reel,
  runBell,
  stepTower,
  useCopium,
} from "../src";
import { makeResident, releaseTogether } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
let day0 = Date.parse("2033-05-02T00:00:00Z"); // a Monday
const freshDay = () => (day0 += 7 * D); // always a Monday
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

function feed() {
  const ms = new Map<string, FeedMarket>();
  const provider: OddsProvider = { source: "bell-test", fetch: async () => [...ms.values()].map((m) => ({ ...m })) };
  const add = (d0: number, price: number) => {
    const m: FeedMarket = { externalId: randomUUID(), question: `Q ${price}?`, category: "sports", ladder: null, freezesAt: new Date(d0 + 16 * H), settlesBy: new Date(d0 + 20 * H), price, resolved: null, voided: false };
    ms.set(m.externalId, m);
    return m;
  };
  return { provider, add };
}
const idOf = async (ext: string) => (await client`SELECT id FROM markets WHERE external_id = ${ext}`)[0]!.id as string;

// A day with a published Slate; returns its cards (by market) in tier order.
async function slateDay(beforePublish?: (d0: number, ids: string[]) => Promise<void>) {
  const d0 = freshDay();
  const f = feed();
  const ms = [80, 50, 60, 30, 20, 8].map((p) => f.add(d0, p));
  await pollOdds(db, f.provider, { now: new Date(d0 + 9 * H - MIN) });
  if (beforePublish) await beforePublish(d0, await Promise.all(ms.map((m) => idOf(m.externalId))));
  await publishSlate(db, { now: new Date(d0 + 9 * H - MIN) });
  const ids = await Promise.all(ms.map((m) => idOf(m.externalId)));
  return { d0, f, ms, ids };
}
const settleAndRing = async (s: Awaited<ReturnType<typeof slateDay>>) => {
  await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 21 * H) });
  return runBell(db, { now: new Date(s.d0 + D + 5 * MIN), only: ["tower"] });
};

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof BellShowError) return e.code;
    throw e;
  }
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("the bell's Tower step", () => {
  it("receipts become moods: CALLED IT, and REKT with a free Copium; once per bell", async () => {
    const s = await slateDay();
    const [winner, loser, both] = [await makeResident(db), await makeResident(db), await makeResident(db)];
    await makeCall(db, winner, { marketId: s.ids[1], side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(s.d0 + 9 * H) });
    await makeCall(db, loser, { marketId: s.ids[1], side: "no", chance: 30, seenPrice: 50 }, { now: new Date(s.d0 + 9 * H) });
    await makeCall(db, both, { marketId: s.ids[1], side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(s.d0 + 9 * H) });
    await makeCall(db, both, { marketId: s.ids[2], side: "yes", chance: 70, seenPrice: 60 }, { now: new Date(s.d0 + 9 * H) });
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 9 * H + MIN) });
    s.ms[1]!.resolved = true;
    s.ms[2]!.resolved = false;
    const first = await settleAndRing(s);
    expect(first.ran.tower).toMatchObject({ calledIt: 2, rekt: 2 });
    const at = new Date(s.d0 + D + 10 * MIN);
    const moods = async (u: string) => (await moodState(db, u, { now: at })).active.map((a) => a.mood).sort();
    expect(await moods(winner)).toEqual(["called_it"]);
    expect(await moods(loser)).toEqual(["rekt"]);
    expect(await moods(both)).toEqual(["called_it", "rekt"]);
    expect((await moodState(db, loser, { now: at })).copium.free).toBe(1);
    expect((await runBell(db, { now: new Date(s.d0 + D + 6 * MIN), only: ["tower"] })).ran.tower).toBe("already done");
    expect((await moodState(db, loser, { now: at })).copium.free).toBe(1);
  });

  it("4 REKT squares on the day's grid tilt you; 3 don't; small misses and calls from before the Slate don't count", async () => {
    let earlyUser = "";
    const s = await slateDay(async (d0, ids) => {
      earlyUser = await makeResident(db);
      await client`INSERT INTO tickets (user_id, balance, as_of) VALUES (${earlyUser}, 9, ${dayOf(d0)})`;
      for (const [i, price] of [80, 50, 60, 30].entries()) await makeCall(db, earlyUser, { marketId: ids[i], side: "yes", chance: 99, seenPrice: price }, { now: new Date(d0 + 9 * H - MIN + 1000) });
    });
    const [four, three, mild] = [await makeResident(db), await makeResident(db), await makeResident(db)];
    const early = earlyUser;
    // mild: 4 small misses (1 point past the price): white squares, not REKT.
    for (const [i, price] of [80, 50, 60, 30].entries()) await makeCall(db, mild, { marketId: s.ids[i], side: "yes", chance: price + 1, seenPrice: price }, { now: new Date(s.d0 + 9 * H) });
    for (const [u, n] of [[four, 4], [three, 3]] as const)
      for (const i of [0, 1, 2, 3].slice(0, n)) {
        const price = [80, 50, 60, 30][i]!;
        await makeCall(db, u, { marketId: s.ids[i], side: "yes", chance: 99, seenPrice: price }, { now: new Date(s.d0 + 9 * H) });
      }
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 9 * H + MIN) });
    for (const m of s.ms) m.resolved = false;
    await settleAndRing(s);
    const at = new Date(s.d0 + D + 10 * MIN);
    expect((await moodState(db, four, { now: at })).tilt.tilted).toBe(true);
    expect((await moodState(db, three, { now: at })).tilt.tilted).toBe(false);
    expect((await moodState(db, mild, { now: at })).tilt.tilted).toBe(false);
    expect((await moodState(db, early, { now: at })).tilt.tilted).toBe(false);
  });

  it("a later step failing leaves the Tower step done: it isn't run again, and no second free Copium", async () => {
    const s = await slateDay();
    const loser = await makeResident(db);
    await makeCall(db, loser, { marketId: s.ids[1], side: "no", chance: 30, seenPrice: 50 }, { now: new Date(s.d0 + 9 * H) });
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 9 * H + MIN) });
    s.ms[1]!.resolved = true;
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 21 * H) });
    const bell = new Date(s.d0 + D + 5 * MIN);
    const jam = (step: string) => {
      if (step === "close") throw new Error("the paper jammed");
    };
    await expect(runBell(db, { now: bell, only: ["tower", "close"], onStep: jam })).rejects.toThrow("the paper jammed");
    expect((await bellStatus(db, dayOf(s.d0))).map((r) => r.step)).toEqual(["tower"]);
    // The next minute: the Tower step stays done; only the paper runs.
    const again = await runBell(db, { now: new Date(bell.getTime() + MIN), only: ["tower", "close"] });
    expect(again.ran.tower).toBe("already done");
    expect(again.ran.close).not.toBe("already done");
    expect((await moodState(db, loser, { now: new Date(bell.getTime() + 2 * MIN) })).copium.free).toBe(1);
  });

  it("a Tower step that runs twice (it crashed before being recorded) grants each mood once", async () => {
    const s = await slateDay();
    const u = await makeResident(db);
    for (const [i, price] of [80, 50, 60, 30].entries()) await makeCall(db, u, { marketId: s.ids[i], side: "yes", chance: 99, seenPrice: price }, { now: new Date(s.d0 + 9 * H) });
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 9 * H + MIN) });
    for (const m of s.ms) m.resolved = false;
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 21 * H) });
    const bell = new Date(s.d0 + D + 5 * MIN);
    await stepTower(db, dayOf(s.d0), bell);
    const at = new Date(bell.getTime() + MIN);
    const first = await moodState(db, u, { now: at });
    expect(first.active.map((a) => a.mood).sort()).toEqual(["rekt", "tilted"]);
    expect(first.copium.free).toBe(1);
    // They spend the free Copium: REKT and Tilted clear.
    await useCopium(db, u, randomUUID(), { now: at });
    // The same step again, a minute later: no second free Copium, no fresh REKT or tilt.
    await stepTower(db, dayOf(s.d0), new Date(at.getTime() + MIN));
    const after = await moodState(db, u, { now: new Date(at.getTime() + 2 * MIN) });
    expect(after.active).toEqual([]);
    expect(after.copium.free).toBe(0);
  });

  it("Bell Scores: a chip per CALLED IT by a crewmate, ×1.5 for a Long Shot caught; crewless winners score nothing", async () => {
    const s = await slateDay();
    const crewA = await Promise.all(Array.from({ length: 3 }, () => makeResident(db)));
    const crewB = await Promise.all(Array.from({ length: 4 }, () => makeResident(db)));
    for (const crew of [crewA, crewB]) {
      await createCrew(db, crew[0]!, { name: `Bell ${randomUUID().slice(0, 6)}` });
      for (const u of crew.slice(1)) await redeemInvite(db, u, (await createInvite(db, crew[0]!)).code);
    }
    const loner = await makeResident(db);
    const at = new Date(s.d0 + 9 * H);
    // A: two right on the Coin Flip, one YES on the Long Shot that hits. B: one right.
    await makeCall(db, crewA[0]!, { marketId: s.ids[1], side: "yes", chance: 60, seenPrice: 50 }, { now: at });
    await makeCall(db, crewA[1]!, { marketId: s.ids[1], side: "yes", chance: 60, seenPrice: 50 }, { now: at });
    await makeCall(db, crewA[2]!, { marketId: s.ids[5], side: "yes", chance: 20, seenPrice: 8 }, { now: at });
    await makeCall(db, crewB[0]!, { marketId: s.ids[1], side: "yes", chance: 60, seenPrice: 50 }, { now: at });
    await makeCall(db, crewB[1]!, { marketId: s.ids[1], side: "no", chance: 40, seenPrice: 50 }, { now: at });
    await makeCall(db, crewB[2]!, { marketId: s.ids[5], side: "no", chance: 4, seenPrice: 8 }, { now: at }); // NO on the Long Shot that hits: not caught
    await makeCall(db, crewB[3]!, { marketId: s.ids[1], side: "yes", chance: 60, seenPrice: 50 }, { now: at }); // right, but leaves before the bell
    await makeCall(db, loner, { marketId: s.ids[1], side: "yes", chance: 60, seenPrice: 50 }, { now: at });
    await pollOdds(db, s.f.provider, { now: new Date(at.getTime() + MIN) });
    s.ms[1]!.resolved = true;
    s.ms[5]!.resolved = true;
    const { leaveCrew } = await import("../src");
    await leaveCrew(db, crewB[3]!);
    expect((await settleAndRing(s)).ran.tower).toMatchObject({ crewsScored: 2 });
    const scores = await client`SELECT c.name, s.chips, s.long_shots, s.score_milli FROM crew_bell_scores s JOIN crews c ON c.id = s.crew_id WHERE s.bell_day = ${dayOf(s.d0)} ORDER BY s.score_milli DESC`;
    expect(scores.map((r) => [r.chips, r.long_shots, r.score_milli])).toEqual([
      [3, 1, 4500],
      [1, 0, 1000],
    ]);
    // The reel: the Slate in tier order, the top crews, my crew's rank, the burn, tomorrow's Long Shot.
    const r = await reel(db, crewB[0]!, { now: new Date(s.d0 + D + 10 * MIN) });
    expect(r!.slate.map((c) => c.tier)).toEqual(["lock", "coin_flip", "coin_flip", "spicy", "spicy", "long_shot"]);
    expect(r!.slate.find((c) => c.tier === "long_shot")).toMatchObject({ result: "yes", darkBunker: "no" });
    expect(r!.bellScores.top.map((t) => t.score)).toEqual([4.5, 1]);
    expect(r!.bellScores.mine).toEqual({ score: 1, rank: 2 });
    expect(typeof r!.burned).toBe("number");
    expect(r!.grid).toMatchObject({ sealed: false });
    expect(await reel(db, crewB[0]!, { now: new Date(s.d0 + 23 * H), bellDay: dayOf(s.d0) })).toBeNull(); // before the bell
  });
});

describe("Bell Stamps", () => {
  it("25 GM for calling today, once, even with racing taps; nothing without a call", async () => {
    const s = await slateDay();
    const u = await makeResident(db);
    const at = new Date(s.d0 + 9 * H);
    expect(await code(claimBellStamp(db, u, { now: at }))).toBe("NO_CALL_TODAY");
    await makeCall(db, u, { marketId: s.ids[1], side: "yes", chance: 60, seenPrice: 50 }, { now: at });
    expect(await code(claimBellStamp(db, u, { now: new Date(at.getTime() + 1000) }))).toBe("NO_CALL_TODAY"); // still pending
    await pollOdds(db, s.f.provider, { now: new Date(at.getTime() + MIN) });
    const before = await getBalance(db, userAccountId(u));
    const res = await releaseTogether(client, "SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [u], 1, Array.from({ length: 4 }, () => () => claimBellStamp(db, u, { now: new Date(at.getTime() + 2 * MIN) })));
    expect(res.every((r) => r.ok)).toBe(true);
    expect((await getBalance(db, userAccountId(u))) - before).toBe(25);
    expect(await client`SELECT 1 FROM bell_stamps WHERE user_id = ${u}`).toHaveLength(1);
    // Tomorrow needs tomorrow's call.
    expect(await code(claimBellStamp(db, u, { now: new Date(s.d0 + D + H) }))).toBe("NO_CALL_TODAY");
  });

  it("150 on Sundays", async () => {
    const s = await slateDay(); // a Monday; its Sunday is 6 days on
    const sunday = s.d0 + 6 * D;
    const f = feed();
    const m = f.add(sunday, 50);
    await pollOdds(db, f.provider, { now: new Date(sunday + 9 * H) });
    const u = await makeResident(db);
    await makeCall(db, u, { marketId: await idOf(m.externalId), side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(sunday + 9 * H + 1000) });
    await pollOdds(db, f.provider, { now: new Date(sunday + 9 * H + MIN) });
    expect(addDays(dayOf(s.d0), 6)).toBe(dayOf(sunday));
    expect(await claimBellStamp(db, u, { now: new Date(sunday + 10 * H) })).toMatchObject({ gm: 150 });
  });
});

describe("which bell a result belongs to", () => {
  it("a market that settles just after the bell waits for the next one", async () => {
    const s = await slateDay();
    const u = await makeResident(db);
    await makeCall(db, u, { marketId: s.ids[1], side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(s.d0 + 9 * H) });
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 9 * H + MIN) });
    s.ms[1]!.resolved = true;
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + D + 2 * MIN) }); // settled at 00:02, after the bell
    await runBell(db, { now: new Date(s.d0 + D + 5 * MIN), only: ["tower"] });
    expect((await moodState(db, u, { now: new Date(s.d0 + D + 10 * MIN) })).active.map((a) => a.mood)).not.toContain("called_it");
    await runBell(db, { now: new Date(s.d0 + 2 * D + 5 * MIN), only: ["tower"] });
    expect((await moodState(db, u, { now: new Date(s.d0 + 2 * D + 10 * MIN) })).active.map((a) => a.mood)).toContain("called_it");
  });
});
