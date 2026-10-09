import { randomUUID } from "node:crypto";
import { type FeedMarket, type OddsProvider, grudgeAccountId, userAccountId } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GrudgeError,
  blockUser,
  cancelGrudge,
  createCrew,
  createDb,
  createInvite,
  ensureSystemAccounts,
  getBalance,
  makeCall,
  offerGrudge,
  pollOdds,
  publishSlate,
  redeemInvite,
  respondGrudge,
  runBell,
} from "../src";
import { makeResident, releaseTogether } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
let day0 = Date.parse("2037-02-03T00:00:00Z");
const freshDay = () => (day0 += 5 * D);
const bal = (u: string) => getBalance(db, userAccountId(u));

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof GrudgeError) return e.code;
    throw e;
  }
}
// An inviter and the newcomer who joined through their crew invite.
async function pair() {
  const inviter = await makeResident(db);
  const newcomer = await makeResident(db);
  await createCrew(db, inviter, { name: `Grudge ${randomUUID().slice(0, 6)}` });
  await redeemInvite(db, newcomer, (await createInvite(db, inviter)).code);
  return { inviter, newcomer };
}
// Tomorrow's Slate (relative to `offerDay`), with both sides' calls.
async function slateFor(d0: number) {
  const ms = new Map<string, FeedMarket>();
  const provider: OddsProvider = { source: "grudge-test", fetch: async () => [...ms.values()].map((m) => ({ ...m })) };
  for (const p of [80, 50, 60, 30, 20, 8]) {
    const m: FeedMarket = { externalId: randomUUID(), question: `G ${p}?`, category: "sports", ladder: null, freezesAt: new Date(d0 + 16 * H), settlesBy: new Date(d0 + 20 * H), price: p, resolved: null, voided: false };
    ms.set(m.externalId, m);
  }
  await pollOdds(db, provider, { now: new Date(d0 + 9 * H - MIN) });
  await publishSlate(db, { now: new Date(d0 + 9 * H - MIN) });
  const ids = (await client`SELECT market_id FROM slate_cards WHERE city_day = ${new Date(d0).toISOString().slice(0, 10)} ORDER BY slot`).map((r) => r.market_id as string);
  return { provider, ms: [...ms.values()], ids };
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("the Grudge Match", () => {
  it("newcomer vs inviter on tomorrow's Slate: higher Aura takes the 20 GM pot", async () => {
    const d0 = freshDay();
    const { inviter, newcomer } = await pair();
    const [n0, i0] = [await bal(newcomer), await bal(inviter)];
    const g = await offerGrudge(db, newcomer, { now: new Date(d0 - 12 * H) });
    expect(g.cityDay).toBe(new Date(d0).toISOString().slice(0, 10));
    expect(await getBalance(db, grudgeAccountId(g.id))).toBe(10);
    expect(await code(respondGrudge(db, newcomer, g.id, true, { now: new Date(d0 - 11 * H) }))).toBe("NOT_YOURS");
    await respondGrudge(db, inviter, g.id, true, { now: new Date(d0 - 11 * H) });
    const s = await slateFor(d0);
    // The first Coin Flip card (which of 50 and 60 sits in slot 1 is the day's hash):
    // newcomer YES 10 points above it (it hits); inviter NO 10 points below.
    const [card] = await client`SELECT question, price FROM markets WHERE id = ${s.ids[1]!}`;
    const p = card!.price as number;
    await makeCall(db, newcomer, { marketId: s.ids[1], side: "yes", chance: p + 10, seenPrice: p }, { now: new Date(d0 + 9 * H) });
    await makeCall(db, inviter, { marketId: s.ids[1], side: "no", chance: p - 10, seenPrice: p }, { now: new Date(d0 + 9 * H) });
    await pollOdds(db, s.provider, { now: new Date(d0 + 9 * H + MIN) });
    const flip = s.ms.find((m) => m.question === card!.question)!;
    for (const m of s.ms) m.resolved = m === flip;
    await pollOdds(db, s.provider, { now: new Date(d0 + 21 * H) });
    const r = await runBell(db, { now: new Date(d0 + D + 5 * MIN), only: ["tower"] });
    expect(r.ran.tower).toMatchObject({ grudgesSettled: 1 });
    expect((await bal(newcomer)) - n0).toBeGreaterThanOrEqual(10); // +10 from the pot (and any stamps/streak)
    const [m] = await client`SELECT status, winner_id FROM grudge_matches WHERE id = ${g.id}`;
    expect(m).toEqual({ status: "settled", winner_id: newcomer });
    expect(await getBalance(db, grudgeAccountId(g.id))).toBe(0);
    // Exactly the pot moved between them, net of what the day's calls paid each.
    const streakN = Number((await client`SELECT COALESCE(SUM(e.amount),0)::int AS n FROM gm_entries e JOIN gm_transactions t ON t.id = e.tx_id WHERE e.account_id = ${userAccountId(newcomer)} AND t.kind = 'streak_bonus'`)[0]!.n);
    const streakI = Number((await client`SELECT COALESCE(SUM(e.amount),0)::int AS n FROM gm_entries e JOIN gm_transactions t ON t.id = e.tx_id WHERE e.account_id = ${userAccountId(inviter)} AND t.kind = 'streak_bonus'`)[0]!.n);
    expect((await bal(newcomer)) - n0 - streakN).toBe(10);
    expect((await bal(inviter)) - i0 - streakI).toBe(-10);
  });

  it("a tie (or nobody calling) gives both stakes back; an unanswered offer goes home at the bell", async () => {
    const d0 = freshDay();
    const p1 = await pair();
    const p2 = await pair();
    const [a0, b0, c0] = [await bal(p1.newcomer), await bal(p1.inviter), await bal(p2.newcomer)];
    const g1 = await offerGrudge(db, p1.newcomer, { now: new Date(d0 - 12 * H) });
    await respondGrudge(db, p1.inviter, g1.id, true, { now: new Date(d0 - 11 * H) });
    const g2 = await offerGrudge(db, p2.newcomer, { now: new Date(d0 - 12 * H) });
    await runBell(db, { now: new Date(d0 + D + 5 * MIN), only: ["tower"] });
    expect((await client`SELECT status FROM grudge_matches WHERE id = ${g1.id}`)[0]!.status).toBe("tied");
    expect((await client`SELECT status FROM grudge_matches WHERE id = ${g2.id}`)[0]!.status).toBe("expired");
    expect([await bal(p1.newcomer), await bal(p1.inviter), await bal(p2.newcomer)]).toEqual([a0, b0, c0]);
  });

  it("tonight's bell leaves tomorrow's match alone", async () => {
    const d0 = freshDay();
    const { newcomer } = await pair();
    const g = await offerGrudge(db, newcomer, { now: new Date(d0 - 12 * H) }); // for day d0
    await runBell(db, { now: new Date(d0 + 5 * MIN), only: ["tower"] }); // the bell that closes d0 - 1
    expect((await client`SELECT status FROM grudge_matches WHERE id = ${g.id}`)[0]!.status).toBe("offered");
  });

  it("only against your own inviter, once per pair ever (either way round), never across a block", async () => {
    const d0 = freshDay();
    const loner = await makeResident(db);
    expect(await code(offerGrudge(db, loner, { now: new Date(d0) }))).toBe("NO_INVITER");
    const { inviter, newcomer } = await pair();
    const g = await offerGrudge(db, newcomer, { now: new Date(d0) });
    await respondGrudge(db, inviter, g.id, false, { now: new Date(d0) });
    expect(await code(offerGrudge(db, newcomer, { now: new Date(d0 + D) }))).toBe("ONCE_PER_PAIR"); // even after a decline
    const p = await pair();
    await blockUser(db, p.inviter, p.newcomer);
    expect(await code(offerGrudge(db, p.newcomer, { now: new Date(d0) }))).toBe("BLOCKED");
  });

  it("racing offers make one match; take-backs and late answers behave", async () => {
    const d0 = freshDay();
    const { inviter, newcomer } = await pair();
    const n0 = await bal(newcomer);
    const res = await releaseTogether(client, "LOCK TABLE grudge_matches IN SHARE ROW EXCLUSIVE MODE", [], 1, [1, 2, 3].map(() => () => code(offerGrudge(db, newcomer, { now: new Date(d0) }))));
    expect(res.map((r) => (r.ok ? r.v : "THREW")).sort()).toEqual(["OK", "ONCE_PER_PAIR", "ONCE_PER_PAIR"]);
    expect((await bal(newcomer)) - n0).toBe(-10);
    const [g] = await client`SELECT id, city_day FROM grudge_matches WHERE newcomer_id = ${newcomer}`;
    expect(await code(respondGrudge(db, inviter, g!.id, true, { now: new Date(d0 + 3 * D) }))).toBe("TOO_LATE");
    expect(await code(cancelGrudge(db, inviter, g!.id))).toBe("NOT_YOURS");
    await cancelGrudge(db, newcomer, g!.id);
    expect(await bal(newcomer)).toBe(n0);
    expect(await code(respondGrudge(db, inviter, g!.id, "yes", { now: new Date(d0) }))).toBe("INVALID_INPUT");
    expect(await code(respondGrudge(db, inviter, "nope", true, { now: new Date(d0) }))).toBe("NO_SUCH_MATCH");
  });
});
