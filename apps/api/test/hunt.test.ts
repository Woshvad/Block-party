import { HUNT_CLUES, HUNT_PLACES, HUNT_TROPHIES, addDays, cityDay } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { arrive, call, client, close, makeApp, ready, resident } from "./harness";

beforeAll(ready);
afterAll(close);

// A clock pinned a few days ahead (sessions last 30 days), one city day per
// test, so nothing here depends on when the suite runs or meets another
// test's hunt.
let offset = 2;
function cityOn() {
  const day = addDays(cityDay(new Date()), offset++);
  let clock = new Date(`${day}T12:00:00Z`);
  const app = makeApp({ now: () => clock });
  return { day, app, at: (time: string, d = day) => (clock = new Date(`${d}T${time}Z`)) };
}
const placeOn = async (day: string) => (await client`SELECT place FROM hunt_days WHERE day = ${day}`)[0]?.place as string;

describe("the Daily Clue Hunt over HTTP", () => {
  it("both routes need a session", async () => {
    expect((await call("GET", "/v1/hunt")).status).toBe(401);
    expect((await call("POST", "/v1/hunt/search", { body: {} })).status).toBe(401);
  });

  it("GET /v1/hunt: today's clue and the bell, nothing searched yet", async () => {
    const { day, app } = cityOn();
    const me = await resident();
    const r = await call("GET", "/v1/hunt", { token: me.token, via: app });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ day, clue: expect.any(String), endsAt: `${addDays(day, 1)}T00:00:00.000Z`, searched: null, foundToday: 0, yesterday: null, finds: 0 });
    expect(HUNT_CLUES[(await placeOn(day)) as keyof typeof HUNT_CLUES]).toContain(r.body.clue);
  });

  it("a miss, a find, one search a day, and the place stays hidden from everyone who missed", async () => {
    const { day, app } = cityOn();
    const [misser, finder] = [await resident(), await resident()];
    await call("GET", "/v1/hunt", { token: misser.token, via: app });
    const place = await placeOn(day);
    const wrong = HUNT_PLACES.find((p) => p !== place)!;

    await arrive(misser.userId, wrong);
    const miss = await call("POST", "/v1/hunt/search", { token: misser.token, body: { place: wrong }, via: app });
    expect([miss.status, miss.body]).toEqual([201, { day, place: wrong, found: false, finds: 0, trophies: [] }]);
    const again = await call("POST", "/v1/hunt/search", { token: misser.token, body: {}, via: app });
    expect([again.status, again.body.error.code]).toEqual([409, "ALREADY_SEARCHED"]);

    await arrive(finder.userId, place);
    const find = await call("POST", "/v1/hunt/search", { token: finder.token, via: app });
    expect([find.status, find.body]).toEqual([201, { day, place, found: true, finds: 1, trophies: [HUNT_TROPHIES[0]!.pieceId] }]);
    const home = await call("GET", "/v1/home", { token: finder.token });
    expect(home.body.storage.map((s: { pieceId: string }) => s.pieceId)).toContain(HUNT_TROPHIES[0]!.pieceId);

    const missed = await call("GET", "/v1/hunt", { token: misser.token, via: app });
    expect(missed.body).toMatchObject({ searched: { place: wrong, found: false }, foundToday: 1, finds: 0 });
    for (const body of [miss.body, again.body, missed.body]) expect(JSON.stringify(body)).not.toContain(`"${place}"`);
    expect((await call("GET", "/v1/hunt", { token: finder.token, via: app })).body).toMatchObject({ searched: { place, found: true }, foundToday: 1, finds: 1 });
  });

  it("yesterday's answer shows after the bell", async () => {
    const { day, app, at } = cityOn();
    offset++; // this test uses the next day too
    const me = await resident();
    await call("GET", "/v1/hunt", { token: me.token, via: app });
    const place = await placeOn(day);
    await arrive(me.userId, place);
    await call("POST", "/v1/hunt/search", { token: me.token, via: app });
    at("00:00:00", addDays(day, 1));
    const next = await call("GET", "/v1/hunt", { token: me.token, via: app });
    expect(next.body).toMatchObject({ day: addDays(day, 1), searched: null, foundToday: 0, finds: 1, yesterday: { place, finders: 1 } });
  });

  it("refusals map to statuses with the API's error shape", async () => {
    const { app } = cityOn();
    const me = await resident();
    const street = await call("POST", "/v1/hunt/search", { token: me.token, via: app });
    expect([street.status, street.body.error.code]).toEqual([409, "NOT_AT_A_PLACE"]);
    expect(street.body.error.message).toMatch(/street/);
    await arrive(me.userId, "faucet");
    const moved = await call("POST", "/v1/hunt/search", { token: me.token, body: { place: "diner" }, via: app });
    expect([moved.status, moved.body.error.code]).toEqual([409, "NOT_AT_A_PLACE"]);
    for (const place of ["narnia", "street", "", 7, null, ["faucet"], { a: 1 }]) {
      const bad = await call("POST", "/v1/hunt/search", { token: me.token, body: { place }, via: app });
      expect([bad.status, bad.body.error.code], JSON.stringify(place)).toEqual([400, "INVALID_INPUT"]);
    }
    // None of those spent the day's search.
    expect((await call("POST", "/v1/hunt/search", { token: me.token, body: { place: "faucet" }, via: app })).status).toBe(201);

    const guest = await call("POST", "/v1/auth/guest", { body: { ageAck: true } });
    expect((await call("GET", "/v1/hunt", { token: guest.body.sessionToken, via: app })).status).toBe(200);
    const notMovedIn = await call("POST", "/v1/hunt/search", { token: guest.body.sessionToken, via: app });
    expect([notMovedIn.status, notMovedIn.body.error.code]).toEqual([404, "NO_RESIDENT"]);
  });

  it("searching is a write: it counts against the per-player write limit", async () => {
    const day = addDays(cityDay(new Date()), offset++);
    const clock = new Date(`${day}T12:00:00Z`);
    const strict = makeApp({ now: () => clock, limits: { writesPerUserPerMinute: 1, readsPerUserPerMinute: 1000 } });
    const me = await resident();
    expect((await call("POST", "/v1/hunt/search", { token: me.token, via: strict })).status).toBe(409); // on the street
    const limited = await call("POST", "/v1/hunt/search", { token: me.token, via: strict });
    expect([limited.status, limited.body.error.code]).toEqual([429, "RATE_LIMITED"]);
    expect((await call("GET", "/v1/hunt", { token: me.token, via: strict })).status).toBe(200);
  });
});
