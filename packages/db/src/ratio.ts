import { type CityDay, RATIO, checkMessage, cityDay, median, nextBell, ratioPrompt, ratioWinner } from "@bp/core";
import { and, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import type { WhereCheck } from "./chat";
import type { Db } from "./client";
import { accountAgeDays, enqueueModeration, isStaff } from "./safety";
import { markets, ratioEntries, ratioPrompts, ratioVotes, residents, users } from "./schema";
import { cityCalls } from "./tower";

export class RatioError extends Error {
  constructor(
    readonly code: "NO_PROMPT" | "NOT_YET" | "CLOSED" | "ALREADY_IN" | "MODERATED" | "NO_RESIDENT" | "NEEDS_PON" | "NOT_ON_ROOF" | "INVALID_INPUT" | "ALREADY_VOTED" | "NO_PAIRS" | "NOT_STAFF",
    message: string,
  ) {
    super(message);
    this.name = "RatioError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUnique = (e: unknown) => ((e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code) === "23505";
const at = (day: CityDay, hour: number) => new Date(Date.parse(`${day}T00:00:00Z`) + hour * 3_600_000);

// From 18:00 UTC: the day's biggest Vibe Gap (10+ neighbours called it, settling by the bell).
export async function pickRatioPrompt(db: Db, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const day = cityDay(now);
  if (now < at(day, RATIO.promptHour)) return null;
  const [have] = await db.select().from(ratioPrompts).where(eq(ratioPrompts.cityDay, day));
  if (have) return have;
  const open = await db
    .select({ id: markets.id, price: markets.price })
    .from(markets)
    // Still to settle, before the bell: "the headline for when it settles".
    .where(and(eq(markets.infoOnly, false), inArray(markets.status, ["open", "frozen"]), gt(markets.settlesBy, now), lte(markets.settlesBy, nextBell(now))));
  const calls = await cityCalls(db, open.map((m) => m.id));
  let best: { id: string; world: number; city: number; gap: number } | null = null;
  for (const m of open) {
    const cs = calls.filter((c) => c.marketId === m.id).map((c) => c.chance);
    if (cs.length < RATIO.minNeighbours) continue;
    const city = median(cs)!;
    const gap = Math.abs(city - m.price);
    if (!best || gap > best.gap || (gap === best.gap && m.id < best.id)) best = { id: m.id, world: m.price, city, gap };
  }
  if (!best) return null;
  await db.insert(ratioPrompts).values({ cityDay: day, marketId: best.id, world: best.world, city: best.city, createdAt: now }).onConflictDoNothing();
  const [p] = await db.select().from(ratioPrompts).where(eq(ratioPrompts.cityDay, day));
  return p!;
}

export async function todaysRatio(db: Db, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const [p] = await db.select().from(ratioPrompts).where(eq(ratioPrompts.cityDay, cityDay(now)));
  return p ? { cityDay: p.cityDay, marketId: p.marketId, prompt: ratioPrompt(p.world, p.city), votingFrom: at(p.cityDay, RATIO.voteHour) } : null;
}

// One headline each, up to 80 characters, through the chat filter, until 23:00.
export async function submitRatio(db: Db, userId: string, text: unknown, opts: { now?: Date; blockedWords?: readonly string[] } = {}) {
  const now = opts.now ?? new Date();
  const day = cityDay(now);
  const [p] = await db.select().from(ratioPrompts).where(eq(ratioPrompts.cityDay, day));
  if (!p) throw new RatioError("NO_PROMPT", "no Ratio of the Day yet (it opens at 18:00 UTC)");
  if (now >= at(day, RATIO.voteHour)) throw new RatioError("CLOSED", "entries closed at 23:00; the Roof is voting");
  const [r] = await db.select({ id: residents.userId }).from(residents).where(eq(residents.userId, userId));
  if (!r) throw new RatioError("NO_RESIDENT", "move in first");
  if (typeof text !== "string" || [...text.trim()].length < 1 || [...text.trim()].length > RATIO.maxChars) throw new RatioError("INVALID_INPUT", `a headline of up to ${RATIO.maxChars} characters`);
  const v = checkMessage(text, { accountAgeDays: await accountAgeDays(db, userId, now), blockedWords: opts.blockedWords });
  if (!v.ok) throw new RatioError("MODERATED", v.message);
  if ([...v.text].length > RATIO.maxChars) throw new RatioError("INVALID_INPUT", `a headline of up to ${RATIO.maxChars} characters`);
  try {
    const [e] = await db.insert(ratioEntries).values({ cityDay: day, userId, text: v.text, createdAt: now }).returning();
    await enqueueModeration(db, { kind: "board", ref: `ratio:${e!.id}`, authorId: userId, text: v.text });
    return { id: e!.id, text: e!.text };
  } catch (e) {
    if (isUnique(e)) throw new RatioError("ALREADY_IN", "one headline each");
    throw e;
  }
}

// The AI moderation check takes a flagged headline down.
export async function takeDownRatioEntry(db: Db, entryId: string) {
  if (!UUID.test(entryId)) return;
  await db.update(ratioEntries).set({ hidden: true }).where(eq(ratioEntries.id, entryId.toLowerCase()));
}

// Staff can pull any entry.
export async function hideRatioEntry(db: Db, staffId: string, entryId: unknown) {
  if (!(await isStaff(db, staffId))) throw new RatioError("NOT_STAFF", "staff only");
  if (typeof entryId !== "string" || !UUID.test(entryId)) throw new RatioError("INVALID_INPUT", "which entry?");
  await db.update(ratioEntries).set({ hidden: true }).where(eq(ratioEntries.id, entryId.toLowerCase()));
}

async function voter(db: Db, userId: string, now: Date, where: WhereCheck) {
  const day = cityDay(now);
  if (now < at(day, RATIO.voteHour)) throw new RatioError("NOT_YET", "the Roof votes from 23:00 UTC");
  const [u] = await db.select({ pon: users.proofOfNeighbourAt }).from(users).where(eq(users.id, userId));
  if (!u?.pon) throw new RatioError("NEEDS_PON", "votes need Proof of Neighbour");
  if ((await where(userId, "roof")) === null) throw new RatioError("NOT_ON_ROOF", "the Roof votes: come up");
  return day;
}

// A head-to-head pair you haven't voted on, the least-shown entries first.
export async function ratioPair(db: Db, userId: string, opts: { now?: Date; where: WhereCheck }) {
  const now = opts.now ?? new Date();
  const day = await voter(db, userId, now, opts.where);
  const entries = await db
    .select({ id: ratioEntries.id, text: ratioEntries.text })
    .from(ratioEntries)
    .where(and(eq(ratioEntries.cityDay, day), eq(ratioEntries.hidden, false), ne(ratioEntries.userId, userId)));
  const votes = await db.select({ low: ratioVotes.low, high: ratioVotes.high, voterId: ratioVotes.voterId }).from(ratioVotes).where(eq(ratioVotes.cityDay, day));
  const shown = new Map<string, number>();
  for (const v of votes) for (const x of [v.low, v.high]) shown.set(x, (shown.get(x) ?? 0) + 1);
  const mine = new Set(votes.filter((v) => v.voterId === userId).map((v) => `${v.low}|${v.high}`));
  const order = [...entries].sort((a, b) => (shown.get(a.id) ?? 0) - (shown.get(b.id) ?? 0) || (a.id < b.id ? -1 : 1));
  // loop-bound: at most n² candidate pairs over a day's entries.
  for (let i = 0; i < order.length; i++)
    for (let j = i + 1; j < order.length; j++) {
      const [low, high] = order[i]!.id < order[j]!.id ? [order[i]!, order[j]!] : [order[j]!, order[i]!];
      if (!mine.has(`${low.id}|${high.id}`)) return { a: { id: order[i]!.id, text: order[i]!.text }, b: { id: order[j]!.id, text: order[j]!.text } };
    }
  throw new RatioError("NO_PAIRS", "you've voted on every pair");
}

export async function voteRatio(db: Db, userId: string, input: { a?: unknown; b?: unknown; winner?: unknown }, opts: { now?: Date; where: WhereCheck }) {
  const now = opts.now ?? new Date();
  const day = await voter(db, userId, now, opts.where);
  const ids = [input.a, input.b];
  if (!ids.every((x) => typeof x === "string" && UUID.test(x)) || input.a === input.b || (input.winner !== input.a && input.winner !== input.b)) throw new RatioError("INVALID_INPUT", "pick one of the two");
  const [a, b] = (ids as string[]).map((x) => x.toLowerCase()) as [string, string];
  const found = await db
    .select({ id: ratioEntries.id, userId: ratioEntries.userId })
    .from(ratioEntries)
    .where(and(inArray(ratioEntries.id, [a, b]), eq(ratioEntries.cityDay, day), eq(ratioEntries.hidden, false)));
  if (found.length !== 2 || found.some((f) => f.userId === userId)) throw new RatioError("INVALID_INPUT", "those aren't today's headlines (or one is yours)");
  const [low, high] = a < b ? [a, b] : [b, a];
  try {
    await db.insert(ratioVotes).values({ cityDay: day, voterId: userId, low, high, winner: (input.winner as string).toLowerCase(), at: now });
  } catch (e) {
    if (isUnique(e)) throw new RatioError("ALREADY_VOTED", "you've voted on this pair");
    throw e;
  }
  return { voted: true };
}

// At the bell: the winning headline (hidden entries never win).
export async function settleRatio(db: Db, bellDay: CityDay) {
  const [p] = await db.select().from(ratioPrompts).where(eq(ratioPrompts.cityDay, bellDay));
  if (!p || p.winnerEntryId) return null;
  const entries = await db.select().from(ratioEntries).where(and(eq(ratioEntries.cityDay, bellDay), eq(ratioEntries.hidden, false)));
  const votes = await db.select().from(ratioVotes).where(eq(ratioVotes.cityDay, bellDay));
  const visible = new Set(entries.map((e) => e.id));
  const stats = entries.map((e) => ({
    id: e.id,
    wins: votes.filter((v) => v.winner === e.id && visible.has(v.low) && visible.has(v.high)).length,
    shown: votes.filter((v) => (v.low === e.id || v.high === e.id) && visible.has(v.low) && visible.has(v.high)).length,
    at: e.createdAt.getTime(),
  }));
  const winner = ratioWinner(stats);
  if (winner) await db.update(ratioPrompts).set({ winnerEntryId: winner }).where(and(eq(ratioPrompts.cityDay, bellDay), sql`${ratioPrompts.winnerEntryId} IS NULL`));
  return winner;
}

// The winning headline for a market (for its share cards) or a day (for the reel).
export async function ratioHeadline(db: Db, by: { marketId?: string; day?: CityDay }) {
  const [p] = await db
    .select({ text: ratioEntries.text, cityDay: ratioPrompts.cityDay, world: ratioPrompts.world, city: ratioPrompts.city })
    .from(ratioPrompts)
    .innerJoin(ratioEntries, eq(ratioEntries.id, ratioPrompts.winnerEntryId))
    .where(by.marketId ? eq(ratioPrompts.marketId, by.marketId) : eq(ratioPrompts.cityDay, by.day ?? ""))
    .limit(1);
  return p ? { headline: p.text, prompt: ratioPrompt(p.world, p.city) } : null;
}

