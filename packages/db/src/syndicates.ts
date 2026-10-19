import { SYNDICATE, cityAccountId, cityDay, crewPotAccountId, shakesNeeded, sliderStart } from "@bp/core";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./client";
import { lockAccounts, transfer } from "./ledger";
import { notify } from "./notify";
import { calls, cityMarkets, cityPositions, crewMembers, crews, dailyGm, markets, residents, syndicateShakes, syndicates } from "./schema";
import { onBlindSlate } from "./slate";
import { makeCall } from "./tower";

export class SyndicateError extends Error {
  constructor(
    readonly code: "NOT_IN_CREW" | "INVALID_INPUT" | "NO_SUCH_MARKET" | "MARKET_CLOSED" | "ALREADY_PROPOSED" | "NO_SUCH_SYNDICATE" | "EXPIRED" | "ALREADY_SHOOK" | "OTHER_SIDE" | "BLIND_SLATE",
    message: string,
  ) {
    super(message);
    this.name = "SyndicateError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUnique = (e: unknown) => ((e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code) === "23505";
type Syndicate = typeof syndicates.$inferSelect;

async function crewOf(db: Db, userId: string) {
  const [m] = await db.select({ crewId: crewMembers.crewId }).from(crewMembers).where(and(eq(crewMembers.userId, userId), isNull(crewMembers.leftAt)));
  if (!m) throw new SyndicateError("NOT_IN_CREW", "syndicates are crew calls");
  return m.crewId;
}

// Members who said gm today: the syndicate's "active that day".
async function activeToday(db: Db, crewId: string, now: Date) {
  const [n] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(crewMembers)
    .innerJoin(dailyGm, and(eq(dailyGm.userId, crewMembers.userId), eq(dailyGm.cityDay, cityDay(now))))
    .where(and(eq(crewMembers.crewId, crewId), isNull(crewMembers.leftAt)));
  return n!.n;
}

async function target(db: Db, s: { marketId: string | null; cityMarketId: string | null }, now: Date) {
  if (s.marketId) {
    const [m] = await db.select().from(markets).where(eq(markets.id, s.marketId));
    if (!m) throw new SyndicateError("NO_SUCH_MARKET", "no such market");
    if (m.infoOnly || m.status !== "open" || now >= m.freezesAt) throw new SyndicateError("MARKET_CLOSED", "that market is closed for calls");
    // A syndicate shows the crew where it stands, and on a Blind Slate even
    // your crew's sides stay hidden until the bell.
    if (await onBlindSlate(db, m.id, now)) throw new SyndicateError("BLIND_SLATE", "it's a Blind Slate: your crew's sides stay hidden until the bell");
    return { kind: "tower" as const, price: m.price };
  }
  const [c] = await db.select().from(cityMarkets).where(eq(cityMarkets.id, s.cityMarketId!));
  if (!c) throw new SyndicateError("NO_SUCH_MARKET", "no such market");
  if (c.status !== "open" || now >= c.locksAt) throw new SyndicateError("MARKET_CLOSED", "that market has locked");
  return { kind: "city" as const, price: null };
}

export async function proposeSyndicate(
  db: Db,
  userId: string,
  input: { marketId?: unknown; cityMarketId?: unknown; side?: unknown; perShake?: unknown; chance?: unknown },
  opts: { now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  const crewId = await crewOf(db, userId);
  const tower = typeof input.marketId === "string" && UUID.test(input.marketId) ? input.marketId.toLowerCase() : null;
  const city = typeof input.cityMarketId === "string" && UUID.test(input.cityMarketId) ? input.cityMarketId.toLowerCase() : null;
  if ((tower === null) === (city === null)) throw new SyndicateError("INVALID_INPUT", "one market: a Tower market or a City market");
  if (input.side !== "yes" && input.side !== "no") throw new SyndicateError("INVALID_INPUT", "side is yes or no");
  let perShake: number | null = null;
  if (city) {
    if (!Number.isInteger(input.perShake) || (input.perShake as number) < 1 || (input.perShake as number) > SYNDICATE.maxPerShake) {
      throw new SyndicateError("INVALID_INPUT", `1 to ${SYNDICATE.maxPerShake} GM from the pot per member who shakes`);
    }
    perShake = input.perShake as number;
  }
  await target(db, { marketId: tower, cityMarketId: city }, now);
  let s: Syndicate;
  try {
    [s] = (await db
      .insert(syndicates)
      .values({ crewId, proposerId: userId, marketId: tower, cityMarketId: city, side: input.side, perShake, needed: shakesNeeded(await activeToday(db, crewId, now)), createdAt: now, expiresAt: new Date(now.getTime() + SYNDICATE.windowHours * 3_600_000) })
      .returning()) as [Syndicate];
  } catch (e) {
    if (isUnique(e)) throw new SyndicateError("ALREADY_PROPOSED", "your crew already has a syndicate on that market");
    throw e;
  }
  // The crew hears about it (opt-in); the proposer's own shake counts.
  const mates = await db.select({ id: crewMembers.userId }).from(crewMembers).where(and(eq(crewMembers.crewId, crewId), isNull(crewMembers.leftAt)));
  for (const m of mates) if (m.id !== userId) await notify(db, m.id, "syndicate_shake", {}, { now });
  return shakeSyndicate(db, userId, s.id, { chance: input.chance }, { now });
}

// A shake. On a Tower market it makes (or confirms) your own free call on the
// syndicate's side. At the threshold the syndicate goes live; on a City market
// that stakes from the pot, and each later shake tops it up.
export async function shakeSyndicate(db: Db, userId: string, syndicateId: unknown, input: { chance?: unknown } = {}, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  if (typeof syndicateId !== "string" || !UUID.test(syndicateId)) throw new SyndicateError("NO_SUCH_SYNDICATE", "no such syndicate");
  const [s] = await db.select().from(syndicates).where(eq(syndicates.id, syndicateId.toLowerCase()));
  if (!s) throw new SyndicateError("NO_SUCH_SYNDICATE", "no such syndicate");
  if ((await crewOf(db, userId)) !== s.crewId) throw new SyndicateError("NOT_IN_CREW", "that's another crew's syndicate");
  if (s.status === "expired" || (s.status === "proposed" && now >= s.expiresAt)) throw new SyndicateError("EXPIRED", "that syndicate's window closed");
  const t = await target(db, s, now);
  const [already] = await db.select().from(syndicateShakes).where(and(eq(syndicateShakes.syndicateId, s.id), eq(syndicateShakes.userId, userId)));
  if (already) throw new SyndicateError("ALREADY_SHOOK", "you've shaken on it");

  if (t.kind === "tower") {
    const [mine] = await db.select({ side: calls.side }).from(calls).where(and(eq(calls.userId, userId), eq(calls.marketId, s.marketId!), inArray(calls.status, ["pending", "locked"])));
    if (mine && mine.side !== s.side) throw new SyndicateError("OTHER_SIDE", "you've already called the other side");
    if (!mine) {
      const chance = input.chance === undefined ? sliderStart(s.side, t.price!) : input.chance;
      await makeCall(db, userId, { marketId: s.marketId, side: s.side, chance, seenPrice: t.price }, { now });
    }
  }

  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(syndicates).where(eq(syndicates.id, s.id)).for("no key update");
    try {
      await tx.insert(syndicateShakes).values({ syndicateId: s.id, userId, at: now });
    } catch (e) {
      if (isUnique(e)) throw new SyndicateError("ALREADY_SHOOK", "you've shaken on it");
      throw e;
    }
    const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(syndicateShakes).where(eq(syndicateShakes.syndicateId, s.id));
    let status = cur!.status;
    if (status === "proposed" && n!.n >= cur!.needed) {
      status = "live";
      await tx.update(syndicates).set({ status: "live", liveAt: now }).where(eq(syndicates.id, s.id));
    }
    // A live City syndicate stakes perShake per shaker from the pot (as far as the pot goes).
    if (status === "live" && cur!.cityMarketId) {
      // The crew first (shared, so a dissolve can't burn the pot under us),
      // then the pot under the ledger's own lock, in its order: two shakes at
      // once each see what the other left, rather than both spending it.
      const [crew] = await tx.select({ dissolvedAt: crews.dissolvedAt }).from(crews).where(eq(crews.id, cur!.crewId)).for("share");
      if (!crew || crew.dissolvedAt) throw new SyndicateError("NOT_IN_CREW", "that crew has dissolved");
      const pot = crewPotAccountId(cur!.crewId);
      const want = (cur!.status === "proposed" ? n!.n : 1) * cur!.perShake!;
      const inPot = (await lockAccounts(tx, [pot, cityAccountId(cur!.cityMarketId)])).get(pot) ?? 0;
      const amount = Math.min(want, inPot);
      if (amount > 0) {
        await transfer(tx, { from: pot, to: cityAccountId(cur!.cityMarketId), amount, kind: "syndicate_stake", idempotencyKey: `syndicate:${s.id}:${userId}` });
        const [pos] = await tx
          .insert(cityPositions)
          .values({ marketId: cur!.cityMarketId, crewId: cur!.crewId, side: cur!.side, stake: amount, createdAt: now })
          .onConflictDoUpdate({ target: [cityPositions.marketId, cityPositions.crewId], set: { stake: sql`${cityPositions.stake} + ${amount}` } })
          .returning();
        if (pos!.side !== cur!.side) throw new SyndicateError("OTHER_SIDE", "the crew already holds the other side");
      }
    }
    return { id: s.id, status, shakes: n!.n, needed: cur!.needed };
  });
}

// The Crew Table: your crew's open syndicates and who shook (never who traded real, or how much).
export async function crewTable(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const crewId = await crewOf(db, userId);
  await db
    .update(syndicates)
    .set({ status: "expired" })
    .where(and(eq(syndicates.crewId, crewId), eq(syndicates.status, "proposed"), sql`${syndicates.expiresAt} <= ${now.toISOString()}::timestamptz`));
  const rows = await db
    .select()
    .from(syndicates)
    .where(and(eq(syndicates.crewId, crewId), gte(syndicates.createdAt, new Date(now.getTime() - 2 * 86_400_000))))
    .orderBy(sql`${syndicates.createdAt} DESC`)
    .limit(30);
  const shakes = rows.length
    ? await db
        .select({ syndicateId: syndicateShakes.syndicateId, handle: residents.handle })
        .from(syndicateShakes)
        .innerJoin(residents, eq(residents.userId, syndicateShakes.userId))
        .where(inArray(syndicateShakes.syndicateId, rows.map((r) => r.id)))
    : [];
  return rows.map((r) => ({
    id: r.id,
    marketId: r.marketId,
    cityMarketId: r.cityMarketId,
    side: r.side,
    perShake: r.perShake,
    status: r.status,
    needed: r.needed,
    expiresAt: r.expiresAt,
    shook: shakes.filter((x) => x.syndicateId === r.id).map((x) => x.handle),
  }));
}
