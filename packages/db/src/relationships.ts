import { RELATIONSHIPS, bondLevel } from "@bp/core";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./client";
import { areFrens, frensOf } from "./chat";
import { PON } from "./pon";
import { isBlockedEitherWay } from "./safety";
import { bestFrens, crewMembers, residents, rivalries } from "./schema";

export class RelationshipError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "NO_SUCH_USER" | "NOT_FRENS" | "TOO_MANY" | "BLOCKED" | "NO_SUCH_REQUEST",
    message: string,
  ) {
    super(message);
    this.name = "RelationshipError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x]) as [string, string];

async function other(db: Db, me: string, target: unknown) {
  if (typeof target !== "string" || !UUID.test(target)) throw new RelationshipError("INVALID_INPUT", "who?");
  const id = target.toLowerCase();
  if (id === me) throw new RelationshipError("INVALID_INPUT", "that's you");
  const [r] = await db.select({ id: residents.userId }).from(residents).where(eq(residents.userId, id));
  if (!r) throw new RelationshipError("NO_SUCH_USER", "no such resident");
  return id;
}

const lockMe = (tx: Db, userId: string) => tx.execute(sql`SELECT 1 FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);

// --- Best frens -----------------------------------------------------------------------

export async function setBestFren(db: Db, userId: string, target: unknown, on: unknown) {
  if (typeof on !== "boolean") throw new RelationshipError("INVALID_INPUT", "on must be true or false");
  const id = await other(db, userId, target);
  if (!on) {
    await db.delete(bestFrens).where(and(eq(bestFrens.userId, userId), eq(bestFrens.frenId, id)));
    return { bestFren: false };
  }
  if (await isBlockedEitherWay(db, userId, id)) throw new RelationshipError("BLOCKED", "you can't");
  if (!(await areFrens(db, userId, id))) throw new RelationshipError("NOT_FRENS", "best frens are picked from your frens");
  return db.transaction(async (tx) => {
    await lockMe(tx, userId);
    const mine = await tx.select({ id: bestFrens.frenId }).from(bestFrens).where(eq(bestFrens.userId, userId));
    if (mine.some((m) => m.id === id)) return { bestFren: true };
    if (mine.length >= RELATIONSHIPS.bestFrens) throw new RelationshipError("TOO_MANY", `${RELATIONSHIPS.bestFrens} best frens at most`);
    await tx.insert(bestFrens).values({ userId, frenId: id });
    return { bestFren: true };
  });
}

// --- Rivals -----------------------------------------------------------------------------

// Propose to a fren (or crewmate); if they'd already proposed to you, it's on.
export async function proposeRivalry(db: Db, userId: string, target: unknown, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const id = await other(db, userId, target);
  if (await isBlockedEitherWay(db, userId, id)) throw new RelationshipError("BLOCKED", "you can't");
  if (!(await areFrens(db, userId, id))) throw new RelationshipError("NOT_FRENS", "rivals start as frens");
  const [a, b] = pair(userId, id);
  return db.transaction(async (tx) => {
    // Both residents, in id order: the cap is checked on each side.
    await lockMe(tx, a);
    await lockMe(tx, b);
    const [existing] = await tx.select().from(rivalries).where(and(eq(rivalries.a, a), eq(rivalries.b, b)));
    if (existing?.status === "active") return { status: "active" as const };
    if (existing && existing.proposedBy !== userId) {
      await tx.update(rivalries).set({ status: "active", acceptedAt: now }).where(and(eq(rivalries.a, a), eq(rivalries.b, b)));
      return { status: "active" as const };
    }
    if (existing) return { status: "pending" as const };
    for (const u of [userId, id]) {
      const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(rivalries).where(or(eq(rivalries.a, u), eq(rivalries.b, u)));
      if (n!.n >= RELATIONSHIPS.rivals) throw new RelationshipError("TOO_MANY", u === userId ? `${RELATIONSHIPS.rivals} rivals at most` : "they have enough rivals");
    }
    await tx.insert(rivalries).values({ a, b, proposedBy: userId, createdAt: now });
    return { status: "pending" as const };
  });
}

export async function acceptRivalry(db: Db, userId: string, target: unknown, opts: { now?: Date } = {}) {
  const id = await other(db, userId, target);
  const [a, b] = pair(userId, id);
  const [r] = await db
    .update(rivalries)
    .set({ status: "active", acceptedAt: opts.now ?? new Date() })
    .where(and(eq(rivalries.a, a), eq(rivalries.b, b), eq(rivalries.status, "pending"), eq(rivalries.proposedBy, id)))
    .returning();
  if (!r) throw new RelationshipError("NO_SUCH_REQUEST", "no rivalry to accept");
  return { status: "active" as const };
}

// Either side ends it, or declines or withdraws a request.
export async function endRivalry(db: Db, userId: string, target: unknown) {
  const id = await other(db, userId, target);
  const [a, b] = pair(userId, id);
  await db.delete(rivalries).where(and(eq(rivalries.a, a), eq(rivalries.b, b)));
}

// --- Crew bonds ---------------------------------------------------------------------------

// For each current crewmate: the distinct days you've actually shared a room
// (a minute or more together), and the bond level that makes.
export async function crewBonds(db: Db, userId: string, now = new Date()) {
  const mates = await crewmatesOf(db, userId);
  if (!mates.length) return [];
  const cap = `${PON.openVisitCapHours} hours`;
  const rows = await db.execute<{ user_id: string; days: number }>(sql`
    SELECT v2.user_id, count(DISTINCT (GREATEST(v1.joined_at, v2.joined_at) AT TIME ZONE 'UTC')::date)::int AS days
    FROM room_visits v1
    JOIN room_visits v2 ON v2.room = v1.room AND v2.user_id <> v1.user_id
    WHERE v1.user_id = ${userId}
      AND v2.user_id IN (${sql.join(mates.map((m) => sql`${m}::uuid`), sql`, `)})
      AND LEAST(
            COALESCE(v1.left_at, LEAST(${now.toISOString()}::timestamptz, v1.joined_at + ${cap}::interval)),
            COALESCE(v2.left_at, LEAST(${now.toISOString()}::timestamptz, v2.joined_at + ${cap}::interval)))
          - GREATEST(v1.joined_at, v2.joined_at) >= make_interval(secs => ${PON.overlapSeconds})
    GROUP BY v2.user_id`);
  const days = new Map(rows.map((r) => [r.user_id, r.days]));
  return mates.map((m) => ({ userId: m, days: days.get(m) ?? 0, level: bondLevel(days.get(m) ?? 0) })).sort((x, y) => y.days - x.days || (x.userId < y.userId ? -1 : 1));
}

// --- Everything at once ------------------------------------------------------------------------

// Current crewmates (who count as frens).
async function crewmatesOf(db: Db, userId: string) {
  const [me] = await db.select({ crewId: crewMembers.crewId }).from(crewMembers).where(and(eq(crewMembers.userId, userId), isNull(crewMembers.leftAt)));
  if (!me) return [];
  const rows = await db
    .select({ id: crewMembers.userId })
    .from(crewMembers)
    .where(and(eq(crewMembers.crewId, me.crewId), isNull(crewMembers.leftAt)));
  return rows.map((m) => m.id).filter((m) => m !== userId);
}

export async function myRelationships(db: Db, userId: string, opts: { now?: Date } = {}) {
  const tapped = new Set(await frensOf(db, userId));
  const crewmates = new Set(await crewmatesOf(db, userId));
  const frenIds = [...new Set([...tapped, ...crewmates])];
  const picks = await db.select({ id: bestFrens.frenId }).from(bestFrens).where(eq(bestFrens.userId, userId));
  const pickedMe = frenIds.length
    ? await db.select({ id: bestFrens.userId }).from(bestFrens).where(and(eq(bestFrens.frenId, userId), inArray(bestFrens.userId, frenIds)))
    : [];
  const picked = new Set(picks.map((p) => p.id));
  const back = new Set(pickedMe.map((p) => p.id));
  const rivals = await db.select().from(rivalries).where(or(eq(rivalries.a, userId), eq(rivalries.b, userId)));
  const them = (r: (typeof rivals)[number]) => (r.a === userId ? r.b : r.a);
  return {
    // A best-fren pick is only yours to see; "mutual" shows when both picked.
    frens: frenIds.map((id) => ({ userId: id, crewmate: crewmates.has(id), bestFren: picked.has(id), mutualBest: picked.has(id) && back.has(id) })),
    // Picks that are no longer frens (unfrenned, left the crew) are kept but inactive.
    bestFrens: [...picked].filter((id) => frenIds.includes(id)),
    rivals: rivals.filter((r) => r.status === "active").map((r) => ({ userId: them(r), since: r.acceptedAt })),
    rivalRequests: {
      incoming: rivals.filter((r) => r.status === "pending" && r.proposedBy !== userId).map(them),
      outgoing: rivals.filter((r) => r.status === "pending" && r.proposedBy === userId).map(them),
    },
    crewBonds: await crewBonds(db, userId, opts.now),
  };
}
