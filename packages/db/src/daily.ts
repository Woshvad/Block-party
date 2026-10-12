import { GM, GRUDGE, STREAK_PIECES, type StreakState, advanceStreak, cityDay, dripFor, mintAccountFor, nextBell, streakView, userAccountId } from "@bp/core";
import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./client";
import { grantEarned } from "./home";
import { burn, lockAccounts, mint } from "./ledger";
import { badges, cityPositions, dailyGm, duels, gmEntries, gmAccounts, gmTransactions, grudgeMatches, streakDays, streaks, users } from "./schema";

export class DailyError extends Error {
  constructor(readonly code: "UNKNOWN_USER" | "HODL_FULL", message: string) {
    super(message);
    this.name = "DailyError";
  }
}

// --- Net worth for the broke floor ----------------------------------------

// Balance, plus furniture/decor/wardrobe burned in the last 7 days (so buying
// a sofa never doubles the drip), plus open GM stakes. The wallet never counts.
export async function gmNetWorth(db: Db, userId: string, now = new Date()): Promise<number> {
  const acct = userAccountId(userId);
  const since = new Date(now.getTime() - GM.netWorthBurnLookbackDays * 86_400_000);
  const [bal] = await db.select({ balance: gmAccounts.balance }).from(gmAccounts).where(eq(gmAccounts.id, acct));
  const [recent] = await db
    .select({ spent: sql<string>`COALESCE(SUM(-${gmEntries.amount}), 0)` })
    .from(gmEntries)
    .innerJoin(gmTransactions, eq(gmTransactions.id, gmEntries.txId))
    .where(
      and(
        eq(gmEntries.accountId, acct),
        inArray(gmTransactions.kind, [...GM.netWorthBurnKinds]),
        gte(gmEntries.createdAt, since),
      ),
    );
  return (bal?.balance ?? 0) + Number(recent?.spent ?? 0) + (await openGmStakes(db, userId));
}

// GM a resident has out on stakes that haven't settled yet: their City market
// stakes, Fade Duel stakes and Grudge Match stakes. It's still theirs, so it
// counts toward the broke floor and toward rent; parking GM in a stake
// mustn't make anyone look poorer than they are. Syndicate stakes and Tower
// Lights bids are left out: they come from a crew pot, which belongs to no
// one resident.
export async function openGmStakes(db: Db, userId: string): Promise<number> {
  // A City position gets its payout (0 for a loss) when its market settles.
  const [city] = await db
    .select({ n: sql<string>`COALESCE(SUM(${cityPositions.stake}), 0)` })
    .from(cityPositions)
    .where(and(eq(cityPositions.userId, userId), isNull(cityPositions.payout)));
  // An offered duel holds the challenger's stake; the opponent's is 0 until they accept.
  const [duel] = await db
    .select({ n: sql<string>`COALESCE(SUM(CASE WHEN ${duels.challengerId} = ${userId} THEN ${duels.stakeChallenger} ELSE ${duels.stakeOpponent} END), 0)` })
    .from(duels)
    .where(and(or(eq(duels.challengerId, userId), eq(duels.opponentId, userId)), inArray(duels.status, ["offered", "active"])));
  // An offered match holds the newcomer's stake; an active one holds both.
  const [grudge] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(grudgeMatches)
    .where(
      or(
        and(eq(grudgeMatches.newcomerId, userId), inArray(grudgeMatches.status, ["offered", "active"])),
        and(eq(grudgeMatches.inviterId, userId), eq(grudgeMatches.status, "active")),
      ),
    );
  return Number(city!.n) + Number(duel!.n) + grudge!.n * GRUDGE.stake;
}

// --- gm and the drip ------------------------------------------------------

export type GmResult = {
  cityDay: string;
  already: boolean;
  drip: number;
  brokeFloor: boolean;
  balance: number;
};

export async function sayGm(db: Db, userId: string, opts: { now?: Date } = {}): Promise<GmResult> {
  const now = opts.now ?? new Date();
  const day = cityDay(now);
  return db.transaction(async (tx) => {
    // Serialises gm, sign-in and Hodl purchases for this resident.
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("no key update");
    if (!u) throw new DailyError("UNKNOWN_USER", "no such resident");

    const [existing] = await tx
      .select()
      .from(dailyGm)
      .where(and(eq(dailyGm.userId, userId), eq(dailyGm.cityDay, day)));
    const acct = userAccountId(userId);
    if (existing) {
      const [b] = await tx.select({ balance: gmAccounts.balance }).from(gmAccounts).where(eq(gmAccounts.id, acct));
      return { cityDay: day, already: true, drip: existing.drip, brokeFloor: existing.brokeFloor, balance: b!.balance };
    }

    // Read under the wallet's lock (taken as the mint below will take it, in
    // the ledger's order), as rent does: a stake paying out between reading
    // the balance and reading the open stakes would count in neither.
    await lockAccounts(tx, [mintAccountFor(acct), acct]);
    const netWorth = await gmNetWorth(tx, userId, now);
    const { amount, brokeFloor } = dripFor(netWorth);
    const res = await mint(tx, {
      accountId: acct,
      amount,
      kind: "drip",
      idempotencyKey: `drip:${userId}:${day}`,
      meta: { cityDay: day, brokeFloor },
    });
    await tx.insert(dailyGm).values({ userId, cityDay: day, drip: amount, brokeFloor, netWorth, txId: res.txId, saidAt: now });
    return { cityDay: day, already: false, drip: amount, brokeFloor, balance: res.balances[acct]! };
  });
}

// --- Streak ---------------------------------------------------------------

async function lockStreak(tx: Db, userId: string): Promise<StreakState> {
  await tx.insert(streaks).values({ userId }).onConflictDoNothing();
  const [row] = await tx.select().from(streaks).where(eq(streaks.userId, userId)).for("no key update");
  return { current: row!.current, longest: row!.longest, lastDay: row!.lastDay, hodlDays: row!.hodlDays };
}

// Called when a resident does the day's qualifying thing. The plan counts
// days with a call, so the calls brick fires this on a resident's first
// locked call of the city day.
export async function recordStreakDay(db: Db, userId: string, opts: { now?: Date } = {}) {
  const day = cityDay(opts.now ?? new Date());
  return db.transaction(async (tx) => {
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("no key update");
    if (!u) throw new DailyError("UNKNOWN_USER", "no such resident");

    const before = await lockStreak(tx, userId);
    const r = advanceStreak(before, day);
    if (!r.changed) return { ...r, cityDay: day };

    await tx
      .update(streaks)
      .set({ ...r.state, updatedAt: new Date() })
      .where(eq(streaks.userId, userId));
    await tx.insert(streakDays).values([
      ...r.coveredDays.map((d) => ({ userId, cityDay: d, kind: "hodl" as const })),
      { userId, cityDay: day, kind: "played" as const },
    ]);
    await mint(tx, {
      accountId: userAccountId(userId),
      amount: r.bonus,
      kind: "streak_bonus",
      idempotencyKey: `streak_bonus:${userId}:${day}`,
      meta: { cityDay: day, streak: r.state.current },
    });
    if (r.cards.length) {
      await tx
        .insert(badges)
        .values(r.cards.map((n) => ({ userId, badge: `streak_${n}`, earnedOn: day })))
        .onConflictDoNothing();
      // The 30-day gm lamp and the 100-day neon: earned, never sold.
      for (const n of r.cards) if (STREAK_PIECES[n]) await grantEarned(tx, userId, STREAK_PIECES[n]);
    }
    return { ...r, cityDay: day };
  });
}

// --- Hodl Days ------------------------------------------------------------

export async function buyHodlDay(db: Db, userId: string, idempotencyKey: string) {
  return db.transaction(async (tx) => {
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("no key update");
    if (!u) throw new DailyError("UNKNOWN_USER", "no such resident");
    const s = await lockStreak(tx, userId);

    if (s.hodlDays >= GM.hodlDayMax) {
      // A retry of a purchase that already went through is not an error.
      const [prior] = await tx
        .select({ id: gmTransactions.id })
        .from(gmTransactions)
        .where(eq(gmTransactions.idempotencyKey, idempotencyKey));
      if (prior) return { replayed: true, hodlDays: s.hodlDays };
      throw new DailyError("HODL_FULL", `you can hold at most ${GM.hodlDayMax} Hodl Days`);
    }

    const res = await burn(tx, {
      accountId: userAccountId(userId),
      amount: GM.hodlDayPrice,
      kind: "hodl_day",
      idempotencyKey,
    });
    if (res.replayed) return { replayed: true, hodlDays: s.hodlDays };

    await tx
      .update(streaks)
      .set({ hodlDays: s.hodlDays + 1, updatedAt: new Date() })
      .where(eq(streaks.userId, userId));
    return { replayed: false, hodlDays: s.hodlDays + 1 };
  });
}

// --- Move-in --------------------------------------------------------------

// Paid once, when a resident claims their account: the 1,000 GM gift and one
// Hodl Day. Idempotent on the resident, so a retried claim pays nothing more.
export async function grantMoveIn(tx: Db, userId: string) {
  const res = await mint(tx, {
    accountId: userAccountId(userId),
    amount: GM.moveInGift,
    kind: "move_in",
    idempotencyKey: `move_in:${userId}`,
  });
  if (res.replayed) return;
  await tx.insert(streaks).values({ userId, hodlDays: GM.hodlDayAtMoveIn }).onConflictDoUpdate({
    target: streaks.userId,
    set: { hodlDays: sql`LEAST(${GM.hodlDayMax}, ${streaks.hodlDays} + ${GM.hodlDayAtMoveIn})`, updatedAt: new Date() },
  });
}

// --- The Today sheet ------------------------------------------------------

export async function today(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const day = cityDay(now);
  const [s] = await db.select().from(streaks).where(eq(streaks.userId, userId));
  const state: StreakState = s
    ? { current: s.current, longest: s.longest, lastDay: s.lastDay, hodlDays: s.hodlDays }
    : { current: 0, longest: 0, lastDay: null, hodlDays: 0 };
  const [gm] = await db
    .select({ drip: dailyGm.drip })
    .from(dailyGm)
    .where(and(eq(dailyGm.userId, userId), eq(dailyGm.cityDay, day)));
  return {
    cityDay: day,
    bellAt: nextBell(now),
    saidGm: !!gm,
    ...streakView(state, day),
    longest: state.longest,
    hodlDays: state.hodlDays,
  };
}
