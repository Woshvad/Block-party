import {
  type ActiveMood,
  MOOD,
  type Mood,
  type TiltSignals,
  type Trait,
  candleMood,
  cozyMinutesToClear,
  nextBell,
  playState,
  realTradePauseUntil,
  tiltTriggered,
  userAccountId,
} from "@bp/core";
import { and, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "./client";
import { burn } from "./ledger";
import { copiumCredits, copiumUses, moods, playSessions, residents } from "./schema";

export class MoodError extends Error {
  constructor(
    readonly code: "NOTHING_TO_CLEAR" | "NO_RESIDENT" | "INVALID_INPUT",
    message: string,
  ) {
    super(message);
    this.name = "MoodError";
  }
}

const MIN = 60_000;

async function lockResident(tx: Db, userId: string) {
  await tx.execute(sql`SELECT 1 FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);
}

// --- The play clock -------------------------------------------------------

// Called on every signed-in request. Writes at most once a minute per player;
// an hour since the last write starts a new session.
export async function touchActivity(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const [last] = await db
    .select()
    .from(playSessions)
    .where(eq(playSessions.userId, userId))
    .orderBy(desc(playSessions.lastSeenAt))
    .limit(1);
  if (last && now.getTime() - last.lastSeenAt.getTime() < MOOD.touchThrottleSeconds * 1000) return;
  await db.transaction(async (tx) => {
    await lockResident(tx, userId);
    const [cur] = await tx
      .select()
      .from(playSessions)
      .where(eq(playSessions.userId, userId))
      .orderBy(desc(playSessions.lastSeenAt))
      .limit(1);
    if (cur && now <= cur.lastSeenAt) return; // an older request arriving late
    if (cur && now.getTime() - cur.lastSeenAt.getTime() < MOOD.sessionGapMinutes * MIN) {
      await tx.update(playSessions).set({ lastSeenAt: now }).where(eq(playSessions.id, cur.id));
    } else {
      await tx.insert(playSessions).values({ userId, startedAt: now, lastSeenAt: now });
    }
  });
}

// --- Granting (server-side only: the bell, rooms, duels) -------------------

const defaultEnd = (mood: Mood, now: Date): Date | null => {
  if (mood === "called_it" || mood === "rekt" || mood === "tilted") return nextBell(now); // the next bell at the latest
  if (mood === "rested") return new Date(now.getTime() + MOOD.restedLastsMinutes * MIN); // a nap
  return null; // Cozy runs until an hour after the crew splits up
};

// Closes rows whose time ran out, so the "one open row per mood" rule never
// blocks the next grant.
async function closeExpired(tx: Db, userId: string, now: Date) {
  await tx
    .update(moods)
    .set({ clearedAt: sql`${moods.endsAt}`, clearedBy: "expired" })
    .where(and(eq(moods.userId, userId), isNull(moods.clearedAt), lte(moods.endsAt, now)));
}

export async function grantMood(db: Db, userId: string, mood: Mood, opts: { now?: Date; source?: Record<string, unknown> } = {}) {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    await lockResident(tx, userId);
    await closeExpired(tx, userId, now);
    const endsAt = defaultEnd(mood, now);
    const [open] = await tx.select().from(moods).where(and(eq(moods.userId, userId), eq(moods.mood, mood), isNull(moods.clearedAt)));
    if (open) {
      // Already in this mood: keep when it began (a tilt's trade pause runs
      // from its first trigger) and stretch the end if the new one is later.
      if (endsAt && open.endsAt && endsAt > open.endsAt) await tx.update(moods).set({ endsAt }).where(eq(moods.id, open.id));
    } else {
      await tx.insert(moods).values({ userId, mood, startedAt: now, endsAt, source: opts.source ?? {} });
    }
    // Every REKT comes with a free Copium.
    if (mood === "rekt") {
      await tx
        .insert(copiumCredits)
        .values({ userId, free: 1 })
        .onConflictDoUpdate({ target: copiumCredits.userId, set: { free: sql`${copiumCredits.free} + 1` } });
    }
  });
}

// The tilt triggers from calls and duels land here.
export async function maybeTilt(db: Db, userId: string, signals: TiltSignals, opts: { now?: Date } = {}) {
  if (!tiltTriggered(signals)) return false;
  await grantMood(db, userId, "tilted", { ...opts, source: { ...signals } });
  return true;
}

// The crew split up: Cozy lasts one more hour.
export async function endCozy(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  await db
    .update(moods)
    .set({ endsAt: new Date(now.getTime() + MOOD.cozyClearsAfterMinutes * MIN) })
    .where(and(eq(moods.userId, userId), eq(moods.mood, "cozy"), isNull(moods.clearedAt), isNull(moods.endsAt)));
}

// --- Reading moods --------------------------------------------------------

type Row = typeof moods.$inferSelect;

// When an hour of Cozy (30 minutes for a Copium Regular's REKT) overlapping a
// REKT or Tilted clears it, or null if it hasn't yet.
function cozyClearsAt(target: Row, cozies: Row[], traits: Trait[], now: Date): Date | null {
  const need = cozyMinutesToClear(target.mood, traits);
  if (need === null) return null;
  for (const c of cozies) {
    const from = Math.max(c.startedAt.getTime(), target.startedAt.getTime());
    const until = Math.min(c.clearedAt?.getTime() ?? Infinity, c.endsAt?.getTime() ?? Infinity, now.getTime());
    if (until - from >= need * MIN) return new Date(from + need * MIN);
  }
  return null;
}

export async function moodState(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const [r] = await db.select({ traits: residents.traits, hide: residents.hideCandleColor }).from(residents).where(eq(residents.userId, userId));
  const traits = (r?.traits ?? []) as Trait[];
  const rows = await db.select().from(moods).where(eq(moods.userId, userId)).orderBy(desc(moods.startedAt)).limit(200);
  const cozies = rows.filter((x) => x.mood === "cozy");

  // Clear REKT and Tilted that an hour of Cozy has already cleared.
  for (const row of rows) {
    if (row.clearedAt || (row.endsAt && row.endsAt <= now)) continue;
    const at = cozyClearsAt(row, cozies, traits, now);
    if (at) {
      await db.update(moods).set({ clearedAt: at, clearedBy: "cozy" }).where(and(eq(moods.id, row.id), isNull(moods.clearedAt)));
      row.clearedAt = at;
      row.clearedBy = "cozy";
    }
  }

  const live = rows.filter((x) => !x.clearedAt && (!x.endsAt || x.endsAt > now) && x.startedAt <= now);
  const active: Array<ActiveMood & { until: Date | null }> = live.map((x) => ({ mood: x.mood, since: x.startedAt, until: x.endsAt }));

  const sessions = await db.select().from(playSessions).where(eq(playSessions.userId, userId)).orderBy(desc(playSessions.lastSeenAt)).limit(2);
  const play = playState(sessions, now);
  const current = sessions[0];
  if (play.rested && current && !active.some((a) => a.mood === "rested")) {
    active.push({ mood: "rested", since: current.startedAt, until: new Date(current.startedAt.getTime() + MOOD.restedLastsMinutes * MIN) });
  }
  if (play.chartBrain && current) {
    active.push({ mood: "chart_brain", since: new Date(current.startedAt.getTime() + MOOD.chartBrainAfterMinutes * MIN), until: null });
  }

  // The trade pause runs from each tilt's start to the next bell, even if a
  // Copium or Cozy cleared the mood itself.
  const pauses = rows.filter((x) => x.mood === "tilted").map((x) => realTradePauseUntil(x.startedAt)).filter((d) => d > now);
  const pausedUntil = pauses.length ? new Date(Math.max(...pauses.map((d) => d.getTime()))) : null;
  const tilted = active.some((a) => a.mood === "tilted");
  const chartBrain = active.some((a) => a.mood === "chart_brain");
  const [credits] = await db.select().from(copiumCredits).where(eq(copiumCredits.userId, userId));

  return {
    active,
    candle: { mood: candleMood(active), color: r?.hide ? null : ("doji" as const), hideColor: r?.hide ?? false },
    tilt: {
      tilted,
      gmStakeCap: tilted ? MOOD.tiltedStakeCap : null,
      snapsAllowed: !tilted,
      sharePromptsAllowed: !tilted,
      realTradesPausedUntil: pausedUntil,
    },
    chartBrain: { hideCrowdBars: chartBrain, realityCheck: chartBrain },
    play: { sessionMinutes: Math.floor(play.sessionMinutes) },
    copium: { free: credits?.free ?? 0, price: MOOD.copiumPrice },
  };
}

// --- Copium ---------------------------------------------------------------

// Clears REKT and Tilted. Free if you have a credit from a REKT, otherwise
// 30 GM, burned. Never spent when there's nothing to clear. Retries with the
// same key return the first result.
export async function useCopium(db: Db, userId: string, idempotencyKey: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    await lockResident(tx, userId);
    const [prior] = await tx.select().from(copiumUses).where(eq(copiumUses.key, idempotencyKey));
    if (prior) {
      if (prior.userId !== userId) throw new MoodError("NOTHING_TO_CLEAR", "nothing to clear");
      return { replayed: true, paid: prior.paid, cleared: prior.cleared as Mood[] };
    }
    await closeExpired(tx, userId, now);
    const targets = await tx
      .select()
      .from(moods)
      .where(and(eq(moods.userId, userId), inArray(moods.mood, ["rekt", "tilted"]), isNull(moods.clearedAt), sql`${moods.startedAt} <= ${now.toISOString()}::timestamptz`));
    if (targets.length === 0) throw new MoodError("NOTHING_TO_CLEAR", "you're not REKT or tilted");

    const [credits] = await tx.select().from(copiumCredits).where(eq(copiumCredits.userId, userId)).for("no key update");
    let paid = 0;
    if (credits && credits.free > 0) {
      await tx.update(copiumCredits).set({ free: credits.free - 1 }).where(eq(copiumCredits.userId, userId));
    } else {
      await burn(tx, { accountId: userAccountId(userId), amount: MOOD.copiumPrice, kind: "copium", idempotencyKey: `copium:${idempotencyKey}` });
      paid = MOOD.copiumPrice;
    }
    await tx.update(moods).set({ clearedAt: now, clearedBy: "copium" }).where(inArray(moods.id, targets.map((t) => t.id)));
    const cleared = targets.map((t) => t.mood);
    await tx.insert(copiumUses).values({ key: idempotencyKey, userId, paid: paid > 0, cleared });
    return { replayed: false, paid: paid > 0, cleared };
  });
}

export async function setHideCandleColor(db: Db, userId: string, hide: unknown) {
  if (typeof hide !== "boolean") throw new MoodError("INVALID_INPUT", "hideCandleColor must be true or false");
  const [r] = await db.update(residents).set({ hideCandleColor: hide, updatedAt: new Date() }).where(eq(residents.userId, userId)).returning();
  if (!r) throw new MoodError("NO_RESIDENT", "move in first");
  return r;
}
