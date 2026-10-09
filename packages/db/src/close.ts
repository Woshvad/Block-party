import { CAST, type CityDay, type CloseItem, NPC_IDS, VERDICTS, addDays, getLaw, median, weekStart, yourHeadline } from "@bp/core";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "./client";
import { duelLines } from "./duels";
import { cityCalls } from "./tower";
import { calls, crewBellScores, crews, dailyCloses, markets, mayorTerms, messages, moods, residents, slateCards } from "./schema";

const dayStart = (d: CityDay) => new Date(`${d}T00:00:00Z`);

async function slateResults(db: Db, bellDay: CityDay) {
  const cards = await db
    .select({ marketId: markets.id, tier: slateCards.tier, question: markets.question, world: markets.price, outcome: markets.outcome, status: markets.status })
    .from(slateCards)
    .innerJoin(markets, eq(markets.id, slateCards.marketId))
    .where(eq(slateCards.cityDay, bellDay))
    .orderBy(asc(slateCards.slot));
  const locked = cards.length
    ? (
        await db
          .select({ userId: calls.userId, marketId: calls.marketId, side: calls.side, chance: calls.chance, aura: calls.auraCenti, onSlate: calls.onSlate })
          .from(calls)
          .where(and(inArray(calls.marketId, cards.map((c) => c.marketId)), eq(calls.status, "locked")))
      ).filter((c) => !NPC_IDS.includes(c.userId))
    : [];
  return { cards, locked };
}

// Prints the night's paper (runBell runs it once, after the cast's lines).
export async function stepClose(db: Db, bellDay: CityDay, now: Date) {
  const { cards, locked } = await slateResults(db, bellDay);
  const front: CloseItem[] = [];
  const settled = cards.filter((c) => c.outcome !== null);
  const ls = cards.find((c) => c.tier === "long_shot");
  if (ls && ls.outcome !== null) {
    const callers = locked.filter((c) => c.marketId === ls.marketId && c.side === "yes").length;
    front.push(ls.outcome ? { key: "front.long_shot_hit", values: { question: ls.question, world: ls.world, callers } } : { key: "front.long_shot_missed", values: { question: ls.question, world: ls.world } });
  }
  // The biggest Vibe Gap on the Slate (once 10 neighbours called), and how it settled.
  let gap: { question: string; world: number; city: number; size: number; verdict: string } | null = null;
  const neighbours = await cityCalls(db, cards.map((c) => c.marketId));
  for (const c of cards) {
    const cs = neighbours.filter((x) => x.marketId === c.marketId).map((x) => x.chance);
    if (cs.length < 10) continue;
    const city = median(cs)!;
    const size = Math.abs(city - c.world);
    const verdict = c.status === "void" ? VERDICTS.void : c.outcome === null ? "" : city > 50 === c.outcome ? VERDICTS.city : VERDICTS.world;
    if (verdict && (!gap || size > gap.size)) gap = { question: c.question, world: c.world, city, size, verdict };
  }
  if (gap) front.push({ key: "front.vibe_gap", values: { question: gap.question, world: gap.world, city: gap.city, verdict: gap.verdict } });
  if (!front.length) front.push({ key: "front.quiet", values: {} });

  // City Hall: the Law of the Week at work, naming the Mayor (they ran).
  const [term] = await db.select().from(mayorTerms).where(eq(mayorTerms.week, weekStart(bellDay)));
  const law = term?.lawId ? getLaw(term.lawId) : null;
  const [mayor] = term ? await db.select({ handle: residents.handle }).from(residents).where(eq(residents.userId, term.mayorUserId)) : [];
  const cityHall: CloseItem[] = law && mayor ? [{ key: "cityhall.law", values: { law: law.name, mayor: `@${mayor.handle}` } }] : [{ key: "cityhall.no_law", values: {} }];

  const top = await db
    .select({ name: crews.name, scoreMilli: crewBellScores.scoreMilli })
    .from(crewBellScores)
    .innerJoin(crews, eq(crews.id, crewBellScores.crewId))
    .where(eq(crewBellScores.bellDay, bellDay))
    .orderBy(desc(crewBellScores.scoreMilli), asc(crewBellScores.crewId))
    .limit(3);
  const crewPage: CloseItem[] = top.length ? top.map((t, i) => ({ key: "crews.top", values: { rank: i + 1, crew: t.name, score: t.scoreMilli / 1000 } })) : [{ key: "crews.none", values: {} }];
  // Duels settled at this bell, naming only residents who allow it.
  for (const d of (await duelLines(db, dayStart(addDays(bellDay, 1)), dayStart(addDays(bellDay, 2)))).slice(0, 5)) {
    crewPage.push({ key: d.snap ? "crews.duel_snap" : "crews.duel", values: { winner: d.winner, loser: d.loser } });
  }

  // The cast: tonight's lines, and the feud of the day.
  const lines = await db
    .select({ authorId: messages.authorId, text: messages.text })
    .from(messages)
    .where(and(eq(messages.kind, "board"), inArray(messages.authorId, [...NPC_IDS]), gte(messages.createdAt, dayStart(addDays(bellDay, 1))), lt(messages.createdAt, dayStart(addDays(bellDay, 2)))))
    .orderBy(asc(messages.createdAt));
  const cast: CloseItem[] = [];
  for (const id of NPC_IDS) {
    const l = lines.find((x) => x.authorId === id);
    const who = Object.values(CAST).find((c) => c.id === id)!;
    if (l) cast.push({ key: "cast.line", values: { npc: who.name, text: l.text } });
  }
  if (lines.some((l) => l.authorId === CAST.nothing_9000.id && /^Nothing happened/.test(l.text)) && settled.some((c) => c.outcome)) cast.push({ key: "cast.feud", values: {} });

  // Weather: the city's candles at this bell.
  const [w] = await db
    .select({
      called: sql<number>`count(*) FILTER (WHERE ${moods.mood} = 'called_it')::int`,
      rekt: sql<number>`count(*) FILTER (WHERE ${moods.mood} = 'rekt')::int`,
    })
    .from(moods)
    .where(sql`${moods.source}->>'bellDay' = ${bellDay}`);
  const [cp] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(moods)
    .where(and(eq(moods.clearedBy, "copium"), gte(moods.clearedAt, dayStart(bellDay)), lt(moods.clearedAt, dayStart(addDays(bellDay, 1)))));
  const total = w!.called + w!.rekt;
  const weather: CloseItem[] = [{ key: "weather.today", values: { green: total ? Math.round((100 * w!.called) / total) : 0, copium: cp!.n, rekt: w!.rekt } }];

  const pages = { front, cityHall, crews: crewPage, cast, weather };
  await db.insert(dailyCloses).values({ bellDay, pages, createdAt: now }).onConflictDoNothing();
  return { items: Object.values(pages).reduce((a, p) => a + p.length, 0) };
}

// The paper for a day, plus your own page: one headline from your real day.
export async function dailyClose(db: Db, userId: string, day: unknown) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [paper] = await db.select().from(dailyCloses).where(eq(dailyCloses.bellDay, day));
  if (!paper) return null;
  const { cards, locked } = await slateResults(db, day);
  const mine = locked.filter((c) => c.userId === userId && c.onSlate);
  const outcome = new Map(cards.map((c) => [c.marketId, c.outcome]));
  const ls = cards.find((c) => c.tier === "long_shot");
  const won = (c: (typeof mine)[number]) => outcome.get(c.marketId) !== null && (c.side === "yes") === outcome.get(c.marketId);
  // "Fades City": a call against the city's majority on that card that won.
  const against = mine.some((c) => {
    const others = locked.filter((x) => x.marketId === c.marketId && x.userId !== userId);
    const yes = others.filter((x) => x.side === "yes").length;
    const no = others.length - yes;
    return others.length > 0 && yes !== no && (c.side === "yes") !== yes > no && won(c);
  });
  const [r] = await db.select({ traits: residents.traits }).from(residents).where(eq(residents.userId, userId));
  const you = yourHeadline({
    trait: (r?.traits as string[] | undefined)?.[0] ?? null,
    calls: mine.length,
    wins: mine.filter(won).length,
    reds: mine.filter((c) => c.aura !== null && c.aura < -200).length,
    whites: mine.filter((c) => c.aura !== null && c.aura >= -200 && c.aura <= 200).length,
    gold: !!ls && mine.some((c) => c.marketId === ls.marketId && c.side === "yes" && ls.outcome === true),
    fadedAgainstCityAndWon: against,
  });
  const pages: Record<string, CloseItem[]> = { ...(paper.pages as Record<string, CloseItem[]>), you: [you] };
  return { bellDay: day, pages };
}
