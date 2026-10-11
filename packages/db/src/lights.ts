import { type CityDay, addDays, cityDay, crewPotAccountId, lightsAccountId, lightsReserve, topBid } from "@bp/core";
import { and, asc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import type { Db } from "./client";
import { burn, openEscrowAccount, transfer } from "./ledger";
import { crewMembers, crews, lightBids } from "./schema";

export class LightsError extends Error {
  constructor(
    readonly code: "NOT_ALLOWED" | "INVALID_INPUT" | "UNDER_RESERVE" | "NOT_HIGHER" | "NOT_ENOUGH_GM",
    message: string,
  ) {
    super(message);
    this.name = "LightsError";
  }
}

const isFunds = (e: unknown) => (e as { code?: string })?.code === "INSUFFICIENT_FUNDS";

async function reserveFor(db: Db, day: CityDay) {
  const won = await db
    .select({ amount: lightBids.amount })
    .from(lightBids)
    .where(and(eq(lightBids.status, "won"), gte(lightBids.cityDay, addDays(day, -7)), lt(lightBids.cityDay, day)));
  return lightsReserve(won.map((w) => w.amount));
}

// The lead or a deputy bids (or raises) from the crew pot for tonight's bell.
export async function bidLights(db: Db, userId: string, amount: unknown, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const day = cityDay(now);
  if (!Number.isInteger(amount) || (amount as number) < 1) throw new LightsError("INVALID_INPUT", "a whole number of GM");
  const [m] = await db.select({ crewId: crewMembers.crewId, role: crewMembers.role }).from(crewMembers).where(and(eq(crewMembers.userId, userId), isNull(crewMembers.leftAt)));
  if (!m || m.role === "member") throw new LightsError("NOT_ALLOWED", "the lead and deputies bid from the pot");
  const reserve = await reserveFor(db, day);
  if ((amount as number) < reserve) throw new LightsError("UNDER_RESERVE", `the reserve tonight is ${reserve} GM`);
  try {
    return await db.transaction(async (tx) => {
      // One bidder at a time for the night, so the top bid is always true.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`lights:${day}`}))`);
      await openEscrowAccount(tx, lightsAccountId(day));
      const [mine] = await tx.select().from(lightBids).where(and(eq(lightBids.cityDay, day), eq(lightBids.crewId, m.crewId)));
      if (mine && (amount as number) <= mine.amount) throw new LightsError("NOT_HIGHER", "a raise has to be higher than your bid");
      const extra = (amount as number) - (mine?.amount ?? 0);
      await transfer(tx, { from: crewPotAccountId(m.crewId), to: lightsAccountId(day), amount: extra, kind: "lights_bid", idempotencyKey: `lights:${day}:${m.crewId}:${amount}` });
      await tx
        .insert(lightBids)
        .values({ cityDay: day, crewId: m.crewId, amount: amount as number, placedBy: userId, at: now })
        .onConflictDoUpdate({ target: [lightBids.cityDay, lightBids.crewId], set: { amount: amount as number, placedBy: userId, at: now } });
      return { cityDay: day, amount: amount as number };
    });
  } catch (e) {
    if (isFunds(e)) throw new LightsError("NOT_ENOUGH_GM", "not enough GM in the pot");
    throw e;
  }
}

// What the Tower shows all day: the top bid, the reserve, and for your crew
// whether you've been outbid ("outbid by @crew").
export async function lightsBoard(db: Db, crewId: string | null, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const day = cityDay(now);
  const bids = await db
    .select({ crewId: lightBids.crewId, name: crews.name, amount: lightBids.amount, at: lightBids.at })
    .from(lightBids)
    .innerJoin(crews, eq(crews.id, lightBids.crewId))
    .where(and(eq(lightBids.cityDay, day), eq(lightBids.status, "open")));
  const top = topBid(bids.map((b) => ({ ...b, at: b.at.getTime() })));
  const mine = crewId ? bids.find((b) => b.crewId === crewId) : undefined;
  return {
    cityDay: day,
    reserve: await reserveFor(db, day),
    top: top ? { crew: top.name, amount: top.amount } : null,
    mine: mine ? { amount: mine.amount, leading: top?.crewId === crewId, outbidBy: top && top.crewId !== crewId ? top.name : null } : null,
  };
}

// At the bell: the top bid burns and lights the Tower; every other bid goes
// home. Every day up to and including bellDay that still has open bids, so a
// day whose bell never ran is settled by the next one rather than leaving its
// bids in escrow for good. Returns what burned, day by day.
export async function settleLights(db: Db, bellDay: CityDay) {
  const days = await db
    .selectDistinct({ day: lightBids.cityDay })
    .from(lightBids)
    .where(and(lte(lightBids.cityDay, bellDay), eq(lightBids.status, "open")))
    .orderBy(asc(lightBids.cityDay));
  const out: Array<{ cityDay: CityDay; crewId: string; amount: number }> = [];
  for (const { day } of days) {
    const won = await settleLightsDay(db, day);
    if (won) out.push({ cityDay: day, ...won });
  }
  return out;
}

async function settleLightsDay(db: Db, day: CityDay) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`lights:${day}`}))`);
    const bids = await tx.select().from(lightBids).where(and(eq(lightBids.cityDay, day), eq(lightBids.status, "open")));
    const top = topBid(bids.map((b) => ({ ...b, at: b.at.getTime() })));
    if (!top) return null;
    // A crew that dissolved after bidding has no pot to go home to (it was
    // burned): its refund burns instead. The share lock, taken before any
    // ledger lock, keeps a dissolve from landing between check and refund.
    const crewRows = await tx.select({ id: crews.id, dissolvedAt: crews.dissolvedAt }).from(crews).where(inArray(crews.id, bids.map((b) => b.crewId))).orderBy(asc(crews.id)).for("share");
    const dissolved = new Set(crewRows.filter((c) => c.dissolvedAt).map((c) => c.id));
    await burn(tx, { accountId: lightsAccountId(day), amount: top.amount, kind: "tower_lights", idempotencyKey: `lights:${day}:burn` });
    for (const b of bids) {
      if (b.crewId === top.crewId) continue;
      const key = `lights:${day}:${b.crewId}:refund`;
      if (dissolved.has(b.crewId)) await burn(tx, { accountId: lightsAccountId(day), amount: b.amount, kind: "crew_dissolve", idempotencyKey: key, meta: { crewId: b.crewId } });
      else await transfer(tx, { from: lightsAccountId(day), to: crewPotAccountId(b.crewId), amount: b.amount, kind: "lights_refund", idempotencyKey: key });
    }
    await tx.update(lightBids).set({ status: sql`CASE WHEN ${lightBids.crewId} = ${top.crewId} THEN 'won'::light_bid_status ELSE 'refunded'::light_bid_status END` }).where(and(eq(lightBids.cityDay, day), inArray(lightBids.crewId, bids.map((b) => b.crewId))));
    return { crewId: top.crewId, amount: top.amount };
  });
}

export async function lightsWinner(db: Db, bellDay: CityDay) {
  const [w] = await db
    .select({ crew: crews.name, amount: lightBids.amount })
    .from(lightBids)
    .innerJoin(crews, eq(crews.id, lightBids.crewId))
    .where(and(eq(lightBids.cityDay, bellDay), eq(lightBids.status, "won")));
  return w ?? null;
}
