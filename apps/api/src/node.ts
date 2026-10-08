import "dotenv/config";
import { serve } from "@hono/node-server";
import { createDb, schemaStatus } from "@bp/db";
import { createApp } from "./app";

// Local dev server. Production runs src/worker.ts on Cloudflare Workers.
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};
const { db } = createDb(need("DATABASE_URL"));
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
});
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`api listening on http://localhost:${port}`);
