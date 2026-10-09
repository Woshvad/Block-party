import { type Law, ResidentInputError, addDays, electionClock, electionWinner, getLaw, normalizeName, weekStart, cityDay } from "@bp/core";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./client";
import { candidates, electionVoters, elections, mayorTerms, residents, users } from "./schema";

export type PoliticsErrorCode =
  | "INVALID_INPUT"
  | "NO_RESIDENT"
  | "NOT_PON"
  | "WRONG_PHASE"
  | "NOT_A_CANDIDATE"
  | "ALREADY_VOTED"
  | "NOT_AT_CITY_HALL"
  | "NOT_MAYOR"
  | "LAW_ALREADY_CHOSEN"
  | "NO_SUCH_LAW";

export class PoliticsError extends Error {
  constructor(
    readonly code: PoliticsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PoliticsError";
  }
}

// Voting is in person: you have to be at City Hall. The live-rooms brick
// provides the real check; until then nobody is anywhere.
export type PresenceCheck = (userId: string, place: "city_hall") => Promise<boolean>;
export const nobodyIsAnywhere: PresenceCheck = async () => false;

export const PITCH_MAX = 140;

async function ensureElection(tx: Db, week: string) {
  await tx.insert(elections).values({ week }).onConflictDoNothing();
}

// Who may run and vote: a moved-in resident with Proof of Neighbour.
async function requireNeighbour(tx: Db, userId: string) {
  const [u] = await tx
    .select({ pon: users.proofOfNeighbourAt, resident: residents.userId })
    .from(users)
    .leftJoin(residents, eq(residents.userId, users.id))
    .where(eq(users.id, userId))
    .for("no key update", { of: users });
  if (!u?.resident) throw new PoliticsError("NO_RESIDENT", "move in first");
  if (!u.pon) throw new PoliticsError("NOT_PON", "City Hall needs Proof of Neighbour");
}

// --- Running --------------------------------------------------------------

export async function declareCandidacy(db: Db, userId: string, pitch: unknown, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  let text: string;
  try {
    text = normalizeName(pitch, PITCH_MAX);
  } catch (e) {
    if (e instanceof ResidentInputError) throw new PoliticsError("INVALID_INPUT", `pitch: ${e.reason}`);
    throw e;
  }
  const clock = electionClock(now);
  if (clock.phase !== "candidacy") throw new PoliticsError("WRONG_PHASE", "candidates declare Monday to Thursday");
  return db.transaction(async (tx) => {
    await requireNeighbour(tx, userId);
    await ensureElection(tx, clock.week);
    const [row] = await tx
      .insert(candidates)
      .values({ week: clock.week, userId, pitch: text, declaredAt: now })
      .onConflictDoUpdate({
        target: [candidates.week, candidates.userId],
        // Re-declaring after a withdrawal goes to the back of the queue.
        set: { pitch: text, withdrawnAt: null, declaredAt: sql`CASE WHEN ${candidates.withdrawnAt} IS NULL THEN ${candidates.declaredAt} ELSE ${now.toISOString()}::timestamptz END` },
      })
      .returning();
    return row!;
  });
}

export async function withdrawCandidacy(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const clock = electionClock(now);
  if (clock.phase !== "candidacy") throw new PoliticsError("WRONG_PHASE", "you can only withdraw before the booth opens");
  const [row] = await db
    .update(candidates)
    .set({ withdrawnAt: now })
    .where(and(eq(candidates.week, clock.week), eq(candidates.userId, userId), isNull(candidates.withdrawnAt)))
    .returning();
  if (!row) throw new PoliticsError("NOT_A_CANDIDATE", "you're not running");
}

// --- Voting ---------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One neighbour, one vote, in person, secret. Records that you voted and adds
// one to your candidate's count, in the same transaction, and nothing else.
export async function castVote(db: Db, userId: string, candidateId: unknown, opts: { now?: Date; presence?: PresenceCheck } = {}) {
  const now = opts.now ?? new Date();
  const clock = electionClock(now);
  if (clock.phase !== "voting") throw new PoliticsError("WRONG_PHASE", "the booth is open Friday 00:00 to Sunday 23:00 UTC");
  if (typeof candidateId !== "string" || !UUID.test(candidateId)) throw new PoliticsError("NOT_A_CANDIDATE", "no such candidate");
  if (!(await (opts.presence ?? nobodyIsAnywhere)(userId, "city_hall"))) {
    throw new PoliticsError("NOT_AT_CITY_HALL", "come to City Hall to vote");
  }
  return db.transaction(async (tx) => {
    await requireNeighbour(tx, userId);
    await ensureElection(tx, clock.week);
    const [cand] = await tx
      .select({ userId: candidates.userId })
      .from(candidates)
      .where(and(eq(candidates.week, clock.week), eq(candidates.userId, candidateId.toLowerCase()), isNull(candidates.withdrawnAt)));
    if (!cand) throw new PoliticsError("NOT_A_CANDIDATE", "no such candidate");
    const [voted] = await tx.insert(electionVoters).values({ week: clock.week, userId }).onConflictDoNothing().returning();
    if (!voted) throw new PoliticsError("ALREADY_VOTED", "you've already voted this week");
    await tx
      .update(candidates)
      .set({ votes: sql`${candidates.votes} + 1` })
      .where(and(eq(candidates.week, clock.week), eq(candidates.userId, cand.userId)));
    return { voted: true };
  });
}

// --- Counting and swearing in -----------------------------------------------

async function tallyOf(db: Db, week: string) {
  return db
    .select({ candidateId: candidates.userId, handle: residents.handle, pitch: candidates.pitch, votes: candidates.votes, declaredAt: candidates.declaredAt })
    .from(candidates)
    .innerJoin(residents, eq(residents.userId, candidates.userId))
    .where(and(eq(candidates.week, week), isNull(candidates.withdrawnAt)))
    .orderBy(asc(candidates.declaredAt));
}

// Closes an election once its polls have closed and swears in the winner for
// the next week. Idempotent; the Monday bell runs it, and reads catch up.
export async function finalizeElection(db: Db, week: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const close = electionClock(new Date(`${week}T12:00:00.000Z`)).pollsClose;
  if (now < close) throw new PoliticsError("WRONG_PHASE", "the polls haven't closed");
  return db.transaction(async (tx) => {
    await ensureElection(tx, week);
    const [e] = await tx.select().from(elections).where(eq(elections.week, week)).for("no key update");
    if (e!.status === "finalized") return { winner: e!.winnerUserId, turnout: e!.turnout ?? 0, alreadyDone: true };
    const tally = await tallyOf(tx, week);
    const winner = electionWinner(tally);
    const [t] = await tx.select({ n: sql<number>`count(*)::int` }).from(electionVoters).where(eq(electionVoters.week, week));
    await tx.update(elections).set({ status: "finalized", winnerUserId: winner, turnout: t!.n, finalizedAt: now }).where(eq(elections.week, week));
    if (winner) await tx.insert(mayorTerms).values({ week: addDays(week, 7), mayorUserId: winner }).onConflictDoNothing();
    return { winner, turnout: t!.n, alreadyDone: false };
  });
}

// --- The Mayor and the Law ------------------------------------------------

export async function currentTerm(db: Db, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const week = weekStart(cityDay(now));
  // Catch up last week's count if the Monday bell hasn't run yet.
  // Lock-free check first: every City Hall view comes through here, and
  // finalizing takes a row lock.
  const last = addDays(week, -7);
  const [e] = await db.select({ status: elections.status }).from(elections).where(eq(elections.week, last));
  if (e?.status !== "finalized" && now >= electionClock(new Date(`${last}T12:00:00.000Z`)).pollsClose) {
    await finalizeElection(db, last, { now });
  }
  const [t] = await db.select().from(mayorTerms).where(eq(mayorTerms.week, week));
  return t ?? null;
}

export async function currentLaw(db: Db, opts: { now?: Date } = {}): Promise<Law | null> {
  const t = await currentTerm(db, opts);
  return t?.lawId ? getLaw(t.lawId) : null;
}

// The Mayor picks the Law of the Week once, from the menu.
export async function chooseLaw(db: Db, userId: string, lawId: unknown, opts: { now?: Date } = {}) {
  const law = getLaw(lawId);
  if (!law) throw new PoliticsError("NO_SUCH_LAW", "that law isn't on the menu");
  const now = opts.now ?? new Date();
  const term = await currentTerm(db, { now });
  if (!term || term.mayorUserId !== userId) throw new PoliticsError("NOT_MAYOR", "only the Mayor picks the Law of the Week");
  const [row] = await db
    .update(mayorTerms)
    .set({ lawId: law.id, lawChosenAt: now })
    .where(and(eq(mayorTerms.week, term.week), isNull(mayorTerms.lawId)))
    .returning();
  if (!row) throw new PoliticsError("LAW_ALREADY_CHOSEN", "this week's law is already set");
  return law;
}

// Everything City Hall's wall shows. The count appears only after the polls
// close; until then you see who's running and whether you've voted.
export async function cityHall(db: Db, userId: string | null, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const clock = electionClock(now);
  const term = await currentTerm(db, { now });
  const tally = await tallyOf(db, clock.week);
  const [voted] = userId
    ? await db.select().from(electionVoters).where(and(eq(electionVoters.week, clock.week), eq(electionVoters.userId, userId)))
    : [];
  let mayorHandle: string | null = null;
  if (term) {
    const [m] = await db.select({ handle: residents.handle }).from(residents).where(eq(residents.userId, term.mayorUserId));
    mayorHandle = m?.handle ?? null;
  }
  const counted = clock.phase === "counted";
  const [turnout] = counted ? await db.select({ n: sql<number>`count(*)::int` }).from(electionVoters).where(eq(electionVoters.week, clock.week)) : [];
  return {
    mayor: term ? { userId: term.mayorUserId, handle: mayorHandle } : null,
    law: term?.lawId ? getLaw(term.lawId) : null,
    election: {
      week: clock.week,
      phase: clock.phase,
      votingOpens: clock.votingOpens,
      pollsClose: clock.pollsClose,
      candidates: tally.map((c) => ({ candidateId: c.candidateId, handle: c.handle, pitch: c.pitch, ...(counted ? { votes: c.votes } : {}) })),
      turnout: counted ? turnout!.n : null,
      youVoted: !!voted,
    },
  };
}
