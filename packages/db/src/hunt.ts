import { type CityDay, HUNT_PLACE_NAMES, HUNT_TROPHIES, type HuntPlace, type RandomInt, addDays, cityDay, cryptoRandomInt, huntClue, isHuntPlace, nextBell, pickHuntDay } from "@bp/core";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { grantEarned } from "./home";
import { whereabouts } from "./rides";
import { huntDays, huntSearches, residents, users } from "./schema";

// The Daily Clue Hunt. Each city day the city hides something at one public
// place and posts a riddle about it; each resident gets one search a day,
// wherever they've ridden to. Finds earn trophies for your home and nothing
// else: no GM, on purpose. The roadmap leaves cash gem hunts for later, and
// the clue bank sits in the public repo, so anyone can read which place a
// clue means. A trophy is the right prize for that.

export class HuntError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "NO_RESIDENT" | "NOT_AT_A_PLACE" | "ALREADY_SEARCHED",
    message: string,
  ) {
    super(message);
    this.name = "HuntError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type HuntOpts = { now?: Date; rand?: RandomInt };

function parse(userId: unknown, opts: unknown) {
  if (typeof userId !== "string" || !UUID_RE.test(userId)) throw new HuntError("INVALID_INPUT", "who's asking?");
  const o = opts ?? {};
  if (typeof o !== "object" || Array.isArray(o)) throw new HuntError("INVALID_INPUT", "bad options");
  const { now = new Date(), rand = cryptoRandomInt } = o as HuntOpts;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new HuntError("INVALID_INPUT", "bad time");
  if (typeof rand !== "function") throw new HuntError("INVALID_INPUT", "bad options");
  return { userId, now, rand, o: o as Record<string, unknown> };
}

type HuntDay = { day: CityDay; place: HuntPlace; clueIndex: number };

function asHuntDay(row: { day: string; place: string; clueIndex: number }): HuntDay {
  if (!isHuntPlace(row.place)) throw new Error(`hunt day ${row.day} hides at an unknown place: ${row.place}`);
  return { day: row.day, place: row.place, clueIndex: row.clueIndex };
}

// The day's hiding place. Picked with crypto randomness the first time
// anyone asks for that day, never from the date (the repo is public), then
// read back by everyone: racing first askers insert-or-nothing and all read
// the one stored row.
async function huntDay(db: Db, day: CityDay, rand: RandomInt, now: Date): Promise<HuntDay> {
  const [had] = await db.select().from(huntDays).where(eq(huntDays.day, day));
  if (had) return asHuntDay(had);
  return db.transaction(async (tx) => {
    // One pick at a time, so a day's pick always sees the day before's: first
    // askers either side of the bell can't both land on the same place.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('hunt_days'))`);
    const [before] = await tx.select({ place: huntDays.place }).from(huntDays).where(eq(huntDays.day, addDays(day, -1)));
    const pick = pickHuntDay(rand, before && isHuntPlace(before.place) ? before.place : null);
    await tx.insert(huntDays).values({ day, place: pick.place, clueIndex: pick.clueIndex, createdAt: now }).onConflictDoNothing();
    const [row] = await tx.select().from(huntDays).where(eq(huntDays.day, day));
    return asHuntDay(row!);
  });
}

const findersOn = async (db: Db, day: CityDay) =>
  (await db.select({ n: sql<number>`count(*)::int` }).from(huntSearches).where(and(eq(huntSearches.day, day), eq(huntSearches.found, true))))[0]!.n;

const findsOf = async (db: Db, userId: string) =>
  (await db.select({ n: sql<number>`count(*)::int` }).from(huntSearches).where(and(eq(huntSearches.userId, userId), eq(huntSearches.found, true))))[0]!.n;

// Today's clue, your search (if any), how many have found it, and yesterday's
// answer now its bell has rung. Today's place is never in here unless you
// found it: a miss only tells you where you looked.
export async function todaysHunt(db: Db, userId: string, opts: HuntOpts = {}) {
  const p = parse(userId, opts);
  const day = cityDay(p.now);
  const today = await huntDay(db, day, p.rand, p.now);
  const [mine] = await db
    .select({ place: huntSearches.place, found: huntSearches.found })
    .from(huntSearches)
    .where(and(eq(huntSearches.day, day), eq(huntSearches.userId, p.userId)));
  // Only days someone asked about have a row; yesterday may have none.
  const [before] = await db.select().from(huntDays).where(eq(huntDays.day, addDays(day, -1)));
  const yesterday = before ? asHuntDay(before) : null;
  return {
    day,
    clue: huntClue(today.place, today.clueIndex),
    endsAt: nextBell(p.now),
    searched: mine ? { place: mine.place, found: mine.found } : null,
    foundToday: await findersOn(db, day),
    yesterday: yesterday ? { place: yesterday.place, clue: huntClue(yesterday.place, yesterday.clueIndex), finders: await findersOn(db, yesterday.day) } : null,
    finds: await findsOf(db, p.userId),
  };
}

// One search a city day, wherever you've arrived. `place` is where the
// player confirmed searching; if they've moved since, nothing is spent.
export async function searchHere(db: Db, userId: string, opts: HuntOpts & { place?: unknown } = {}) {
  const p = parse(userId, opts);
  const confirmed = p.o.place;
  if (confirmed !== undefined && !isHuntPlace(confirmed)) throw new HuntError("INVALID_INPUT", "which place?");
  const day = cityDay(p.now);
  const today = await huntDay(db, day, p.rand, p.now);
  return db.transaction(async (tx) => {
    // The resident first, as every write takes it: one resident's searches
    // and rides run one at a time, so the find count below is never stale.
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, p.userId)).for("no key update");
    if (!u) throw new HuntError("NO_RESIDENT", "move in first");
    const [r] = await tx.select({ id: residents.userId }).from(residents).where(eq(residents.userId, p.userId));
    if (!r) throw new HuntError("NO_RESIDENT", "move in first");
    const [had] = await tx
      .select({ day: huntSearches.day })
      .from(huntSearches)
      .where(and(eq(huntSearches.day, day), eq(huntSearches.userId, p.userId)));
    if (had) throw new HuntError("ALREADY_SEARCHED", "one search a day: try again after the bell");

    const here = await whereabouts(tx, p.userId, { now: p.now });
    if (!here.arrived) throw new HuntError("NOT_AT_A_PLACE", "you're still on your way: search when you get there");
    if (!isHuntPlace(here.area)) throw new HuntError("NOT_AT_A_PLACE", "nothing's hidden on the street: ride to a place first");
    if (confirmed !== undefined && confirmed !== here.area) throw new HuntError("NOT_AT_A_PLACE", `you're at ${HUNT_PLACE_NAMES[here.area]} now, not ${HUNT_PLACE_NAMES[confirmed]}`);

    const found = here.area === today.place;
    // The primary key backs the check above: a second search that slipped
    // past it records nothing.
    const [row] = await tx.insert(huntSearches).values({ day, userId: p.userId, place: here.area, found, at: p.now }).onConflictDoNothing().returning();
    if (!row) throw new HuntError("ALREADY_SEARCHED", "one search a day: try again after the bell");

    const finds = await findsOf(tx, p.userId);
    const trophies: string[] = [];
    if (found) for (const t of HUNT_TROPHIES) if (finds >= t.finds && (await grantEarned(tx, p.userId, t.pieceId))) trophies.push(t.pieceId);
    return { day, place: here.area, found, finds, trophies };
  });
}
