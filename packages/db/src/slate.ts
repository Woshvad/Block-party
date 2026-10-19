import { CAST, type CityDay, type Modifier, NPC_IDS, type SlateTier, addDays, againstCity, cityDay, gridText, modifierFor, oddsCredit, pickSlate, slateNumber, square } from "@bp/core";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "./client";
import { bellSteps, calls, contrarianCards, markets, nothingDayWins, slateCards, slates } from "./schema";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const bellAfter = (day: CityDay) => new Date(`${addDays(day, 1)}T00:00:00Z`);

// Publishes today's Slate once (racing publishers agree on one). Six cards as
// soon as six fit; a short Slate only after 02:00 UTC, giving the feed time.
export async function publishSlate(db: Db, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const day = cityDay(now);
  const [existing] = await db.select().from(slates).where(eq(slates.cityDay, day));
  if (existing) return { cityDay: day, published: false, reason: "already" as const };
  // Only markets the latest poll carried: one the feed has dropped takes no calls.
  const candidates = await db
    .select({ id: markets.id, category: markets.category, ladder: markets.ladder, price: markets.price, freezesAt: markets.freezesAt, settlesBy: markets.settlesBy, infoOnly: markets.infoOnly })
    .from(markets)
    .where(and(eq(markets.status, "open"), eq(markets.inFeed, true)));
  const picks = pickSlate(candidates, day);
  const late = now.getTime() - Date.parse(`${day}T00:00:00Z`) >= 2 * 3_600_000;
  if (picks.length === 0 || (picks.length < 6 && !late)) return { cityDay: day, published: false, reason: "not_enough_markets" as const, found: picks.length };
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(slates).values({ cityDay: day, modifier: modifierFor(day), publishedAt: now }).onConflictDoNothing().returning();
    if (!row) return { cityDay: day, published: false, reason: "already" as const };
    await tx.insert(slateCards).values(picks.map((p) => ({ cityDay: day, slot: p.slot, tier: p.tier, marketId: p.id })));
    return { cityDay: day, published: true, cards: picks.length, modifier: row.modifier };
  });
}

// Is this market on today's Slate (the one calls are being made for)?
export async function isOnSlate(db: Db, marketId: string, now = new Date()): Promise<boolean> {
  const [c] = await db
    .select({ slot: slateCards.slot })
    .from(slateCards)
    .where(and(eq(slateCards.cityDay, cityDay(now)), eq(slateCards.marketId, marketId)));
  return !!c;
}

export async function slateModifier(db: Db, now = new Date()): Promise<Modifier | null> {
  const [s] = await db.select({ modifier: slates.modifier }).from(slates).where(eq(slates.cityDay, cityDay(now)));
  return (s?.modifier as Modifier) ?? null;
}

// Today's Slate as one resident sees it: the cards, their own call on each,
// and nothing that gives away the result before the bell.
export async function todaySlate(db: Db, userId: string, opts: { now?: Date; day?: unknown } = {}) {
  const now = opts.now ?? new Date();
  const day = typeof opts.day === "string" && DAY.test(opts.day) ? opts.day : cityDay(now);
  const [s] = await db.select().from(slates).where(eq(slates.cityDay, day));
  if (!s) return null;
  const cards = await db
    .select({ slot: slateCards.slot, tier: slateCards.tier, marketId: markets.id, question: markets.question, category: markets.category, price: markets.price, freezesAt: markets.freezesAt, status: markets.status, inFeed: markets.inFeed, outcome: markets.outcome, source: markets.source })
    .from(slateCards)
    .innerJoin(markets, eq(markets.id, slateCards.marketId))
    .where(eq(slateCards.cityDay, day))
    .orderBy(asc(slateCards.slot));
  const mine = cards.length
    ? await db
        .select({ marketId: calls.marketId, side: calls.side, chance: calls.chance, status: calls.status, aura: calls.auraCenti })
        .from(calls)
        .where(and(eq(calls.userId, userId), inArray(calls.marketId, cards.map((c) => c.marketId)), inArray(calls.status, ["pending", "locked"]), eq(calls.onSlate, true)))
    : [];
  const revealed = now >= bellAfter(day);
  return {
    cityDay: day,
    number: slateNumber(day),
    modifier: s.modifier,
    bellAt: bellAfter(day),
    sealed: !revealed,
    // Where the cards' odds come from: Polymarket's name only when every one
    // is Polymarket's (a sample card says so instead).
    credit: cards.length ? oddsCredit(cards.find((c) => c.source !== "polymarket")?.source ?? "polymarket") : null,
    cards: cards.map((c) => {
      const m = mine.find((x) => x.marketId === c.marketId);
      return {
        slot: c.slot,
        tier: c.tier,
        marketId: c.marketId,
        question: c.question,
        category: c.category,
        // The world's price is public; whether it settled waits for the bell.
        world: c.price,
        freezesAt: c.freezesAt,
        // Callable: open, not frozen yet, and carried by the latest poll.
        open: c.status === "open" && c.inFeed && now < c.freezesAt,
        mine: m ? { side: m.side, chance: m.chance, status: m.status } : null,
      };
    }),
  };
}

// The grid, sealed until the bell after the Slate's day: then each square by
// Aura, the share line, and where you landed in the city.
export async function myGrid(db: Db, userId: string, day: unknown, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  if (typeof day !== "string" || !DAY.test(day)) return null;
  const [s] = await db.select().from(slates).where(eq(slates.cityDay, day));
  if (!s) return null;
  if (now < bellAfter(day)) return { cityDay: day, sealed: true as const, bellAt: bellAfter(day) };
  const cards = await db
    .select({ slot: slateCards.slot, tier: slateCards.tier, marketId: slateCards.marketId, outcome: markets.outcome, status: markets.status })
    .from(slateCards)
    .innerJoin(markets, eq(markets.id, slateCards.marketId))
    .where(eq(slateCards.cityDay, day))
    .orderBy(asc(slateCards.slot));
  const ids = cards.map((c) => c.marketId);
  const all = ids.length
    ? await db
        .select({ userId: calls.userId, marketId: calls.marketId, side: calls.side, aura: calls.auraCenti })
        .from(calls)
        .where(and(inArray(calls.marketId, ids), eq(calls.status, "locked"), eq(calls.onSlate, true)))
    : [];
  const mine = all.filter((c) => c.userId === userId);
  const squares = cards.map((c) => {
    const m = mine.find((x) => x.marketId === c.marketId);
    return square(m ? { side: m.side, auraCenti: m.aura } : null, c.tier as SlateTier, c.outcome, c.status === "void");
  });
  // Where you landed: the share of today's players whose Slate Aura you beat.
  const totals = new Map<string, number>();
  for (const c of all) if (!NPC_IDS.includes(c.userId)) totals.set(c.userId, (totals.get(c.userId) ?? 0) + (c.aura ?? 0));
  const myTotal = totals.get(userId);
  const others = [...totals.entries()].filter(([u]) => u !== userId).map(([, v]) => v);
  const percentile = myTotal === undefined || !others.length ? null : Math.round((100 * others.filter((v) => v < myTotal).length) / others.length);
  return {
    cityDay: day,
    sealed: false as const,
    number: slateNumber(day),
    modifier: s.modifier,
    squares,
    share: gridText(day, squares),
    aura: myTotal === undefined ? null : myTotal / 100,
    percentile,
    // Contrarian Day: which of your squares went against the city majority
    // (the gold border), as the bell recorded it. Null on other days.
    contrarian: s.modifier === "contrarian_day" ? await contrarianSquares(db, day, cards, mine) : null,
    // NOTHING Day: NOTHING-9000's grid under yours, and whether yours beat it
    // at the bell (null until the bell has settled it). Null on other days.
    nothing: s.modifier === "nothing_day" ? await nothingDay(db, userId, day, cards, all) : null,
  };
}

type GridCard = { marketId: string; tier: string; outcome: boolean | null; status: string };
type GridCall = { userId: string; marketId: string; side: "yes" | "no"; aura: number | null };

async function contrarianSquares(db: Db, day: string, cards: GridCard[], mine: GridCall[]) {
  const recorded = await db.select({ marketId: contrarianCards.marketId, majority: contrarianCards.majority }).from(contrarianCards).where(eq(contrarianCards.cityDay, day));
  return cards.map((c) => {
    const m = mine.find((x) => x.marketId === c.marketId);
    const r = recorded.find((x) => x.marketId === c.marketId);
    return !!m && !!r && againstCity(m.side, r.majority);
  });
}

async function nothingDay(db: Db, userId: string, day: string, cards: GridCard[], all: GridCall[]) {
  const bot = all.filter((c) => c.userId === CAST.nothing_9000.id);
  const squares = cards.map((c) => {
    const b = bot.find((x) => x.marketId === c.marketId);
    return square(b ? { side: b.side, auraCenti: b.aura } : null, c.tier as SlateTier, c.outcome, c.status === "void");
  });
  const [settled] = await db
    .select({ day: bellSteps.bellDay })
    .from(bellSteps)
    .where(and(eq(bellSteps.bellDay, day), eq(bellSteps.step, "modifier")));
  const [win] = await db
    .select({ tile: nothingDayWins.tile })
    .from(nothingDayWins)
    .where(and(eq(nothingDayWins.cityDay, day), eq(nothingDayWins.userId, userId)));
  return {
    squares,
    aura: bot.length ? bot.reduce((a, c) => a + (c.aura ?? 0), 0) / 100 : null,
    beat: settled ? !!win : null,
    tile: !!win?.tile,
  };
}
