import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./client";
import { hitRateLimit } from "./ratelimit";
import { phoneChecks, roomVisits, users, verifiedIdentities } from "./schema";

// Proof of Neighbour: an account at least 3 days old, verified by phone (one
// account per number, no VoIP) or a crypto-native proof, that has shared
// rooms in person with 5+ neighbours. One neighbour, one vote.

export { PON } from "@bp/core";
import { PON } from "@bp/core";

export class PonError extends Error {
  constructor(
    readonly code:
      | "INVALID_PHONE"
      | "NOT_MOBILE"
      | "PHONE_TAKEN"
      | "ALREADY_VERIFIED"
      | "TOO_MANY_CODES"
      | "NO_SUCH_CHECK"
      | "CODE_EXPIRED"
      | "WRONG_CODE"
      | "PROOF_REJECTED"
      | "PROOF_TAKEN"
      | "INVALID_INPUT",
    message: string,
  ) {
    super(message);
    this.name = "PonError";
  }
}

// Providers, configured with real keys in production (Twilio Verify or
// similar for phones; Alchemy, EAS on Base and World ID for crypto proofs).
export interface PhoneVerifier {
  lineType(phone: string): Promise<"mobile" | "landline" | "voip" | "unknown">;
  start(phone: string): Promise<{ ref: string }>;
  check(ref: string, phone: string, code: string): Promise<boolean>;
}
export type CryptoProofKind = "wallet_history" | "coinbase" | "world_id";
export interface CryptoProofVerifier {
  // ok: the proof holds (6+ months of history, a valid attestation, a valid
  // World ID proof); subject: the wallet, attestation or nullifier it's about.
  verify(kind: CryptoProofKind, proof: unknown): Promise<{ ok: boolean; subject: string }>;
}

const E164 = /^\+[1-9]\d{7,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Keyed hash: enough to enforce one account per number, without keeping the number.
async function keyedHash(pepper: string, value: string) {
  if (!pepper || pepper.length < 32) throw new Error("PoN pepper must be 32+ characters");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

const isUnique = (e: unknown) => ((e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code) === "23505";

// --- Phone -----------------------------------------------------------------------

export async function startPhoneCheck(db: Db, userId: string, phone: unknown, opts: { verifier: PhoneVerifier; pepper: string; now?: Date }) {
  const now = opts.now ?? new Date();
  if (typeof phone !== "string" || !E164.test(phone)) throw new PonError("INVALID_PHONE", "use the international format, like +2348012345678");
  const hash = await keyedHash(opts.pepper, phone);
  const [mine] = await db.select().from(verifiedIdentities).where(and(eq(verifiedIdentities.userId, userId), eq(verifiedIdentities.kind, "phone")));
  if (mine) throw new PonError("ALREADY_VERIFIED", "your phone is already verified");
  const [taken] = await db.select().from(verifiedIdentities).where(and(eq(verifiedIdentities.kind, "phone"), eq(verifiedIdentities.subjectHash, hash)));
  if (taken) throw new PonError("PHONE_TAKEN", "that number is already used by another resident");
  const perUser = await hitRateLimit(db, `pon-start:${userId}`, { limit: PON.startsPerHour, windowSeconds: 3600, now });
  const perNumber = await hitRateLimit(db, `pon-number:${hash}`, { limit: PON.startsPerNumberPerDay, windowSeconds: 86_400, now });
  if (!perUser.allowed || !perNumber.allowed) throw new PonError("TOO_MANY_CODES", "too many codes; try again later");
  // No VoIP, and SMS needs a mobile.
  if ((await opts.verifier.lineType(phone)) !== "mobile") throw new PonError("NOT_MOBILE", "use a mobile number (no VoIP)");
  const { ref } = await opts.verifier.start(phone);
  const [row] = await db.insert(phoneChecks).values({ userId, phoneHash: hash, providerRef: ref, createdAt: now }).returning();
  return { checkId: row!.id };
}

// The client sends the number again with the code; it must match the hash.
export async function confirmPhoneCheck(db: Db, userId: string, input: { checkId: unknown; phone: unknown; code: unknown }, opts: { verifier: PhoneVerifier; pepper: string; now?: Date }) {
  const now = opts.now ?? new Date();
  if (typeof input.checkId !== "string" || !UUID.test(input.checkId)) throw new PonError("NO_SUCH_CHECK", "no such check");
  if (typeof input.phone !== "string" || !E164.test(input.phone)) throw new PonError("INVALID_PHONE", "which number?");
  if (typeof input.code !== "string" || !/^\d{4,10}$/.test(input.code)) throw new PonError("WRONG_CODE", "that code doesn't match");
  const hash = await keyedHash(opts.pepper, input.phone);
  return db.transaction(async (tx) => {
    const [check] = await tx.select().from(phoneChecks).where(and(eq(phoneChecks.id, input.checkId as string), eq(phoneChecks.userId, userId))).for("no key update");
    if (!check || check.status !== "pending" || check.phoneHash !== hash) throw new PonError("NO_SUCH_CHECK", "no such check");
    if (now.getTime() - check.createdAt.getTime() > PON.codeTtlMinutes * 60_000) throw new PonError("CODE_EXPIRED", "that code expired; ask for a new one");
    if (check.attempts >= PON.codeAttempts) throw new PonError("CODE_EXPIRED", "too many tries; ask for a new code");
    await tx.update(phoneChecks).set({ attempts: check.attempts + 1 }).where(eq(phoneChecks.id, check.id));
    if (!(await opts.verifier.check(check.providerRef, input.phone as string, input.code as string))) {
      return { verified: false };
    }
    try {
      await tx.insert(verifiedIdentities).values({ userId, kind: "phone", subjectHash: hash, verifiedAt: now });
    } catch (e) {
      if (isUnique(e)) throw new PonError("PHONE_TAKEN", "that number is already used by another resident");
      throw e;
    }
    await tx.update(phoneChecks).set({ status: "verified" }).where(eq(phoneChecks.id, check.id));
    return { verified: true };
  });
}

// --- Crypto-native proofs -------------------------------------------------------------

export async function addCryptoProof(db: Db, userId: string, kind: unknown, proof: unknown, opts: { verifier: CryptoProofVerifier; pepper: string; now?: Date }) {
  if (kind !== "wallet_history" && kind !== "coinbase" && kind !== "world_id") throw new PonError("INVALID_INPUT", "wallet_history, coinbase or world_id");
  const r = await opts.verifier.verify(kind, proof);
  if (!r.ok || typeof r.subject !== "string" || !r.subject) throw new PonError("PROOF_REJECTED", "that proof didn't check out");
  const hash = await keyedHash(opts.pepper, `${kind}:${r.subject.toLowerCase()}`);
  try {
    await db.insert(verifiedIdentities).values({ userId, kind, subjectHash: hash, verifiedAt: opts.now ?? new Date() });
  } catch (e) {
    if (isUnique(e)) throw new PonError("PROOF_TAKEN", "that proof is already used by a resident, or you've added one of this kind");
    throw e;
  }
  return { verified: true };
}

// --- Sharing rooms in person -------------------------------------------------------------

export async function recordVisit(db: Db, input: { userId: string; room: string; event: "start" | "end"; at: Date }) {
  if (!UUID.test(input.userId) || !/^[a-z0-9_:-]{1,64}#\d{1,6}$/.test(input.room)) throw new PonError("INVALID_INPUT", "bad visit");
  if (input.event === "start") {
    // A reconnect without an end: close the old visit first.
    await db.update(roomVisits).set({ leftAt: input.at }).where(and(eq(roomVisits.userId, input.userId), eq(roomVisits.room, input.room), isNull(roomVisits.leftAt), sql`${roomVisits.joinedAt} <= ${input.at.toISOString()}::timestamptz`));
    await db.insert(roomVisits).values({ userId: input.userId, room: input.room, joinedAt: input.at });
    return;
  }
  const [open] = await db
    .select({ id: roomVisits.id, joinedAt: roomVisits.joinedAt })
    .from(roomVisits)
    .where(and(eq(roomVisits.userId, input.userId), eq(roomVisits.room, input.room), isNull(roomVisits.leftAt)))
    .orderBy(desc(roomVisits.joinedAt))
    .limit(1);
  if (open && input.at >= open.joinedAt) await db.update(roomVisits).set({ leftAt: input.at }).where(eq(roomVisits.id, open.id));
}

// Distinct residents you've been in the same room copy with for a minute or more.
export async function sharedNeighbours(db: Db, userId: string, now = new Date()): Promise<number> {
  const cap = `${PON.openVisitCapHours} hours`;
  const [r] = await db.execute<{ n: number }>(sql`
    SELECT count(DISTINCT v2.user_id)::int AS n
    FROM room_visits v1
    JOIN room_visits v2 ON v2.room = v1.room AND v2.user_id <> v1.user_id
    JOIN residents res ON res.user_id = v2.user_id
    WHERE v1.user_id = ${userId}
      AND LEAST(
            COALESCE(v1.left_at, LEAST(${now.toISOString()}::timestamptz, v1.joined_at + ${cap}::interval)),
            COALESCE(v2.left_at, LEAST(${now.toISOString()}::timestamptz, v2.joined_at + ${cap}::interval)))
          - GREATEST(v1.joined_at, v2.joined_at) >= make_interval(secs => ${PON.overlapSeconds})`);
  return r?.n ?? 0;
}

// --- The checklist ---------------------------------------------------------------------------

// Where a resident stands, and sets the mark once every box is ticked (kept for good).
export async function ponStatus(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const [u] = await db.select({ createdAt: users.createdAt, pon: users.proofOfNeighbourAt }).from(users).where(eq(users.id, userId));
  if (!u) throw new PonError("INVALID_INPUT", "no such resident");
  const verified = (await db.select({ kind: verifiedIdentities.kind }).from(verifiedIdentities).where(eq(verifiedIdentities.userId, userId))).map((v) => v.kind);
  const ageDays = (now.getTime() - u.createdAt.getTime()) / 86_400_000;
  const neighbours = await sharedNeighbours(db, userId, now);
  const checks = { ageOk: ageDays >= PON.minAccountDays, verified, neighbours, neighboursNeeded: PON.neighboursNeeded };
  let since = u.pon;
  if (!since && checks.ageOk && verified.length > 0 && neighbours >= PON.neighboursNeeded) {
    await db.update(users).set({ proofOfNeighbourAt: now }).where(and(eq(users.id, userId), isNull(users.proofOfNeighbourAt)));
    since = now;
  }
  return { ...checks, proofOfNeighbour: !!since, since };
}
