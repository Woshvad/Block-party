import { pickForMe, seededRandomInt, signTelegramInitData } from "@bp/core";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The bundled API Worker, running in workerd (the Cloudflare runtime) through
// Miniflare, talking to the test Postgres over TCP the way Hyperdrive will.
// Catches what Node-only tests can't: bundling, nodejs_compat, sockets.
const BOT = "777:WORKER_RUNTIME";
const SECRET = "w".repeat(40);
const ORIGIN = "https://city.blockparty.test";
let mf: Miniflare;
// Everything the Worker logs (console.*), as workerd reports it.
const logs: string[] = [];

// Hyperdrive always hands the Worker a full connection string. A local URL may
// leave the user out (Node's driver then uses the OS user; workerd can't).
function withUser(raw: string) {
  const u = new URL(raw);
  if (!u.username) u.username = userInfo().username;
  return u.toString();
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      HYPERDRIVE: { connectionString: withUser(process.env.TEST_DATABASE_URL!) },
      TELEGRAM_BOT_TOKEN: BOT,
      INTERNAL_SECRET: SECRET,
      ALLOWED_ORIGINS: ORIGIN,
    },
    handleStructuredLogs: ({ message }: { message: string }) => void logs.push(message),
  });
  await mf.ready;
}, 60_000);
afterAll(() => mf?.dispose());

const call = async (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await mf.dispatchFetch(`https://api.test${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

describe("the API on the Workers runtime", () => {
  it("health reads the schema over a real socket", async () => {
    const r = await call("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.body.schema.upToDate).toBe(true);
  });

  it("a new resident signs in, moves in, says gm and buys a stool", async () => {
    const id = 800_000_000 + Math.floor(Math.random() * 99_999_999);
    const initData = await signTelegramInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id }) }, BOT);
    const signin = await call("POST", "/v1/auth/telegram", { body: { initData, ageAck: true } });
    expect(signin.status).toBe(200);
    const token = signin.body.sessionToken;
    expect((await call("POST", "/v1/resident", { token, body: { ...pickForMe(seededRandomInt(id)), handle: `wk${id.toString(36)}`.slice(0, 15), name: "Worker Test" } })).status).toBe(201);
    expect((await call("POST", "/v1/gm", { token })).status).toBe(200);
    expect((await call("POST", "/v1/home/buy", { token, body: { pieceId: "stool" }, headers: { "idempotency-key": crypto.randomUUID() } })).status).toBe(201);
    expect((await call("GET", "/v1/me", { token })).body.gm).toBe(1000 + 50 - 15);
  });

  it("internal routes stay hidden without the secret, and work with it", async () => {
    expect((await call("POST", "/internal/actions/run")).status).toBe(404);
    expect((await call("POST", "/internal/actions/run", { headers: { "x-internal-secret": SECRET } })).status).toBe(200);
  });

  it("the minute cron runs on the runtime without throwing", async () => {
    const worker = await mf.getWorker();
    const r = await worker.scheduled({ cron: "* * * * *" });
    expect(r.outcome).toBe("ok");
    // On a quarter hour it also runs the daily ping scheduler.
    const q = await worker.scheduled({ cron: "* * * * *", scheduledTime: new Date("2026-10-09T18:15:00Z") });
    expect(q.outcome).toBe("ok");
    // No job failed quietly either.
    expect(logs.filter((l) => l.includes("cron job failed"))).toEqual([]);
  });

  it("a cron whose jobs fail logs each one by name and fails the run", async () => {
    // The same Worker on a database that isn't there: every job throws.
    const gone = new URL(withUser(process.env.TEST_DATABASE_URL!));
    gone.pathname = "/bp_no_such_database_test";
    const seen: string[] = [];
    const broken = new Miniflare({
      modules: true,
      scriptPath: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
      compatibilityDate: "2026-07-01",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { HYPERDRIVE: { connectionString: gone.toString() }, TELEGRAM_BOT_TOKEN: BOT, INTERNAL_SECRET: SECRET, ALLOWED_ORIGINS: ORIGIN },
      handleStructuredLogs: ({ message }: { message: string }) => void seen.push(message),
    });
    try {
      const r = await (await broken.getWorker()).scheduled({ cron: "* * * * *", scheduledTime: new Date("2026-10-09T18:15:00Z") });
      expect(r.outcome).not.toBe("ok");
      // (Last Call has nothing to do before its hour, so it never reaches the database.)
      for (const job of ["bell", "finishedActions", "ratioPrompt", "realTrades", "notifications", "dailyPings"]) {
        expect(seen.some((l) => l.includes(`cron job failed: ${job}`))).toBe(true);
      }
      // With the reason.
      expect(seen.find((l) => l.includes("cron job failed: bell"))).toContain("bp_no_such_database_test");
    } finally {
      await broken.dispose();
    }
  }, 60_000);
});
