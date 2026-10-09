import { randomUUID } from "node:crypto";
import type { FeedMarket, OddsProvider } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DuelError,
  GrudgeError,
  challenge,
  createCrew,
  createDb,
  createInvite,
  ensureSystemAccounts,
  isFlaggedPair,
  makeCall,
  offerGrudge,
  pairFlows,
  pollOdds,
  redeemInvite,
  runAltChecks,
  setDuelPrefs,
  staffAltFlags,
} from "../src";
import { makeResident } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const H = 3_600_000;
const D = 24 * H;
const now = new Date("2043-03-10T12:00:00Z");
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

// A settled City market in the window where `loser` staked `amount` on the losing side and `winner` on the winning one.
async function cityFlow(staff: string, loser: string, winner: string, amount: number, daysAgo: number) {
  const [m] = await client`INSERT INTO city_markets (question, kind, bell_day, locks_at, status, outcome, created_by, created_at)
    VALUES ('Alt test market?', 'manual', ${day(now.getTime() - daysAgo * D)}, ${new Date(now.getTime() - daysAgo * D).toISOString()}, 'settled', true, ${staff}, now()) RETURNING id`;
  await client`INSERT INTO city_positions (market_id, user_id, side, stake, payout, created_at) VALUES
    (${m!.id}, ${loser}, 'no', ${amount}, 0, now()), (${m!.id}, ${winner}, 'yes', ${amount}, ${amount * 2}, now())`;
}

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof DuelError || e instanceof GrudgeError) return e.code;
    throw e;
  }
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("alt checks", () => {
  it("flags 500+ one way with under 20% back; a two-way rivalry isn't flagged; once a day", async () => {
    const staff = await makeResident(db);
    await client`INSERT INTO staff (user_id, role) VALUES (${staff}, 'moderator')`;
    const [a, b, c, d] = [await makeResident(db), await makeResident(db), await makeResident(db), await makeResident(db)];
    await cityFlow(staff, a, b, 600, 3); // a → b 600, nothing back
    await cityFlow(staff, c, d, 600, 3); // c → d 600 ...
    await cityFlow(staff, d, c, 200, 2); // ... and 200 back: 33%
    await cityFlow(staff, a, c, 700, 20); // outside the 14 days
    const r = await runAltChecks(db, { now });
    expect(r.flagged).toBeGreaterThanOrEqual(1);
    expect(await isFlaggedPair(db, a, b, now)).toBe(true);
    expect(await isFlaggedPair(db, b, a, now)).toBe(true);
    expect(await isFlaggedPair(db, c, d, now)).toBe(false);
    expect(await isFlaggedPair(db, a, c, now)).toBe(false);
    const [low, high] = a < b ? [a, b] : [b, a];
    expect((await client`SELECT from_user, to_user, amount, back FROM alt_flags WHERE low = ${low} AND high = ${high}`)[0]).toEqual({ from_user: a, to_user: b, amount: 600, back: 0 });
    expect((await runAltChecks(db, { now })).flagged).toBe(0); // already flagged today
    expect(await isFlaggedPair(db, a, b, new Date(now.getTime() + 15 * D))).toBe(false); // the flag ages out
    expect(await staffAltFlags(db, a)).toBeNull();
    expect((await staffAltFlags(db, staff))!.some((f) => f.fromUser === a)).toBe(true);
  });

  it("a flagged pair can't Fade Duel or Grudge Match each other", async () => {
    const t = Date.parse("2043-03-11T10:00:00Z"); // a fixed day, so the market always settles before the bell
    const ms = new Map<string, FeedMarket>();
    const provider: OddsProvider = { source: "alt-test", fetch: async () => [...ms.values()].map((m) => ({ ...m })) };
    const m: FeedMarket = { externalId: randomUUID(), question: "Alt duel?", category: "sports", ladder: null, freezesAt: new Date(t + H), settlesBy: new Date(t + 2 * H), price: 50, resolved: null, voided: false };
    ms.set(m.externalId, m);
    await pollOdds(db, provider, { now: new Date(t - 1000) });
    const [mk] = await client`SELECT id FROM markets WHERE external_id = ${m.externalId}`;
    // An inviter and the newcomer they brought in, on opposite sides.
    const inviter = await makeResident(db);
    const newcomer = await makeResident(db);
    await createCrew(db, inviter, { name: `Alt ${randomUUID().slice(0, 6)}` });
    await redeemInvite(db, newcomer, (await createInvite(db, inviter)).code);
    for (const u of [inviter, newcomer]) {
      await client`UPDATE users SET proof_of_neighbour_at = now() WHERE id = ${u}`;
      await setDuelPrefs(db, u, { duelsOn: true });
    }
    await makeCall(db, inviter, { marketId: mk!.id, side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(t) });
    await makeCall(db, newcomer, { marketId: mk!.id, side: "no", chance: 40, seenPrice: 50 }, { now: new Date(t) });
    await pollOdds(db, provider, { now: new Date(t + 1000) });
    const [low, high] = inviter < newcomer ? [inviter, newcomer] : [newcomer, inviter];
    await client`INSERT INTO alt_flags (city_day, low, high, from_user, to_user, amount, back, created_at) VALUES (${day(t)}, ${low}, ${high}, ${newcomer}, ${inviter}, 900, 0, now())`;
    expect(await code(challenge(db, inviter, { marketId: mk!.id, opponentId: newcomer }, { now: new Date(t + 2000) }))).toBe("ALT_FLAGGED");
    expect(await code(offerGrudge(db, newcomer, { now: new Date(t + 2000) }))).toBe("ALT_FLAGGED");
  });
});

describe("the flow graph", () => {
  it("duels pay the loser's stake, a retreat pays the ante, a Grudge Match pays 10", async () => {
    const t = Date.parse("2043-06-01T10:00:00Z");
    const provider: OddsProvider = { source: "alt-flow", fetch: async () => [{ externalId: `alt-flow-${randomUUID()}`, question: "Flows?", category: "sports", ladder: null, freezesAt: new Date(t + H), settlesBy: new Date(t + 2 * H), price: 50, resolved: null, voided: false }] };
    await pollOdds(db, provider, { now: new Date(t) });
    const [mk] = await client`SELECT id FROM markets WHERE source = 'alt-flow' ORDER BY created_at DESC LIMIT 1`;
    const [x, y, z] = [await makeResident(db), await makeResident(db), await makeResident(db)];
    const ended = new Date(t + 3 * H).toISOString();
    // x beat y in a 40-each duel; z retreated against x; y beat z in a Grudge Match.
    await client`INSERT INTO duels (market_id, challenger_id, opponent_id, challenger_side, status, stake_challenger, stake_opponent, winner_id, created_at, ended_at)
      VALUES (${mk!.id}, ${x}, ${y}, 'yes', 'settled', 40, 40, ${x}, now(), ${ended})`;
    await client`INSERT INTO duels (market_id, challenger_id, opponent_id, challenger_side, status, stake_challenger, stake_opponent, retreated_by, created_at, ended_at)
      VALUES (${mk!.id}, ${z}, ${x}, 'no', 'retreated', 20, 20, ${z}, now(), ${ended})`;
    await client`INSERT INTO grudge_matches (city_day, newcomer_id, inviter_id, status, winner_id, created_at, ended_at)
      VALUES (${day(t)}, ${z}, ${y}, 'settled', ${y}, now(), ${ended})`;
    const flows = await pairFlows(db, new Date(t), new Date(t + D));
    const get = (p: string, q: string) => {
      const [a, b] = p < q ? [p, q] : [q, p];
      const f = flows.find((r) => r.a === a && r.b === b);
      return f ? (p === a ? f.ab : f.ba) : 0;
    };
    expect(get(y, x)).toBe(40);
    expect(get(z, x)).toBe(10);
    expect(get(z, y)).toBe(10);
    expect(get(x, y)).toBe(0);
  });
});
