// Bots walking the real server: sign in, move in, gm, read the Floor and the
// Slate, make a call, check their moods, buy a stool. Reports latency
// percentiles and errors per route. Run against a dev server started with
// ODDS_SOURCE=mock and CLIENT_IP_HEADER=x-load-ip (never production).
//   LOAD_URL=http://localhost:8799 BOTS=200 CONCURRENCY=50 pnpm load
import { pickForMe, seededRandomInt, signTelegramInitData } from "@bp/core";
import { loadEnv } from "@bp/db/src/env";

loadEnv();

const base = process.env.LOAD_URL ?? "http://localhost:8787";
const bot = process.env.TELEGRAM_BOT_TOKEN;
const origin = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000").split(",")[0]!;
const BOTS = Number(process.env.BOTS ?? 100);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 25);
if (!bot) throw new Error("TELEGRAM_BOT_TOKEN is not set");

const timings = new Map<string, number[]>();
const errors = new Map<string, number>();
async function hit(name: string, ip: string, method: string, path: string, opts: { token?: string; body?: unknown; idem?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin, "x-load-ip": ip };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.idem) headers["idempotency-key"] = crypto.randomUUID();
  const t = performance.now();
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const body = (await res.json().catch(() => null)) as any;
  (timings.get(name) ?? timings.set(name, []).get(name)!).push(performance.now() - t);
  if (res.status >= 500 || res.status === 429) errors.set(`${name} ${res.status}`, (errors.get(`${name} ${res.status}`) ?? 0) + 1);
  return { status: res.status, body };
}

async function oneBot(i: number) {
  const id = 700_000_000 + Math.floor(Math.random() * 99_999_999);
  const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
  const initData = await signTelegramInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id }) }, bot!);
  const s = await hit("sign in", ip, "POST", "/v1/auth/telegram", { body: { initData, ageAck: true } });
  const token = s.body?.sessionToken as string | undefined;
  if (!token) return;
  await hit("move in", ip, "POST", "/v1/resident", { token, body: { ...pickForMe(seededRandomInt(id)), handle: `ld${id.toString(36)}`.slice(0, 15), name: "Load Bot" } });
  await hit("gm", ip, "POST", "/v1/gm", { token });
  const floor = await hit("the Floor", ip, "GET", "/v1/tower/markets", { token });
  await hit("the Slate", ip, "GET", "/v1/slate", { token });
  const m = Array.isArray(floor.body) ? floor.body[i % Math.max(1, floor.body.length)] : null;
  if (m && m.price < 99) await hit("make a call", ip, "POST", "/v1/tower/calls", { token, body: { marketId: m.id, side: "yes", chance: Math.min(99, m.price + 10), seenPrice: m.price } });
  await hit("moods", ip, "GET", "/v1/moods", { token });
  await hit("buy a stool", ip, "POST", "/v1/home/buy", { token, body: { pieceId: "stool" }, idem: true });
  await hit("me", ip, "GET", "/v1/me", { token });
}

// Keep the (mock) odds feed live during the run, as the cron would.
const poll = () => fetch(`${base}/internal/tower/poll`, { method: "POST", headers: { "x-internal-secret": process.env.INTERNAL_SECRET ?? "" } }).catch(() => undefined);
await poll();
const poller = setInterval(poll, 30_000);

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0;
const started = performance.now();
let next = 0;
// loop-bound: each worker takes bot numbers until all BOTS are taken.
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < BOTS) await oneBot(next++).catch((e) => errors.set(`crash ${String(e?.message ?? e).slice(0, 60)}`, (errors.get(`crash ${String(e?.message ?? e).slice(0, 60)}`) ?? 0) + 1));
  }),
);
clearInterval(poller);
const secs = (performance.now() - started) / 1000;
const total = [...timings.values()].reduce((a, xs) => a + xs.length, 0);
console.log(`${BOTS} bots, ${CONCURRENCY} at a time: ${total} requests in ${secs.toFixed(1)} s = ${(total / secs).toFixed(0)} req/s`);
console.log("route".padEnd(14), "n".padStart(5), "p50".padStart(7), "p95".padStart(7), "p99".padStart(7));
for (const [name, xs] of timings) console.log(name.padEnd(14), String(xs.length).padStart(5), `${pct(xs, 50).toFixed(0)}ms`.padStart(7), `${pct(xs, 95).toFixed(0)}ms`.padStart(7), `${pct(xs, 99).toFixed(0)}ms`.padStart(7));
console.log(errors.size ? `errors: ${JSON.stringify(Object.fromEntries(errors))}` : "no errors");
process.exit(errors.size ? 1 : 0);
