import { sql } from "drizzle-orm";
import type { Db } from "./client";
import journal from "../migrations/meta/_journal.json";

// Compares migrations applied to this database with the ones this build
// ships. A server on an un-migrated database runs fine and then 500s on the
// first new table, so /health and start-up check this.
export async function schemaStatus(db: Db) {
  const expected = journal.entries.length;
  let applied = 0;
  try {
    const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    applied = [...rows][0]?.n ?? 0;
  } catch {
    applied = 0; // no migrations table yet
  }
  return { applied, expected, upToDate: applied === expected, latest: journal.entries.at(-1)?.tag ?? null };
}
