import {
  CREW,
  CrewInputError,
  type CrewRole,
  DEFAULT_BANNER,
  type JoinPolicy,
  burnAccountFor,
  can,
  crewNameKey,
  crewPotAccountId,
  crewStatus,
  invitePreApproved,
  userAccountId,
  validateBanner,
  validateCrewName,
  validateJoinPolicy,
} from "@bp/core";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "./client";
import { burn, getBalance, lockAccounts, openEscrowAccount, transfer } from "./ledger";
import { crewInvites, crewJoinRequests, crewMembers, crews, inviters, residents } from "./schema";

export type CrewErrorCode =
  | "INVALID_INPUT"
  | "NO_RESIDENT"
  | "ALREADY_IN_CREW"
  | "NOT_IN_CREW"
  | "NAME_TAKEN"
  | "NOT_ALLOWED"
  | "CREW_FULL"
  | "CREW_DISSOLVED"
  | "INVITE_INVALID"
  | "NO_SUCH_REQUEST"
  | "NO_SUCH_MEMBER"
  | "LEAD_MUST_TRANSFER"
  | "TOO_MANY_DEPUTIES";

export class CrewError extends Error {
  constructor(
    readonly code: CrewErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "CrewError";
  }
}

const input = <T,>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CrewInputError) throw new CrewError("INVALID_INPUT", e.reason, e.field);
    throw e;
  }
};

const uniqueViolation = (e: unknown): string | undefined => {
  const err = e as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } };
  const c = err?.cause ?? err;
  return c?.code === "23505" ? c.constraint_name : undefined;
};

const newInviteCode = () => {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// --- Internals ------------------------------------------------------------

type Membership = { crewId: string; role: CrewRole; stintId: string };

async function membershipOf(tx: Db, userId: string): Promise<Membership | null> {
  const [m] = await tx
    .select({ crewId: crewMembers.crewId, role: crewMembers.role, stintId: crewMembers.id })
    .from(crewMembers)
    .where(and(eq(crewMembers.userId, userId), isNull(crewMembers.leftAt)));
  return m ?? null;
}

async function requireMembership(tx: Db, userId: string): Promise<Membership> {
  const m = await membershipOf(tx, userId);
  if (!m) throw new CrewError("NOT_IN_CREW", "you're not in a crew");
  return m;
}

// Every roster change locks the crew row first: one writer per crew at a time.
async function lockCrew(tx: Db, crewId: string) {
  const [c] = await tx.select().from(crews).where(eq(crews.id, crewId)).for("no key update");
  if (!c) throw new CrewError("CREW_DISSOLVED", "no such crew");
  if (c.dissolvedAt) throw new CrewError("CREW_DISSOLVED", "this crew has dissolved");
  return c;
}

async function rosterSize(tx: Db, crewId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(crewMembers)
    .where(and(eq(crewMembers.crewId, crewId), isNull(crewMembers.leftAt)));
  return r!.n;
}

async function requireResident(tx: Db, userId: string) {
  const [r] = await tx.select({ userId: residents.userId }).from(residents).where(eq(residents.userId, userId));
  if (!r) throw new CrewError("NO_RESIDENT", "move in first");
}

// Adds a resident to a crew the caller has already locked.
async function addMember(tx: Db, crewId: string, userId: string) {
  if (await membershipOf(tx, userId)) throw new CrewError("ALREADY_IN_CREW", "already in a crew");
  if ((await rosterSize(tx, crewId)) >= CREW.maxMembers) throw new CrewError("CREW_FULL", "this crew is full");
  await tx.insert(crewMembers).values({ crewId, userId, role: "member" });
  // Joining one crew withdraws every other pending request.
  await tx
    .update(crewJoinRequests)
    .set({ status: "cancelled", decidedAt: new Date() })
    .where(and(eq(crewJoinRequests.userId, userId), eq(crewJoinRequests.status, "pending")));
}

async function closeStint(tx: Db, stintId: string, reason: "left" | "removed" | "dissolved") {
  await tx.update(crewMembers).set({ leftAt: new Date(), leftReason: reason }).where(eq(crewMembers.id, stintId));
}

// Serialises everything one resident does across crews.
async function lockResident(tx: Db, userId: string) {
  await tx.execute(sql`SELECT 1 FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);
}

const mapUnique = (e: unknown): never => {
  const c = uniqueViolation(e);
  if (c === "crews_name_key_live") throw new CrewError("NAME_TAKEN", "that crew name is taken", "name");
  if (c === "crew_members_one_crew") throw new CrewError("ALREADY_IN_CREW", "already in a crew");
  throw e;
};

// --- Create, read, edit ---------------------------------------------------

export async function createCrew(
  db: Db,
  userId: string,
  opts: { name: unknown; joinPolicy?: unknown; banner?: unknown },
) {
  const name = input(() => validateCrewName(opts.name));
  const policy = input(() => (opts.joinPolicy === undefined ? "approval" : validateJoinPolicy(opts.joinPolicy)));
  const banner = input(() => (opts.banner === undefined ? DEFAULT_BANNER : validateBanner(opts.banner)));
  try {
    return await db.transaction(async (tx) => {
      await lockResident(tx, userId);
      await requireResident(tx, userId);
      if (await membershipOf(tx, userId)) throw new CrewError("ALREADY_IN_CREW", "leave your crew first");
      const [c] = await tx
        .insert(crews)
        .values({ name, nameKey: crewNameKey(name), joinPolicy: policy, banner, createdBy: userId })
        .returning();
      await tx.insert(crewMembers).values({ crewId: c!.id, userId, role: "lead" });
      await openEscrowAccount(tx, crewPotAccountId(c!.id));
      return c!;
    });
  } catch (e) {
    return mapUnique(e);
  }
}

export async function getCrew(db: Db, crewId: string) {
  const [c] = await db.select().from(crews).where(eq(crews.id, crewId));
  if (!c) return null;
  const roster = await db
    .select({ userId: crewMembers.userId, role: crewMembers.role, handle: residents.handle, joinedAt: crewMembers.joinedAt })
    .from(crewMembers)
    .innerJoin(residents, eq(residents.userId, crewMembers.userId))
    .where(and(eq(crewMembers.crewId, crewId), isNull(crewMembers.leftAt)))
    .orderBy(asc(crewMembers.joinedAt));
  return {
    ...c,
    roster,
    status: c.dissolvedAt ? ("dissolved" as const) : crewStatus(roster.length),
    pot: await getBalance(db, crewPotAccountId(crewId)),
  };
}

export async function myCrew(db: Db, userId: string) {
  const m = await membershipOf(db, userId);
  return m ? { role: m.role, crew: (await getCrew(db, m.crewId))! } : null;
}

export async function editCrew(db: Db, actorId: string, opts: { name?: unknown; joinPolicy?: unknown; banner?: unknown }) {
  const set: Partial<typeof crews.$inferInsert> = {};
  if (opts.name !== undefined) {
    set.name = input(() => validateCrewName(opts.name));
    set.nameKey = crewNameKey(set.name);
  }
  if (opts.joinPolicy !== undefined) set.joinPolicy = input(() => validateJoinPolicy(opts.joinPolicy)) as JoinPolicy;
  if (opts.banner !== undefined) set.banner = input(() => validateBanner(opts.banner));
  try {
    return await db.transaction(async (tx) => {
      const m = await requireMembership(tx, actorId);
      if (!can(m.role, "edit_crew")) throw new CrewError("NOT_ALLOWED", "only the lead and deputies can edit the crew");
      await lockCrew(tx, m.crewId);
      if (Object.keys(set).length === 0) return (await tx.select().from(crews).where(eq(crews.id, m.crewId)))[0]!;
      const [c] = await tx.update(crews).set(set).where(eq(crews.id, m.crewId)).returning();
      return c!;
    });
  } catch (e) {
    return mapUnique(e);
  }
}

// --- Invites and joining --------------------------------------------------

export async function createInvite(db: Db, actorId: string, opts: { ttlHours?: number; now?: Date } = {}) {
  const ttl = opts.ttlHours ?? CREW.inviteTtlHours;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > CREW.inviteMaxTtlHours) {
    throw new CrewError("INVALID_INPUT", `invites last up to ${CREW.inviteMaxTtlHours} hours`, "ttl");
  }
  return db.transaction(async (tx) => {
    const m = await requireMembership(tx, actorId);
    await lockCrew(tx, m.crewId);
    const now = opts.now ?? new Date();
    const [inv] = await tx
      .insert(crewInvites)
      .values({
        code: newInviteCode(),
        crewId: m.crewId,
        createdBy: actorId,
        preApproved: invitePreApproved(m.role),
        expiresAt: new Date(now.getTime() + ttl * 3_600_000),
      })
      .returning();
    return inv!;
  });
}

export async function revokeInvite(db: Db, actorId: string, code: unknown) {
  // Same format check as redeem: never hand an unchecked string to SQL (a
  // null byte here was a 500).
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(code)) throw new CrewError("INVITE_INVALID", "no such invite");
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(crewInvites).where(eq(crewInvites.code, code));
    const m = await membershipOf(tx, actorId);
    if (!inv || !m || m.crewId !== inv.crewId) throw new CrewError("INVITE_INVALID", "no such invite");
    if (inv.createdBy !== actorId && !can(m.role, "approve_join")) throw new CrewError("NOT_ALLOWED", "not your invite");
    await tx.update(crewInvites).set({ revokedAt: new Date() }).where(eq(crewInvites.code, code));
  });
}

export type JoinOutcome = { joined: true; crewId: string } | { joined: false; crewId: string; requestId: string };

async function requestOrJoin(tx: Db, crewId: string, userId: string, autoJoin: boolean, invitedBy: string | null): Promise<JoinOutcome> {
  if (autoJoin) {
    await addMember(tx, crewId, userId);
    return { joined: true, crewId };
  }
  if (await membershipOf(tx, userId)) throw new CrewError("ALREADY_IN_CREW", "already in a crew");
  const [existing] = await tx
    .select({ id: crewJoinRequests.id })
    .from(crewJoinRequests)
    .where(and(eq(crewJoinRequests.crewId, crewId), eq(crewJoinRequests.userId, userId), eq(crewJoinRequests.status, "pending")));
  if (existing) return { joined: false, crewId, requestId: existing.id };
  const [req] = await tx.insert(crewJoinRequests).values({ crewId, userId, invitedBy }).returning();
  return { joined: false, crewId, requestId: req!.id };
}

export async function redeemInvite(db: Db, userId: string, code: unknown, opts: { now?: Date } = {}): Promise<JoinOutcome> {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(code)) throw new CrewError("INVITE_INVALID", "no such invite");
  return db.transaction(async (tx) => {
    await lockResident(tx, userId);
    await requireResident(tx, userId);
    const [inv] = await tx.select().from(crewInvites).where(eq(crewInvites.code, code)).for("no key update");
    const now = opts.now ?? new Date();
    if (!inv || inv.revokedAt || inv.expiresAt <= now) throw new CrewError("INVITE_INVALID", "this invite has expired");
    // Only "dissolved" becomes an expired invite. A blanket catch here once
    // turned a deadlock into "this invite has expired" and hid it.
    const crew = await lockCrew(tx, inv.crewId).catch((e) => {
      if (e instanceof CrewError && e.code === "CREW_DISSOLVED") throw new CrewError("INVITE_INVALID", "this crew has dissolved");
      throw e;
    });
    // The inviter's standing now, not when they made the link: a demoted
    // deputy's link needs approval, and a link from someone who left is dead.
    const [inviter] = await tx
      .select({ role: crewMembers.role })
      .from(crewMembers)
      .where(and(eq(crewMembers.crewId, crew.id), eq(crewMembers.userId, inv.createdBy), isNull(crewMembers.leftAt)));
    if (!inviter) throw new CrewError("INVITE_INVALID", "this invite has expired");
    const auto = crew.joinPolicy === "open" || (inv.preApproved && invitePreApproved(inviter.role));
    const out = await requestOrJoin(tx, crew.id, userId, auto, inv.createdBy);
    // The friend who first invited them (for the Grudge Match).
    if (inv.createdBy !== userId) await tx.insert(inviters).values({ userId, inviterId: inv.createdBy }).onConflictDoNothing();
    await tx.update(crewInvites).set({ uses: sql`${crewInvites.uses} + 1` }).where(eq(crewInvites.code, code));
    return out;
  });
}

// Open tables: one tap to join a crew that's looking for members.
export async function joinOpenCrew(db: Db, userId: string, crewId: string): Promise<JoinOutcome> {
  return db.transaction(async (tx) => {
    await lockResident(tx, userId);
    await requireResident(tx, userId);
    const crew = await lockCrew(tx, crewId);
    if (crew.joinPolicy !== "open") throw new CrewError("NOT_ALLOWED", "this crew is invite only");
    return requestOrJoin(tx, crewId, userId, true, null);
  });
}

export async function decideJoinRequest(db: Db, actorId: string, requestId: string, approve: boolean) {
  return db.transaction(async (tx) => {
    // Lock order everywhere: resident, then request/invite, then crew.
    // (Taking the crew first here deadlocked against redeemInvite.)
    const [peek] = await tx.select({ userId: crewJoinRequests.userId }).from(crewJoinRequests).where(eq(crewJoinRequests.id, requestId));
    if (!peek) throw new CrewError("NO_SUCH_REQUEST", "no pending request");
    await lockResident(tx, peek.userId);
    const [req] = await tx.select().from(crewJoinRequests).where(eq(crewJoinRequests.id, requestId)).for("no key update");
    if (!req || req.status !== "pending") throw new CrewError("NO_SUCH_REQUEST", "no pending request");
    await lockCrew(tx, req.crewId);
    const m = await membershipOf(tx, actorId);
    if (!m || m.crewId !== req.crewId || !can(m.role, "approve_join")) {
      throw new CrewError("NOT_ALLOWED", "only the lead and deputies approve joins");
    }
    if (approve) await addMember(tx, req.crewId, req.userId); // also cancels their other requests
    await tx
      .update(crewJoinRequests)
      .set({ status: approve ? "approved" : "declined", decidedBy: actorId, decidedAt: new Date() })
      .where(eq(crewJoinRequests.id, requestId));
    return { approved: approve };
  });
}

export async function pendingRequests(db: Db, actorId: string) {
  const m = await requireMembership(db, actorId);
  if (!can(m.role, "approve_join")) throw new CrewError("NOT_ALLOWED", "only the lead and deputies see requests");
  return db
    .select({ id: crewJoinRequests.id, userId: crewJoinRequests.userId, handle: residents.handle, createdAt: crewJoinRequests.createdAt })
    .from(crewJoinRequests)
    .innerJoin(residents, eq(residents.userId, crewJoinRequests.userId))
    .where(and(eq(crewJoinRequests.crewId, m.crewId), eq(crewJoinRequests.status, "pending")))
    .orderBy(asc(crewJoinRequests.createdAt));
}

// --- Roster changes -------------------------------------------------------

export async function leaveCrew(db: Db, userId: string) {
  return db.transaction(async (tx) => {
    await lockResident(tx, userId);
    const m = await requireMembership(tx, userId);
    await lockCrew(tx, m.crewId);
    if (m.role === "lead") {
      if ((await rosterSize(tx, m.crewId)) > 1) throw new CrewError("LEAD_MUST_TRANSFER", "hand the crew to someone first");
      await dissolveLocked(tx, m.crewId);
      return { dissolved: true };
    }
    await closeStint(tx, m.stintId, "left");
    return { dissolved: false };
  });
}

async function targetStint(tx: Db, crewId: string, userId: string) {
  const [t] = await tx
    .select({ id: crewMembers.id, role: crewMembers.role })
    .from(crewMembers)
    .where(and(eq(crewMembers.crewId, crewId), eq(crewMembers.userId, userId), isNull(crewMembers.leftAt)));
  if (!t) throw new CrewError("NO_SUCH_MEMBER", "not in your crew");
  return t;
}

export async function removeMember(db: Db, actorId: string, targetId: string) {
  return db.transaction(async (tx) => {
    const m = await requireMembership(tx, actorId);
    await lockCrew(tx, m.crewId);
    const actor = await targetStint(tx, m.crewId, actorId); // re-read under the lock
    const t = await targetStint(tx, m.crewId, targetId);
    if (!can(actor.role, "remove", t.role)) throw new CrewError("NOT_ALLOWED", "you can't remove them");
    await closeStint(tx, t.id, "removed");
  });
}

export async function setDeputy(db: Db, actorId: string, targetId: string, deputy: boolean) {
  return db.transaction(async (tx) => {
    const m = await requireMembership(tx, actorId);
    await lockCrew(tx, m.crewId);
    const actor = await targetStint(tx, m.crewId, actorId);
    if (!can(actor.role, "set_deputy")) throw new CrewError("NOT_ALLOWED", "only the lead picks deputies");
    const t = await targetStint(tx, m.crewId, targetId);
    if (t.role === "lead") throw new CrewError("NOT_ALLOWED", "the lead is already the lead");
    const want: CrewRole = deputy ? "deputy" : "member";
    if (t.role === want) return;
    if (deputy) {
      const [d] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(crewMembers)
        .where(and(eq(crewMembers.crewId, m.crewId), eq(crewMembers.role, "deputy"), isNull(crewMembers.leftAt)));
      if (d!.n >= CREW.maxDeputies) throw new CrewError("TOO_MANY_DEPUTIES", `at most ${CREW.maxDeputies} deputies`);
    }
    await tx.update(crewMembers).set({ role: want }).where(eq(crewMembers.id, t.id));
  });
}

// The old lead stays on as a deputy if there's room, else as a member.
export async function transferLead(db: Db, actorId: string, targetId: string) {
  return db.transaction(async (tx) => {
    const m = await requireMembership(tx, actorId);
    await lockCrew(tx, m.crewId);
    const actor = await targetStint(tx, m.crewId, actorId);
    if (!can(actor.role, "transfer_lead")) throw new CrewError("NOT_ALLOWED", "only the lead can hand over the crew");
    if (targetId === actorId) throw new CrewError("NOT_ALLOWED", "you're already the lead");
    const t = await targetStint(tx, m.crewId, targetId);
    const [d] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(crewMembers)
      .where(and(eq(crewMembers.crewId, m.crewId), eq(crewMembers.role, "deputy"), isNull(crewMembers.leftAt), ne(crewMembers.id, t.id)));
    await tx
      .update(crewMembers)
      .set({ role: d!.n < CREW.maxDeputies ? "deputy" : "member" })
      .where(eq(crewMembers.id, actor.id));
    await tx.update(crewMembers).set({ role: "lead" }).where(eq(crewMembers.id, t.id));
  });
}

// Dissolving burns the pot: pot GM never goes back to members. The pot is read
// under the ledger's lock, so a Lights bid or a syndicate stake leaving it at
// the same moment is either in the burn or already gone, never both. Anything
// paid back to a dissolved crew later (a syndicate's winnings, a Lights
// refund) burns where it would have been paid in.
async function dissolveLocked(tx: Db, crewId: string) {
  const pot = crewPotAccountId(crewId);
  const balance = (await lockAccounts(tx, [pot, burnAccountFor(pot)])).get(pot) ?? 0;
  if (balance > 0) {
    await burn(tx, { accountId: pot, amount: balance, kind: "crew_dissolve", idempotencyKey: `crew_dissolve:${crewId}` });
  }
  await tx.update(crews).set({ dissolvedAt: new Date() }).where(eq(crews.id, crewId));
  await tx
    .update(crewMembers)
    .set({ leftAt: new Date(), leftReason: "dissolved" })
    .where(and(eq(crewMembers.crewId, crewId), isNull(crewMembers.leftAt)));
  await tx.update(crewInvites).set({ revokedAt: new Date() }).where(and(eq(crewInvites.crewId, crewId), isNull(crewInvites.revokedAt)));
  await tx
    .update(crewJoinRequests)
    .set({ status: "cancelled", decidedAt: new Date() })
    .where(and(eq(crewJoinRequests.crewId, crewId), eq(crewJoinRequests.status, "pending")));
  return balance;
}

export async function dissolveCrew(db: Db, actorId: string) {
  return db.transaction(async (tx) => {
    const m = await requireMembership(tx, actorId);
    await lockCrew(tx, m.crewId);
    const actor = await targetStint(tx, m.crewId, actorId);
    if (!can(actor.role, "dissolve")) throw new CrewError("NOT_ALLOWED", "only the lead can dissolve the crew");
    return { burned: await dissolveLocked(tx, m.crewId) };
  });
}

// --- The crew pot ---------------------------------------------------------

export async function depositToPot(db: Db, userId: string, amount: number, idempotencyKey: string) {
  return db.transaction(async (tx) => {
    const m = await requireMembership(tx, userId);
    // Shared lock: deposits run side by side but never during a dissolve.
    const [c] = await tx.select().from(crews).where(eq(crews.id, m.crewId)).for("share");
    if (!c || c.dissolvedAt) throw new CrewError("CREW_DISSOLVED", "this crew has dissolved");
    const still = await membershipOf(tx, userId);
    if (!still || still.crewId !== m.crewId) throw new CrewError("NOT_IN_CREW", "you're not in a crew");
    const res = await transfer(tx, {
      from: userAccountId(userId),
      to: crewPotAccountId(m.crewId),
      amount,
      kind: "crew_pot_deposit",
      idempotencyKey,
      meta: { crewId: m.crewId },
    });
    return { replayed: res.replayed, pot: res.balances[crewPotAccountId(m.crewId)]! };
  });
}

// For later bricks (Crew House decor, Tower Lights): pot GM only leaves by burning.
export async function burnFromPot(db: Db, crewId: string, amount: number, kind: string, idempotencyKey: string) {
  return db.transaction(async (tx) => {
    await lockCrew(tx, crewId);
    return burn(tx, { accountId: crewPotAccountId(crewId), amount, kind, idempotencyKey, meta: { crewId } });
  });
}

// Open tables for newcomers: open crews with 5+ members and room, busiest
// first. (The plan's "nearby time zone" filter needs time zones, which
// residents don't record yet.)
export async function openTables(db: Db, limit = 3) {
  return db
    .select({ id: crews.id, name: crews.name, members: sql<number>`count(${crewMembers.id})::int` })
    .from(crews)
    .innerJoin(crewMembers, and(eq(crewMembers.crewId, crews.id), isNull(crewMembers.leftAt)))
    .where(and(eq(crews.joinPolicy, "open"), isNull(crews.dissolvedAt)))
    .groupBy(crews.id)
    .having(sql`count(${crewMembers.id}) BETWEEN 5 AND ${CREW.maxMembers - 1}`)
    .orderBy(sql`count(${crewMembers.id}) DESC`)
    .limit(limit);
}

