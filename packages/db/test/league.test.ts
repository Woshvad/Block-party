import { randomUUID } from "node:crypto";
import { type FeedMarket, type OddsProvider, weekStart } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCrew, createDb, createInvite, ensureSystemAccounts, leagueCard, leagueChampions, makeCall, pollOdds, publishSlate, redeemInvite, runBell, runLeague } from "../src";
import { makeResident } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const monday = Date.parse("2040-01-02T00:00:00Z"); // a Monday
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

async function crewOf(n: number) {
  const people = await Promise.all(Array.from({ length: n }, () => makeResident(db)));
  const c = await createCrew(db, people[0]!, { name: `League ${randomUUID().slice(0, 6)}` });
  for (const u of people.slice(1)) await redeemInvite(db, u, (await createInvite(db, people[0]!)).code);
  return { id: c.id, people };
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("the Crew League", () => {
  it("scores the week: top-5 Aura average plus full-Slate points; under 5 callers doesn't play; once a week", async () => {
    // Tuesday's Slate: six cards; everybody calls the 50% card, A also locks a full Slate with one member.
    const d0 = monday + D;
    const ms = new Map<string, FeedMarket>();
    const provider: OddsProvider = { source: "league-test", fetch: async () => [...ms.values()].map((m) => ({ ...m })) };
    for (const p of [80, 50, 60, 30, 20, 8]) {
      const m: FeedMarket = { externalId: randomUUID(), question: `L ${p}?`, category: "sports", ladder: null, freezesAt: new Date(d0 + 16 * H), settlesBy: new Date(d0 + 20 * H), price: p, resolved: null, voided: false };
      ms.set(m.externalId, m);
    }
    await pollOdds(db, provider, { now: new Date(d0 + 9 * H - MIN) });
    await publishSlate(db, { now: new Date(d0 + 9 * H - MIN) });
    const cards = await client`SELECT sc.market_id, m.price FROM slate_cards sc JOIN markets m ON m.id = sc.market_id WHERE sc.city_day = ${day(d0)} ORDER BY sc.slot`;
    const flip = cards.find((c) => c.price === 50)!.market_id as string;
    const [A, B, C, Dc] = [await crewOf(5), await crewOf(5), await crewOf(4), await crewOf(6)];
    const at = new Date(d0 + 9 * H);
    // D: five steady YES 60s, and a sixth member with a huge YES 99 who leaves before Sunday's close.
    for (const u of Dc.people.slice(0, 5)) await makeCall(db, u, { marketId: flip, side: "yes", chance: 60, seenPrice: 50 }, { now: at });
    await makeCall(db, Dc.people[5]!, { marketId: flip, side: "yes", chance: 99, seenPrice: 50 }, { now: at });
    // A market that resolves next week: A's member scores big on it, but not in this week's table.
    const late: FeedMarket = { externalId: randomUUID(), question: "Next week?", category: "sports", ladder: null, freezesAt: new Date(d0 + 16 * H), settlesBy: new Date(monday + 9 * D), price: 50, resolved: null, voided: false };
    ms.set(late.externalId, late);
    await pollOdds(db, provider, { now: new Date(at.getTime() - 1000) });
    const lateId = (await client`SELECT id FROM markets WHERE external_id = ${late.externalId}`)[0]!.id as string;
    await makeCall(db, A.people[1]!, { marketId: lateId, side: "yes", chance: 99, seenPrice: 50 }, { now: at });
    for (const u of A.people) await makeCall(db, u, { marketId: flip, side: "yes", chance: 60, seenPrice: 50 }, { now: at });
    for (const u of B.people) await makeCall(db, u, { marketId: flip, side: "no", chance: 40, seenPrice: 50 }, { now: at });
    for (const u of C.people) await makeCall(db, u, { marketId: flip, side: "yes", chance: 99, seenPrice: 50 }, { now: at });
    // One of A locks every card on the Slate: a full Slate, +1.
    for (const c of cards) if (c.market_id !== flip) await makeCall(db, A.people[0]!, { marketId: c.market_id, side: "yes", chance: Math.min(99, c.price + 5), seenPrice: c.price }, { now: at });
    await pollOdds(db, provider, { now: new Date(at.getTime() + MIN) });
    for (const m of ms.values()) if (m !== late) m.resolved = m.price === 50; // the Coin Flip hits YES, the rest NO
    await pollOdds(db, provider, { now: new Date(d0 + 21 * H) });
    late.resolved = true;
    await pollOdds(db, provider, { now: new Date(monday + 8 * D) }); // resolves the following Tuesday
    const { leaveCrew } = await import("../src");
    await leaveCrew(db, Dc.people[5]!);

    const sunday = day(monday + 6 * D);
    const r = await runLeague(db, sunday, new Date(monday + 7 * D + 5 * MIN));
    expect(r.week).toBe(weekStart(sunday));
    const row = async (id: string) => (await client`SELECT * FROM league_weeks WHERE crew_id = ${id} AND week = ${day(monday)}`)[0]!;
    // A: four members at +9, one at +9 minus their five NO-resolved YES calls; top-5 average, plus 1 full Slate.
    const auraA = (await client`SELECT user_id, SUM(aura_centi)::int AS s FROM calls WHERE user_id IN ${client(A.people)} AND market_id <> ${lateId} GROUP BY user_id`).map((x) => x.s as number);
    const expectedA = auraA.sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0) / 5 / 100 + 1;
    expect((await row(A.id)).score_milli).toBe(Math.round(expectedA * 1000));
    expect((await row(B.id)).score_milli).toBe(-11_000); // five NOs at 40 on a YES: −11 each
    expect((await row(C.id)).score_milli).toBeNull(); // 4 callers: not in the table
    expect((await row(Dc.id)).score_milli).toBe(9_000); // the leaver's +24.99 doesn't count
    // Only a crew that played can be champion.
    expect((await client`SELECT count(*)::int AS n FROM league_weeks WHERE champion AND score_milli IS NULL`)[0]!.n).toBe(0);
    // Within a division a scored crew never sits below an unscored one.
    for (const x of [A, B]) {
      const me = await row(x.id);
      const below = await client`SELECT count(*)::int AS n FROM league_weeks WHERE week = ${day(monday)} AND size_group = ${me.size_group} AND division = ${me.division} AND rank < ${me.rank} AND score_milli IS NULL`;
      expect(below[0]!.n).toBe(0);
    }
    expect((await row(C.id)).moved).not.toBe("up"); // a crew that didn't play never goes up
    // The card, and once a week only.
    expect(await leagueCard(db, A.id)).toMatchObject({ week: day(monday), sizeGroup: "small", score: expectedA });
    expect((await runLeague(db, sunday, new Date(monday + 7 * D + 6 * MIN))).recorded).toBe(0);
    expect(Array.isArray(await leagueChampions(db))).toBe(true);
    // The ladder holds every live crew exactly once.
    const dupes = await client`SELECT crew_id FROM crew_league GROUP BY crew_id HAVING count(*) > 1`;
    expect(dupes).toHaveLength(0);
  });

  it("runs at the Monday bell", async () => {
    const r = await runBell(db, { now: new Date(monday + 14 * D + 5 * MIN), only: ["league"] });
    expect(r.ran.league).toMatchObject({ week: day(monday + 7 * D) });
    // Nobody played that week: no champion anywhere.
    expect((await client`SELECT count(*)::int AS n FROM league_weeks WHERE week = ${day(monday + 7 * D)} AND champion`)[0]!.n).toBe(0);
  });
});
