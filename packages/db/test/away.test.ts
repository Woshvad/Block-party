import { randomUUID } from "node:crypto";
import { awayPlaceAt, slotOf } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { awayAt, awayRecap, createCrew, createDb, createInvite, ensureSystemAccounts, redeemInvite, touchActivity } from "../src";
import { makeResident } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const H = 3_600_000;
const T0 = new Date("2029-02-05T09:00:00Z").getTime();
const at = (h: number) => new Date(T0 + h * H);
const traits = (u: string, t: string[]) => client`UPDATE residents SET traits = ${`{${t.join(",")}}`}::text[] WHERE user_id = ${u}`;

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("while you were away", () => {
  it("no recap on a first visit", async () => {
    const u = await makeResident(db);
    await touchActivity(db, u, { now: at(0) });
    expect(await awayRecap(db, u, { now: at(0) })).toMatchObject({ from: null, to: null, highlights: [] });
  });

  it("a day away writes a story from your traits, as templates", async () => {
    const u = await makeResident(db);
    await traits(u, ["roof_rat", "ape", "hype_man"]);
    await touchActivity(db, u, { now: at(0) });
    await touchActivity(db, u, { now: at(30) });
    const r = await awayRecap(db, u, { now: at(30) });
    expect(r.from).toEqual(at(0));
    expect(r.to).toEqual(at(30));
    expect(r.highlights.length).toBeGreaterThan(0);
    expect(r.highlights.every((e) => /^away\./.test(e.key))).toBe(true);
    expect(r.favouritePlace).not.toBeNull();
  });

  it("crewmates away together meet, and every meeting shows in both recaps", async () => {
    const crew = await Promise.all(Array.from({ length: 6 }, () => makeResident(db)));
    for (const u of crew) await traits(u, ["roof_rat", "night_owl", "hype_man"]);
    await createCrew(db, crew[0]!, { name: `Away ${randomUUID().slice(0, 6)}` });
    const inv = await createInvite(db, crew[0]!);
    for (const u of crew.slice(1)) await redeemInvite(db, u, inv.code);
    for (const u of crew) {
      await touchActivity(db, u, { now: at(100) });
      await touchActivity(db, u, { now: at(172) });
    }
    const recaps = new Map<string, Awaited<ReturnType<typeof awayRecap>>>();
    for (const u of crew) recaps.set(u, await awayRecap(db, u, { now: at(172) }));
    // Use the full stories (not just highlights) to check every meeting both ways.
    const { awayStory } = await import("@bp/core");
    const story = (u: string) =>
      awayStory(
        { userId: u, traits: ["roof_rat", "night_owl", "hype_man"] },
        at(100).getTime(),
        at(172).getTime(),
        crew.filter((p) => p !== u).map((p) => ({ userId: p, traits: ["roof_rat", "night_owl", "hype_man"], lastSeen: at(100).getTime(), awayUntil: at(172).getTime() })),
      ).filter((e) => e.key === "away.met_resident");
    let total = 0;
    for (const a of crew) {
      for (const e of story(a)) {
        total++;
        const b = (e.values as { userId: string }).userId;
        expect(story(b).some((x) => x.at === e.at && (x.values as { userId: string }).userId === a)).toBe(true);
      }
    }
    expect(total).toBeGreaterThan(0); // six roof-loving crewmates over three days do meet
    expect([...recaps.values()].some((r) => r.counts.people > 0)).toBe(true);
  });

  it("you can't meet a crewmate who was online the whole time", async () => {
    const [a, b] = [await makeResident(db), await makeResident(db)];
    for (const u of [a, b]) await traits(u, ["roof_rat", "night_owl", "hype_man"]);
    await createCrew(db, a, { name: `Online ${randomUUID().slice(0, 6)}` });
    await redeemInvite(db, b, (await createInvite(db, a)).code);
    await touchActivity(db, a, { now: at(200) });
    for (let m = 0; m <= 48 * 60; m += 30) await touchActivity(db, b, { now: new Date(at(200).getTime() + m * 60_000) }); // b plays non-stop
    await touchActivity(db, a, { now: at(248) });
    expect((await awayRecap(db, a, { now: at(248) })).counts.people).toBe(0);
  });
});

describe("away residents in the rooms", () => {
  it("lists who is wandering a place now: offline, seen in the last 7 days, there in their away life", async () => {
    const u = await makeResident(db);
    await traits(u, ["roof_rat", "night_owl", "hype_man"]);
    await touchActivity(db, u, { now: at(300) });
    // Find an hour when their away self is on the roof.
    let h = 302;
    while (awayPlaceAt(u, ["roof_rat", "night_owl", "hype_man"], slotOf(at(h).getTime()), at(300).getTime()) !== "roof") h++;
    expect((await awayAt(db, "roof", { now: at(h) })).map((x) => x.userId)).toContain(u);
    // Online residents are here, not away.
    await touchActivity(db, u, { now: at(h) });
    expect((await awayAt(db, "roof", { now: at(h) })).map((x) => x.userId)).not.toContain(u);
  });

  it("after 7 days away they stay home, so no room draws them", async () => {
    const u = await makeResident(db);
    await traits(u, ["roof_rat", "night_owl", "hype_man"]);
    await touchActivity(db, u, { now: at(500) });
    for (const place of ["roof", "tower", "diner", "watch_party"]) {
      expect((await awayAt(db, place, { now: at(500 + 8 * 24) })).map((x) => x.userId)).not.toContain(u);
    }
  });

  it("caps the list", async () => {
    expect((await awayAt(db, "roof", { now: at(0), limit: 3 })).length).toBeLessThanOrEqual(3);
  });
});
