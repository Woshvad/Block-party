import { shiftPuzzle } from "@bp/core";
import { createDb } from "@bp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORIGIN, SECRET, app, call, close, idem, logs, makeApp, ready, resident, telegramInit } from "./harness";

beforeAll(ready);
afterAll(close);

describe("a new player's first minutes, over HTTP", () => {
  it("guest -> claim -> move in -> gm -> buy -> place -> crew -> shift", async () => {
    const guest = await call("POST", "/v1/auth/guest", { body: { ageAck: true } });
    expect(guest.status).toBe(201);
    let token = guest.body.sessionToken as string;

    const claim = await call("POST", "/v1/auth/telegram", { token, body: { initData: await telegramInit() } });
    expect(claim.status).toBe(200);
    expect(claim.body).toMatchObject({ userId: guest.body.userId, status: "claimed" });
    token = claim.body.sessionToken;
    expect((await call("GET", "/v1/me", { token: guest.body.sessionToken })).status).toBe(401); // old token is dead

    const pick = await call("GET", "/v1/resident/pick-for-me", { token });
    expect(pick.status).toBe(200);
    expect((await call("GET", `/v1/handles/${pick.body.handle}/available`, { token })).body).toEqual({ available: true });
    const moved = await call("POST", "/v1/resident", { token, body: pick.body });
    expect(moved.status).toBe(201);

    const me = await call("GET", "/v1/me", { token });
    expect(me.body).toMatchObject({ status: "claimed", gm: 1000, resident: { handle: pick.body.handle }, crew: null });

    expect((await call("POST", "/v1/gm", { token })).body).toMatchObject({ drip: 50, balance: 1050 });
    expect((await call("GET", "/v1/today", { token })).body).toMatchObject({ saidGm: true });

    const sofa = await call("POST", "/v1/home/buy", { token, body: { pieceId: "sofa" }, headers: idem() });
    expect(sofa.status).toBe(201);
    expect((await call("PUT", `/v1/home/items/${sofa.body.id}/place`, { token, body: { layer: "floor", x: 3, y: 6, rot: 0, color: 2 } })).status).toBe(200);
    const home = await call("GET", "/v1/home", { token });
    expect(home.body.placed.some((p: { itemId: string }) => p.itemId === sofa.body.id)).toBe(true);

    const crew = await call("POST", "/v1/crews", { token, body: { name: `Api ${crypto.randomUUID().slice(0, 6)}` } });
    expect(crew.status).toBe(201);
    const inv = await call("POST", "/v1/crews/mine/invites", { token, body: {} });
    const friend = await resident();
    expect((await call("POST", "/v1/crews/join", { token: friend.token, body: { code: inv.body.code } })).body).toEqual({ joined: true, crewId: crew.body.id });
    expect((await call("POST", "/v1/crews/mine/pot", { token: friend.token, body: { amount: 100 }, headers: idem() })).body).toMatchObject({ pot: 100 });

    const shift = await call("POST", "/v1/shifts", { token });
    expect(shift.status).toBe(201);
    expect(shift.body.items).toHaveLength(10);
    const ans = await call("POST", `/v1/shifts/${shift.body.shiftId}/answers`, { token, body: { answers: Array(10).fill(false) } });
    expect(ans.status).toBe(200);
    expect((await call("POST", `/v1/shifts/${shift.body.shiftId}/collect`, { token })).body.error.code).toBe("NOT_DONE");
  });
});

describe("auth", () => {
  it("guests need the 18+ notice", async () => {
    const r = await call("POST", "/v1/auth/guest", { body: {} });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("AGE_ACK_REQUIRED");
  });

  it("forged Telegram data is refused without saying why", async () => {
    const forged = (await telegramInit()).replace(/hash=[0-9a-f]+/, `hash=${"0".repeat(64)}`);
    const r = await call("POST", "/v1/auth/telegram", { body: { initData: forged, ageAck: true } });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatchObject({ code: "TELEGRAM_AUTH_FAILED", message: "Telegram sign-in failed" });
  });

  it("Privy is off until configured", async () => {
    expect((await call("POST", "/v1/auth/privy", { body: { accessToken: "x" } })).status).toBe(503);
  });

  it("logout kills one session, logout-all kills every one", async () => {
    const init = await telegramInit();
    const a = await call("POST", "/v1/auth/telegram", { body: { initData: init, ageAck: true } });
    const b = await call("POST", "/v1/auth/telegram", { body: { initData: init } });
    await call("POST", "/v1/auth/logout", { token: a.body.sessionToken });
    expect((await call("GET", "/v1/me", { token: a.body.sessionToken })).status).toBe(401);
    expect((await call("GET", "/v1/me", { token: b.body.sessionToken })).status).toBe(200);
    await call("POST", "/v1/auth/logout-all", { token: b.body.sessionToken });
    expect((await call("GET", "/v1/me", { token: b.body.sessionToken })).status).toBe(401);
  });

  it.each([["Bearer"], ["Bearer "], ["Basic abc"], ["Bearer bps_x"], [`Bearer bps_${"A".repeat(43)}`], ["bearer bps_x"], ["Bearer a b"]])(
    "refuses a bad Authorization header: %s",
    async (h) => {
      expect((await call("GET", "/v1/me", { headers: { authorization: h } })).status).toBe(401);
    },
  );
});

describe("idempotency over HTTP", () => {
  it("GM-moving routes need a key", async () => {
    const u = await resident();
    for (const [path, body] of [["/v1/home/buy", { pieceId: "stool" }], ["/v1/hodl-days", {}]] as const) {
      const r = await call("POST", path, { token: u.token, body });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }
    for (const bad of ["short", "has space here", "x".repeat(101), "émoji-key-123"]) {
      expect((await call("POST", "/v1/home/buy", { token: u.token, body: { pieceId: "stool" }, headers: { "idempotency-key": bad } })).status).toBe(400);
    }
  });

  it("a retried purchase charges once", async () => {
    const u = await resident();
    const h = idem();
    const a = await call("POST", "/v1/home/buy", { token: u.token, body: { pieceId: "sofa" }, headers: h });
    const b = await call("POST", "/v1/home/buy", { token: u.token, body: { pieceId: "sofa" }, headers: h });
    expect(b.body.id).toBe(a.body.id);
    expect((await call("GET", "/v1/me", { token: u.token })).body.gm).toBe(700);
  });

  it("keys are per player: the same key from someone else is a different purchase", async () => {
    const a = await resident();
    const b = await resident();
    const h = idem();
    expect((await call("POST", "/v1/home/buy", { token: a.token, body: { pieceId: "stool" }, headers: h })).status).toBe(201);
    const other = await call("POST", "/v1/home/buy", { token: b.token, body: { pieceId: "stool" }, headers: h });
    expect(other.status).toBe(201); // no IDEMPOTENCY_CONFLICT leaking a's purchase
    expect((await call("GET", "/v1/me", { token: b.token })).body.gm).toBe(985);
  });
});

describe("request hygiene", () => {
  it("refuses oversized, non-JSON, broken and non-object bodies", async () => {
    const u = await resident();
    const big = await call("PATCH", "/v1/resident", { token: u.token, raw: JSON.stringify({ name: "x".repeat(20_000) }), headers: { "content-type": "application/json" } });
    expect(big.status).toBe(413);
    expect((await call("PATCH", "/v1/resident", { token: u.token, raw: "name=x", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(415);
    expect((await call("PATCH", "/v1/resident", { token: u.token, raw: "{nope", headers: { "content-type": "application/json" } })).body.error.code).toBe("BAD_JSON");
    expect((await call("PATCH", "/v1/resident", { token: u.token, raw: "[1,2]", headers: { "content-type": "application/json" } })).body.error.code).toBe("BAD_JSON");
    expect((await call("PATCH", "/v1/resident", { token: u.token, raw: "null", headers: { "content-type": "application/json" } })).body.error.code).toBe("BAD_JSON");
  });

  it("a __proto__ payload pollutes nothing", async () => {
    const u = await resident();
    const r = await call("PATCH", "/v1/resident", { token: u.token, raw: '{"__proto__":{"admin":true},"name":"Proto Test"}', headers: { "content-type": "application/json" } });
    expect(r.status).toBe(200);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it("every response carries a request id and safe headers; errors share one shape", async () => {
    const r = await call("GET", "/v1/nope");
    expect(r.status).toBe(404);
    expect(r.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "no such route", requestId: r.headers.get("x-request-id") } });
  });

  it("a database failure is a plain 500: no SQL, no stack, but logged", async () => {
    const dead = createDb(process.env.TEST_DATABASE_URL!, { max: 1 });
    await dead.close();
    const broken = makeApp({ db: dead.db });
    const before = logs.length;
    const r = await call("POST", "/v1/auth/guest", { body: { ageAck: true }, via: broken });
    expect(r.status).toBe(500);
    expect(r.body.error).toMatchObject({ code: "INTERNAL", message: "something went wrong" });
    expect(JSON.stringify(r.body)).not.toMatch(/select|insert|postgres|stack|at /i);
    expect(logs.length).toBe(before + 1);
    expect(logs.at(-1)!.extra.requestId).toBe(r.body.error.requestId);
  });
});

describe("health", () => {
  it("is ready when the schema is current", async () => {
    const r = await call("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, schema: { upToDate: true } });
  });
});

describe("CORS", () => {
  it("answers the city's origin, ignores others", async () => {
    const ok = await call("GET", "/health", { headers: { origin: ORIGIN } });
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const evil = await call("GET", "/health", { headers: { origin: "https://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await call("OPTIONS", "/v1/gm", { headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "authorization,idempotency-key" } });
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers.get("access-control-allow-headers")).toMatch(/idempotency-key/);
  });
});

describe("rate limits", () => {
  it("guest creation is capped per IP, other IPs unaffected", async () => {
    const strict = makeApp({ limits: { guestsPerIpPerHour: 2 } });
    const ip = `192.0.2.${Math.floor(Math.random() * 250)}`;
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await call("POST", "/v1/auth/guest", { body: { ageAck: true }, ip, via: strict })).status);
    expect(codes).toEqual([201, 201, 429]);
    const blocked = await call("POST", "/v1/auth/guest", { body: { ageAck: true }, ip, via: strict });
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await call("POST", "/v1/auth/guest", { body: { ageAck: true }, via: strict })).status).toBe(201);
  });

  it("writes are capped per player, reads counted separately", async () => {
    // Moving in was already 1 write this minute (the counter lives in the database).
    const strict = makeApp({ limits: { writesPerUserPerMinute: 3, readsPerUserPerMinute: 1000 } });
    const u = await resident();
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await call("POST", "/v1/gm", { token: u.token, via: strict })).status);
    expect(codes).toEqual([200, 200, 429]);
    expect((await call("GET", "/v1/me", { token: u.token, via: strict })).status).toBe(200);
  });

  it("20 concurrent guest sign-ups from one IP with a cap of 5: exactly 5 succeed", async () => {
    const strict = makeApp({ limits: { guestsPerIpPerHour: 5 } });
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}`;
    const res = await Promise.all(Array.from({ length: 20 }, () => call("POST", "/v1/auth/guest", { body: { ageAck: true }, ip, via: strict })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(5);
    expect(res.filter((r) => r.status === 429)).toHaveLength(15);
  });
});

describe("internal routes", () => {
  it("hide behind the secret (404, not 401)", async () => {
    for (const h of [{}, { "x-internal-secret": "wrong" }, { "x-internal-secret": SECRET.slice(1) }] as Array<Record<string, string>>) {
      expect((await call("POST", "/internal/bell", { headers: h })).status).toBe(404);
    }
    const weak = makeApp({ internalSecret: "short" });
    expect((await call("POST", "/internal/bell", { headers: { "x-internal-secret": "short" }, via: weak })).status).toBe(404);
  });

  it("run the bell and the economy report with the secret", async () => {
    const r = await call("POST", "/internal/bell", { headers: { "x-internal-secret": SECRET } });
    expect(r.status).toBe(200);
    expect(r.body.ran).toBeDefined();
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date().toISOString();
    expect((await call("GET", `/internal/economy?from=${from}&to=${to}`, { headers: { "x-internal-secret": SECRET } })).body).toHaveProperty("ratio");
    expect((await call("GET", "/internal/economy?from=x&to=y", { headers: { "x-internal-secret": SECRET } })).status).toBe(400);
  });
});

describe("the Mod Shift over HTTP never reveals answers", () => {
  it("the response has items and timing only", async () => {
    const u = await resident();
    const s = await call("POST", "/v1/shifts", { token: u.token });
    expect(Object.keys(s.body).sort()).toEqual(["answerBy", "endsAt", "items", "shiftId"]);
    expect(JSON.stringify(s.body)).not.toMatch(/\b(true|false)\b/);
    void shiftPuzzle;
    void app;
  });
});

describe("the bad-input backstop", () => {
  // A database whose every call fails with Postgres's "invalid byte sequence".
  const badBytes = Object.assign(new Error("invalid byte sequence for encoding UTF8: 0x00"), { cause: { code: "22021" } });
  const throwingDb = new Proxy({}, { get: () => () => { throw badBytes; } }) as never;

  it("answers 400, not 500, and logs it so the missing validator gets added", async () => {
    const before = logs.length;
    const r = await call("POST", "/v1/auth/guest", { body: { ageAck: true }, via: makeApp({ db: throwingDb }) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("BAD_INPUT");
    expect(logs.slice(before).map((l) => l.msg)).toEqual(["input reached the database unvalidated"]);
  });

  it("only data errors get this treatment; anything else stays a logged 500", async () => {
    const other = Object.assign(new Error("connection reset"), { cause: { code: "08006" } });
    const db = new Proxy({}, { get: () => () => { throw other; } }) as never;
    const before = logs.length;
    const r = await call("POST", "/v1/auth/guest", { body: { ageAck: true }, via: makeApp({ db }) });
    expect(r.status).toBe(500);
    expect(logs.slice(before).map((l) => l.msg)).toEqual(["unhandled error"]);
  });
});

describe("moods over HTTP", () => {
  it("the candle, Copium and the hide-colour setting", async () => {
    const { grantMood } = await import("@bp/db");
    const { db } = await import("./harness");
    const u = await resident();
    expect((await call("GET", "/v1/moods", { token: u.token })).body).toMatchObject({ active: [], candle: { mood: null, color: "doji" }, copium: { free: 0, price: 30 } });
    expect((await call("POST", "/v1/copium", { token: u.token })).body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await call("POST", "/v1/copium", { token: u.token, headers: idem() })).body.error.code).toBe("NOTHING_TO_CLEAR");
    await grantMood(db, u.userId, "rekt"); // the bell would do this
    expect((await call("GET", "/v1/moods", { token: u.token })).body.candle.mood).toBe("rekt");
    expect((await call("POST", "/v1/copium", { token: u.token, headers: idem() })).body).toMatchObject({ paid: false, cleared: ["rekt"] });
    expect((await call("PATCH", "/v1/resident", { token: u.token, body: { hideCandleColor: true } })).body.hideCandleColor).toBe(true);
    expect((await call("PATCH", "/v1/resident", { token: u.token, body: { hideCandleColor: "no" } })).status).toBe(400);
  });

  it("signed-in requests run the play clock", async () => {
    const { client } = await import("./harness");
    const u = await resident();
    await call("POST", "/v1/heartbeat", { token: u.token });
    const [r] = await client`SELECT count(*)::int AS n FROM play_sessions WHERE user_id = ${u.userId}`;
    expect(r!.n).toBe(1);
  });
});

describe("City Hall over HTTP", () => {
  it("shows the wall; voting in person is refused until rooms exist", async () => {
    const { client } = await import("./harness");
    const u = await resident();
    await client`UPDATE users SET proof_of_neighbour_at = now() WHERE id = ${u.userId}`;
    const hall = await call("GET", "/v1/city-hall", { token: u.token });
    expect(hall.status).toBe(200);
    expect(hall.body.election).toHaveProperty("phase");
    expect((await call("GET", "/v1/laws", { token: u.token })).body.map((l: { id: string }) => l.id)).toContain("copium_subsidy");
    const vote = await call("POST", "/v1/election/vote", { token: u.token, body: { candidateId: u.userId } });
    expect([403, 409]).toContain(vote.status); // NOT_AT_CITY_HALL, or WRONG_PHASE outside Fri-Sun
    expect((await call("POST", "/v1/mayor/law", { token: u.token, body: { lawId: "gas_holiday" } })).body.error.code).toBe("NOT_MAYOR");
  });

  it("with a presence check wired in, a neighbour at City Hall can vote", async () => {
    const { client } = await import("./harness");
    // Next week, so the sessions made now (30-day lifetime) are still valid.
    const now = new Date();
    const daysToMonday = ((8 - now.getUTCDay()) % 7) || 7;
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToMonday, 12));
    const friday = new Date(monday.getTime() + 4 * 86_400_000);
    let clock = monday;
    const city = makeApp({ now: () => clock, presence: async () => true });
    const cand = await resident();
    const voter = await resident();
    await client`UPDATE users SET proof_of_neighbour_at = now() WHERE id IN (${cand.userId}, ${voter.userId})`;
    expect((await call("POST", "/v1/election/candidacy", { token: cand.token, body: { pitch: "Touch grass Tuesdays" }, via: city })).status).toBe(201);
    clock = friday;
    expect((await call("POST", "/v1/election/vote", { token: voter.token, body: { candidateId: cand.userId }, via: city })).body).toEqual({ voted: true });
    expect((await call("POST", "/v1/election/vote", { token: voter.token, body: { candidateId: cand.userId }, via: city })).body.error.code).toBe("ALREADY_VOTED");
  });
});
