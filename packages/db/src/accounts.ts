import {
  type PrivyVerifier,
  SESSION_TTL_SECONDS,
  hashSessionToken,
  isWellFormedSessionToken,
  newSessionToken,
  verifyTelegramInitData,
} from "@bp/core";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "./client";
import { grantMoveIn } from "./daily";
import { openUserAccount } from "./ledger";
import { identities, sessions, users } from "./schema";

export type AccountErrorCode = "AGE_ACK_REQUIRED" | "PROVIDER_ALREADY_LINKED" | "INVALID_SESSION";

export class AccountError extends Error {
  constructor(readonly code: AccountErrorCode, message: string) {
    super(message);
    this.name = "AccountError";
  }
}

export type Provider = "telegram" | "privy";

export type AuthResult = {
  userId: string;
  sessionToken: string;
  expiresAt: Date;
  status: "guest" | "claimed";
  // A brand-new resident was created by this call.
  isNew: boolean;
  // The caller was a guest and signed into a different, existing account.
  // The guest's progress stays on the guest; we never merge GM between accounts.
  leftGuest: boolean;
};

export type SessionInfo = { sessionId: string; userId: string; status: "guest" | "claimed" };

// --- Sessions -------------------------------------------------------------

async function issueSession(db: Db, userId: string, now = new Date()) {
  const sessionToken = newSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  await db.insert(sessions).values({ userId, tokenHash: await hashSessionToken(sessionToken), expiresAt });
  return { sessionToken, expiresAt };
}

export async function resolveSession(
  db: Db,
  token: unknown,
  opts: { now?: Date; lock?: boolean } = {},
): Promise<SessionInfo | null> {
  if (!isWellFormedSessionToken(token)) return null;
  const q = db
    .select({ sessionId: sessions.id, userId: users.id, status: users.status })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, await hashSessionToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, opts.now ?? new Date()),
      ),
    );
  // Locking the user row serialises concurrent sign-ins for the same resident.
  const [row] = opts.lock ? await q.for("update", { of: users }) : await q;
  return row ?? null;
}

export async function revokeSession(db: Db, token: string) {
  if (!isWellFormedSessionToken(token)) return;
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, await hashSessionToken(token)), isNull(sessions.revokedAt)));
}

export async function revokeAllSessions(db: Db, userId: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

// --- Sign-in flows --------------------------------------------------------

// First tap: a guest resident behind the one-tap 18+ notice.
export async function createGuest(db: Db, opts: { ageAck: boolean }): Promise<AuthResult> {
  if (opts.ageAck !== true) throw new AccountError("AGE_ACK_REQUIRED", "the 18+ notice must be accepted");
  return db.transaction(async (tx) => {
    const [u] = await tx.insert(users).values({ ageAckAt: new Date() }).returning();
    await openUserAccount(tx, u!.id);
    const s = await issueSession(tx, u!.id);
    return { userId: u!.id, ...s, status: "guest" as const, isNew: true, leftGuest: false };
  });
}

type IdentityInput = {
  provider: Provider;
  subject: string;
  meta?: Record<string, unknown>;
  currentSessionToken?: string;
  ageAck?: boolean;
};

const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23505" || err?.cause?.code === "23505";
};

// Three outcomes:
//  1. identity already known        -> sign into its owner (a guest caller is left behind, not merged)
//  2. unknown identity, guest/user  -> link it to the caller; a guest becomes claimed
//  3. unknown identity, no session  -> new claimed resident (needs the 18+ ack)
// The session token always rotates on sign-in.
export async function signInWithIdentity(db: Db, input: IdentityInput): Promise<AuthResult> {
  // Two first sign-ins with the same identity can race; the unique constraint
  // picks a winner and the loser retries into outcome 1.
  // loop-bound: at most 3 attempts; the catch rethrows once attempt reaches 2.
  for (let attempt = 0; ; attempt++) {
    try {
      return await signInOnce(db, input);
    } catch (e) {
      if (attempt < 2 && isUniqueViolation(e)) continue;
      throw e;
    }
  }
}

async function signInOnce(db: Db, input: IdentityInput): Promise<AuthResult> {
  return db.transaction(async (tx) => {
    let current: SessionInfo | null = null;
    if (input.currentSessionToken !== undefined) {
      current = await resolveSession(tx, input.currentSessionToken, { lock: true });
      // Never silently fall through to "new resident": the client drops the
      // stale token and retries without it.
      if (!current) throw new AccountError("INVALID_SESSION", "session is expired, revoked or unknown");
    }

    const [known] = await tx
      .select({ userId: identities.userId, status: users.status })
      .from(identities)
      .innerJoin(users, eq(users.id, identities.userId))
      .where(and(eq(identities.provider, input.provider), eq(identities.subject, input.subject)));

    if (known) {
      if (current && current.userId !== known.userId && input.currentSessionToken) {
        await revokeSession(tx, input.currentSessionToken);
      }
      const s = await issueSession(tx, known.userId);
      return {
        userId: known.userId,
        ...s,
        status: known.status,
        isNew: false,
        leftGuest: !!current && current.userId !== known.userId && current.status === "guest",
      };
    }

    if (current) {
      const [already] = await tx
        .select({ id: identities.id })
        .from(identities)
        .where(and(eq(identities.userId, current.userId), eq(identities.provider, input.provider)));
      if (already) {
        throw new AccountError("PROVIDER_ALREADY_LINKED", `this resident already has a ${input.provider} login`);
      }
      await tx.insert(identities).values({
        userId: current.userId,
        provider: input.provider,
        subject: input.subject,
        meta: input.meta ?? {},
      });
      if (current.status === "guest") {
        await tx.update(users).set({ status: "claimed", claimedAt: new Date() }).where(eq(users.id, current.userId));
        await grantMoveIn(tx, current.userId);
      }
      await revokeSession(tx, input.currentSessionToken!);
      const s = await issueSession(tx, current.userId);
      return { userId: current.userId, ...s, status: "claimed" as const, isNew: false, leftGuest: false };
    }

    if (input.ageAck !== true) throw new AccountError("AGE_ACK_REQUIRED", "the 18+ notice must be accepted");
    const now = new Date();
    const [u] = await tx.insert(users).values({ ageAckAt: now, status: "claimed", claimedAt: now }).returning();
    await tx.insert(identities).values({
      userId: u!.id,
      provider: input.provider,
      subject: input.subject,
      meta: input.meta ?? {},
    });
    await openUserAccount(tx, u!.id);
    await grantMoveIn(tx, u!.id);
    const s = await issueSession(tx, u!.id);
    return { userId: u!.id, ...s, status: "claimed" as const, isNew: true, leftGuest: false };
  });
}

export async function signInWithTelegram(
  db: Db,
  opts: { initData: string; botToken: string; currentSessionToken?: string; ageAck?: boolean; now?: number },
) {
  const { user, startParam } = await verifyTelegramInitData(opts.initData, opts.botToken, { now: opts.now });
  const result = await signInWithIdentity(db, {
    provider: "telegram",
    subject: String(user.id),
    // Only what the city needs: a handle hint and a language.
    meta: { username: user.username ?? null, languageCode: user.language_code ?? null },
    currentSessionToken: opts.currentSessionToken,
    ageAck: opts.ageAck,
  });
  return { ...result, startParam };
}

export async function signInWithPrivy(
  db: Db,
  opts: { accessToken: string; verify: PrivyVerifier; currentSessionToken?: string; ageAck?: boolean },
) {
  const { did } = await opts.verify(opts.accessToken);
  return signInWithIdentity(db, {
    provider: "privy",
    subject: did,
    currentSessionToken: opts.currentSessionToken,
    ageAck: opts.ageAck,
  });
}
