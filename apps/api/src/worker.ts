import { createPrivyVerifier, mockProvider, openAiModeration, parseBlockedWords, polymarketProvider, sampleMarkets } from "@bp/core";
import { type Db, createDb } from "@bp/db";
import { createApp } from "./app";
import { runMinute } from "./cron";
import { httpRoomsClient } from "./rooms-client";
import { telegramSender } from "./telegram-sender";

// Cloudflare Workers entry. Postgres goes through Hyperdrive; one small pool
// per request, closed when the response is done.
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

export default {
  async fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const { db, close } = createDb(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
    const privyVerify =
      env.PRIVY_APP_ID && env.PRIVY_VERIFICATION_KEY
        ? await createPrivyVerifier({ appId: env.PRIVY_APP_ID, verificationKeyPem: env.PRIVY_VERIFICATION_KEY })
        : undefined;
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
      ...(oddsFor(env) ? { odds: oddsFor(env) } : {}),
      ...(env.RECEIPT_SECRET ? { receiptSecret: env.RECEIPT_SECRET } : {}),
      features: { duels: env.FEATURE_DUELS === "on", towerLights: env.FEATURE_TOWER_LIGHTS === "on", realMoney: env.FEATURE_REAL_MONEY === "on" },
      countryHeader: "cf-ipcountry",
    });
    const res = await app.fetch(req);
    ctx.waitUntil(close());
    return res;
  },
  // Every minute: the nightly bell (safe to repeat, since runBell does each
  // step once) and whatever pushes have fallen due.
  // Every 15 minutes, the daily pings for whoever's usual hour it is (15, so
  // half-hour and 45-minute time zones get their hour too).
  async scheduled(event: { scheduledTime?: number }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const { db, close } = createDb(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
    const at = new Date(event.scheduledTime ?? Date.now());
    const odds = oddsFor(env);
    const moderation = moderationFor(env);
    const rooms = roomsFor(env);
    ctx.waitUntil(
      runMinute(db, at, {
        sender: senderFor(env, db),
        ...(odds ? { odds } : {}),
        ...(moderation ? { moderation } : {}),
        ...(rooms ? { rooms } : {}),
      }).finally(() => close()),
    );
  },
};
