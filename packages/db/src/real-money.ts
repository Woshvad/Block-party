import { EXCLUSIONS, type GateReason, MOOD, REAL, TIMEOUTS, cityDay, feeQuote, isAdult, monthlyCityCap, realGate, realPnl, realityCheckDue } from "@bp/core";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { moodState } from "./moods";
import { isStaff } from "./safety";
import { countrySwitches, markets, playSessions, realBreaks, realLimitRaises, realProfiles, realTrades, realityChecks } from "./schema";
import { feedStatus } from "./tower";

export class RealMoneyError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "UNDER_18" | "NOT_SET_UP" | "NOT_YET" | "NO_SUCH_RAISE" | "ON_A_BREAK" | "NOT_STAFF" | "GATE_CLOSED" | "NO_SUCH_TRADE",
    message: string,
  ) {
    super(message);
    this.name = "RealMoneyError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITS = ["weekly", "monthly", "loss"] as const;
type LimitKind = (typeof LIMITS)[number];
const col = { weekly: "weeklyCents", monthly: "monthlyCents", loss: "lossCents" } as const;
const cents = (x: unknown) => Number.isSafeInteger(x) && (x as number) > 0 && (x as number) <= 1_000_000_00;

const lockRealUser = (tx: Db, userId: string) => tx.execute(sql`SELECT 1 FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);

// Before a first real trade: a birth year (18+, as given), the declarations,
// and limits ("Set a limit" is already selected).
export async function setupReal(
  db: Db,
  userId: string,
  input: { birthYear?: unknown; notRestricted?: unknown; noVpn?: unknown; weeklyCents?: unknown; monthlyCents?: unknown; lossCents?: unknown },
  opts: { now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  if (!Number.isInteger(input.birthYear)) throw new RealMoneyError("INVALID_INPUT", "your birth year");
  if (!isAdult(input.birthYear as number, now)) throw new RealMoneyError("UNDER_18", "real trades are 18+");
  if (input.notRestricted !== true || input.noVpn !== true) throw new RealMoneyError("INVALID_INPUT", "confirm you're not in a restricted place and not on a VPN");
  for (const k of ["weeklyCents", "monthlyCents", "lossCents"] as const) if (!cents(input[k])) throw new RealMoneyError("INVALID_INPUT", `${k} must be set`);
  const [have] = await db.select().from(realProfiles).where(eq(realProfiles.userId, userId));
  if (have) throw new RealMoneyError("INVALID_INPUT", "already set up; change limits separately");
  await db.insert(realProfiles).values({
    userId,
    birthYear: input.birthYear as number,
    declaredAt: now,
    weeklyCents: input.weeklyCents as number,
    monthlyCents: input.monthlyCents as number,
    lossCents: input.lossCents as number,
    updatedAt: now,
  });
  return { setUp: true };
}

// Lowering works at once; raising waits 24 hours and asks again.
export async function changeLimit(db: Db, userId: string, kind: unknown, value: unknown, opts: { now?: Date } = {}) {
  return db.transaction(async (tx) => {
    await lockRealUser(tx, userId);
    return changeLimitLocked(tx, userId, kind, value, opts);
  });
}

async function changeLimitLocked(db: Db, userId: string, kind: unknown, value: unknown, opts: { now?: Date }) {
  const now = opts.now ?? new Date();
  if (!(LIMITS as readonly unknown[]).includes(kind) || !cents(value)) throw new RealMoneyError("INVALID_INPUT", "weekly, monthly or loss, in cents");
  const [p] = await db.select().from(realProfiles).where(eq(realProfiles.userId, userId));
  if (!p) throw new RealMoneyError("NOT_SET_UP", "set up real trades first");
  const k = kind as LimitKind;
  const current = p[col[k]];
  if ((value as number) <= current) {
    await db.update(realProfiles).set({ [col[k]]: value as number, updatedAt: now }).where(eq(realProfiles.userId, userId));
    // A lower limit cancels any pending raise of the same kind.
    await db.update(realLimitRaises).set({ status: "cancelled" }).where(and(eq(realLimitRaises.userId, userId), eq(realLimitRaises.kind, k), eq(realLimitRaises.status, "pending")));
    return { applied: true as const };
  }
  const [r] = await db
    .insert(realLimitRaises)
    .values({ userId, kind: k, cents: value as number, confirmableAt: new Date(now.getTime() + REAL.raiseWaitHours * 3_600_000), createdAt: now })
    .returning();
  return { applied: false as const, raiseId: r!.id, confirmableAt: r!.confirmableAt };
}

export async function confirmRaise(db: Db, userId: string, raiseId: unknown, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  if (typeof raiseId !== "string" || !UUID.test(raiseId)) throw new RealMoneyError("NO_SUCH_RAISE", "no such raise");
  return db.transaction(async (tx) => {
    await lockRealUser(tx, userId);
    const [r] = await tx
      .select()
      .from(realLimitRaises)
      .where(and(eq(realLimitRaises.id, raiseId.toLowerCase()), eq(realLimitRaises.userId, userId), eq(realLimitRaises.status, "pending")))
      .for("no key update");
    if (!r) throw new RealMoneyError("NO_SUCH_RAISE", "no such raise");
    if (now < r.confirmableAt) throw new RealMoneyError("NOT_YET", "a higher limit waits 24 hours");
    await tx.update(realProfiles).set({ [col[r.kind as LimitKind]]: r.cents, updatedAt: now }).where(eq(realProfiles.userId, userId));
    await tx.update(realLimitRaises).set({ status: "applied" }).where(eq(realLimitRaises.id, r.id));
    return { applied: true };
  });
}

// A time-out (24h, 1w, 1m, or any number of days up to 6 weeks) or
// self-exclusion (6m, 1y, 5y, for good). Neither ends early.
export async function takeBreak(db: Db, userId: string, kind: unknown, length: unknown, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  let days: number | null;
  if (kind === "timeout") {
    days = typeof length === "string" && length in TIMEOUTS ? TIMEOUTS[length as keyof typeof TIMEOUTS] : Number.isInteger(length) && (length as number) >= 1 && (length as number) <= REAL.timeoutMaxDays ? (length as number) : -1;
    if (days === -1) throw new RealMoneyError("INVALID_INPUT", "24h, 1w, 1m, or 1 to 42 days");
  } else if (kind === "exclusion") {
    if (typeof length !== "string" || !(length in EXCLUSIONS)) throw new RealMoneyError("INVALID_INPUT", "6m, 1y, 5y or forever");
    days = EXCLUSIONS[length as keyof typeof EXCLUSIONS];
  } else throw new RealMoneyError("INVALID_INPUT", "timeout or exclusion");
  const b = await db.transaction(async (tx) => {
    await lockRealUser(tx, userId);
    const [row] = await tx
      .insert(realBreaks)
      .values({ userId, kind, startedAt: now, endsAt: days === null ? null : new Date(now.getTime() + days * 86_400_000) })
      .returning();
    return row!;
  });
  return { id: b!.id, kind, endsAt: b!.endsAt };
}

// Where a resident stands on breaks: blocked until a fixed break ends, then
// until they ask back, then for one more day.
async function breakState(db: Db, userId: string, now: Date) {
  const rows = await db.select().from(realBreaks).where(eq(realBreaks.userId, userId)).orderBy(desc(realBreaks.startedAt));
  let excludedUntil: Date | null | "forever" = null;
  let timeoutUntil: Date | null = null;
  let awaitingReturnUntil: Date | null = null;
  for (const b of rows) {
    if (b.endsAt === null) {
      excludedUntil = "forever";
      continue;
    }
    if (now < b.endsAt) {
      if (b.kind === "exclusion") excludedUntil = excludedUntil === "forever" ? "forever" : b.endsAt;
      else timeoutUntil = b.endsAt;
      continue;
    }
    // Ended: still off until they ask back, then a day more.
    if (!b.returnAt) awaitingReturnUntil = new Date(8.64e15);
    else if (now < b.returnAt) awaitingReturnUntil = b.returnAt;
  }
  return { excludedUntil, timeoutUntil, awaitingReturnUntil, rows };
}

// Ask for real money back after a fixed break has ended: it returns a day later.
export async function askBack(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const s = await breakState(db, userId, now);
  if (s.excludedUntil || s.timeoutUntil) throw new RealMoneyError("ON_A_BREAK", "your break hasn't ended, and it can't end early");
  const ended = s.rows.filter((b) => b.endsAt && b.endsAt <= now && !b.returnAt);
  const returnAt = new Date(now.getTime() + REAL.returnWaitHours * 3_600_000);
  for (const b of ended) await db.update(realBreaks).set({ returnAt }).where(eq(realBreaks.id, b.id));
  return { returnsAt: ended.length ? returnAt : null };
}

// Staff (admins in practice) flip a country's real-trade switch.
export async function setCountrySwitch(db: Db, staffId: string, country: unknown, on: unknown, opts: { now?: Date } = {}) {
  if (!(await isStaff(db, staffId))) throw new RealMoneyError("NOT_STAFF", "staff only");
  if (typeof country !== "string" || !/^[A-Z]{2}$/.test(country) || typeof on !== "boolean") throw new RealMoneyError("INVALID_INPUT", "a two-letter country code and on or off");
  await db
    .insert(countrySwitches)
    .values({ country, realTrades: on, updatedBy: staffId, updatedAt: opts.now ?? new Date() })
    .onConflictDoUpdate({ target: countrySwitches.country, set: { realTrades: on, updatedBy: staffId, updatedAt: opts.now ?? new Date() } });
  return { country, realTrades: on };
}

// Whether "Back it for real" may show for this resident, market and amount,
// and if not, why. Every input the server can't know (location agreement,
// first session, Mini App) comes from the caller.
export async function realTradeGate(
  db: Db,
  userId: string,
  input: { switchOn: boolean; country: string | null; locationOk: boolean; firstSession: boolean; inMiniApp: boolean; marketId?: string; amountCents?: number | null },
  opts: { now?: Date } = {},
): Promise<{ ok: true } | { ok: false; reason: GateReason }> {
  const now = opts.now ?? new Date();
  const [sw] = input.country ? await db.select().from(countrySwitches).where(eq(countrySwitches.country, input.country)) : [];
  const [p] = await db.select().from(realProfiles).where(eq(realProfiles.userId, userId));
  const breaks = await breakState(db, userId, now);
  const mood = await moodState(db, userId, { now });
  let marketReal = true;
  if (input.marketId) {
    const [m] = UUID.test(input.marketId) ? await db.select().from(markets).where(eq(markets.id, input.marketId)) : [];
    // Mirror markets only (never politics, City/Crew markets, duels or the warm-up), and only while open.
    marketReal = !!m && !m.infoOnly && m.category !== "politics" && m.status === "open" && now < m.freezesAt;
  }
  const monthStart = new Date(`${cityDay(now).slice(0, 7)}-01T00:00:00Z`);
  const weekStart = new Date(now.getTime() - 7 * 86_400_000);
  const spent = await db
    .select({
      week: sql<number>`COALESCE(SUM(${realTrades.amountCents}) FILTER (WHERE ${realTrades.createdAt} >= ${weekStart.toISOString()}::timestamptz), 0)::int`,
      month: sql<number>`COALESCE(SUM(${realTrades.amountCents}) FILTER (WHERE ${realTrades.createdAt} >= ${monthStart.toISOString()}::timestamptz), 0)::int`,
      lost: sql<number>`COALESCE(-SUM(LEAST(${realTrades.pnlCents}, 0)) FILTER (WHERE ${realTrades.settledAt} >= ${monthStart.toISOString()}::timestamptz), 0)::int`,
    })
    .from(realTrades)
    // A device's failure report cannot release a reservation. Only trusted
    // exchange reconciliation can establish that no order was filled; until
    // that integration exists, failed reports count for the original window.
    .where(and(eq(realTrades.userId, userId), inArray(realTrades.status, ["intent", "filled", "settled", "failed"]),
      sql`(${realTrades.createdAt} >= ${new Date(Math.min(weekStart.getTime(), monthStart.getTime())).toISOString()}::timestamptz OR ${realTrades.settledAt} >= ${monthStart.toISOString()}::timestamptz)`));
  return realGate({
    switchOn: input.switchOn,
    countryOn: !!sw?.realTrades,
    locationOk: input.locationOk,
    firstSession: input.firstSession,
    inMiniApp: input.inMiniApp,
    setUp: !!p,
    excludedUntil: breaks.excludedUntil,
    timeoutUntil: breaks.timeoutUntil,
    awaitingReturnUntil: breaks.awaitingReturnUntil,
    tiltPauseUntil: mood.tilt.realTradesPausedUntil,
    marketReal,
    feedPaused: input.marketId ? (await feedStatus(db, { now })).paused : false,
    amountCents: input.amountCents ?? null,
    spentThisWeekCents: spent[0]!.week,
    spentThisMonthCents: spent[0]!.month,
    lostThisMonthCents: spent[0]!.lost,
    limits: p ? { weeklyCents: p.weeklyCents, monthlyCents: p.monthlyCents, lossCents: p.lossCents } : null,
    monthlyCityCapCents: p ? monthlyCityCap(p.birthYear, now) : 0,
    now,
  });
}

// A resident's first session: no earlier play session to their name.
export async function inFirstSession(db: Db, userId: string): Promise<boolean> {
  const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(playSessions).where(eq(playSessions.userId, userId));
  return n!.n <= 1;
}

// --- The trade record ---------------------------------------------------------------

type GateContext = { switchOn: boolean; country: string | null; locationOk: boolean; firstSession: boolean; inMiniApp: boolean };

// Before the device signs: the gate again, for this market and amount, then a
// record with both fees. We never relay the order or hold the money.
export async function recordIntent(
  db: Db,
  userId: string,
  input: { marketId?: unknown; side?: unknown; amountCents?: unknown; polymarketFeeCents?: unknown },
  ctx: GateContext,
  opts: { now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  if (typeof input.marketId !== "string" || !UUID.test(input.marketId)) throw new RealMoneyError("INVALID_INPUT", "which market?");
  if (input.side !== "yes" && input.side !== "no") throw new RealMoneyError("INVALID_INPUT", "side is yes or no");
  if (!Number.isSafeInteger(input.amountCents) || (input.amountCents as number) <= 0) throw new RealMoneyError("INVALID_INPUT", "an amount in cents");
  if (!Number.isSafeInteger(input.polymarketFeeCents) || (input.polymarketFeeCents as number) < 0 || (input.polymarketFeeCents as number) > (input.amountCents as number)) throw new RealMoneyError("INVALID_INPUT", "Polymarket's fee in cents");
  return db.transaction(async (tx) => {
    await lockRealUser(tx, userId);
    const g = await realTradeGate(tx, userId, { ...ctx, marketId: (input.marketId as string).toLowerCase(), amountCents: input.amountCents as number }, { now });
    if (!g.ok) throw new RealMoneyError("GATE_CLOSED", g.reason);
    const q = feeQuote(input.amountCents as number, input.polymarketFeeCents as number);
    const [t] = await tx
      .insert(realTrades)
      .values({ userId, marketId: (input.marketId as string).toLowerCase(), side: input.side as "yes" | "no", amountCents: q.amountCents, polymarketFeeCents: q.polymarketFeeCents, builderFeeCents: q.builderFeeCents, createdAt: now })
      .returning();
    return { id: t!.id, ...q };
  });
}

// The device reports the order: filled in full (at its price) or not at all.
export async function reportFill(db: Db, userId: string, tradeId: unknown, input: { filled?: unknown; fillPricePct?: unknown }, opts: { now?: Date } = {}) {
  if (typeof tradeId !== "string" || !UUID.test(tradeId)) throw new RealMoneyError("NO_SUCH_TRADE", "no such trade");
  if (typeof input.filled !== "boolean") throw new RealMoneyError("INVALID_INPUT", "filled is true or false");
  if (input.filled && (!Number.isInteger(input.fillPricePct) || (input.fillPricePct as number) < 1 || (input.fillPricePct as number) > 99)) throw new RealMoneyError("INVALID_INPUT", "the fill price, 1 to 99");
  const [t] = await db
    .update(realTrades)
    .set(input.filled ? { status: "filled", fillPricePct: input.fillPricePct as number, filledAt: opts.now ?? new Date() } : { status: "failed" })
    .where(and(eq(realTrades.id, tradeId.toLowerCase()), eq(realTrades.userId, userId), eq(realTrades.status, "intent")))
    .returning({ id: realTrades.id, status: realTrades.status });
  if (!t) throw new RealMoneyError("NO_SUCH_TRADE", "no such open trade");
  return t;
}

// When a market resolves (or voids), each filled trade on it gets its result.
export async function settleRealTrades(db: Db, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const due = await db
    .select({ id: realTrades.id, amountCents: realTrades.amountCents, fill: realTrades.fillPricePct, pm: realTrades.polymarketFeeCents, b: realTrades.builderFeeCents, side: realTrades.side, status: markets.status, outcome: markets.outcome })
    .from(realTrades)
    .innerJoin(markets, eq(markets.id, realTrades.marketId))
    .where(and(eq(realTrades.status, "filled"), inArray(markets.status, ["resolved", "void"])));
  for (const t of due) {
    const pnl = realPnl({ amountCents: t.amountCents, fillPricePct: t.fill!, feesCents: t.pm + t.b, side: t.side }, t.status === "void" ? null : t.outcome);
    await db.update(realTrades).set({ status: "settled", pnlCents: pnl, settledAt: now }).where(and(eq(realTrades.id, t.id), eq(realTrades.status, "filled")));
  }
  return { settled: due.length };
}

// Your own record: money into trades, wins, losses, fees and time spent, by month.
export async function realActivity(db: Db, userId: string, month: unknown, opts: { now?: Date } = {}) {
  const m = typeof month === "string" && /^\d{4}-\d{2}$/.test(month) ? month : cityDay(opts.now ?? new Date()).slice(0, 7);
  const from = new Date(`${m}-01T00:00:00Z`);
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  const trades = await db
    .select()
    .from(realTrades)
    .where(and(eq(realTrades.userId, userId), gte(realTrades.createdAt, from), sql`${realTrades.createdAt} < ${to.toISOString()}::timestamptz`))
    .orderBy(desc(realTrades.createdAt));
  const counted = trades.filter((t) => t.status === "filled" || t.status === "settled");
  const [mins] = await db
    .select({ m: sql<number>`COALESCE(SUM(EXTRACT(EPOCH FROM (${playSessions.lastSeenAt} - ${playSessions.startedAt})) / 60), 0)::int` })
    .from(playSessions)
    .where(and(eq(playSessions.userId, userId), gte(playSessions.startedAt, from), sql`${playSessions.startedAt} < ${to.toISOString()}::timestamptz`));
  return {
    month: m,
    intoTradesCents: counted.reduce((a, t) => a + t.amountCents, 0),
    winsCents: counted.reduce((a, t) => a + Math.max(0, t.pnlCents ?? 0), 0),
    lossesCents: counted.reduce((a, t) => a + Math.max(0, -(t.pnlCents ?? 0)), 0),
    feesCents: counted.reduce((a, t) => a + t.polymarketFeeCents + t.builderFeeCents, 0),
    minutesPlayed: mins!.m,
    trades: trades.map((t) => ({ id: t.id, marketId: t.marketId, side: t.side, amountCents: t.amountCents, status: t.status, pnlCents: t.pnlCents, createdAt: t.createdAt })),
  };
}

// Every 60 minutes of play: time played and today's real-money result.
export async function realityCheck(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const [s] = await db.select().from(playSessions).where(eq(playSessions.userId, userId)).orderBy(desc(playSessions.lastSeenAt)).limit(1);
  if (!s || now.getTime() - s.lastSeenAt.getTime() > MOOD.sessionGapMinutes * 60_000) return { due: false, minutesPlayed: 0, todayResultCents: 0 };
  const minutes = Math.floor((now.getTime() - s.startedAt.getTime()) / 60_000);
  const [last] = await db
    .select({ hour: sql<number>`COALESCE(MAX(${realityChecks.hour}), 0)::int` })
    .from(realityChecks)
    .where(and(eq(realityChecks.userId, userId), eq(realityChecks.sessionStartedAt, s.startedAt)));
  const [today] = await db
    .select({ r: sql<number>`COALESCE(SUM(${realTrades.pnlCents}), 0)::int` })
    .from(realTrades)
    .where(and(eq(realTrades.userId, userId), eq(realTrades.status, "settled"), gte(realTrades.settledAt, new Date(`${cityDay(now)}T00:00:00Z`))));
  return { due: realityCheckDue(minutes, last!.hour), minutesPlayed: minutes, todayResultCents: today!.r, sessionStartedAt: s.startedAt };
}

export async function ackRealityCheck(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const r = await realityCheck(db, userId, { now });
  if (!r.due || !("sessionStartedAt" in r)) return { acknowledged: false };
  await db
    .insert(realityChecks)
    .values({ userId, sessionStartedAt: r.sessionStartedAt!, hour: Math.floor(r.minutesPlayed / REAL.realityCheckMinutes), at: now })
    .onConflictDoNothing();
  return { acknowledged: true };
}
