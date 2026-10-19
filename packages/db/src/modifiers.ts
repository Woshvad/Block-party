import { CAST, type CityDay, NOTHING_DAY_TILE, NPC_IDS, beatsBot, cityMajority } from "@bp/core";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./client";
import { grantEarned } from "./home";
import { calls, contrarianCards, markets, nothingDayGrids, nothingDayWins, slateCards, slates } from "./schema";
import { cityCalls } from "./tower";

// The Bell Modifier's results, settled once per bell (runBell records the
// step): Contrarian Day's city majorities, and NOTHING Day's banner tiles.
// Neither touches Aura, GM or real trades: a gold border and a home piece.

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function stepModifier(db: Db, bellDay: CityDay, now: Date) {
  // Checked first: an undefined parameter can stall postgres.js's pool.
  if (typeof bellDay !== "string" || !DAY.test(bellDay) || !(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("stepModifier needs a city day and a time");
  const [s] = await db.select({ modifier: slates.modifier }).from(slates).where(eq(slates.cityDay, bellDay));
  if (!s) return { modifier: null };
  if (s.modifier === "contrarian_day") return { modifier: s.modifier, ...(await recordMajorities(db, bellDay, now)) };
  if (s.modifier === "nothing_day") return { modifier: s.modifier, ...(await payBannerTiles(db, bellDay, now)) };
  // Blind Slate has nothing to settle: it only hides the crew's sides until now.
  return { modifier: s.modifier };
}

// Contrarian Day. The majority is measured at the freeze, not when each call
// locks: at lock time the first callers face a handful of calls (or none), and
// anyone who learns the lean from a friend could take the other side on
// purpose. At the freeze nobody can still move it after they've locked, and
// every call on the card is judged against the same final count. No call locks
// after its card freezes, so the bell counts the City bar's own calls
// (neighbours only, never the cast) as the bar stood at the freeze: a Proof of
// Neighbour stamped between the freeze and the bell doesn't count. It records
// them once, so one stamped later can't change a border either. A card still
// taking calls at the bell (its freeze moved past it) has no final count, so it
// gets no row.
async function recordMajorities(db: Db, day: CityDay, now: Date) {
  const cards = await db
    .select({ marketId: slateCards.marketId, status: markets.status, freezesAt: markets.freezesAt })
    .from(slateCards)
    .innerJoin(markets, eq(markets.id, slateCards.marketId))
    .where(eq(slateCards.cityDay, day));
  const final = cards.filter((c) => c.status !== "open" || c.freezesAt <= now);
  const neighbours = await cityCalls(db, final.map((c) => c.marketId), { atFreeze: true });
  const rows = final.map((c) => {
    const mine = neighbours.filter((n) => n.marketId === c.marketId);
    const yes = mine.filter((n) => n.side === "yes").length;
    const no = mine.length - yes;
    return { cityDay: day, marketId: c.marketId, yes, no, majority: cityMajority(yes, no), recordedAt: now };
  });
  // A replayed step finds them recorded and keeps the first count.
  if (rows.length) await db.insert(contrarianCards).values(rows).onConflictDoNothing();
  return { cards: rows.length, majorities: rows.filter((r) => r.majority !== null).length };
}

// NOTHING Day: every resident whose Slate Aura beat NOTHING-9000's grid wins
// the day; the first win brings the banner tile. Each grid is totalled the way
// the grid counts it (Slate calls only, an unsettled square is 0), and every
// resident's total is recorded with the bot's: a card that settles after the
// bell moves the grids, never the verdict, and the verdict keeps its numbers.
async function payBannerTiles(db: Db, day: CityDay, now: Date) {
  const ids = (await db.select({ marketId: slateCards.marketId }).from(slateCards).where(eq(slateCards.cityDay, day))).map((c) => c.marketId);
  const locked = ids.length
    ? await db
        .select({ userId: calls.userId, aura: calls.auraCenti })
        .from(calls)
        .where(and(inArray(calls.marketId, ids), eq(calls.status, "locked"), eq(calls.onSlate, true)))
    : [];
  const totals = new Map<string, number>();
  for (const c of locked) totals.set(c.userId, (totals.get(c.userId) ?? 0) + (c.aura ?? 0));
  const bot = totals.get(CAST.nothing_9000.id) ?? null;
  // Sorted, so two racing runs insert in the same order and can't deadlock.
  const judged = [...totals]
    .filter(([userId]) => !NPC_IDS.includes(userId))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([userId, aura]) => ({ cityDay: day, userId, auraCenti: aura, botAuraCenti: bot, at: now }));
  // All or none, and a replayed step keeps the first count.
  await db.transaction(async (tx) => {
    for (let i = 0; i < judged.length; i += 1000) await tx.insert(nothingDayGrids).values(judged.slice(i, i + 1000)).onConflictDoNothing();
  });
  // Paid from that record, so a replay judges by the bell's count too.
  const record = await db
    .select({ userId: nothingDayGrids.userId, aura: nothingDayGrids.auraCenti, bot: nothingDayGrids.botAuraCenti })
    .from(nothingDayGrids)
    .where(eq(nothingDayGrids.cityDay, day));
  let winners = 0;
  let tiles = 0;
  for (const r of record) {
    if (!beatsBot(r.aura, r.bot)) continue;
    const won = await db.transaction(async (tx) => {
      // Once: the tile is an earned piece (once per owner), and the win is
      // keyed by day and resident, so a replayed bell grants and records
      // nothing new.
      const tile = await grantEarned(tx, r.userId, NOTHING_DAY_TILE);
      const [row] = await tx.insert(nothingDayWins).values({ cityDay: day, userId: r.userId, auraCenti: r.aura, botAuraCenti: r.bot!, tile, at: now }).onConflictDoNothing().returning({ tile: nothingDayWins.tile });
      return row ?? null;
    });
    if (won) {
      winners++;
      if (won.tile) tiles++;
    }
  }
  return { botAura: bot === null ? null : bot / 100, winners, tiles };
}
