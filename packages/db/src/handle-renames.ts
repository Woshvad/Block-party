import { HANDLE_RENAME, type RandomInt, ResidentInputError, containsBlockedWord, cryptoRandomInt, handleHeldUntil, neutralHandle, renameReason, validateHandle } from "@bp/core";
import { and, eq, inArray, isNull, max, ne, sql } from "drizzle-orm";
import type { Db } from "./client";
import { enqueueModeration, isStaff } from "./safety";
import { handleNotices, handleRenames, moderationItems, reports, residents } from "./schema";

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
  | "NO_SUCH_NOTICE";

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
// from them and it's still resting: for picking a neutral handle that's free.
async function takenByOthers(tx: Db, handle: string, userId: string, now: Date) {
  const [row] = await tx.execute<{ taken: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM residents WHERE lower(handle) = lower(${handle}) AND user_id <> ${userId})
        OR EXISTS (SELECT 1 FROM handle_renames WHERE lower(old_handle) = lower(${handle}) AND user_id <> ${userId}
                   AND held_until > ${now.toISOString()}::timestamptz) AS taken`);
  return row?.taken === true;
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

      // The clock was read before this queued for the resident, so the record
      // moves just past the rename it follows if need be: it reads in order.
      const [last] = await tx.select({ at: max(handleRenames.createdAt) }).from(handleRenames).where(eq(handleRenames.userId, userId));
      const at = last?.at && last.at.getTime() >= now.getTime() ? new Date(last.at.getTime() + 1) : now;
      // The record first: the handle trigger lets the rename through only once it's there.
      const [row] = await tx
        .insert(handleRenames)
        .values({ userId, oldHandle: r.handle, newHandle: handle, staffId: me, reason, reportId, createdAt: at, heldUntil: handleHeldUntil(at) })
        .returning();
      await tx.execute(sql`SELECT set_config('bp.handle_rename', ${me}, true)`);
      // A display name taken down to the old handle shows the new one instead.
      await tx
        .update(residents)
        .set({ handle, name: sql`CASE WHEN ${residents.name} = ${r.handle} THEN ${handle} ELSE ${residents.name} END`, updatedAt: now })
        .where(eq(residents.userId, userId));
      await tx
        .insert(handleNotices)
        .values({ userId, renameId: row!.id, fromHandle: r.handle })
        .onConflictDoUpdate({
          target: handleNotices.userId,
          // Two renames before they look: they last knew the first one's old handle.
          set: { renameId: row!.id, fromHandle: sql`CASE WHEN ${handleNotices.seenAt} IS NULL THEN ${handleNotices.fromHandle} ELSE excluded.from_handle END`, seenAt: null },
        });
      // Put back to that handle before they looked (staff undoing a mistake):
      // nothing changed for them, so there's nothing to tell.
      await tx.delete(handleNotices).where(and(eq(handleNotices.userId, userId), eq(handleNotices.fromHandle, handle)));
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
      await tx.update(moderationItems).set({ reviewedAt: now, reviewedBy: me, review: "removed" }).where(inArray(moderationItems.id, open));
      if (reportId) {
        await tx
          .update(reports)
          .set({ status: "actioned", resolvedAt: now, resolvedBy: me, resolution: `Renamed @${r.handle} to @${handle}: ${reason}` })
          .where(eq(reports.id, reportId));
      }
      // A handle staff typed gets the AI check like any other; a neutral one needn't.
      if (given !== null) await enqueueModeration(tx, { kind: "resident_handle", ref: userId, authorId: me, text: handle });
      return { id: row!.id, userId, from: r.handle, to: handle, reason, at: row!.createdAt, heldUntil: row!.heldUntil, reportId };
    });
  } catch (e) {
    if (takenConstraint(e)) throw new HandleRenameError("HANDLE_TAKEN", "that handle is taken", "newHandle");
    throw e;
  }
}

// The notice a renamed resident hasn't dismissed yet, or null: what they were,
// what they are now, and the reason staff gave.
export async function handleNotice(db: Db, userId: string) {
  if (typeof userId !== "string" || !UUID.test(userId)) return null;
  const [n] = await db
    .select({ id: handleRenames.id, from: handleNotices.fromHandle, to: handleRenames.newHandle, reason: handleRenames.reason, at: handleRenames.createdAt })
    .from(handleNotices)
    .innerJoin(handleRenames, eq(handleRenames.id, handleNotices.renameId))
    .where(and(eq(handleNotices.userId, userId.toLowerCase()), isNull(handleNotices.seenAt)));
  return n ?? null;
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
