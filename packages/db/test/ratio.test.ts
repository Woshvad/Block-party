import { randomUUID } from "node:crypto";
import type { FeedMarket, OddsProvider } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RatioError,
  type WhereCheck,
  createDb,
  ensureSystemAccounts,
  hideRatioEntry,
  makeCall,
  pickRatioPrompt,
  pollOdds,
  ratioPair,
  receipt,
  reel,
  runBell,
  submitRatio,
  todaysRatio,
  voteRatio,
} from "../src";
import { makeResident } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
let day0 = Date.parse("2041-05-06T00:00:00Z");
const freshDay = () => (day0 += 3 * D);
const onRoof: WhereCheck = async (_u, place) => (place === "roof" ? 1 : null);
const offRoof: WhereCheck = async () => null;

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof RatioError) return e.code;
    throw e;
  }
}
// A day whose biggest Vibe Gap is market "big" (world 10, the city at 60).
async function gapDay() {
  const d0 = freshDay();
  const ms = new Map<string, FeedMarket>();
  const provider: OddsProvider = { source: "ratio-test", fetch: async () => [...ms.values()].map((m) => ({ ...m })) };
  const add = (price: number) => {
    const m: FeedMarket = { externalId: randomUUID(), question: `R ${price}?`, category: "sports", ladder: null, freezesAt: new Date(d0 + 17 * H), settlesBy: new Date(d0 + 20 * H), price, resolved: null, voided: false };
    ms.set(m.externalId, m);
    return m;
  };
  const small = add(50); // created first, so "the first one" would be wrong
  const big = add(10);
  const thin = add(5); // a bigger gap, but only 9 neighbours called it: not eligible
  await pollOdds(db, provider, { now: new Date(d0 + 9 * H - MIN) });
  const id = async (m: FeedMarket) => (await client`SELECT id FROM markets WHERE external_id = ${m.externalId}`)[0]!.id as string;
  const [bigId, smallId, thinId] = [await id(big), await id(small), await id(thin)];
  const crowd = await Promise.all(Array.from({ length: 10 }, () => makeResident(db)));
  await client`UPDATE users SET proof_of_neighbour_at = now() WHERE id IN ${client(crowd)}`;
  for (const u of crowd) {
    await client`INSERT INTO tickets (user_id, balance, as_of) VALUES (${u}, 9, ${new Date(d0).toISOString().slice(0, 10)})`;
    await makeCall(db, u, { marketId: bigId, side: "yes", chance: 60, seenPrice: 10 }, { now: new Date(d0 + 9 * H) });
    await makeCall(db, u, { marketId: smallId, side: "yes", chance: 55, seenPrice: 50 }, { now: new Date(d0 + 9 * H) });
  }
  for (const u of crowd.slice(0, 9)) await makeCall(db, u, { marketId: thinId, side: "yes", chance: 95, seenPrice: 5 }, { now: new Date(d0 + 9 * H) });
  await pollOdds(db, provider, { now: new Date(d0 + 9 * H + MIN) });
  return { d0, provider, big, bigId, crowd };
}
const ponned = async () => {
  const u = await makeResident(db);
  await client`UPDATE users SET proof_of_neighbour_at = now() WHERE id = ${u}`;
  return u;
};

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("the Ratio of the Day", () => {
  it("at 18:00 the day's biggest Vibe Gap becomes the prompt, once", async () => {
    const g = await gapDay();
    expect(await pickRatioPrompt(db, { now: new Date(g.d0 + 17 * H) })).toBeNull();
    const p = await pickRatioPrompt(db, { now: new Date(g.d0 + 18 * H) });
    expect(p).toMatchObject({ marketId: g.bigId, world: 10, city: 60 });
    expect((await pickRatioPrompt(db, { now: new Date(g.d0 + 19 * H) }))!.createdAt).toEqual(p!.createdAt);
    expect((await todaysRatio(db, { now: new Date(g.d0 + 19 * H) }))!.prompt).toBe("World 10% · City 60%. Write the headline for when it settles.");
  });

  it("a market that already passed its settle time is never the prompt", async () => {
    const g = await gapDay(); // its markets settle at 20:00
    expect(await pickRatioPrompt(db, { now: new Date(g.d0 + 21 * H) })).toBeNull();
  });

  it("one headline each, up to 80 characters, through the filter, until 23:00", async () => {
    const g = await gapDay();
    const u = await makeResident(db);
    expect(await code(submitRatio(db, u, "Too early", { now: new Date(g.d0 + 17 * H) }))).toBe("NO_PROMPT");
    await pickRatioPrompt(db, { now: new Date(g.d0 + 18 * H) });
    const at = new Date(g.d0 + 19 * H);
    expect(await code(submitRatio(db, u, "x".repeat(81), { now: at }))).toBe("INVALID_INPUT");
    // A pasted private key is refused outright.
    expect(await code(submitRatio(db, u, `key 0x${"a1".repeat(32)}`, { now: at }))).toBe("MODERATED");
    // Staff's blocked words are refused here too.
    expect(await code(submitRatio(db, u, "City is a b4dword", { now: at, blockedWords: ["badword"] }))).toBe("MODERATED");
    // Links never get in: the filter strips them.
    const linky = await makeResident(db);
    expect((await submitRatio(db, linky, "free money at scam.com now", { now: at })).text).toBe("free money at [link removed] now");
    expect(await submitRatio(db, u, "City copes as world shrugs", { now: at })).toMatchObject({ text: "City copes as world shrugs" });
    expect(await code(submitRatio(db, u, "Second try", { now: at }))).toBe("ALREADY_IN");
    expect(await code(submitRatio(db, await makeResident(db), "Too late", { now: new Date(g.d0 + 23 * H) }))).toBe("CLOSED");
  });

  it("the Roof votes head-to-head from 23:00: Proof of Neighbour, in person, never your own, once per pair", async () => {
    const g = await gapDay();
    await pickRatioPrompt(db, { now: new Date(g.d0 + 18 * H) });
    const authors = await Promise.all(Array.from({ length: 3 }, () => makeResident(db)));
    const texts = ["Headline one", "Headline two", "Headline three"];
    const entries = [];
    for (const [i, u] of authors.entries()) entries.push(await submitRatio(db, u, texts[i], { now: new Date(g.d0 + 19 * H) }));
    const v = await ponned();
    const vote = new Date(g.d0 + 23 * H + MIN);
    expect(await code(ratioPair(db, v, { now: new Date(g.d0 + 22 * H), where: onRoof }))).toBe("NOT_YET");
    expect(await code(ratioPair(db, await makeResident(db), { now: vote, where: onRoof }))).toBe("NEEDS_PON");
    expect(await code(ratioPair(db, v, { now: vote, where: offRoof }))).toBe("NOT_ON_ROOF");
    // Three entries: three pairs, then none left.
    for (let i = 0; i < 3; i++) {
      const pair = await ratioPair(db, v, { now: vote, where: onRoof });
      const winner = [pair.a, pair.b].find((x) => x.text === "Headline two")?.id ?? pair.a.id;
      await voteRatio(db, v, { a: pair.a.id, b: pair.b.id, winner }, { now: vote, where: onRoof });
      expect(await code(voteRatio(db, v, { a: pair.b.id, b: pair.a.id, winner }, { now: vote, where: onRoof }))).toBe("ALREADY_VOTED");
    }
    expect(await code(ratioPair(db, v, { now: vote, where: onRoof }))).toBe("NO_PAIRS");
    // An author never sees, or votes on, their own entry.
    await client`UPDATE users SET proof_of_neighbour_at = now() WHERE id = ${authors[0]!}`;
    const pair = await ratioPair(db, authors[0]!, { now: vote, where: onRoof });
    expect([pair.a.id, pair.b.id]).not.toContain(entries[0]!.id);
    expect(await code(voteRatio(db, authors[0]!, { a: entries[0]!.id, b: entries[1]!.id, winner: entries[0]!.id }, { now: vote, where: onRoof }))).toBe("INVALID_INPUT");
    expect(await code(voteRatio(db, v, { a: entries[0]!.id, b: entries[0]!.id, winner: entries[0]!.id }, { now: vote, where: onRoof }))).toBe("INVALID_INPUT");
    // At the bell "Headline two" wins (2 head-to-heads); it plays on the reel and prints on the market's receipts.
    g.big.resolved = false;
    await pollOdds(db, g.provider, { now: new Date(g.d0 + 21 * H) });
    await runBell(db, { now: new Date(g.d0 + D + 5 * MIN), only: ["tower"] });
    expect((await reel(db, v, { now: new Date(g.d0 + D + 10 * MIN) }))!.ratio).toEqual({ headline: "Headline two", prompt: "World 10% · City 60%. Write the headline for when it settles." });
    const [c] = await client`SELECT id FROM calls WHERE market_id = ${g.bigId} AND user_id = ${g.crowd[0]!}`;
    expect((await receipt(db, c!.id, { now: new Date(g.d0 + D + 10 * MIN) }))!.ratio).toBe("Headline two");
  });

  it("a hidden entry never shows in a pair or wins; only staff hide", async () => {
    const g = await gapDay();
    await pickRatioPrompt(db, { now: new Date(g.d0 + 18 * H) });
    const [a, b] = [await makeResident(db), await makeResident(db)];
    const ea = await submitRatio(db, a, "Fine headline", { now: new Date(g.d0 + 19 * H) });
    const eb = await submitRatio(db, b, "Bad headline", { now: new Date(g.d0 + 19 * H) });
    expect(await code(hideRatioEntry(db, a, eb.id))).toBe("NOT_STAFF");
    const s = await makeResident(db);
    await client`INSERT INTO staff (user_id, role) VALUES (${s}, 'moderator')`;
    await hideRatioEntry(db, s, eb.id);
    const v = await ponned();
    expect(await code(ratioPair(db, v, { now: new Date(g.d0 + 23 * H + MIN), where: onRoof }))).toBe("NO_PAIRS");
    void ea;
  });
});
