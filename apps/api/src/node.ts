import "dotenv/config";
import { serve } from "@hono/node-server";
import { type OddsProvider, mockProvider, polymarketProvider, sampleMarkets } from "@bp/core";
import { createDb, schemaStatus } from "@bp/db";
import { createApp } from "./app";
import { logCronFailures, runMinute } from "./cron";
import { httpRoomsClient } from "./rooms-client";

// Local dev server. Production runs src/worker.ts on Cloudflare Workers.
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};
const { db } = createDb(need("DATABASE_URL"), { max: Number(process.env.DB_POOL ?? 10) });
const schema = await schemaStatus(db);
if (!schema.upToDate) {
  console.error(`database has ${schema.applied}/${schema.expected} migrations; run pnpm db:migrate first`);
  process.exit(1);
}
// ODDS_SOURCE: "polymarket" (the live feed, read-only) or "mock" (a sample feed); unset, no odds.
const ODDS: OddsProvider | undefined =
  process.env.ODDS_SOURCE === "polymarket" ? polymarketProvider() : process.env.ODDS_SOURCE === "mock" ? mockProvider(() => sampleMarkets(new Date())) : undefined;
const app = createApp({
  db,
  telegramBotToken: need("TELEGRAM_BOT_TOKEN"),
  internalSecret: need("INTERNAL_SECRET"),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000").split(","),
  // Dev and load tests only: trust a header for the client IP (Cloudflare's cf-connecting-ip in production).
  ...(process.env.CLIENT_IP_HEADER ? { clientIpHeader: process.env.CLIENT_IP_HEADER } : {}),
  ...(ODDS ? { odds: ODDS } : {}),
  // The same switches as on Workers, off unless set to "on".
  features: { duels: process.env.FEATURE_DUELS === "on", towerLights: process.env.FEATURE_TOWER_LIGHTS === "on", realMoney: process.env.FEATURE_REAL_MONEY === "on" },
  // The live rooms (pnpm --filter @bp/rooms dev), wired as on Workers.
  ...(process.env.ROOMS_URL && process.env.TICKET_SECRET
    ? { rooms: httpRoomsClient({ url: process.env.ROOMS_URL, secret: need("INTERNAL_SECRET") }), roomsUrl: process.env.ROOMS_URL, ticketSecret: process.env.TICKET_SECRET }
    : {}),
});
// LOCAL_CRON=1: run the Worker's minute cron here too, so a local city has a
// bell, live odds and a Slate. Notifications aren't sent (no real bot locally).
if (process.env.LOCAL_CRON === "1") {
  const odds = ODDS;
  let running = false;
  const tick = async () => {
    if (running) return; // a slow minute never overlaps the next
    running = true;
    try {
      logCronFailures(await runMinute(db, new Date(), odds ? { odds } : {}));
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(tick, 60_000);
  console.log("local cron on: every minute");
}
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`api listening on http://localhost:${port}`);
