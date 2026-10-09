import { type CityDay, GRUDGE, NPC_IDS, addDays, cityDay, grudgeAccountId, grudgeWinner, userAccountId } from "@bp/core";
import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "./client";
import { openEscrowAccount, transfer } from "./ledger";
import { isBlockedEitherWay } from "./safety";
import { calls, grudgeMatches, inviters, slateCards } from "./schema";

export class GrudgeError extends Error {
  constructor(
    readonly code: "NO_INVITER" | "ONCE_PER_PAIR" | "NOT_ENOUGH_GM" | "BLOCKED" | "NO_SUCH_MATCH" | "NOT_YOURS" | "WRONG_STATE" | "TOO_LATE" | "INVALID_INPUT",
    message: string,
  ) {
    super(message);
    this.name = "GrudgeError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUnique = (e: unknown) => ((e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code) === "23505";
const isFunds = (e: unknown) => (e as { code?: string })?.code === "INSUFFICIENT_FUNDS";
const dayEnd = (d: CityDay) => new Date(`${addDays(d, 1)}T00:00:00Z`);
type Match = typeof grudgeMatches.$inferSelect;

async function lockMatch(tx: Db, id: unknown) {
  if (typeof id !== "string" || !UUID.test(id)) throw new GrudgeError("NO_SUCH_MATCH", "no such match");
  const [m] = await tx.select().from(grudgeMatches).where(eq(grudgeMatches.id, id.toLowerCase())).for("no key update");
  if (!m) throw new GrudgeError("NO_SUCH_MATCH", "no such match");
  return m;
}

const pay = (tx: Db, m: Match, to: string, amount: number, tag: string) =>
  transfer(tx, { from: grudgeAccountId(m.id), to: userAccountId(to), amount, kind: "grudge_payout", idempotencyKey: `grudge:${m.id}:${tag}` });

// The newcomer throws it down: tomorrow's Slate, head to head with whoever invited them.
export async function offerGrudge(db: Db, newcomerId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const [inv] = await db.select().from(inviters).where(eq(inviters.userId, newcomerId));
  if (!inv || NPC_IDS.includes(inv.inviterId)) throw new GrudgeError("NO_INVITER", "a Grudge Match is against the friend who invited you");
  if (await isBlockedEitherWay(db, newcomerId, inv.inviterId)) throw new GrudgeError("BLOCKED", "you can't");
  const day = addDays(cityDay(now), 1);
  try {
    return await db.transaction(async (tx) => {
      const [m] = await tx.insert(grudgeMatches).values({ cityDay: day, newcomerId, inviterId: inv.inviterId, createdAt: now }).returning();
      await openEscrowAccount(tx, grudgeAccountId(m!.id));
      await transfer(tx, { from: userAccountId(newcomerId), to: grudgeAccountId(m!.id), amount: GRUDGE.stake, kind: "grudge_stake", idempotencyKey: `grudge:${m!.id}:stake:n` });
      return { id: m!.id, cityDay: day, status: m!.status };
    });
  } catch (e) {
    if (isUnique(e)) throw new GrudgeError("ONCE_PER_PAIR", "one Grudge Match per pair, ever");
    if (isFunds(e)) throw new GrudgeError("NOT_ENOUGH_GM", "not enough GM");
    throw e;
  }
}

export async function respondGrudge(db: Db, inviterId: string, matchId: unknown, accept: unknown, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  if (typeof accept !== "boolean") throw new GrudgeError("INVALID_INPUT", "accept is true or false");
  try {
    return await db.transaction(async (tx) => {
      const m = await lockMatch(tx, matchId);
      if (m.inviterId !== inviterId) throw new GrudgeError("NOT_YOURS", "that match isn't for you");
      if (m.status !== "offered") throw new GrudgeError("WRONG_STATE", "that match isn't waiting on you");
      if (now >= dayEnd(m.cityDay)) throw new GrudgeError("TOO_LATE", "that Slate is over");
      if (!accept) {
        await pay(tx, m, m.newcomerId, GRUDGE.stake, "refund:n");
        await tx.update(grudgeMatches).set({ status: "declined", endedAt: now }).where(eq(grudgeMatches.id, m.id));
        return { id: m.id, status: "declined" as const };
      }
      await transfer(tx, { from: userAccountId(inviterId), to: grudgeAccountId(m.id), amount: GRUDGE.stake, kind: "grudge_stake", idempotencyKey: `grudge:${m.id}:stake:i` });
      await tx.update(grudgeMatches).set({ status: "active" }).where(eq(grudgeMatches.id, m.id));
      return { id: m.id, status: "active" as const };
    });
  } catch (e) {
    if (isFunds(e)) throw new GrudgeError("NOT_ENOUGH_GM", "not enough GM");
    throw e;
  }
}

export async function cancelGrudge(db: Db, newcomerId: string, matchId: unknown, opts: { now?: Date } = {}) {
  return db.transaction(async (tx) => {
    const m = await lockMatch(tx, matchId);
    if (m.newcomerId !== newcomerId) throw new GrudgeError("NOT_YOURS", "not your match");
    if (m.status !== "offered") throw new GrudgeError("WRONG_STATE", "only an unanswered match can be taken back");
    await pay(tx, m, m.newcomerId, GRUDGE.stake, "refund:n");
    await tx.update(grudgeMatches).set({ status: "cancelled", endedAt: opts.now ?? new Date() }).where(eq(grudgeMatches.id, m.id));
    return { id: m.id, status: "cancelled" as const };
  });
}

// At the day's bell: higher Slate Aura takes the pot; a tie gives both back;
// an unanswered offer goes home.
export async function settleGrudges(db: Db, bellDay: CityDay, now: Date) {
  const due = await db
    .select({ id: grudgeMatches.id })
    .from(grudgeMatches)
    .where(and(eq(grudgeMatches.cityDay, bellDay), inArray(grudgeMatches.status, ["offered", "active"])));
  const cards = (await db.select({ id: slateCards.marketId }).from(slateCards).where(eq(slateCards.cityDay, bellDay))).map((c) => c.id);
  let settled = 0;
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const m = await lockMatch(tx, id);
      if (m.status === "offered") {
        await pay(tx, m, m.newcomerId, GRUDGE.stake, "refund:n");
        await tx.update(grudgeMatches).set({ status: "expired", endedAt: now }).where(eq(grudgeMatches.id, m.id));
        return;
      }
      if (m.status !== "active") return;
      const rows = cards.length
        ? await tx
            .select({ userId: calls.userId, aura: calls.auraCenti })
            .from(calls)
            .where(and(inArray(calls.marketId, cards), eq(calls.status, "locked"), eq(calls.onSlate, true), or(eq(calls.userId, m.newcomerId), eq(calls.userId, m.inviterId))))
        : [];
      const total = (u: string) => rows.filter((r) => r.userId === u).reduce((a, r) => a + (r.aura ?? 0), 0);
      const winner = grudgeWinner({ id: m.newcomerId, auraCenti: total(m.newcomerId) }, { id: m.inviterId, auraCenti: total(m.inviterId) });
      if (winner) {
        await pay(tx, m, winner, GRUDGE.stake * 2, "win");
        await tx.update(grudgeMatches).set({ status: "settled", winnerId: winner, endedAt: now }).where(eq(grudgeMatches.id, m.id));
      } else {
        await pay(tx, m, m.newcomerId, GRUDGE.stake, "refund:n");
        await pay(tx, m, m.inviterId, GRUDGE.stake, "refund:i");
        await tx.update(grudgeMatches).set({ status: "tied", endedAt: now }).where(eq(grudgeMatches.id, m.id));
      }
      settled++;
    });
  }
  return { settled };
}

export async function myGrudges(db: Db, userId: string) {
  return db
    .select()
    .from(grudgeMatches)
    .where(or(eq(grudgeMatches.newcomerId, userId), eq(grudgeMatches.inviterId, userId)))
    .limit(20);
}
