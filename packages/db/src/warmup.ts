import {
  WARMUP,
  type WarmupFeed,
  type WarmupResult,
  type WarmupWindow,
  entryClosesAt,
  isWarmupSide,
  isWindow,
  nextWindowAt,
  takingCalls,
  warmupCredit,
  warmupEligibility,
  warmupReel,
  warmupStamp,
  windowStart,
} from "@bp/core";
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "./client";
import { grantMood } from "./moods";
import { notify } from "./notify";
import { users, warmupCalls, warmupPolls, warmupWindows } from "./schema";

// The 15-minute warm-up: a newcomer's free UP or DOWN call on Polymarket's
// rolling Bitcoin windows, taken only in a window's first 2 minutes, one a
// day for their first 3 days. Nothing here touches the ledger or Aura: the
// only things a warm-up ever gives are a mood (CALLED IT, or REKT with its
// free Copium, both through the moods brick) and an opt-in push. The API
// keeps all of it behind FEATURE_WARMUP.

export class WarmupError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "UNKNOWN_USER" | "NOT_NEW" | "ALREADY_TODAY" | "ALREADY_IN" | "WINDOW_CLOSED" | "FEED_DOWN",
    message: string,
  ) {
    super(message);
    this.name = "WarmupError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hhmm = (d: Date) => d.toISOString().slice(11, 16);
// Which unique constraint refused an insert, if one did (Drizzle wraps the error).
const uniqueRefusal = (e: unknown) => {
  const pg = ((e as { cause?: unknown })?.cause ?? e) as { code?: string; constraint_name?: string };
  return pg?.code === "23505" ? (pg.constraint_name ?? "") : null;
};

type Opts = { now?: Date; source?: string };

// The clock, and the feed the warm-up is on (the API's, by its source);
// without a source the feed is down.
function parse(userId: unknown, opts: unknown) {
  if (typeof userId !== "string" || !UUID.test(userId)) throw new WarmupError("INVALID_INPUT", "who's asking?");
  const o = opts ?? {};
  if (typeof o !== "object" || Array.isArray(o)) throw new WarmupError("INVALID_INPUT", "bad options");
  const { now = new Date(), source } = o as Opts;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new WarmupError("INVALID_INPUT", "bad time");
  if (source !== undefined && (typeof source !== "string" || source.length === 0 || source.length > 100)) throw new WarmupError("INVALID_INPUT", "bad feed");
  return { userId: userId.toLowerCase(), now, source: source ?? null };
}

// The feed is live while its latest good poll is under 3 minutes old (never
// one stamped later than now).
async function feedLive(db: Db, source: string, now: Date) {
  const [last] = await db
    .select({ at: warmupPolls.at })
    .from(warmupPolls)
    .where(and(eq(warmupPolls.source, source), eq(warmupPolls.ok, true), lte(warmupPolls.at, now)))
    .orderBy(desc(warmupPolls.at))
    .limit(1);
  return !!last && now.getTime() - last.at.getTime() <= WARMUP.feedPausedAfterSeconds * 1000;
}

// --- The feed -----------------------------------------------------------------

const validWindow = (w: WarmupWindow) =>
  !!w &&
  typeof w.externalId === "string" &&
  w.externalId.length > 0 &&
  w.externalId.length <= 200 &&
  typeof w.question === "string" &&
  w.question.length > 0 &&
  w.startsAt instanceof Date &&
  w.endsAt instanceof Date &&
  isWindow(w.startsAt, w.endsAt) &&
  typeof w.open === "boolean";

const validResult = (r: WarmupResult) =>
  !!r &&
  typeof r.externalId === "string" &&
  r.externalId.length > 0 &&
  r.externalId.length <= 200 &&
  typeof r.voided === "boolean" &&
  (r.outcome === null || isWarmupSide(r.outcome)) &&
  !(r.voided && r.outcome !== null);

// One poll of the warm-up feed: store this window and the next, settle the
// ended windows whose results are in, then stamp their calls. One poller at
// a time (an advisory lock); a second just skips. A failed fetch, or one
// that lists no window, is recorded as failed, so the warm-up reads "feed
// down" until a good one. Results still count when no window is listed, and
// calls on windows already resolved are stamped whatever the feed did.
export async function pollWarmup(db: Db, feed: WarmupFeed, opts: { now?: Date } = {}) {
  // Checked first: the source goes into a query, and postgres.js can stall
  // the pool on an undefined parameter.
  if (typeof feed?.source !== "string" || feed.source.length === 0 || feed.source.length > 100 || typeof feed.fetch !== "function") throw new TypeError("pollWarmup needs a warm-up feed");
  const now = opts?.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("pollWarmup needs a date");
  const source = feed.source;
  // Ended windows someone called that are still waiting on a result, newest
  // first, so a fresh result is never stuck behind one that never resolves.
  // (Spelled out: in a one-table select drizzle writes columns unqualified.)
  const pending = await db
    .select({ externalId: warmupWindows.externalId })
    .from(warmupWindows)
    .where(
      and(
        eq(warmupWindows.source, source),
        eq(warmupWindows.status, "open"),
        lte(warmupWindows.endsAt, now),
        sql`EXISTS (SELECT 1 FROM warmup_calls c WHERE c.window_id = warmup_windows.id)`,
      ),
    )
    .orderBy(desc(warmupWindows.endsAt))
    .limit(WARMUP.lookupsPerPoll);
  let got: Awaited<ReturnType<WarmupFeed["fetch"]>>;
  try {
    got = await feed.fetch(
      now,
      pending.map((p) => p.externalId),
    );
    if (!got || !Array.isArray(got.windows) || !Array.isArray(got.results)) throw new Error("the feed did not return windows and results");
  } catch (e) {
    await db.insert(warmupPolls).values({ source, ok: false, error: String((e as Error)?.message ?? e).slice(0, 500), at: now });
    // Settling reads only what's stored, so a feed that's down doesn't hold
    // up calls on windows that resolved before it went (or a settle cut short).
    return { ok: false as const, skipped: false as const, settled: (await settleWarmups(db, { now })).settled };
  }
  const result = await db.transaction(async (tx) => {
    const [lock] = await tx.execute<{ ok: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtext('warmup_poll')) AS ok`);
    if (!lock?.ok) return { ok: true as const, skipped: true as const };
    let windows = 0;
    let resolved = 0;
    let voided = 0;
    let bad = 0;
    for (const w of got.windows) {
      if (!validWindow(w)) {
        bad++;
        continue;
      }
      const [had] = await tx
        .select({ id: warmupWindows.id, status: warmupWindows.status })
        .from(warmupWindows)
        .where(and(eq(warmupWindows.source, source), eq(warmupWindows.externalId, w.externalId)))
        .for("no key update");
      if (had) {
        if (had.status === "open") await tx.update(warmupWindows).set({ trading: w.open }).where(eq(warmupWindows.id, had.id));
      } else {
        // A second market for a slot we already hold is ignored: one window a slot.
        await tx
          .insert(warmupWindows)
          .values({ source, externalId: w.externalId, question: w.question.slice(0, 300), startsAt: w.startsAt, endsAt: w.endsAt, trading: w.open })
          .onConflictDoNothing();
      }
      windows++;
    }
    for (const r of got.results) {
      if (!validResult(r)) {
        bad++;
        continue;
      }
      if (r.outcome === null && !r.voided) continue; // closed, but its result isn't final: it waits
      // Only a window that has ended can have a result.
      const [w] = await tx
        .select({ id: warmupWindows.id })
        .from(warmupWindows)
        .where(and(eq(warmupWindows.source, source), eq(warmupWindows.externalId, r.externalId), eq(warmupWindows.status, "open"), lte(warmupWindows.endsAt, now)))
        .for("no key update");
      if (!w) continue;
      await tx
        .update(warmupWindows)
        .set(r.voided ? { status: "void", resolvedAt: now } : { status: "resolved", outcome: r.outcome, resolvedAt: now })
        .where(eq(warmupWindows.id, w.id));
      if (r.voided) voided++;
      else resolved++;
    }
    // No window to call is a failed poll, whatever else came back.
    const ok = windows > 0;
    const error = [ok ? null : "no window listed", bad ? `${bad} malformed item(s) skipped` : null].filter(Boolean).join("; ");
    await tx.insert(warmupPolls).values({ source, ok, windows, at: now, ...(error ? { error } : {}) });
    return { ok, skipped: false as const, windows, resolved, voided, bad };
  });
  if (result.skipped) return result;
  return { ...result, settled: (await settleWarmups(db, { now })).settled };
}

// --- Settling -------------------------------------------------------------------

// Stamps every call on a window that has resolved or voided, once each:
// CALLED IT or REKT, and VOID on a void. CALLED IT and REKT come as moods,
// REKT with its free Copium (grantMood, once per call), never as GM; every
// stamp queues the opt-in "your warm-up settled" push.
export async function settleWarmups(db: Db, opts: { now?: Date; batch?: number } = {}) {
  const now = opts?.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("settleWarmups needs a date");
  const batch = Number.isSafeInteger(opts?.batch) && (opts.batch as number) > 0 ? Math.min(opts.batch as number, 5000) : 1000;
  const due = await db
    .select({ id: warmupCalls.id, userId: warmupCalls.userId })
    .from(warmupCalls)
    .innerJoin(warmupWindows, eq(warmupWindows.id, warmupCalls.windowId))
    .where(and(isNull(warmupCalls.stamp), inArray(warmupWindows.status, ["resolved", "void"])))
    .orderBy(asc(warmupWindows.endsAt))
    .limit(batch);
  let settled = 0;
  for (const d of due) {
    const done = await db.transaction(async (tx) => {
      // The resident first, as every write takes it (the mood and the push
      // below lock it too), then the call itself.
      await tx.execute(sql`SELECT 1 FROM users WHERE id = ${d.userId} FOR NO KEY UPDATE`);
      const [c] = await tx
        .select({ id: warmupCalls.id, userId: warmupCalls.userId, side: warmupCalls.side, status: warmupWindows.status, outcome: warmupWindows.outcome })
        .from(warmupCalls)
        .innerJoin(warmupWindows, eq(warmupWindows.id, warmupCalls.windowId))
        .where(and(eq(warmupCalls.id, d.id), isNull(warmupCalls.stamp)))
        .for("no key update", { of: warmupCalls });
      if (!c) return false; // a racing settler got here first
      const stamp = warmupStamp(c.side, c.outcome, c.status === "void");
      if (!stamp) return false;
      await tx.update(warmupCalls).set({ stamp, settledAt: now }).where(eq(warmupCalls.id, c.id));
      if (stamp !== "void") await grantMood(tx, c.userId, stamp, { now, once: `warmup:${c.id}`, source: { warmup: c.id } });
      await notify(tx, c.userId, "warmup_settled", {}, { now });
      return true;
    });
    if (done) settled++;
  }
  return { settled };
}

// --- Playing ----------------------------------------------------------------------

// The warm-up card: whether you can make one, the window taking calls (if
// any) or when the next opens, and your warm-ups with their receipts and,
// once settled, the reel. No City market stands in when there's no window:
// the plan's fallback is a free 10-minute one, and every City market takes
// GM and a Tower ticket and settles at the bell (HANDOFF.md).
export async function warmupState(db: Db, userId: string, opts: Opts = {}) {
  const p = parse(userId, opts);
  const [u] = await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, p.userId));
  if (!u) throw new WarmupError("UNKNOWN_USER", "who's asking?");
  const rows = await db
    .select({
      id: warmupCalls.id,
      windowId: warmupCalls.windowId,
      side: warmupCalls.side,
      day: warmupCalls.accountDay,
      stamp: warmupCalls.stamp,
      settledAt: warmupCalls.settledAt,
      startsAt: warmupWindows.startsAt,
      endsAt: warmupWindows.endsAt,
      status: warmupWindows.status,
      outcome: warmupWindows.outcome,
    })
    .from(warmupCalls)
    .innerJoin(warmupWindows, eq(warmupWindows.id, warmupCalls.windowId))
    .where(eq(warmupCalls.userId, p.userId))
    .orderBy(desc(warmupCalls.createdAt))
    .limit(WARMUP.max);
  const e = warmupEligibility(u.createdAt, p.now, rows.map((r) => r.day));
  // Everyone in the windows these were in: the Rookie Bell, then the reel.
  const sides = rows.length
    ? await db
        .select({ windowId: warmupCalls.windowId, side: warmupCalls.side })
        .from(warmupCalls)
        .where(
          inArray(
            warmupCalls.windowId,
            rows.map((r) => r.windowId),
          ),
        )
    : [];
  const live = p.source ? await feedLive(db, p.source, p.now) : false;
  const slot = windowStart(p.now);
  const [current] =
    p.source && live && takingCalls(slot, p.now)
      ? await db
          .select({ id: warmupWindows.id, question: warmupWindows.question, startsAt: warmupWindows.startsAt, endsAt: warmupWindows.endsAt })
          .from(warmupWindows)
          .where(and(eq(warmupWindows.source, p.source), eq(warmupWindows.startsAt, slot), eq(warmupWindows.status, "open"), eq(warmupWindows.trading, true)))
      : [];
  return {
    eligible: e.ok,
    reason: e.ok ? null : e.reason,
    day: e.day,
    left: e.left,
    feed: { live, credit: p.source ? warmupCredit(p.source) : null },
    window: current ? { ...current, entryClosesAt: entryClosesAt(current.startsAt) } : null,
    nextWindowAt: nextWindowAt(p.now),
    // Whether you could call that window when it opens: on your last day it
    // can open after your 3 days are up, and then the card promises nothing.
    nextCallable: warmupEligibility(u.createdAt, nextWindowAt(p.now), rows.map((r) => r.day)).ok,
    mine: rows.map((r) => {
      const window = sides.filter((s) => s.windowId === r.windowId).map((s) => s.side);
      return {
        id: r.id,
        side: r.side,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        stamp: r.stamp,
        settledAt: r.settledAt,
        newcomers: window.length,
        reel: r.stamp ? warmupReel(r.outcome, r.status === "void", window) : null,
      };
    }),
  };
}

// A warm-up call: UP or DOWN on the window now taking calls. Free: no stake,
// no GM, no Aura, no streak day. One a day for a resident's first 3 days,
// one per window, only in its first 2 minutes, and only while the feed is
// live and lists it.
export async function makeWarmup(db: Db, userId: string, input: { side?: unknown } = {}, opts: Opts = {}) {
  const p = parse(userId, opts);
  const side = (input as { side?: unknown } | null)?.side;
  if (!isWarmupSide(side)) throw new WarmupError("INVALID_INPUT", "UP or DOWN?");
  return db.transaction(async (tx) => {
    // The resident first, as every write takes it: their warm-ups are read
    // and written one at a time.
    const [u] = await tx.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, p.userId)).for("no key update");
    if (!u) throw new WarmupError("UNKNOWN_USER", "who's asking?");
    const used = await tx.select({ day: warmupCalls.accountDay }).from(warmupCalls).where(eq(warmupCalls.userId, p.userId));
    const e = warmupEligibility(
      u.createdAt,
      p.now,
      used.map((x) => x.day),
    );
    if (!e.ok && e.reason === "not_new") throw new WarmupError("NOT_NEW", `The warm-up is for your first ${WARMUP.days} days in the city.`);
    if (!e.ok) throw new WarmupError("ALREADY_TODAY", e.left > 0 ? "One warm-up a day. Your next one opens tomorrow." : "That was your last warm-up.");
    if (!p.source || !(await feedLive(tx, p.source, p.now))) throw new WarmupError("FEED_DOWN", "The Bitcoin feed is quiet right now. Try again in a few minutes.");
    const slot = windowStart(p.now);
    if (!takingCalls(slot, p.now)) {
      // No promise of a window that opens after the resident's 3 days are up.
      const next = nextWindowAt(p.now);
      if (!warmupEligibility(u.createdAt, next, used.map((x) => x.day)).ok)
        throw new WarmupError("WINDOW_CLOSED", `Calls close ${WARMUP.entryMinutes} minutes into a window, and your first ${WARMUP.days} days are up before the next one opens.`);
      throw new WarmupError("WINDOW_CLOSED", `Calls close ${WARMUP.entryMinutes} minutes into a window. The next one opens at ${hhmm(next)} UTC.`);
    }
    const [w] = await tx
      .select({ id: warmupWindows.id, startsAt: warmupWindows.startsAt, endsAt: warmupWindows.endsAt, trading: warmupWindows.trading })
      .from(warmupWindows)
      .where(and(eq(warmupWindows.source, p.source), eq(warmupWindows.startsAt, slot), eq(warmupWindows.status, "open")));
    if (!w || !w.trading) throw new WarmupError("FEED_DOWN", "This window isn't on the feed. Try the next one.");
    try {
      const [c] = await tx.insert(warmupCalls).values({ userId: p.userId, windowId: w.id, side, accountDay: e.day, createdAt: p.now }).returning();
      const [{ n } = { n: 1 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(warmupCalls).where(eq(warmupCalls.windowId, w.id));
      return { id: c!.id, side: c!.side, startsAt: w.startsAt, endsAt: w.endsAt, day: e.day, left: e.left - 1, newcomers: n };
    } catch (err) {
      // The unique keys back the checks above: one a day, one per window.
      const refused = uniqueRefusal(err);
      if (refused === "warmup_calls_user_day") throw new WarmupError("ALREADY_TODAY", "One warm-up a day. Your next one opens tomorrow.");
      if (refused === "warmup_calls_window_user") throw new WarmupError("ALREADY_IN", "You've already called this window.");
      throw err;
    }
  });
}
