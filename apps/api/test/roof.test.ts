import { randomUUID } from "node:crypto";
import { CAST, type FeedMarket, type OddsProvider, seasonOf } from "@bp/core";
import { makeCall, pollOdds } from "@bp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, client, close, db, makeApp, ready, resident } from "./harness";

beforeAll(ready);
afterAll(close);

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const BOT = CAST.nothing_9000.id;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
// Tomorrow at 09:00 UTC: a day of its own, well inside the sessions' 30 days.
// The boards are read at the next bell, and the Right List counts only its
// own season: when tomorrow is a season's last day, the day after it instead.
const tomorrow = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1, 9);
const t = seasonOf(dayOf(tomorrow)) === seasonOf(dayOf(tomorrow + D)) ? tomorrow : tomorrow + D;
// The bell after the day's markets settle.
const afterBell = makeApp({ now: () => new Date(t + D) });

// Ten markets that settle YES the same day, called by each resident (and by
// NOTHING-9000, straight into the queue like the cast's calls), so everyone
// here has the 10 settled calls the Right List asks for.
async function settledDay(callers: Array<{ id: string; side: "yes" | "no"; chance: number }>) {
  const ms = Array.from({ length: 10 }, (): FeedMarket => ({ externalId: randomUUID(), question: "Roof?", category: "crypto", ladder: null, freezesAt: new Date(t + 2 * H), settlesBy: new Date(t + 3 * H), price: 50, resolved: null, voided: false }));
  const provider: OddsProvider = { source: "roof-api-test", fetch: async () => ms.map((m) => ({ ...m })) };
  await pollOdds(db, provider, { now: new Date(t) });
  const ids = (await client`SELECT id FROM markets WHERE external_id IN ${client(ms.map((m) => m.externalId))}`).map((r) => r.id as string);
  for (const c of callers) {
    if (c.id !== BOT) await client`UPDATE users SET proof_of_neighbour_at = now() WHERE id = ${c.id}`;
    for (const id of ids) {
      if (c.id === BOT) {
        await client`INSERT INTO calls (user_id, market_id, side, chance, seen_price, on_slate, ticket, created_at) VALUES (${BOT}, ${id}, ${c.side}, ${c.chance}, 50, true, false, ${new Date(t + 1000).toISOString()})`;
        continue;
      }
      await client`INSERT INTO tickets (user_id, balance, as_of) VALUES (${c.id}, 9, ${dayOf(t)}) ON CONFLICT (user_id) DO UPDATE SET balance = 9, as_of = ${dayOf(t)}`;
      await makeCall(db, c.id, { marketId: id, side: c.side, chance: c.chance, seenPrice: 50 }, { now: new Date(t + 1000) });
    }
  }
  await pollOdds(db, provider, { now: new Date(t + MIN) });
  for (const m of ms) m.resolved = true;
  await pollOdds(db, provider, { now: new Date(t + 4 * H) });
}

describe("GET /v1/roof", () => {
  it("needs a session, and answers every resident with the boards' shape", async () => {
    expect((await call("GET", "/v1/roof")).status).toBe(401);
    const me = await resident();
    const r = await call("GET", "/v1/roof", { token: me.token });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["bellAt", "crews", "rightList", "season", "seasonStack"]);
    expect(r.body.bellAt).toBe(`${dayOf(Date.now())}T00:00:00.000Z`);
    expect(Object.keys(r.body.rightList).sort()).toEqual(["bot", "rows"]);
    expect(Object.keys(r.body.crews).sort()).toEqual(["bellDay", "bellScores", "league"]);
    expect(Array.isArray(r.body.seasonStack.rows)).toBe(true);
  });

  it("the Right List with NOTHING-9000's row; a block or a mute takes a resident off only that reader's boards; never an id", async () => {
    const [reader, other, sharp, blocked, muted] = [await resident(), await resident(), await resident(), await resident(), await resident()];
    await settledDay([
      { id: sharp.userId, side: "yes", chance: 70 },
      { id: blocked.userId, side: "yes", chance: 65 },
      { id: muted.userId, side: "yes", chance: 60 },
      { id: BOT, side: "no", chance: 40 },
    ]);
    expect((await call("POST", `/v1/blocks/${blocked.userId}`, { token: reader.token })).status).toBeLessThan(300);
    expect((await call("POST", `/v1/mutes/${muted.userId}`, { token: reader.token, body: {} })).status).toBeLessThan(300);

    const theirs = await call("GET", "/v1/roof", { token: other.token, via: afterBell });
    expect(theirs.status).toBe(200);
    const rows = theirs.body.rightList.rows as Array<{ rank: number; handle: string; npc: string | null }>;
    const rankOf = (h: string) => rows.find((r) => r.handle === h)!.rank;
    // +6.4, +5.1 and +3.6 per call; the db tests pin the exact order around the bot.
    expect(rankOf(sharp.handle)).toBeLessThan(rankOf(blocked.handle));
    expect(rankOf(blocked.handle)).toBeLessThan(rankOf(muted.handle));
    expect(rows.find((r) => r.handle === "NOTHING-9000")).toMatchObject({ npc: "NPC · AI", rank: theirs.body.rightList.bot.rank });

    const mine = await call("GET", "/v1/roof", { token: reader.token, via: afterBell });
    const handles = (mine.body.rightList.rows as Array<{ handle: string }>).map((r) => r.handle);
    expect(handles).toContain(sharp.handle);
    expect(handles).toContain("NOTHING-9000");
    expect(handles).not.toContain(blocked.handle);
    expect(handles).not.toContain(muted.handle);
    expect(mine.body.rightList.bot).toEqual(theirs.body.rightList.bot); // the line stays where the city put it

    const body = JSON.stringify([theirs.body, mine.body]);
    for (const u of [reader, other, sharp, blocked, muted]) expect(body).not.toContain(u.userId);
    expect(body).not.toContain(BOT);
    for (const r of [...theirs.body.rightList.rows, ...theirs.body.seasonStack.rows]) expect(Object.keys(r)).not.toContain("userId");
  });
});
