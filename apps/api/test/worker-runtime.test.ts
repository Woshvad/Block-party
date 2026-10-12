import { pickForMe, seededRandomInt, signTelegramInitData } from "@bp/core";
import { createHmac } from "node:crypto";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The bundled API Worker, running in workerd (the Cloudflare runtime) through
// Miniflare, talking to the test Postgres over TCP the way Hyperdrive will.
// Catches what Node-only tests can't: bundling, nodejs_compat, sockets.
// Shaped like a real bot token: the Worker refuses to start on anything else.
const BOT = "777000:WORKER_RUNTIME_TEST_TOKEN_0123456789";
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

// The bindings a working deploy has.
const good = () => ({ HYPERDRIVE: { connectionString: withUser(process.env.TEST_DATABASE_URL!) }, TELEGRAM_BOT_TOKEN: BOT, INTERNAL_SECRET: SECRET, ALLOWED_ORIGINS: ORIGIN });

// A Worker with these bindings, logging into `into`.
async function worker(bindings: Record<string, unknown>, into: string[]) {
  const w = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat"],
    bindings,
    handleStructuredLogs: ({ message }: { message: string }) => void into.push(message),
  });
  await w.ready;
  return w;
}

beforeAll(async () => {
  mf = await worker(good(), logs);
}, 60_000);
afterAll(() => mf?.dispose());

const call = async (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; via?: Miniflare } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await (opts.via ?? mf).dispatchFetch(`https://api.test${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

const launchData = (id: number, bot = BOT) => signTelegramInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id }) }, bot);

describe("the API on the Workers runtime", () => {
  it("health reads the schema over a real socket", async () => {
    const r = await call("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.body.schema.upToDate).toBe(true);
  });

  it("a new resident signs in, moves in, says gm and buys a stool", async () => {
    const id = 800_000_000 + Math.floor(Math.random() * 99_999_999);
    const initData = await launchData(id);
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
    const broken = await worker({ ...good(), HYPERDRIVE: { connectionString: gone.toString() } }, seen);
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

describe("a Worker that isn't set up right", () => {
  it("with no bot token it serves nobody: a 500 everywhere, /health says why, and no cron", async () => {
    const seen: string[] = [];
    const { TELEGRAM_BOT_TOKEN: _, ...noToken } = good();
    const w = await worker(noToken, seen);
    try {
      const health = await call("GET", "/health", { via: w });
      expect(health.status).toBe(500);
      expect(health.body).toEqual({ ok: false, config: ["TELEGRAM_BOT_TOKEN is not set"] });
      // Launch data signed with an empty token, which anyone can make: no session.
      const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 4242 }) };
      const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k as keyof typeof fields]}`).join("\n");
      const hash = createHmac("sha256", createHmac("sha256", "WebAppData").update("").digest()).update(check).digest("hex");
      const forged = await call("POST", "/v1/auth/telegram", { via: w, body: { initData: new URLSearchParams({ ...fields, hash }).toString(), ageAck: true } });
      expect(forged.status).toBe(500);
      expect(forged.body.error.code).toBe("MISCONFIGURED");
      expect(forged.body.sessionToken).toBeUndefined();
      expect(seen.some((l) => l.includes("refusing requests") && l.includes("TELEGRAM_BOT_TOKEN is not set"))).toBe(true);
      // The cron refuses too, and says why.
      expect((await (await w.getWorker()).scheduled({ cron: "* * * * *" })).outcome).not.toBe("ok");
      expect(seen.some((l) => l.includes("cron is not running") && l.includes("TELEGRAM_BOT_TOKEN"))).toBe(true);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("a weak internal secret is refused the same way", async () => {
    const w = await worker({ ...good(), INTERNAL_SECRET: "short" }, []);
    try {
      expect((await call("GET", "/health", { via: w })).body).toEqual({ ok: false, config: ["INTERNAL_SECRET must be 32+ characters"] });
      expect((await call("POST", "/internal/actions/run", { via: w, headers: { "x-internal-secret": "short" } })).status).toBe(500);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("a Privy key that won't load turns off Privy sign-in only, and is found once per isolate", async () => {
    const seen: string[] = [];
    const w = await worker({ ...good(), PRIVY_APP_ID: "privy-app", PRIVY_VERIFICATION_KEY: "-----BEGIN PUBLIC KEY-----\nnot a key\n-----END PUBLIC KEY-----" }, seen);
    try {
      expect((await call("GET", "/health", { via: w })).status).toBe(200);
      const id = 800_000_000 + Math.floor(Math.random() * 99_999_999);
      expect((await call("POST", "/v1/auth/telegram", { via: w, body: { initData: await launchData(id), ageAck: true } })).status).toBe(200);
      const privy = await call("POST", "/v1/auth/privy", { via: w, body: { accessToken: "x", ageAck: true } });
      expect(privy.status).toBe(503);
      expect(privy.body.error.code).toBe("PRIVY_DISABLED");
      expect((await call("GET", "/health", { via: w })).status).toBe(200);
      // Four requests, one setup: the app and the key aren't rebuilt per request.
      expect(seen.filter((l) => l.includes("Privy sign-in is off"))).toHaveLength(1);
    } finally {
      await w.dispose();
    }
  }, 60_000);
});
