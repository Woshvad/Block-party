import { randomUUID } from "node:crypto";
import { CAST, type FeedMarket, type OddsProvider } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  ensureSystemAccounts,
  makeCall,
  marketView,
  moodState,
  npcBoardLines,
  npcCalls,
  pollOdds,
  publishSlate,
  readBoard,
  receipt,
  recordVisit,
  runBell,
  setPrefs,
} from "../src";
import { makeResident } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
let day0 = Date.parse("2034-03-06T00:00:00Z");
const freshDay = () => (day0 += 4 * D);
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

function feed() {
  const ms = new Map<string, FeedMarket>();
  const provider: OddsProvider = { source: "cast-test", fetch: async () => [...ms.values()].map((m) => ({ ...m })) };
  const add = (d0: number, price: number) => {
    const m: FeedMarket = { externalId: randomUUID(), question: `Q ${price}?`, category: "sports", ladder: null, freezesAt: new Date(d0 + 16 * H), settlesBy: new Date(d0 + 20 * H), price, resolved: null, voided: false };
    ms.set(m.externalId, m);
    return m;
  };
  return { provider, add };
}
const idOf = async (ext: string) => (await client`SELECT id FROM markets WHERE external_id = ${ext}`)[0]!.id as string;
async function slateDay() {
  const d0 = freshDay();
  const f = feed();
  const ms = [80, 50, 60, 30, 20, 8].map((p) => f.add(d0, p));
  await pollOdds(db, f.provider, { now: new Date(d0 + 9 * H - MIN) });
  await publishSlate(db, { now: new Date(d0 + 9 * H - MIN) });
  return { d0, f, ms, ids: await Promise.all(ms.map((m) => idOf(m.externalId))) };
}
const pon = (ids: string[]) => client`UPDATE users SET proof_of_neighbour_at = now() WHERE id IN ${client(ids)}`;
const npcCallsOn = (npc: keyof typeof CAST, ids: string[]) => client`SELECT market_id, side, chance FROM calls WHERE user_id = ${CAST[npc].id} AND market_id IN ${client(ids)}`;

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("the cast's accounts", () => {
  it("exist from the migrations, and can never hold GM", async () => {
    const rows = await client`SELECT key, user_id FROM npcs ORDER BY key`;
    expect(rows.map((r) => r.key)).toEqual(["contrarian", "faucet_fren", "hash_brown", "nothing_9000"]);
    await expect(client`INSERT INTO gm_accounts (id, kind, user_id) VALUES (${`user:${CAST.nothing_9000.id}`}, 'user', ${CAST.nothing_9000.id})`).rejects.toThrow(/never hold GM/);
  });
});

describe("the cast plays the Slate", () => {
  it("NOTHING-9000 says NO to every card as soon as the Slate is out; once", async () => {
    const s = await slateDay();
    expect(await npcCalls(db, { now: new Date(s.d0 + 9 * H) })).toMatchObject({ made: 6 });
    expect(await npcCalls(db, { now: new Date(s.d0 + 9 * H + MIN) })).toMatchObject({ made: 0 });
    const mine = await npcCallsOn("nothing_9000", s.ids);
    expect(mine.every((c) => c.side === "no")).toBe(true);
    expect(mine).toHaveLength(6);
    expect(await npcCallsOn("contrarian", s.ids)).toHaveLength(0); // not before noon
  });

  it("never calls a card after it freezes", async () => {
    const s = await slateDay();
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 16 * H + MIN) }); // every card frozen at 16:00
    expect(await npcCalls(db, { now: new Date(s.d0 + 16 * H + 2 * MIN) })).toMatchObject({ made: 0 });
    expect(await npcCallsOn("nothing_9000", s.ids)).toHaveLength(0);
  });

  it("the Contrarian goes against where the city leans, at noon", async () => {
    const s = await slateDay();
    const people = await Promise.all(Array.from({ length: 3 }, () => makeResident(db)));
    for (const u of people) await makeCall(db, u, { marketId: s.ids[1], side: "yes", chance: 60, seenPrice: 50 }, { now: new Date(s.d0 + 9 * H) });
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 9 * H + MIN) });
    await npcCalls(db, { now: new Date(s.d0 + 9 * H + 2 * MIN) }); // NOTHING-9000 only
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 12 * H - MIN) });
    await npcCalls(db, { now: new Date(s.d0 + 12 * H) });
    const c = await npcCallsOn("contrarian", s.ids);
    expect(c.find((x) => x.market_id === s.ids[1])!.side).toBe("no"); // the city leaned YES (NOTHING-9000's NO doesn't count)
    expect(c.find((x) => x.market_id === s.ids[0])!.side).toBe("no"); // nobody called: against the 80% favourite
    expect(c.find((x) => x.market_id === s.ids[5])!.side).toBe("yes"); // against the 8% underdog's NO
  });

  it("their calls lock like anyone's without crashing the poll (no streak, no GM), and never move the City bar", async () => {
    const s = await slateDay();
    const people = await Promise.all(Array.from({ length: 10 }, () => makeResident(db)));
    await pon(people);
    for (const u of people) await makeCall(db, u, { marketId: s.ids[1], side: "yes", chance: 70, seenPrice: 50 }, { now: new Date(s.d0 + 9 * H) });
    await npcCalls(db, { now: new Date(s.d0 + 9 * H) });
    const r = await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 9 * H + MIN) });
    expect(r).toMatchObject({ ok: true });
    const [nc] = await client`SELECT id, status FROM calls WHERE user_id = ${CAST.nothing_9000.id} AND market_id = ${s.ids[1]!}`;
    expect(nc!.status).toBe("locked");
    expect(await client`SELECT 1 FROM streaks WHERE user_id = ${CAST.nothing_9000.id}`).toHaveLength(0);
    expect(await marketView(db, people[0]!, s.ids[1]!, { now: new Date(s.d0 + 9 * H + 2 * MIN) })).toMatchObject({ city: 70, counts: { city: 10 } });
    // Its receipt is labelled.
    expect(await receipt(db, nc!.id, { now: new Date(s.d0 + 10 * H) })).toMatchObject({ handle: "NOTHING-9000", npc: "NPC · AI" });
    // Fading it (off the Slate) pings nobody.
    const off = s.f.add(s.d0, 45);
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 9 * H + 2 * MIN) });
    const offId = await idOf(off.externalId);
    await client`INSERT INTO calls (user_id, market_id, side, chance, seen_price, on_slate, created_at) VALUES (${CAST.nothing_9000.id}, ${offId}, 'no', 35, 45, false, ${new Date(s.d0 + 9 * H + 2 * MIN + 1000).toISOString()})`;
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 9 * H + 3 * MIN) });
    const fader = await makeResident(db);
    await setPrefs(db, CAST.nothing_9000.id, { alerts: ["faded"] }).catch(() => undefined);
    const fade = await makeCall(db, fader, { marketId: offId, via: "fade", viaUserId: CAST.nothing_9000.id, chance: 55, seenPrice: 45 }, { now: new Date(s.d0 + 9 * H + 4 * MIN) });
    expect(fade.side).toBe("yes");
    expect(await client`SELECT 1 FROM notifications WHERE user_id = ${CAST.nothing_9000.id}`).toHaveLength(0);
  });

  it("at the bell the cast gets no moods", async () => {
    const s = await slateDay();
    await npcCalls(db, { now: new Date(s.d0 + 9 * H) });
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 9 * H + MIN) });
    for (const m of s.ms) m.resolved = true; // NOTHING-9000 loses everything
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 21 * H) });
    await runBell(db, { now: new Date(s.d0 + D + 5 * MIN), only: ["tower"] });
    expect(await client`SELECT 1 FROM moods WHERE user_id = ${CAST.nothing_9000.id}`).toHaveLength(0);
  });
});

describe("the cast's Board lines", () => {
  it("one labelled line each on their home Boards after the bell, at most 3 NPC lines a Board a day", async () => {
    const s = await slateDay();
    for (const m of s.ms) m.resolved = false;
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 21 * H) });
    const at = new Date(s.d0 + D + 5 * MIN);
    await runBell(db, { now: at, only: ["npc_lines"] });
    const reader = await makeResident(db);
    const roof = await readBoard(db, reader, "roof", { now: new Date(at.getTime() + MIN) });
    const line = roof.find((m) => m.authorId === CAST.nothing_9000.id) as { text: string; npc?: { label: string } } | undefined;
    expect(line).toMatchObject({ text: "Nothing happened. Again.", npc: { label: "NPC · AI" } });
    const diner = await readBoard(db, reader, "diner", { now: new Date(at.getTime() + MIN) });
    expect(diner.some((m) => m.authorId === CAST.hash_brown.id && /fiction/i.test(m.text))).toBe(true);
    // The cap: two more runs fill the roof to 3; a fourth posts nothing there.
    await npcBoardLines(db, dayOf(s.d0), at);
    await npcBoardLines(db, dayOf(s.d0), at);
    expect((await npcBoardLines(db, dayOf(s.d0), at)).posted).toBe(0);
    const [n] = await client`SELECT count(*)::int AS n FROM messages WHERE channel = 'roof' AND author_id = ${CAST.nothing_9000.id} AND created_at >= ${new Date(s.d0 + D).toISOString()} AND created_at < ${new Date(s.d0 + 2 * D).toISOString()}`;
    expect(n!.n).toBe(3);
  });

  it("the Contrarian's city lean is the city's before kickoff: calls made in play don't move it", async () => {
    const s = await slateDay();
    for (let i = 0; i < 2; i++) await makeCall(db, await makeResident(db), { marketId: s.ids[1]!, side: "no", chance: 40, seenPrice: 50 }, { now: new Date(s.d0 + 9 * H) });
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 9 * H + MIN) });
    // Kickoff: three in the Watch Party Hall call YES, in play.
    s.ms[1]!.inPlay = true;
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 16 * H + MIN) });
    for (let i = 0; i < 3; i++) {
      const fan = await makeResident(db);
      await recordVisit(db, { userId: fan, room: "watch_party#1", event: "start", at: new Date(s.d0 + 16 * H) });
      await makeCall(db, fan, { marketId: s.ids[1]!, side: "yes", chance: 60, seenPrice: 50, inPlay: true }, { now: new Date(s.d0 + 16 * H + MIN + 1000) });
    }
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 16 * H + 4 * MIN) });
    const [live] = await client`SELECT count(*)::int AS n FROM calls WHERE market_id = ${s.ids[1]!} AND in_play AND status = 'locked'`;
    expect(live!.n).toBe(3);
    s.ms[1]!.inPlay = undefined;
    for (const m of s.ms) m.resolved = false;
    await pollOdds(db, s.f.provider, { now: new Date(s.d0 + 21 * H) });
    const at = new Date(s.d0 + D + 5 * MIN);
    await runBell(db, { now: at, only: ["npc_lines"] });
    const tower = await readBoard(db, await makeResident(db), "tower", { now: new Date(at.getTime() + MIN) });
    expect(tower.find((m) => m.authorId === CAST.contrarian.id)?.text).toBe("The city leaned NO and got it right. Even a stopped clock, ser.");
  });
});

void moodState;
