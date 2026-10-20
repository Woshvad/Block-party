import {
  type FeedMarket,
  type OddsProvider,
  type Side,
  RIGHT_LIST,
  SEASON_EPOCH,
  SEASON_LENGTH_DAYS,
  NPC_IDS,
  TOWER,
  addDays,
  againstCity,
  npcById,
  CAST,
  auraCenti,
  chanceOnSide,
  revealAt,
  rightListScore,
  rightListSpread,
  seasonOf,
  cityDay,
  daysBetween,
  median,
  oddsCredit,
  sideOpen,
  ticketsAfter,
  vibeGap,
} from "@bp/core";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { areFrens } from "./chat";
import { grantOwedStreakDays } from "./daily";
import { moodState } from "./moods";
import { notify } from "./notify";
import { inRoom } from "./pon";
import { isBlockedEitherWay } from "./safety";
import { ratioHeadline } from "./ratio";
import { isOnSlate, slateModifier } from "./slate";
import { calls, contrarianCards, crewMembers, feedPolls, marketTicks, markets, residents, streakGrants, streaks, tickets, users } from "./schema";

export class TowerError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "NO_SUCH_MARKET"
      | "MARKET_CLOSED"
      | "INFO_ONLY"
      | "NO_RESIDENT"
      | "ALREADY_CALLED"
      | "PRICE_MOVED"
      | "NO_TICKETS"
      | "NOT_FRENS"
      | "NOTHING_TO_TAIL"
      | "TOO_MANY_TAILS"
      | "BLOCKED"
      | "FEED_PAUSED"
      | "NOT_IN_HALL",
    message: string,
  ) {
    super(message);
    this.name = "TowerError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUnique = (e: unknown) => ((e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code) === "23505";
const POLL_LOCK = 0x70_11_0d_d5; // advisory lock: one poller at a time

// --- Tickets --------------------------------------------------------------------

async function lockTickets(tx: Db, userId: string, now: Date) {
  const today = cityDay(now);
  await tx.insert(tickets).values({ userId, balance: TOWER.ticketsPerDay, asOf: today }).onConflictDoNothing();
  const [t] = await tx.select().from(tickets).where(eq(tickets.userId, userId)).for("no key update");
  const balance = ticketsAfter(t!.balance, daysBetween(t!.asOf, today));
  return { balance, today };
}

export async function myTickets(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const [t] = await db.select().from(tickets).where(eq(tickets.userId, userId));
  return { tickets: t ? ticketsAfter(t.balance, daysBetween(t.asOf, cityDay(now))) : TOWER.ticketsPerDay, max: TOWER.ticketsMax };
}

// For other off-slate calls (City markets): spend one ticket, under its lock.
export async function spendTicket(tx: Db, userId: string, now: Date) {
  const { balance, today } = await lockTickets(tx, userId, now);
  if (balance < 1) throw new TowerError("NO_TICKETS", "no tickets left; 3 more at the bell");
  await tx.update(tickets).set({ balance: balance - 1, asOf: today }).where(eq(tickets.userId, userId));
}

async function refundTicket(tx: Db, userId: string, now: Date) {
  const { balance, today } = await lockTickets(tx, userId, now);
  await tx.update(tickets).set({ balance: Math.min(TOWER.ticketsMax, balance + 1), asOf: today }).where(eq(tickets.userId, userId));
}

// --- The odds feed -----------------------------------------------------------------

function statusFor(m: FeedMarket, now: Date): "open" | "frozen" | "resolved" | "void" {
  if (m.voided) return "void";
  if (m.resolved !== null) return "resolved";
  return m.closed || now >= m.freezesAt ? "frozen" : "open";
}

const validFeed = (m: FeedMarket) =>
  typeof m.externalId === "string" &&
  m.externalId.length > 0 &&
  m.externalId.length <= 200 &&
  typeof m.question === "string" &&
  m.question.length > 0 &&
  Number.isInteger(m.price) &&
  m.price >= 1 &&
  m.price <= 99 &&
  m.freezesAt instanceof Date &&
  m.settlesBy instanceof Date &&
  !Number.isNaN(m.freezesAt.getTime()) &&
  m.settlesBy >= m.freezesAt;

// A match in play (FeedMarket.inPlay): it stays frozen at its kickoff price
// for everything else, and its live price and tick serve the Watch Party
// Hall's in-play calls. Each locks on the first tick at least
// TOWER.inPlayDelaySeconds after it was made, within maxSlip of what its
// caller saw, for half the Aura; otherwise the price moved and the ticket
// comes back. Only a match we froze at kickoff plays on: a feed can't open
// one in play. null: not one of those.
async function playOn(tx: Db, source: string, m: FeedMarket, now: Date, lockedFor: Set<string>) {
  const [market] = await tx
    .select()
    .from(markets)
    .where(and(eq(markets.source, source), eq(markets.externalId, m.externalId)))
    .for("no key update");
  if (!market || (market.status !== "frozen" && market.status !== "open") || market.category !== "sports" || market.ladder !== null || now < market.freezesAt) return null;
  // The first poll past kickoff can find it still open: it freezes here, as it would have anyway.
  await tx.update(markets).set({ status: "frozen", inFeed: false, inPlay: true, livePrice: m.price }).where(eq(markets.id, market.id));
  const out = { marketId: market.id, ticked: 0, locked: 0, moved: 0 };
  // A repeat poll for the same moment (two crons racing) adds nothing.
  const [last] = await tx.select({ at: marketTicks.at }).from(marketTicks).where(eq(marketTicks.marketId, market.id)).orderBy(desc(marketTicks.id)).limit(1);
  if (last && last.at >= now) return out;
  const [tick] = await tx.insert(marketTicks).values({ marketId: market.id, price: m.price, at: now }).returning();
  out.ticked++;
  const waiting = await tx
    .select()
    .from(calls)
    .where(
      and(
        eq(calls.marketId, market.id),
        eq(calls.status, "pending"),
        eq(calls.inPlay, true),
        lte(calls.createdAt, new Date(now.getTime() - TOWER.inPlayDelaySeconds * 1000)),
      ),
    )
    .for("no key update");
  for (const c of waiting) {
    if (Math.abs(tick!.price - c.seenPrice) <= TOWER.maxSlip) {
      await tx.update(calls).set({ status: "locked", tickId: tick!.id, lockedPrice: tick!.price, lockedAt: now, half: true }).where(eq(calls.id, c.id));
      if (!NPC_IDS.includes(c.userId)) lockedFor.add(c.userId);
      out.locked++;
    } else {
      await tx.update(calls).set({ status: "price_moved" }).where(eq(calls.id, c.id));
      if (c.ticket) await refundTicket(tx, c.userId, now);
      out.moved++;
    }
  }
  return out;
}

// One poll: store every open market's tick, then settle the calls waiting on
// it. One poller at a time (an advisory lock); a second one just skips.
export async function pollOdds(db: Db, provider: OddsProvider, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  // Checked first: the source goes into a query, and postgres.js can stall the
  // pool on an undefined parameter.
  if (typeof provider?.source !== "string") throw new TypeError("pollOdds needs an odds provider");
  // Our markets from this feed that aren't final yet, soonest to freeze
  // first: a feed that only lists what's trading looks these up to say what
  // became of the ones it no longer lists. `held`: a call (and so any duel)
  // or a Slate card rides on it, so its result comes first. `live`: it must
  // keep its price while it trades, listed or not (a card on today's Slate,
  // a call waiting to lock). `inPlay`: a match frozen at kickoff in the last
  // few hours, whose live price the Watch Party Hall's in-play calls need.
  // (Spelled out: in a one-table select drizzle writes columns unqualified,
  // and inside these subqueries "id" would then mean calls.id.)
  const today = cityDay(now);
  const known = await db
    .select({
      externalId: markets.externalId,
      question: markets.question,
      category: markets.category,
      ladder: markets.ladder,
      freezesAt: markets.freezesAt,
      settlesBy: markets.settlesBy,
      price: markets.price,
      held: sql<boolean>`(EXISTS (SELECT 1 FROM calls c WHERE c.market_id = markets.id AND c.status IN ('pending', 'locked'))
        OR EXISTS (SELECT 1 FROM slate_cards s WHERE s.market_id = markets.id))`,
      live: sql<boolean>`(markets.status = 'open' AND (EXISTS (SELECT 1 FROM calls c WHERE c.market_id = markets.id AND c.status = 'pending')
        OR EXISTS (SELECT 1 FROM slate_cards s WHERE s.market_id = markets.id AND s.city_day = ${today})))`,
      inPlay: sql<boolean>`(markets.status = 'frozen' AND markets.category = 'sports' AND markets.ladder IS NULL
        AND markets.freezes_at <= ${now.toISOString()}::timestamptz
        AND markets.freezes_at > ${new Date(now.getTime() - TOWER.inPlayHours * 3_600_000).toISOString()}::timestamptz)`,
    })
    .from(markets)
    .where(and(eq(markets.source, provider.source), inArray(markets.status, ["open", "frozen"])))
    .orderBy(markets.freezesAt);
  let feed: FeedMarket[];
  try {
    feed = await provider.fetch(now, known);
    if (!Array.isArray(feed)) throw new Error("feed did not return a list");
  } catch (e) {
    await db.insert(feedPolls).values({ source: provider.source, ok: false, error: String((e as Error)?.message ?? e).slice(0, 500), at: now });
    return { ok: false as const, skipped: false };
  }
  const result = await db.transaction(async (tx) => {
    const [got] = await tx.execute<{ ok: boolean }>(sql`SELECT pg_try_advisory_xact_lock(${POLL_LOCK}) AS ok`);
    if (!got?.ok) return { ok: true as const, skipped: true as const };
    let ticked = 0;
    let locked = 0;
    let moved = 0;
    let bad = 0;
    const carried: string[] = []; // the open markets this poll carried
    const playing: string[] = []; // the matches this poll carried in play
    const lockedFor = new Set<string>(); // residents with a call locked: owed today's streak day
    for (const m of feed) {
      if (!validFeed(m)) {
        bad++;
        continue;
      }
      if (m.inPlay) {
        const r = await playOn(tx, provider.source, m, now, lockedFor);
        if (r) {
          playing.push(r.marketId);
          ticked += r.ticked;
          locked += r.locked;
          moved += r.moved;
        }
        continue;
      }
      const status = statusFor(m, now);
      const [row] = await tx
        .insert(markets)
        .values({
          source: provider.source,
          externalId: m.externalId,
          question: m.question.slice(0, 300),
          category: m.category,
          ladder: m.ladder,
          infoOnly: m.category === "politics",
          freezesAt: m.freezesAt,
          settlesBy: m.settlesBy,
          status,
          outcome: status === "resolved" ? m.resolved : null,
          resolvedAt: status === "resolved" || status === "void" ? now : null,
          price: m.price,
          inFeed: status === "open",
        })
        .onConflictDoNothing()
        .returning();
      let market = row;
      if (!market) {
        const [existing] = await tx
          .select()
          .from(markets)
          .where(and(eq(markets.source, provider.source), eq(markets.externalId, m.externalId)))
          .for("no key update");
        market = existing!;
        if (market.status === "resolved" || market.status === "void") continue; // final
        const [updated] = await tx
          .update(markets)
          .set({
            question: m.question.slice(0, 300),
            freezesAt: m.freezesAt,
            settlesBy: m.settlesBy,
            status,
            outcome: status === "resolved" ? m.resolved : null,
            resolvedAt: status === "resolved" || status === "void" ? now : null,
            ...(status === "open" ? { price: m.price } : {}),
            inFeed: status === "open",
            // In play only when a poll carries it so (see playOn).
            inPlay: false,
            livePrice: null,
          })
          .where(eq(markets.id, market.id))
          .returning();
        market = updated!;
      }
      if (market.status !== "open") continue;
      carried.push(market.id);
      // A repeat poll for the same moment (two crons racing) adds nothing.
      const [last] = await tx.select({ at: marketTicks.at }).from(marketTicks).where(eq(marketTicks.marketId, market.id)).orderBy(desc(marketTicks.id)).limit(1);
      if (last && last.at >= now) continue;
      const [tick] = await tx.insert(marketTicks).values({ marketId: market.id, price: m.price, at: now }).returning();
      ticked++;
      // Everyone who confirmed before this tick locks on it, or hears the price moved.
      const waiting = await tx
        .select()
        .from(calls)
        .where(and(eq(calls.marketId, market.id), eq(calls.status, "pending"), eq(calls.inPlay, false), lt(calls.createdAt, now)))
        .for("no key update");
      for (const c of waiting) {
        if (Math.abs(tick!.price - c.seenPrice) <= TOWER.maxSlip) {
          const half = !c.onSlate && market.freezesAt.getTime() - now.getTime() < TOWER.halfAuraLastMinutes * 60_000;
          await tx.update(calls).set({ status: "locked", tickId: tick!.id, lockedPrice: tick!.price, lockedAt: now, half }).where(eq(calls.id, c.id));
          // Your streak grows with your first call of the day (the cast has no streak, and no GM).
          if (!NPC_IDS.includes(c.userId)) lockedFor.add(c.userId);
          locked++;
        } else {
          await tx.update(calls).set({ status: "price_moved" }).where(eq(calls.id, c.id));
          if (c.ticket) await refundTicket(tx, c.userId, now);
          moved++;
        }
      }
    }
    // Markets this poll didn't carry: frozen once their time is up, listed or
    // not, and off the Floor meanwhile, because their last price is stale.
    // Every source's, not just this one's: after ODDS_SOURCE changes (mock to
    // polymarket on the same database), the old feed's markets would
    // otherwise stay open, on the Floor and callable at prices nobody updates.
    await tx
      .update(markets)
      .set({ status: "frozen", inFeed: false })
      .where(and(eq(markets.status, "open"), lte(markets.freezesAt, now)));
    await tx
      .update(markets)
      .set({ inFeed: false })
      .where(and(eq(markets.status, "open"), eq(markets.inFeed, true), notInArray(markets.id, carried)));
    // Matches this poll didn't carry in play (over, stopped trading, or the
    // lookup failed): no live price, so no in-play calls until one comes back.
    await tx
      .update(markets)
      .set({ inPlay: false, livePrice: null })
      .where(and(eq(markets.inPlay, true), notInArray(markets.id, playing)));
    // Calls that can never lock: their market froze or ended first (an
    // in-play call: its match stopped playing), or the feed went quiet for
    // too long. Tickets come back.
    const stale = await tx
      .select({ id: calls.id, userId: calls.userId, ticket: calls.ticket })
      .from(calls)
      .innerJoin(markets, eq(markets.id, calls.marketId))
      .where(
        and(
          eq(calls.status, "pending"),
          sql`(CASE WHEN ${calls.inPlay} THEN ${markets.status} <> 'frozen' OR NOT ${markets.inPlay} ELSE ${markets.status} <> 'open' END
            OR ${calls.createdAt} < ${new Date(now.getTime() - TOWER.pendingExpiresSeconds * 1000).toISOString()}::timestamptz)`,
        ),
      )
      .for("no key update", { of: calls });
    for (const c of stale) {
      await tx.update(calls).set({ status: "expired" }).where(eq(calls.id, c.id));
      if (c.ticket) await refundTicket(tx, c.userId, now);
    }
    // Today's streak day, owed to each resident whose call this poll locked
    // (unless today already counted for them): noted with the poll, so a
    // grant that fails, or a run cut off after the commit, is made by the
    // next poll instead of lost.
    if (lockedFor.size) {
      const counted = await tx
        .select({ userId: streaks.userId })
        .from(streaks)
        .where(and(inArray(streaks.userId, [...lockedFor]), gte(streaks.lastDay, today)));
      for (const r of counted) lockedFor.delete(r.userId);
      if (lockedFor.size) await tx.insert(streakGrants).values([...lockedFor].map((userId) => ({ userId, cityDay: today }))).onConflictDoNothing();
    }
    await tx.insert(feedPolls).values({ source: provider.source, ok: true, markets: feed.length, at: now, ...(bad ? { error: `${bad} malformed market(s) skipped` } : {}) });
    return { ok: true as const, skipped: false as const, ticked, locked, moved, expired: stale.length, bad };
  });
  if (result.skipped) return result;
  // Streak days are granted once the poll has committed, one resident per
  // transaction. Minted inside the poll, they held mint shards while it went
  // on to lock more residents: the reverse of gm's order (resident, then
  // ledger), so a gm and the poll could deadlock. Every owed day is tried,
  // this poll's and any an earlier one couldn't grant; if any failed, the
  // first error is thrown once calls are settled (its note stays).
  const failed = await grantOwedStreakDays(db);
  const settled = (await settleCalls(db, { now })).settled;
  if (failed) throw failed.e;
  return { ...result, settled };
}

// --- The city's calls ------------------------------------------------------------------

// The calls that move the City bar: Proof of Neighbour accounts only (so one
// viral link can't brigade a market), and never the cast. atFreeze: the bar as
// it stood when each market froze, so a mark stamped after that (the PoN page
// grants it when it's opened) doesn't count. Never an in-play call: those are
// made on the match as it goes, and the bar is the city's view before kickoff.
export async function cityCalls(db: Db, marketIds: string[], opts: { atFreeze?: boolean } = {}) {
  if (!marketIds.length) return [];
  const rows = await db
    .select({ userId: calls.userId, marketId: calls.marketId, side: calls.side, chance: calls.chance })
    .from(calls)
    .innerJoin(users, eq(users.id, calls.userId))
    .innerJoin(markets, eq(markets.id, calls.marketId))
    .where(
      and(
        inArray(calls.marketId, marketIds),
        eq(calls.status, "locked"),
        eq(calls.inPlay, false),
        opts.atFreeze ? lte(users.proofOfNeighbourAt, markets.freezesAt) : isNotNull(users.proofOfNeighbourAt),
      ),
    );
  return rows.filter((r) => !NPC_IDS.includes(r.userId));
}

// --- Settling -------------------------------------------------------------------------

// Scores every locked call on a resolved market, once (the database refuses a
// second score). A Tail scores nothing; a voided market scores nobody.
export async function settleCalls(db: Db, opts: { now?: Date; batch?: number } = {}) {
  const due = await db
    .select({ id: calls.id })
    .from(calls)
    .innerJoin(markets, eq(markets.id, calls.marketId))
    .where(and(eq(calls.status, "locked"), isNull(calls.auraCenti), eq(markets.status, "resolved")))
    .limit(opts.batch ?? 5000);
  let settled = 0;
  for (const { id } of due) {
    const done = await db.transaction(async (tx) => {
      const [c] = await tx
        .select({ id: calls.id, chance: calls.chance, lockedPrice: calls.lockedPrice, half: calls.half, via: calls.via, outcome: markets.outcome })
        .from(calls)
        .innerJoin(markets, eq(markets.id, calls.marketId))
        .where(and(eq(calls.id, id), isNull(calls.auraCenti)))
        .for("no key update", { of: calls, skipLocked: true });
      if (!c || c.outcome === null) return false;
      const aura = c.via === "tail" ? 0 : auraCenti(c.outcome, c.lockedPrice!, c.chance, c.half);
      await tx.update(calls).set({ auraCenti: aura }).where(eq(calls.id, c.id));
      return true;
    });
    if (done) settled++;
  }
  return { settled };
}

// --- Receipts -----------------------------------------------------------------------------

// What a receipt shows: who, what, which side, how sure, the World and City at
// the time, and, after the bell, the stamp and the Aura. Never an amount,
// never a wallet, never whether it was backed for real.
export async function receipt(db: Db, callId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const [r] = await db
    .select({
      id: calls.id,
      handle: residents.handle,
      question: markets.question,
      marketId: markets.id,
      side: calls.side,
      chance: calls.chance,
      world: calls.lockedPrice,
      lockedAt: calls.lockedAt,
      settlesBy: markets.settlesBy,
      status: markets.status,
      outcome: markets.outcome,
      resolvedAt: markets.resolvedAt,
      aura: calls.auraCenti,
      via: calls.via,
      onSlate: calls.onSlate,
      createdAt: calls.createdAt,
    })
    .from(calls)
    .innerJoin(markets, eq(markets.id, calls.marketId))
    .leftJoin(residents, eq(residents.userId, calls.userId))
    .where(and(eq(calls.id, callId), eq(calls.status, "locked")));
  if (!r) return null;
  const npc = npcById((await db.select({ u: calls.userId }).from(calls).where(eq(calls.id, callId)))[0]!.u);
  if (!r.handle && !npc) return null;
  const cityRows = await cityCalls(db, [r.marketId]);
  const city = cityRows.length >= TOWER.cityBarMin ? median(cityRows.map((x) => x.chance)) : null;
  const revealed = r.status === "resolved" && r.resolvedAt !== null && now >= revealAt(r.resolvedAt);
  // Contrarian Day: a Slate call against the city majority the bell recorded
  // for its card (the Slate of the day it was made) gets the gold border.
  const [card] = r.onSlate
    ? await db
        .select({ majority: contrarianCards.majority })
        .from(contrarianCards)
        .where(and(eq(contrarianCards.marketId, r.marketId), eq(contrarianCards.cityDay, cityDay(r.createdAt))))
    : [];
  return {
    id: r.id,
    handle: r.handle ?? CAST[npc!].name,
    npc: npc ? CAST[npc].label : null,
    question: r.question,
    side: r.side,
    chance: r.chance,
    world: r.world,
    city,
    vibeGap: vibeGap(r.world!, city),
    lockedAt: r.lockedAt,
    bellAt: r.resolvedAt ? revealAt(r.resolvedAt) : revealAt(r.settlesBy),
    // Sealed until the bell, even when the world settled hours earlier.
    stamp: !revealed ? (r.status === "void" ? "VOID" : "IN THE MEMPOOL") : (r.side === "yes") === r.outcome ? "CALLED IT" : "REKT",
    aura: revealed && r.via !== "tail" && r.aura !== null ? r.aura / 100 : null,
    contrarian: !!card && againstCity(r.side, card.majority),
    // The Ratio of the Day's winning headline, printed on this market's share card.
    ratio: (await ratioHeadline(db, { marketId: r.marketId }))?.headline ?? null,
  };
}

// --- The Right List -------------------------------------------------------------------------

const seasonStart = (season: number) => new Date(`${addDays(SEASON_EPOCH, (season - 1) * SEASON_LENGTH_DAYS)}T00:00:00Z`);

async function seasonTotals(db: Db, season: number, now: Date) {
  const from = seasonStart(season);
  const to = seasonStart(season + 1);
  // Revealed only: settled before the last bell.
  const lastBell = new Date(`${cityDay(now)}T00:00:00Z`);
  const until = lastBell < to ? lastBell : to;
  return db.execute<{ user_id: string; aura: string; settled: number; auras: number[]; last_call: Date }>(sql`
    SELECT c.user_id, SUM(c.aura_centi)::text AS aura, count(*)::int AS settled, array_agg(c.aura_centi) AS auras, max(c.locked_at) AS last_call
    FROM calls c JOIN markets m ON m.id = c.market_id
    JOIN users u ON u.id = c.user_id
    WHERE c.status = 'locked' AND c.aura_centi IS NOT NULL AND c.via IS DISTINCT FROM 'tail'
      AND (u.proof_of_neighbour_at IS NOT NULL OR u.id IN (SELECT user_id FROM npcs))
      AND m.status = 'resolved' AND m.resolved_at >= ${from.toISOString()}::timestamptz AND m.resolved_at < ${until.toISOString()}::timestamptz
    GROUP BY c.user_id`);
}

// The Receipt Binder: your 9 best receipts of the season (CALLED IT, by Aura),
// for your profile and the trophy wall at home. Revealed only, as on the Right
// List; Tails earn no Aura and don't count. Never an amount or "backed for real".
export const BINDER_SIZE = 9;
export async function receiptBinder(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const season = seasonOf(cityDay(now));
  const from = seasonStart(season);
  const lastBell = new Date(`${cityDay(now)}T00:00:00Z`);
  const rows = await db
    .select({ callId: calls.id, question: markets.question, side: calls.side, chance: calls.chance, world: calls.lockedPrice, aura: calls.auraCenti, resolvedAt: markets.resolvedAt })
    .from(calls)
    .innerJoin(markets, eq(markets.id, calls.marketId))
    .where(
      and(
        eq(calls.userId, userId),
        eq(calls.status, "locked"),
        isNotNull(calls.auraCenti),
        sql`${calls.via} IS DISTINCT FROM 'tail'`,
        eq(markets.status, "resolved"),
        sql`(${calls.side} = 'yes') = ${markets.outcome}`,
        gte(markets.resolvedAt, from),
        lt(markets.resolvedAt, lastBell),
      ),
    )
    .orderBy(desc(calls.auraCenti), desc(markets.resolvedAt))
    .limit(BINDER_SIZE);
  return { season, receipts: rows.map((r) => ({ callId: r.callId, question: r.question, side: r.side, chance: r.chance, world: r.world, aura: r.aura! / 100, resolvedAt: r.resolvedAt })) };
}

// Season Aura ÷ (settled calls + 15), shown as "Aura +6.2 per call ± 3.1".
// 10 settled calls to appear; no call in 14 days marks you rusty, not gone.
export async function rightList(db: Db, opts: { now?: Date; season?: number; limit?: number; userId?: string } = {}) {
  const now = opts.now ?? new Date();
  const season = opts.season ?? seasonOf(cityDay(now));
  const [cur, prev] = await Promise.all([seasonTotals(db, season, now), season > 1 ? seasonTotals(db, season - 1, now) : Promise.resolve([])]);
  const last = new Map([...prev].map((r) => [r.user_id, { auraCenti: Number(r.aura), settled: r.settled }]));
  const rows = [...cur]
    .filter((r) => r.settled >= RIGHT_LIST.minSettled)
    .map((r) => ({
      userId: r.user_id,
      perCall: rightListScore(Number(r.aura), r.settled, last.get(r.user_id)),
      spread: rightListSpread(r.auras),
      settled: r.settled,
      rusty: now.getTime() - new Date(r.last_call).getTime() > RIGHT_LIST.rustyAfterDays * 86_400_000,
    }))
    .sort((a, b) => b.perCall - a.perCall || a.userId.localeCompare(b.userId));
  const ranked = rows.map((r, i) => ({ rank: i + 1, ...r }));
  const handles = new Map(
    ranked.length
      ? (await db.select({ id: residents.userId, handle: residents.handle }).from(residents).where(inArray(residents.userId, ranked.slice(0, opts.limit ?? 100).map((r) => r.userId)))).map((h) => [h.id, h.handle])
      : [],
  );
  const me = opts.userId ? (ranked.find((r) => r.userId === opts.userId) ?? null) : null;
  // The cast keeps its rows, labelled.
  const label = (id: string) => {
    const k = npcById(id);
    return k ? { handle: CAST[k].name, npc: CAST[k].label } : { handle: handles.get(id) ?? null, npc: null };
  };
  return {
    season,
    rows: ranked.slice(0, Math.min(opts.limit ?? 100, 500)).map((r) => ({ ...r, ...label(r.userId) })),
    me,
  };
}

// "Network congested: odds paused at 20:41" once polls stop succeeding. The
// credit line names the feed the odds actually came from.
export async function feedStatus(db: Db, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const [last] = await db
    .select({ at: feedPolls.at, source: feedPolls.source })
    .from(feedPolls)
    .where(and(eq(feedPolls.ok, true), lte(feedPolls.at, now)))
    .orderBy(desc(feedPolls.at))
    .limit(1);
  const paused = !last || now.getTime() - last.at.getTime() > TOWER.feedPausedAfterSeconds * 1000;
  return { paused, lastTickAt: last?.at ?? null, credit: last ? oddsCredit(last.source) : null };
}

// --- Making a call ------------------------------------------------------------------

export type CallInput = { marketId: unknown; side?: unknown; chance: unknown; seenPrice: unknown; via?: unknown; viaUserId?: unknown; inPlay?: unknown };

// Confirms a call: it waits "in the mempool" and locks at the next tick (see
// pollOdds). Off-slate calls take a ticket; a dropped call gives it back.
// inPlay: a call on a match after kickoff, made in the Watch Party Hall at
// its live price. It locks 2 minutes later at the earliest (see playOn), for
// half the Aura, and is never on the Slate, a Tail or a Fade.
export async function makeCall(db: Db, userId: string, input: CallInput, opts: { now?: Date; onSlate?: (marketId: string) => Promise<boolean> } = {}) {
  const now = opts.now ?? new Date();
  if (typeof input.marketId !== "string" || !UUID.test(input.marketId)) throw new TowerError("NO_SUCH_MARKET", "no such market");
  if (input.via !== undefined && input.via !== null && input.via !== "tail" && input.via !== "fade") throw new TowerError("INVALID_INPUT", "via is tail or fade");
  const via = (input.via ?? null) as "tail" | "fade" | null;
  if (via === null && input.side !== "yes" && input.side !== "no") throw new TowerError("INVALID_INPUT", "side is yes or no");
  if (!Number.isInteger(input.seenPrice) || (input.seenPrice as number) < 1 || (input.seenPrice as number) > 99) throw new TowerError("INVALID_INPUT", "seenPrice is a whole percent");
  const seen = input.seenPrice as number;
  if (input.inPlay !== undefined && input.inPlay !== null && typeof input.inPlay !== "boolean") throw new TowerError("INVALID_INPUT", "inPlay is true or false");
  const inPlay = input.inPlay === true;
  if (inPlay && via !== null) throw new TowerError("INVALID_INPUT", "in play, you lock your own call");

  const [me] = await db.select({ id: residents.userId }).from(residents).where(eq(residents.userId, userId));
  if (!me) throw new TowerError("NO_RESIDENT", "move in first");
  const [market] = await db.select().from(markets).where(eq(markets.id, input.marketId.toLowerCase()));
  if (!market) throw new TowerError("NO_SUCH_MARKET", "no such market");
  if (market.infoOnly) throw new TowerError("INFO_ONLY", "this one's on the Odds Wall: read it, don't call it");
  if (inPlay) {
    // The latest poll carried it in play; a match it didn't has no live price.
    if (market.status !== "frozen" || !market.inPlay || market.livePrice === null) throw new TowerError("MARKET_CLOSED", "this match isn't in play right now");
    if (!(await inRoom(db, userId, "watch_party", now))) throw new TowerError("NOT_IN_HALL", "in-play calls are made in the Watch Party Hall");
  } else {
    if (market.status !== "open" || now >= market.freezesAt) throw new TowerError("MARKET_CLOSED", "calls are closed on this market");
    // The latest poll didn't carry it, so its price is stale: no new calls.
    if (!market.inFeed) throw new TowerError("MARKET_CLOSED", "this market has dropped off the feed; calls are closed");
  }
  if ((await feedStatus(db, { now })).paused) throw new TowerError("FEED_PAUSED", "odds are paused; try again when they're back");
  const price = inPlay ? market.livePrice! : market.price;
  if (Math.abs(price - seen) > TOWER.maxSlip) throw new TowerError("PRICE_MOVED", "price moved; call again?");
  // Never on the Slate: the Slate's cards froze at kickoff.
  const onSlate = inPlay ? false : opts.onSlate ? await opts.onSlate(market.id) : await isOnSlate(db, market.id, now);

  // Tail copies a fren's side; Fade takes the other one.
  let side = input.side as Side;
  let viaUserId: string | null = null;
  if (via) {
    if (onSlate) throw new TowerError("INVALID_INPUT", "no tailing or fading on the Slate: lock your own call");
    if (typeof input.viaUserId !== "string" || !UUID.test(input.viaUserId)) throw new TowerError("INVALID_INPUT", "whose call?");
    viaUserId = input.viaUserId.toLowerCase();
    if (viaUserId === userId) throw new TowerError("INVALID_INPUT", "that's your own call");
    if (await isBlockedEitherWay(db, userId, viaUserId)) throw new TowerError("BLOCKED", "you can't");
    if (via === "tail" && !(await areFrens(db, userId, viaUserId))) throw new TowerError("NOT_FRENS", "you tail frens");
    const [theirs] = await db
      .select({ side: calls.side })
      .from(calls)
      .where(and(eq(calls.userId, viaUserId), eq(calls.marketId, market.id), eq(calls.status, "locked")));
    if (!theirs) throw new TowerError("NOTHING_TO_TAIL", "they haven't called this one");
    side = via === "tail" ? theirs.side : theirs.side === "yes" ? "no" : "yes";
  }
  if (!sideOpen(side, seen) || !chanceOnSide(side, seen, input.chance)) throw new TowerError("INVALID_INPUT", `chance must be on the ${side.toUpperCase()} side of ${seen}%`);

  const row = await db.transaction(async (tx) => {
    if (via === "tail") {
      const since = new Date(`${cityDay(now)}T00:00:00Z`);
      const [n] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(calls)
        .where(and(eq(calls.userId, userId), eq(calls.via, "tail"), gte(calls.createdAt, since), inArray(calls.status, ["pending", "locked"])));
      if (n!.n >= TOWER.tailsPerDay) throw new TowerError("TOO_MANY_TAILS", `${TOWER.tailsPerDay} tails a day`);
    }
    let ticket = false;
    if (!onSlate) {
      const { balance, today } = await lockTickets(tx, userId, now);
      if (balance < 1) throw new TowerError("NO_TICKETS", "no tickets left; 3 more at the bell");
      await tx.update(tickets).set({ balance: balance - 1, asOf: today }).where(eq(tickets.userId, userId));
      ticket = true;
    }
    try {
      const [c] = await tx
        .insert(calls)
        .values({ userId, marketId: market.id, side, chance: input.chance as number, seenPrice: seen, onSlate, ticket, via, viaUserId, inPlay, createdAt: now })
        .returning();
      return c!;
    } catch (e) {
      if (isUnique(e)) throw new TowerError("ALREADY_CALLED", "one call per market, no edits");
      throw e;
    }
  });
  // They get pinged (opt-in) when someone fades them.
  if (via === "fade" && viaUserId && !NPC_IDS.includes(viaUserId)) {
    const [r] = await db.select({ handle: residents.handle }).from(residents).where(eq(residents.userId, userId));
    await notify(db, viaUserId, "faded", { handle: r!.handle }, { now });
  }
  return { id: row.id, status: row.status, side: row.side, chance: row.chance, onSlate: row.onSlate, ticket: row.ticket, inPlay: row.inPlay };
}

export async function myCall(db: Db, userId: string, callId: unknown) {
  if (typeof callId !== "string" || !UUID.test(callId)) throw new TowerError("INVALID_INPUT", "which call?");
  const [c] = await db.select().from(calls).where(and(eq(calls.id, callId.toLowerCase()), eq(calls.userId, userId)));
  if (!c) throw new TowerError("INVALID_INPUT", "no such call");
  return c;
}

// --- The Floor --------------------------------------------------------------------------

// A market as one resident sees it: the world's price, the city's and the
// crew's medians (once enough have called), and their own call. On the Slate
// the crowd stays blurred until you lock (Lock to see); Chart-brain hides it.
export async function marketView(db: Db, userId: string, marketId: unknown, opts: { now?: Date; onSlate?: (marketId: string) => Promise<boolean> } = {}) {
  const now = opts.now ?? new Date();
  if (typeof marketId !== "string" || !UUID.test(marketId)) throw new TowerError("NO_SUCH_MARKET", "no such market");
  const [m] = await db.select().from(markets).where(eq(markets.id, marketId.toLowerCase()));
  if (!m) throw new TowerError("NO_SUCH_MARKET", "no such market");
  const [mine] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.userId, userId), eq(calls.marketId, m.id), inArray(calls.status, ["pending", "locked"])));
  const onSlate = opts.onSlate ? await opts.onSlate(m.id) : await isOnSlate(db, m.id, now);
  const mood = await moodState(db, userId, { now });
  const blurred = (onSlate && mine?.status !== "locked") || mood.chartBrain.hideCrowdBars;
  // Blind Slate: even your crew's sides stay hidden until the bell.
  const blind = onSlate && (await slateModifier(db, now)) === "blind_slate";

  let city: number | null = null;
  let crew: number | null = null;
  let cityCount = 0;
  let crewCount = 0;
  if (!blurred && !m.infoOnly) {
    // The cast's calls never move the City or Crew bars; the City bar counts
    // Proof of Neighbour accounts only.
    const locked = (
      await db
        .select({ userId: calls.userId, chance: calls.chance })
        .from(calls)
        .where(and(eq(calls.marketId, m.id), eq(calls.status, "locked"), eq(calls.inPlay, false)))
    ).filter((c) => !NPC_IDS.includes(c.userId));
    const neighbours = await cityCalls(db, [m.id]);
    cityCount = neighbours.length;
    if (cityCount >= TOWER.cityBarMin) city = median(neighbours.map((c) => c.chance));
    const [myCrew] = await db.select({ crewId: crewMembers.crewId }).from(crewMembers).where(and(eq(crewMembers.userId, userId), isNull(crewMembers.leftAt)));
    if (myCrew) {
      const mates = new Set(
        (await db.select({ id: crewMembers.userId }).from(crewMembers).where(and(eq(crewMembers.crewId, myCrew.crewId), isNull(crewMembers.leftAt)))).map((x) => x.id),
      );
      const crewChances = locked.filter((c) => mates.has(c.userId)).map((c) => c.chance);
      crewCount = crewChances.length;
      if (crewCount >= TOWER.crewBarMin && !blind) crew = median(crewChances);
    }
  }
  // A match in play shows its live price, and takes in-play calls at it in
  // the Hall. Its City and Crew bars are the view before kickoff, so no gap.
  const live = m.inPlay && m.livePrice !== null;
  return {
    id: m.id,
    question: m.question,
    category: m.category,
    status: m.status,
    // false: the latest poll didn't carry it, so its price is stale and calls are closed.
    inFeed: m.inFeed,
    infoOnly: m.infoOnly,
    inPlay: live,
    freezesAt: m.freezesAt,
    settlesBy: m.settlesBy,
    world: live ? m.livePrice! : m.price,
    city: blurred ? null : city,
    crew: blurred ? null : crew,
    vibeGap: blurred || live ? null : vibeGap(m.price, city),
    blurred,
    counts: blurred ? null : { city: cityCount, crew: crewCount },
    onSlate,
    mine: mine ? { id: mine.id, side: mine.side, chance: mine.chance, status: mine.status, lockedPrice: mine.lockedPrice, inPlay: mine.inPlay } : null,
    source: oddsCredit(m.source),
  };
}

// The Floor: every callable open market; the Odds Wall: everything open, read-only.
// Only what the latest poll carried and isn't frozen yet: a market the feed
// has dropped has a stale price, and one past its freeze is done.
export async function openMarkets(db: Db, opts: { infoOnly?: boolean; limit?: number; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  return db
    .select({ id: markets.id, question: markets.question, category: markets.category, price: markets.price, freezesAt: markets.freezesAt, infoOnly: markets.infoOnly })
    .from(markets)
    .where(
      and(eq(markets.status, "open"), eq(markets.inFeed, true), gt(markets.freezesAt, now), opts.infoOnly === undefined ? undefined : eq(markets.infoOnly, opts.infoOnly)),
    )
    .orderBy(markets.freezesAt)
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 200));
}

// The Watch Party Hall's matches in play: frozen at kickoff, still trading,
// at their live price, the latest kickoff first.
export async function inPlayMarkets(db: Db, opts: { limit?: number } = {}) {
  const rows = await db
    .select({ id: markets.id, question: markets.question, price: markets.livePrice, kickoffAt: markets.freezesAt, settlesBy: markets.settlesBy })
    .from(markets)
    .where(and(eq(markets.inPlay, true), eq(markets.status, "frozen")))
    .orderBy(desc(markets.freezesAt), markets.id)
    .limit(Math.min(Math.max(opts.limit ?? 20, 1), 50));
  return rows.map((r) => ({ ...r, price: r.price! }));
}

// The side of a resident's locked call on a market, if any (the Bunkers' door).
export async function lockedSide(db: Db, userId: string, marketId: string): Promise<"yes" | "no" | null> {
  const [c] = await db
    .select({ side: calls.side })
    .from(calls)
    .where(and(eq(calls.userId, userId), eq(calls.marketId, marketId), eq(calls.status, "locked")));
  return c?.side ?? null;
}
