import { CREW, addDays, chainHolds, chainLength, chainThreshold, cityDay, daysBetween } from "@bp/core";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { crewChainDays, crewChainRelights, crewMembers, crews } from "./schema";

export class ChainError extends Error {
  constructor(
    readonly code: "NOT_IN_CREW" | "NOTHING_TO_RELIGHT" | "NOT_A_MEMBER_THAT_DAY" | "NO_SUCH_CREW",
    message: string,
  ) {
    super(message);
    this.name = "ChainError";
  }
}

const bellAfter = (day: string) => new Date(`${addDays(day, 1)}T00:00:00.000Z`);

type Counts = { members: number; active: number; gms: number };

// Who counts for day D: members on the roster when D's bell rang.
async function countsFor(db: Db, crewId: string, day: string): Promise<Counts> {
  const bell = bellAfter(day).toISOString();
  const windowStart = addDays(day, -(CREW.chainActiveWindowDays - 1));
  const rows = await db.execute<{ members: number; active: number; gms: number }>(sql`
    WITH m AS (
      SELECT user_id FROM crew_members
      WHERE crew_id = ${crewId} AND joined_at < ${bell}::timestamptz
        AND (left_at IS NULL OR left_at >= ${bell}::timestamptz)
    )
    SELECT
      (SELECT count(*)::int FROM m) AS members,
      (SELECT count(DISTINCT g.user_id)::int FROM daily_gm g JOIN m USING (user_id)
         WHERE g.city_day BETWEEN ${windowStart}::date AND ${day}::date) AS active,
      (SELECT count(*)::int FROM daily_gm g JOIN m USING (user_id) WHERE g.city_day = ${day}::date) AS gms
  `);
  return [...rows][0]!;
}

// Settles every unsettled day from the crew's first day up to yesterday, in
// order. Idempotent and safe to run from many places at once; the bell job
// calls it for every crew, and reads call it lazily.
export async function settleCrewChain(db: Db, crewId: string, opts: { now?: Date } = {}) {
  const today = cityDay(opts.now ?? new Date());
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"crew_chain:" + crewId}))`);
    const [c] = await tx.select().from(crews).where(eq(crews.id, crewId));
    if (!c) throw new ChainError("NO_SUCH_CREW", "no such crew");
    const [last] = await tx
      .select({ day: crewChainDays.cityDay })
      .from(crewChainDays)
      .where(eq(crewChainDays.crewId, crewId))
      .orderBy(desc(crewChainDays.cityDay))
      .limit(1);
    let day = last ? addDays(last.day, 1) : cityDay(c.createdAt);
    // A crew dissolved during day X never reaches X's bell.
    const end = c.dissolvedAt ? minDay(addDays(today, -1), addDays(cityDay(c.dissolvedAt), -1)) : addDays(today, -1);
    let settled = 0;
    while (daysBetween(day, end) >= 0) {
      const n = await countsFor(tx, crewId, day);
      await tx
        .insert(crewChainDays)
        .values({ crewId, cityDay: day, ...n, held: chainHolds(n.active, n.gms) })
        .onConflictDoNothing();
      settled++;
      day = addDays(day, 1);
    }
    return { settled };
  });
}

const minDay = (a: string, b: string) => (a < b ? a : b);

async function membershipCrew(db: Db, userId: string) {
  const [m] = await db
    .select({ crewId: crewMembers.crewId })
    .from(crewMembers)
    .where(and(eq(crewMembers.userId, userId), sql`${crewMembers.leftAt} IS NULL`));
  if (!m) throw new ChainError("NOT_IN_CREW", "you're not in a crew");
  return m.crewId;
}

// The crew's chain, and today's progress toward keeping it. Counts only.
export async function chainStatus(db: Db, crewId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const today = cityDay(now);
  await settleCrewChain(db, crewId, { now });
  const days = await db
    .select({ day: crewChainDays.cityDay, held: crewChainDays.held, relit: crewChainDays.relit })
    .from(crewChainDays)
    .where(eq(crewChainDays.crewId, crewId))
    .orderBy(desc(crewChainDays.cityDay))
    .limit(400);
  const { length, needsRelight } = chainLength(days, today);
  const t = await countsFor(db, crewId, today);
  let relightVotes = 0;
  if (needsRelight) {
    const [v] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(crewChainRelights)
      .where(and(eq(crewChainRelights.crewId, crewId), eq(crewChainRelights.cityDay, needsRelight)));
    relightVotes = v!.n;
  }
  return {
    length,
    needsRelight,
    relightVotes,
    relightNeeded: CREW.relightVotes,
    today: { gms: t.gms, active: t.active, needed: chainThreshold(t.active) },
  };
}

// Any 3 members can relight yesterday's missed chain before tonight's bell.
// A voter must have been on the roster at that day's bell, so inviting alts
// in to relight doesn't work.
export async function relightChain(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const crewId = await membershipCrew(db, userId);
  await settleCrewChain(db, crewId, { now });
  const target = addDays(cityDay(now), -1);
  return db.transaction(async (tx) => {
    const [d] = await tx
      .select()
      .from(crewChainDays)
      .where(and(eq(crewChainDays.crewId, crewId), eq(crewChainDays.cityDay, target)))
      .for("update");
    if (!d || d.held) throw new ChainError("NOTHING_TO_RELIGHT", "the chain doesn't need relighting");
    const bell = bellAfter(target).toISOString();
    const [wasMember] = await tx.execute<{ ok: number }>(sql`
      SELECT 1 AS ok FROM crew_members WHERE crew_id = ${crewId} AND user_id = ${userId}
        AND joined_at < ${bell}::timestamptz AND (left_at IS NULL OR left_at >= ${bell}::timestamptz)`);
    if (!wasMember) throw new ChainError("NOT_A_MEMBER_THAT_DAY", "only members from that day can relight it");
    // Votes after the third still land, so five crewmates tapping at once
    // all see success rather than an error.
    await tx.insert(crewChainRelights).values({ crewId, cityDay: target, userId }).onConflictDoNothing();
    const [v] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(crewChainRelights)
      .where(and(eq(crewChainRelights.crewId, crewId), eq(crewChainRelights.cityDay, target)));
    const relit = v!.n >= CREW.relightVotes;
    if (relit && !d.relit) {
      await tx
        .update(crewChainDays)
        .set({ relit: true })
        .where(and(eq(crewChainDays.crewId, crewId), eq(crewChainDays.cityDay, target)));
    }
    return { votes: v!.n, relit };
  });
}
