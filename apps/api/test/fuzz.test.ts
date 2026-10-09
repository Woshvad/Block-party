import { seededRandomInt } from "@bp/core";
import { reconcile } from "@bp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, call, client, close, db, logs, ready, resident } from "./harness";

const PUBLIC = new Set(["GET /health", "GET /v1/catalogue", "POST /v1/auth/guest", "POST /v1/auth/telegram", "POST /v1/auth/privy", "GET /v1/receipts/:token"]);
// Server-only actions that must never get a route.
const FORBIDDEN = /streak|mint|grant|burn|halving|set-?up-?home|collect-?rent|record|tilt|cozy|staff\/(grant|add|roles)|evidence/i;

const routes = [
  ...new Map(
    app.routes
      .filter((r) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(r.method) && r.path !== "*" && !r.path.endsWith("/*"))
      .map((r) => [`${r.method} ${r.path}`, { method: r.method, path: r.path }]),
  ).values(),
];

beforeAll(ready);
afterAll(close);

describe("route table", () => {
  it("has the routes we expect, and none for server-only actions", () => {
    expect(routes.length).toBeGreaterThan(45);
    expect(routes.filter((r) => FORBIDDEN.test(r.path)).map((r) => r.path)).toEqual([]);
  });

  it.each(routes.filter((r) => !PUBLIC.has(`${r.method} ${r.path}`)))("$method $path refuses callers without a session or secret", async (r) => {
    const path = r.path.replace(/:[a-zA-Z]+/g, "00000000-0000-4000-8000-000000000000");
    const res = await call(r.method, path, r.method === "GET" ? {} : { body: {} });
    expect(res.status).toBe(r.path.startsWith("/internal/") ? 404 : 401);
  });
});

// Hostile values, used for path params and body fields alike.
const NASTY: unknown[] = [
  "",
  " ",
  "x",
  "\u0000",
  "a\u0000b",
  "' OR '1'='1",
  "'; DROP TABLE users; --",
  "../../../etc/passwd",
  "%00",
  "%2e%2e%2f",
  "<script>alert(1)</script>",
  "𝔘𝔫𝔦𝔠𝔬𝔡𝔢",
  "‮evil",
  "x".repeat(5000),
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "not-a-uuid-but-36-characters-long-xx",
  0,
  -1,
  1.5,
  1e308,
  -1e308,
  Number.MAX_SAFE_INTEGER + 2,
  NaN,
  true,
  false,
  null,
  [],
  [null],
  {},
  { __proto__: { admin: true } },
  { $gt: "" },
  [[[[[[[[[[[]]]]]]]]]]],
];
const FIELDS = ["text", "firstDm", "targetUserId", "reason", "place", "note", "hours", "action", "restriction", "overturn", "kind", "pitch", "candidateId", "lawId", "hideCandleColor", "name", "handle", "look", "traits", "goal", "kitStyle", "pieceId", "code", "amount", "answers", "room", "placement", "layer", "x", "y", "rot", "color", "wall", "floor", "doorOpen", "deputy", "userId", "ttlHours", "joinPolicy", "banner", "ageAck", "initData", "accessToken"];

function hostileBody(rand: (n: number) => number): unknown {
  const kind = rand(5);
  if (kind === 0) return NASTY[rand(NASTY.length)];
  const o: Record<string, unknown> = {};
  for (let i = 0, n = 1 + rand(5); i < n; i++) o[FIELDS[rand(FIELDS.length)]!] = NASTY[rand(NASTY.length)];
  if (kind === 1) o.placement = { layer: NASTY[rand(NASTY.length)], x: NASTY[rand(NASTY.length)], y: 1, rot: 0, color: 0 };
  return o;
}

const asPathSegment = (v: unknown) => encodeURIComponent(typeof v === "string" ? v : JSON.stringify(v) ?? "null");

describe("fuzzing every route with a real session", () => {
  type World = { lead: Awaited<ReturnType<typeof resident>>; member: Awaited<ReturnType<typeof resident>>; realIds: string[] };

  // A fresh crew for every route: fuzzing logout, leave or dissolve must not
  // wreck the session the other routes are fuzzed with. (It once did, and the
  // fuzzer quietly tested nothing but 401s.)
  async function world(): Promise<World> {
    const lead = await resident();
    const member = await resident();
    const crew = await call("POST", "/v1/crews", { token: lead.token, body: { name: `Fuzz ${crypto.randomUUID().slice(0, 6)}` } });
    const inv = await call("POST", "/v1/crews/mine/invites", { token: lead.token, body: {} });
    await call("POST", "/v1/crews/join", { token: member.token, body: { code: inv.body.code } });
    await call("POST", "/v1/crews/mine/pot", { token: member.token, body: { amount: 300 }, headers: { "idempotency-key": crypto.randomUUID() } });
    const item = await call("POST", "/v1/home/buy", { token: member.token, body: { pieceId: "stool" }, headers: { "idempotency-key": crypto.randomUUID() } });
    return { lead, member, realIds: [crew.body.id, member.userId, item.body.id, lead.userId, inv.body.code] };
  }

  // Signed-out routes don't count; for the rest, a 401 means the fuzzer lost
  // its session and stopped reaching the handler.
  const unauthenticated = (res: { body: { error?: { code?: string } } }) => res.body?.error?.code === "UNAUTHENTICATED";

  it.each(routes.filter((r) => !r.path.startsWith("/internal/")))("$method $path never 500s on hostile input", async (r) => {
    const { lead, member, realIds } = await world();
    const rand = seededRandomInt([...`${r.method}${r.path}`].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) >>> 0);
    const failures: string[] = [];
    for (let i = 0; i < 60; i++) {
      // Mix in real ids (someone else's item, a crew) so authorisation gets tested too.
      const param = () => (rand(4) === 0 ? realIds[rand(realIds.length)]! : NASTY[rand(NASTY.length)]);
      const path = r.path.replace(/:[a-zA-Z]+/g, () => asPathSegment(param()));
      const token = rand(5) === 0 ? member.token : lead.token;
      const headers: Record<string, string> = {};
      if (rand(2)) headers["idempotency-key"] = rand(2) ? crypto.randomUUID() : String(NASTY[rand(NASTY.length)]).slice(0, 200).replace(/[^\x20-\x7e]/g, "");
      const asRaw = rand(6) === 0;
      const res = await call(r.method, path, {
        token,
        headers: { ...headers, ...(asRaw ? { "content-type": rand(2) ? "application/json" : "text/plain" } : {}) },
        ...(r.method === "GET" ? {} : asRaw ? { raw: String(NASTY[rand(NASTY.length)]) } : { body: hostileBody(rand) }),
      });
      // 503 PRIVY_DISABLED is deliberate; anything else 5xx is a crash.
      if (res.status >= 500 && res.body?.error?.code !== "PRIVY_DISABLED") failures.push(`${res.status} ${r.method} ${path.slice(0, 120)} -> ${JSON.stringify(res.body).slice(0, 200)}`);
      if (res.status >= 400 && (typeof res.body !== "object" || !res.body?.error?.code)) failures.push(`bad error shape on ${path.slice(0, 80)}`);
      if (unauthenticated(res) && !/logout/.test(r.path)) failures.push(`lost the session before ${r.method} ${path.slice(0, 60)}`);
      if (/logout/.test(r.path) && res.status === 200) break; // that session is gone now, by design
    }
    expect(failures).toEqual([]);
  });

  // Random sampling missed a null byte once. Sweep every hostile value through
  // every path parameter of every route, deterministically.
  it.each(routes.filter((r) => !r.path.startsWith("/internal/") && r.path.includes(":")))("$method $path: every hostile path value", async (r) => {
    const { lead, realIds } = await world();
    const failures: string[] = [];
    for (const v of [...NASTY, ...realIds]) {
      const path = r.path.replace(/:[a-zA-Z]+/g, () => asPathSegment(v));
      const res = await call(r.method, path, { token: lead.token, ...(r.method === "GET" ? {} : { body: {} }), headers: { "idempotency-key": crypto.randomUUID() } });
      if (res.status >= 500) failures.push(`${res.status} ${path.slice(0, 100)}`);
      if (unauthenticated(res)) failures.push(`lost the session before ${path.slice(0, 60)}`);
    }
    expect(failures).toEqual([]);
  });

  // And every hostile value through every body field of every write route.
  it.each(routes.filter((r) => !r.path.startsWith("/internal/") && r.method !== "GET" && !/logout/.test(r.path)))("$method $path: every hostile body value", async (r) => {
    const { member, realIds } = await world();
    const failures: string[] = [];
    const path = r.path.replace(/:[a-zA-Z]+/g, () => realIds[0]!);
    for (const field of FIELDS) {
      for (const v of NASTY) {
        const res = await call(r.method, path, { token: member.token, body: { [field]: v }, headers: { "idempotency-key": crypto.randomUUID() } });
        if (res.status >= 500 && res.body?.error?.code !== "PRIVY_DISABLED") failures.push(`${res.status} ${field}=${JSON.stringify(v)?.slice(0, 40)}`);
        if (unauthenticated(res)) failures.push(`lost the session at ${field}`);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it("no hostile input reached the database unvalidated (the backstop never fired)", () => {
    const hits = logs.filter((l) => l.msg === "input reached the database unvalidated").map((l) => `${l.extra.path}: ${String(l.extra.error).slice(0, 80)}`);
    expect([...new Set(hits)]).toEqual([]);
  });

  it("afterwards the ledger still adds up and nobody is below zero", async () => {
    expect(await reconcile(db)).toEqual([]);
    const [neg] = await client`SELECT count(*)::int AS n FROM gm_accounts WHERE balance < 0 AND NOT allow_negative`;
    expect(neg!.n).toBe(0);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });
});
