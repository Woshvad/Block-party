import { AREAS, CAST, PLACE_RE, checkMessage, npcById } from "@bp/core";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "./client";
import { hitRateLimit } from "./ratelimit";
import { accountAgeDays, allowNewDmThread, enqueueModeration, isBlockedEitherWay, isRestricted } from "./safety";
import { bestFrens, blocks, boardFollows, crewMembers, dmThreads, frenTaps, frens, messages, mutes, restrictions, users } from "./schema";

export type ChatErrorCode =
  | "INVALID_INPUT"
  | "NOT_ALLOWED"
  | "NOT_FRENS"
  | "BLOCKED"
  | "CHAT_RESTRICTED"
  | "MODERATED"
  | "SLOW_MODE"
  | "TOO_FAST"
  | "FOLLOW_LIMIT"
  | "NOT_TOGETHER"
  | "NO_SUCH_THREAD";

export class ChatError extends Error {
  constructor(
    readonly code: ChatErrorCode,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

export const CHAT = {
  followMax: 12,
  pageSize: 50,
  postsPerMinute: 10, // per resident, across Boards, crew chat and DMs
  slowModeBusyPosts: 20, // a Board with this many posts in the last minute goes slow
  slowModeSeconds: 30,
} as const;

// Shown on every DM.
export const DM_NOTICE = "No one from Block Party will ever ask for your seed phrase or your funds. Not the Mayor. Not your crew.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

// Live presence from the rooms Worker: which copy of a place someone is in.
export type WhereCheck = (userId: string, place: string) => Promise<number | null>;
export const nowhere: WhereCheck = async () => null;

async function requireUser(db: Db, id: unknown) {
  if (typeof id !== "string" || !UUID.test(id)) throw new ChatError("INVALID_INPUT", "no such resident");
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, id.toLowerCase()));
  if (!u) throw new ChatError("INVALID_INPUT", "no such resident");
  return u.id;
}

// --- Frens ---------------------------------------------------------------------

async function crewmates(db: Db, a: string, b: string) {
  const rows = await db
    .select({ crewId: crewMembers.crewId })
    .from(crewMembers)
    .where(and(inArray(crewMembers.userId, [a, b]), isNull(crewMembers.leftAt)));
  return rows.length === 2 && rows[0]!.crewId === rows[1]!.crewId;
}

export async function areFrens(db: Db, x: string, y: string): Promise<boolean> {
  if (x === y) return false;
  const [a, b] = pair(x, y);
  const [f] = await db.select().from(frens).where(and(eq(frens.a, a), eq(frens.b, b)));
  return !!f || (await crewmates(db, x, y));
}

// Tap "Fren" on someone you're sharing a room with. Two taps make frens.
export async function tapFren(db: Db, fromId: string, target: unknown, place: unknown, where: WhereCheck) {
  const toId = await requireUser(db, target);
  if (toId === fromId) throw new ChatError("INVALID_INPUT", "you can't fren yourself");
  if (typeof place !== "string" || !PLACE_RE.test(place)) throw new ChatError("INVALID_INPUT", "which place?");
  if (await isBlockedEitherWay(db, fromId, toId)) throw new ChatError("BLOCKED", "you can't fren them");
  const [mine, theirs] = await Promise.all([where(fromId, place), where(toId, place)]);
  if (mine === null || mine !== theirs) throw new ChatError("NOT_TOGETHER", "fren people you're sharing a room with");
  return db.transaction(async (tx) => {
    await tx.insert(frenTaps).values({ fromId, toId, place }).onConflictDoNothing();
    const [back] = await tx.select().from(frenTaps).where(and(eq(frenTaps.fromId, toId), eq(frenTaps.toId, fromId)));
    if (!back) return { frens: false };
    const [a, b] = pair(fromId, toId);
    await tx.insert(frens).values({ a, b }).onConflictDoNothing();
    return { frens: true };
  });
}

export async function unfren(db: Db, userId: string, target: unknown) {
  const other = await requireUser(db, target);
  const [a, b] = pair(userId, other);
  await db.transaction(async (tx) => {
    await tx.delete(frens).where(and(eq(frens.a, a), eq(frens.b, b)));
    await tx.delete(frenTaps).where(or(and(eq(frenTaps.fromId, userId), eq(frenTaps.toId, other)), and(eq(frenTaps.fromId, other), eq(frenTaps.toId, userId))));
    await tx.delete(bestFrens).where(or(and(eq(bestFrens.userId, userId), eq(bestFrens.frenId, other)), and(eq(bestFrens.userId, other), eq(bestFrens.frenId, userId))));
  });
}

export async function frensOf(db: Db, userId: string) {
  const rows = await db.select().from(frens).where(or(eq(frens.a, userId), eq(frens.b, userId)));
  return rows.map((r) => (r.a === userId ? r.b : r.a));
}

// --- Posting ---------------------------------------------------------------------

type Channel = { kind: "board" | "crew" | "dm"; channel: string };

// What every send path takes: the clock, and staff's blocked words (the API
// reads them from its BLOCKED_WORDS setting).
export type SendOptions = { now?: Date; blockedWords?: readonly string[] };

async function post(db: Db, authorId: string, where: Channel, text: unknown, opts: { now: Date; firstDm?: boolean; blockedWords?: readonly string[] }) {
  if (await isRestricted(db, authorId, "chat_mute", opts.now)) throw new ChatError("CHAT_RESTRICTED", "you can't chat right now; see your restrictions");
  const v = checkMessage(text, { accountAgeDays: await accountAgeDays(db, authorId, opts.now), firstDm: opts.firstDm, blockedWords: opts.blockedWords });
  if (!v.ok) throw new ChatError("MODERATED", v.message, v.reason);
  const rl = await hitRateLimit(db, `chat:${authorId}`, { limit: CHAT.postsPerMinute, windowSeconds: 60, now: opts.now });
  if (!rl.allowed) throw new ChatError("TOO_FAST", "slow down, ser");
  const [m] = await db.insert(messages).values({ kind: where.kind, channel: where.channel, authorId, text: v.text, createdAt: opts.now }).returning();
  await enqueueModeration(db, { kind: where.kind, ref: m!.id, authorId, text: v.text });
  return m!;
}

// Everyone this reader must not see: blocks either way, plus their mutes.
// Room tickets carry the same list.
export async function hiddenFor(db: Db, readerId: string, now: Date): Promise<Set<string>> {
  const [b1, b2, m] = await Promise.all([
    db.select({ id: blocks.blockedId }).from(blocks).where(eq(blocks.blockerId, readerId)),
    db.select({ id: blocks.blockerId }).from(blocks).where(eq(blocks.blockedId, readerId)),
    db.select({ id: mutes.mutedId, until: mutes.until }).from(mutes).where(eq(mutes.muterId, readerId)),
  ]);
  return new Set([...b1.map((x) => x.id), ...b2.map((x) => x.id), ...m.filter((x) => x.until === null || x.until > now).map((x) => x.id)]);
}

// One batch for a live room: fresh blocks, incoming-only mutes and staff
// restrictions. Missing users are omitted so the room refuses their access.
export async function roomAccess(db: Db, userIds: string[], now = new Date()) {
  if (!userIds.length) return [];
  const [people, blocked, muted, restricted] = await Promise.all([
    db.select({ userId: users.id }).from(users).where(inArray(users.id, userIds)),
    db.select().from(blocks).where(or(inArray(blocks.blockerId, userIds), inArray(blocks.blockedId, userIds))),
    db.select().from(mutes).where(and(inArray(mutes.muterId, userIds), or(isNull(mutes.until), sql`${mutes.until} > ${now.toISOString()}::timestamptz`))),
    db.select().from(restrictions).where(and(inArray(restrictions.userId, userIds), isNull(restrictions.liftedAt), sql`${restrictions.startsAt} <= ${now.toISOString()}::timestamptz`, or(isNull(restrictions.endsAt), sql`${restrictions.endsAt} > ${now.toISOString()}::timestamptz`))),
  ]);
  return people.map(({ userId }) => {
    const b = blocked.filter((x) => x.blockerId === userId || x.blockedId === userId).map((x) => x.blockerId === userId ? x.blockedId : x.blockerId);
    const r = restricted.filter((x) => x.userId === userId);
    return { userId, blocked: [...new Set(b)], hidden: [...new Set([...b, ...muted.filter((x) => x.muterId === userId).map((x) => x.mutedId)])], chat: r.length === 0, suspended: r.some((x) => x.kind === "suspended") };
  });
}

async function read(db: Db, readerId: string, where: Channel, opts: { before?: unknown; now: Date }) {
  let before: Date | null = null;
  if (opts.before !== undefined) {
    const d = new Date(String(opts.before));
    if (Number.isNaN(d.getTime())) throw new ChatError("INVALID_INPUT", "before must be a date");
    before = d;
  }
  // Blocked (either way) and muted authors are left out before the page is
  // cut, so a muted spammer's 50 posts can't push everyone else off it.
  const nowIso = opts.now.toISOString();
  const rows = await db
    .select({ id: messages.id, authorId: messages.authorId, text: messages.text, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.kind, where.kind),
        eq(messages.channel, where.channel),
        eq(messages.hidden, false),
        before ? lt(messages.createdAt, before) : undefined,
        sql`NOT EXISTS (SELECT 1 FROM ${blocks} WHERE (${blocks.blockerId} = ${readerId} AND ${blocks.blockedId} = ${messages.authorId}) OR (${blocks.blockerId} = ${messages.authorId} AND ${blocks.blockedId} = ${readerId}))`,
        sql`NOT EXISTS (SELECT 1 FROM ${mutes} WHERE ${mutes.muterId} = ${readerId} AND ${mutes.mutedId} = ${messages.authorId} AND (${mutes.until} IS NULL OR ${mutes.until} > ${nowIso}::timestamptz))`,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(CHAT.pageSize);
  // Every line from the cast carries its label.
  return rows.map((r) => {
    const k = npcById(r.authorId);
    return k ? { ...r, npc: { name: CAST[k].name, label: CAST[k].label } } : r;
  });
}

// --- Boards ---------------------------------------------------------------------

// The city's Boards: one for each public place, the street's on Crew Row.
// Homes, Crew Houses and the Bunkers have none, and no other name opens one,
// so nobody can set up an unlisted channel outside the DM rules.
export const BOARDS: readonly string[] = [...AREAS.filter((a) => a !== "street"), "crew_row"];

const boardPlace = (place: unknown) => {
  if (typeof place !== "string" || !BOARDS.includes(place)) throw new ChatError("INVALID_INPUT", "no such board");
  return place;
};

// Slow mode when a Board is busy: one post per 30 seconds each.
export async function postToBoard(db: Db, authorId: string, place: unknown, text: unknown, opts: SendOptions = {}) {
  const now = opts.now ?? new Date();
  const p = boardPlace(place);
  const [busy] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.kind, "board"), eq(messages.channel, p), sql`${messages.createdAt} > ${new Date(now.getTime() - 60_000).toISOString()}::timestamptz`));
  if (busy!.n >= CHAT.slowModeBusyPosts) {
    const rl = await hitRateLimit(db, `slow:${p}:${authorId}`, { limit: 1, windowSeconds: CHAT.slowModeSeconds, now });
    if (!rl.allowed) throw new ChatError("SLOW_MODE", `slow mode: one post every ${CHAT.slowModeSeconds} seconds`);
  }
  return post(db, authorId, { kind: "board", channel: p }, text, { now, blockedWords: opts.blockedWords });
}

export const readBoard = (db: Db, readerId: string, place: unknown, opts: { before?: unknown; now?: Date } = {}) =>
  Promise.resolve().then(() => read(db, readerId, { kind: "board", channel: boardPlace(place) }, { before: opts.before, now: opts.now ?? new Date() }));

export async function followBoard(db: Db, userId: string, place: unknown) {
  const p = boardPlace(place);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);
    const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(boardFollows).where(eq(boardFollows.userId, userId));
    const [already] = await tx.select().from(boardFollows).where(and(eq(boardFollows.userId, userId), eq(boardFollows.place, p)));
    if (already) return;
    if (n!.n >= CHAT.followMax) throw new ChatError("FOLLOW_LIMIT", `you can follow up to ${CHAT.followMax} Boards`);
    await tx.insert(boardFollows).values({ userId, place: p });
  });
}

export async function unfollowBoard(db: Db, userId: string, place: unknown) {
  await db.delete(boardFollows).where(and(eq(boardFollows.userId, userId), eq(boardFollows.place, boardPlace(place))));
}

// --- Crew chat ------------------------------------------------------------------

async function myCrewId(db: Db, userId: string) {
  const [m] = await db.select({ crewId: crewMembers.crewId }).from(crewMembers).where(and(eq(crewMembers.userId, userId), isNull(crewMembers.leftAt)));
  if (!m) throw new ChatError("NOT_ALLOWED", "you're not in a crew");
  return m.crewId;
}

export async function postToCrew(db: Db, authorId: string, text: unknown, opts: SendOptions = {}) {
  const crewId = await myCrewId(db, authorId);
  return post(db, authorId, { kind: "crew", channel: crewId }, text, { now: opts.now ?? new Date(), blockedWords: opts.blockedWords });
}

export async function readCrew(db: Db, readerId: string, opts: { before?: unknown; now?: Date } = {}) {
  const crewId = await myCrewId(db, readerId);
  return read(db, readerId, { kind: "crew", channel: crewId }, { before: opts.before, now: opts.now ?? new Date() });
}

// --- DMs --------------------------------------------------------------------------

export async function sendDm(db: Db, fromId: string, target: unknown, text: unknown, opts: SendOptions = {}) {
  const now = opts.now ?? new Date();
  const toId = await requireUser(db, target);
  if (toId === fromId) throw new ChatError("INVALID_INPUT", "you can't DM yourself");
  if (await isBlockedEitherWay(db, fromId, toId)) throw new ChatError("BLOCKED", "you can't message them");
  if (!(await areFrens(db, fromId, toId))) throw new ChatError("NOT_FRENS", "DMs are for frens: crewmates, or people you've both frenned");
  const [a, b] = pair(fromId, toId);
  let [thread] = await db.select().from(dmThreads).where(and(eq(dmThreads.a, a), eq(dmThreads.b, b)));
  if (!thread) {
    await allowNewDmThread(db, fromId, { now }); // new accounts: 5 new conversations a day
    await db.insert(dmThreads).values({ a, b, createdBy: fromId }).onConflictDoNothing();
    [thread] = await db.select().from(dmThreads).where(and(eq(dmThreads.a, a), eq(dmThreads.b, b)));
  }
  // A first message from you in this conversation can't carry links or addresses.
  const [mine] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.kind, "dm"), eq(messages.channel, thread!.id), eq(messages.authorId, fromId)))
    .limit(1);
  const m = await post(db, fromId, { kind: "dm", channel: thread!.id }, text, { now, firstDm: !mine, blockedWords: opts.blockedWords });
  return { threadId: thread!.id, message: m, notice: DM_NOTICE };
}

async function myThread(db: Db, userId: string, threadId: unknown) {
  if (typeof threadId !== "string" || !UUID.test(threadId)) throw new ChatError("NO_SUCH_THREAD", "no such conversation");
  const [t] = await db.select().from(dmThreads).where(eq(dmThreads.id, threadId));
  if (!t || (t.a !== userId && t.b !== userId)) throw new ChatError("NO_SUCH_THREAD", "no such conversation");
  return t;
}

export async function readDm(db: Db, readerId: string, threadId: unknown, opts: { before?: unknown; now?: Date } = {}) {
  const t = await myThread(db, readerId, threadId);
  const other = t.a === readerId ? t.b : t.a;
  // A block hides the whole conversation.
  if (await isBlockedEitherWay(db, readerId, other)) return { notice: DM_NOTICE, messages: [] };
  return { notice: DM_NOTICE, messages: await read(db, readerId, { kind: "dm", channel: t.id }, { before: opts.before, now: opts.now ?? new Date() }) };
}

export async function myThreads(db: Db, userId: string) {
  return db.select().from(dmThreads).where(or(eq(dmThreads.a, userId), eq(dmThreads.b, userId))).orderBy(desc(dmThreads.createdAt)).limit(200);
}

// --- Moderation follow-through and report evidence ---------------------------------

// The AI check flagged a stored message: hide it everywhere.
export async function hideMessage(db: Db, messageId: string) {
  if (!UUID.test(messageId)) return;
  await db.update(messages).set({ hidden: true }).where(eq(messages.id, messageId));
}

// The last 20 messages of a conversation the reporter is part of, as stored.
export async function evidenceFor(db: Db, reporterId: string, context: { kind: unknown; id: unknown }) {
  let channel: Channel;
  if (context.kind === "dm") channel = { kind: "dm", channel: (await myThread(db, reporterId, context.id)).id };
  else if (context.kind === "crew") channel = { kind: "crew", channel: await myCrewId(db, reporterId) };
  else if (context.kind === "board") channel = { kind: "board", channel: boardPlace(context.id) };
  else throw new ChatError("INVALID_INPUT", "unknown context");
  const rows = await db
    .select({ at: messages.createdAt, authorId: messages.authorId, text: messages.text })
    .from(messages)
    .where(and(eq(messages.kind, channel.kind), eq(messages.channel, channel.channel)))
    .orderBy(desc(messages.createdAt))
    .limit(20);
  return rows.reverse().map((r) => ({ at: r.at.toISOString(), authorId: r.authorId, text: r.text }));
}
