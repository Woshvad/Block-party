import { CITY, type CityDay, PLACE_RE, PON, SEASON_EPOCH, SEASON_LENGTH_DAYS, addDays, cityAccountId, cityDay, cityStakeCap, seasonOf, settleCity, userAccountId } from "@bp/core";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { burn, getBalance, openEscrowAccount, transfer } from "./ledger";
import { moodState } from "./moods";
import { isStaff } from "./safety";
import { cityMarkets, cityPositions, residents, users } from "./schema";
import { spendTicket } from "./tower";

export class CityMarketError extends Error {
  constructor(
    readonly code: "NOT_STAFF" | "INVALID_INPUT" | "NO_SUCH_MARKET" | "LOCKED" | "ALREADY_IN" | "OVER_CAP" | "NOT_ENOUGH_GM" | "NO_RESIDENT" | "WRONG_STATE",
    message: string,
  ) {
    super(message);
    this.name = "CityMarketError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (d: CityDay) => new Date(`${d}T00:00:00Z`);
const isUnique = (e: unknown) => ((e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code) === "23505";
const isFunds = (e: unknown) => (e as { code?: string })?.code === "INSUFFICIENT_FUNDS";

// Staff write City markets: a headcount ("20+ on the Roof at the bell?"),
// settled from who was really there, or a manual one staff resolve.
export async function createCityMarket(
  db: Db,
  staffId: string,
  input: { question?: unknown; kind?: unknown; bellDay?: unknown; place?: unknown; threshold?: unknown; measureAt?: unknown },
  opts: { now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  if (!(await isStaff(db, staffId))) throw new CityMarketError("NOT_STAFF", "staff write City markets");
  if (typeof input.question !== "string" || input.question.trim().length < 5 || input.question.length > 200) throw new CityMarketError("INVALID_INPUT", "a question of 5 to 200 characters");
  if (input.kind !== "headcount" && input.kind !== "manual") throw new CityMarketError("INVALID_INPUT", "kind is headcount or manual");
  if (typeof input.bellDay !== "string" || !DAY.test(input.bellDay) || input.bellDay < cityDay(now)) throw new CityMarketError("INVALID_INPUT", "a bell day from today on");
  const bell = dayStart(addDays(input.bellDay, 1));
  const locksAt = new Date(bell.getTime() - CITY.lockBeforeBellHours * 3_600_000);
  let place: string | null = null;
  let threshold: number | null = null;
  let measureAt: Date | null = null;
  if (input.kind === "headcount") {
    if (typeof input.place !== "string" || !PLACE_RE.test(input.place) || input.place.includes(":")) throw new CityMarketError("INVALID_INPUT", "which place?");
    if (!Number.isInteger(input.threshold) || (input.threshold as number) < 1 || (input.threshold as number) > 10_000) throw new CityMarketError("INVALID_INPUT", "a headcount threshold, 1 to 10,000");
    measureAt = input.measureAt === undefined ? bell : new Date(String(input.measureAt));
    if (Number.isNaN(measureAt.getTime()) || measureAt <= locksAt || measureAt > bell) throw new CityMarketError("INVALID_INPUT", "measured after it locks, by the bell");
    place = input.place;
    threshold = input.threshold as number;
  }
  const [m] = await db
    .insert(cityMarkets)
    .values({ question: input.question.trim(), kind: input.kind, bellDay: input.bellDay, locksAt, place, threshold, measureAt, createdBy: staffId, createdAt: now })
    .returning();
  await openEscrowAccount(db, cityAccountId(m!.id));
  return m!;
}

// Staff settle a manual market (or void it). Final once set.
export async function resolveCityMarket(db: Db, staffId: string, marketId: unknown, result: unknown, opts: { now?: Date } = {}) {
  if (!(await isStaff(db, staffId))) throw new CityMarketError("NOT_STAFF", "staff only");
  if (result !== "yes" && result !== "no" && result !== "void") throw new CityMarketError("INVALID_INPUT", "yes, no or void");
  if (typeof marketId !== "string" || !UUID.test(marketId)) throw new CityMarketError("NO_SUCH_MARKET", "no such market");
  const [r] = await db
    .update(cityMarkets)
    .set(result === "void" ? { status: "void", resolvedBy: staffId, resolvedAt: opts.now ?? new Date() } : { status: "resolved", outcome: result === "yes", resolvedBy: staffId, resolvedAt: opts.now ?? new Date() })
    .where(and(eq(cityMarkets.id, marketId.toLowerCase()), eq(cityMarkets.status, "open"), eq(cityMarkets.kind, "manual")))
    .returning({ id: cityMarkets.id });
  if (!r) throw new CityMarketError("WRONG_STATE", "only an open manual market can be resolved");
  return { id: r.id, result };
}

// A stake: once per market, inside your cap, with a ticket, until 2 hours before the bell.
export async function stakeCity(db: Db, userId: string, input: { marketId?: unknown; side?: unknown; stake?: unknown }, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  if (typeof input.marketId !== "string" || !UUID.test(input.marketId)) throw new CityMarketError("NO_SUCH_MARKET", "no such market");
  if (input.side !== "yes" && input.side !== "no") throw new CityMarketError("INVALID_INPUT", "side is yes or no");
  if (!Number.isInteger(input.stake) || (input.stake as number) < 1) throw new CityMarketError("INVALID_INPUT", "a whole number of GM");
  const stake = input.stake as number;
  const [r] = await db.select({ createdAt: residents.createdAt }).from(residents).where(eq(residents.userId, userId));
  if (!r) throw new CityMarketError("NO_RESIDENT", "move in first");
  const [m] = await db.select().from(cityMarkets).where(eq(cityMarkets.id, input.marketId.toLowerCase()));
  if (!m) throw new CityMarketError("NO_SUCH_MARKET", "no such market");
  if (m.status !== "open" || now >= m.locksAt) throw new CityMarketError("LOCKED", "this market has locked");
  const [u] = await db.select({ pon: users.proofOfNeighbourAt }).from(users).where(eq(users.id, userId));
  const tilted = (await moodState(db, userId, { now })).tilt.tilted;
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);
      const cap = cityStakeCap({ balance: await getBalance(tx, userAccountId(userId)), residentDays: (now.getTime() - r.createdAt.getTime()) / 86_400_000, pon: !!u?.pon, tilted });
      if (stake > cap) throw new CityMarketError("OVER_CAP", `you can stake up to ${cap} GM`);
      const [p] = await tx.insert(cityPositions).values({ marketId: m.id, userId, side: input.side as "yes" | "no", stake, createdAt: now }).returning();
      await spendTicket(tx, userId, now);
      await transfer(tx, { from: userAccountId(userId), to: cityAccountId(m.id), amount: stake, kind: "city_stake", idempotencyKey: `city:${m.id}:${userId}:stake` });
      return { id: p!.id, side: p!.side, stake };
    });
  } catch (e) {
    if (isUnique(e)) throw new CityMarketError("ALREADY_IN", "one stake per market");
    if (isFunds(e)) throw new CityMarketError("NOT_ENOUGH_GM", "not enough GM");
    throw e;
  }
}

// Who was really there: Proof of Neighbour residents who made a call that city
// day and were in the room at the moment (never away, never the cast).
export async function headcount(db: Db, place: string, at: Date, day: CityDay) {
  const cap = `${PON.openVisitCapHours} hours`;
  const [r] = await db.execute<{ n: number }>(sql`
    SELECT count(DISTINCT v.user_id)::int AS n
    FROM room_visits v
    JOIN users u ON u.id = v.user_id AND u.proof_of_neighbour_at IS NOT NULL
    WHERE split_part(v.room, '#', 1) = ${place}
      AND v.joined_at <= ${at.toISOString()}::timestamptz
      AND COALESCE(v.left_at, LEAST(${at.toISOString()}::timestamptz, v.joined_at + ${cap}::interval)) >= ${at.toISOString()}::timestamptz
      AND v.user_id NOT IN (SELECT user_id FROM npcs)
      AND EXISTS (SELECT 1 FROM calls c WHERE c.user_id = v.user_id AND c.status = 'locked'
                  AND c.locked_at >= ${dayStart(day).toISOString()}::timestamptz AND c.locked_at < ${dayStart(addDays(day, 1)).toISOString()}::timestamptz)`);
  return r?.n ?? 0;
}

// At the bell: headcounts are counted, resolved markets pay out, voids refund.
// An unresolved manual market waits for a later bell.
export async function settleCityMarkets(db: Db, bellDay: CityDay, now: Date) {
  const due = await db
    .select()
    .from(cityMarkets)
    .where(and(sql`${cityMarkets.bellDay} <= ${bellDay}`, inArray(cityMarkets.status, ["open", "resolved", "void"])));
  let settled = 0;
  for (const m of due) {
    let outcome: boolean | null = m.status === "resolved" ? m.outcome : null;
    if (m.status === "open" && m.kind === "headcount" && m.bellDay <= bellDay) {
      outcome = (await headcount(db, m.place!, m.measureAt!, m.bellDay)) >= m.threshold!;
      await db.update(cityMarkets).set({ status: "resolved", outcome, resolvedAt: now }).where(and(eq(cityMarkets.id, m.id), eq(cityMarkets.status, "open")));
    }
    if (m.status === "open" && m.kind === "manual") continue; // staff haven't called it yet
    await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(cityMarkets).where(eq(cityMarkets.id, m.id)).for("no key update");
      if (!cur || cur.status === "settled" || cur.status === "refunded") return;
      const positions = await tx.select().from(cityPositions).where(eq(cityPositions.marketId, m.id));
      const result = cur.status === "void" ? null : (cur.outcome ?? outcome);
      const plan =
        result === null
          ? { payouts: new Map(positions.map((p) => [p.id, p.stake])), burned: 0, dust: 0 }
          : settleCity(
              positions.map((p) => ({ id: p.id, side: p.side, stake: p.stake })),
              result,
            );
      for (const p of positions) {
        const amount = plan.payouts.get(p.id) ?? 0;
        if (amount > 0) await transfer(tx, { from: cityAccountId(m.id), to: userAccountId(p.userId), amount, kind: result === null ? "city_refund" : "city_payout", idempotencyKey: `city:${m.id}:${p.userId}:payout` });
        await tx.update(cityPositions).set({ payout: amount }).where(eq(cityPositions.id, p.id));
      }
      if (plan.burned > 0) await burn(tx, { accountId: cityAccountId(m.id), amount: plan.burned, kind: "city_bell_burn", idempotencyKey: `city:${m.id}:bell_burn` });
      if (plan.dust > 0) await burn(tx, { accountId: cityAccountId(m.id), amount: plan.dust, kind: "city_dust", idempotencyKey: `city:${m.id}:dust` });
      await tx
        .update(cityMarkets)
        .set(result === null ? { status: "refunded" } : { status: "settled", outcome: result })
        .where(eq(cityMarkets.id, m.id));
      settled++;
    });
  }
  return { settled };
}

export async function openCityMarkets(db: Db, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  return db
    .select({ id: cityMarkets.id, question: cityMarkets.question, kind: cityMarkets.kind, place: cityMarkets.place, threshold: cityMarkets.threshold, locksAt: cityMarkets.locksAt, bellDay: cityMarkets.bellDay })
    .from(cityMarkets)
    .where(and(eq(cityMarkets.status, "open"), gte(cityMarkets.locksAt, now)))
    .limit(50);
}


// --- The Season Stack ----------------------------------------------------------------

// GM profit on City markets and Fade Duels this season. Real-money profit is
// never ranked anywhere.
export async function seasonStack(db: Db, opts: { now?: Date; season?: number; limit?: number } = {}) {
  const now = opts.now ?? new Date();
  const season = opts.season ?? seasonOf(cityDay(now));
  const from = dayStart(addDays(SEASON_EPOCH, (season - 1) * SEASON_LENGTH_DAYS)).toISOString();
  const to = dayStart(addDays(SEASON_EPOCH, season * SEASON_LENGTH_DAYS)).toISOString();
  const rows = await db.execute<{ user_id: string; profit: number }>(sql`
    WITH flows AS (
      SELECT p.user_id, p.payout - p.stake AS profit
      FROM city_positions p JOIN city_markets m ON m.id = p.market_id
      WHERE m.status IN ('settled', 'refunded') AND p.payout IS NOT NULL
        AND m.bell_day >= ${from.slice(0, 10)}::date AND m.bell_day < ${to.slice(0, 10)}::date
      UNION ALL
      SELECT d.winner_id, CASE WHEN d.winner_id = d.challenger_id THEN d.stake_opponent ELSE d.stake_challenger END
      FROM duels d WHERE d.status = 'settled' AND d.ended_at >= ${from}::timestamptz AND d.ended_at < ${to}::timestamptz
      UNION ALL
      SELECT CASE WHEN d.winner_id = d.challenger_id THEN d.opponent_id ELSE d.challenger_id END,
             -CASE WHEN d.winner_id = d.challenger_id THEN d.stake_opponent ELSE d.stake_challenger END
      FROM duels d WHERE d.status = 'settled' AND d.ended_at >= ${from}::timestamptz AND d.ended_at < ${to}::timestamptz
      UNION ALL
      SELECT d.retreated_by, -CASE WHEN d.retreated_by = d.challenger_id THEN d.stake_challenger ELSE d.stake_opponent END
      FROM duels d WHERE d.status = 'retreated' AND d.ended_at >= ${from}::timestamptz AND d.ended_at < ${to}::timestamptz
      UNION ALL
      SELECT CASE WHEN d.retreated_by = d.challenger_id THEN d.opponent_id ELSE d.challenger_id END, 10
      FROM duels d WHERE d.status = 'retreated' AND d.ended_at >= ${from}::timestamptz AND d.ended_at < ${to}::timestamptz
    )
    SELECT f.user_id, SUM(f.profit)::int AS profit FROM flows f GROUP BY f.user_id
    ORDER BY profit DESC, f.user_id LIMIT ${Math.min(Math.max(opts.limit ?? 100, 1), 500)}`);
  const ids = [...rows].map((r) => r.user_id);
  const handles = new Map(ids.length ? (await db.select({ id: residents.userId, handle: residents.handle }).from(residents).where(inArray(residents.userId, ids))).map((h) => [h.id, h.handle]) : []);
  return { season, rows: [...rows].map((r, i) => ({ rank: i + 1, userId: r.user_id, handle: handles.get(r.user_id) ?? null, profit: r.profit })) };
}
