import { ALTS, type CityDay, type PairFlow, addDays, altFlag, cityDay, marketPairFlows } from "@bp/core";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { isStaff } from "./safety";
import { altFlags, cityMarkets, cityPositions, duels, grudgeMatches } from "./schema";

const dayStart = (d: CityDay) => new Date(`${d}T00:00:00Z`);

// Every GM flow between two residents over the window: duels (and retreats),
// Grudge Matches, and City markets (losers to winners, by stake). Crew pots
// never pay members, so they carry no pair flow.
export async function pairFlows(db: Db, from: Date, to: Date): Promise<PairFlow[]> {
  const flows: Array<{ from: string; to: string; amount: number }> = [];
  const ds = await db
    .select()
    .from(duels)
    .where(and(inArray(duels.status, ["settled", "retreated"]), gte(duels.endedAt, from), sql`${duels.endedAt} < ${to.toISOString()}::timestamptz`));
  for (const d of ds) {
    if (d.status === "settled") {
      const loser = d.winnerId === d.challengerId ? d.opponentId : d.challengerId;
      flows.push({ from: loser, to: d.winnerId!, amount: loser === d.challengerId ? d.stakeChallenger : d.stakeOpponent });
    } else {
      const other = d.retreatedBy === d.challengerId ? d.opponentId : d.challengerId;
      flows.push({ from: d.retreatedBy!, to: other, amount: 10 });
    }
  }
  const gs = await db
    .select()
    .from(grudgeMatches)
    .where(and(eq(grudgeMatches.status, "settled"), gte(grudgeMatches.endedAt, from), sql`${grudgeMatches.endedAt} < ${to.toISOString()}::timestamptz`));
  for (const g of gs) flows.push({ from: g.winnerId === g.newcomerId ? g.inviterId : g.newcomerId, to: g.winnerId!, amount: 10 });
  const ms = await db
    .select({ id: cityMarkets.id, outcome: cityMarkets.outcome })
    .from(cityMarkets)
    .where(and(eq(cityMarkets.status, "settled"), gte(cityMarkets.bellDay, cityDay(from)), sql`${cityMarkets.bellDay} < ${cityDay(to)}`));
  if (ms.length) {
    const ps = await db
      .select({ marketId: cityPositions.marketId, userId: cityPositions.userId, side: cityPositions.side, stake: cityPositions.stake })
      .from(cityPositions)
      .where(and(inArray(cityPositions.marketId, ms.map((m) => m.id)), sql`${cityPositions.userId} IS NOT NULL`));
    for (const m of ms) {
      const mine = ps.filter((p) => p.marketId === m.id).map((p) => ({ userId: p.userId!, side: p.side, stake: p.stake }));
      flows.push(...marketPairFlows(mine, m.outcome!));
    }
  }
  const pairs = new Map<string, PairFlow>();
  for (const f of flows) {
    if (f.from === f.to) continue;
    const [a, b] = f.from < f.to ? [f.from, f.to] : [f.to, f.from];
    const p = pairs.get(`${a}|${b}`) ?? { a, b, ab: 0, ba: 0 };
    if (f.from === a) p.ab += f.amount;
    else p.ba += f.amount;
    pairs.set(`${a}|${b}`, p);
  }
  return [...pairs.values()];
}

// Nightly: flag every pair over the line in the last 14 days (once a day).
export async function runAltChecks(db: Db, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const today = cityDay(now);
  const flows = await pairFlows(db, dayStart(addDays(today, -ALTS.windowDays)), dayStart(addDays(today, 1)));
  let flagged = 0;
  for (const f of flows) {
    const flag = altFlag(f);
    if (!flag) continue;
    const [r] = await db
      .insert(altFlags)
      .values({ cityDay: today, low: f.a, high: f.b, fromUser: flag.from, toUser: flag.to, amount: flag.amount, back: flag.back, createdAt: now })
      .onConflictDoNothing()
      .returning();
    if (r) flagged++;
  }
  return { pairs: flows.length, flagged };
}

// Flagged in the last 14 days?
export async function isFlaggedPair(db: Db, x: string, y: string, now = new Date()) {
  const [a, b] = x < y ? [x, y] : [y, x];
  const [f] = await db
    .select({ day: altFlags.cityDay })
    .from(altFlags)
    .where(and(eq(altFlags.low, a), eq(altFlags.high, b), gte(altFlags.cityDay, addDays(cityDay(now), -ALTS.windowDays))))
    .limit(1);
  return !!f;
}

export async function staffAltFlags(db: Db, staffId: string, opts: { limit?: number } = {}) {
  if (!(await isStaff(db, staffId))) return null;
  return db
    .select()
    .from(altFlags)
    .orderBy(desc(altFlags.cityDay), desc(altFlags.amount))
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
}

