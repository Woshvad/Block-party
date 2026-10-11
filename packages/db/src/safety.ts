import {
  MODERATION,
  type ModerationProvider,
  OPENAI_MODERATION_BATCH,
  REPORT_REASONS,
  type ReportReason,
} from "@bp/core";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./client";
import { hitRateLimit } from "./ratelimit";
import { appeals, bestFrens, blocks, frenTaps, frens, moderationItems, mutes, reports, restrictions, rivalries, staff, users } from "./schema";

export type SafetyErrorCode =
  | "INVALID_INPUT"
  | "NOT_SELF"
  | "NO_SUCH_USER"
  | "TOO_MANY_REPORTS"
  | "NOT_STAFF"
  | "NO_SUCH_REPORT"
  | "NO_SUCH_RESTRICTION"
  | "ALREADY_APPEALED"
  | "NO_SUCH_APPEAL"
  | "RESTRICTED"
  | "DM_LIMIT";

export class SafetyError extends Error {
  constructor(
    readonly code: SafetyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SafetyError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireUser(db: Db, id: unknown): Promise<string> {
  if (typeof id !== "string" || !UUID.test(id)) throw new SafetyError("NO_SUCH_USER", "no such resident");
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, id.toLowerCase()));
  if (!u) throw new SafetyError("NO_SUCH_USER", "no such resident");
  return u.id;
}

// --- Block and mute -------------------------------------------------------

// A block works both ways: neither side sees or reaches the other.
export async function blockUser(db: Db, blockerId: string, target: unknown) {
  const blockedId = await requireUser(db, target);
  if (blockedId === blockerId) throw new SafetyError("NOT_SELF", "you can't block yourself");
  const [a, b] = blockerId < blockedId ? [blockerId, blockedId] : [blockedId, blockerId];
  // A block ends everything between the two: frenship, fren taps, best-fren picks, rivalry.
  await db.transaction(async (tx) => {
    await tx.insert(blocks).values({ blockerId, blockedId }).onConflictDoNothing();
    await tx.delete(frens).where(and(eq(frens.a, a), eq(frens.b, b)));
    await tx.delete(frenTaps).where(or(and(eq(frenTaps.fromId, a), eq(frenTaps.toId, b)), and(eq(frenTaps.fromId, b), eq(frenTaps.toId, a))));
    await tx.delete(bestFrens).where(or(and(eq(bestFrens.userId, a), eq(bestFrens.frenId, b)), and(eq(bestFrens.userId, b), eq(bestFrens.frenId, a))));
    await tx.delete(rivalries).where(and(eq(rivalries.a, a), eq(rivalries.b, b)));
  });
}

export async function unblockUser(db: Db, blockerId: string, target: unknown) {
  if (typeof target !== "string" || !UUID.test(target)) return;
  await db.delete(blocks).where(and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, target.toLowerCase())));
}

export async function isBlockedEitherWay(db: Db, a: string, b: string): Promise<boolean> {
  const [row] = await db
    .select({ x: sql<number>`1` })
    .from(blocks)
    .where(or(and(eq(blocks.blockerId, a), eq(blocks.blockedId, b)), and(eq(blocks.blockerId, b), eq(blocks.blockedId, a))))
    .limit(1);
  return !!row;
}

export async function muteUser(db: Db, muterId: string, target: unknown, opts: { hours?: unknown; now?: Date } = {}) {
  const mutedId = await requireUser(db, target);
  if (mutedId === muterId) throw new SafetyError("NOT_SELF", "you can't mute yourself");
  let until: Date | null = null;
  if (opts.hours !== undefined) {
    if (typeof opts.hours !== "number" || !Number.isFinite(opts.hours) || opts.hours <= 0 || opts.hours > 24 * 365) {
      throw new SafetyError("INVALID_INPUT", "hours must be between 0 and a year");
    }
    until = new Date((opts.now ?? new Date()).getTime() + opts.hours * 3_600_000);
  }
  await db.insert(mutes).values({ muterId, mutedId, until }).onConflictDoUpdate({ target: [mutes.muterId, mutes.mutedId], set: { until } });
}

export async function unmuteUser(db: Db, muterId: string, target: unknown) {
  if (typeof target !== "string" || !UUID.test(target)) return;
  await db.delete(mutes).where(and(eq(mutes.muterId, muterId), eq(mutes.mutedId, target.toLowerCase())));
}

export async function isMuted(db: Db, muterId: string, mutedId: string, now = new Date()) {
  const [m] = await db.select().from(mutes).where(and(eq(mutes.muterId, muterId), eq(mutes.mutedId, mutedId)));
  return !!m && (m.until === null || m.until > now);
}

// --- Reports --------------------------------------------------------------

export type Evidence = Array<{ at: string; authorId: string; text: string }>;

// Evidence comes from the server (the room or DM snapshots its last
// messages); the API never takes evidence from the reporter.
export async function fileReport(
  db: Db,
  reporterId: string,
  input: { target: unknown; reason: unknown; place?: unknown; note?: unknown; evidence?: Evidence },
  opts: { now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  const targetUserId = await requireUser(db, input.target);
  if (targetUserId === reporterId) throw new SafetyError("NOT_SELF", "you can't report yourself");
  if (typeof input.reason !== "string" || !(REPORT_REASONS as readonly string[]).includes(input.reason)) {
    throw new SafetyError("INVALID_INPUT", `reason must be one of ${REPORT_REASONS.join(", ")}`);
  }
  const reason = input.reason as ReportReason;
  const place = typeof input.place === "string" ? input.place.slice(0, 80) : null;
  const note = typeof input.note === "string" ? input.note.slice(0, 1000) : null;
  const evidence = (input.evidence ?? []).slice(-20).map((e) => ({ at: String(e.at), authorId: String(e.authorId), text: String(e.text).slice(0, 2000) }));

  const [open] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.reporterId, reporterId), eq(reports.targetUserId, targetUserId), eq(reports.reason, reason), eq(reports.status, "open")));
  if (open) return open; // already being looked at

  const rl = await hitRateLimit(db, `reports:${reporterId}`, { limit: MODERATION.reportsPerDay, windowSeconds: 86_400, now });
  if (!rl.allowed) throw new SafetyError("TOO_MANY_REPORTS", "you've sent a lot of reports today; staff will get to them");

  const [row] = await db
    .insert(reports)
    .values({
      reporterId,
      targetUserId,
      reason,
      place,
      note,
      evidence,
      priority: reason === "under_18",
      createdAt: now,
      dueAt: new Date(now.getTime() + MODERATION.reportDueHours * 3_600_000),
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  // Lost a race with an identical report: return that one.
  const [same] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.reporterId, reporterId), eq(reports.targetUserId, targetUserId), eq(reports.reason, reason), eq(reports.status, "open")));
  return same!;
}

// --- Staff ----------------------------------------------------------------

async function requireStaff(db: Db, userId: string) {
  const [s] = await db.select().from(staff).where(eq(staff.userId, userId));
  if (!s) throw new SafetyError("NOT_STAFF", "staff only");
  return s;
}

export const isStaff = async (db: Db, userId: string) => !!(await db.select().from(staff).where(eq(staff.userId, userId)))[0];

// Oldest deadline first; under-18 reports jump the queue.
export async function openReports(db: Db, staffId: string) {
  await requireStaff(db, staffId);
  return db.select().from(reports).where(eq(reports.status, "open")).orderBy(sql`${reports.priority} DESC`, asc(reports.dueAt)).limit(200);
}

const reasonText = (r: unknown, min: number, what: string) => {
  if (typeof r !== "string" || r.trim().length < min) throw new SafetyError("INVALID_INPUT", `${what} needs at least ${min} characters`);
  return r.trim().slice(0, 2000);
};

export async function restrictUser(
  db: Db,
  staffId: string,
  input: { userId: unknown; kind: unknown; hours?: unknown; reason: unknown; reportId?: string | null },
  opts: { now?: Date } = {},
) {
  await requireStaff(db, staffId);
  const now = opts.now ?? new Date();
  const userId = await requireUser(db, input.userId);
  if (input.kind !== "chat_mute" && input.kind !== "suspended") throw new SafetyError("INVALID_INPUT", "kind must be chat_mute or suspended");
  // The EU statement of reasons: the player gets to read why.
  const reason = reasonText(input.reason, 20, "a restriction's reason");
  let endsAt: Date | null = null;
  if (input.hours !== undefined && input.hours !== null) {
    if (typeof input.hours !== "number" || !Number.isFinite(input.hours) || input.hours <= 0 || input.hours > 24 * 3650) {
      throw new SafetyError("INVALID_INPUT", "hours must be positive");
    }
    endsAt = new Date(now.getTime() + input.hours * 3_600_000);
  }
  const [r] = await db
    .insert(restrictions)
    .values({ userId, kind: input.kind, reason, reportId: input.reportId ?? null, startsAt: now, endsAt, createdBy: staffId })
    .returning();
  return r!;
}

export async function resolveReport(
  db: Db,
  staffId: string,
  reportId: unknown,
  input: { action: unknown; note: unknown; restriction?: { kind: unknown; hours?: unknown; reason: unknown } },
  opts: { now?: Date } = {},
) {
  await requireStaff(db, staffId);
  const now = opts.now ?? new Date();
  if (typeof reportId !== "string" || !UUID.test(reportId)) throw new SafetyError("NO_SUCH_REPORT", "no such report");
  if (input.action !== "dismiss" && input.action !== "restrict") throw new SafetyError("INVALID_INPUT", "action must be dismiss or restrict");
  const note = reasonText(input.note, 10, "a resolution note");
  return db.transaction(async (tx) => {
    const [rep] = await tx.select().from(reports).where(eq(reports.id, reportId)).for("no key update");
    if (!rep || rep.status !== "open") throw new SafetyError("NO_SUCH_REPORT", "no open report");
    let restriction = null;
    if (input.action === "restrict") {
      if (!input.restriction) throw new SafetyError("INVALID_INPUT", "restrict needs a restriction");
      restriction = await restrictUser(tx, staffId, { ...input.restriction, userId: rep.targetUserId, reportId: rep.id }, { now });
    }
    const [done] = await tx
      .update(reports)
      .set({ status: input.action === "restrict" ? "actioned" : "dismissed", resolvedAt: now, resolvedBy: staffId, resolution: note })
      .where(eq(reports.id, rep.id))
      .returning();
    return { report: done!, restriction };
  });
}

// --- Restrictions as the player sees them ----------------------------------

export async function activeRestrictions(db: Db, userId: string, now = new Date()) {
  return db
    .select({ id: restrictions.id, kind: restrictions.kind, reason: restrictions.reason, startsAt: restrictions.startsAt, endsAt: restrictions.endsAt })
    .from(restrictions)
    .where(and(eq(restrictions.userId, userId), isNull(restrictions.liftedAt), sql`${restrictions.startsAt} <= ${now.toISOString()}::timestamptz`, or(isNull(restrictions.endsAt), gt(restrictions.endsAt, now))));
}

export async function isRestricted(db: Db, userId: string, kind: "chat_mute" | "suspended", now = new Date()) {
  const active = await activeRestrictions(db, userId, now);
  // A suspension covers chat too.
  return active.some((r) => r.kind === kind || r.kind === "suspended");
}

export async function appealRestriction(db: Db, userId: string, restrictionId: unknown, text: unknown, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  if (typeof restrictionId !== "string" || !UUID.test(restrictionId)) throw new SafetyError("NO_SUCH_RESTRICTION", "no such restriction");
  const body = reasonText(text, 10, "an appeal");
  const [r] = await db.select().from(restrictions).where(and(eq(restrictions.id, restrictionId), eq(restrictions.userId, userId)));
  if (!r) throw new SafetyError("NO_SUCH_RESTRICTION", "no such restriction");
  const [a] = await db.insert(appeals).values({ restrictionId: r.id, userId, text: body, createdAt: now }).onConflictDoNothing().returning();
  if (!a) throw new SafetyError("ALREADY_APPEALED", "you've already appealed this one");
  return a;
}

export async function openAppeals(db: Db, staffId: string) {
  await requireStaff(db, staffId);
  return db.select().from(appeals).where(eq(appeals.status, "open")).orderBy(asc(appeals.createdAt));
}

export async function decideAppeal(db: Db, staffId: string, appealId: unknown, input: { overturn: unknown; note: unknown }, opts: { now?: Date } = {}) {
  await requireStaff(db, staffId);
  const now = opts.now ?? new Date();
  if (typeof appealId !== "string" || !UUID.test(appealId)) throw new SafetyError("NO_SUCH_APPEAL", "no such appeal");
  if (typeof input.overturn !== "boolean") throw new SafetyError("INVALID_INPUT", "overturn must be true or false");
  const note = reasonText(input.note, 10, "a decision note");
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(appeals).where(eq(appeals.id, appealId)).for("no key update");
    if (!a || a.status !== "open") throw new SafetyError("NO_SUCH_APPEAL", "no open appeal");
    const [r] = await tx.select().from(restrictions).where(eq(restrictions.id, a.restrictionId));
    // Nobody decides their own case: the staff member who restricted can't rule on the appeal.
    if (r!.createdBy === staffId) throw new SafetyError("NOT_STAFF", "another staff member must decide this appeal");
    await tx.update(appeals).set({ status: input.overturn ? "overturned" : "upheld", decidedBy: staffId, decidedAt: now, decisionNote: note }).where(eq(appeals.id, a.id));
    if (input.overturn) await tx.update(restrictions).set({ liftedAt: now, liftedBy: staffId }).where(eq(restrictions.id, a.restrictionId));
    return { overturned: input.overturn };
  });
}

// The plan's target: 95%+ of reports answered within 24 hours.
export async function reportSla(db: Db, opts: { from: Date; to: Date; now?: Date }) {
  const now = opts.now ?? new Date();
  const [r] = await db.execute<{ total: number; on_time: number; overdue_open: number }>(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE resolved_at IS NOT NULL AND resolved_at <= due_at)::int AS on_time,
           count(*) FILTER (WHERE resolved_at IS NULL AND due_at < ${now.toISOString()}::timestamptz)::int AS overdue_open
    FROM reports WHERE created_at >= ${opts.from.toISOString()}::timestamptz AND created_at < ${opts.to.toISOString()}::timestamptz`);
  const total = r?.total ?? 0;
  return { total, onTime: r?.on_time ?? 0, overdueOpen: r?.overdue_open ?? 0, onTimeShare: total ? (r?.on_time ?? 0) / total : null };
}

// --- New-account DM limit ---------------------------------------------------

export async function allowNewDmThread(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const [u] = await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId));
  if (!u) throw new SafetyError("NO_SUCH_USER", "no such resident");
  const ageDays = (now.getTime() - u.createdAt.getTime()) / 86_400_000;
  if (ageDays >= MODERATION.linksAfterDays) return;
  const rl = await hitRateLimit(db, `dm-threads:${userId}`, { limit: MODERATION.newAccountDmThreadsPerDay, windowSeconds: 86_400, now });
  if (!rl.allowed) throw new SafetyError("DM_LIMIT", `new accounts can start ${MODERATION.newAccountDmThreadsPerDay} new conversations a day`);
}

export async function accountAgeDays(db: Db, userId: string, now = new Date()) {
  const [u] = await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId));
  return u ? (now.getTime() - u.createdAt.getTime()) / 86_400_000 : 0;
}

// --- The AI check, in batches -------------------------------------------------

export async function enqueueModeration(db: Db, item: { kind: string; ref: string; authorId: string | null; text: string }) {
  const [row] = await db.insert(moderationItems).values({ ...item, text: item.text.slice(0, 4000) }).returning();
  return row!;
}

// The same, under an id the caller derives from what it's queueing, so a
// retry adds nothing (the rooms resend a batch whose answer they missed).
// Returns the new item, or null if that id was already queued.
export async function enqueueModerationOnce(db: Db, id: string, item: { kind: string; ref: string; authorId: string | null; text: string }) {
  const [row] = await db
    .insert(moderationItems)
    .values({ ...item, id, text: item.text.slice(0, 4000) })
    .onConflictDoNothing({ target: moderationItems.id })
    .returning();
  return row ?? null;
}

export const MAX_MODERATION_ATTEMPTS = 5;

// Claims a batch with SKIP LOCKED (so parallel workers never check the same
// item), asks the provider, and records the answer. If the provider fails,
// nothing is marked clean: the items stay pending, and after 5 failed
// attempts they go to staff as "error".
export async function runModerationBatch(
  db: Db,
  provider: ModerationProvider,
  opts: { batchSize?: number; now?: Date; onFlagged?: (item: { id: string; kind: string; ref: string; authorId: string | null; categories: string[] }) => Promise<void> } = {},
) {
  const size = Math.min(opts.batchSize ?? OPENAI_MODERATION_BATCH, OPENAI_MODERATION_BATCH);
  const now = opts.now ?? new Date();
  const flaggedItems: Array<{ id: string; kind: string; ref: string; authorId: string | null; categories: string[] }> = [];
  const outcome = await db.transaction(async (tx) => {
    const batch = await tx
      .select()
      .from(moderationItems)
      .where(eq(moderationItems.status, "pending"))
      .orderBy(asc(moderationItems.createdAt))
      .limit(size)
      .for("no key update", { skipLocked: true });
    if (batch.length === 0) return { checked: 0, flagged: 0, failed: 0 };
    let results;
    try {
      results = await provider.classify(batch.map((b) => b.text));
      if (!Array.isArray(results) || results.length !== batch.length) throw new Error("provider returned the wrong number of results");
    } catch {
      for (const b of batch) {
        await tx
          .update(moderationItems)
          .set({ attempts: b.attempts + 1, status: b.attempts + 1 >= MAX_MODERATION_ATTEMPTS ? "error" : "pending" })
          .where(eq(moderationItems.id, b.id));
      }
      return { checked: 0, flagged: 0, failed: batch.length };
    }
    let flagged = 0;
    for (const [i, b] of batch.entries()) {
      const r = results[i]!;
      await tx
        .update(moderationItems)
        .set({ status: r.flagged ? "flagged" : "clean", categories: r.categories, checkedAt: now, attempts: b.attempts + 1 })
        .where(eq(moderationItems.id, b.id));
      if (r.flagged) {
        flagged++;
        flaggedItems.push({ id: b.id, kind: b.kind, ref: b.ref, authorId: b.authorId, categories: r.categories });
      }
    }
    return { checked: batch.length, flagged, failed: 0 };
  });
  // Hooks run after commit (hide the message, open a staff case).
  for (const f of flaggedItems) await opts.onFlagged?.(f);
  return outcome;
}
