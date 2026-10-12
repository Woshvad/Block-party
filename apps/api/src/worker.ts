import { AsyncLocalStorage } from "node:async_hooks";
import { type PrivyVerifier, createPrivyVerifier, mockProvider, openAiModeration, parseBlockedWords, polymarketProvider, sampleMarkets } from "@bp/core";
import { type Db, createDb } from "@bp/db";
import { createApp } from "./app";
import { configProblems } from "./config-check";
import { logCronFailures, runMinute } from "./cron";
import { httpRoomsClient } from "./rooms-client";
import { telegramSender } from "./telegram-sender";

// Cloudflare Workers entry. Postgres goes through Hyperdrive: one small pool
// per request, closed when the response is done (workerd won't let a request
// use sockets another request opened). Everything else (the config check, the
// app and its routes, the Privy key) is set up once per isolate.
type Env = {
  HYPERDRIVE: { connectionString: string };
  TELEGRAM_BOT_TOKEN: string;
  INTERNAL_SECRET: string;
  ALLOWED_ORIGINS: string;
  PRIVY_APP_ID?: string;
  PRIVY_VERIFICATION_KEY?: string;
  OPENAI_API_KEY?: string;
  ROOMS_URL?: string;
  TICKET_SECRET?: string;
  // "mock" for staging; the Polymarket feed plugs in here.
  ODDS_SOURCE?: string;
  RECEIPT_SECRET?: string;
  // Hashes phone numbers and wallets for Proof of Neighbour (32+ characters).
  PON_PEPPER?: string;
  // "on" once the alt checks are live.
  FEATURE_DUELS?: string;
  FEATURE_TOWER_LIGHTS?: string;
  // "on" only after the legal opinion.
  FEATURE_REAL_MONEY?: string;
  // Staff's blocked words, comma- or newline-separated.
  BLOCKED_WORDS?: string;
  // The city's https address: pushes then carry an Open button.
  CITY_URL?: string;
};

// For the minute cron: the AI moderation check once OPENAI_API_KEY is set,
// and the rooms Worker to take flagged room lines down.
const moderationFor = (env: Env) => (env.OPENAI_API_KEY ? openAiModeration({ apiKey: env.OPENAI_API_KEY }) : undefined);
const roomsFor = (env: Env) => (env.ROOMS_URL && env.TICKET_SECRET ? httpRoomsClient({ url: env.ROOMS_URL, secret: env.INTERNAL_SECRET }) : undefined);

// Pushes as Telegram bot messages, with an Open button once CITY_URL is set.
const senderFor = (env: Env, db: Db) => telegramSender({ db, botToken: env.TELEGRAM_BOT_TOKEN, ...(env.CITY_URL ? { cityUrl: env.CITY_URL } : {}) });

// ODDS_SOURCE: "polymarket" (the live feed, read-only) or "mock" (a sample feed); unset, no odds.
const oddsFor = (env: Env) => (env.ODDS_SOURCE === "polymarket" ? polymarketProvider() : env.ODDS_SOURCE === "mock" ? mockProvider(() => sampleMarkets(new Date())) : undefined);

// Why this Worker won't run, if anything: the secrets, plus the bindings
// nothing works without.
function problemsWith(env: Env) {
  const problems = configProblems(env);
  if (!env.HYPERDRIVE?.connectionString) problems.push("HYPERDRIVE is not bound");
  if (!env.ALLOWED_ORIGINS) problems.push("ALLOWED_ORIGINS is not set");
  return problems;
}

// The app is built once, so it gets this stand-in for the database: each
// use goes to the pool of the request it's serving.
const requestDb = new AsyncLocalStorage<Db>();
const current = () => {
  const real = requestDb.getStore();
  if (!real) throw new Error("the database was used outside a request");
  return real;
};
const db = new Proxy(Object.create(null) as Db, {
  get(_, key) {
    const real = current();
    const v = Reflect.get(real, key, real);
    return typeof v === "function" && key !== "constructor" ? v.bind(real) : v;
  },
  has: (_, key) => key in current(),
  getPrototypeOf: () => Object.getPrototypeOf(current()),
});

type Setup = { problems: string[]; app?: ReturnType<typeof createApp> };

async function setUp(env: Env): Promise<Setup> {
  const problems = problemsWith(env);
  if (problems.length > 0) return { problems };
  let privyVerify: PrivyVerifier | undefined;
  if (env.PRIVY_APP_ID && env.PRIVY_VERIFICATION_KEY) {
    try {
      privyVerify = await createPrivyVerifier({ appId: env.PRIVY_APP_ID, verificationKeyPem: env.PRIVY_VERIFICATION_KEY });
    } catch (e) {
      // A key that won't load turns off Privy sign-in (503 there), not the whole API.
      console.error("Privy sign-in is off: PRIVY_VERIFICATION_KEY didn't load", { error: String(e) });
    }
  }
  const odds = oddsFor(env);
  const app = createApp({
    db,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    internalSecret: env.INTERNAL_SECRET,
    allowedOrigins: env.ALLOWED_ORIGINS.split(","),
    clientIpHeader: "cf-connecting-ip",
    ...(env.OPENAI_API_KEY ? { moderation: openAiModeration({ apiKey: env.OPENAI_API_KEY }) } : {}),
    blockedWords: parseBlockedWords(env.BLOCKED_WORDS),
    ...(env.ROOMS_URL && env.TICKET_SECRET
      ? { rooms: httpRoomsClient({ url: env.ROOMS_URL, secret: env.INTERNAL_SECRET }), roomsUrl: env.ROOMS_URL, ticketSecret: env.TICKET_SECRET }
      : {}),
    ...(privyVerify ? { privyVerify } : {}),
    notifier: senderFor(env, db),
    ...(odds ? { odds } : {}),
    ...(env.RECEIPT_SECRET ? { receiptSecret: env.RECEIPT_SECRET } : {}),
    // The pepper alone turns nothing on: the PoN routes answer 503 until a
    // phone or crypto-proof provider is configured too.
    ...(env.PON_PEPPER ? { ponPepper: env.PON_PEPPER } : {}),
    features: { duels: env.FEATURE_DUELS === "on", towerLights: env.FEATURE_TOWER_LIGHTS === "on", realMoney: env.FEATURE_REAL_MONEY === "on" },
    countryHeader: "cf-ipcountry",
  });
  return { problems, app };
}

// Once per isolate, keyed by the env it was built from.
const setups = new WeakMap<Env, Promise<Setup>>();
function setUpOnce(env: Env) {
  let s = setups.get(env);
  if (!s) {
    s = setUp(env).catch((e) => {
      setups.delete(env); // the next request tries again
      throw e;
    });
    setups.set(env, s);
  }
  return s;
}

// A misconfigured API answers everything with a 500, and /health says why.
function refuse(req: Request, problems: string[]) {
  console.error("the API is refusing requests: its config is unsafe", { problems });
  const health = new URL(req.url).pathname === "/health";
  const body = health ? { ok: false, config: problems } : { error: { code: "MISCONFIGURED", message: "the API isn't set up right; see /health" } };
  return Response.json(body, { status: 500, headers: { "cache-control": "no-store" } });
}

export default {
  async fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const { problems, app } = await setUpOnce(env);
    if (!app) return refuse(req, problems);
    const { db: real, close } = createDb(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
    try {
      return await requestDb.run(real, () => app.fetch(req));
    } finally {
      ctx.waitUntil(close());
    }
  },
  // Every minute: the nightly bell (safe to repeat, since runBell does each
  // step once) and whatever pushes have fallen due.
  // Every 15 minutes, the daily pings for whoever's usual hour it is (15, so
  // half-hour and 45-minute time zones get their hour too).
  // A failed job is logged by name and fails the run, so it shows in the logs
  // and in the Cron Trigger history. A misconfigured Worker runs no jobs.
  async scheduled(event: { scheduledTime?: number }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const problems = problemsWith(env);
    if (problems.length > 0) {
      console.error("the cron is not running: the API's config is unsafe", { problems });
      throw new Error(`config problems: ${problems.join("; ")}`);
    }
    const { db, close } = createDb(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
    const at = new Date(event.scheduledTime ?? Date.now());
    const odds = oddsFor(env);
    const moderation = moderationFor(env);
    const rooms = roomsFor(env);
    try {
      const deps = { sender: senderFor(env, db), ...(odds ? { odds } : {}), ...(moderation ? { moderation } : {}), ...(rooms ? { rooms } : {}) };
      const failed = logCronFailures(await runMinute(db, at, deps));
      if (failed > 0) throw new Error(`${failed} cron job(s) failed`);
    } finally {
      ctx.waitUntil(close());
    }
  },
};
