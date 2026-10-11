import { randomUUID } from "node:crypto";
import { type FeedMarket, type OddsProvider, modifierFor } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCrew,
  createDb,
  createInvite,
  ensureSystemAccounts,
  makeCall,
  marketView,
  myGrid,
  myTickets,
  pollOdds,
  publishSlate,
  redeemInvite,
  todaySlate,
} from "../src";
import { makeResident, releaseTogether } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
let dayStart = Date.parse("2032-02-02T00:00:00Z");
// A fresh city day per test (09:00 on it), far from every other test file's markets.
const fresh = () => (dayStart += 3 * D) + 9 * H;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

function feed() {
  const ms = new Map<string, FeedMarket>();
  const provider: OddsProvider = { source: "slate-test", fetch: async () => [...ms.values()].map((m) => ({ ...m })) };
  // Fits the Slate: callable to 16:00, settled by 20:00 of the test's day.
  const add = (t: number, price: number, over: Partial<FeedMarket> = {}) => {
    const d0 = t - 9 * H;
    const m: FeedMarket = { externalId: randomUUID(), question: `Q ${price}?`, category: "sports", ladder: null, freezesAt: new Date(d0 + 16 * H), settlesBy: new Date(d0 + 20 * H), price, resolved: null, voided: false, ...over };
    ms.set(m.externalId, m);
    return m;
  };
  return { provider, add, ms };
}
const six = (f: ReturnType<typeof feed>, t: number) => [80, 50, 60, 30, 20, 8].map((p) => f.add(t, p));
// Which slot each market landed in (within a tier the order is the day's hash).
const slotOf = async (day: string, marketId: string) => (await client`SELECT slot FROM slate_cards WHERE city_day = ${day} AND market_id = ${marketId}`)[0]!.slot as number;
const idOf = async (ext: string) => (await client`SELECT id FROM markets WHERE external_id = ${ext}`)[0]!.id as string;

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("publishing the Slate", () => {
  it("six cards in tier order, once a day, even with racing publishers", async () => {
    const t = fresh();
    const f = feed();
    const ms = six(f, t);
    await pollOdds(db, f.provider, { now: new Date(t) });
    const res = await releaseTogether(client, "LOCK TABLE slates IN SHARE ROW EXCLUSIVE MODE", [], 1, [1, 2, 3].map(() => () => publishSlate(db, { now: new Date(t) })));
    expect(res.every((r) => r.ok)).toBe(true); // the losers step aside, they don't crash
    expect(res.filter((r) => r.ok && r.v.published)).toHaveLength(1);
    const cards = await client`SELECT slot, tier, market_id FROM slate_cards WHERE city_day = ${dayOf(t)} ORDER BY slot`;
    expect(cards.map((c) => c.tier)).toEqual(["lock", "coin_flip", "coin_flip", "spicy", "spicy", "long_shot"]);
    expect(cards[0]!.market_id).toBe(await idOf(ms[0]!.externalId));
    expect((await client`SELECT modifier FROM slates WHERE city_day = ${dayOf(t)}`)[0]!.modifier).toBe(modifierFor(dayOf(t)));
  });

  it("a short Slate waits until 02:00 UTC for the feed, then goes out with what fits", async () => {
    const t = fresh();
    const f = feed();
    for (const p of [50, 30, 8]) f.add(t, p);
    const d0 = t - 9 * H;
    await pollOdds(db, f.provider, { now: new Date(d0 + H) });
    expect(await publishSlate(db, { now: new Date(d0 + H) })).toMatchObject({ published: false, reason: "not_enough_markets", found: 3 });
    expect(await publishSlate(db, { now: new Date(d0 + 3 * H) })).toMatchObject({ published: true, cards: 3 });
  });

  it("a market the feed has dropped isn't dealt: it takes no calls", async () => {
    const t = fresh();
    const f = feed();
    const ms = six(f, t);
    await pollOdds(db, f.provider, { now: new Date(t - MIN) });
    f.ms.delete(ms[0]!.externalId);
    await pollOdds(db, f.provider, { now: new Date(t) });
    expect(await publishSlate(db, { now: new Date(t) })).toMatchObject({ published: true, cards: 5 });
    const dealt = await client`SELECT market_id FROM slate_cards WHERE city_day = ${dayOf(t)}`;
    expect(dealt.map((c) => c.market_id)).not.toContain(await idOf(ms[0]!.externalId));
  });

  it("a published Slate never changes", async () => {
    const t = fresh();
    const f = feed();
    six(f, t);
    await pollOdds(db, f.provider, { now: new Date(t) });
    await publishSlate(db, { now: new Date(t) });
    await expect(client`UPDATE slate_cards SET slot = 5 WHERE city_day = ${dayOf(t)} AND slot = 0`).rejects.toThrow(/never changes/);
    await expect(client`DELETE FROM slates WHERE city_day = ${dayOf(t)}`).rejects.toThrow(/never changes/);
    await expect(client`UPDATE slates SET modifier = 'nothing_day' WHERE city_day = ${dayOf(t)}`).rejects.toThrow(/never changes/);
  });
});

describe("calling the Slate", () => {
  async function day() {
    const t = fresh();
    const f = feed();
    const ms = six(f, t);
    await pollOdds(db, f.provider, { now: new Date(t) });
    await publishSlate(db, { now: new Date(t) });
    return { t, f, ms, ids: await Promise.all(ms.map((m) => idOf(m.externalId))) };
  }

  it("Slate calls are free (no ticket), one shot, and the card shows your call but not the result", async () => {
    const { t, f, ids } = await day();
    const u = await makeResident(db);
    const c = await makeCall(db, u, { marketId: ids[1], side: "yes", chance: 65, seenPrice: 50 }, { now: new Date(t + 1000) });
    expect(c).toMatchObject({ onSlate: true, ticket: false });
    expect((await myTickets(db, u, { now: new Date(t) })).tickets).toBe(3);
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    const s = await todaySlate(db, u, { now: new Date(t + 2 * MIN) });
    expect(s).toMatchObject({ sealed: true, cards: expect.any(Array) });
    expect(s!.cards).toHaveLength(6);
    expect(s!.cards.find((c) => c.marketId === ids[1])!.mine).toMatchObject({ side: "yes", chance: 65, status: "locked" });
    expect(s!.cards.filter((c) => c.mine)).toHaveLength(1);
    expect(JSON.stringify(s)).not.toMatch(/outcome|aura/i);
    expect(await todaySlate(db, u, { now: new Date(t), day: "2000-01-01" })).toBeNull();
  });

  it("the grid: sealed until the bell, then coloured by Aura, with the share line and your percentile", async () => {
    const { t, f, ms, ids } = await day();
    const [me, other] = [await makeResident(db), await makeResident(db)];
    // me: YES 99 on the Lock, NO 40 on a Coin Flip, YES 30 on the Long Shot, nothing else.
    await makeCall(db, me, { marketId: ids[0], side: "yes", chance: 99, seenPrice: 80 }, { now: new Date(t + 1000) });
    await makeCall(db, me, { marketId: ids[1], side: "no", chance: 40, seenPrice: 50 }, { now: new Date(t + 1000) });
    await makeCall(db, me, { marketId: ids[5], side: "yes", chance: 30, seenPrice: 8 }, { now: new Date(t + 1000) });
    await makeCall(db, other, { marketId: ids[0], side: "no", chance: 60, seenPrice: 80 }, { now: new Date(t + 1000) });
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    ms[0]!.resolved = true;
    ms[1]!.resolved = true;
    ms[2]!.resolved = false;
    ms[3]!.resolved = false;
    ms[4]!.voided = true;
    ms[5]!.resolved = true;
    const d0 = t - 9 * H;
    await pollOdds(db, f.provider, { now: new Date(d0 + 21 * H) });
    expect(await myGrid(db, me, dayOf(t), { now: new Date(d0 + 23 * H) })).toMatchObject({ sealed: true });
    const g = await myGrid(db, me, dayOf(t), { now: new Date(d0 + D) });
    // Lock YES 99 @80, YES happened: (20² − 1²) = +3.99 → green. Coin Flip NO 40 @50, YES: (50² − 60²) = −11 → red.
    const want = ["black", "black", "black", "black", "black", "black"];
    want[await slotOf(dayOf(t), ids[0]!)] = "green";
    want[await slotOf(dayOf(t), ids[1]!)] = "red";
    want[await slotOf(dayOf(t), ids[5]!)] = "gold";
    expect(g).toMatchObject({ sealed: false, squares: want });
    expect(await slotOf(dayOf(t), ids[5]!)).toBe(5); // the Long Shot is always last
    expect(g!.share).toContain(want.map((x) => ({ green: "🟩", red: "🟥", black: "⬛", gold: "🟨" })[x]).join(""));
    expect(g!.percentile).toBe(100); // beat the only other player
    expect(await myGrid(db, me, "junk", { now: new Date(d0 + D) })).toBeNull();
  });

  it("a voided card is grey, and an unsettled one at the bell is pending", async () => {
    const { t, f, ms, ids } = await day();
    const me = await makeResident(db);
    await makeCall(db, me, { marketId: ids[4], side: "yes", chance: 30, seenPrice: 20 }, { now: new Date(t + 1000) });
    await makeCall(db, me, { marketId: ids[3], side: "yes", chance: 40, seenPrice: 30 }, { now: new Date(t + 1000) });
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    ms[4]!.voided = true;
    const d0 = t - 9 * H;
    await pollOdds(db, f.provider, { now: new Date(d0 + 21 * H) });
    const g = await myGrid(db, me, dayOf(t), { now: new Date(d0 + D) });
    if (g?.sealed !== false) throw new Error("the grid should be open after the bell");
    expect(g.squares[await slotOf(dayOf(t), ids[4]!)]).toBe("void");
    expect(g.squares[await slotOf(dayOf(t), ids[3]!)]).toBe("pending");
  });

  it("Blind Slate: even after you lock, your crew's view stays hidden until the bell", async () => {
    // Find a day whose modifier is Blind Slate.
    let t = fresh();
    while (modifierFor(dayOf(t)) !== "blind_slate") t = fresh();
    const f = feed();
    const ms = six(f, t);
    await pollOdds(db, f.provider, { now: new Date(t) });
    await publishSlate(db, { now: new Date(t) });
    const id = await idOf(ms[1]!.externalId);
    const crew = await Promise.all(Array.from({ length: 3 }, () => makeResident(db)));
    await createCrew(db, crew[0]!, { name: `Blind ${randomUUID().slice(0, 6)}` });
    for (const u of crew.slice(1)) await redeemInvite(db, u, (await createInvite(db, crew[0]!)).code);
    for (const u of crew) await makeCall(db, u, { marketId: id, side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(t + 1000) });
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    expect(await marketView(db, crew[0]!, id, { now: new Date(t + 2 * MIN) })).toMatchObject({ blurred: false, crew: null });
  });
});

describe("what counts on the grid", () => {
  it("a call made before the Slate went out isn't a Slate call; a dropped call isn't yours; a tie isn't a win", async () => {
    const t = fresh();
    const d0 = t - 9 * H;
    const f = feed();
    const ms = six(f, t);
    await pollOdds(db, f.provider, { now: new Date(d0 + 30 * MIN) });
    const ids = await Promise.all(ms.map((m) => idOf(m.externalId)));
    const [early, me, twin] = [await makeResident(db), await makeResident(db), await makeResident(db)];
    // early calls the Lock before the Slate is published (a ticket call)
    const e = await makeCall(db, early, { marketId: ids[0], side: "yes", chance: 99, seenPrice: 80 }, { now: new Date(d0 + 31 * MIN) });
    expect(e.onSlate).toBe(false);
    await pollOdds(db, f.provider, { now: new Date(d0 + 32 * MIN) });
    await publishSlate(db, { now: new Date(d0 + 33 * MIN) });
    await pollOdds(db, f.provider, { now: new Date(t - MIN) });
    // me and twin make the same call; me also has a call that gets dropped
    for (const u of [me, twin]) await makeCall(db, u, { marketId: ids[1], side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(t) });
    await makeCall(db, me, { marketId: ids[2], side: "yes", chance: 70, seenPrice: 60 }, { now: new Date(t) });
    ms[2]!.price = 66;
    await pollOdds(db, f.provider, { now: new Date(t + MIN) });
    const card = (await todaySlate(db, me, { now: new Date(t + 2 * MIN) }))!.cards.find((c) => c.marketId === ids[2])!;
    expect(card.mine).toBeNull(); // price moved: no call on that card
    for (const m of ms) m.resolved = true;
    await pollOdds(db, f.provider, { now: new Date(d0 + 21 * H) });
    const ge = await myGrid(db, early, dayOf(t), { now: new Date(d0 + D) });
    if (ge?.sealed !== false) throw new Error("the grid should be open after the bell");
    expect(ge.squares.every((x) => x === "black")).toBe(true);
    expect(ge.aura).toBeNull();
    const gm = await myGrid(db, me, dayOf(t), { now: new Date(d0 + D) });
    if (gm?.sealed !== false) throw new Error("the grid should be open after the bell");
    expect(gm.percentile).toBe(0); // tied with twin: beat nobody
  });
});
