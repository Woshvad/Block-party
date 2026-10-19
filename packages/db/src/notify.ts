import {
  ALERT_KINDS,
  addDays,
  cityDay,
  nextBell,
  streakView,
  type AlertKind,
  CREW_POST_KINDS,
  type CrewPostKind,
  type DailyTopic,
  FAREWELL,
  NEVER_SAY,
  NOTIFY,
  type NotifyKind,
  afterQuietHours,
  chooseDailyTemplate,
  chooseTemplate,
  inQuietHours,
  isTimeZone,
  localParts,
  render,
} from "@bp/core";
import { and, asc, desc, eq, gt, gte, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "./client";
import { awayShiftReady } from "./economy";
import { myMakeGoods } from "./make-goods";
import { crewBotMutes, crewBotPosts, crewMembers, identities, notificationPrefs, notifications, playSessions, residents, shifts, streaks } from "./schema";

export class NotifyError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "NOT_ALLOWED",
    message: string,
  ) {
    super(message);
    this.name = "NotifyError";
  }
}

// Delivery: Telegram bot messages now, home-screen push later. The id lets
// the message carry a button that opens the city and marks it opened.
export interface NotificationSender {
  send(userId: string, text: string, notificationId?: string): Promise<"sent" | "no_channel" | "error">;
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

// The opt-in kinds (every alert, and "Bell in 2h") need switching on; the
// daily ping doesn't.
function switchedOn(p: Prefs, kind: string): boolean {
  if ((ALERT_KINDS as readonly string[]).includes(kind)) return p.alerts.includes(kind as AlertKind);
  if (kind === "bell_2h") return p.bell2h;
  return true;
}

// Queue a ping. Opt-in kinds go nowhere unless switched on; anything due in
// quiet hours waits until they end. With a ref, it's queued once per resident,
// kind and ref, whoever asks how often (null for the repeats). With expiresAt,
// it's never sent after then, and not queued at all if quiet hours would hold
// it that long.
export async function notify(
  db: Db,
  userId: string,
  kind: NotifyKind,
  values: Record<string, string | number> = {},
  opts: { now?: Date; ref?: string; expiresAt?: Date } = {},
) {
  const now = opts.now ?? new Date();
  const p = await getPrefs(db, userId);
  if (p.pushOff || !switchedOn(p, kind)) return null;
  const scheduledFor = afterQuietHours(now, p.timeZone, p.quietStart, p.quietEnd);
  if (opts.expiresAt && scheduledFor >= opts.expiresAt) return null;
  const [row] = await db
    .insert(notifications)
    .values({ userId, kind, values, scheduledFor, createdAt: now, ref: opts.ref ?? null, expiresAt: opts.expiresAt ?? null })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The bell that started today's city day.
const lastBell = (now: Date) => new Date(nextBell(now).getTime() - 86_400_000);

// Whether they've been in the city (a session, or a heartbeat in one) since then.
async function seenSince(tx: Db, userId: string, at: Date): Promise<boolean> {
  const [s] = await tx
    .select({ id: playSessions.id })
    .from(playSessions)
    .where(and(eq(playSessions.userId, userId), gte(playSessions.lastSeenAt, at)))
    .limit(1);
  return !!s;
}

// Whether a queued alert is still news as it's about to go out: a Mod Shift
// nobody has collected yet, or an away shift that's still theirs to take
// today and that they haven't been in to see since the bell. Everything else
// stays due until it's sent.
async function stillDue(tx: Db, n: typeof notifications.$inferSelect, now: Date): Promise<boolean> {
  if (n.kind === "shift_done" && n.ref !== null) {
    if (!UUID.test(n.ref)) return false;
    const [s] = await tx.select({ collectedTx: shifts.collectedTx }).from(shifts).where(and(eq(shifts.id, n.ref), eq(shifts.userId, n.userId)));
    return !!s && !s.collectedTx;
  }
  if (n.kind === "away_shift_ready" && n.ref !== null) {
    return n.ref === cityDay(now) && !(await seenSince(tx, n.userId, lastBell(now))) && (await awayShiftReady(tx, n.userId, { now }));
  }
  return true;
}

// What the daily ping can mention, worked out as it goes out so it never talks
// about something already done: a make-good they can still collect, and
// today's clue while they haven't searched for it.
async function dailyTopics(tx: Db, userId: string, now: Date): Promise<DailyTopic[]> {
  const topics: DailyTopic[] = [];
  if ((await myMakeGoods(tx, userId, { now })).length) topics.push("make_good");
  const [r] = await tx
    .select({ searched: sql<boolean>`EXISTS (SELECT 1 FROM hunt_searches h WHERE h.user_id = ${userId} AND h.day = ${cityDay(now)})` })
    .from(residents)
    .where(eq(residents.userId, userId));
  if (r && !r.searched) topics.push("clue");
  return topics;
}

// Sends what's due, re-checking every limit at send time under a per-resident
// lock (two dispatchers can never both squeeze under the cap).
//
// Each push is claimed before it goes out: the limits are checked, the wording
// chosen and the row marked sent (reason "sending") in one transaction, and
// only once that has committed is the message sent. So a lost commit can never
// send a push twice, and no lock is held while Telegram answers. A push whose
// answer never comes back (the Worker died mid-send) keeps reason "sending":
// it counts as sent for the limits and is never sent again.
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
    const claim = await db.transaction(async (tx) => {
      const [n] = await tx.select().from(notifications).where(and(eq(notifications.id, id), eq(notifications.status, "queued"))).for("no key update", { skipLocked: true });
      if (!n) return null;
      await tx.execute(sql`SELECT 1 FROM users WHERE id = ${n.userId} FOR NO KEY UPDATE`);
      const suppress = async (reason: string) => {
        await tx.update(notifications).set({ status: "suppressed", reason }).where(eq(notifications.id, n.id));
        return "suppressed" as const;
      };
      const p = await getPrefs(tx, n.userId);
      if (p.pushOff) return suppress("push_off");
      if (!switchedOn(p, n.kind)) return suppress("switched_off"); // since it was queued
      // Stale counts from when it was due, so a long quiet window doesn't kill it.
      if (now.getTime() - n.scheduledFor.getTime() > NOTIFY.staleAfterHours * 3_600_000) return suppress("stale");
      if (n.expiresAt && now >= n.expiresAt) return suppress("expired");
      const local = localParts(now, p.timeZone);
      // Prefs may have changed since it was queued: quiet hours are re-checked now.
      if (inQuietHours(local.hour, p.quietStart, p.quietEnd)) {
        await tx.update(notifications).set({ scheduledFor: afterQuietHours(now, p.timeZone, p.quietStart, p.quietEnd) }).where(eq(notifications.id, n.id));
        return "deferred" as const;
      }
      // Never about something they've already done or seen (the shift
      // collected, or the city opened, before the push could go out).
      if (!(await stillDue(tx, n, now))) return suppress("done");
      const localDay = local.day;

      // "back": they were playing at some point in the few hours after it was
      // sent (a new session or a heartbeat), which counts as opening it even if
      // they came in some other way than the push's button. (Spelled out: in a
      // one-table select drizzle writes columns unqualified, and inside the
      // subquery "user_id" would then be the session's own, so anyone's play
      // counted.)
      const sentRecent = await tx
        .select({
          template: notifications.template,
          sentAt: notifications.sentAt,
          openedAt: notifications.openedAt,
          localDay: notifications.localDay,
          text: notifications.text,
          back: sql<boolean>`EXISTS (SELECT 1 FROM play_sessions s WHERE s.user_id = notifications.user_id AND s.last_seen_at >= notifications.sent_at AND s.started_at <= notifications.sent_at + make_interval(hours => ${NOTIFY.backWithinHours}))`,
        })
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
        if (s.openedAt || s.back) break;
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
      const seed = parseInt(n.id.slice(0, 8), 16);
      const template =
        n.kind === "daily" ? chooseDailyTemplate(await dailyTopics(tx, n.userId, now), used, now.getTime(), seed, n.values) : chooseTemplate(n.kind as NotifyKind, used, now.getTime(), seed, n.values);
      if (!template) return suppress("missing_values"); // never "@ faded your call"
      let text = render(template, n.values);
      if (farewell) text = `${text} ${FAREWELL}`;
      // Values (handles) can't smuggle in money talk, not even as buy_now or usdc-drop.
      if (NEVER_SAY.test(text.replace(FAREWELL, "").replace(/[_\-.]+/g, " "))) return suppress("unsafe_text");

      await tx.update(notifications).set({ status: "sent", reason: "sending", template, text, localDay, sentAt: now }).where(eq(notifications.id, n.id));
      return { userId: n.userId, text, attempts: n.attempts };
    });
    if (!claim) continue;
    if (typeof claim === "string") {
      tally[claim]++;
      continue;
    }

    const result = await sender.send(claim.userId, claim.text, id);
    // Not sent after all: the claim is undone, so it no longer counts.
    const unsent = { sentAt: null, template: null, text: null, localDay: null };
    if (result === "sent") {
      await db.update(notifications).set({ reason: null }).where(eq(notifications.id, id));
      tally.sent++;
    } else if (result === "no_channel") {
      await db.update(notifications).set({ status: "suppressed", reason: "no_channel", ...unsent }).where(eq(notifications.id, id));
      tally.suppressed++;
    } else {
      const attempts = claim.attempts + 1;
      // Back off 5, then 10 minutes; the third failure is final.
      await db
        .update(notifications)
        .set({
          ...unsent,
          attempts,
          scheduledFor: new Date(now.getTime() + attempts * 5 * 60_000),
          ...(attempts >= 3 ? { status: "failed" as const, reason: "send_failed" } : { status: "queued" as const, reason: null }),
        })
        .where(eq(notifications.id, id));
      tally[attempts >= 3 ? "failed" : "retry"]++;
    }
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

// --- Alerts the cron raises ----------------------------------------------------------

// A scheduler's clock and page size: what it was given, or the defaults; junk
// is refused.
function clockOf(opts: unknown): Date {
  const now = (opts as { now?: unknown } | null | undefined)?.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new NotifyError("INVALID_INPUT", "bad time");
  return now;
}
function sizeOf(n: unknown, fallback: number): number {
  if (n === undefined) return fallback;
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 5000) throw new NotifyError("INVALID_INPUT", "a page is 1 to 5000 rows");
  return n as number;
}

// "Your Mod Shift is done", every minute: each Mod Shift whose time ran out in
// the last hour and that nobody has collected, for residents who switched the
// alert on. The shift's id is the push's ref, so overlapping crons queue it
// once, and one collected before the push goes out is dropped at send time.
export async function queueShiftPings(db: Db, opts: { now?: Date; batch?: number } = {}) {
  const now = clockOf(opts);
  const batch = sizeOf(opts?.batch, 500);
  const due = await db
    .select({ id: shifts.id, userId: shifts.userId })
    .from(shifts)
    .innerJoin(notificationPrefs, eq(notificationPrefs.userId, shifts.userId))
    .where(
      and(
        eq(shifts.kind, "active"),
        isNull(shifts.collectedTx),
        lte(shifts.endsAt, now),
        gt(shifts.endsAt, new Date(now.getTime() - NOTIFY.shiftPingWithinMinutes * 60_000)),
        // notify() decides who gets it; this only skips who won't.
        eq(notificationPrefs.pushOff, false),
        sql`'shift_done' = ANY(${notificationPrefs.alerts})`,
        sql`NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = shifts.user_id AND n.kind = 'shift_done' AND n.ref = shifts.id::text)`,
      ),
    )
    .orderBy(asc(shifts.endsAt))
    .limit(batch);
  let queued = 0;
  for (const s of due) if (await notify(db, s.userId, "shift_done", {}, { now, ref: s.id })) queued++;
  return { checked: due.length, queued };
}

// "Your away shift is ready": a proven neighbour's away shift comes up at the
// bell while their last gm is under a day old, and stays theirs to take until
// that day runs out. Every 15 minutes, for residents who switched the alert on
// and haven't been in the city since the bell (they'd have seen it there). Not
// on the bell's own tick: whoever is watching it hasn't been seen since yet
// (activity is written at most once a minute), so it starts a quarter of an
// hour later, and the visit is checked again as it goes out. The city day is
// the ref, so it's queued once a day however the crons overlap. It isn't
// queued if quiet hours would hold it past the gm's 24 hours, and it's dropped
// at send time once taken, seen or out of reach. Paged by id.
export async function queueAwayShiftPings(db: Db, opts: { now?: Date; pageSize?: number } = {}) {
  const now = clockOf(opts);
  const pageSize = sizeOf(opts?.pageSize, 500);
  const day = cityDay(now);
  const bell = lastBell(now);
  if (now.getTime() < bell.getTime() + NOTIFY.awayPingAfterMinutes * 60_000) return { checked: 0, queued: 0 };
  let after = "00000000-0000-0000-0000-000000000000";
  let queued = 0;
  let checked = 0;
  // loop-bound: each page moves strictly past the last id seen; an empty or short page ends it.
  for (;;) {
    const page = await db.execute<{ user_id: string; said_at: string | Date }>(sql`
      SELECT p.user_id, g.said_at
      FROM notification_prefs p
      JOIN users u ON u.id = p.user_id
      JOIN daily_gm g ON g.user_id = p.user_id AND g.city_day = ${addDays(day, -1)}
      WHERE p.user_id > ${after}::uuid
        AND NOT p.push_off AND 'away_shift_ready' = ANY(p.alerts)
        AND u.proof_of_neighbour_at IS NOT NULL
        AND g.said_at > ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM play_sessions s WHERE s.user_id = p.user_id AND s.last_seen_at >= ${bell.toISOString()}::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = p.user_id AND n.kind = 'away_shift_ready' AND n.ref = ${day})
      ORDER BY p.user_id
      LIMIT ${pageSize}`);
    for (const r of page) {
      checked++;
      if (!(await awayShiftReady(db, r.user_id, { now }))) continue;
      const expiresAt = new Date(new Date(r.said_at).getTime() + 86_400_000);
      if (await notify(db, r.user_id, "away_shift_ready", {}, { now, ref: day, expiresAt })) queued++;
    }
    if (page.length < pageSize) break;
    after = page[page.length - 1]!.user_id;
  }
  return { checked, queued };
}

// "Bell in 2h", for the night owls who switched it on: queued from two hours
// before the bell (the 15-minute cron), once per resident per bell (the city
// day is the ref), and dropped if it can't go out within half an hour, when
// it would say the wrong thing. Quiet hours that would hold it past then mean
// it isn't queued at all. Any other time, this does nothing. Paged by id.
export async function queueBellPings(db: Db, opts: { now?: Date; pageSize?: number } = {}) {
  const now = clockOf(opts);
  const pageSize = sizeOf(opts?.pageSize, 500);
  const from = nextBell(now).getTime() - NOTIFY.bellPingMinutes * 60_000;
  const expiresAt = new Date(from + NOTIFY.bellPingLateMinutes * 60_000);
  if (now.getTime() < from || now >= expiresAt) return { checked: 0, queued: 0 };
  const day = cityDay(now);
  let after = "00000000-0000-0000-0000-000000000000";
  let queued = 0;
  let checked = 0;
  // loop-bound: each page moves strictly past the last id seen; an empty or short page ends it.
  for (;;) {
    const page = await db
      .select({ userId: notificationPrefs.userId })
      .from(notificationPrefs)
      .where(
        and(
          sql`${notificationPrefs.userId} > ${after}::uuid`,
          eq(notificationPrefs.bell2h, true),
          eq(notificationPrefs.pushOff, false),
          sql`NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = notification_prefs.user_id AND n.kind = 'bell_2h' AND n.ref = ${day})`,
        ),
      )
      .orderBy(asc(notificationPrefs.userId))
      .limit(pageSize);
    for (const p of page) {
      checked++;
      if (await notify(db, p.userId, "bell_2h", {}, { now, ref: day, expiresAt })) queued++;
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
