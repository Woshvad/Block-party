import "dotenv/config";
import postgres from "postgres";
import { runMigrations } from "../src/migrate";

// Fresh test database per run: the ledger is append-only, so we never clean
// rows, we start over.
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error(`refusing to reset non-test database "${name}"`);

  const admin = new URL(url);
  admin.pathname = "/postgres";
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await sql.unsafe(`CREATE DATABASE "${name}"`);
  await sql.end();

  await runMigrations(url);
}
