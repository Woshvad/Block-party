import { type CityDay, LEAGUE, NPC_IDS, SIZE_GROUPS, type SizeGroup, addDays, leagueScore, promote, sizeGroupOf, weekStart } from "@bp/core";
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "./client";
import { calls, crewLeague, crewMembers, crews, leagueWeeks, markets, slateCards } from "./schema";

const dayStart = (d: CityDay) => new Date(`${d}T00:00:00Z`);

// The week's score for each crew with 5+ callers (null otherwise).
async function weekScores(db: Db, week: CityDay, crewIds: string[]) {
  const from = dayStart(week);
  const to = dayStart(addDays(week, 7));
  const members = crewIds.length
    ? await db
        .select({ crewId: crewMembers.crewId, userId: crewMembers.userId })
        .from(crewMembers)
        .where(and(inArray(crewMembers.crewId, crewIds), isNull(crewMembers.leftAt)))
    : [];
  const ids = members.map((m) => m.userId).filter((u) => !NPC_IDS.includes(u));
  // Callers: anyone with a locked call this week. Aura: settled calls on markets resolved this week.
  const lockedThisWeek = ids.length
    ? await db
        .select({ userId: calls.userId, marketId: calls.marketId, onSlate: calls.onSlate })
        .from(calls)
        .where(and(inArray(calls.userId, ids), eq(calls.status, "locked"), gte(calls.lockedAt, from), lt(calls.lockedAt, to)))
    : [];
  const aura = ids.length
    ? await db
        .select({ userId: calls.userId, sum: sql<number>`SUM(${calls.auraCenti})::int` })
        .from(calls)
        .innerJoin(markets, eq(markets.id, calls.marketId))
        .where(and(inArray(calls.userId, ids), eq(calls.status, "locked"), sql`${calls.auraCenti} IS NOT NULL`, sql`${calls.via} IS DISTINCT FROM 'tail'`, gte(markets.resolvedAt, from), lt(markets.resolvedAt, to)))
        .groupBy(calls.userId)
    : [];
  const auraOf = new Map(aura.map((a) => [a.userId, a.sum]));
  // Full Slates: per night, members who locked every card.
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const cards = await db.select({ day: slateCards.cityDay, marketId: slateCards.marketId }).from(slateCards).where(inArray(slateCards.cityDay, days));
  const fullBy = new Map<string, Set<string>>(); // day -> users with a full Slate
  for (const d of days) {
    const dayCards = new Set(cards.filter((c) => c.day === d).map((c) => c.marketId));
    if (!dayCards.size) continue;
    const per = new Map<string, number>();
    for (const c of lockedThisWeek) if (c.onSlate && dayCards.has(c.marketId)) per.set(c.userId, (per.get(c.userId) ?? 0) + 1);
    fullBy.set(d, new Set([...per.entries()].filter(([, n]) => n === dayCards.size).map(([u]) => u)));
  }
  const scores = new Map<string, number | null>();
  for (const crewId of crewIds) {
    const mine = members.filter((m) => m.crewId === crewId).map((m) => m.userId);
    const callers = new Set(lockedThisWeek.filter((c) => mine.includes(c.userId)).map((c) => c.userId));
    if (callers.size < LEAGUE.minCallers) {
      scores.set(crewId, null);
      continue;
    }
    const nights = days.map((d) => [...(fullBy.get(d) ?? [])].filter((u) => mine.includes(u)).length);
    scores.set(crewId, leagueScore([...callers].map((u) => auraOf.get(u) ?? 0), nights));
  }
  return scores;
}

// Sunday's close (the Monday bell): the week's table, then promotion and relegation.
export async function runLeague(db: Db, bellDay: CityDay, now: Date) {
  const week = weekStart(bellDay);
  const live = await db
    .select({ id: crews.id, members: sql<number>`count(${crewMembers.id})::int` })
    .from(crews)
    .leftJoin(crewMembers, and(eq(crewMembers.crewId, crews.id), isNull(crewMembers.leftAt)))
    .where(isNull(crews.dissolvedAt))
    .groupBy(crews.id);
  const groupOf = new Map(live.map((c) => [c.id, sizeGroupOf(c.members)]));
  const scores = await weekScores(db, week, live.filter((c) => groupOf.get(c.id)).map((c) => c.id));
  let recorded = 0;
  for (const g of SIZE_GROUPS) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`league:${g.key}`}))`);
      const [done] = await tx.select({ n: sql<number>`count(*)::int` }).from(leagueWeeks).where(and(eq(leagueWeeks.week, week), eq(leagueWeeks.sizeGroup, g.key)));
      if (done!.n > 0) return; // this week's table is already in
      const old = await tx.select().from(crewLeague).where(eq(crewLeague.sizeGroup, g.key)).orderBy(asc(crewLeague.place));
      // Keep crews still in this group in their places; newcomers (and crews
      // that changed size) start at the bottom.
      const ladder = old.filter((r) => groupOf.get(r.crewId) === g.key).map((r) => r.crewId);
      for (const c of live) if (groupOf.get(c.id) === g.key && !ladder.includes(c.id)) ladder.push(c.id);
      if (!ladder.length) {
        await tx.delete(crewLeague).where(eq(crewLeague.sizeGroup, g.key));
        return;
      }
      const s = new Map(ladder.map((c) => [c, scores.get(c) ?? null]));
      const next = promote(ladder, s);
      // Ranks inside each division before the moves, for the cards.
      for (let d = 0; d * LEAGUE.divisionSize < ladder.length; d++) {
        const div = ladder.slice(d * LEAGUE.divisionSize, (d + 1) * LEAGUE.divisionSize);
        const ranked = [...div].sort((a, b) => {
          const sa = s.get(a) ?? null;
          const sb = s.get(b) ?? null;
          if (sa === null || sb === null) return sa === null && sb === null ? ladder.indexOf(a) - ladder.indexOf(b) : sa === null ? 1 : -1;
          return sb - sa || ladder.indexOf(a) - ladder.indexOf(b);
        });
        for (const [i, crewId] of ranked.entries()) {
          const before = Math.floor(ladder.indexOf(crewId) / LEAGUE.divisionSize);
          const after = Math.floor(next.indexOf(crewId) / LEAGUE.divisionSize);
          const sc = s.get(crewId) ?? null;
          await tx.insert(leagueWeeks).values({
            week,
            crewId,
            sizeGroup: g.key,
            division: d + 1,
            rank: i + 1,
            score: sc === null ? null : Math.round(sc * 1000),
            moved: after < before ? "up" : after > before ? "down" : "stayed",
            champion: d === 0 && i === 0 && sc !== null,
          });
          recorded++;
        }
      }
      await tx.delete(crewLeague).where(eq(crewLeague.sizeGroup, g.key));
      await tx.insert(crewLeague).values(next.map((crewId, place) => ({ crewId, sizeGroup: g.key as SizeGroup, place })));
    });
  }
  return { week, recorded };
}

// A crew's league card for its latest week, and this week's champions (the banners).
export async function leagueCard(db: Db, crewId: string) {
  const [row] = await db.select().from(leagueWeeks).where(eq(leagueWeeks.crewId, crewId)).orderBy(desc(leagueWeeks.week)).limit(1);
  if (!row) return null;
  return { week: row.week, sizeGroup: row.sizeGroup, division: row.division, rank: row.rank, score: row.score === null ? null : row.score / 1000, moved: row.moved, champion: row.champion };
}

export async function leagueChampions(db: Db) {
  const [last] = await db.select({ week: leagueWeeks.week }).from(leagueWeeks).orderBy(desc(leagueWeeks.week)).limit(1);
  if (!last) return [];
  return db
    .select({ sizeGroup: leagueWeeks.sizeGroup, crewId: leagueWeeks.crewId, name: crews.name })
    .from(leagueWeeks)
    .innerJoin(crews, eq(crews.id, leagueWeeks.crewId))
    .where(and(eq(leagueWeeks.week, last.week), eq(leagueWeeks.champion, true)));
}
