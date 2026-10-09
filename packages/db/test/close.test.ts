import { randomUUID } from "node:crypto";
import { type FeedMarket, type OddsProvider, renderClose, weekStart } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCrew, createDb, createInvite, dailyClose, ensureSystemAccounts, makeCall, npcCalls, pollOdds, publishSlate, redeemInvite, runBell } from "../src";
import { makeResident } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const d0 = Date.parse("2035-06-05T00:00:00Z"); // a Tuesday
const day = new Date(d0).toISOString().slice(0, 10);

function feed() {
  const ms = new Map<string, FeedMarket>();
  const provider: OddsProvider = { source: "close-test", fetch: async () => [...ms.values()].map((m) => ({ ...m })) };
  const add = (price: number, q: string) => {
    const m: FeedMarket = { externalId: randomUUID(), question: q, category: "sports", ladder: null, freezesAt: new Date(d0 + 16 * H), settlesBy: new Date(d0 + 20 * H), price, resolved: null, voided: false };
    ms.set(m.externalId, m);
    return m;
  };
  return { provider, add };
}
const idOf = async (ext: string) => (await client`SELECT id FROM markets WHERE external_id = ${ext}`)[0]!.id as string;

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("the Daily Close", () => {
  it("prints the day's paper once, from game data, and each resident gets their own headline", async () => {
    const f = feed();
    const ms = [
      f.add(80, "Lock?"),
      f.add(50, "Coin flip one?"),
      f.add(60, "Coin flip two?"),
      f.add(30, "Spicy one?"),
      f.add(20, "Spicy two?"),
      f.add(8, "The long shot?"),
    ];
    const offSlate = f.add(50, "Off the Slate?");
    offSlate.freezesAt = new Date(d0 + 12 * H); // callable under 15 hours: never on the Slate
    await pollOdds(db, f.provider, { now: new Date(d0 + 9 * H - MIN) });
    const early = await makeResident(db); // calls the Long Shot before the Slate is out: not a Slate call
    await makeCall(db, early, { marketId: await idOf(ms[5]!.externalId), side: "yes", chance: 30, seenPrice: 8 }, { now: new Date(d0 + 9 * H - MIN + 500) });
    await publishSlate(db, { now: new Date(d0 + 9 * H - MIN + 1000) });
    const ids = await Promise.all(ms.map((m) => idOf(m.externalId)));
    const at = new Date(d0 + 9 * H);

    // A crew of 10 who all lean YES on "Coin flip one?" (city 70 vs world 50); one calls the Long Shot.
    const crowd = await Promise.all(Array.from({ length: 10 }, () => makeResident(db)));
    await client`UPDATE users SET proof_of_neighbour_at = now() WHERE id IN ${client(crowd as string[])}`;
    await createCrew(db, crowd[0]!, { name: `Close ${randomUUID().slice(0, 6)}` });
    for (const u of crowd.slice(1, 4)) await redeemInvite(db, u, (await createInvite(db, crowd[0]!)).code);
    for (const [i, u] of crowd.entries()) await makeCall(db, u, { marketId: ids[1], side: "yes", chance: i < 4 ? 70 : 72, seenPrice: 50 }, { now: at });
    // The bigger gap sits later on the Slate (Spicy one: world 30, city 79 vs the Coin Flip's 22).
    // City 79 is the median of 78s and 80s; NOTHING-9000's NO at 20 would drag it to 78.
    for (const [i, u] of crowd.entries()) await makeCall(db, u, { marketId: ids[3], side: "yes", chance: i < 5 ? 78 : 80, seenPrice: 30 }, { now: at });
    await makeCall(db, crowd[0]!, { marketId: ids[5], side: "yes", chance: 30, seenPrice: 8 }, { now: at });
    const fader = await makeResident(db); // against the city on the Coin Flip... and wrong
    await makeCall(db, fader, { marketId: ids[1], side: "no", chance: 30, seenPrice: 50 }, { now: at });
    const contrary = await makeResident(db); // against the city on the Lock, and right
    for (const u of crowd.slice(4, 7)) await makeCall(db, u, { marketId: ids[0], side: "yes", chance: 90, seenPrice: 80 }, { now: at });
    await makeCall(db, contrary, { marketId: ids[0], side: "no", chance: 60, seenPrice: 80 }, { now: at });
    const idle = await makeResident(db);
    await makeCall(db, idle, { marketId: await idOf(offSlate.externalId), side: "yes", chance: 60, seenPrice: 50 }, { now: at });
    await npcCalls(db, { now: at });
    await pollOdds(db, f.provider, { now: new Date(at.getTime() + MIN) });

    // A Mayor and their Law of the Week.
    const mayor = await makeResident(db);
    await client`INSERT INTO mayor_terms (week, mayor_user_id, law_id, law_chosen_at) VALUES (${weekStart(day)}, ${mayor}, 'gas_holiday', now()) ON CONFLICT (week) DO UPDATE SET mayor_user_id = EXCLUDED.mayor_user_id, law_id = 'gas_holiday', law_chosen_at = now()`;
    const [mh] = await client`SELECT handle FROM residents WHERE user_id = ${mayor}`;

    ms[0]!.resolved = false; // the Lock misses
    ms[1]!.resolved = true; // the city was right
    ms[5]!.resolved = true; // the Long Shot hits
    for (const m of ms.slice(2, 5)) m.resolved = false;
    offSlate.resolved = true; // idle wins off the Slate: still a quiet day on the paper
    await pollOdds(db, f.provider, { now: new Date(d0 + 21 * H) });
    const bell = new Date(d0 + D + 5 * MIN);
    const r = await runBell(db, { now: bell, only: ["tower", "npc_lines", "close"] });
    expect(Object.keys(r.ran).sort()).toEqual(["close", "npc_lines", "tower"]);

    const paper = await dailyClose(db, crowd[0]!, day);
    if (!paper) throw new Error("the paper should be printed");
    const text = (k: string) => paper.pages[k]!.map((i) => renderClose(i));
    expect(text("front")[0]).toBe("The Long Shot hit: The long shot? (the world said 8%). 2 neighbours called it.");
    expect(text("front")[1]).toBe("Biggest Vibe Gap: Spicy one?. World 30% · City 79%. The world was right. The city is coping.");
    expect(text("cityHall")).toEqual([`Law of the Week: Gas Holiday, by order of Mayor @${mh!.handle}.`]);
    expect(text("crews")[0]).toMatch(/^#1 on the Bell Score: Close /);
    expect(paper.pages.cast!.filter((i) => i.key === "cast.line")).toHaveLength(4);
    expect(text("cast")).toContain("NOTHING-9000: “Nothing happened.” Something happened.");
    const green = paper.pages.weather![0]!.values.green as number;
    expect(green).toBeGreaterThan(0);
    expect(green).toBeLessThan(100);
    expect(text("you")).toEqual(["Local " + text("you")[0]!.split("Local ")[1]]);
    expect(paper.pages.you![0]!.key).toBe("you.long_shot");
    expect((await dailyClose(db, contrary, day))!.pages.you![0]!.key).toBe("you.faded_city");
    expect((await dailyClose(db, idle, day))!.pages.you![0]!.key).toBe("you.quiet");
    expect((await dailyClose(db, early, day))!.pages.you![0]!.key).toBe("you.quiet"); // its Long Shot wasn't a Slate call
    expect((await dailyClose(db, fader, day))!.pages.you![0]!.key).toBe("you.rekt"); // against the city, and wrong
    // Nobody but the Mayor is named; no user ids leak.
    const json = JSON.stringify(paper);
    for (const u of [...crowd, fader, contrary]) expect(json).not.toContain(u);
    const handles = await client`SELECT handle FROM residents WHERE user_id IN ${client([...crowd, fader, contrary] as string[])}`;
    for (const h of handles) expect(json).not.toContain(h.handle);
    expect((await runBell(db, { now: new Date(bell.getTime() + MIN), only: ["close"] })).ran.close).toBe("already done");
    expect(await dailyClose(db, idle, "2000-01-01")).toBeNull();
    expect(await dailyClose(db, idle, "junk")).toBeNull();
  });
});
