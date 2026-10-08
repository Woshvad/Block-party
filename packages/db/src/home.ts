import {
  CREW,
  FLOOR_FINISHES,
  type KitStyle,
  type Piece,
  type Placement,
  PlacementError,
  type RoomKind,
  WALL_FINISHES,
  crewPotAccountId,
  crewRooms,
  getPiece,
  kitLayout,
  userAccountId,
  validatePlacement,
} from "@bp/core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./client";
import { burn } from "./ledger";
import {
  crewHouses,
  crewMembers,
  crewPieceApprovals,
  crewPieceProposals,
  crews,
  homes,
  items,
  placements,
} from "./schema";

export type HomeErrorCode =
  | "NO_HOME"
  | "NOT_FOR_SALE"
  | "ALREADY_OWNED"
  | "NOT_YOURS"
  | "BAD_PLACEMENT"
  | "BAD_ROOM"
  | "BAD_FINISH"
  | "NOT_IN_CREW"
  | "NOT_ALLOWED"
  | "NO_SUCH_PROPOSAL"
  | "CREW_DISSOLVED";

export class HomeError extends Error {
  constructor(
    readonly code: HomeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HomeError";
  }
}

const WORKING = new Set(["guestbook", "trophy_wall", "slate_board", "tv"]);

const uniqueViolation = (e: unknown): string | undefined => {
  const err = e as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } };
  const c = err?.cause ?? err;
  return c?.code === "23505" ? c.constraint_name : undefined;
};

type Owner = { kind: "user"; id: string } | { kind: "crew"; id: string };

// --- Move-in --------------------------------------------------------------

// Runs inside Create-a-Resident: a tenement, the free kit (placed, so you
// move in furnished) and the backstory's starter item.
export async function setUpHome(tx: Db, userId: string, kitStyle: KitStyle, starterItem: string) {
  await tx.insert(homes).values({ userId }).onConflictDoNothing();
  for (const k of kitLayout(kitStyle)) {
    const [it] = await tx
      .insert(items)
      .values({ pieceId: k.pieceId, ownerUserId: userId, source: "kit" })
      .onConflictDoNothing()
      .returning();
    if (it) await tx.insert(placements).values({ itemId: it.id, room: "tenement", layer: k.placement.layer, spot: k.placement });
  }
  await tx.insert(items).values({ pieceId: starterItem, ownerUserId: userId, source: "starter" }).onConflictDoNothing();
}

// Earned-only pieces (streak lamps, trophies). Once each, never priced.
export async function grantEarned(tx: Db, userId: string, pieceId: string) {
  const piece = getPiece(pieceId);
  if (!piece || piece.band !== "earned") throw new Error(`${pieceId} is not an earned piece`);
  await tx.insert(items).values({ pieceId, ownerUserId: userId, source: "earned" }).onConflictDoNothing();
}

// --- Buying ---------------------------------------------------------------

function forSale(pieceId: unknown): Piece {
  const piece = getPiece(pieceId);
  if (!piece || piece.price === null) throw new HomeError("NOT_FOR_SALE", "that piece isn't for sale");
  return piece;
}

// Buying burns the GM. Safe to retry with the same key: you get the same piece.
export async function buyPiece(db: Db, userId: string, pieceId: unknown, idempotencyKey: string) {
  const piece = forSale(pieceId);
  try {
    return await db.transaction(async (tx) => {
      const [home] = await tx.select().from(homes).where(eq(homes.userId, userId)).for("no key update");
      if (!home) throw new HomeError("NO_HOME", "move in first");
      const res = await burn(tx, {
        accountId: userAccountId(userId),
        amount: piece.price!,
        kind: piece.burnKind,
        idempotencyKey,
        meta: { pieceId: piece.id },
      });
      if (res.replayed) {
        const [prior] = await tx.select().from(items).where(eq(items.txId, res.txId));
        if (!prior || prior.ownerUserId !== userId || prior.pieceId !== piece.id) throw new HomeError("NOT_YOURS", "that purchase key was used for something else");
        return prior;
      }
      if (WORKING.has(piece.id)) {
        const [owned] = await tx.select({ id: items.id }).from(items).where(and(eq(items.ownerUserId, userId), eq(items.pieceId, piece.id)));
        if (owned) throw new HomeError("ALREADY_OWNED", "one of each working piece per home");
      }
      const [it] = await tx
        .insert(items)
        .values({ pieceId: piece.id, ownerUserId: userId, source: "purchase", pricePaid: piece.price!, txId: res.txId })
        .returning();
      return it!;
    });
  } catch (e) {
    if (uniqueViolation(e) === "items_working_once_user") throw new HomeError("ALREADY_OWNED", "one of each working piece per home");
    throw e;
  }
}

// --- Placing --------------------------------------------------------------

async function roomContents(tx: Db, owner: Owner, room: string, exceptItem: string) {
  const ownerCol = owner.kind === "user" ? items.ownerUserId : items.ownerCrewId;
  const rows = await tx
    .select({ itemId: items.id, pieceId: items.pieceId, spot: placements.spot })
    .from(placements)
    .innerJoin(items, eq(items.id, placements.itemId))
    .where(and(eq(ownerCol, owner.id), eq(placements.room, room)));
  return rows
    .filter((r) => r.itemId !== exceptItem)
    .map((r) => ({ piece: getPiece(r.pieceId)!, placement: r.spot as unknown as Placement }));
}

async function place(tx: Db, owner: Owner, itemId: string, room: RoomKind, input: unknown) {
  const ownerCol = owner.kind === "user" ? items.ownerUserId : items.ownerCrewId;
  const [it] = await tx.select().from(items).where(and(eq(items.id, itemId), eq(ownerCol, owner.id)));
  if (!it) throw new HomeError("NOT_YOURS", "that piece isn't yours");
  const piece = getPiece(it.pieceId)!;
  let pl: Placement;
  try {
    pl = validatePlacement(room, piece, input, await roomContents(tx, owner, room, itemId));
  } catch (e) {
    if (e instanceof PlacementError) throw new HomeError("BAD_PLACEMENT", e.reason);
    throw e;
  }
  await tx
    .insert(placements)
    .values({ itemId, room, layer: pl.layer, spot: pl })
    .onConflictDoUpdate({ target: placements.itemId, set: { room, layer: pl.layer, spot: pl, updatedAt: new Date() } });
  return pl;
}

export async function placeItem(db: Db, userId: string, itemId: string, placement: unknown) {
  return db.transaction(async (tx) => {
    // One editor per home at a time, so two placements can't land on one spot.
    const [home] = await tx.select().from(homes).where(eq(homes.userId, userId)).for("no key update");
    if (!home) throw new HomeError("NO_HOME", "move in first");
    return place(tx, { kind: "user", id: userId }, itemId, "tenement", placement);
  });
}

export async function storeItem(db: Db, userId: string, itemId: string) {
  return db.transaction(async (tx) => {
    const [home] = await tx.select().from(homes).where(eq(homes.userId, userId)).for("no key update");
    if (!home) throw new HomeError("NO_HOME", "move in first");
    const [it] = await tx.select().from(items).where(and(eq(items.id, itemId), eq(items.ownerUserId, userId)));
    if (!it) throw new HomeError("NOT_YOURS", "that piece isn't yours");
    await tx.delete(placements).where(eq(placements.itemId, itemId));
  });
}

function finishes(input: { wall?: unknown; floor?: unknown }) {
  const set: { wallFinish?: string; floorFinish?: string } = {};
  if (input.wall !== undefined) {
    if (!(WALL_FINISHES as readonly unknown[]).includes(input.wall)) throw new HomeError("BAD_FINISH", "unknown wall");
    set.wallFinish = input.wall as string;
  }
  if (input.floor !== undefined) {
    if (!(FLOOR_FINISHES as readonly unknown[]).includes(input.floor)) throw new HomeError("BAD_FINISH", "unknown floor");
    set.floorFinish = input.floor as string;
  }
  return set;
}

export async function setFinishes(db: Db, userId: string, input: { wall?: unknown; floor?: unknown }) {
  const set = finishes(input);
  const [h] = await db.update(homes).set(set).where(eq(homes.userId, userId)).returning();
  if (!h) throw new HomeError("NO_HOME", "move in first");
  return h;
}

export async function setDoor(db: Db, userId: string, open: boolean) {
  if (typeof open !== "boolean") throw new HomeError("BAD_PLACEMENT", "open must be true or false");
  const [h] = await db.update(homes).set({ doorOpen: open }).where(eq(homes.userId, userId)).returning();
  if (!h) throw new HomeError("NO_HOME", "move in first");
  return h;
}

async function contents(db: Db, owner: Owner) {
  const ownerCol = owner.kind === "user" ? items.ownerUserId : items.ownerCrewId;
  const rows = await db
    .select({ itemId: items.id, pieceId: items.pieceId, source: items.source, room: placements.room, spot: placements.spot })
    .from(items)
    .leftJoin(placements, eq(placements.itemId, items.id))
    .where(eq(ownerCol, owner.id));
  return {
    placed: rows.filter((r) => r.room !== null).map((r) => ({ itemId: r.itemId, pieceId: r.pieceId, room: r.room!, placement: r.spot })),
    storage: rows.filter((r) => r.room === null).map((r) => ({ itemId: r.itemId, pieceId: r.pieceId, source: r.source })),
  };
}

export async function getHome(db: Db, userId: string) {
  const [h] = await db.select().from(homes).where(eq(homes.userId, userId));
  if (!h) return null;
  return { ...h, ...(await contents(db, { kind: "user", id: userId })) };
}

// --- The Crew House -------------------------------------------------------

async function crewMember(tx: Db, userId: string) {
  const [m] = await tx
    .select({ crewId: crewMembers.crewId, role: crewMembers.role })
    .from(crewMembers)
    .where(and(eq(crewMembers.userId, userId), isNull(crewMembers.leftAt)));
  if (!m) throw new HomeError("NOT_IN_CREW", "you're not in a crew");
  return m;
}

async function lockLiveCrew(tx: Db, crewId: string) {
  const [c] = await tx.select().from(crews).where(eq(crews.id, crewId)).for("no key update");
  if (!c || c.dissolvedAt) throw new HomeError("CREW_DISSOLVED", "this crew has dissolved");
  await tx.insert(crewHouses).values({ crewId }).onConflictDoNothing();
}

// Any member proposes a piece; their proposal is their approval.
export async function proposeCrewPiece(db: Db, userId: string, pieceId: unknown) {
  const piece = forSale(pieceId);
  return db.transaction(async (tx) => {
    const m = await crewMember(tx, userId);
    await lockLiveCrew(tx, m.crewId);
    if (WORKING.has(piece.id)) {
      const [owned] = await tx.select({ id: items.id }).from(items).where(and(eq(items.ownerCrewId, m.crewId), eq(items.pieceId, piece.id)));
      if (owned) throw new HomeError("ALREADY_OWNED", "the Crew House already has one");
    }
    const [p] = await tx.insert(crewPieceProposals).values({ crewId: m.crewId, pieceId: piece.id, proposedBy: userId }).returning();
    await tx.insert(crewPieceApprovals).values({ proposalId: p!.id, userId });
    return p!;
  });
}

// Bought from the pot once the lead and 2 other members approve. Approvals
// from people who have since left don't count. The pot GM burns.
export async function approveCrewPiece(db: Db, userId: string, proposalId: string) {
  return db.transaction(async (tx) => {
    const m = await crewMember(tx, userId);
    await lockLiveCrew(tx, m.crewId);
    const [p] = await tx.select().from(crewPieceProposals).where(eq(crewPieceProposals.id, proposalId)).for("no key update");
    if (!p || p.crewId !== m.crewId || p.status !== "pending") throw new HomeError("NO_SUCH_PROPOSAL", "no open proposal");
    await tx.insert(crewPieceApprovals).values({ proposalId, userId }).onConflictDoNothing();

    const approvers = await tx
      .select({ role: crewMembers.role })
      .from(crewPieceApprovals)
      .innerJoin(crewMembers, and(eq(crewMembers.userId, crewPieceApprovals.userId), eq(crewMembers.crewId, p.crewId), isNull(crewMembers.leftAt)))
      .where(eq(crewPieceApprovals.proposalId, proposalId));
    const lead = approvers.some((a) => a.role === "lead");
    const others = approvers.filter((a) => a.role !== "lead").length;
    if (!lead || others < 2) return { bought: false as const, approvals: approvers.length };

    const piece = getPiece(p.pieceId)!;
    if (WORKING.has(piece.id)) {
      const [owned] = await tx.select({ id: items.id }).from(items).where(and(eq(items.ownerCrewId, p.crewId), eq(items.pieceId, piece.id)));
      if (owned) throw new HomeError("ALREADY_OWNED", "the Crew House already has one");
    }
    const res = await burn(tx, {
      accountId: crewPotAccountId(p.crewId),
      amount: piece.price!,
      kind: "crew_house_decor",
      idempotencyKey: `crew_piece:${proposalId}`,
      meta: { crewId: p.crewId, pieceId: piece.id },
    });
    const [it] = await tx
      .insert(items)
      .values({ pieceId: piece.id, ownerCrewId: p.crewId, source: "purchase", pricePaid: piece.price!, txId: res.txId })
      .returning();
    await tx.update(crewPieceProposals).set({ status: "bought", itemId: it!.id, decidedAt: new Date() }).where(eq(crewPieceProposals.id, proposalId));
    return { bought: true as const, approvals: approvers.length, item: it! };
  });
}

export async function cancelCrewPiece(db: Db, userId: string, proposalId: string) {
  return db.transaction(async (tx) => {
    const m = await crewMember(tx, userId);
    const [p] = await tx.select().from(crewPieceProposals).where(eq(crewPieceProposals.id, proposalId)).for("no key update");
    if (!p || p.crewId !== m.crewId || p.status !== "pending") throw new HomeError("NO_SUCH_PROPOSAL", "no open proposal");
    if (p.proposedBy !== userId && m.role !== "lead") throw new HomeError("NOT_ALLOWED", "only the proposer or the lead can cancel");
    await tx.update(crewPieceProposals).set({ status: "cancelled", decidedAt: new Date() }).where(eq(crewPieceProposals.id, proposalId));
  });
}

async function rosterSize(tx: Db, crewId: string) {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(crewMembers)
    .where(and(eq(crewMembers.crewId, crewId), isNull(crewMembers.leftAt)));
  return r!.n;
}

// The lead and deputies arrange the Crew House.
export async function placeCrewItem(db: Db, userId: string, itemId: string, room: unknown, placement: unknown) {
  return db.transaction(async (tx) => {
    const m = await crewMember(tx, userId);
    if (m.role === "member") throw new HomeError("NOT_ALLOWED", "the lead and deputies arrange the Crew House");
    await lockLiveCrew(tx, m.crewId);
    const open = crewRooms(await rosterSize(tx, m.crewId));
    if (typeof room !== "string" || !(open as string[]).includes(room)) throw new HomeError("BAD_ROOM", "that room isn't open");
    return place(tx, { kind: "crew", id: m.crewId }, itemId, room as RoomKind, placement);
  });
}

export async function storeCrewItem(db: Db, userId: string, itemId: string) {
  return db.transaction(async (tx) => {
    const m = await crewMember(tx, userId);
    if (m.role === "member") throw new HomeError("NOT_ALLOWED", "the lead and deputies arrange the Crew House");
    await lockLiveCrew(tx, m.crewId);
    const [it] = await tx.select().from(items).where(and(eq(items.id, itemId), eq(items.ownerCrewId, m.crewId)));
    if (!it) throw new HomeError("NOT_YOURS", "that piece isn't the crew's");
    await tx.delete(placements).where(eq(placements.itemId, itemId));
  });
}

export async function setCrewFinishes(db: Db, userId: string, input: { wall?: unknown; floor?: unknown }) {
  const set = finishes(input);
  return db.transaction(async (tx) => {
    const m = await crewMember(tx, userId);
    if (m.role === "member") throw new HomeError("NOT_ALLOWED", "the lead and deputies arrange the Crew House");
    await lockLiveCrew(tx, m.crewId);
    const [h] = await tx.update(crewHouses).set(set).where(eq(crewHouses.crewId, m.crewId)).returning();
    return h!;
  });
}

export async function getCrewHouse(db: Db, crewId: string) {
  const [h] = await db.select().from(crewHouses).where(eq(crewHouses.crewId, crewId));
  const size = await rosterSize(db, crewId);
  const proposals = await db
    .select()
    .from(crewPieceProposals)
    .where(and(eq(crewPieceProposals.crewId, crewId), inArray(crewPieceProposals.status, ["pending"])));
  return {
    wallFinish: h?.wallFinish ?? "plaster",
    floorFinish: h?.floorFinish ?? "boards",
    rooms: crewRooms(size),
    proposals,
    approvalsNeeded: { lead: 1, others: 2 },
    maxMembers: CREW.maxMembers,
    ...(await contents(db, { kind: "crew", id: crewId })),
  };
}
