import { randomUUID } from "node:crypto";
import { BURN_SHARDS, MINT_SHARDS, SYS_PURSE, SYS_SHARDS, burnAccountFor, isBurnAccount, mintAccountFor, userAccountId } from "@bp/core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { burn, createDb, ensureSystemAccounts, getBalance, mint, openUserAccount, reconcile, supplyStats } from "../src";
import { runMigrations } from "../src/migrate";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

async function funded(n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const u = randomUUID();
    await client`INSERT INTO users (id, age_ack_at) VALUES (${u}, now())`;
    const acct = await openUserAccount(db, u);
    await mint(db, { accountId: acct, amount: 1000, kind: "test", idempotencyKey: `fund:${u}` });
    ids.push(acct);
  }
  return ids;
}

describe("the mint and the burn, in shards", () => {
  it("a fresh database gets every system account from its migrations alone", async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const fresh = `${url.pathname.slice(1)}_fresh`;
    const admin = new URL(url);
    admin.pathname = "/postgres";
    const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
    await sql.unsafe(`DROP DATABASE IF EXISTS "${fresh}" WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE "${fresh}"`);
    try {
      const freshUrl = new URL(url);
      freshUrl.pathname = `/${fresh}`;
      await runMigrations(freshUrl.toString());
      const f = postgres(freshUrl.toString(), { max: 1 });
      const rows = await f`SELECT id, allow_negative FROM gm_accounts WHERE kind = 'system' ORDER BY id`;
      await f.end();
      expect(rows.map((r) => r.id).sort()).toEqual([...MINT_SHARDS, ...BURN_SHARDS, SYS_PURSE].sort());
      for (const r of rows) expect(r.allow_negative).toBe(MINT_SHARDS.includes(r.id));
    } finally {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${fresh}" WITH (FORCE)`);
      await sql.end();
    }
  });

  it("each account always uses one shard; many accounts spread over all of them", () => {
    const ids = Array.from({ length: 2000 }, () => userAccountId(randomUUID()));
    for (const id of ids.slice(0, 50)) expect(burnAccountFor(id)).toBe(burnAccountFor(id));
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(burnAccountFor(id), (counts.get(burnAccountFor(id)) ?? 0) + 1);
    expect(counts.size).toBe(SYS_SHARDS);
    for (const n of counts.values()) expect(n).toBeGreaterThan(2000 / SYS_SHARDS / 2); // no shard starves or hogs
    for (const id of ids) {
      expect(isBurnAccount(burnAccountFor(id))).toBe(true);
      expect(MINT_SHARDS).toContain(mintAccountFor(id));
    }
    expect(isBurnAccount("sys:burn:16")).toBe(false);
    expect(isBurnAccount("sys:burnt")).toBe(false);
  });

  it("supply stats add up across shards, and the books still balance", async () => {
    const before = await supplyStats(db);
    const accts = await funded(20);
    for (const a of accts) await burn(db, { accountId: a, amount: 7, kind: "test", idempotencyKey: `b:${a}` });
    const after = await supplyStats(db);
    expect(after.created - before.created).toBe(20 * 1000);
    expect(after.destroyed - before.destroyed).toBe(20 * 7);
    for (const a of accts) expect(await getBalance(db, a)).toBe(993);
    expect(await reconcile(db)).toEqual([]);
  });

  it("a burn on one shard doesn't wait for a held lock on another", async () => {
    const accts = await funded(40);
    const a = accts[0]!;
    const b = accts.find((x) => burnAccountFor(x) !== burnAccountFor(a))!;
    const held = await client.reserve();
    await held`BEGIN`;
    await held`SELECT 1 FROM gm_accounts WHERE id = ${burnAccountFor(a)} FOR NO KEY UPDATE`;
    try {
      const t = Date.now();
      await burn(db, { accountId: b, amount: 1, kind: "test", idempotencyKey: `free:${b}` });
      expect(Date.now() - t).toBeLessThan(2000);
      // ...while one on the held shard does wait.
      let done = false;
      const p = burn(db, { accountId: a, amount: 1, kind: "test", idempotencyKey: `held:${a}` }).then(() => (done = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(done).toBe(false);
      await held`COMMIT`;
      await p;
      expect(done).toBe(true);
    } finally {
      held.release();
    }
  });

  it("a purchase is still refused unless it burned its price (into any shard)", async () => {
    // An account whose burns land on a new shard, not the old sys:burn row.
    const acct = (await funded(8)).find((x) => burnAccountFor(x) !== "sys:burn");
    const user = acct!.slice("user:".length);
    const tx = await burn(db, { accountId: acct!, amount: 50, kind: "furniture", idempotencyKey: `buy:${acct}` });
    await client`INSERT INTO items (piece_id, owner_user_id, source, price_paid, tx_id) VALUES ('desk_chair', ${user}, 'purchase', 50, ${tx.txId})`;
    await expect(client`INSERT INTO items (piece_id, owner_user_id, source, price_paid, tx_id) VALUES ('stool', ${user}, 'purchase', 15, ${tx.txId})`).rejects.toThrow();
  });
});
