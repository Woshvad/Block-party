import { NAP, napsOn } from "@bp/core";
import { and, eq, lte } from "drizzle-orm";
import type { Db } from "./client";
import type { WhereCheck } from "./chat";
import { grantMood } from "./moods";
import { notify } from "./notify";
import { items, longActions, placements } from "./schema";

export class LifeError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "NOT_HOME" | "CANT_NAP_THERE" | "BUSY" | "NOTHING_RUNNING",
    message: string,
  ) {
    super(message);
    this.name = "LifeError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUnique = (e: unknown) => ((e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code) === "23505";

// A nap: in your own home, on a Rested piece you've placed there. It runs
// for real minutes whether you stay or log off.
export async function startNap(db: Db, userId: string, itemId: unknown, where: WhereCheck, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  if (typeof itemId !== "string" || !UUID.test(itemId)) throw new LifeError("INVALID_INPUT", "which bed?");
  if ((await where(userId, `home:${userId}`)) === null) throw new LifeError("NOT_HOME", "naps are in your own home");
  const [it] = await db
    .select({ pieceId: items.pieceId })
    .from(items)
    .innerJoin(placements, eq(placements.itemId, items.id))
    .where(and(eq(items.id, itemId), eq(items.ownerUserId, userId)));
  if (!it || !napsOn(it.pieceId)) throw new LifeError("CANT_NAP_THERE", "you need a bed (or a hammock) placed at home");
  await finishDueActions(db, { now, userId });
  try {
    const [row] = await db
      .insert(longActions)
      .values({ userId, kind: "nap", itemId, startedAt: now, endsAt: new Date(now.getTime() + NAP.minutes * 60_000) })
      .returning();
    return row!;
  } catch (e) {
    if (isUnique(e)) throw new LifeError("BUSY", "you're already in the middle of something");
    throw e;
  }
}

// Wake up early: no Rested.
export async function cancelLongAction(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  await finishDueActions(db, { now, userId });
  const [r] = await db
    .update(longActions)
    .set({ status: "cancelled", finishedAt: now })
    .where(and(eq(longActions.userId, userId), eq(longActions.status, "running")))
    .returning({ id: longActions.id });
  if (!r) throw new LifeError("NOTHING_RUNNING", "nothing to stop");
  return { cancelled: r.id };
}

// Finishes every long action that's due, each exactly once: the mood lands as
// of when it ended, and the opt-in ping is queued. Run by the cron, and for one
// resident whenever they look.
export async function finishDueActions(db: Db, opts: { now?: Date; userId?: string; batch?: number } = {}) {
  const now = opts.now ?? new Date();
  const due = await db
    .select({ id: longActions.id })
    .from(longActions)
    .where(and(eq(longActions.status, "running"), lte(longActions.endsAt, now), opts.userId ? eq(longActions.userId, opts.userId) : undefined))
    .limit(opts.batch ?? 500);
  let finished = 0;
  for (const { id } of due) {
    const done = await db.transaction(async (tx) => {
      const [a] = await tx
        .select()
        .from(longActions)
        .where(and(eq(longActions.id, id), eq(longActions.status, "running")))
        .for("no key update", { skipLocked: true });
      if (!a) return false;
      await tx.update(longActions).set({ status: "done", finishedAt: a.endsAt }).where(eq(longActions.id, a.id));
      if (a.kind === "nap") {
        await grantMood(tx, a.userId, "rested", { now: a.endsAt, source: { nap: a.id } });
        await notify(tx, a.userId, "nap_done", {}, { now });
      }
      return true;
    });
    if (done) finished++;
  }
  return { finished };
}

export async function myLongAction(db: Db, userId: string, opts: { now?: Date } = {}) {
  await finishDueActions(db, { ...opts, userId });
  const [a] = await db
    .select({ id: longActions.id, kind: longActions.kind, startedAt: longActions.startedAt, endsAt: longActions.endsAt })
    .from(longActions)
    .where(and(eq(longActions.userId, userId), eq(longActions.status, "running")));
  return a ?? null;
}

