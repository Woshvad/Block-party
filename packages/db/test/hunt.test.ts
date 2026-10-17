import { randomUUID } from "node:crypto";
import { HUNT_CLUES, HUNT_PLACES, HUNT_TROPHIES, type HuntPlace, type RandomInt, addDays, seededRandomInt } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HuntError, createDb, createGuest, ensureSystemAccounts, getHome, searchHere, takeRide, todaysHunt, whereabouts } from "../src";
import { makeResident, raceAt } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 20 });
beforeAll(() => ensureSystemAccounts(db));
afterAll(() => close());

// Hunt days are city-wide, so every test keeps to days of its own, far from
// anything else in the shared database.
const at = (day: string, time = "12:00:00") => new Date(`${day}T${time}Z`);
// Randomness pinned: the same index every draw (wrapped into range).
const always = (i: number): RandomInt => (n) => i % n;
const [MAP, MAGNIFIER] = HUNT_TROPHIES.map((t) => t.pieceId) as [string, string];

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof HuntError) return e.code;
    throw e;
  }
}

const placeOn = async (day: string) => ((await client`SELECT place FROM hunt_days WHERE day = ${day}`)[0]?.place ?? null) as HuntPlace | null;

// Walks a resident to `area`, arriving 20 seconds before `now`.
async function goTo(userId: string, area: string, now: Date) {
  const here = await whereabouts(db, userId, { now });
  if (here.arrived && here.area === area) return;
  await takeRide(db, userId, { to: area, mode: "walk", idempotencyKey: randomUUID() }, { now: new Date(now.getTime() - 60_000) });
}

// A day played through the real services: the day is picked, the resident
// rides to its place and finds it.
async function findOn(userId: string, day: string) {
  const now = at(day);
  await todaysHunt(db, userId, { now });
  await goTo(userId, (await placeOn(day))!, now);
  return searchHere(db, userId, { now });
}

const storage = async (userId: string) => (await getHome(db, userId))!.storage.map((s) => s.pieceId);

describe("the day's hiding place", () => {
  it("is picked once, the first time anyone asks, and everyone reads the same one", async () => {
    const [a, b] = [await makeResident(db), await makeResident(db)];
    const day = "2033-01-10";
    expect(await placeOn(day)).toBeNull();
    const first = await todaysHunt(db, a, { now: at(day, "08:00:00"), rand: seededRandomInt(1) });
    const place = (await placeOn(day))!;
    expect(HUNT_PLACES).toContain(place);
    expect(HUNT_CLUES[place]).toContain(first.clue);
    // Another asker with other randomness gets the stored day, not a new pick.
    const second = await todaysHunt(db, b, { now: at(day, "20:00:00"), rand: seededRandomInt(999) });
    expect(second.clue).toBe(first.clue);
    expect(await placeOn(day)).toBe(place);
    expect(first).toMatchObject({ day, endsAt: at("2033-01-11", "00:00:00"), searched: null, foundToday: 0, finds: 0 });
  });

  it("racing first askers all agree on one pick", async () => {
    const u = await makeResident(db);
    const now = at("2033-02-03");
    const results = await raceAt(client, "hunt_days", 6, Array.from({ length: 6 }, (_, i) => () => todaysHunt(db, u, { now, rand: seededRandomInt(100 + i) })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => (r.ok ? r.v.clue : null))).size).toBe(1);
    expect((await client`SELECT count(*)::int AS n FROM hunt_days WHERE day = '2033-02-03'`)[0]!.n).toBe(1);
  });

  it("never repeats yesterday's place, even when the dice would", async () => {
    const u = await makeResident(db);
    // Pinned to the first choice every time: without the rule, every day
    // would be the first place. With it, the first two take turns.
    const picks: string[] = [];
    for (let d = 0; d < 6; d++) {
      const day = addDays("2033-03-01", d);
      await todaysHunt(db, u, { now: at(day), rand: always(0) });
      picks.push((await placeOn(day))!);
    }
    expect(picks).toEqual([0, 1, 0, 1, 0, 1].map((i) => HUNT_PLACES[i]));
  });

  it("first askers either side of the bell never land on the same place", async () => {
    // Both dice pinned to the first choice: whichever day is picked second
    // must see the other and step aside.
    const u = await makeResident(db);
    const [before, after] = ["2033-03-20", "2033-03-21"];
    const results = await raceAt(client, "hunt_days", 2, [before, after].map((day) => () => todaysHunt(db, u, { now: at(day, day === before ? "23:59:59" : "00:00:00"), rand: always(0) })));
    expect(results.every((r) => r.ok)).toBe(true);
    const places = [await placeOn(before), await placeOn(after)];
    expect(new Set(places).size).toBe(2);
    expect(places).toContain(HUNT_PLACES[0]);
  });

  it("over a month of real dice, no day repeats the one before", async () => {
    const u = await makeResident(db);
    const rand = seededRandomInt(2033);
    let before: string | null = null;
    for (let d = 0; d < 30; d++) {
      const day = addDays("2033-04-01", d);
      await todaysHunt(db, u, { now: at(day), rand });
      const place = await placeOn(day);
      expect(place).not.toBe(before);
      before = place;
    }
  });

  it("uses the server's crypto randomness when no generator is passed", async () => {
    const u = await makeResident(db);
    const h = await todaysHunt(db, u, { now: at("2033-05-20") });
    const place = (await placeOn("2033-05-20"))!;
    expect(HUNT_PLACES).toContain(place);
    expect(HUNT_CLUES[place]).toContain(h.clue);
  });

  it("the database refuses any change to a day or a search", async () => {
    const u = await makeResident(db);
    const day = "2033-06-02";
    await todaysHunt(db, u, { now: at(day), rand: always(0) });
    await goTo(u, "diner", at(day));
    await searchHere(db, u, { now: at(day) });
    const refused = async (q: Promise<unknown>) => {
      try {
        await q;
        return "OK";
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    expect(await refused(client`UPDATE hunt_days SET place = 'roof' WHERE day = ${day}`)).toBe("23000");
    expect(await refused(client`DELETE FROM hunt_days WHERE day = ${day}`)).toBe("23000");
    expect(await refused(client`UPDATE hunt_searches SET found = true WHERE day = ${day}`)).toBe("23000");
    expect(await refused(client`DELETE FROM hunt_searches WHERE day = ${day}`)).toBe("23000");
  });
});

describe("searching", () => {
  it("a miss says only where you looked; today's place stays hidden", async () => {
    const u = await makeResident(db);
    const day = "2033-07-04";
    const now = at(day);
    await todaysHunt(db, u, { now });
    const place = (await placeOn(day))!;
    const wrong = HUNT_PLACES.find((p) => p !== place)!;
    await goTo(u, wrong, now);
    const r = await searchHere(db, u, { now });
    expect(r).toEqual({ day, place: wrong, found: false, finds: 0, trophies: [] });
    const h = await todaysHunt(db, u, { now });
    expect(h.searched).toEqual({ place: wrong, found: false });
    expect(h.foundToday).toBe(0);
    for (const answer of [r, h]) expect(JSON.stringify(answer)).not.toContain(`"${place}"`);
    expect(await storage(u)).not.toContain(MAP);
  });

  it("a find records it, counts it, and brings the first trophy", async () => {
    const [u, other] = [await makeResident(db), await makeResident(db)];
    const day = "2033-08-08";
    const r = await findOn(u, day);
    const place = (await placeOn(day))!;
    expect(r).toEqual({ day, place, found: true, finds: 1, trophies: [MAP] });
    expect(await storage(u)).toContain(MAP);
    const mine = await todaysHunt(db, u, { now: at(day, "18:00:00") });
    expect(mine).toMatchObject({ searched: { place, found: true }, foundToday: 1, finds: 1 });
    // Someone who hasn't searched sees the count, never the place.
    const theirs = await todaysHunt(db, other, { now: at(day, "18:00:00") });
    expect(theirs).toMatchObject({ searched: null, foundToday: 1, finds: 0 });
    expect(JSON.stringify(theirs)).not.toContain(`"${place}"`);
  });

  it("yesterday's answer and its finders show after the bell", async () => {
    const [u, v, w] = [await makeResident(db), await makeResident(db), await makeResident(db)];
    const day = "2033-09-09";
    await findOn(u, day);
    await findOn(v, day);
    const place = (await placeOn(day))!;
    await goTo(w, HUNT_PLACES.find((p) => p !== place)!, at(day));
    await searchHere(db, w, { now: at(day) });
    expect((await todaysHunt(db, w, { now: at(day, "23:59:59") })).yesterday).toBeNull(); // nobody asked about the day before
    const next = await todaysHunt(db, w, { now: at(addDays(day, 1), "00:00:00") });
    expect(next.yesterday).toEqual({ place, clue: expect.any(String), finders: 2 });
    expect(HUNT_CLUES[place]).toContain(next.yesterday!.clue);
    expect(next).toMatchObject({ searched: null, foundToday: 0 });
  });

  it("one search a day: a second is refused, even from the right place", async () => {
    const u = await makeResident(db);
    const day = "2033-10-10";
    await todaysHunt(db, u, { now: at(day) });
    const place = (await placeOn(day))!;
    await goTo(u, HUNT_PLACES.find((p) => p !== place)!, at(day, "09:00:00"));
    expect((await searchHere(db, u, { now: at(day, "09:00:00") })).found).toBe(false);
    await goTo(u, place, at(day, "10:00:00"));
    expect(await code(searchHere(db, u, { now: at(day, "10:00:00") }))).toBe("ALREADY_SEARCHED");
    expect(await code(searchHere(db, u, { now: at(day, "23:59:59") }))).toBe("ALREADY_SEARCHED");
    expect((await client`SELECT count(*)::int AS n FROM hunt_searches WHERE user_id = ${u}`)[0]!.n).toBe(1);
    // The bell gives a new search.
    const tomorrow = addDays(day, 1);
    await todaysHunt(db, u, { now: at(tomorrow, "00:00:01") });
    await goTo(u, (await placeOn(tomorrow))!, at(tomorrow, "00:01:00"));
    expect(await searchHere(db, u, { now: at(tomorrow, "00:01:00") })).toMatchObject({ day: tomorrow, found: true });
  });

  it("the second trophy comes at 7 finds; each trophy comes once", async () => {
    const u = await makeResident(db);
    const got: string[][] = [];
    for (let d = 0; d < 8; d++) got.push((await findOn(u, addDays("2034-01-01", d))).trophies);
    expect(got).toEqual([[MAP], [], [], [], [], [], [MAGNIFIER], []]);
    const owned = await storage(u);
    expect(owned.filter((p) => p === MAP)).toHaveLength(1);
    expect(owned.filter((p) => p === MAGNIFIER)).toHaveLength(1);
    expect((await todaysHunt(db, u, { now: at("2034-01-08", "13:00:00") })).finds).toBe(8);
  }, 60_000);

  it("only residents who have arrived at a place can search", async () => {
    const guest = await createGuest(db, { ageAck: true });
    const now = at("2034-02-02");
    expect(await code(searchHere(db, guest.userId, { now }))).toBe("NO_RESIDENT");
    expect(await code(searchHere(db, randomUUID(), { now }))).toBe("NO_RESIDENT");
    const u = await makeResident(db);
    expect(await code(searchHere(db, u, { now }))).toBe("NOT_AT_A_PLACE"); // on the street
    await takeRide(db, u, { to: "roof", mode: "walk", idempotencyKey: randomUUID() }, { now: new Date(now.getTime() - 10_000) });
    expect(await code(searchHere(db, u, { now }))).toBe("NOT_AT_A_PLACE"); // still walking
    expect(await code(searchHere(db, u, { now: new Date(now.getTime() + 60_000) }))).toBe("OK");
    const home = await makeResident(db);
    await takeRide(db, home, { to: "roof", mode: "walk", idempotencyKey: randomUUID() }, { now: new Date(now.getTime() - 120_000) });
    await takeRide(db, home, { to: "street", mode: "walk", idempotencyKey: randomUUID() }, { now: new Date(now.getTime() - 60_000) });
    expect(await code(searchHere(db, home, { now }))).toBe("NOT_AT_A_PLACE"); // back home
    expect((await client`SELECT count(*)::int AS n FROM hunt_searches WHERE user_id IN (${u}, ${home}) AND place = 'street'`)[0]!.n).toBe(0);
  });

  it("refuses if you've moved since confirming, and spends nothing", async () => {
    const u = await makeResident(db);
    const now = at("2034-03-03");
    await goTo(u, "faucet", now);
    expect(await code(searchHere(db, u, { now, place: "diner" }))).toBe("NOT_AT_A_PLACE");
    expect(await searchHere(db, u, { now, place: "faucet" })).toMatchObject({ place: "faucet" });
  });

  it("refuses bad input before touching anything", async () => {
    const u = await makeResident(db);
    const now = at("2034-04-04");
    for (const place of ["narnia", "street", "home", "__proto__", "", null, 1, {}, ["diner"]]) expect(await code(searchHere(db, u, { now, place }))).toBe("INVALID_INPUT");
    for (const bad of ["", "not-a-uuid", null, 5]) {
      expect(await code(searchHere(db, bad as string, { now }))).toBe("INVALID_INPUT");
      expect(await code(todaysHunt(db, bad as string, { now }))).toBe("INVALID_INPUT");
    }
    for (const opts of [{ now: new Date(NaN) }, { now: "today" }, { rand: 4 }, [], "x", -1]) {
      expect(await code(searchHere(db, u, opts as never))).toBe("INVALID_INPUT");
      expect(await code(todaysHunt(db, u, opts as never))).toBe("INVALID_INPUT");
    }
    expect(await placeOn("2034-04-04")).toBeNull();
  });
});

describe("races", () => {
  it("two searches at once by one resident record exactly one", async () => {
    const u = await makeResident(db);
    const day = "2034-05-05";
    const now = at(day);
    await todaysHunt(db, u, { now });
    await goTo(u, (await placeOn(day))!, now);
    const results = await raceAt(client, "hunt_searches", 2, [0, 1].map(() => () => searchHere(db, u, { now })));
    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(1);
    const refused = results.find((r) => !r.ok)!;
    expect(!refused.ok && refused.e instanceof HuntError && refused.e.code).toBe("ALREADY_SEARCHED");
    expect((await client`SELECT count(*)::int AS n FROM hunt_searches WHERE user_id = ${u}`)[0]!.n).toBe(1);
    expect((await storage(u)).filter((p) => p === MAP)).toHaveLength(1);
  });

  it("finds landing either side of the bell are counted under the resident's lock", async () => {
    // Two finds by one resident can't normally race (the place never runs
    // two days), so pin both days to one place and race them across the bell.
    // Without the lock each would count 6 finds and the seventh's trophy
    // would never come.
    const u = await makeResident(db);
    for (let d = 0; d < 5; d++) await findOn(u, addDays("2034-06-01", d));
    const [d1, d2] = ["2034-06-10", "2034-06-11"];
    await client`INSERT INTO hunt_days (day, place, clue_index) VALUES (${d1}, 'diner', 0), (${d2}, 'diner', 1)`;
    await goTo(u, "diner", at(d1, "23:00:00"));
    // The barrier holds whoever gets as far as granting a trophy.
    const results = await raceAt(client, "items", 2, [at(d1, "23:59:59"), at(d2, "00:00:01")].map((now) => () => searchHere(db, u, { now })));
    expect(results.every((r) => r.ok && r.v.found)).toBe(true);
    expect(results.flatMap((r) => (r.ok ? r.v.trophies : []))).toEqual([MAGNIFIER]);
    expect(await storage(u)).toContain(MAGNIFIER);
  });
});
