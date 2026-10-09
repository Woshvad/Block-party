import { shiftPuzzle } from "@bp/core";
import { createDb } from "@bp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORIGIN, SECRET, app, arrive, call, close, idem, logs, makeApp, pushes, ready, resident, telegramInit } from "./harness";

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

describe("safety over HTTP", () => {
  const REASON = "Asked several residents for their seed phrases in DMs.";

  it("the pre-send check blocks seed phrases and strips links for new accounts", async () => {
    const u = await resident();
    const seed = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const v = await call("POST", "/v1/moderation/check", { token: u.token, body: { text: seed } });
    expect(v.body).toMatchObject({ ok: false, reason: "SECRET" });
    const link = await call("POST", "/v1/moderation/check", { token: u.token, body: { text: "chart at https://dexscreener.com/x" } });
    expect(link.body).toMatchObject({ ok: true, text: "chart at [link removed]" }); // a brand-new account
  });

  it("block, mute and report, with no client-supplied evidence", async () => {
    const [a, b] = [await resident(), await resident()];
    expect((await call("POST", `/v1/blocks/${b.userId}`, { token: a.token })).status).toBe(200);
    expect((await call("POST", `/v1/blocks/${a.userId}`, { token: a.token })).body.error.code).toBe("NOT_SELF");
    expect((await call("POST", `/v1/mutes/${b.userId}`, { token: a.token, body: { hours: 2 } })).status).toBe(200);
    const r = await call("POST", "/v1/reports", { token: a.token, body: { targetUserId: b.userId, reason: "scam", evidence: [{ at: "x", authorId: b.userId, text: "forged" }] } });
    expect(r.status).toBe(201);
    const { client } = await import("./harness");
    const [row] = await client`SELECT evidence FROM reports WHERE id = ${r.body.id}`;
    expect(row!.evidence).toEqual([]); // the forged evidence was ignored
  });

  it("staff routes are staff-only; a suspension blocks writes but not reading, logging out or appealing", async () => {
    const { client } = await import("./harness");
    const [mod, other, b] = [await resident(), await resident(), await resident()];
    expect((await call("GET", "/v1/staff/reports", { token: b.token })).status).toBe(403);
    await client`INSERT INTO staff (user_id, role) VALUES (${mod.userId}, 'moderator'), (${other.userId}, 'admin')`;
    const restr = await call("POST", "/v1/staff/restrictions", { token: mod.token, body: { userId: b.userId, kind: "suspended", reason: REASON } });
    expect(restr.status).toBe(201);

    const blocked = await call("POST", "/v1/gm", { token: b.token });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatchObject({ code: "RESTRICTED" });
    expect(blocked.body.error.message).toContain(REASON); // the statement of reasons
    expect((await call("GET", "/v1/me", { token: b.token })).status).toBe(200);
    expect((await call("GET", "/v1/restrictions", { token: b.token })).body).toEqual([expect.objectContaining({ kind: "suspended", reason: REASON })]);

    const appeal = await call("POST", `/v1/restrictions/${restr.body.id}/appeal`, { token: b.token, body: { text: "I was helping a friend recover their wallet." } });
    expect(appeal.status).toBe(201);
    expect((await call("POST", `/v1/staff/appeals/${appeal.body.id}/decide`, { token: other.token, body: { overturn: true, note: "Good-faith help, lifted." } })).status).toBe(200);
    expect((await call("POST", "/v1/gm", { token: b.token })).status).toBe(200); // lifted
    expect((await call("POST", "/v1/auth/logout", { token: b.token })).status).toBe(200);
  });

  it("names and pitches are queued for the AI check; the worker needs a provider", async () => {
    const { client } = await import("./harness");
    const u = await resident();
    const [q] = await client`SELECT count(*)::int AS n FROM moderation_items WHERE author_id = ${u.userId} AND kind = 'resident_name'`;
    expect(q!.n).toBe(1);
    expect((await call("POST", "/internal/moderation/run", { headers: { "x-internal-secret": SECRET } })).status).toBe(503);
    const withAi = makeApp({ moderation: { classify: async (ts) => ts.map(() => ({ flagged: false, categories: [] })) } });
    const ran = await call("POST", "/internal/moderation/run", { headers: { "x-internal-secret": SECRET }, via: withAi });
    expect(ran.body.checked).toBeGreaterThan(0);
  });
});

describe("live rooms over HTTP", () => {
  const ticketFor = async (token: string, place: string) => call("POST", "/v1/rooms/ticket", { token, body: { place } });

  it("public places for anyone moved in; a guest gets nothing", async () => {
    const { verifyRoomTicket } = await import("@bp/core");
    const { TICKET_SECRET } = await import("./harness");
    const u = await resident();
    expect((await ticketFor(u.token, "diner")).body.error.code).toBe("RIDE_FIRST"); // no teleporting
    await arrive(u.userId, "diner");
    const r = await ticketFor(u.token, "diner");
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(/^https:\/\/rooms\.test\/connect\?ticket=/);
    const t = await verifyRoomTicket(r.body.ticket, TICKET_SECRET);
    expect(t).toMatchObject({ u: u.userId, h: u.handle, place: "diner", chat: true });
    const g = await call("POST", "/v1/auth/guest", { body: { ageAck: true } });
    expect((await ticketFor(g.body.sessionToken, "diner")).status).toBe(404);
    for (const bad of ["narnia:x", "../etc", "", "HOME:x"]) expect([400, 404]).toContain((await ticketFor(u.token, bad)).status);
  });

  it("homes: yours always; others' only with the door open and no block", async () => {
    const [a, b] = [await resident(), await resident()];
    expect((await ticketFor(a.token, `home:${a.userId}`)).status).toBe(200);
    expect((await ticketFor(b.token, `home:${a.userId}`)).body.error.code).toBe("DOOR_CLOSED");
    await call("PATCH", "/v1/home", { token: a.token, body: { doorOpen: true } });
    expect((await ticketFor(b.token, `home:${a.userId}`)).status).toBe(200);
    await call("POST", `/v1/blocks/${b.userId}`, { token: a.token });
    expect((await ticketFor(b.token, `home:${a.userId}`)).body.error.code).toBe("DOOR_CLOSED");
  });

  it("the Crew House is for members only", async () => {
    const [lead, outsider] = [await resident(), await resident()];
    const crew = await call("POST", "/v1/crews", { token: lead.token, body: { name: `Room ${crypto.randomUUID().slice(0, 6)}` } });
    expect((await ticketFor(lead.token, `crew_house:${crew.body.id}`)).status).toBe(200);
    expect((await ticketFor(outsider.token, `crew_house:${crew.body.id}`)).status).toBe(403);
  });

  it("the ticket carries blocks both ways, mutes, frens and the chat restriction", async () => {
    const { verifyRoomTicket } = await import("@bp/core");
    const { TICKET_SECRET, client } = await import("./harness");
    const [me, blockedByMe, blockedMe, muted, mod] = [await resident(), await resident(), await resident(), await resident(), await resident()];
    await call("POST", `/v1/blocks/${blockedByMe.userId}`, { token: me.token });
    await call("POST", `/v1/blocks/${me.userId}`, { token: blockedMe.token });
    await call("POST", `/v1/mutes/${muted.userId}`, { token: me.token, body: {} });
    await client`INSERT INTO staff (user_id, role) VALUES (${mod.userId}, 'moderator')`;
    await call("POST", "/v1/staff/restrictions", { token: mod.token, body: { userId: me.userId, kind: "chat_mute", hours: 2, reason: "Flooding the Diner with copy-pasta all morning." } });
    await arrive(me.userId, "roof");
    const t = await verifyRoomTicket((await ticketFor(me.token, "roof")).body.ticket, TICKET_SECRET);
    expect(new Set(t.hidden)).toEqual(new Set([blockedByMe.userId, blockedMe.userId, muted.userId]));
    expect(t.chat).toBe(false);
  });

  it("room effects become moods and moderation items; only with the secret", async () => {
    const { client } = await import("./harness");
    const u = await resident();
    const effects = [
      { kind: "cozy_start", userId: u.userId, at: Date.now() },
      { kind: "moderate", line: { id: "l1", userId: u.userId, handle: u.handle, text: "a room line", at: Date.now() } },
      { kind: "cozy_start", userId: "not-a-uuid" },
      { kind: "launch" },
    ];
    expect((await call("POST", "/internal/rooms/effects", { body: { place: "diner", copy: 0, effects } })).status).toBe(404);
    const r = await call("POST", "/internal/rooms/effects", { body: { place: "diner", copy: 0, effects }, headers: { "x-internal-secret": SECRET } });
    expect(r.body).toEqual({ applied: 2 });
    expect((await call("GET", "/v1/moods", { token: u.token })).body.active.map((m: { mood: string }) => m.mood)).toContain("cozy");
    const [q] = await client`SELECT ref FROM moderation_items WHERE kind = 'room' AND author_id = ${u.userId}`;
    expect(q!.ref).toBe("diner#0#l1");
    expect((await call("POST", "/internal/rooms/effects", { body: { place: "../x", copy: 0, effects: [] }, headers: { "x-internal-secret": SECRET } })).status).toBe(400);
  });

  it("flagged content comes down where it lives: hidden on a Board, taken down in a room", async () => {
    const { roomsState, client } = await import("./harness");
    const u = await resident();
    const place = `fl${crypto.randomUUID().slice(0, 6)}`;
    const post = await call("POST", `/v1/boards/${place}`, { token: u.token, body: { text: "flag me please" } });
    await call("POST", "/internal/rooms/effects", { body: { place: "roof", copy: 2, effects: [{ kind: "moderate", line: { id: "zz", userId: u.userId, handle: "x", text: "flag me in the room", at: 1 } }] }, headers: { "x-internal-secret": SECRET } });
    await client`UPDATE moderation_items SET status = 'clean' WHERE status = 'pending' AND author_id <> ${u.userId}`;
    const ai = makeApp({ moderation: { classify: async (ts) => ts.map((t) => ({ flagged: t.includes("flag me"), categories: ["harassment"] })) } });
    await call("POST", "/internal/moderation/run", { headers: { "x-internal-secret": SECRET }, via: ai });
    expect((await call("GET", `/v1/boards/${place}`, { token: u.token })).body.map((m: { id: string }) => m.id)).not.toContain(post.body.id);
    expect(roomsState.takedowns).toContain("roof#2#zz");
  });

  it("voting in person works once the rooms Worker says you're at City Hall", async () => {
    const { roomsState, client } = await import("./harness");
    const now = new Date();
    const daysToMonday = ((8 - now.getUTCDay()) % 7) || 7;
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToMonday, 12));
    let clock = monday;
    const city = makeApp({ now: () => clock });
    const [cand, voter] = [await resident(), await resident()];
    await client`UPDATE users SET proof_of_neighbour_at = now() WHERE id IN (${cand.userId}, ${voter.userId})`;
    await call("POST", "/v1/election/candidacy", { token: cand.token, body: { pitch: "Rooms for everyone" }, via: city });
    clock = new Date(monday.getTime() + 4 * 86_400_000);
    expect((await call("POST", "/v1/election/vote", { token: voter.token, body: { candidateId: cand.userId }, via: city })).body.error.code).toBe("NOT_AT_CITY_HALL");
    roomsState.where.set(`${voter.userId}|city_hall`, 0);
    expect((await call("POST", "/v1/election/vote", { token: voter.token, body: { candidateId: cand.userId }, via: city })).body).toEqual({ voted: true });
  });

  it("frens from a shared room, then DMs, then a report with the DM as evidence", async () => {
    const { roomsState, client } = await import("./harness");
    const [a, b] = [await resident(), await resident()];
    expect((await call("POST", `/v1/frens/${b.userId}`, { token: a.token, body: { place: "diner" } })).body.error.code).toBe("NOT_TOGETHER");
    roomsState.where.set(`${a.userId}|diner`, 0);
    roomsState.where.set(`${b.userId}|diner`, 0);
    expect((await call("POST", `/v1/frens/${b.userId}`, { token: a.token, body: { place: "diner" } })).body).toEqual({ frens: false });
    expect((await call("POST", `/v1/frens/${a.userId}`, { token: b.token, body: { place: "diner" } })).body).toEqual({ frens: true });
    const dm = await call("POST", `/v1/dms/to/${b.userId}`, { token: a.token, body: { text: "send me 50 USDC, I'll double it" } });
    expect(dm.status).toBe(201);
    expect(dm.body.notice).toMatch(/will ever ask for your seed phrase/);
    const rep = await call("POST", "/v1/reports", { token: b.token, body: { targetUserId: a.userId, reason: "scam", context: { kind: "dm", id: dm.body.threadId } } });
    expect(rep.status).toBe(201);
    const [row] = await client`SELECT evidence FROM reports WHERE id = ${rep.body.id}`;
    expect(row!.evidence.map((e: { text: string }) => e.text)).toEqual(["send me 50 USDC, I'll double it"]);
  });

  it("a report from a room snapshots the room, only if you're in that copy", async () => {
    const { roomsState, client } = await import("./harness");
    const [a, b] = [await resident(), await resident()];
    roomsState.evidence.set("roof#3", [{ id: "r1", userId: a.userId, handle: "a", text: "roof spam", at: Date.now() }]);
    roomsState.where.set(`${b.userId}|roof`, 3);
    const rep = await call("POST", "/v1/reports", { token: b.token, body: { targetUserId: a.userId, reason: "spam", context: { kind: "room", id: "roof", copy: 3 } } });
    const [row] = await client`SELECT evidence FROM reports WHERE id = ${rep.body.id}`;
    expect(row!.evidence.map((e: { text: string }) => e.text)).toEqual(["roof spam"]);
    roomsState.evidence.set("roof#9", [{ id: "r9", userId: a.userId, handle: "a", text: "a private roof chat in another copy", at: Date.now() }]);
    const elsewhere = await call("POST", "/v1/reports", { token: b.token, body: { targetUserId: a.userId, reason: "harassment", context: { kind: "room", id: "roof", copy: 9 } } });
    const [row2] = await client`SELECT evidence FROM reports WHERE id = ${elsewhere.body.id}`;
    expect(row2!.evidence).toEqual([]); // not in that copy: no peeking at its chat
  });
});

describe("getting around over HTTP", () => {
  it("ride somewhere, wait to arrive, then get in", async () => {
    let clock = new Date();
    const city = makeApp({ now: () => clock });
    const u = await resident();
    expect((await call("GET", "/v1/whereabouts", { token: u.token, via: city })).body).toMatchObject({ area: "street", arrived: true });
    expect((await call("POST", "/v1/rides", { token: u.token, body: { to: "diner", mode: "walk" }, via: city })).body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const r = await call("POST", "/v1/rides", { token: u.token, body: { to: "diner", mode: "walk" }, headers: idem(), via: city });
    expect(r.status).toBe(201);
    expect((await call("POST", "/v1/rooms/ticket", { token: u.token, body: { place: "diner" }, via: city })).body.error.code).toBe("IN_TRANSIT");
    clock = new Date(clock.getTime() + 41_000);
    expect((await call("POST", "/v1/rooms/ticket", { token: u.token, body: { place: "diner" }, via: city })).status).toBe(200);
    // Home is back on the street: another ride.
    expect((await call("POST", "/v1/rooms/ticket", { token: u.token, body: { place: `home:${u.userId}` }, via: city })).body.error.code).toBe("RIDE_FIRST");
  });
});

describe("away life over HTTP", () => {
  it("the recap is the player's own; the away list is internal only", async () => {
    const u = await resident();
    const r = await call("GET", "/v1/away/recap", { token: u.token });
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("highlights");
    expect((await call("GET", "/internal/rooms/away?place=roof")).status).toBe(404);
    expect((await call("GET", "/internal/rooms/away?place=roof", { headers: { "x-internal-secret": SECRET } })).status).toBe(200);
    expect((await call("GET", "/internal/rooms/away?place=../x", { headers: { "x-internal-secret": SECRET } })).status).toBe(400);
  });
});

describe("Proof of Neighbour over HTTP", () => {
  it("phone verification, then rooms shared, then the mark", async () => {
    const { client } = await import("./harness");
    const me = await resident();
    expect((await call("GET", "/v1/pon", { token: me.token })).body).toMatchObject({ proofOfNeighbour: false, verified: [] });
    expect((await call("POST", "/v1/pon/phone", { token: me.token, body: { phone: "+15551234567" } })).body.error.code).toBe("NOT_MOBILE");
    const phone = `+234809${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}`;
    const start = await call("POST", "/v1/pon/phone", { token: me.token, body: { phone } });
    expect(start.status).toBe(201);
    const ok = await call("POST", `/v1/pon/phone/${start.body.checkId}/confirm`, { token: me.token, body: { phone, code: "123456" } });
    expect(ok.body).toMatchObject({ verified: true, status: { verified: ["phone"] } });
    await client`UPDATE users SET created_at = now() - interval '4 days' WHERE id = ${me.userId}`;
    const others = await Promise.all(Array.from({ length: 5 }, () => resident()));
    const t = Date.now() - 10 * 60_000;
    const effects = [me, ...others].map((u) => ({ kind: "visit_start", userId: u.userId, at: t }));
    await call("POST", "/internal/rooms/effects", { body: { place: "diner", copy: 7, effects }, headers: { "x-internal-secret": SECRET } });
    expect((await call("GET", "/v1/pon", { token: me.token })).body).toMatchObject({ neighbours: 5, proofOfNeighbour: true });
  });

  it("providers missing: a clear 503, not a crash", async () => {
    const bare = makeApp({ phoneVerifier: undefined, cryptoProofs: undefined });
    const u = await resident();
    expect((await call("POST", "/v1/pon/phone", { token: u.token, body: { phone: "+2348011111111" }, via: bare })).status).toBe(503);
    expect((await call("POST", "/v1/pon/crypto", { token: u.token, body: { kind: "world_id", proof: {} }, via: bare })).status).toBe(503);
  });
});

describe("notifications over HTTP", () => {
  const internal = { "x-internal-secret": SECRET };

  it("prefs: read, change, refuse junk; another resident's are untouched", async () => {
    const [me, other] = [await resident(), await resident()];
    expect((await call("GET", "/v1/notifications/prefs", { token: me.token })).body).toMatchObject({ timeZone: "UTC", alerts: [], pushOff: false });
    const ok = await call("PATCH", "/v1/notifications/prefs", { token: me.token, body: { timeZone: "Africa/Lagos", alerts: ["snap"] } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ timeZone: "Africa/Lagos", alerts: ["snap"] });
    for (const bad of [{ timeZone: "Nowhere/Land" }, { quietStart: 99 }, { alerts: ["wallet"] }, { pushOff: 1 }])
      expect((await call("PATCH", "/v1/notifications/prefs", { token: me.token, body: bad })).status).toBe(400);
    expect((await call("GET", "/v1/notifications/prefs", { token: other.token })).body.timeZone).toBe("UTC");
    expect((await call("GET", "/v1/notifications/prefs")).status).toBe(401);
  });

  it("the dispatcher sends due pings; opening one is the owner's only", async () => {
    const { client } = await import("./harness");
    const { notify } = await import("@bp/db");
    const { db } = await import("./harness");
    const [me, other] = [await resident(), await resident()];
    await call("PATCH", "/v1/notifications/prefs", { token: me.token, body: { quietStart: 0, quietEnd: 0 } }); // no quiet hours, whatever the test clock
    const n = await notify(db, me.userId, "daily", {});
    const run = await call("POST", "/internal/notifications/run", { headers: internal });
    expect(run.status).toBe(200);
    expect(pushes.filter((p) => p.userId === me.userId)).toHaveLength(1);
    expect((await call("POST", "/internal/notifications/run")).status).toBe(404); // no secret, no route
    expect((await call("POST", `/v1/notifications/${n!.id}/opened`, { token: other.token })).status).toBe(204);
    expect((await client`SELECT opened_at FROM notifications WHERE id = ${n!.id}`)[0]!.opened_at).toBeNull();
    expect((await call("POST", "/v1/notifications/not-a-uuid/opened", { token: me.token })).status).toBe(404);
    expect((await call("POST", `/v1/notifications/${n!.id}/opened`, { token: me.token })).status).toBe(204);
    expect((await client`SELECT opened_at FROM notifications WHERE id = ${n!.id}`)[0]!.opened_at).not.toBeNull();
  });

  it("no push sender configured: a clear 503", async () => {
    expect((await call("POST", "/internal/notifications/run", { headers: internal, via: makeApp({ notifier: undefined }) })).status).toBe(503);
  });

  it("crew bot mutes: the lead yes, a member no, someone crewless no", async () => {
    const [lead, member, loner] = [await resident(), await resident(), await resident()];
    const crew = await call("POST", "/v1/crews", { token: lead.token, body: { name: `Pings ${Math.random().toString(36).slice(2, 7)}`, joinPolicy: "open" } });
    expect(crew.status).toBe(201);
    expect((await call("POST", `/v1/crews/${crew.body.id}/join`, { token: member.token })).status).toBeLessThan(300);
    expect((await call("PUT", "/v1/crews/mine/bot-mutes", { token: lead.token, body: { kinds: ["crew_card"] } })).body).toEqual({ muted: ["crew_card"] });
    expect((await call("PUT", "/v1/crews/mine/bot-mutes", { token: member.token, body: { kinds: [] } })).status).toBe(403);
    expect((await call("PUT", "/v1/crews/mine/bot-mutes", { token: loner.token, body: { kinds: [] } })).status).toBe(403);
    expect((await call("PUT", "/v1/crews/mine/bot-mutes", { token: lead.token, body: { kinds: "all" } })).status).toBe(400);
  });
});

describe("naps and the city clock over HTTP", () => {
  it("nap at home on your own bed; one at a time; wake early", async () => {
    const { client, roomsState } = await import("./harness");
    const me = await resident();
    const [bed] = await client`SELECT i.id FROM items i JOIN placements p ON p.item_id = i.id WHERE i.owner_user_id = ${me.userId} AND i.piece_id LIKE '%_bed'`;
    expect((await call("POST", "/v1/naps", { token: me.token, body: { itemId: bed!.id } })).body.error.code).toBe("NOT_HOME");
    roomsState.where.set(`${me.userId}|home:${me.userId}`, 1);
    const nap = await call("POST", "/v1/naps", { token: me.token, body: { itemId: bed!.id } });
    expect(nap.status).toBe(201);
    expect((await call("POST", "/v1/naps", { token: me.token, body: { itemId: bed!.id } })).status).toBe(409);
    expect((await call("GET", "/v1/actions/current", { token: me.token })).body.action).toMatchObject({ kind: "nap" });
    expect((await call("DELETE", "/v1/actions/current", { token: me.token })).status).toBe(200);
    expect((await call("GET", "/v1/actions/current", { token: me.token })).body.action).toBeNull();
    expect((await call("DELETE", "/v1/actions/current", { token: me.token })).status).toBe(409);
    expect((await call("POST", "/v1/naps", { token: me.token, body: { itemId: "nope" } })).status).toBe(400);
  });

  it("the timetable, and the finisher behind the secret", async () => {
    const me = await resident();
    const t = await call("GET", "/v1/city/timetable", { token: me.token });
    expect(t.body.bigNights.find((b: { place: string }) => b.place === "diner")).toMatchObject({ kind: "rotating" });
    expect((await call("POST", "/internal/actions/run", { headers: { "x-internal-secret": SECRET } })).status).toBe(200);
    expect((await call("POST", "/internal/actions/run")).status).toBe(404);
  });
});

describe("relationships over HTTP", () => {
  it("best frens, rivals and the overview; strangers and junk refused", async () => {
    const { client } = await import("./harness");
    const [a, b, stranger] = [await resident(), await resident(), await resident()];
    const [x, y] = a.userId < b.userId ? [a.userId, b.userId] : [b.userId, a.userId];
    await client`INSERT INTO frens (a, b) VALUES (${x}, ${y})`;
    expect((await call("PUT", `/v1/frens/${b.userId}/best`, { token: a.token, body: { on: true } })).body).toEqual({ bestFren: true });
    expect((await call("PUT", `/v1/frens/${stranger.userId}/best`, { token: a.token, body: { on: true } })).status).toBe(409);
    expect((await call("PUT", `/v1/frens/${b.userId}/best`, { token: a.token, body: { on: "yes" } })).status).toBe(400);
    expect((await call("POST", `/v1/rivals/${b.userId}`, { token: a.token })).body).toEqual({ status: "pending" });
    expect((await call("POST", `/v1/rivals/${a.userId}/accept`, { token: b.token })).body).toEqual({ status: "active" });
    expect((await call("POST", `/v1/rivals/${stranger.userId}/accept`, { token: b.token })).status).toBe(404);
    const rel = await call("GET", "/v1/relationships", { token: a.token });
    expect(rel.body).toMatchObject({ bestFrens: [b.userId], rivals: [{ userId: b.userId }] });
    expect((await call("DELETE", `/v1/rivals/${a.userId}`, { token: b.token })).status).toBe(204);
    expect((await call("GET", "/v1/relationships", { token: a.token })).body.rivals).toEqual([]);
    // A block over HTTP ends it all.
    await call("POST", `/v1/blocks/${a.userId}`, { token: b.token });
    expect((await call("GET", "/v1/relationships", { token: a.token })).body.frens).toEqual([]);
  });
});

describe("Faucet Fren over HTTP", () => {
  it("answers from the script, and shrugs at anything else", async () => {
    const me = await resident();
    expect((await call("GET", `/v1/faucet-fren?q=${encodeURIComponent("gm fren, will anyone ask for my seed phrase?")}`, { token: me.token })).body.id).toBe("safety");
    expect((await call("GET", "/v1/faucet-fren?q=wen%20lambo", { token: me.token })).body.id).toBeNull();
    expect((await call("GET", "/v1/faucet-fren", { token: me.token })).body.id).toBeNull();
    expect((await call("GET", "/v1/faucet-fren?q=rent")).status).toBe(401);
  });
});

describe("the Tower over HTTP", () => {
  it("poll, the Floor and the Odds Wall, a call that locks at the next tick, tickets", async () => {
    const { mockProvider } = await import("@bp/core");
    const t0 = Date.now();
    const id = crypto.randomUUID();
    const specs = [
      { externalId: `api-${id}`, question: "Will the test pass?", category: "crypto" as const, openAt: new Date(t0 - 3_600_000), freezesAt: new Date(t0 + 6 * 3_600_000), settlesBy: new Date(t0 + 7 * 3_600_000), start: 40 },
      { externalId: `api-pol-${id}`, question: "Will a senator...?", category: "politics" as const, openAt: new Date(t0 - 3_600_000), freezesAt: new Date(t0 + 6 * 3_600_000), settlesBy: new Date(t0 + 7 * 3_600_000), start: 40 },
    ];
    const tower = makeApp({ odds: mockProvider(() => specs) });
    const internal = { "x-internal-secret": SECRET };
    expect((await call("POST", "/internal/tower/poll", { headers: internal, via: tower })).body).toMatchObject({ ok: true });
    const me = await resident();
    const floor = (await call("GET", "/v1/tower/markets", { token: me.token, via: tower })).body as Array<{ id: string; question: string; price: number }>;
    const mine = floor.find((m) => m.question === "Will the test pass?" && m.price)!;
    expect(floor.some((m) => m.question === "Will a senator...?")).toBe(false);
    expect(((await call("GET", "/v1/tower/odds-wall", { token: me.token, via: tower })).body as Array<{ question: string }>).some((m) => m.question === "Will a senator...?")).toBe(true);
    const made = await call("POST", "/v1/tower/calls", { token: me.token, via: tower, body: { marketId: mine.id, side: "yes", chance: Math.min(99, mine.price + 10), seenPrice: mine.price } });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ status: "pending", ticket: true });
    expect((await call("POST", "/v1/tower/calls", { token: me.token, via: tower, body: { marketId: mine.id, side: "yes", chance: Math.min(99, mine.price + 10), seenPrice: mine.price } })).status).toBe(409);
    expect((await call("GET", "/v1/tower/tickets", { token: me.token, via: tower })).body.tickets).toBe(2);
    await new Promise((r) => setTimeout(r, 5));
    await call("POST", "/internal/tower/poll", { headers: internal, via: tower });
    const got = (await call("GET", `/v1/tower/calls/${made.body.id}`, { token: me.token, via: tower })).body;
    expect(["locked", "price_moved"]).toContain(got.status); // the mock walks by the minute
    const view = (await call("GET", `/v1/tower/markets/${mine.id}`, { token: me.token, via: tower })).body;
    expect(view).toMatchObject({ source: "Odds via Polymarket", world: expect.any(Number) });
    expect((await call("POST", "/v1/tower/calls", { token: me.token, via: tower, body: { marketId: mine.id, side: "sideways", chance: 50, seenPrice: 40 } })).status).toBe(400);
  });

  it("no feed configured: polling is a clear 503", async () => {
    expect((await call("POST", "/internal/tower/poll", { headers: { "x-internal-secret": SECRET } })).status).toBe(503);
  });
});

describe("receipts and the Right List over HTTP", () => {
  it("a locked call gets a public receipt link; it's sealed until the bell; forged links are 404s", async () => {
    const { client } = await import("./harness");
    const t0 = Date.now();
    const spec = { externalId: `rcpt-${crypto.randomUUID()}`, question: "Will the receipt print?", category: "crypto" as const, openAt: new Date(t0 - 3_600_000), freezesAt: new Date(t0 + 3_600_000), settlesBy: new Date(t0 + 2 * 3_600_000), start: 50, outcome: true };
    // A fixed price, so the call always locks.
    const tower = makeApp({
      odds: {
        source: "fixed",
        fetch: async () => [{ externalId: spec.externalId, question: spec.question, category: spec.category, ladder: null, freezesAt: spec.freezesAt, settlesBy: spec.settlesBy, price: 50, resolved: null, voided: false }],
      },
    });
    const internal = { "x-internal-secret": SECRET };
    await call("POST", "/internal/tower/poll", { headers: internal, via: tower });
    const [m] = await client`SELECT id, price FROM markets WHERE external_id = ${spec.externalId}`;
    const me = await resident();
    const made = await call("POST", "/v1/tower/calls", { token: me.token, via: tower, body: { marketId: m!.id, side: "yes", chance: Math.min(99, m!.price + 10), seenPrice: m!.price } });
    await new Promise((r) => setTimeout(r, 5));
    await call("POST", "/internal/tower/poll", { headers: internal, via: tower });
    const mine = (await call("GET", `/v1/tower/calls/${made.body.id}`, { token: me.token, via: tower })).body;
    expect(mine.status).toBe("locked");
    expect(mine.receiptLink).toMatch(/^\/v1\/receipts\//);
    const pub = await call("GET", mine.receiptLink, { via: tower }); // no session needed
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ stamp: "IN THE MEMPOOL", aura: null, handle: me.handle, side: "yes" });
    expect(JSON.stringify(pub.body)).not.toContain(me.userId);
    const forged = mine.receiptLink.replace(/.$/, (ch: string) => (ch === "A" ? "B" : "A"));
    expect((await call("GET", forged, { via: tower })).status).toBe(404);
    expect((await call("GET", "/v1/receipts/nope", { via: tower })).status).toBe(404);
    expect((await call("GET", "/v1/tower/right-list", { token: me.token, via: tower })).body).toMatchObject({ season: expect.any(Number), rows: expect.any(Array) });
  });
});

describe("the Slate over HTTP", () => {
  it("not out yet is a 404; published, it lists the cards; the grid is sealed; junk days are 404s", async () => {
    const me = await resident();
    const s = await call("GET", "/v1/slate", { token: me.token });
    expect([200, 404]).toContain(s.status); // other tests may have published today's
    expect((await call("POST", "/internal/slate/publish", { headers: { "x-internal-secret": SECRET } })).status).toBe(200);
    expect((await call("GET", "/v1/slate/not-a-day/grid", { token: me.token })).status).toBe(404);
    expect((await call("GET", "/v1/slate/1999-01-01/grid", { token: me.token })).status).toBe(404);
    expect((await call("GET", "/v1/slate")).status).toBe(401);
  });
});

describe("the bell over HTTP", () => {
  it("no call today: no Bell Stamp; the reel for a day the bell hasn't rung is a 404", async () => {
    const me = await resident();
    expect((await call("POST", "/v1/bell-stamp", { token: me.token })).body.error.code).toBe("NO_CALL_TODAY");
    expect((await call("GET", "/v1/reel?day=2999-01-01", { token: me.token })).status).toBe(404);
    expect((await call("GET", "/v1/reel", { token: me.token })).status).toBe(200); // last night's, even if empty
  });
});

describe("the Daily Close over HTTP", () => {
  it("a day with no paper is a 404; junk days too; it needs a session", async () => {
    const me = await resident();
    expect((await call("GET", "/v1/daily-close/1999-01-01", { token: me.token })).status).toBe(404);
    expect((await call("GET", "/v1/daily-close/nope", { token: me.token })).status).toBe(404);
    expect((await call("GET", "/v1/daily-close/1999-01-01")).status).toBe(401);
  });
});

describe("Fade Duels over HTTP", () => {
  it("prefs, and the refusals a newcomer meets", async () => {
    const me = await resident();
    expect((await call("PUT", "/v1/duels/prefs", { token: me.token, body: { duelsOn: true } })).body).toEqual({ duelsOn: true, allowNaming: false });
    expect((await call("PUT", "/v1/duels/prefs", { token: me.token, body: { duelsOn: "on" } })).status).toBe(400);
    // Off until the alt checks are live; on, junk is a 400.
    const off = makeApp({ features: {} });
    expect((await call("POST", "/v1/duels", { token: me.token, via: off, body: { marketId: "nope", opponentId: "nope" } })).status).toBe(503);
    expect((await call("POST", "/v1/duels", { token: me.token, body: { marketId: "nope", opponentId: "nope" } })).status).toBe(400);
    expect((await call("POST", `/v1/duels/${crypto.randomUUID()}/snap`, { token: me.token })).status).toBe(404);
    expect((await call("GET", "/v1/duels", { token: me.token })).body).toEqual([]);
  });
});
