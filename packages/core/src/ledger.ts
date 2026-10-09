// Pure GM ledger rules. No I/O here so the same checks run in the API,
// in Workers and in tests.

export type Leg = { accountId: string; amount: number };

export type LedgerErrorCode =
  | "INVALID_LEGS"
  | "UNKNOWN_ACCOUNT"
  | "INSUFFICIENT_FUNDS"
  | "IDEMPOTENCY_CONFLICT";

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

// Far below 2^53 so balances can never lose precision as JS numbers.
export const MAX_LEG_AMOUNT = 1_000_000_000;

export function validateLegs(legs: readonly Leg[]): void {
  if (legs.length < 2) {
    throw new LedgerError("INVALID_LEGS", "a transaction needs at least 2 legs");
  }
  const seen = new Set<string>();
  let sum = 0;
  for (const leg of legs) {
    if (!leg.accountId) {
      throw new LedgerError("INVALID_LEGS", "leg is missing accountId");
    }
    if (seen.has(leg.accountId)) {
      throw new LedgerError("INVALID_LEGS", "account appears twice in one transaction", {
        accountId: leg.accountId,
      });
    }
    seen.add(leg.accountId);
    if (!Number.isSafeInteger(leg.amount) || leg.amount === 0) {
      throw new LedgerError("INVALID_LEGS", "leg amount must be a non-zero integer", { leg });
    }
    if (Math.abs(leg.amount) > MAX_LEG_AMOUNT) {
      throw new LedgerError("INVALID_LEGS", "leg amount exceeds MAX_LEG_AMOUNT", { leg });
    }
    sum += leg.amount;
  }
  if (sum !== 0) {
    throw new LedgerError("INVALID_LEGS", "legs must sum to zero", { sum });
  }
}

// Stable string for a posting, so a replayed idempotency key can be checked
// against the original request.
export function canonicalPosting(kind: string, legs: readonly Leg[]): string {
  const sorted = [...legs].sort((a, b) => (a.accountId < b.accountId ? -1 : 1));
  return JSON.stringify([kind, sorted.map((l) => [l.accountId, l.amount])]);
}

export async function postingHash(kind: string, legs: readonly Leg[]): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalPosting(kind, legs));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Account ids. System accounts are fixed; user and escrow ids are derived.
export const SYS_MINT = "sys:mint"; // every GM ever created leaves here; runs negative
export const SYS_BURN = "sys:burn"; // every GM ever destroyed lands here

// Every mint and burn in the city used to lock one of those two rows, so all
// GM flows queued behind each other. Each is now 16 shards; the shard is
// picked from the other account, so one resident always uses the same shard
// and different residents mostly don't collide. Shard 0 keeps the old id, so
// history before sharding stays where it was. Reports sum all shards.
export const SYS_SHARDS = 16;
const shardIds = (base: string) => Array.from({ length: SYS_SHARDS }, (_, i) => (i === 0 ? base : `${base}:${i}`));
export const MINT_SHARDS: readonly string[] = shardIds(SYS_MINT);
export const BURN_SHARDS: readonly string[] = shardIds(SYS_BURN);

// FNV-1a: stable across runtimes, no crypto needed.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
export const mintAccountFor = (to: string) => MINT_SHARDS[fnv1a(to) % SYS_SHARDS]!;
export const burnAccountFor = (from: string) => BURN_SHARDS[fnv1a(from) % SYS_SHARDS]!;
export const isMintAccount = (id: string) => MINT_SHARDS.includes(id);
export const isBurnAccount = (id: string) => BURN_SHARDS.includes(id);
export const userAccountId = (userId: string) => `user:${userId}`;
export const escrowAccountId = (scope: string, id: string) => `escrow:${scope}:${id}`;
