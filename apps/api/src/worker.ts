import { createPrivyVerifier } from "@bp/core";
import { createDb } from "@bp/db";
import { createApp } from "./app";

// Cloudflare Workers entry. Postgres goes through Hyperdrive; one small pool
// per request, closed when the response is done.
type Env = {
  HYPERDRIVE: { connectionString: string };
  TELEGRAM_BOT_TOKEN: string;
  INTERNAL_SECRET: string;
  ALLOWED_ORIGINS: string;
  PRIVY_APP_ID?: string;
  PRIVY_VERIFICATION_KEY?: string;
};

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
      ...(privyVerify ? { privyVerify } : {}),
    });
    const res = await app.fetch(req);
    ctx.waitUntil(close());
    return res;
  },
  // The nightly bell: a Cron Trigger every minute after 00:00 UTC is safe,
  // since runBell does each step once.
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const { db, close } = createDb(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false });
    const { runBell } = await import("@bp/db");
    ctx.waitUntil(runBell(db).finally(() => close()));
  },
};
