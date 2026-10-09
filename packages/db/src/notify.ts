import {
  ALERT_KINDS,
  cityDay,
  streakView,
  type AlertKind,
  CREW_POST_KINDS,
  type CrewPostKind,
  FAREWELL,
  NEVER_SAY,
  NOTIFY,
  type NotifyKind,
  afterQuietHours,
  chooseTemplate,
  inQuietHours,
  isTimeZone,
  localParts,
  render,
} from "@bp/core";
import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "./client";
import { crewBotMutes, crewBotPosts, crewMembers, identities, notificationPrefs, notifications, playSessions, streaks } from "./schema";

export class NotifyError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "NOT_ALLOWED",
    message: string,
  ) {
    super(message);
    this.name = "NotifyError";
  }
}

// Delivery: Telegram bot messages now, home-screen push later.
export interface NotificationSender {
  send(userId: string, text: string): Promise<"sent" | "no_channel" | "error">;
}

type Prefs = typeof notificationPrefs.$inferSelect;
const defaults = (userId: string): Prefs => ({
  userId,
  timeZone: "UTC",
  quietStart: NOTIFY.defaultQuietStart,
  quietEnd: NOTIFY.defaultQuietEnd,
  alerts: [],
  bell2h: false,
  pushOff: false,
  updatedAt: new Date(0),
});

export async function getPrefs(db: Db, userId: string): Promise<Prefs> {
  const [p] = await db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, userId));
  return p ?? defaults(userId);
}

export async function setPrefs(db: Db, userId: string, input: Record<string, unknown>) {
  const set: Partial<Prefs> = {};
  if (input.timeZone !== undefined) {
    if (!isTimeZone(input.timeZone)) throw new NotifyError("INVALID_INPUT", "unknown time zone");
    set.timeZone = input.timeZone;
  }
  for (const k of ["quietStart", "quietEnd"] as const) {
    if (input[k] !== undefined) {
      if (!Number.isInteger(input[k]) || (input[k] as number) < 0 || (input[k] as number) > 23) throw new NotifyError("INVALID_INPUT", `${k} is an hour, 0 to 23`);
      set[k] = input[k] as number;
    }
  }
  if (input.alerts !== undefined) {
    if (!Array.isArray(input.alerts) || !input.alerts.every((a) => (ALERT_KINDS as readonly unknown[]).includes(a))) throw new NotifyError("INVALID_INPUT", `alerts: ${ALERT_KINDS.join(", ")}`);
    set.alerts = [...new Set(input.alerts as string[])];
  }
  for (const k of ["bell2h", "pushOff"] as const) {
    if (input[k] !== undefined) {
      if (typeof input[k] !== "boolean") throw new NotifyError("INVALID_INPUT", `${k} must be true or false`);
      set[k] = input[k] as boolean;
    }
  }
  const base = await getPrefs(db, userId);
  const next = { ...base, ...set, updatedAt: new Date() };
  await db.insert(notificationPrefs).values(next).onConflictDoUpdate({ target: notificationPrefs.userId, set: { ...set, updatedAt: next.updatedAt } });
  return next;
}

// Queue a ping. Opt-in kinds go nowhere unless switched on; anything due in
// quiet hours waits until they end.
export async function notify(db: Db, userId: string, kind: NotifyKind, values: Record<string, string | number> = {}, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const p = await getPrefs(db, userId);
  if (p.pushOff) return null;
  if ((ALERT_KINDS as readonly string[]).includes(kind) && !p.alerts.includes(kind as AlertKind)) return null;
  if (kind === "bell_2h" && !p.bell2h) return null;
  const [row] = await db
    .insert(notifications)
    .values({ userId, kind, values, scheduledFor: afterQuietHours(now, p.timeZone, p.quietStart, p.quietEnd), createdAt: now })
    .returning();
  return row!;
}

// Sends what's due, re-checking every limit at send time under a per-resident
// lock (two dispatchers can never both squeeze under the cap).
export async function runNotificationBatch(db: Db, sender: NotificationSender, opts: { now?: Date; batch?: number } = {}) {
  const now = opts.now ?? new Date();
  const due = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.status, "queued"), lte(notifications.scheduledFor, now)))
    .orderBy(asc(notifications.scheduledFor))
    .limit(opts.batch ?? 100);
  const tally = { sent: 0, suppressed: 0, failed: 0, retry: 0, deferred: 0 };
  for (const { id } of due) {
    const r = await db.transaction(async (tx) => {
      const [n] = await tx.select().from(notifications).where(and(eq(notifications.id, id), eq(notifications.status, "queued"))).for("no key update", { skipLocked: true });
      if (!n) return null;
      await tx.execute(sql`SELECT 1 FROM users WHERE id = ${n.userId} FOR NO KEY UPDATE`);
      const suppress = async (reason: string) => {
        await tx.update(notifications).set({ status: "suppressed", reason }).where(eq(notifications.id, n.id));
        return "suppressed" as const;
      };
      const p = await getPrefs(tx, n.userId);
      if (p.pushOff) return suppress("push_off");
      // Stale counts from when it was due, so a long quiet window doesn't kill it.
      if (now.getTime() - n.scheduledFor.getTime() > NOTIFY.staleAfterHours * 3_600_000) return suppress("stale");
      const local = localParts(now, p.timeZone);
      // Prefs may have changed since it was queued: quiet hours are re-checked now.
      if (inQuietHours(local.hour, p.quietStart, p.quietEnd)) {
        await tx.update(notifications).set({ scheduledFor: afterQuietHours(now, p.timeZone, p.quietStart, p.quietEnd) }).where(eq(notifications.id, n.id));
        return "deferred" as const;
      }
      const localDay = local.day;

      const sentRecent = await tx
        .select({ template: notifications.template, sentAt: notifications.sentAt, openedAt: notifications.openedAt, localDay: notifications.localDay, text: notifications.text })
        .from(notifications)
        .where(and(eq(notifications.userId, n.userId), eq(notifications.status, "sent")))
        .orderBy(desc(notifications.sentAt))
        .limit(50);
      if (sentRecent.filter((s) => s.localDay === localDay).length >= NOTIFY.dailyCap) return suppress("cap");

      // After 7 ignored pushes in a row: one a week, the first with the farewell line.
      const ignoredCutoff = now.getTime() - NOTIFY.ignoredAfterHours * 3_600_000;
      let streak = 0;
      let farewellSent = false;
      for (const s of sentRecent) {
        if (s.openedAt) break;
        if (s.text?.endsWith(FAREWELL)) farewellSent = true;
        if (s.sentAt!.getTime() > ignoredCutoff) continue; // too recent to call ignored
        streak++;
      }
      let farewell = false;
      if (streak >= NOTIFY.ignoredBeforeWeekly) {
        const lastSent = sentRecent[0]?.sentAt?.getTime() ?? 0;
        if (now.getTime() - lastSent < 7 * 86_400_000) return suppress("weekly");
        farewell = !farewellSent;
      }

      const used = new Map<string, number>();
      for (const s of sentRecent) if (s.template && !used.has(s.template)) used.set(s.template, s.sentAt!.getTime());
      const template = chooseTemplate(n.kind as NotifyKind, used, now.getTime(), parseInt(n.id.slice(0, 8), 16), n.values);
      if (!template) return suppress("missing_values"); // never "@ faded your call"
      let text = render(template, n.values);
      if (farewell) text = `${text} ${FAREWELL}`;
      // Values (handles) can't smuggle in money talk, not even as buy_now or usdc-drop.
      if (NEVER_SAY.test(text.replace(FAREWELL, "").replace(/[_\-.]+/g, " "))) return suppress("unsafe_text");

      const result = await sender.send(n.userId, text);
      if (result === "no_channel") return suppress("no_channel");
      if (result === "error") {
        const attempts = n.attempts + 1;
        // Back off 5, then 10 minutes; the third failure is final.
        await tx
          .update(notifications)
          .set({ attempts, scheduledFor: new Date(now.getTime() + attempts * 5 * 60_000), ...(attempts >= 3 ? { status: "failed" as const, reason: "send_failed" } : {}) })
          .where(eq(notifications.id, n.id));
        return attempts >= 3 ? ("failed" as const) : ("retry" as const);
      }
      await tx.update(notifications).set({ status: "sent", template, text, localDay, sentAt: now }).where(eq(notifications.id, n.id));
      return "sent" as const;
    });
    if (r) tally[r]++;
  }
  return tally;
}

export async function markOpened(db: Db, userId: string, id: unknown, opts: { now?: Date } = {}) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return;
  await db
    .update(notifications)
    .set({ openedAt: opts.now ?? new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId), eq(notifications.status, "sent"), isNull(notifications.openedAt)));
}

// --- The daily ping ---------------------------------------------------------------

// The hour a resident usually starts playing, in their own time zone (from the
// last 14 days of sessions), or 18:00 if we can't tell yet.
export async function usualHour(db: Db, userId: string, tz: string, now = new Date()): Promise<number> {
  const rows = await db
    .select({ startedAt: playSessions.startedAt })
    .from(playSessions)
    .where(and(eq(playSessions.userId, userId), gte(playSessions.startedAt, new Date(now.getTime() - 14 * 86_400_000))));
  if (rows.length < 3) return 18;
  const hours = rows.map((r) => localParts(r.startedAt, tz).hour).sort((a, b) => a - b);
  return hours[Math.floor(hours.length / 2)]!;
}

// Queues today's ping for someone whose usual hour this is, only if there's a
// reason (their streak is unprotected, or something of theirs is riding).
export async function maybeQueueDaily(db: Db, userId: string, reason: { streakUnprotected: boolean; riding: boolean; streak?: number }, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  if (!reason.streakUnprotected && !reason.riding) return null;
  const p = await getPrefs(db, userId);
  if (localParts(now, p.timeZone).hour !== (await usualHour(db, userId, p.timeZone, now))) return null;
  // Locked per resident: two schedulers on the same tick queue one ping.
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);
    const [already] = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.kind, "daily"), gte(notifications.createdAt, new Date(now.getTime() - 20 * 3_600_000))));
    if (already) return null;
    return notify(tx, userId, "daily", { streak: reason.streak ?? 0 }, { now });
  });
}

// The scheduler (a cron every 15 minutes, so half-hour time zones get their
// hour too): every resident who played in the last 14 days with a live streak
// not yet played today, at their usual hour. Paged by id, so it never holds
// the whole city in memory.
export async function queueDailyPings(db: Db, opts: { now?: Date; pageSize?: number } = {}) {
  const now = opts.now ?? new Date();
  const day = cityDay(now);
  const pageSize = opts.pageSize ?? 500;
  let after = "00000000-0000-0000-0000-000000000000";
  let queued = 0;
  let checked = 0;
  // loop-bound: each page moves strictly past the last id seen; an empty or short page ends it.
  for (;;) {
    const page = await db
      .select({ userId: streaks.userId, current: streaks.current, longest: streaks.longest, lastDay: streaks.lastDay, hodlDays: streaks.hodlDays })
      .from(streaks)
      .where(
        and(
          sql`${streaks.userId} > ${after}::uuid`,
          sql`EXISTS (SELECT 1 FROM play_sessions s WHERE s.user_id = ${streaks.userId} AND s.last_seen_at >= ${new Date(now.getTime() - 14 * 86_400_000).toISOString()}::timestamptz)`,
        ),
      )
      .orderBy(asc(streaks.userId))
      .limit(pageSize);
    for (const s of page) {
      checked++;
      const v = streakView(s, day);
      if (v.streak === 0 || v.playedToday) continue; // a broken streak already reads 0
      if (await maybeQueueDaily(db, s.userId, { streakUnprotected: true, riding: false, streak: v.streak }, { now })) queued++;
    }
    if (page.length < pageSize) break;
    after = page[page.length - 1]!.userId;
  }
  return { checked, queued };
}

// --- The crew group bot ------------------------------------------------------------

export async function crewBotPostAllowed(db: Db, crewId: string, kind: CrewPostKind, cityDay: string) {
  if (!(CREW_POST_KINDS as readonly string[]).includes(kind)) throw new NotifyError("INVALID_INPUT", "unknown post kind");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM crews WHERE id = ${crewId} FOR NO KEY UPDATE`);
    const [muted] = await tx.select().from(crewBotMutes).where(and(eq(crewBotMutes.crewId, crewId), eq(crewBotMutes.kind, kind)));
    if (muted) return false;
    const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(crewBotPosts).where(and(eq(crewBotPosts.crewId, crewId), eq(crewBotPosts.cityDay, cityDay)));
    if (n!.n >= NOTIFY.crewPostsPerDay) return false;
    const [ins] = await tx.insert(crewBotPosts).values({ crewId, cityDay, kind }).onConflictDoNothing().returning();
    return !!ins; // one of each kind a day
  });
}

// Leads (and deputies) mute post types for their group.
export async function setCrewBotMutes(db: Db, actorId: string, kinds: unknown) {
  if (!Array.isArray(kinds) || !kinds.every((k) => (CREW_POST_KINDS as readonly unknown[]).includes(k))) throw new NotifyError("INVALID_INPUT", `kinds: ${CREW_POST_KINDS.join(", ")}`);
  const [m] = await db.select({ crewId: crewMembers.crewId, role: crewMembers.role }).from(crewMembers).where(and(eq(crewMembers.userId, actorId), isNull(crewMembers.leftAt)));
  if (!m || m.role === "member") throw new NotifyError("NOT_ALLOWED", "only the lead and deputies mute the bot");
  await db.transaction(async (tx) => {
    await tx.delete(crewBotMutes).where(eq(crewBotMutes.crewId, m.crewId));
    if (kinds.length) await tx.insert(crewBotMutes).values([...new Set(kinds as string[])].map((kind) => ({ crewId: m.crewId, kind })));
  });
  return { muted: [...new Set(kinds as string[])] };
}


// Where Telegram pushes go: the resident's Telegram user id doubles as the
// private chat id with the bot (they must have started the bot).
export async function telegramChatId(db: Db, userId: string): Promise<string | null> {
  const [i] = await db.select({ subject: identities.subject }).from(identities).where(and(eq(identities.userId, userId), eq(identities.provider, "telegram")));
  return i?.subject ?? null;
}
