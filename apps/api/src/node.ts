import "dotenv/config";
import { serve } from "@hono/node-server";
import { mockProvider, sampleMarkets } from "@bp/core";
import { createDb, schemaStatus } from "@bp/db";
import { createApp } from "./app";

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
const app = createApp({
  db,
  telegramBotToken: need("TELEGRAM_BOT_TOKEN"),
  internalSecret: need("INTERNAL_SECRET"),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000").split(","),
  // Dev and load tests only: trust a header for the client IP (Cloudflare's cf-connecting-ip in production).
  ...(process.env.CLIENT_IP_HEADER ? { clientIpHeader: process.env.CLIENT_IP_HEADER } : {}),
  ...(process.env.ODDS_SOURCE === "mock" ? { odds: mockProvider(() => sampleMarkets(new Date())) } : {}),
});
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`api listening on http://localhost:${port}`);
