import { type CityDay, NPC_IDS, addDays, bellScoreMilli, bellStampFor, cityDay, median, userAccountId } from "@bp/core";
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { chainStatus } from "./chain";
import { settleCityMarkets } from "./city-markets";
import { duelLines, settleDuels } from "./duels";
import { settleGrudges } from "./grudge";
import { lightsWinner, settleLights } from "./lights";
import { ratioHeadline, settleRatio } from "./ratio";
import type { Db } from "./client";
import { gmDestroyed } from "./economy";
import { mint } from "./ledger";
import { grantMood, maybeTilt } from "./moods";
import { bellStamps, bellSteps, calls, cityMarkets, contrarianCards, crewBellScores, crewMembers, crews, duels, markets, nothingDayWins, residents, slateCards, slates } from "./schema";
import { myGrid } from "./slate";
import { cityCalls, settleCalls } from "./tower";

const dayStart = (d: CityDay) => new Date(`${d}T00:00:00Z`);

export class BellShowError extends Error {
  constructor(
    readonly code: "NO_CALL_TODAY" | "NO_RESIDENT",
    message: string,
  ) {
    super(message);
    this.name = "BellShowError";
  }
}

// --- The bell's Tower step ----------------------------------------------------------

// Run once per bell (runBell records it): results for every market settled
// during the day land now. Receipts become moods (CALLED IT, REKT with its
// free Copium), 4+ REKT squares on the day's grid tilt you, and each crew
// gets its Bell Score.
export async function stepTower(db: Db, bellDay: CityDay, now: Date) {
  await settleCalls(db, { now });
  // Duels settle at the bell too: the bell is the reveal.
  const duelsSettled = (await settleDuels(db, { now })).settled;
  const grudges = await settleGrudges(db, bellDay, now);
  const cityMarketsSettled = (await settleCityMarkets(db, bellDay, now)).settled;
  await settleRatio(db, bellDay);
  const lights = await settleLights(db, bellDay);
  const lightsBurned = lights.reduce((a, l) => a + l.amount, 0);
  const from = dayStart(bellDay);
  const to = dayStart(addDays(bellDay, 1));
  const receipts = await db
    .select({ userId: calls.userId, marketId: calls.marketId, side: calls.side, outcome: markets.outcome, inPlay: calls.inPlay })
    .from(calls)
    .innerJoin(markets, eq(markets.id, calls.marketId))
    .where(and(eq(calls.status, "locked"), eq(markets.status, "resolved"), gte(markets.resolvedAt, from), lt(markets.resolvedAt, to)));
  const byUser = new Map<string, { wins: number; losses: number }>();
  // The cast doesn't get moods, tilt or Bell Score chips.
  for (const r of receipts) {
    if (NPC_IDS.includes(r.userId)) continue;
    const u = byUser.get(r.userId) ?? { wins: 0, losses: 0 };
    if ((r.side === "yes") === r.outcome) u.wins++;
    else u.losses++;
    byUser.set(r.userId, u);
  }
  // Each grant is keyed by the bell day: if this step fails partway and runs
  // again, nobody gets a second free Copium or a fresh tilt.
  let calledIt = 0;
  let rekt = 0;
  for (const [userId, u] of byUser) {
    if (u.wins) {
      await grantMood(db, userId, "called_it", { now, source: { bellDay }, once: `bell:${bellDay}:called_it` });
      calledIt++;
    }
    if (u.losses) {
      await grantMood(db, userId, "rekt", { now, source: { bellDay }, once: `bell:${bellDay}:rekt` });
      rekt++;
    }
  }

  // The day's grid: 4+ REKT squares tilt you.
  const slate = await db
    .select({ marketId: slateCards.marketId, tier: slateCards.tier })
    .from(slateCards)
    .where(eq(slateCards.cityDay, bellDay));
  const slateIds = slate.map((s) => s.marketId);
  const slateCalls = slateIds.length
    ? await db
        .select({ userId: calls.userId, marketId: calls.marketId, side: calls.side, aura: calls.auraCenti, outcome: markets.outcome })
        .from(calls)
        .innerJoin(markets, eq(markets.id, calls.marketId))
        .where(and(inArray(calls.marketId, slateIds), eq(calls.status, "locked"), eq(calls.onSlate, true)))
    : [];
  const reds = new Map<string, number>();
  for (const c of slateCalls) if (!NPC_IDS.includes(c.userId) && c.aura !== null && c.aura < -200) reds.set(c.userId, (reds.get(c.userId) ?? 0) + 1);
  let tilted = 0;
  for (const [userId, n] of reds) if (await maybeTilt(db, userId, { rektSquares: n }, { now, once: `bell:${bellDay}:grid_tilt` })) tilted++;

  // Bell Scores: CALLED IT chips per crew, Long Shots caught, the gm chain.
  const longShot = slate.find((s) => s.tier === "long_shot")?.marketId;
  const golds = new Set(slateCalls.filter((c) => c.marketId === longShot && c.side === "yes" && c.outcome === true).map((c) => c.userId));
  // Not an in-play win: late in a match a near-certain call would farm chips
  // for the crew, three tickets a day. It still gets its half Aura and its mood.
  const winners = receipts.filter((r) => (r.side === "yes") === r.outcome && !r.inPlay && !NPC_IDS.includes(r.userId)).map((r) => r.userId);
  const members = winners.length
    ? await db
        .select({ userId: crewMembers.userId, crewId: crewMembers.crewId })
        .from(crewMembers)
        .where(and(inArray(crewMembers.userId, [...new Set([...winners, ...golds])]), isNull(crewMembers.leftAt)))
    : [];
  const crewOf = new Map(members.map((m) => [m.userId, m.crewId]));
  // ×2 for each crewmate who held a Snap and won a duel on today's markets.
  const snapWins = (
    await db
      .select({ winner: duels.winnerId, sc: duels.snapChallenger, so: duels.snapOpponent, c: duels.challengerId })
      .from(duels)
      .innerJoin(markets, eq(markets.id, duels.marketId))
      .where(and(eq(duels.status, "settled"), gte(markets.resolvedAt, from), lt(markets.resolvedAt, to)))
  )
    .filter((d) => (d.winner === d.c ? d.sc : d.so))
    .map((d) => d.winner!);
  const snapCrews = snapWins.length
    ? await db
        .select({ userId: crewMembers.userId, crewId: crewMembers.crewId })
        .from(crewMembers)
        .where(and(inArray(crewMembers.userId, snapWins), isNull(crewMembers.leftAt)))
    : [];
  const tally = new Map<string, { chips: number; longShots: number; snapsWon: number }>();
  for (const u of winners) {
    const c = crewOf.get(u);
    if (!c) continue;
    const t = tally.get(c) ?? { chips: 0, longShots: 0, snapsWon: 0 };
    t.chips++;
    tally.set(c, t);
  }
  for (const u of golds) {
    const c = crewOf.get(u);
    if (c && tally.has(c)) tally.get(c)!.longShots++;
  }
  for (const s of snapCrews) if (tally.has(s.crewId)) tally.get(s.crewId)!.snapsWon++;
  for (const [crewId, t] of tally) {
    const chainDays = (await chainStatus(db, crewId, { now })).length;
    await db
      .insert(crewBellScores)
      .values({ bellDay, crewId, chips: t.chips, longShots: t.longShots, chainDays, scoreMilli: bellScoreMilli({ ...t, chainDays }) })
      .onConflictDoNothing();
  }
  // The day's burn for the reel, counted once here, after the day has ended,
  // and kept in this step's record. The reel reads it rather than summing the
  // ledger on every request.
  const burned = await gmDestroyed(db, { from, to });
  return { receipts: receipts.length, calledIt, rekt, tilted, crewsScored: tally.size, duelsSettled, grudgesSettled: grudges.settled, grudgesWaiting: grudges.waiting, cityMarketsSettled, lightsBurned, burned };
}

// --- Bell Stamps ------------------------------------------------------------------------

// One tap after your call: 25 GM (150 on Sundays), once a city day. It pays
// for calling, not for winning, and never for money.
export async function claimBellStamp(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const day = cityDay(now);
  const [me] = await db.select({ id: residents.userId }).from(residents).where(eq(residents.userId, userId));
  if (!me) throw new BellShowError("NO_RESIDENT", "move in first");
  const [called] = await db
    .select({ id: calls.id })
    .from(calls)
    .where(and(eq(calls.userId, userId), eq(calls.status, "locked"), gte(calls.lockedAt, dayStart(day)), lt(calls.lockedAt, dayStart(addDays(day, 1)))))
    .limit(1);
  if (!called) throw new BellShowError("NO_CALL_TODAY", "make a call today first");
  const gm = bellStampFor(day);
  return db.transaction(async (tx) => {
    const [had] = await tx.select().from(bellStamps).where(and(eq(bellStamps.userId, userId), eq(bellStamps.cityDay, day)));
    if (had) return { cityDay: day, gm: had.gm, already: true };
    const r = await mint(tx, { accountId: userAccountId(userId), amount: gm, kind: "bell_stamp", idempotencyKey: `bell_stamp:${userId}:${day}`, meta: { cityDay: day } });
    await tx.insert(bellStamps).values({ userId, cityDay: day, gm, txId: r.txId }).onConflictDoNothing();
    return { cityDay: day, gm, already: r.replayed };
  });
}

// --- The reel -------------------------------------------------------------------------------

// Tonight's reel, smallest result to biggest: the Slate band by band with the
// Long Shot last, the Bell Scores (yours and the top 3), the city's burn, and
// finally tomorrow's Long Shot. Only after the bell.
export async function reel(db: Db, userId: string, opts: { now?: Date; bellDay?: unknown } = {}) {
  const now = opts.now ?? new Date();
  const bellDay = typeof opts.bellDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(opts.bellDay) ? opts.bellDay : addDays(cityDay(now), -1);
  if (now < dayStart(addDays(bellDay, 1))) return null;
  const cards = await db
    .select({ slot: slateCards.slot, tier: slateCards.tier, marketId: markets.id, question: markets.question, outcome: markets.outcome, status: markets.status, world: markets.price })
    .from(slateCards)
    .innerJoin(markets, eq(markets.id, slateCards.marketId))
    .where(eq(slateCards.cityDay, bellDay))
    .orderBy(asc(slateCards.slot));
  const chances = await cityCalls(db, cards.map((c) => c.marketId));
  const top = await db
    .select({ crewId: crewBellScores.crewId, name: crews.name, chips: crewBellScores.chips, longShots: crewBellScores.longShots, scoreMilli: crewBellScores.scoreMilli })
    .from(crewBellScores)
    .innerJoin(crews, eq(crews.id, crewBellScores.crewId))
    .where(eq(crewBellScores.bellDay, bellDay))
    .orderBy(desc(crewBellScores.scoreMilli), asc(crewBellScores.crewId))
    .limit(3);
  const [mine] = await db.select({ crewId: crewMembers.crewId }).from(crewMembers).where(and(eq(crewMembers.userId, userId), isNull(crewMembers.leftAt)));
  let myCrew: { scoreMilli: number; rank: number } | null = null;
  if (mine) {
    const [s] = await db.select().from(crewBellScores).where(and(eq(crewBellScores.bellDay, bellDay), eq(crewBellScores.crewId, mine.crewId)));
    if (s) {
      const [above] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(crewBellScores)
        .where(and(eq(crewBellScores.bellDay, bellDay), sql`(${crewBellScores.scoreMilli} > ${s.scoreMilli} OR (${crewBellScores.scoreMilli} = ${s.scoreMilli} AND ${crewBellScores.crewId} < ${s.crewId}))`));
      myCrew = { scoreMilli: s.scoreMilli, rank: above!.n + 1 };
    }
  }
  // The burn the bell's Tower step counted for this day. Before that step has
  // run (the first minutes after midnight), or for a day whose record has no
  // count, it's summed here: the window index keeps that to the day's own
  // entries.
  const [tower] = await db
    .select({ result: bellSteps.result })
    .from(bellSteps)
    .where(and(eq(bellSteps.bellDay, bellDay), eq(bellSteps.step, "tower")));
  const recorded = tower?.result.burned;
  const burned = typeof recorded === "number" ? recorded : await gmDestroyed(db, { from: dayStart(bellDay), to: dayStart(addDays(bellDay, 1)) });
  const [tomorrow] = await db
    .select({ question: markets.question, world: markets.price })
    .from(slateCards)
    .innerJoin(markets, eq(markets.id, slateCards.marketId))
    .where(and(eq(slateCards.cityDay, addDays(bellDay, 1)), eq(slateCards.tier, "long_shot")));
  // The Bell Modifier: on Contrarian Day each card shows the majority the bell
  // recorded; on NOTHING Day, how many residents beat the bot's grid.
  const [slate] = await db.select({ modifier: slates.modifier }).from(slates).where(eq(slates.cityDay, bellDay));
  const majorities =
    slate?.modifier === "contrarian_day"
      ? await db.select({ marketId: contrarianCards.marketId, majority: contrarianCards.majority }).from(contrarianCards).where(eq(contrarianCards.cityDay, bellDay))
      : [];
  // (Counted only once the bell's modifier step has settled the day.)
  const [settled] =
    slate?.modifier === "nothing_day" ? await db.select({ step: bellSteps.step }).from(bellSteps).where(and(eq(bellSteps.bellDay, bellDay), eq(bellSteps.step, "modifier"))) : [];
  const [beatTheBot] = settled ? await db.select({ n: sql<number>`count(*)::int` }).from(nothingDayWins).where(eq(nothingDayWins.cityDay, bellDay)) : [];
  // City markets come first on the reel, smallest to biggest.
  const city = await db
    .select({ question: cityMarkets.question, outcome: cityMarkets.outcome, status: cityMarkets.status })
    .from(cityMarkets)
    .where(and(eq(cityMarkets.bellDay, bellDay), inArray(cityMarkets.status, ["settled", "refunded"])));
  return {
    bellDay,
    modifier: slate?.modifier ?? null,
    cityMarkets: city.map((c) => ({ question: c.question, result: c.status === "refunded" ? "void" : c.outcome ? "yes" : "no" })),
    slate: cards.map((c) => {
      const cs = chances.filter((x) => x.marketId === c.marketId).map((x) => x.chance);
      const result = c.status === "void" ? "void" : c.outcome === null ? "pending" : c.outcome ? "yes" : "no";
      // The losing Bunker's lights go out.
      const dark = result === "yes" ? "no" : result === "no" ? "yes" : null;
      const majority = majorities.find((x) => x.marketId === c.marketId);
      return {
        slot: c.slot,
        tier: c.tier,
        question: c.question,
        result,
        world: c.world,
        city: cs.length >= 10 ? median(cs) : null,
        darkBunker: dark,
        ...(slate?.modifier === "contrarian_day" ? { cityMajority: majority?.majority ?? null } : {}),
      };
    }),
    bellScores: { top: top.map((t) => ({ ...t, score: t.scoreMilli / 1000 })), mine: myCrew && { score: myCrew.scoreMilli / 1000, rank: myCrew.rank } },
    // Tower Lights: whose colours lit the Tower tonight.
    towerLights: await lightsWinner(db, bellDay),
    // The Ratio of the Day: the Roof's winning headline.
    ratio: await ratioHeadline(db, { day: bellDay }),
    // Duels settle at the bell after the day: "@a ate @b's Snap".
    duels: await duelLines(db, dayStart(addDays(bellDay, 1)), dayStart(addDays(bellDay, 2))),
    burned,
    // NOTHING Day: residents who beat NOTHING-9000's grid (null on other days).
    beatTheBot: beatTheBot?.n ?? null,
    grid: await myGrid(db, userId, bellDay, { now }),
    tomorrowsLongShot: tomorrow ?? null,
  };
}
