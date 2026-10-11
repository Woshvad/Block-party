import { randomUUID } from "node:crypto";
import { type FeedMarket, type OddsProvider, cityAccountId, crewPotAccountId } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SyndicateError,
  createCityMarket,
  createCrew,
  createDb,
  createInvite,
  crewTable,
  depositToPot,
  ensureSystemAccounts,
  getBalance,
  makeCall,
  openGmStakes,
  pollOdds,
  proposeSyndicate,
  redeemInvite,
  resolveCityMarket,
  runBell,
  sayGm,
  setPrefs,
  shakeSyndicate,
  stakeCity,
} from "../src";
import { makeResident, releaseTogether } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
let day0 = Date.parse("2039-03-07T00:00:00Z");
const freshDay = () => (day0 += 3 * D);
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof SyndicateError) return e.code;
    throw e;
  }
}
async function crewOfSize(n: number) {
  const people = await Promise.all(Array.from({ length: n }, () => makeResident(db)));
  const crew = await createCrew(db, people[0]!, { name: `Synd ${randomUUID().slice(0, 6)}` });
  for (const u of people.slice(1)) await redeemInvite(db, u, (await createInvite(db, people[0]!)).code);
  return { people, crewId: crew.id };
}
async function towerMarket(d0: number) {
  const ms = new Map<string, FeedMarket>();
  const provider: OddsProvider = { source: "synd-test", fetch: async () => [...ms.values()].map((m) => ({ ...m })) };
  const m: FeedMarket = { externalId: randomUUID(), question: "Crew call?", category: "sports", ladder: null, freezesAt: new Date(d0 + 16 * H), settlesBy: new Date(d0 + 20 * H), price: 40, resolved: null, voided: false };
  ms.set(m.externalId, m);
  await pollOdds(db, provider, { now: new Date(d0 + 9 * H - MIN) });
  return (await client`SELECT id FROM markets WHERE external_id = ${m.externalId}`)[0]!.id as string;
}
async function staffer() {
  const s = await makeResident(db);
  await client`INSERT INTO staff (user_id, role) VALUES (${s}, 'moderator')`;
  return s;
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("a syndicate on a Tower market", () => {
  it("each shake is the shaker's own free call on that side; live at the threshold; the crew is pinged", async () => {
    const d0 = freshDay();
    const id = await towerMarket(d0);
    const { people } = await crewOfSize(8);
    const at = new Date(d0 + 9 * H);
    for (const u of people) await sayGm(db, u, { now: new Date(d0 + H) }); // 8 active: 2 shakes needed
    await setPrefs(db, people[1]!, { alerts: ["syndicate_shake"] });
    const p = await proposeSyndicate(db, people[0]!, { marketId: id, side: "yes" }, { now: at });
    expect(p).toMatchObject({ status: "proposed", shakes: 1, needed: 2 });
    expect((await client`SELECT kind FROM notifications WHERE user_id = ${people[1]!}`).map((r) => r.kind)).toEqual(["syndicate_shake"]);
    expect(await shakeSyndicate(db, people[1]!, p.id, { chance: 55 }, { now: at })).toMatchObject({ status: "live", shakes: 2 });
    const mine = await client`SELECT user_id, side, chance FROM calls WHERE market_id = ${id} ORDER BY chance`;
    expect(mine.map((c) => [c.side, c.chance])).toEqual([["yes", 50], ["yes", 55]]); // the proposer at the slider start, the shaker at 55
    expect(await code(shakeSyndicate(db, people[1]!, p.id, {}, { now: at }))).toBe("ALREADY_SHOOK");
    // Someone who already called NO can't shake a YES syndicate.
    await makeCall(db, people[2]!, { marketId: id, side: "no", chance: 30, seenPrice: 40 }, { now: at });
    expect(await code(shakeSyndicate(db, people[2]!, p.id, {}, { now: at }))).toBe("OTHER_SIDE");
    // Not your crew's.
    expect(await code(shakeSyndicate(db, await makeResident(db), p.id, {}, { now: at }))).toBe("NOT_IN_CREW");
    expect(await code(proposeSyndicate(db, people[3]!, { marketId: id, side: "no" }, { now: at }))).toBe("ALREADY_PROPOSED");
    const table = await crewTable(db, people[0]!, { now: at });
    expect(table[0]).toMatchObject({ status: "live", needed: 2 });
    expect(table[0]!.shook).toHaveLength(2);
  });

  it("expires after 2 hours unshaken", async () => {
    const d0 = freshDay();
    const id = await towerMarket(d0);
    const { people } = await crewOfSize(8);
    for (const u of people) await sayGm(db, u, { now: new Date(d0 + H) });
    const at = new Date(d0 + 9 * H);
    const p = await proposeSyndicate(db, people[0]!, { marketId: id, side: "no" }, { now: at });
    await pollOdds(db, { source: "synd-test", fetch: async () => [] }, { now: new Date(at.getTime() + 2 * H) }); // keep the feed alive
    expect(await code(shakeSyndicate(db, people[1]!, p.id, {}, { now: new Date(at.getTime() + 2 * H + MIN) }))).toBe("EXPIRED");
    expect((await crewTable(db, people[0]!, { now: new Date(at.getTime() + 2 * H + MIN) }))[0]!.status).toBe("expired");
  });
});

describe("a syndicate on a City market", () => {
  it("stakes from the pot per shake once live, tops up, pays back into the pot", async () => {
    const d0 = freshDay();
    const s = await staffer();
    const m = await createCityMarket(db, s, { question: "Will the crew pot grow?", kind: "manual", bellDay: dayOf(d0) }, { now: new Date(d0) });
    const { people, crewId } = await crewOfSize(4); // nobody said gm: 1 shake needed
    await depositToPot(db, people[0]!, 100, `pot:${randomUUID()}`);
    const at = new Date(d0 + 10 * H);
    expect(await code(proposeSyndicate(db, people[0]!, { cityMarketId: m.id, side: "yes", perShake: 51 }, { now: at }))).toBe("INVALID_INPUT");
    const p = await proposeSyndicate(db, people[0]!, { cityMarketId: m.id, side: "yes", perShake: 30 }, { now: at });
    expect(p).toMatchObject({ status: "live", shakes: 1 });
    expect(await getBalance(db, cityAccountId(m.id))).toBe(30);
    await shakeSyndicate(db, people[1]!, p.id, {}, { now: at });
    await shakeSyndicate(db, people[2]!, p.id, {}, { now: at });
    expect(await getBalance(db, cityAccountId(m.id))).toBe(90);
    await shakeSyndicate(db, people[3]!, p.id, {}, { now: at }); // the pot only has 10 left
    expect(await getBalance(db, cityAccountId(m.id))).toBe(100);
    expect(await getBalance(db, crewPotAccountId(crewId))).toBe(0);
    // Pot GM on a stake is the crew's, not any one shaker's: it never counts toward their rent or drip.
    for (const u of people) expect(await openGmStakes(db, u)).toBe(0);
    // A resident takes the other side; YES wins; the crew's winnings go back to the pot.
    const rival = await makeResident(db);
    await stakeCity(db, rival, { marketId: m.id, side: "no", stake: 50 }, { now: at });
    await resolveCityMarket(db, s, m.id, "yes");
    await runBell(db, { now: new Date(d0 + D + 5 * MIN), only: ["tower"] });
    expect(await getBalance(db, crewPotAccountId(crewId))).toBe(100 + 50); // stake back + the rival's 50 (a win of exactly 50 pays no bell burn)
  });

  it("racing shakes at the threshold stake exactly once each", async () => {
    const d0 = freshDay();
    const s = await staffer();
    const m = await createCityMarket(db, s, { question: "Racing shakes ok?", kind: "manual", bellDay: dayOf(d0) }, { now: new Date(d0) });
    const { people } = await crewOfSize(8);
    for (const u of people) await sayGm(db, u, { now: new Date(d0 + H) }); // 2 needed
    await depositToPot(db, people[0]!, 500, `pot:${randomUUID()}`);
    const at = new Date(d0 + 10 * H);
    const p = await proposeSyndicate(db, people[0]!, { cityMarketId: m.id, side: "no", perShake: 20 }, { now: at });
    const res = await releaseTogether(client, "SELECT 1 FROM syndicates WHERE id = $1 FOR UPDATE", [p.id], 4, people.slice(1, 5).map((u) => () => shakeSyndicate(db, u, p.id, {}, { now: at })));
    expect(res.every((r) => r.ok)).toBe(true);
    expect(await getBalance(db, cityAccountId(m.id))).toBe(5 * 20);
  });
});
