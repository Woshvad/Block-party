import { randomUUID } from "node:crypto";
import { LedgerError, SYS_BURN, SYS_MINT, escrowAccountId } from "@bp/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  burn,
  createDb,
  ensureSystemAccounts,
  getBalance,
  listEntries,
  mint,
  openEscrowAccount,
  openUserAccount,
  post,
  reconcile,
  schema,
  supplyStats,
  transfer,
} from "../src";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 20 });
const key = () => randomUUID();

async function newResident(gm = 0) {
  const [u] = await db.insert(schema.users).values({ ageAckAt: new Date() }).returning();
  const acct = await openUserAccount(db, u!.id);
  if (gm > 0) await mint(db, { accountId: acct, amount: gm, kind: "test_seed", idempotencyKey: key() });
  return acct;
}

async function errCode(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof LedgerError) return e.code;
    throw e;
  }
  return "OK";
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(async () => {
  expect(await reconcile(db)).toEqual([]);
  await close();
});

describe("faucets, sinks, transfers", () => {
  it("mints, burns and tracks supply", async () => {
    const before = await supplyStats(db);
    const a = await newResident();
    await mint(db, { accountId: a, amount: 100, kind: "drip", idempotencyKey: key() });
    await burn(db, { accountId: a, amount: 30, kind: "furniture", idempotencyKey: key() });
    expect(await getBalance(db, a)).toBe(70);

    const after = await supplyStats(db);
    expect(after.created - before.created).toBe(100);
    expect(after.destroyed - before.destroyed).toBe(30);
    expect(after.circulating - before.circulating).toBe(70);
  });

  it("transfers between residents", async () => {
    const a = await newResident(50);
    const b = await newResident();
    const res = await transfer(db, { from: a, to: b, amount: 20, kind: "gift", idempotencyKey: key() });
    expect(res.balances).toEqual({ [a]: 30, [b]: 20 });
  });

  it("settles a multi-leg duel pot: winner, loser's ante, burn", async () => {
    const a = await newResident(100);
    const b = await newResident(100);
    const pot = await openEscrowAccount(db, escrowAccountId("duel", randomUUID()));
    await transfer(db, { from: a, to: pot, amount: 10, kind: "duel_ante", idempotencyKey: key() });
    await transfer(db, { from: b, to: pot, amount: 10, kind: "duel_ante", idempotencyKey: key() });
    // b retreats: a takes b's ante, the rest burns (plan: "Retreated · N GM burned").
    await post(db, {
      idempotencyKey: key(),
      kind: "duel_retreat",
      legs: [
        { accountId: pot, amount: -20 },
        { accountId: a, amount: 10 },
        { accountId: SYS_BURN, amount: 10 },
      ],
    });
    expect(await getBalance(db, pot)).toBe(0);
    expect(await getBalance(db, a)).toBe(100);
    expect(await getBalance(db, b)).toBe(90);
  });

  it("keeps a readable history", async () => {
    const a = await newResident(40);
    await burn(db, { accountId: a, amount: 15, kind: "ride", idempotencyKey: key(), meta: { ride: "priority" } });
    const rows = await listEntries(db, a);
    expect(rows.map((r) => [r.kind, r.amount, r.balanceAfter])).toEqual([
      ["ride", -15, 25],
      ["test_seed", 40, 40],
    ]);
    expect(rows[0]!.meta).toEqual({ ride: "priority" });
  });
});

describe("many postings in one transaction (the bell job shape)", () => {
  it("opens and funds an account in the same transaction", async () => {
    const [u] = await db.insert(schema.users).values({ ageAckAt: new Date() }).returning();
    await db.transaction(async (tx) => {
      const acct = await openUserAccount(tx, u!.id);
      await mint(tx, { accountId: acct, amount: 1000, kind: "test_seed", idempotencyKey: key() });
    });
    expect(await getBalance(db, `user:${u!.id}`)).toBe(1000);
  });

  it("posts to the same accounts many times in one transaction", async () => {
    const a = await newResident(100);
    const b = await newResident(100);
    await db.transaction(async (tx) => {
      for (let i = 0; i < 10; i++) {
        await transfer(tx, { from: a, to: b, amount: 7, kind: "payout", idempotencyKey: key() });
        await mint(tx, { accountId: a, amount: 3, kind: "drip", idempotencyKey: key() });
      }
      await burn(tx, { accountId: b, amount: 50, kind: "ride", idempotencyKey: key() });
    });
    expect(await getBalance(db, a)).toBe(100 - 70 + 30);
    expect(await getBalance(db, b)).toBe(100 + 70 - 50);
  });

  it("still refuses a forged balance inside a busy transaction", async () => {
    const a = await newResident(100);
    await expect(
      db.transaction(async (tx) => {
        await mint(tx, { accountId: a, amount: 5, kind: "drip", idempotencyKey: key() });
        await tx.execute(sql`UPDATE gm_accounts SET balance = balance + 1 WHERE id = ${a}`);
        await mint(tx, { accountId: a, amount: 5, kind: "drip", idempotencyKey: key() });
      }),
    ).rejects.toThrow();
    expect(await getBalance(db, a)).toBe(100);
  });
});

describe("refusals leave no trace", () => {
  it("refuses an overdraft and writes nothing", async () => {
    const a = await newResident(10);
    const k = key();
    expect(await errCode(burn(db, { accountId: a, amount: 11, kind: "furniture", idempotencyKey: k }))).toBe(
      "INSUFFICIENT_FUNDS",
    );
    expect(await getBalance(db, a)).toBe(10);
    const [row] = await client`SELECT count(*)::int AS n FROM gm_transactions WHERE idempotency_key = ${k}`;
    expect(row!.n).toBe(0);
  });

  it("refuses unknown accounts", async () => {
    const a = await newResident(10);
    expect(await errCode(transfer(db, { from: a, to: "user:nobody", amount: 1, kind: "gift", idempotencyKey: key() }))).toBe(
      "UNKNOWN_ACCOUNT",
    );
    expect(await getBalance(db, a)).toBe(10);
  });

  it("refuses unbalanced legs before touching the DB", async () => {
    const a = await newResident(10);
    expect(
      await errCode(post(db, { idempotencyKey: key(), kind: "x", legs: [{ accountId: a, amount: -5 }, { accountId: SYS_BURN, amount: 4 }] })),
    ).toBe("INVALID_LEGS");
  });

  it("refuses non-positive flows", async () => {
    const a = await newResident(10);
    expect(await errCode(mint(db, { accountId: a, amount: 0, kind: "drip", idempotencyKey: key() }))).toBe("INVALID_LEGS");
    expect(await errCode(burn(db, { accountId: a, amount: -5, kind: "ride", idempotencyKey: key() }))).toBe("INVALID_LEGS");
  });

  it("rolls back with the caller's outer transaction", async () => {
    const a = await newResident(10);
    await expect(
      db.transaction(async (tx) => {
        await mint(tx, { accountId: a, amount: 5, kind: "drip", idempotencyKey: key() });
        throw new Error("caller failed after posting");
      }),
    ).rejects.toThrow("caller failed");
    expect(await getBalance(db, a)).toBe(10);
  });
});

describe("idempotency", () => {
  it("a retried posting pays once", async () => {
    const a = await newResident();
    const k = key();
    const first = await mint(db, { accountId: a, amount: 25, kind: "drip", idempotencyKey: k });
    const again = await mint(db, { accountId: a, amount: 25, kind: "drip", idempotencyKey: k });
    expect(again.replayed).toBe(true);
    expect(again.txId).toBe(first.txId);
    expect(again.balances[a]).toBe(25);
    expect(await getBalance(db, a)).toBe(25);
  });

  it("a reused key with a different posting is a conflict", async () => {
    const a = await newResident();
    const k = key();
    await mint(db, { accountId: a, amount: 25, kind: "drip", idempotencyKey: k });
    expect(await errCode(mint(db, { accountId: a, amount: 26, kind: "drip", idempotencyKey: k }))).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
    expect(await getBalance(db, a)).toBe(25);
  });

  it("20 concurrent retries of one key pay once", async () => {
    const a = await newResident();
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => mint(db, { accountId: a, amount: 7, kind: "drip", idempotencyKey: k })),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.txId)).size).toBe(1);
    expect(await getBalance(db, a)).toBe(7);
  });
});

describe("concurrency", () => {
  it("50 racing spends of 10 from 100 GM: exactly 10 win, never below zero", async () => {
    const a = await newResident(100);
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => errCode(burn(db, { accountId: a, amount: 10, kind: "ride", idempotencyKey: key() }))),
    );
    expect(outcomes.filter((o) => o === "OK")).toHaveLength(10);
    expect(outcomes.filter((o) => o === "INSUFFICIENT_FUNDS")).toHaveLength(40);
    expect(await getBalance(db, a)).toBe(0);
  });

  it("crossing transfers between the same pair never deadlock", async () => {
    const a = await newResident(1000);
    const b = await newResident(1000);
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        i % 2
          ? transfer(db, { from: a, to: b, amount: 3, kind: "gift", idempotencyKey: key() })
          : transfer(db, { from: b, to: a, amount: 3, kind: "gift", idempotencyKey: key() }),
      ),
    );
    expect((await getBalance(db, a)) + (await getBalance(db, b))).toBe(2000);
  });
});

describe("database guards (bypassing app code)", () => {
  const raw = (q: (sql: typeof client) => Promise<unknown>) =>
    client.begin(async (sql) => {
      await q(sql as unknown as typeof client);
    });

  it("refuses an unbalanced transaction at commit", async () => {
    const a = await newResident();
    await expect(
      raw(async (sql) => {
        const [t] = await sql`INSERT INTO gm_transactions (idempotency_key, kind, payload_hash) VALUES (${key()}, 'hack', 'x') RETURNING id`;
        await sql`UPDATE gm_accounts SET balance = 1000 WHERE id = ${a}`;
        await sql`INSERT INTO gm_entries (tx_id, account_id, amount, balance_after) VALUES (${t!.id}, ${a}, 1000, 1000)`;
      }),
    ).rejects.toThrow(/does not balance/);
    expect(await getBalance(db, a)).toBe(0);
  });

  it("refuses a balance edit with no entries", async () => {
    const a = await newResident(5);
    await expect(raw((sql) => sql`UPDATE gm_accounts SET balance = 999 WHERE id = ${a}`)).rejects.toThrow(
      /set outside the ledger/,
    );
    expect(await getBalance(db, a)).toBe(5);
  });

  it("refuses a balanced posting with a forged balance_after", async () => {
    const a = await newResident(5);
    await expect(
      raw(async (sql) => {
        const [t] = await sql`INSERT INTO gm_transactions (idempotency_key, kind, payload_hash) VALUES (${key()}, 'hack', 'x') RETURNING id`;
        await sql`UPDATE gm_accounts SET balance = 500 WHERE id = ${a}`;
        await sql`UPDATE gm_accounts SET balance = balance - 1 WHERE id = ${SYS_MINT}`;
        await sql`INSERT INTO gm_entries (tx_id, account_id, amount, balance_after) VALUES (${t!.id}, ${a}, 1, 500)`;
        await sql`INSERT INTO gm_entries (tx_id, account_id, amount, balance_after)
                  SELECT ${t!.id}, ${SYS_MINT}, -1, balance FROM gm_accounts WHERE id = ${SYS_MINT}`;
      }),
    ).rejects.toThrow(/balance chain/);
    expect(await getBalance(db, a)).toBe(5);
  });

  it("refuses edits and deletes of history", async () => {
    await newResident(5);
    await expect(raw((sql) => sql`UPDATE gm_entries SET amount = 1 WHERE id = (SELECT max(id) FROM gm_entries)`)).rejects.toThrow(
      /append-only/,
    );
    await expect(raw((sql) => sql`DELETE FROM gm_transactions`)).rejects.toThrow(/append-only/);
    await expect(raw((sql) => sql`TRUNCATE gm_entries CASCADE`)).rejects.toThrow(/append-only/);
  });

  it("refuses a negative balance on a resident account", async () => {
    const [u] = await db.insert(schema.users).values({ ageAckAt: new Date() }).returning();
    await expect(
      raw((sql) => sql`INSERT INTO gm_accounts (id, kind, user_id, balance) VALUES (${"user:" + u!.id}, 'user', ${u!.id}, -1)`),
    ).rejects.toThrow(/balance_floor/);
  });
});
