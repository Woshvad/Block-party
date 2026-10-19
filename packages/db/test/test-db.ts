import postgres from "postgres";
import { runMigrations } from "../src/migrate";

// Test files run in parallel, one vitest worker each, and every worker gets
// its own copy of a freshly migrated database: `<name>_w<n>_test` for worker
// n (VITEST_POOL_ID). Files in one worker share it one after another, as all
// files used to share one database. Separate databases also keep the race
// barriers honest: they count lock waits in the current database only.
// Idempotent: a worker's own URL maps to itself.
export function workerDatabaseUrl(url: string, worker = process.env.VITEST_POOL_ID) {
  if (!worker) return url;
  const u = new URL(url);
  u.pathname = `/${baseName(u.pathname.slice(1))}_w${worker}_test`;
  return u.toString();
}

const baseName = (name: string) => name.replace(/(_w\d+)?_test$/, "");

// Drops and recreates `url`'s database from the migrations, then copies it
// for each of `workers` workers. A test database is thrown away every run:
// the ledger is append-only, so we never clean rows, we start over.
export async function freshDatabases(url: string, workers: number) {
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error(`refusing to reset non-test database "${name}"`);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    // Copies from an earlier run, including workers this run won't start.
    const stale = await sql<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname ~ ${`^${baseName(name)}_w[0-9]+_test$`}`;
    for (const d of stale) await sql.unsafe(`DROP DATABASE IF EXISTS "${d.datname}" WITH (FORCE)`);
    await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE "${name}"`);
    await runMigrations(url);
    for (let w = 1; w <= workers; w++) {
      const copy = new URL(workerDatabaseUrl(url, String(w))).pathname.slice(1);
      await sql.unsafe(`CREATE DATABASE "${copy}" TEMPLATE "${name}"`);
      // Throwaway data: commits needn't wait for the disk. What a test can
      // see is unchanged; only a crash of the server could lose a commit.
      await sql.unsafe(`ALTER DATABASE "${copy}" SET synchronous_commit = off`);
    }
  } finally {
    await sql.end();
  }
}
