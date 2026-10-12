import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, schemaStatus } from "../src";
import { runMigrations } from "../src/migrate";

const { db, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 2 });
afterAll(() => close());

describe("schema status", () => {
  it("a fully migrated database is up to date", async () => {
    const s = await schemaStatus(db);
    expect(s.upToDate).toBe(true);
    expect(s.applied).toBe(s.expected);
    expect(s.latest).toMatch(/^\d{4}_/);
  });

  it("an empty or half-migrated database is not", async () => {
    const admin = new URL(process.env.TEST_DATABASE_URL!);
    const name = `bp_schema_${Date.now()}_test`;
    admin.pathname = "/postgres";
    const sqlAdmin = postgres(admin.toString(), { max: 1, onnotice: () => {} });
    await sqlAdmin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = `/${name}`;
    const scratch = createDb(url.toString(), { max: 1 });
    try {
      expect(await schemaStatus(scratch.db)).toMatchObject({ applied: 0, upToDate: false });
      await runMigrations(url.toString());
      expect((await schemaStatus(scratch.db)).upToDate).toBe(true);
      await scratch.client.unsafe(`DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)`);
      expect(await schemaStatus(scratch.db)).toMatchObject({ upToDate: false });
    } finally {
      await scratch.close();
      await sqlAdmin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await sqlAdmin.end();
    }
  });

  it("migrating gives up on a lock it can't get, instead of queueing everyone behind it", async () => {
    const admin = new URL(process.env.TEST_DATABASE_URL!);
    const name = `bp_locked_${Date.now()}_test`;
    admin.pathname = "/postgres";
    const sqlAdmin = postgres(admin.toString(), { max: 1, onnotice: () => {} });
    await sqlAdmin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = `/${name}`;
    const holder = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      // A long transaction holds a table the migration needs.
      await holder.unsafe(`CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
      const held = await holder.reserve();
      await held`BEGIN`;
      await held`LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE`;
      try {
        const started = Date.now();
        const e = (await runMigrations(url.toString(), { lockTimeoutMs: 300 }).catch((x) => x)) as { cause?: { code?: string } } | undefined;
        expect(e?.cause?.code).toBe("55P03"); // lock_not_available: the lock timeout
        expect(Date.now() - started).toBeLessThan(5_000);
      } finally {
        await held`ROLLBACK`;
        held.release();
      }
    } finally {
      await holder.end();
      await sqlAdmin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await sqlAdmin.end();
    }
  });
});
