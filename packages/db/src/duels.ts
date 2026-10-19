import { DUEL, NPC_IDS, canDouble, duelAccountId, nextBell, retreatSplit, userAccountId } from "@bp/core";
import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./client";
import { isFlaggedPair } from "./alts";
import { burn, getBalance, openEscrowAccount, transfer } from "./ledger";
import { maybeTilt, moodState } from "./moods";
import { notify } from "./notify";
import { isBlockedEitherWay } from "./safety";
import { calls, crewMembers, duelPrefs, duels, markets, residents, users } from "./schema";
import { onBlindSlate } from "./slate";

export class DuelError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "NO_SUCH_DUEL"
      | "NOT_YOURS"
      | "DUELS_OFF"
      | "NOT_ACROSS"
      | "MARKET_CLOSED"
      | "NEEDS_PON"
      | "NOT_ENOUGH_GM"
      | "TOO_MANY_OPEN"
      | "PAIR_THIS_WEEK"
      | "BLOCKED"
      | "WRONG_STATE"
      | "SNAP_USED"
      | "TILTED"
      | "AT_THE_CAP"
      | "CANT_COVER"
      | "ALT_FLAGGED"
      | "BLIND_SLATE",
    message: string,
  ) {
    super(message);
    this.name = "DuelError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN = ["offered", "active"] as const;
type Duel = typeof duels.$inferSelect;

const isFunds = (e: unknown) => (e as { code?: string })?.code === "INSUFFICIENT_FUNDS";

export async function setDuelPrefs(db: Db, userId: string, input: { duelsOn?: unknown; allowNaming?: unknown }) {
  const set: { duelsOn?: boolean; allowNaming?: boolean } = {};
  for (const k of ["duelsOn", "allowNaming"] as const) {
    if (input[k] === undefined) continue;
    if (typeof input[k] !== "boolean") throw new DuelError("INVALID_INPUT", `${k} must be true or false`);
    set[k] = input[k] as boolean;
  }
  await db.insert(duelPrefs).values({ userId, ...set }).onConflictDoUpdate({ target: duelPrefs.userId, set: Object.keys(set).length ? set : { userId } });
  const [p] = await db.select().from(duelPrefs).where(eq(duelPrefs.userId, userId));
  return { duelsOn: p!.duelsOn, allowNaming: p!.allowNaming };
}

async function prefs(db: Db, userId: string) {
  const [p] = await db.select().from(duelPrefs).where(eq(duelPrefs.userId, userId));
  return p ?? { duelsOn: false, allowNaming: false };
}

// Proof of Neighbour, 300 GM, and room for another open duel.
async function eligible(db: Db, userId: string) {
  const [u] = await db.select({ pon: users.proofOfNeighbourAt }).from(users).where(eq(users.id, userId));
  if (!u?.pon) throw new DuelError("NEEDS_PON", "duels need Proof of Neighbour");
  if ((await getBalance(db, userAccountId(userId)).catch(() => 0)) < DUEL.minGm) throw new DuelError("NOT_ENOUGH_GM", `duels need ${DUEL.minGm} GM`);
}

async function openCount(tx: Db, userId: string) {
  const [n] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(duels)
    .where(and(or(eq(duels.challengerId, userId), eq(duels.opponentId, userId)), inArray(duels.status, [...OPEN])));
  return n!.n;
}

const lockUsers = async (tx: Db, a: string, b: string) => {
  for (const id of [a, b].sort()) await tx.execute(sql`SELECT 1 FROM users WHERE id = ${id} FOR NO KEY UPDATE`);
};

async function lockDuel(tx: Db, duelId: unknown) {
  if (typeof duelId !== "string" || !UUID.test(duelId)) throw new DuelError("NO_SUCH_DUEL", "no such duel");
  const [d] = await tx.select().from(duels).where(eq(duels.id, duelId.toLowerCase())).for("no key update");
  if (!d) throw new DuelError("NO_SUCH_DUEL", "no such duel");
  return d;
}

// Both in the same crew right now.
async function crewmates(db: Db, a: string, b: string) {
  const rows = await db
    .select({ crewId: crewMembers.crewId })
    .from(crewMembers)
    .where(and(inArray(crewMembers.userId, [a, b]), isNull(crewMembers.leftAt)));
  return rows.length === 2 && rows[0]!.crewId === rows[1]!.crewId;
}

const marketOf = async (db: Db, id: string) => (await db.select().from(markets).where(eq(markets.id, id)))[0]!;
const beforeLock = (m: typeof markets.$inferSelect, now: Date) => m.status === "open" && now < m.freezesAt;

// --- Throwing one down -------------------------------------------------------------

export async function challenge(db: Db, challengerId: string, input: { marketId?: unknown; opponentId?: unknown }, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  if (typeof input.marketId !== "string" || !UUID.test(input.marketId) || typeof input.opponentId !== "string" || !UUID.test(input.opponentId)) {
    throw new DuelError("INVALID_INPUT", "which market, and who?");
  }
  const marketId = input.marketId.toLowerCase();
  const opponentId = input.opponentId.toLowerCase();
  if (opponentId === challengerId) throw new DuelError("INVALID_INPUT", "you can't duel yourself");
  if (NPC_IDS.includes(opponentId)) throw new DuelError("INVALID_INPUT", "you never duel the cast for GM");
  const [m] = await db.select().from(markets).where(eq(markets.id, marketId));
  if (!m || !beforeLock(m, now) || m.settlesBy > nextBell(now)) throw new DuelError("MARKET_CLOSED", "duels are on markets that settle by the next bell, before they lock");
  // On a Blind Slate even your crew's sides stay hidden until the bell, and
  // whether a crewmate is across from you would give theirs away. Checked
  // before the sides are.
  if ((await onBlindSlate(db, marketId, now)) && (await crewmates(db, challengerId, opponentId))) {
    throw new DuelError("BLIND_SLATE", "it's a Blind Slate: your crew's sides stay hidden until the bell");
  }
  const sides = await db
    .select({ userId: calls.userId, side: calls.side })
    .from(calls)
    .where(and(eq(calls.marketId, marketId), eq(calls.status, "locked"), inArray(calls.userId, [challengerId, opponentId])));
  const mine = sides.find((s) => s.userId === challengerId);
  const theirs = sides.find((s) => s.userId === opponentId);
  if (!mine || !theirs || mine.side === theirs.side) throw new DuelError("NOT_ACROSS", "you duel someone on the other side of a market you've both called");
  if (!(await prefs(db, challengerId)).duelsOn || !(await prefs(db, opponentId)).duelsOn) throw new DuelError("DUELS_OFF", "both of you need duels switched on");
  if (await isBlockedEitherWay(db, challengerId, opponentId)) throw new DuelError("BLOCKED", "you can't");
  if (await isFlaggedPair(db, challengerId, opponentId, now)) throw new DuelError("ALT_FLAGGED", "these two accounts can't duel each other right now");
  await eligible(db, challengerId);

  const duel = await db.transaction(async (tx) => {
    await lockUsers(tx, challengerId, opponentId);
    for (const u of [challengerId, opponentId]) if ((await openCount(tx, u)) >= DUEL.openMax) throw new DuelError("TOO_MANY_OPEN", `${DUEL.openMax} open duels at a time`);
    const [recent] = await tx
      .select({ id: duels.id })
      .from(duels)
      .where(
        and(
          or(and(eq(duels.challengerId, challengerId), eq(duels.opponentId, opponentId)), and(eq(duels.challengerId, opponentId), eq(duels.opponentId, challengerId))),
          gte(duels.createdAt, new Date(now.getTime() - DUEL.pairWindowDays * 86_400_000)),
        ),
      )
      .limit(1);
    if (recent) throw new DuelError("PAIR_THIS_WEEK", "one duel per pair a week");
    const [d] = await tx.insert(duels).values({ marketId, challengerId, opponentId, challengerSide: mine.side, stakeChallenger: DUEL.ante, createdAt: now }).returning();
    await openEscrowAccount(tx, duelAccountId(d!.id));
    try {
      await transfer(tx, { from: userAccountId(challengerId), to: duelAccountId(d!.id), amount: DUEL.ante, kind: "duel_ante", idempotencyKey: `duel:${d!.id}:ante:c` });
    } catch (e) {
      if (isFunds(e)) throw new DuelError("NOT_ENOUGH_GM", "not enough GM");
      throw e;
    }
    return d!;
  });
  return { id: duel.id, status: duel.status, stake: DUEL.ante };
}

export async function respond(db: Db, opponentId: string, duelId: unknown, accept: unknown, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  if (typeof accept !== "boolean") throw new DuelError("INVALID_INPUT", "accept is true or false");
  if (accept) await eligible(db, opponentId);
  return db.transaction(async (tx) => {
    const d = await lockDuel(tx, duelId);
    if (d.opponentId !== opponentId) throw new DuelError("NOT_YOURS", "that duel isn't for you");
    if (d.status !== "offered") throw new DuelError("WRONG_STATE", "that duel isn't waiting on you");
    const m = await marketOf(tx, d.marketId);
    if (!accept || !beforeLock(m, now)) {
      await refund(tx, d, "c", d.stakeChallenger);
      await tx.update(duels).set({ status: accept ? "expired" : "declined", endedAt: now }).where(eq(duels.id, d.id));
      if (accept) throw new DuelError("MARKET_CLOSED", "that market has locked");
      return { id: d.id, status: "declined" as const };
    }
    try {
      await transfer(tx, { from: userAccountId(opponentId), to: duelAccountId(d.id), amount: DUEL.ante, kind: "duel_ante", idempotencyKey: `duel:${d.id}:ante:o` });
    } catch (e) {
      if (isFunds(e)) throw new DuelError("NOT_ENOUGH_GM", "not enough GM");
      throw e;
    }
    await tx.update(duels).set({ status: "active", stakeOpponent: DUEL.ante, acceptedAt: now }).where(eq(duels.id, d.id));
    return { id: d.id, status: "active" as const };
  });
}

export async function cancelOffer(db: Db, challengerId: string, duelId: unknown, opts: { now?: Date } = {}) {
  return db.transaction(async (tx) => {
    const d = await lockDuel(tx, duelId);
    if (d.challengerId !== challengerId) throw new DuelError("NOT_YOURS", "not your duel");
    if (d.status !== "offered") throw new DuelError("WRONG_STATE", "only an unanswered offer can be taken back");
    await refund(tx, d, "c", d.stakeChallenger);
    await tx.update(duels).set({ status: "cancelled", endedAt: opts.now ?? new Date() }).where(eq(duels.id, d.id));
    return { id: d.id, status: "cancelled" as const };
  });
}

async function refund(tx: Db, d: Duel, who: "c" | "o", amount: number) {
  if (amount <= 0) return;
  await transfer(tx, { from: duelAccountId(d.id), to: userAccountId(who === "c" ? d.challengerId : d.opponentId), amount, kind: "duel_refund", idempotencyKey: `duel:${d.id}:refund:${who}` });
}

// --- Snap, Retreat, Last Call -------------------------------------------------------

// SNAP: once each, doubles the pot (both stakes). Never while either side is
// tilted: it doubles the other side's stake too, and Tilted caps GM stakes.
export async function snap(db: Db, userId: string, duelId: unknown, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  if ((await moodState(db, userId, { now })).tilt.tilted) throw new DuelError("TILTED", "no Snaps while you're tilted");
  const out = await db.transaction(async (tx) => {
    const d = await lockDuel(tx, duelId);
    const me = d.challengerId === userId ? "c" : d.opponentId === userId ? "o" : null;
    if (!me) throw new DuelError("NOT_YOURS", "not your duel");
    if (d.status !== "active") throw new DuelError("WRONG_STATE", "that duel isn't live");
    if (!beforeLock(await marketOf(tx, d.marketId), now)) throw new DuelError("MARKET_CLOSED", "the market has locked");
    if (me === "c" ? d.snapChallenger : d.snapOpponent) throw new DuelError("SNAP_USED", "one Snap each");
    if (!canDouble(d.stakeChallenger) || !canDouble(d.stakeOpponent)) throw new DuelError("AT_THE_CAP", "the pot is at its cap");
    if ((await moodState(tx, me === "c" ? d.opponentId : d.challengerId, { now })).tilt.tilted) throw new DuelError("TILTED", "they're tilted: no Snaps until it clears");
    for (const [who, stake] of [["c", d.stakeChallenger], ["o", d.stakeOpponent]] as const) {
      try {
        await transfer(tx, { from: userAccountId(who === "c" ? d.challengerId : d.opponentId), to: duelAccountId(d.id), amount: stake, kind: "duel_snap", idempotencyKey: `duel:${d.id}:snap:${me}:${who}` });
      } catch (e) {
        if (isFunds(e)) throw new DuelError("CANT_COVER", who === me ? "not enough GM to Snap" : "they can't cover a Snap");
        throw e;
      }
    }
    await tx
      .update(duels)
      .set({ stakeChallenger: d.stakeChallenger * 2, stakeOpponent: d.stakeOpponent * 2, ...(me === "c" ? { snapChallenger: true } : { snapOpponent: true }) })
      .where(eq(duels.id, d.id));
    return { id: d.id, stake: d.stakeChallenger * 2, other: me === "c" ? d.opponentId : d.challengerId };
  });
  const [r] = await db.select({ handle: residents.handle }).from(residents).where(eq(residents.userId, userId));
  await notify(db, out.other, "snap", { handle: r?.handle ?? "someone" }, { now });
  return { id: out.id, stake: out.stake };
}

// Retreat before the market locks: a smart exit, not a loss screen.
export async function retreat(db: Db, userId: string, duelId: unknown, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const d = await lockDuel(tx, duelId);
    const me = d.challengerId === userId ? "c" : d.opponentId === userId ? "o" : null;
    if (!me) throw new DuelError("NOT_YOURS", "not your duel");
    if (d.status !== "active") throw new DuelError("WRONG_STATE", "that duel isn't live");
    if (!beforeLock(await marketOf(tx, d.marketId), now)) throw new DuelError("MARKET_CLOSED", "too late to retreat: the market has locked");
    const mine = me === "c" ? d.stakeChallenger : d.stakeOpponent;
    const theirs = me === "c" ? d.stakeOpponent : d.stakeChallenger;
    const other = me === "c" ? "o" : "c";
    const { toOpponent, burned } = retreatSplit(mine);
    await refund(tx, d, other, theirs + toOpponent);
    if (burned > 0) await burn(tx, { accountId: duelAccountId(d.id), amount: burned, kind: "duel_retreat", idempotencyKey: `duel:${d.id}:retreat_burn` });
    await tx.update(duels).set({ status: "retreated", retreatedBy: userId, endedAt: now }).where(eq(duels.id, d.id));
    return { id: d.id, status: "retreated" as const, burned, lost: mine };
  });
}

// At "Bell in 60" (23:00 UTC), every live duel whose market settles by the bell
// doubles once more if both are still in, can cover it, and neither is tilted.
export async function runLastCall(db: Db, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  if (now.getUTCHours() < DUEL.lastCallHour) return { doubled: 0, skipped: 0 };
  const due = await db
    .select({ id: duels.id, c: duels.challengerId, o: duels.opponentId })
    .from(duels)
    .innerJoin(markets, eq(markets.id, duels.marketId))
    .where(and(eq(duels.status, "active"), eq(duels.lastCall, false), sql`${markets.settlesBy} <= ${nextBell(now).toISOString()}::timestamptz`));
  let doubled = 0;
  let skipped = 0;
  for (const x of due) {
    const tilted = (await moodState(db, x.c, { now })).tilt.tilted || (await moodState(db, x.o, { now })).tilt.tilted;
    const ok = await db
      .transaction(async (tx) => {
        const d = await lockDuel(tx, x.id);
        if (d.status !== "active" || d.lastCall) return false;
        await tx.update(duels).set({ lastCall: true }).where(eq(duels.id, d.id));
        if (tilted || !canDouble(d.stakeChallenger) || !canDouble(d.stakeOpponent)) return false;
        for (const [who, stake] of [["c", d.stakeChallenger], ["o", d.stakeOpponent]] as const) {
          await transfer(tx, { from: userAccountId(who === "c" ? d.challengerId : d.opponentId), to: duelAccountId(d.id), amount: stake, kind: "duel_last_call", idempotencyKey: `duel:${d.id}:last_call:${who}` });
        }
        await tx.update(duels).set({ stakeChallenger: d.stakeChallenger * 2, stakeOpponent: d.stakeOpponent * 2 }).where(eq(duels.id, d.id));
        return true;
      })
      .catch(async (e) => {
        if (!isFunds(e)) throw e;
        // Someone can't cover it: no Last Call for this duel, recorded so it isn't retried.
        await db.update(duels).set({ lastCall: true }).where(and(eq(duels.id, x.id), eq(duels.lastCall, false)));
        return false;
      });
    if (ok) doubled++;
    else skipped++;
  }
  return { doubled, skipped };
}

// --- Settling -----------------------------------------------------------------------------

// The winner takes the pot; a voided market gives both stakes back; an offer
// nobody answered before the lock is returned. A lost Snap tilts.
export async function settleDuels(db: Db, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const due = await db
    .select({ id: duels.id })
    .from(duels)
    .innerJoin(markets, eq(markets.id, duels.marketId))
    .where(
      or(
        and(eq(duels.status, "active"), inArray(markets.status, ["resolved", "void"])),
        and(eq(duels.status, "offered"), sql`(${markets.status} <> 'open' OR ${markets.freezesAt} <= ${now.toISOString()}::timestamptz)`),
      ),
    );
  let settled = 0;
  const tilts: string[] = [];
  for (const { id } of due) {
    const r = await db.transaction(async (tx) => {
      const d = await lockDuel(tx, id);
      const m = await marketOf(tx, d.marketId);
      if (d.status === "offered") {
        await refund(tx, d, "c", d.stakeChallenger);
        await tx.update(duels).set({ status: "expired", endedAt: now }).where(eq(duels.id, d.id));
        return null;
      }
      if (d.status !== "active") return null;
      if (m.status === "void") {
        await refund(tx, d, "c", d.stakeChallenger);
        await refund(tx, d, "o", d.stakeOpponent);
        await tx.update(duels).set({ status: "void", endedAt: now }).where(eq(duels.id, d.id));
        return null;
      }
      if (m.status !== "resolved") return null;
      const challengerWon = (d.challengerSide === "yes") === m.outcome;
      const winner = challengerWon ? d.challengerId : d.opponentId;
      const loserSnapped = challengerWon ? d.snapOpponent : d.snapChallenger;
      await transfer(tx, {
        from: duelAccountId(d.id),
        to: userAccountId(winner),
        amount: d.stakeChallenger + d.stakeOpponent,
        kind: "duel_win",
        idempotencyKey: `duel:${d.id}:win`,
      });
      await tx.update(duels).set({ status: "settled", winnerId: winner, endedAt: now }).where(eq(duels.id, d.id));
      return loserSnapped ? (challengerWon ? d.opponentId : d.challengerId) : "";
    });
    if (r !== null) settled++;
    if (r) tilts.push(r);
  }
  for (const u of tilts) await maybeTilt(db, u, { lostSnap: true }, { now });
  return { settled };
}

export async function myDuels(db: Db, userId: string) {
  return db
    .select()
    .from(duels)
    .where(or(eq(duels.challengerId, userId), eq(duels.opponentId, userId)))
    .orderBy(sql`${duels.createdAt} DESC`)
    .limit(50);
}

// For the reel: "@a ate @b's Snap", naming only residents who allow it.
export async function duelLines(db: Db, from: Date, to: Date) {
  const rows = await db
    .select()
    .from(duels)
    .where(and(eq(duels.status, "settled"), gte(duels.endedAt, from), sql`${duels.endedAt} < ${to.toISOString()}::timestamptz`));
  const ids = [...new Set(rows.flatMap((d) => [d.challengerId, d.opponentId]))];
  const named = new Map(
    ids.length
      ? (
          await db
            .select({ id: residents.userId, handle: residents.handle, allow: duelPrefs.allowNaming })
            .from(residents)
            .leftJoin(duelPrefs, eq(duelPrefs.userId, residents.userId))
            .where(inArray(residents.userId, ids))
        ).map((r) => [r.id, r.allow ? `@${r.handle}` : null])
      : [],
  );
  return rows.map((d) => {
    const loser = d.winnerId === d.challengerId ? d.opponentId : d.challengerId;
    const loserSnapped = loser === d.challengerId ? d.snapChallenger : d.snapOpponent;
    return { winner: named.get(d.winnerId!) ?? "a neighbour", loser: named.get(loser) ?? "a neighbour", snap: loserSnapped, pot: d.stakeChallenger + d.stakeOpponent };
  });
}
