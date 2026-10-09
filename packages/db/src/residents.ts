import {
  CAST,
  type RandomInt,
  ResidentInputError,
  cityDay,
  cryptoRandomInt,
  dealBackstory,
  normalizeName,
  seasonOf,
  suggestHandle,
  validateGoal,
  validateHandle,
  validateLook,
  validateResidentInput,
  validateTraits,
} from "@bp/core";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { setUpHome } from "./home";
import { residents, users } from "./schema";

export type ResidentErrorCode =
  | "INVALID_INPUT"
  | "UNKNOWN_USER"
  | "NOT_CLAIMED"
  | "ALREADY_MOVED_IN"
  | "HANDLE_TAKEN"
  | "NO_RESIDENT"
  | "TRAITS_LOCKED";

export class ResidentError extends Error {
  constructor(
    readonly code: ResidentErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ResidentError";
  }
}

export type Resident = typeof residents.$inferSelect;

const wrapInput = <T,>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ResidentInputError) throw new ResidentError("INVALID_INPUT", e.reason, e.field);
    throw e;
  }
};

const constraintOf = (e: unknown): string | undefined => {
  const err = e as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } };
  const c = err?.cause ?? err;
  return c?.code === "23505" ? c.constraint_name : undefined;
};

// Move-in: only claimed residents, once each. The city deals the backstory.
export async function createResident(
  db: Db,
  userId: string,
  input: unknown,
  opts: { rand?: RandomInt } = {},
): Promise<Resident> {
  const v = wrapInput(() => validateResidentInput(input));
  const dealt = dealBackstory(opts.rand ?? cryptoRandomInt);
  try {
    return await db.transaction(async (tx) => {
      const [u] = await tx.select({ status: users.status }).from(users).where(eq(users.id, userId)).for("no key update");
      if (!u) throw new ResidentError("UNKNOWN_USER", "no such account");
      if (u.status !== "claimed") throw new ResidentError("NOT_CLAIMED", "claim your account to move in");
      const [existing] = await tx.select({ userId: residents.userId }).from(residents).where(eq(residents.userId, userId));
      if (existing) throw new ResidentError("ALREADY_MOVED_IN", "you already live here");
      const [row] = await tx
        .insert(residents)
        .values({ userId, ...v, ...dealt })
        .returning();
      await setUpHome(tx, userId, v.kitStyle, dealt.starterItem);
      return row!;
    });
  } catch (e) {
    const c = constraintOf(e);
    if (c === "residents_handle_lower") throw new ResidentError("HANDLE_TAKEN", "that handle is taken", "handle");
    if (c === "residents_pkey") throw new ResidentError("ALREADY_MOVED_IN", "you already live here");
    throw e;
  }
}

export async function getResident(db: Db, userId: string): Promise<Resident | null> {
  const [r] = await db.select().from(residents).where(eq(residents.userId, userId));
  return r ?? null;
}

// Who's who for a page of messages or a frens list: handle and look by id,
// at most 100 at a time. The NPCs answer with their names. Unknown ids are
// simply left out; junk input gets an empty list, never an error.
export const LOOKUP_MAX = 100;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function residentsByIds(db: Db, ids: unknown): Promise<Array<{ userId: string; handle: string; name: string; look: Record<string, unknown> | null; npc: string | null }>> {
  if (!Array.isArray(ids)) return [];
  const wanted = [...new Set(ids.filter((x): x is string => typeof x === "string" && ID_RE.test(x)).map((x) => x.toLowerCase()))].slice(0, LOOKUP_MAX);
  if (wanted.length === 0) return [];
  const out: Array<{ userId: string; handle: string; name: string; look: Record<string, unknown> | null; npc: string | null }> = [];
  for (const c of Object.values(CAST)) if (wanted.includes(c.id)) out.push({ userId: c.id, handle: c.name, name: c.name, look: null, npc: c.label });
  const rows = await db.select({ userId: residents.userId, handle: residents.handle, name: residents.name, look: residents.look }).from(residents).where(inArray(residents.userId, wanted));
  for (const r of rows) out.push({ ...r, npc: null });
  return out;
}

export async function findByHandle(db: Db, handle: string): Promise<Resident | null> {
  const h = handle.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
  const [r] = await db
    .select()
    .from(residents)
    .where(sql`lower(${residents.handle}) = lower(${h})`);
  return r ?? null;
}

export async function isHandleAvailable(db: Db, handle: string): Promise<boolean> {
  try {
    validateHandle(handle);
  } catch {
    return false;
  }
  return (await findByHandle(db, handle)) === null;
}

// "Pick for me" on the handle step: a free, valid suggestion.
export async function suggestFreeHandle(db: Db, rand: RandomInt = cryptoRandomInt, tries = 20): Promise<string> {
  for (let i = 0; i < tries; i++) {
    const h = suggestHandle(rand);
    if (await isHandleAvailable(db, h)) return h;
  }
  throw new Error("could not find a free handle");
}

// --- The mirror: change what you can, any time ----------------------------

async function update(db: Db, userId: string, set: Partial<typeof residents.$inferInsert>) {
  const [row] = await db
    .update(residents)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(residents.userId, userId))
    .returning();
  if (!row) throw new ResidentError("NO_RESIDENT", "move in first");
  return row;
}

// async so bad input is always a rejected promise, never a synchronous throw.
export async function updateName(db: Db, userId: string, name: unknown) {
  return update(db, userId, { name: wrapInput(() => normalizeName(name)) });
}

export async function updateLook(db: Db, userId: string, look: unknown) {
  return update(db, userId, { look: wrapInput(() => validateLook(look)) });
}

export async function updateGoal(db: Db, userId: string, g: unknown) {
  return update(db, userId, { goal: wrapInput(() => validateGoal(g)) });
}

// Traits: free to swap once a season. Picking the same three is not a swap.
export async function swapTraits(db: Db, userId: string, traits: unknown, opts: { now?: Date } = {}) {
  const next = wrapInput(() => validateTraits(traits));
  const season = seasonOf(cityDay(opts.now ?? new Date()));
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(residents).where(eq(residents.userId, userId)).for("no key update");
    if (!r) throw new ResidentError("NO_RESIDENT", "move in first");
    if (r.traits.join() === next.join()) return r;
    if (r.traitsSwappedSeason === season) {
      throw new ResidentError("TRAITS_LOCKED", "you already swapped traits this season", "traits");
    }
    const [row] = await tx
      .update(residents)
      .set({ traits: next, traitsSwappedSeason: season, updatedAt: new Date() })
      .where(eq(residents.userId, userId))
      .returning();
    return row!;
  });
}
