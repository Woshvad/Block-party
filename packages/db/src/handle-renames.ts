import { HANDLE_RENAME, type RandomInt, ResidentInputError, containsBlockedWord, cryptoRandomInt, handleHeldUntil, neutralHandle, renameAppeal, renameReason, validateHandle } from "@bp/core";
import { and, asc, desc, eq, inArray, isNull, max, ne, sql } from "drizzle-orm";
import type { Db } from "./client";
import { enqueueModeration, isStaff } from "./safety";
import { handleNotices, handleRenameAppeals, handleRenames, moderationItems, reports, residents } from "./schema";

export type HandleRenameErrorCode =
  | "NOT_STAFF"
  | "INVALID_INPUT"
  | "NOT_SELF"
  | "STAFF_HANDLE"
  | "NO_RESIDENT"
  | "HANDLE_TAKEN"
  | "HANDLE_CHANGED"
  | "MODERATED"
  | "NO_SUCH_REPORT"
  | "NO_SUCH_NOTICE"
  | "NO_SUCH_RENAME"
  | "APPEAL_CLOSED"
  | "ALREADY_APPEALED"
  | "NO_SUCH_APPEAL";

export class HandleRenameError extends Error {
  constructor(
    readonly code: HandleRenameErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "HandleRenameError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NEUTRAL_TRIES = 20;

const takenConstraint = (e: unknown) => {
  const c = (e as { cause?: { code?: string; constraint_name?: string } })?.cause ?? (e as { code?: string; constraint_name?: string });
  return c?.code === "23505" && (c.constraint_name === "residents_handle_lower" || c.constraint_name === "residents_handle_held");
};

// Whether someone other than `userId` has this handle, or had it renamed away
// from them and it's still resting (handle_resting, in the database): for
// picking a neutral handle that's free.
async function takenByOthers(tx: Db, handle: string, userId: string, now: Date) {
  const [row] = await tx.execute<{ taken: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM residents WHERE lower(handle) = lower(${handle}) AND user_id <> ${userId})
        OR handle_resting(${handle}, ${userId}, ${now.toISOString()}::timestamptz) AS taken`);
  return row?.taken === true;
}

// The rename itself, inside a transaction that holds the resident's row: the
// record, the handle, the resident's notice, and the old handle's flags off
// the staff queue. Returns the record.
async function applyRename(tx: Db, p: { userId: string; staffId: string; from: string; to: string; reason: string; reportId: string | null; appealId: string | null; now: Date }) {
  const { userId, staffId, from, to, now } = p;
  // The clock was read before this queued for the resident, so the record
  // moves just past the rename it follows if need be: it reads in order.
  const [last] = await tx.select({ at: max(handleRenames.createdAt) }).from(handleRenames).where(eq(handleRenames.userId, userId));
  const at = last?.at && last.at.getTime() >= now.getTime() ? new Date(last.at.getTime() + 1) : now;
  // The record first: the handle trigger lets the rename through only once it's there.
  const [row] = await tx
    .insert(handleRenames)
    .values({ userId, oldHandle: from, newHandle: to, staffId, reason: p.reason, reportId: p.reportId, appealId: p.appealId, createdAt: at, heldUntil: handleHeldUntil(at) })
    .returning();
  await tx.execute(sql`SELECT set_config('bp.handle_rename', ${staffId}, true)`);
  // A display name taken down to the old handle shows the new one instead.
  await tx
    .update(residents)
    .set({ handle: to, name: sql`CASE WHEN ${residents.name} = ${from} THEN ${to} ELSE ${residents.name} END`, updatedAt: at })
    .where(eq(residents.userId, userId));
  await tx
    .insert(handleNotices)
    .values({ userId, renameId: row!.id, fromHandle: from })
    .onConflictDoUpdate({
      target: handleNotices.userId,
      // Two renames before they look: they last knew the first one's old handle.
      set: { renameId: row!.id, fromHandle: sql`CASE WHEN ${handleNotices.seenAt} IS NULL THEN ${handleNotices.fromHandle} ELSE excluded.from_handle END`, seenAt: null },
    });
  // Put back to that handle before they looked (staff undoing a mistake):
  // nothing changed for them, so there's nothing to tell.
  await tx.delete(handleNotices).where(and(eq(handleNotices.userId, userId), eq(handleNotices.fromHandle, to)));
  // The old handle's flags are dealt with: they leave the staff queue. An
  // item the AI check is reading right now is skipped, not waited for: the
  // batch holds it while it waits on the provider, and may then take the
  // display name down, which needs the resident row this rename holds.
  // Its verdict is on the old handle, so a Rename from it finds them renamed.
  const open = tx
    .select({ id: moderationItems.id })
    .from(moderationItems)
    .where(and(eq(moderationItems.kind, "resident_handle"), eq(moderationItems.ref, userId), isNull(moderationItems.reviewedAt), ne(moderationItems.status, "clean")))
    .for("no key update", { skipLocked: true });
  await tx.update(moderationItems).set({ reviewedAt: now, reviewedBy: staffId, review: "removed" }).where(inArray(moderationItems.id, open));
  return row!;
}

// Staff rename a resident's @handle, usually one moderation flagged. With no
// newHandle the resident gets a neutral one ("neighbour_" and five digits).
// A given one passes the same checks as a new resident's: core's handle
// rules, free ignoring case, and staff's blocked words. The reason is the
// resident's to read, the next time they open the app.
//
// `from` is the handle staff were looking at, and it's required: if the
// resident has been renamed since (another staff member got there first),
// nothing happens, so two staff renaming at once make one rename, never two
// in a row. `reportId` closes that report as actioned.
//
// Staff can't rename themselves or another staff member. The old handle rests
// for 30 days: nobody else can take it, though staff can give it back to the
// same resident. Every rename is kept in handle_renames, which the database
// won't let anyone edit, and the handle itself changes only inside this
// transaction's switch (the trigger checks it, the staff role and the row).
// The resident can appeal it (appealRename).
export async function renameHandle(
  db: Db,
  staffId: string,
  targetUserId: unknown,
  input: { newHandle?: unknown; reason?: unknown; from?: unknown; reportId?: unknown },
  opts: { now?: Date; blockedWords?: readonly string[]; rand?: RandomInt } = {},
) {
  const now = opts.now ?? new Date();
  if (typeof staffId !== "string" || !UUID.test(staffId) || !(await isStaff(db, staffId))) throw new HandleRenameError("NOT_STAFF", "staff only");
  if (typeof targetUserId !== "string" || !UUID.test(targetUserId)) throw new HandleRenameError("NO_RESIDENT", "no such resident");
  const userId = targetUserId.toLowerCase();
  const me = staffId.toLowerCase();
  const i = input && typeof input === "object" ? input : {};
  const reason = renameReason(i.reason);
  if (reason === null) throw new HandleRenameError("INVALID_INPUT", `a reason of ${HANDLE_RENAME.reasonMinChars} to ${HANDLE_RENAME.reasonMaxChars} characters; they'll read it`, "reason");
  let given: string | null = null;
  if (i.newHandle !== undefined && i.newHandle !== null) {
    try {
      given = validateHandle(i.newHandle);
    } catch (e) {
      if (e instanceof ResidentInputError) throw new HandleRenameError("INVALID_INPUT", e.reason, "newHandle");
      throw e;
    }
    if (containsBlockedWord(given, opts.blockedWords)) throw new HandleRenameError("MODERATED", "that word isn't allowed here", "newHandle");
  }
  const from = typeof i.from === "string" && i.from.length <= 40 ? i.from.trim().replace(/^@/, "").toLowerCase() : "";
  if (!from) throw new HandleRenameError("INVALID_INPUT", "from is the handle you're renaming", "from");
  let reportId: string | null = null;
  if (i.reportId !== undefined && i.reportId !== null) {
    if (typeof i.reportId !== "string" || !UUID.test(i.reportId)) throw new HandleRenameError("NO_SUCH_REPORT", "no such report");
    reportId = i.reportId.toLowerCase();
  }
  if (userId === me) throw new HandleRenameError("NOT_SELF", "you can't rename yourself");
  if (await isStaff(db, userId)) throw new HandleRenameError("STAFF_HANDLE", "staff handles can't be renamed");

  try {
    return await db.transaction(async (tx) => {
      // The resident first, as everywhere: two staff renaming them at once
      // queue here, and the second sees the first's new handle.
      const [r] = await tx.select({ handle: residents.handle }).from(residents).where(eq(residents.userId, userId)).for("no key update");
      if (!r) throw new HandleRenameError("NO_RESIDENT", "no such resident");
      if (from !== r.handle.toLowerCase()) throw new HandleRenameError("HANDLE_CHANGED", `they've been renamed already: they're @${r.handle} now`);
      if (reportId) {
        const [rep] = await tx.select({ status: reports.status, target: reports.targetUserId }).from(reports).where(eq(reports.id, reportId)).for("no key update");
        if (!rep || rep.status !== "open" || rep.target !== userId) throw new HandleRenameError("NO_SUCH_REPORT", "no open report about them");
      }

      let handle: string | null = null;
      if (given !== null) {
        if (given.toLowerCase() === r.handle.toLowerCase()) throw new HandleRenameError("INVALID_INPUT", "that's already their handle", "newHandle");
        // Whether it's free is the database's answer (the unique index, and the
        // trigger for a resting handle), turned into HANDLE_TAKEN below.
        handle = given;
      } else {
        for (let n = 0; n < NEUTRAL_TRIES && handle === null; n++) {
          const h = neutralHandle(opts.rand ?? cryptoRandomInt);
          if (h.toLowerCase() !== r.handle.toLowerCase() && !containsBlockedWord(h, opts.blockedWords) && !(await takenByOthers(tx, h, userId, now))) handle = h;
        }
        if (handle === null) throw new HandleRenameError("HANDLE_TAKEN", "couldn't find a free neutral handle; give one instead", "newHandle");
      }

      const row = await applyRename(tx, { userId, staffId: me, from: r.handle, to: handle, reason, reportId, appealId: null, now });
      if (reportId) {
        await tx
          .update(reports)
          .set({ status: "actioned", resolvedAt: now, resolvedBy: me, resolution: `Renamed @${r.handle} to @${handle}: ${reason}` })
          .where(eq(reports.id, reportId));
      }
      // A handle staff typed gets the AI check like any other; a neutral one needn't.
      if (given !== null) await enqueueModeration(tx, { kind: "resident_handle", ref: userId, authorId: me, text: handle });
      return { id: row.id, userId, from: r.handle, to: handle, reason, at: row.createdAt, heldUntil: row.heldUntil, reportId };
    });
  } catch (e) {
    if (takenConstraint(e)) throw new HandleRenameError("HANDLE_TAKEN", "that handle is taken", "newHandle");
    throw e;
  }
}

// The notice a renamed resident hasn't dismissed yet, or null: what they were,
// what they are now, the reason staff gave, and whether they can appeal it
// (not when it gave their handle back after an appeal).
export async function handleNotice(db: Db, userId: string) {
  if (typeof userId !== "string" || !UUID.test(userId)) return null;
  const [n] = await db
    .select({ id: handleRenames.id, from: handleNotices.fromHandle, to: handleRenames.newHandle, reason: handleRenames.reason, at: handleRenames.createdAt, appealId: handleRenames.appealId })
    .from(handleNotices)
    .innerJoin(handleRenames, eq(handleRenames.id, handleNotices.renameId))
    .where(and(eq(handleNotices.userId, userId.toLowerCase()), isNull(handleNotices.seenAt)));
  if (!n) return null;
  const { appealId, ...notice } = n;
  return { ...notice, appealable: appealId === null };
}

// OK on the notice. Only the rename it showed: one made since stays up. A
// second OK (two devices) is fine and keeps the first time.
export async function seeHandleNotice(db: Db, userId: string, renameId: unknown, opts: { now?: Date } = {}) {
  if (typeof userId !== "string" || !UUID.test(userId) || typeof renameId !== "string" || !UUID.test(renameId)) throw new HandleRenameError("NO_SUCH_NOTICE", "no such notice");
  const [n] = await db
    .update(handleNotices)
    .set({ seenAt: sql`COALESCE(${handleNotices.seenAt}, ${(opts.now ?? new Date()).toISOString()}::timestamptz)` })
    .where(and(eq(handleNotices.userId, userId.toLowerCase()), eq(handleNotices.renameId, renameId.toLowerCase())))
    .returning({ seenAt: handleNotices.seenAt });
  if (!n) throw new HandleRenameError("NO_SUCH_NOTICE", "no such notice");
  return { ok: true as const };
}

// --- Appeals ------------------------------------------------------------------

// Every staff action can be appealed (the plan), a rename too. The resident
// appeals the rename that gave them the handle they have now, once, while its
// old handle rests (30 days); the old handle keeps resting while the appeal is
// open, so overturning it can always give that back. Staff other than the one
// who renamed them decide, with a note the resident reads.

// The rename that gave them their handle, for Me: what it was, why, and the
// appeal, while it can still be appealed or one is open; else null. Not a
// rename that gave their handle back after an appeal: the notice said so.
export async function myHandleRename(db: Db, userId: string, opts: { now?: Date } = {}) {
  if (typeof userId !== "string" || !UUID.test(userId)) return null;
  const now = opts.now ?? new Date();
  const [r] = await db
    .select({ rename: handleRenames, appeal: handleRenameAppeals })
    .from(handleRenames)
    .leftJoin(handleRenameAppeals, eq(handleRenameAppeals.renameId, handleRenames.id))
    .where(eq(handleRenames.userId, userId.toLowerCase()))
    .orderBy(desc(handleRenames.createdAt))
    .limit(1);
  if (!r || r.rename.appealId !== null) return null;
  const { rename, appeal } = r;
  if (rename.heldUntil <= now && appeal?.status !== "open") return null;
  return {
    id: rename.id,
    from: rename.oldHandle,
    to: rename.newHandle,
    reason: rename.reason,
    at: rename.createdAt,
    appealUntil: rename.heldUntil,
    appeal: appeal ? { status: appeal.status, at: appeal.createdAt, note: appeal.decisionNote, decidedAt: appeal.decidedAt } : null,
  };
}

// A resident's appeal against their rename, in their own words. It counts as
// seeing the rename's notice.
export async function appealRename(db: Db, userId: string, renameId: unknown, text: unknown, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  if (typeof userId !== "string" || !UUID.test(userId) || typeof renameId !== "string" || !UUID.test(renameId)) throw new HandleRenameError("NO_SUCH_RENAME", "no such rename");
  const body = renameAppeal(text);
  if (body === null) throw new HandleRenameError("INVALID_INPUT", `an appeal of ${HANDLE_RENAME.appealMinChars} to ${HANDLE_RENAME.appealMaxChars} characters`, "text");
  const me = userId.toLowerCase();
  const id = renameId.toLowerCase();
  return db.transaction(async (tx) => {
    // The resident first, as everywhere: no rename lands while this checks
    // it's appealing the latest.
    const [r] = await tx.select({ handle: residents.handle }).from(residents).where(eq(residents.userId, me)).for("no key update");
    const [rn] = await tx.select().from(handleRenames).where(and(eq(handleRenames.id, id), eq(handleRenames.userId, me)));
    if (!r || !rn || rn.appealId !== null) throw new HandleRenameError("NO_SUCH_RENAME", "no rename of yours to appeal there");
    const [latest] = await tx.select({ id: handleRenames.id }).from(handleRenames).where(eq(handleRenames.userId, me)).orderBy(desc(handleRenames.createdAt)).limit(1);
    if (latest!.id !== rn.id) throw new HandleRenameError("HANDLE_CHANGED", `you've been renamed again since: you're @${r.handle} now, so appeal that one`);
    if (rn.heldUntil <= now) throw new HandleRenameError("APPEAL_CLOSED", `appeals close ${HANDLE_RENAME.holdDays} days after a rename`);
    const [a] = await tx.insert(handleRenameAppeals).values({ renameId: rn.id, userId: me, text: body, createdAt: now }).onConflictDoNothing({ target: handleRenameAppeals.renameId }).returning();
    if (!a) throw new HandleRenameError("ALREADY_APPEALED", "you've already appealed this one");
    await tx
      .update(handleNotices)
      .set({ seenAt: sql`COALESCE(${handleNotices.seenAt}, ${now.toISOString()}::timestamptz)` })
      .where(and(eq(handleNotices.userId, me), eq(handleNotices.renameId, rn.id)));
    return a;
  });
}

// Open rename appeals for staff, oldest first, with the rename they're about.
// An appeal against your own rename goes to someone else.
export async function openRenameAppeals(db: Db, staffId: string) {
  if (typeof staffId !== "string" || !UUID.test(staffId) || !(await isStaff(db, staffId))) throw new HandleRenameError("NOT_STAFF", "staff only");
  return db
    .select({
      id: handleRenameAppeals.id,
      renameId: handleRenames.id,
      userId: handleRenameAppeals.userId,
      text: handleRenameAppeals.text,
      createdAt: handleRenameAppeals.createdAt,
      from: handleRenames.oldHandle,
      to: handleRenames.newHandle,
      reason: handleRenames.reason,
      renamedBy: handleRenames.staffId,
      renamedAt: handleRenames.createdAt,
    })
    .from(handleRenameAppeals)
    .innerJoin(handleRenames, eq(handleRenames.id, handleRenameAppeals.renameId))
    .where(and(eq(handleRenameAppeals.status, "open"), ne(handleRenames.staffId, staffId.toLowerCase())))
    .orderBy(asc(handleRenameAppeals.createdAt))
    .limit(200);
}

// Staff decide an appeal: overturn gives the old handle back (a rename by the
// decider, the note its reason, which the resident reads in a new notice);
// uphold keeps the new one, and the resident reads the note in Me.
export async function decideRenameAppeal(db: Db, staffId: string, appealId: unknown, input: { overturn?: unknown; note?: unknown }, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  if (typeof staffId !== "string" || !UUID.test(staffId) || !(await isStaff(db, staffId))) throw new HandleRenameError("NOT_STAFF", "staff only");
  if (typeof appealId !== "string" || !UUID.test(appealId)) throw new HandleRenameError("NO_SUCH_APPEAL", "no such appeal");
  const i = input && typeof input === "object" ? input : {};
  if (typeof i.overturn !== "boolean") throw new HandleRenameError("INVALID_INPUT", "overturn must be true or false", "overturn");
  const overturn = i.overturn;
  const note = renameReason(i.note);
  if (note === null) throw new HandleRenameError("INVALID_INPUT", `a note of ${HANDLE_RENAME.reasonMinChars} to ${HANDLE_RENAME.reasonMaxChars} characters; they'll read it`, "note");
  const me = staffId.toLowerCase();
  const id = appealId.toLowerCase();
  const [peek] = await db.select({ userId: handleRenameAppeals.userId }).from(handleRenameAppeals).where(eq(handleRenameAppeals.id, id));
  if (!peek) throw new HandleRenameError("NO_SUCH_APPEAL", "no such appeal");
  try {
    return await db.transaction(async (tx) => {
      // The resident first, as everywhere, then the appeal.
      const [r] = await tx.select({ handle: residents.handle }).from(residents).where(eq(residents.userId, peek.userId)).for("no key update");
      const [a] = await tx.select().from(handleRenameAppeals).where(eq(handleRenameAppeals.id, id)).for("no key update");
      if (!r || !a || a.status !== "open") throw new HandleRenameError("NO_SUCH_APPEAL", "no open appeal");
      const [rn] = await tx.select().from(handleRenames).where(eq(handleRenames.id, a.renameId));
      // Nobody decides their own case.
      if (rn!.staffId === me) throw new HandleRenameError("NOT_STAFF", "another staff member must decide this appeal");
      let rename = null;
      if (overturn) {
        // Renamed again since (by staff, before this was decided): that one stands until it's dealt with.
        if (r.handle !== rn!.newHandle) throw new HandleRenameError("HANDLE_CHANGED", `they've been renamed again since: they're @${r.handle} now`);
        const row = await applyRename(tx, { userId: a.userId, staffId: me, from: r.handle, to: rn!.oldHandle, reason: note, reportId: null, appealId: a.id, now });
        rename = { id: row.id, userId: a.userId, from: row.oldHandle, to: row.newHandle, reason: note, at: row.createdAt, heldUntil: row.heldUntil, reportId: null };
      }
      await tx
        .update(handleRenameAppeals)
        .set({ status: overturn ? "overturned" : "upheld", decidedBy: me, decidedAt: now, decisionNote: note })
        .where(eq(handleRenameAppeals.id, a.id));
      return { overturned: overturn, rename };
    });
  } catch (e) {
    if (takenConstraint(e)) throw new HandleRenameError("HANDLE_TAKEN", "someone else has that handle now");
    throw e;
  }
}
