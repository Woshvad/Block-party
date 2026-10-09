import {
  BURN_SHARDS,
  type Leg,
  LedgerError,
  MINT_SHARDS,
  SYS_PURSE,
  burnAccountFor,
  isMintAccount,
  mintAccountFor,
  postingHash,
  userAccountId,
  validateLegs,
} from "@bp/core";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { gmAccounts, gmEntries, gmTransactions } from "./schema";

export type PostInput = {
  idempotencyKey: string;
  kind: string;
  legs: Leg[];
  meta?: Record<string, unknown>;
};

export type PostResult = {
  txId: string;
  replayed: boolean;
  balances: Record<string, number>;
};

// Posts one balanced GM transaction. Safe to call inside an outer transaction
// (it becomes a savepoint), safe to retry with the same idempotency key, and
// safe under concurrency: accounts are locked in id order so postings never
// deadlock, and balances are checked under the lock.
export async function post(db: Db, input: PostInput): Promise<PostResult> {
  validateLegs(input.legs);
  if (!input.idempotencyKey) {
    throw new LedgerError("INVALID_LEGS", "idempotencyKey is required");
  }
  const hash = await postingHash(input.kind, input.legs);

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(gmTransactions)
      .values({
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        payloadHash: hash,
        meta: input.meta ?? {},
      })
      .onConflictDoNothing({ target: gmTransactions.idempotencyKey })
      .returning({ id: gmTransactions.id });

    if (inserted.length === 0) {
      return replay(tx as unknown as Db, input.idempotencyKey, hash);
    }
    const txId = inserted[0]!.id;

    const ids = input.legs.map((l) => l.accountId).sort();
    const locked = await tx
      .select({ id: gmAccounts.id, balance: gmAccounts.balance, allowNegative: gmAccounts.allowNegative })
      .from(gmAccounts)
      .where(inArray(gmAccounts.id, ids))
      .orderBy(asc(gmAccounts.id))
      .for("no key update");

    const byId = new Map(locked.map((a) => [a.id, a]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new LedgerError("UNKNOWN_ACCOUNT", "posting references unknown accounts", { missing });
    }

    const balances: Record<string, number> = {};
    for (const leg of input.legs) {
      const acct = byId.get(leg.accountId)!;
      const next = acct.balance + leg.amount;
      if (next < 0 && !acct.allowNegative) {
        throw new LedgerError("INSUFFICIENT_FUNDS", "not enough GM", {
          accountId: leg.accountId,
          balance: acct.balance,
          needed: -leg.amount,
        });
      }
      balances[leg.accountId] = next;
    }

    // Stable order keeps entry ids (and so the balance chain) deterministic.
    const legs = [...input.legs].sort((a, b) => (a.accountId < b.accountId ? -1 : 1));
    for (const leg of legs) {
      await tx
        .update(gmAccounts)
        .set({ balance: balances[leg.accountId]! })
        .where(eq(gmAccounts.id, leg.accountId));
    }
    await tx.insert(gmEntries).values(
      legs.map((leg) => ({
        txId,
        accountId: leg.accountId,
        amount: leg.amount,
        balanceAfter: balances[leg.accountId]!,
      })),
    );

    return { txId, replayed: false, balances };
  });
}

// Locks accounts in the same global order post() uses (sorted ids). Anything
// that reads a balance before posting must lock through here, or it can
// deadlock against an ordinary posting (the Halving once did).
export async function lockAccounts(db: Db, ids: string[]) {
  const sorted = [...new Set(ids)].sort();
  const rows = await db
    .select({ id: gmAccounts.id, balance: gmAccounts.balance })
    .from(gmAccounts)
    .where(inArray(gmAccounts.id, sorted))
    .orderBy(asc(gmAccounts.id))
    .for("no key update");
  return new Map(rows.map((r) => [r.id, r.balance]));
}

async function replay(db: Db, idempotencyKey: string, hash: string): Promise<PostResult> {
  const [existing] = await db
    .select()
    .from(gmTransactions)
    .where(eq(gmTransactions.idempotencyKey, idempotencyKey));
  if (!existing) {
    // Only reachable if the conflicting row vanished, which append-only forbids.
    throw new Error(`idempotency key ${idempotencyKey} conflicted but no transaction found`);
  }
  if (existing.payloadHash !== hash) {
    throw new LedgerError("IDEMPOTENCY_CONFLICT", "idempotency key reused with a different posting", {
      idempotencyKey,
      txId: existing.id,
    });
  }
  const entries = await db
    .select({ accountId: gmEntries.accountId, balanceAfter: gmEntries.balanceAfter })
    .from(gmEntries)
    .where(eq(gmEntries.txId, existing.id));
  return {
    txId: existing.id,
    replayed: true,
    balances: Object.fromEntries(entries.map((e) => [e.accountId, e.balanceAfter])),
  };
}

// --- Accounts -------------------------------------------------------------

export async function ensureSystemAccounts(db: Db) {
  await db
    .insert(gmAccounts)
    .values([
      ...MINT_SHARDS.map((id) => ({ id, kind: "system" as const, allowNegative: true })),
      ...BURN_SHARDS.map((id) => ({ id, kind: "system" as const })),
      { id: SYS_PURSE, kind: "system" },
    ])
    .onConflictDoNothing();
}

export async function openUserAccount(db: Db, userId: string): Promise<string> {
  const id = userAccountId(userId);
  await db.insert(gmAccounts).values({ id, kind: "user", userId }).onConflictDoNothing();
  return id;
}

export async function openEscrowAccount(db: Db, id: string): Promise<string> {
  await db.insert(gmAccounts).values({ id, kind: "escrow" }).onConflictDoNothing();
  return id;
}

export async function getBalance(db: Db, accountId: string): Promise<number> {
  const [row] = await db.select({ balance: gmAccounts.balance }).from(gmAccounts).where(eq(gmAccounts.id, accountId));
  if (!row) throw new LedgerError("UNKNOWN_ACCOUNT", "unknown account", { accountId });
  return row.balance;
}

export async function listEntries(db: Db, accountId: string, limit = 50) {
  return db
    .select({
      id: gmEntries.id,
      txId: gmEntries.txId,
      kind: gmTransactions.kind,
      amount: gmEntries.amount,
      balanceAfter: gmEntries.balanceAfter,
      meta: gmTransactions.meta,
      createdAt: gmEntries.createdAt,
    })
    .from(gmEntries)
    .innerJoin(gmTransactions, eq(gmTransactions.id, gmEntries.txId))
    .where(eq(gmEntries.accountId, accountId))
    .orderBy(desc(gmEntries.id))
    .limit(limit);
}

// --- Faucets and sinks ----------------------------------------------------

type Flow = { accountId: string; amount: number; kind: string; idempotencyKey: string; meta?: Record<string, unknown> };

const positive = (amount: number) => {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new LedgerError("INVALID_LEGS", "amount must be a positive integer", { amount });
  }
};

// Creates GM (drip, shift pay, streak bonus...).
export async function mint(db: Db, f: Flow) {
  positive(f.amount);
  return post(db, { ...f, legs: [{ accountId: mintAccountFor(f.accountId), amount: -f.amount }, { accountId: f.accountId, amount: f.amount }] });
}

// Destroys GM (furniture, rides, retreat burns, the Halving...).
export async function burn(db: Db, f: Flow) {
  positive(f.amount);
  return post(db, { ...f, legs: [{ accountId: f.accountId, amount: -f.amount }, { accountId: burnAccountFor(f.accountId), amount: f.amount }] });
}

export async function transfer(db: Db, f: Omit<Flow, "accountId"> & { from: string; to: string }) {
  positive(f.amount);
  const { from, to, ...rest } = f;
  return post(db, { ...rest, legs: [{ accountId: from, amount: -f.amount }, { accountId: to, amount: f.amount }] });
}

// Economy health: the plan targets destroyed / created of 0.9 to 1.1 weekly.
export async function supplyStats(db: Db) {
  const rows = await db
    .select({ id: gmAccounts.id, balance: gmAccounts.balance })
    .from(gmAccounts)
    .where(inArray(gmAccounts.id, [...MINT_SHARDS, ...BURN_SHARDS]));
  const created = -rows.filter((r) => isMintAccount(r.id)).reduce((a, r) => a + r.balance, 0);
  const destroyed = rows.filter((r) => !isMintAccount(r.id)).reduce((a, r) => a + r.balance, 0);
  return { created, destroyed, circulating: created - destroyed };
}

// Full audit: every cached balance equals the sum of its entries. Should
// always return [] thanks to the DB guards; run it in the nightly job anyway.
export async function reconcile(db: Db) {
  const rows = await db.execute<{ id: string; balance: string; ledger: string }>(sql`
    SELECT a.id, a.balance, COALESCE(SUM(e.amount), 0) AS ledger
    FROM gm_accounts a LEFT JOIN gm_entries e ON e.account_id = a.id
    GROUP BY a.id, a.balance
    HAVING a.balance <> COALESCE(SUM(e.amount), 0)
  `);
  return [...rows];
}
