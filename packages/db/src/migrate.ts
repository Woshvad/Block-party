import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client";
import { loadEnv } from "./env";

loadEnv();

export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

// How long a migration may wait for a table lock before giving up. Drizzle
// applies every pending migration in one transaction; one queued behind a
// long-running transaction (an ALTER TABLE waiting for its lock) would make
// every request on that table queue behind it in turn, and the pool would
// fill. Failing fast leaves nothing changed: run it again when it's quiet.
export const MIGRATION_LOCK_TIMEOUT_MS = 5_000;

export async function runMigrations(url: string, opts: { lockTimeoutMs?: number } = {}) {
  const { db, close } = createDb(url, { max: 1, connection: { lock_timeout: opts.lockTimeoutMs ?? MIGRATION_LOCK_TIMEOUT_MS } });
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  await runMigrations(url);
  console.log("migrations applied");
}
