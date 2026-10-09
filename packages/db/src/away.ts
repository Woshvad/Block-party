import { AWAY, type AwayPeer, type Trait, awayPlaceAt, awayStory, recap, slotOf } from "@bp/core";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { frensOf } from "./chat";
import { crewMembers, playSessions, residents } from "./schema";

const DAY = 86_400_000;
const SESSION_GAP = 60 * 60_000;

// A resident's away stretches since `since`: the gaps between their play
// sessions, plus the open one after their latest session.
async function awayWindows(db: Db, userIds: string[], since: number, now: number): Promise<Map<string, Array<{ from: number; to: number }>>> {
  const out = new Map<string, Array<{ from: number; to: number }>>();
  if (userIds.length === 0) return out;
  const rows = await db
    .select({ userId: playSessions.userId, startedAt: playSessions.startedAt, lastSeenAt: playSessions.lastSeenAt })
    .from(playSessions)
    .where(and(inArray(playSessions.userId, userIds), gte(playSessions.lastSeenAt, new Date(since - AWAY.livesForDays * DAY))))
    .orderBy(playSessions.userId, playSessions.startedAt);
  const byUser = new Map<string, Array<{ start: number; last: number }>>();
  for (const r of rows) {
    const list = byUser.get(r.userId) ?? [];
    list.push({ start: r.startedAt.getTime(), last: r.lastSeenAt.getTime() });
    byUser.set(r.userId, list);
  }
  for (const [u, sessions] of byUser) {
    const windows: Array<{ from: number; to: number }> = [];
    for (let i = 0; i + 1 < sessions.length; i++) windows.push({ from: sessions[i]!.last, to: sessions[i + 1]!.start });
    const lastS = sessions.at(-1)!;
    if (now - lastS.last >= SESSION_GAP) windows.push({ from: lastS.last, to: now });
    out.set(u, windows);
  }
  return out;
}

async function traitsOf(db: Db, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, Trait[]>();
  const rows = await db.select({ userId: residents.userId, traits: residents.traits }).from(residents).where(inArray(residents.userId, userIds));
  return new Map(rows.map((r) => [r.userId, r.traits as Trait[]]));
}

// "While you were away": the stretch between your last session and this one.
export async function awayRecap(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = (opts.now ?? new Date()).getTime();
  const sessions = await db.select().from(playSessions).where(eq(playSessions.userId, userId)).orderBy(desc(playSessions.startedAt)).limit(2);
  const [current, previous] = sessions;
  if (!current || !previous) return { from: null, to: null, ...recap([]) };
  const from = previous.lastSeenAt.getTime();
  const to = current.startedAt.getTime();
  const me = (await traitsOf(db, [userId])).get(userId) ?? [];

  // Peers you might have bumped into: crewmates and frens.
  const [crew] = await db.select({ crewId: crewMembers.crewId }).from(crewMembers).where(and(eq(crewMembers.userId, userId), sql`${crewMembers.leftAt} IS NULL`));
  const mates = crew
    ? (await db.select({ userId: crewMembers.userId }).from(crewMembers).where(and(eq(crewMembers.crewId, crew.crewId), sql`${crewMembers.leftAt} IS NULL`))).map((m) => m.userId)
    : [];
  const peerIds = [...new Set([...mates, ...(await frensOf(db, userId))])].filter((p) => p !== userId).slice(0, 100);
  const [windows, traits] = await Promise.all([awayWindows(db, peerIds, from, now), traitsOf(db, peerIds)]);
  const peers: AwayPeer[] = [];
  for (const [p, ws] of windows) for (const w of ws) if (w.to > from && w.from < to) peers.push({ userId: p, traits: traits.get(p) ?? [], lastSeen: w.from, awayUntil: w.to });

  const story = awayStory({ userId, traits: me }, from, to, peers);
  return { from: new Date(from), to: new Date(to), ...recap(story) };
}

// Who is wandering a place right now in their away life (for the rooms to
// draw dimmed). Only residents seen in the last 7 days who aren't online.
export async function awayAt(db: Db, place: string, opts: { now?: Date; limit?: number } = {}) {
  const now = (opts.now ?? new Date()).getTime();
  const limit = Math.min(opts.limit ?? 50, 200);
  const rows = await db.execute<{ user_id: string; last_seen: Date; handle: string; traits: string[] }>(sql`
    SELECT DISTINCT ON (s.user_id) s.user_id, s.last_seen_at AS last_seen, r.handle, r.traits
    FROM play_sessions s JOIN residents r ON r.user_id = s.user_id
    WHERE s.last_seen_at >= ${new Date(now - AWAY.livesForDays * DAY).toISOString()}::timestamptz
    ORDER BY s.user_id, s.last_seen_at DESC`);
  const slot = slotOf(now);
  const out: Array<{ userId: string; handle: string }> = [];
  for (const r of rows) {
    const last = new Date(r.last_seen).getTime();
    if (now - last < SESSION_GAP) continue; // online, not away
    if (awayPlaceAt(r.user_id, r.traits as Trait[], slot, last) !== place) continue;
    out.push({ userId: r.user_id, handle: r.handle });
    if (out.length >= limit) break;
  }
  return out;
}

