import { randomUUID } from "node:crypto";
import { CAST, type FeedMarket, type OddsProvider, addDays, cityWeekday, seasonOf } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOF_ROWS, TowerError, blockUser, createCityMarket, createCrew, createDb, ensureSystemAccounts, makeCall, muteUser, pollOdds, resolveCityMarket, roofBoards, seasonStack, settleCityMarkets, stakeCity } from "../src";
import { makeResident } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 10 });
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
// Each test gets a season to itself: the Right List and the Season Stack are
// city-wide, and these dates are far from every other test file's.
let base = Date.parse("2052-01-08T09:00:00Z");
const fresh = () => (base += 30 * D);
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const BOT = CAST.nothing_9000.id;

// The bell that closed this day has run its steps: the Tower's, and the
// League's that Monday's bell runs (a record the bell would skip any other day).
const rang = (day: string, steps = ["tower", "league"]) => client`INSERT INTO bell_steps ${client(steps.map((step) => ({ bell_day: day, step })))} ON CONFLICT DO NOTHING`;
const pon = (ids: string[]) => client`UPDATE users SET proof_of_neighbour_at = now() WHERE id IN ${client(ids)}`;
const topUp = (u: string, t: number) => client`INSERT INTO tickets (user_id, balance, as_of) VALUES (${u}, 9, ${dayOf(t)}) ON CONFLICT (user_id) DO UPDATE SET balance = 9, as_of = ${dayOf(t)}`;

// Ten markets that all settle YES the same day, and each caller's call on
// every one of them: residents through makeCall, NOTHING-9000 straight into
// the queue as the cast's calls go. Ten settled calls puts each on the list.
async function settledSeason(t: number, callers: Array<{ id: string; side: "yes" | "no"; chance: number }>) {
  const ms = Array.from({ length: 10 }, (): FeedMarket => ({ externalId: randomUUID(), question: "Roof?", category: "crypto", ladder: null, freezesAt: new Date(t + 2 * H), settlesBy: new Date(t + 3 * H), price: 50, resolved: null, voided: false }));
  const provider: OddsProvider = { source: "roof-test", fetch: async () => ms.map((m) => ({ ...m })) };
  await pollOdds(db, provider, { now: new Date(t) });
  const ids = (await client`SELECT id FROM markets WHERE external_id IN ${client(ms.map((m) => m.externalId))}`).map((r) => r.id as string);
  for (const c of callers) {
    for (const id of ids) {
      if (c.id === BOT) {
        await client`INSERT INTO calls (user_id, market_id, side, chance, seen_price, on_slate, ticket, created_at) VALUES (${BOT}, ${id}, ${c.side}, ${c.chance}, 50, true, false, ${new Date(t + 1000).toISOString()})`;
      } else {
        await topUp(c.id, t);
        await makeCall(db, c.id, { marketId: id, side: c.side, chance: c.chance, seenPrice: 50 }, { now: new Date(t + 1000) });
      }
    }
  }
  await pollOdds(db, provider, { now: new Date(t + MIN) }); // they lock
  for (const m of ms) m.resolved = true;
  await pollOdds(db, provider, { now: new Date(t + 4 * H) }); // they settle and score
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("the Roof's boards", () => {
  it("the Right List: handles and scores only, NOTHING-9000's row wherever it ranks, and nobody the reader has hidden", async () => {
    const t = fresh();
    const [reader, other, a, b, c, d, e] = await Promise.all(Array.from({ length: 7 }, () => makeResident(db)));
    await pon([a!, b!, c!, d!, e!]);
    // Aura per call over 10 calls (+15): a +6.4, b +5.1, c +3.6, d +1.9, the bot −4.4, e −22.4.
    await settledSeason(t, [
      { id: a!, side: "yes", chance: 70 },
      { id: b!, side: "yes", chance: 65 },
      { id: c!, side: "yes", chance: 60 },
      { id: d!, side: "yes", chance: 55 },
      { id: BOT, side: "no", chance: 40 },
      { id: e!, side: "no", chance: 10 },
    ]);
    await blockUser(db, reader!, b!); // blocked by the reader
    await blockUser(db, c!, reader!); // blocked the reader
    await muteUser(db, reader!, d!); // muted for good
    await muteUser(db, reader!, e!, { hours: 1, now: new Date(t) }); // a mute that has run out
    const after = new Date(t + D); // the bell after they settled
    await rang(dayOf(t));
    const handle = async (u: string) => (await client`SELECT handle FROM residents WHERE user_id = ${u}`)[0]!.handle as string;

    // Sealed until the bell, like everything on the Right List.
    expect((await roofBoards(db, other!, { now: new Date(t + 5 * H) })).rightList).toEqual({ rows: [], bot: null });

    const everyone = await roofBoards(db, other!, { now: after });
    expect(everyone.bellAt.toISOString()).toBe(`${dayOf(t + D)}T00:00:00.000Z`);
    expect(everyone.rightList.rows.map((r) => [r.rank, r.handle])).toEqual([
      [1, await handle(a!)],
      [2, await handle(b!)],
      [3, await handle(c!)],
      [4, await handle(d!)],
      [5, "NOTHING-9000"],
      [6, await handle(e!)],
    ]);
    expect(everyone.rightList.rows[0]).toEqual({ rank: 1, handle: await handle(a!), npc: null, perCall: expect.closeTo(6.4, 6), spread: expect.any(Number), rusty: false });
    expect(everyone.rightList.rows[4]).toMatchObject({ npc: "NPC · AI", perCall: expect.closeTo(-4.4, 6) });
    expect(everyone.rightList.bot).toEqual({ rank: 5, perCall: expect.closeTo(-4.4, 6), spread: expect.any(Number) });

    // The reader's own view: the blocked, the blocker and the muted are gone,
    // and the ranks are still the city's.
    const mine = await roofBoards(db, reader!, { now: after });
    expect(mine.rightList.rows.map((r) => [r.rank, r.handle])).toEqual([
      [1, await handle(a!)],
      [5, "NOTHING-9000"],
      [6, await handle(e!)],
    ]);
    expect(mine.rightList.bot).toMatchObject({ rank: 5 });

    // The cast can be muted like anyone: then the bot's row and its line go too.
    await muteUser(db, other!, BOT);
    const muted = await roofBoards(db, other!, { now: after });
    expect(muted.rightList.bot).toBeNull();
    expect(muted.rightList.rows.map((r) => r.handle)).not.toContain("NOTHING-9000");

    // Never an id, for anyone in it or reading it (the rows' keys are pinned above).
    const json = JSON.stringify([everyone, mine]);
    for (const u of [reader, other, a, b, c, d, e, BOT]) expect(json).not.toContain(u!);
  });

  it("a list longer than the board is cut after the hiding, and the bot's row comes with it from far down", async () => {
    const t = fresh();
    const reader = await makeResident(db);
    const top = await Promise.all(Array.from({ length: ROOF_ROWS + 4 }, () => makeResident(db)));
    await pon(top);
    // Everyone beats the bot: NO at 45 on markets that settle YES loses Aura,
    // whatever it carries over from the season before (the bot is one user
    // across every test here).
    await settledSeason(t, [...top.map((id, i) => ({ id, side: "yes" as const, chance: 60 + i })), { id: BOT, side: "no", chance: 45 }]);
    for (const u of top.slice(-3)) await blockUser(db, reader, u); // the three best
    await rang(dayOf(t));
    const mine = await roofBoards(db, reader, { now: new Date(t + D) });
    // Hiding doesn't cost the board a row: a full board from #4 down.
    expect(mine.rightList.rows.map((r) => r.rank)).toEqual(Array.from({ length: ROOF_ROWS }, (_, i) => i + 4));
    expect(mine.rightList.rows.map((r) => r.handle)).not.toContain("NOTHING-9000");
    expect(mine.rightList.bot).toEqual({ rank: ROOF_ROWS + 5, perCall: expect.any(Number), spread: 0 });
    expect(mine.rightList.bot!.perCall).toBeLessThan(0);
  });

  it("the Season Stack: GM won and lost on City markets, by handle, neighbours only, without the reader's hidden", async () => {
    const t = fresh();
    const [reader, other, staff, a, b, e, n] = await Promise.all(Array.from({ length: 7 }, () => makeResident(db)));
    await pon([a!, b!, e!]); // n hasn't passed Proof of Neighbour
    await client`INSERT INTO staff (user_id, role) VALUES (${staff!}, 'moderator')`;
    const m = await createCityMarket(db, staff!, { question: "Will the Roof stay up?", kind: "manual", bellDay: dayOf(t) }, { now: new Date(t) });
    for (const [u, side, stake] of [[a!, "yes", 100], [n!, "yes", 80], [b!, "yes", 50], [e!, "no", 90]] as const) {
      await topUp(u, t);
      await stakeCity(db, u, { marketId: m.id, side, stake }, { now: new Date(t + H) });
    }
    await resolveCityMarket(db, staff!, m.id, "yes");
    await settleCityMarkets(db, dayOf(t), new Date(t + D));
    await rang(dayOf(t));
    await muteUser(db, reader!, b!);
    const handle = async (u: string) => (await client`SELECT handle FROM residents WHERE user_id = ${u}`)[0]!.handle as string;

    const everyone = (await roofBoards(db, other!, { now: new Date(t + D + MIN) })).seasonStack.rows;
    expect(everyone.map((r) => r.handle)).toEqual([await handle(a!), await handle(b!), await handle(e!)]);
    expect(everyone.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(everyone[0]!.profit).toBeGreaterThan(everyone[1]!.profit);
    expect(everyone[2]).toEqual({ rank: 3, handle: await handle(e!), profit: -90 });
    // n won and was paid like anyone, but only neighbours are ranked, in
    // Games too: the plan keeps leaderboards to Proof of Neighbour accounts.
    expect((await client`SELECT payout FROM city_positions WHERE market_id = ${m.id} AND user_id = ${n!}`)[0]!.payout).toBeGreaterThan(80);
    expect((await seasonStack(db, { now: new Date(t + D + MIN) })).rows.map((r) => r.userId)).not.toContain(n!);
    const mine = (await roofBoards(db, reader!, { now: new Date(t + D + MIN) })).seasonStack.rows;
    expect(mine.map((r) => [r.rank, r.handle])).toEqual([[1, await handle(a!)], [3, await handle(e!)]]);
  });

  it("the crews: the last bell's top 3 Bell Scores and the latest League champions, by name", async () => {
    const t = fresh();
    const leads = await Promise.all(Array.from({ length: 5 }, () => makeResident(db)));
    const crewIds: string[] = [];
    for (const [i, u] of leads.entries()) crewIds.push((await createCrew(db, u, { name: `Roof Crew ${randomUUID().slice(0, 4)}${i}` })).id);
    const names = await Promise.all(crewIds.map(async (id) => (await client`SELECT name FROM crews WHERE id = ${id}`)[0]!.name as string));
    const bellDay = dayOf(t);
    const score = (day: string, crew: string, milli: number) => client`INSERT INTO crew_bell_scores (bell_day, crew_id, chips, long_shots, chain_days, score_milli) VALUES (${day}, ${crew}, 1, 0, 0, ${milli})`;
    await score(bellDay, crewIds[0]!, 1000);
    await score(bellDay, crewIds[1]!, 4500);
    await score(bellDay, crewIds[2]!, 2250);
    await score(bellDay, crewIds[3]!, 3000);
    await score(addDays(bellDay, -1), crewIds[4]!, 99_000); // an older bell's
    const reader = await makeResident(db);
    await rang(addDays(bellDay, -1));
    const before = await roofBoards(db, reader, { now: new Date(t + H) }); // the bell for that day hasn't rung
    expect(before.crews.bellScores.map((s) => s.name)).toEqual([names[4]]);

    // The League: champions of the latest week up to today, small to large.
    const week = addDays(bellDay, -10);
    const row = (w: string, crew: string, group: string, champion: boolean) =>
      client`INSERT INTO league_weeks (week, crew_id, size_group, division, rank, score_milli, moved, champion) VALUES (${w}, ${crew}, ${group}, 1, ${champion ? 1 : 2}, 1000, 'stayed', ${champion})`;
    await row(addDays(week, -7), crewIds[0]!, "small", true); // last week's
    await row(week, crewIds[2]!, "large", true);
    await row(week, crewIds[3]!, "small", true);
    await row(week, crewIds[1]!, "small", false);
    await row(addDays(bellDay, 30), crewIds[4]!, "small", true); // a week that hasn't happened

    await rang(bellDay);
    const after = await roofBoards(db, reader, { now: new Date(t + D) });
    expect(after.crews.bellDay).toBe(bellDay);
    expect(after.crews.bellScores).toEqual([
      { rank: 1, name: names[1], score: 4.5 },
      { rank: 2, name: names[3], score: 3 },
      { rank: 3, name: names[2], score: 2.25 },
    ]);
    expect(after.crews.league).toEqual({ week, champions: [{ sizeGroup: "small", name: names[3] }, { sizeGroup: "large", name: names[2] }] });
    expect(JSON.stringify(after.crews)).not.toMatch(/crewId|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("until the bell's steps have run, the boards stand as at the bell before, and bellAt says which bell that is", async () => {
    // A Sunday, so its bell (Monday's) runs the League as well as the Tower
    // step, and not a season's last day, so the read stays in its season.
    let t = fresh();
    t += ((7 - cityWeekday(dayOf(t))) % 7) * D;
    if (seasonOf(dayOf(t)) !== seasonOf(dayOf(t + D))) t += 7 * D;
    base = t; // the next test's season counts from here
    const [sunday, saturday] = [dayOf(t), dayOf(t - D)];
    const [reader, a, lead1, lead2] = await Promise.all(Array.from({ length: 4 }, () => makeResident(db)));
    await pon([a!]);
    await settledSeason(t, [{ id: a!, side: "yes", chance: 70 }]);
    const [old, tonight] = [await createCrew(db, lead1!, { name: `Roof Crew ${randomUUID().slice(0, 4)}o` }), await createCrew(db, lead2!, { name: `Roof Crew ${randomUUID().slice(0, 4)}n` })];
    await client`INSERT INTO crew_bell_scores (bell_day, crew_id, chips, long_shots, chain_days, score_milli) VALUES (${saturday}, ${old.id}, 1, 0, 0, 1500), (${sunday}, ${tonight.id}, 1, 0, 0, 2500)`;
    await rang(saturday);
    const handle = (await client`SELECT handle FROM residents WHERE user_id = ${a!}`)[0]!.handle as string;
    // Monday 09:00: the bell rang at 00:00, but its runner hasn't got there.
    const read = async () => {
      const r = await roofBoards(db, reader!, { now: new Date(t + D) });
      return { bellAt: r.bellAt.toISOString(), bellDay: r.crews.bellDay, scores: r.crews.bellScores.map((s) => s.score), onList: r.rightList.rows.some((x) => x.handle === handle) };
    };
    const before = { bellAt: `${sunday}T00:00:00.000Z`, bellDay: saturday, scores: [1.5], onList: false };
    expect(await read()).toEqual(before);
    await rang(sunday, ["tower"]);
    expect(await read()).toEqual(before); // Monday's bell isn't done until the League is
    await rang(sunday, ["league"]);
    expect(await read()).toEqual({ bellAt: `${dayOf(t + D)}T00:00:00.000Z`, bellDay: sunday, scores: [2.5], onList: true });
  });

  it("asks who's looking, and refuses anything that isn't an id", async () => {
    for (const bad of [undefined, null, "", "not-a-uuid", 7, {}]) {
      await expect(roofBoards(db, bad)).rejects.toBeInstanceOf(TowerError);
    }
  });
});
