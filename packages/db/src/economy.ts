import {
  GM,
  MAX_RENT_WEEKS,
  RENT,
  SHIFT,
  BURN_SHARDS,
  MINT_SHARDS,
  SYS_PURSE,
  burnAccountFor,
  isMintAccount,
  addDays,
  cityDay,
  cryptoRandomInt,
  isSublet,
  rentSplit,
  saturdaysBetween,
  scoreShift,
  shiftPay,
  shiftPuzzle,
  userAccountId,
} from "@bp/core";
import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "./client";
import { openGmStakes } from "./daily";
import { lockAccounts, mint, post } from "./ledger";
import { crewMembers, dailyGm, gmAccounts, rentCharges, residents, shifts, users } from "./schema";

export class EconomyError extends Error {
  constructor(
    readonly code:
      | "NO_RESIDENT"
      | "SHIFT_IN_PROGRESS"
      | "DAILY_CAP"
      | "NO_SUCH_SHIFT"
      | "ALREADY_SUBMITTED"
      | "LATE"
      | "NOT_DONE"
      | "NOT_PON"
      | "NO_RECENT_GM",
    message: string,
  ) {
    super(message);
    this.name = "EconomyError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function lockResident(tx: Db, userId: string) {
  await tx.execute(sql`SELECT 1 FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);
  const [r] = await tx.select({ createdAt: residents.createdAt }).from(residents).where(eq(residents.userId, userId));
  if (!r) throw new EconomyError("NO_RESIDENT", "move in first");
  return r;
}

// --- Rent -----------------------------------------------------------------

// Last city day the resident said gm before `day`, or the day they moved in.
async function lastActiveBefore(tx: Db, userId: string, day: string, movedIn: string) {
  const [g] = await tx
    .select({ d: dailyGm.cityDay })
    .from(dailyGm)
    .where(and(eq(dailyGm.userId, userId), lt(dailyGm.cityDay, day)))
    .orderBy(desc(dailyGm.cityDay))
    .limit(1);
  return g && g.d > movedIn ? g.d : movedIn;
}

// "owed" is never stored: that Saturday stays unrecorded and is tried again
// by the same bell's final pass.
export type RentOutcome = { saturday: string; status: "paid" | "couch" | "sublet" | "owed"; amount: number };

// Charges every Saturday's rent the resident owes up to today, oldest first,
// at most MAX_RENT_WEEKS back (older ones are forgiven, never stacked).
// Idempotent. The bell job runs it first thing at each Saturday bell, before
// anyone can spend, so nobody can dodge rent by spending first. Someone short
// in the wallet but not counting their open stakes is "owed": the bell runs
// it again with `final` once tonight's stakes have paid out, and then what's
// in the wallet is what there is. A stake still open past the bell doesn't
// keep anyone off the couch, or one kept open over every Saturday would mean
// rent was never paid.
export async function collectRent(db: Db, userId: string, opts: { now?: Date; final?: boolean } = {}): Promise<RentOutcome[]> {
  const today = cityDay(opts.now ?? new Date());
  return db.transaction(async (tx) => {
    const r = await lockResident(tx, userId);
    const movedIn = cityDay(r.createdAt);
    // Rent is due at the Saturday bell; moving in during a Saturday owes nothing that week.
    const from = addDays(movedIn, 1);
    const windowStart = addDays(today, -7 * MAX_RENT_WEEKS + 1);
    const out: RentOutcome[] = [];
    for (const saturday of saturdaysBetween(from > windowStart ? from : windowStart, today)) {
      const [done] = await tx
        .select()
        .from(rentCharges)
        .where(and(eq(rentCharges.userId, userId), eq(rentCharges.saturday, saturday)));
      if (done) continue;
      const last = await lastActiveBefore(tx, userId, saturday, movedIn);
      if (isSublet(last, saturday)) {
        await tx.insert(rentCharges).values({ userId, saturday, status: "sublet" });
        out.push({ saturday, status: "sublet", amount: 0 });
        continue;
      }
      // Read under the ledger's locks, in its order, so a purchase can't land
      // between "can they pay?" and the charge.
      const balance = (await lockAccounts(tx, [userAccountId(userId), burnAccountFor(userAccountId(userId)), SYS_PURSE])).get(userAccountId(userId)) ?? 0;
      if (balance < RENT.tenement) {
        // GM out on stakes is still theirs: a stake settling tonight doesn't
        // make anyone too poor to pay, so the first pass waits for it. Read
        // after the wallet's lock, so a stake coming home right now is
        // counted once, not twice. The final pass counts the wallet alone.
        const staked = opts.final ? 0 : await openGmStakes(tx, userId);
        if (balance + staked < RENT.tenement) {
          // Can't pay: a week on the crew's couch (or the bench). Never debt.
          await tx.insert(rentCharges).values({ userId, saturday, status: "couch" });
          out.push({ saturday, status: "couch", amount: 0 });
          continue;
        }
        // They can pay, but part of it is out on stakes. Never debt: this
        // Saturday stays unrecorded, and so do the ones after it, until the
        // bell's final pass, after tonight's payouts, charges the wallet or
        // sends them to the couch.
        out.push({ saturday, status: "owed", amount: 0 });
        break;
      }
      const { burn, purse } = rentSplit(RENT.tenement);
      const res = await post(tx, {
        idempotencyKey: `rent:${userId}:${saturday}`,
        kind: "rent",
        legs: [
          { accountId: userAccountId(userId), amount: -RENT.tenement },
          { accountId: burnAccountFor(userAccountId(userId)), amount: burn },
          { accountId: SYS_PURSE, amount: purse },
        ],
        meta: { saturday },
      });
      await tx.insert(rentCharges).values({ userId, saturday, status: "paid", amount: RENT.tenement, txId: res.txId });
      out.push({ saturday, status: "paid", amount: RENT.tenement });
    }
    return out;
  });
}

// Where you sleep this week.
export async function tenancy(db: Db, userId: string, opts: { now?: Date } = {}) {
  const today = cityDay(opts.now ?? new Date());
  const [last] = await db
    .select()
    .from(rentCharges)
    .where(and(eq(rentCharges.userId, userId), sql`${rentCharges.saturday} <= ${today}::date`))
    .orderBy(desc(rentCharges.saturday))
    .limit(1);
  if (!last || last.status !== "couch") return { where: "home" as const };
  const [m] = await db
    .select({ crewId: crewMembers.crewId })
    .from(crewMembers)
    .where(and(eq(crewMembers.userId, userId), isNull(crewMembers.leftAt)));
  return m ? { where: "crew_couch" as const, crewId: m.crewId } : { where: "bench" as const };
}

// --- Mod Shift ------------------------------------------------------------

async function shiftsOn(tx: Db, userId: string, day: string) {
  return tx.select().from(shifts).where(and(eq(shifts.userId, userId), eq(shifts.cityDay, day)));
}

export async function startShift(db: Db, userId: string, opts: { now?: Date; seed?: number } = {}) {
  const now = opts.now ?? new Date();
  const day = cityDay(now);
  return db.transaction(async (tx) => {
    await lockResident(tx, userId);
    const [busy] = await tx
      .select({ id: shifts.id })
      .from(shifts)
      .where(and(eq(shifts.userId, userId), eq(shifts.kind, "active"), sql`${shifts.endsAt} > ${now.toISOString()}::timestamptz`));
    if (busy) throw new EconomyError("SHIFT_IN_PROGRESS", "finish your current shift first");
    const today = await shiftsOn(tx, userId, day);
    if (today.length >= SHIFT.perDay) throw new EconomyError("DAILY_CAP", `${SHIFT.perDay} shifts a day`);
    const seed = opts.seed ?? cryptoRandomInt(2 ** 31);
    const [s] = await tx
      .insert(shifts)
      .values({
        userId,
        cityDay: day,
        slot: today.length + 1,
        kind: "active",
        seed,
        startedAt: now,
        endsAt: new Date(now.getTime() + SHIFT.minutes * 60_000),
      })
      .returning();
    return {
      shiftId: s!.id,
      items: shiftPuzzle(seed).items, // never the answers
      answerBy: new Date(now.getTime() + SHIFT.answerWindowSeconds * 1000),
      endsAt: s!.endsAt,
    };
  });
}

async function ownShift(tx: Db, userId: string, shiftId: unknown) {
  if (typeof shiftId !== "string" || !/^[0-9a-f-]{36}$/.test(shiftId)) throw new EconomyError("NO_SUCH_SHIFT", "no such shift");
  const [s] = await tx.select().from(shifts).where(and(eq(shifts.id, shiftId), eq(shifts.userId, userId))).for("no key update");
  if (!s) throw new EconomyError("NO_SUCH_SHIFT", "no such shift");
  return s;
}

// The mini-game result. The server scores it; the client never sends a score.
export async function submitShift(db: Db, userId: string, shiftId: unknown, answers: unknown, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const s = await ownShift(tx, userId, shiftId);
    if (s.kind !== "active") throw new EconomyError("NO_SUCH_SHIFT", "no mini-game on an away shift");
    if (s.submittedAt) throw new EconomyError("ALREADY_SUBMITTED", "already answered");
    if (now.getTime() > s.startedAt.getTime() + SHIFT.answerWindowSeconds * 1000 || now < s.startedAt) {
      throw new EconomyError("LATE", "the mini-game is over; the shift pays the base rate");
    }
    const score = scoreShift(s.seed!, answers);
    await tx.update(shifts).set({ submittedAt: now, score }).where(eq(shifts.id, s.id));
    return { score, pay: shiftPay(score) };
  });
}

export async function collectShift(db: Db, userId: string, shiftId: unknown, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const s = await ownShift(tx, userId, shiftId);
    if (s.collectedTx) return { pay: s.pay!, replayed: true };
    if (now < s.endsAt) throw new EconomyError("NOT_DONE", "the shift is still running");
    const pay = shiftPay(s.score);
    const res = await mint(tx, {
      accountId: userAccountId(userId),
      amount: pay,
      kind: "mod_shift",
      idempotencyKey: `shift:${s.id}`,
      meta: { cityDay: s.cityDay, score: s.score },
    });
    await tx.update(shifts).set({ pay, collectedTx: res.txId }).where(eq(shifts.id, s.id));
    return { pay, replayed: false };
  });
}

// The shift to come back to after leaving the Shifts view or reloading: the
// newest Mod Shift not yet collected, from today or yesterday (one started
// just before the bell ends after it). It carries what the city needs to pick
// up where the player left off: the queue while it can still be answered
// (never the answers), the score once handed in, the pay (by the score, or
// the base rate once the answer window has passed unanswered; null while it
// can still be answered), and whether the shift has ended so the pay can be
// collected. null when there's nothing to come back to.
export async function currentShift(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const [s] = await db
    .select()
    .from(shifts)
    .where(and(eq(shifts.userId, userId), eq(shifts.kind, "active"), isNull(shifts.collectedTx), gte(shifts.cityDay, addDays(cityDay(now), -1))))
    .orderBy(desc(shifts.startedAt))
    .limit(1);
  if (!s) return null;
  const answerBy = new Date(s.startedAt.getTime() + SHIFT.answerWindowSeconds * 1000);
  const answerable = !s.submittedAt && now >= s.startedAt && now <= answerBy;
  return {
    shiftId: s.id,
    items: answerable ? shiftPuzzle(s.seed!).items : null,
    answerBy,
    endsAt: s.endsAt,
    answered: !!s.submittedAt,
    score: s.score,
    pay: answerable ? null : shiftPay(s.score),
    collectable: now >= s.endsAt,
  };
}

// Why this resident can't take an away shift right now, or null if they can.
// Collecting it and the "ready" ping both ask here, so they never disagree.
async function awayShiftBlock(tx: Db, userId: string, now: Date, day: string): Promise<EconomyError | null> {
  const [u] = await tx.select({ pon: users.proofOfNeighbourAt }).from(users).where(eq(users.id, userId));
  if (!u?.pon) return new EconomyError("NOT_PON", "away shifts need Proof of Neighbour");
  const [recent] = await tx
    .select({ at: dailyGm.saidAt })
    .from(dailyGm)
    .where(and(eq(dailyGm.userId, userId), gte(dailyGm.saidAt, new Date(now.getTime() - 24 * 3_600_000)), sql`${dailyGm.saidAt} <= ${now.toISOString()}::timestamptz`))
    .limit(1);
  if (!recent) return new EconomyError("NO_RECENT_GM", "say gm first; away shifts pay only within 24 hours of a gm");
  const today = await shiftsOn(tx, userId, day);
  if (today.some((s) => s.kind === "away")) return new EconomyError("DAILY_CAP", "one away shift a day");
  if (today.length >= SHIFT.perDay) return new EconomyError("DAILY_CAP", `${SHIFT.perDay} shifts a day`);
  return null;
}

// Whether this resident could collect an away shift right now (anything that
// isn't a resident's id simply can't).
export async function awayShiftReady(db: Db, userId: unknown, opts: { now?: Date } = {}): Promise<boolean> {
  const now = opts?.now ?? new Date();
  if (typeof userId !== "string" || !UUID.test(userId) || !(now instanceof Date) || Number.isNaN(now.getTime())) return false;
  return (await awayShiftBlock(db, userId, now, cityDay(now))) === null;
}

// The away shift: Proof of Neighbour only, needs a gm in the last 24 hours,
// collected by hand, and takes one of the 2 daily slots at half pay.
export async function collectAwayShift(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const day = cityDay(now);
  return db.transaction(async (tx) => {
    await lockResident(tx, userId);
    const block = await awayShiftBlock(tx, userId, now, day);
    if (block) throw block;
    const today = await shiftsOn(tx, userId, day);
    const [s] = await tx
      .insert(shifts)
      .values({ userId, cityDay: day, slot: today.length + 1, kind: "away", startedAt: now, endsAt: now, pay: SHIFT.awayPay })
      .returning();
    const res = await mint(tx, {
      accountId: userAccountId(userId),
      amount: SHIFT.awayPay,
      kind: "away_shift",
      idempotencyKey: `shift:${s!.id}`,
      meta: { cityDay: day },
    });
    await tx.update(shifts).set({ collectedTx: res.txId }).where(eq(shifts.id, s!.id));
    return { pay: SHIFT.awayPay };
  });
}

// --- The Drip Committee minutes (internal dashboard) -----------------------

// Just the GM destroyed over a window: everything paid into the burn shards
// and the Purse, the same total as economyReport's totalDestroyed. The reel
// needs only this, not the flows by kind or the median balance.
export async function gmDestroyed(db: Db, opts: { from: Date; to: Date }): Promise<number> {
  const [r] = await db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(amount), 0)::text AS total
    FROM gm_entries
    WHERE account_id IN (${sql.join([...BURN_SHARDS, SYS_PURSE].map((id) => sql`${id}`), sql`, `)})
      AND created_at >= ${opts.from.toISOString()}::timestamptz AND created_at < ${opts.to.toISOString()}::timestamptz`);
  return Number(r!.total);
}

// GM created vs destroyed over a window, on net flows: only the mint and the
// sinks count; GM moving between players doesn't. Rent's Purse share counts
// as destroyed, since the Purse never pays GM back out.
export async function economyReport(db: Db, opts: { from: Date; to: Date }) {
  const rows = await db.execute<{ account_id: string; kind: string; total: string }>(sql`
    SELECT e.account_id, t.kind, SUM(e.amount)::text AS total
    FROM gm_entries e JOIN gm_transactions t ON t.id = e.tx_id
    WHERE e.account_id IN (${sql.join([...MINT_SHARDS, ...BURN_SHARDS, SYS_PURSE].map((id) => sql`${id}`), sql`, `)})
      AND e.created_at >= ${opts.from.toISOString()}::timestamptz AND e.created_at < ${opts.to.toISOString()}::timestamptz
    GROUP BY e.account_id, t.kind`);
  const created: Record<string, number> = {};
  const destroyed: Record<string, number> = {};
  for (const r of rows) {
    const n = Number(r.total);
    if (isMintAccount(r.account_id)) created[r.kind] = (created[r.kind] ?? 0) - n;
    else destroyed[r.kind] = (destroyed[r.kind] ?? 0) + n;
  }
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  const totalCreated = sum(created);
  const totalDestroyed = sum(destroyed);

  // Median balance of residents who said gm in the window.
  const [med] = await db.execute<{ median: string | null }>(sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY a.balance)::text AS median
    FROM gm_accounts a
    WHERE a.kind = 'user' AND a.user_id IN (
      SELECT user_id FROM daily_gm WHERE said_at >= ${opts.from.toISOString()}::timestamptz AND said_at < ${opts.to.toISOString()}::timestamptz)`);
  const median = med?.median === null || med?.median === undefined ? null : Number(med.median);
  const activeWeeklyIncome = 7 * GM.drip + 7 * GM.streakBonusCap + 7 * SHIFT.perDay * shiftPay(8); // 679, the plan's active row

  return {
    created,
    destroyed,
    totalCreated,
    totalDestroyed,
    ratio: totalCreated === 0 ? null : totalDestroyed / totalCreated,
    healthyRatio: totalCreated === 0 ? null : totalDestroyed / totalCreated >= 0.9 && totalDestroyed / totalCreated <= 1.1,
    medianActiveBalance: median,
    medianWeeksOfIncome: median === null ? null : median / activeWeeklyIncome,
    activeWeeklyIncome,
  };
}
