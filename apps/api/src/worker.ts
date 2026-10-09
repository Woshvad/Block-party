import { createPrivyVerifier, mockProvider, openAiModeration, sampleMarkets } from "@bp/core";
import { createDb } from "@bp/db";
import { createApp } from "./app";
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
};

const oddsFor = (env: Env) => (env.ODDS_SOURCE === "mock" ? mockProvider(() => sampleMarkets(new Date())) : undefined);

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
      ...(env.ROOMS_URL && env.TICKET_SECRET
        ? { rooms: httpRoomsClient({ url: env.ROOMS_URL, secret: env.INTERNAL_SECRET }), roomsUrl: env.ROOMS_URL, ticketSecret: env.TICKET_SECRET }
        : {}),
      ...(privyVerify ? { privyVerify } : {}),
      notifier: telegramSender({ db, botToken: env.TELEGRAM_BOT_TOKEN }),
      ...(oddsFor(env) ? { odds: oddsFor(env) } : {}),
      ...(env.RECEIPT_SECRET ? { receiptSecret: env.RECEIPT_SECRET } : {}),
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
    const { runBell, runNotificationBatch, finishDueActions, queueDailyPings, pollOdds } = await import("@bp/db");
    const at = new Date(event.scheduledTime ?? Date.now());
    const jobs: Array<Promise<unknown>> = [runBell(db), finishDueActions(db), runNotificationBatch(db, telegramSender({ db, botToken: env.TELEGRAM_BOT_TOKEN }), { batch: 200 })];
    if (at.getUTCMinutes() % 15 === 0) jobs.push(queueDailyPings(db, { now: at }));
    const odds = oddsFor(env);
    if (odds) jobs.push(pollOdds(db, odds, { now: at }));
    ctx.waitUntil(Promise.allSettled(jobs).finally(() => close()));
  },
};
