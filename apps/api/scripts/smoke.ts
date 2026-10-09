// Smoke test of the real server on a real, migrated database: a new resident
// walks the day-one path over HTTP. Catches wiring the in-process tests can't
// (missing system rows, env, migrations). Usage: SMOKE_URL=http://localhost:8787 pnpm smoke
import "dotenv/config";
import { pickForMe, seededRandomInt, signTelegramInitData } from "@bp/core";

const base = process.env.SMOKE_URL ?? "http://localhost:8787";
const bot = process.env.TELEGRAM_BOT_TOKEN;
const origin = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000").split(",")[0]!;
if (!bot) throw new Error("TELEGRAM_BOT_TOKEN is not set");

let failures = 0;
async function step(name: string, method: string, path: string, opts: { token?: string; body?: unknown; expect?: number; idem?: boolean; secret?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin };
  if (opts.secret) headers["x-internal-secret"] = process.env.INTERNAL_SECRET ?? "";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.idem) headers["idempotency-key"] = crypto.randomUUID();
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const body = await res.json().catch(() => null);
  const ok = res.status === (opts.expect ?? 200);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(28)} ${res.status}${ok ? "" : ` ${JSON.stringify(body)}`}`);
  return body as any;
}

const id = 900_000_000 + Math.floor(Math.random() * 99_999_999);
const initData = await signTelegramInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, username: `smoke${id}` }) }, bot);
const signin = await step("sign in with Telegram", "POST", "/v1/auth/telegram", { body: { initData, ageAck: true } });
const token = signin?.sessionToken as string;
await step("move in", "POST", "/v1/resident", { token, body: { ...pickForMe(seededRandomInt(id)), handle: `smoke${id.toString(36)}`.slice(0, 15), name: "Smoke Test" }, expect: 201 });
await step("say gm (the drip mints)", "POST", "/v1/gm", { token, idem: true });
const me = await step("me", "GET", "/v1/me", { token });
console.log(`     ${JSON.stringify(me).slice(0, 160)}`);
await step("buy a stool (a burn)", "POST", "/v1/home/buy", { token, body: { pieceId: "stool" }, idem: true, expect: 201 });
await step("home", "GET", "/v1/home", { token });
await step("moods", "GET", "/v1/moods", { token });
await step("notification prefs", "GET", "/v1/notifications/prefs", { token });
await step("relationships", "GET", "/v1/relationships", { token });
await step("timetable", "GET", "/v1/city/timetable", { token });
await step("away recap", "GET", "/v1/away/recap", { token });
await step("proof of neighbour", "GET", "/v1/pon", { token });
// The Tower, when the server runs with ODDS_SOURCE=mock.
if (process.env.SMOKE_TOWER) {
  await step("poll the odds (internal)", "POST", "/internal/tower/poll", { secret: true });
  const floor = await step("the Floor", "GET", "/v1/tower/markets", { token });
  const m = (floor as Array<{ id: string; price: number }>)[0];
  if (m) {
    const made = await step("make a call", "POST", "/v1/tower/calls", { token, body: { marketId: m.id, side: m.price < 99 ? "yes" : "no", chance: m.price < 99 ? Math.min(99, m.price + 10) : 90, seenPrice: m.price }, expect: 201 });
    await new Promise((r) => setTimeout(r, 1100));
    await step("next tick (internal)", "POST", "/internal/tower/poll", { secret: true });
    const c = await step("the call", "GET", `/v1/tower/calls/${made?.id}`, { token });
    console.log(`     call ${c?.status} at ${c?.lockedPrice ?? "-"}`);
    await step("the market", "GET", `/v1/tower/markets/${m.id}`, { token });
    await step("publish the Slate (internal)", "POST", "/internal/slate/publish", { secret: true });
    const slate = await step("today's Slate", "GET", "/v1/slate", { token });
    console.log(`     Slate #${slate?.number}: ${slate?.cards?.length} cards, ${slate?.modifier}`);
    if (slate?.cards?.length !== 6) {
      failures++;
      console.log("FAIL the Slate should have 6 cards");
    }
  } else {
    failures++;
    console.log("FAIL the Floor is empty");
  }
}
await step("economy (internal)", "GET", `/internal/economy?from=2020-01-01&to=2100-01-01`, { expect: 404 }); // no secret
console.log(failures ? `\n${failures} step(s) failed` : "\nall steps passed");
process.exit(failures ? 1 : 0);
