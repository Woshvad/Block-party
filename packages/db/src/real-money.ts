import { EXCLUSIONS, type GateReason, REAL, TIMEOUTS, cityDay, isAdult, monthlyCityCap, realGate } from "@bp/core";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { moodState } from "./moods";
import { isStaff } from "./safety";
import { countrySwitches, markets, playSessions, realBreaks, realLimitRaises, realProfiles, realTrades } from "./schema";
import { feedStatus } from "./tower";

export class RealMoneyError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "UNDER_18" | "NOT_SET_UP" | "NOT_YET" | "NO_SUCH_RAISE" | "ON_A_BREAK" | "NOT_STAFF",
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
  const [b] = await db
    .insert(realBreaks)
    .values({ userId, kind, startedAt: now, endsAt: days === null ? null : new Date(now.getTime() + days * 86_400_000) })
    .returning();
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
      month: sql<number>`COALESCE(SUM(${realTrades.amountCents}), 0)::int`,
      lost: sql<number>`COALESCE(-SUM(LEAST(${realTrades.pnlCents}, 0)), 0)::int`,
    })
    .from(realTrades)
    .where(and(eq(realTrades.userId, userId), inArray(realTrades.status, ["intent", "filled", "settled"]), gte(realTrades.createdAt, monthStart)));
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
