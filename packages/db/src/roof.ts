import { CAST, SIZE_GROUPS, addDays, cityDay } from "@bp/core";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import type { Db } from "./client";
import { hiddenFor } from "./chat";
import { seasonStack } from "./city-markets";
import { crewBellScores, crews, leagueWeeks } from "./schema";
import { TowerError, rightList } from "./tower";

// The Roof's screens. The plan puts the Right List beside the Season Stack,
// with NOTHING-9000's row ("everyone above this line beat a bot that says no
// to everything"), and Sunday's bell brings the Crew League up here. Handles,
// crew names and scores only: never a user id, a stake or anything about
// real money. Anyone this reader has blocked, is blocked by or has muted is
// left out before a list is cut, as on the Boards; ranks stay the city's, so
// a left-out row is a gap, never a reshuffle. It all moves at the bell.

export const ROOF_ROWS = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOT = CAST.nothing_9000.id;

export async function roofBoards(db: Db, readerId: unknown, opts: { now?: Date } = {}) {
  if (typeof readerId !== "string" || !UUID.test(readerId)) throw new TowerError("INVALID_INPUT", "who's looking?");
  const now = opts.now ?? new Date();
  const today = cityDay(now);
  // The last bell rang at the start of today and closed yesterday.
  const bellDay = addDays(today, -1);
  const [hidden, right, stack, scores, [latest]] = await Promise.all([
    hiddenFor(db, readerId.toLowerCase(), now),
    // Asking as NOTHING-9000 gives its row wherever it ranks.
    rightList(db, { now, limit: 100, userId: BOT }),
    seasonStack(db, { now, limit: 100 }),
    db
      .select({ name: crews.name, scoreMilli: crewBellScores.scoreMilli })
      .from(crewBellScores)
      .innerJoin(crews, eq(crews.id, crewBellScores.crewId))
      .where(eq(crewBellScores.bellDay, bellDay))
      .orderBy(desc(crewBellScores.scoreMilli), asc(crewBellScores.crewId))
      .limit(3),
    db.select({ week: leagueWeeks.week }).from(leagueWeeks).where(lte(leagueWeeks.week, today)).orderBy(desc(leagueWeeks.week)).limit(1),
  ]);
  const shown = (id: string) => !hidden.has(id);
  const champions = latest
    ? await db
        .select({ sizeGroup: leagueWeeks.sizeGroup, name: crews.name })
        .from(leagueWeeks)
        .innerJoin(crews, eq(crews.id, leagueWeeks.crewId))
        .where(and(eq(leagueWeeks.week, latest.week), eq(leagueWeeks.champion, true)))
    : [];
  const group = (k: string) => SIZE_GROUPS.findIndex((g) => g.key === k);
  return {
    bellAt: new Date(`${today}T00:00:00Z`),
    season: right.season,
    rightList: {
      rows: right.rows
        .filter((r) => r.handle !== null && shown(r.userId))
        .slice(0, ROOF_ROWS)
        .map((r) => ({ rank: r.rank, handle: r.handle!, npc: r.npc, perCall: r.perCall, spread: r.spread, rusty: r.rusty })),
      // Where the line goes; null until the bot has its 10 settled calls.
      bot: right.me && shown(BOT) ? { rank: right.me.rank, perCall: right.me.perCall, spread: right.me.spread } : null,
    },
    seasonStack: {
      rows: stack.rows
        .filter((r) => r.handle !== null && shown(r.userId))
        .slice(0, ROOF_ROWS)
        .map((r) => ({ rank: r.rank, handle: r.handle!, profit: r.profit })),
    },
    crews: {
      bellDay,
      bellScores: scores.map((s, i) => ({ rank: i + 1, name: s.name, score: s.scoreMilli / 1000 })),
      league: latest
        ? { week: latest.week, champions: champions.sort((a, b) => group(a.sizeGroup) - group(b.sizeGroup)).map((c) => ({ sizeGroup: c.sizeGroup, name: c.name })) }
        : null,
    },
  };
}
