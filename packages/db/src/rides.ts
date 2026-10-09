import { type Area, ROLLUP, RIDES, type RideMode, fareFor, isArea, isRideMode, userAccountId } from "@bp/core";
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { Db } from "./client";
import { burn } from "./ledger";
import { currentLaw } from "./politics";
import { buses, residents, rides } from "./schema";

export class RideError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "NO_RESIDENT" | "ALREADY_THERE" | "IDEMPOTENCY_KEY_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "RideError";
  }
}

export type Whereabouts = { area: Area; arrived: boolean; arriveAt: Date | null; from: Area | null };

// Where a resident is: the end of their latest ride, or the street if they've
// never ridden. In transit until it arrives.
export async function whereabouts(db: Db, userId: string, opts: { now?: Date } = {}): Promise<Whereabouts> {
  const now = opts.now ?? new Date();
  const [last] = await db.select().from(rides).where(eq(rides.userId, userId)).orderBy(desc(rides.departedAt), desc(rides.arriveAt)).limit(1);
  if (!last) return { area: "street", arrived: true, arriveAt: null, from: null };
  const arrived = last.arriveAt <= now;
  return { area: last.toArea as Area, arrived, arriveAt: arrived ? null : last.arriveAt, from: last.fromArea as Area };
}

// Takes you somewhere. Walking is free; the Rollup and priority rides burn
// their fare (free under the Gas Holiday). Retrying with the same key returns
// the same ride and never charges twice.
export async function takeRide(db: Db, userId: string, input: { to: unknown; mode: unknown; idempotencyKey: string }, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  if (!isArea(input.to)) throw new RideError("INVALID_INPUT", "where to?");
  if (!isRideMode(input.mode)) throw new RideError("INVALID_INPUT", "walk, rollup or priority");
  if (!input.idempotencyKey) throw new RideError("IDEMPOTENCY_KEY_REQUIRED", "a ride needs an idempotency key");
  const to = input.to;
  const mode: RideMode = input.mode;
  const law = await currentLaw(db, { now });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM users WHERE id = ${userId} FOR NO KEY UPDATE`);
    const [r] = await tx.select({ id: residents.userId }).from(residents).where(eq(residents.userId, userId));
    if (!r) throw new RideError("NO_RESIDENT", "move in first");
    const [prior] = await tx.select().from(rides).where(and(eq(rides.userId, userId), eq(rides.idempotencyKey, input.idempotencyKey)));
    if (prior) return { ride: prior, replayed: true };
    const here = await whereabouts(tx, userId, { now });
    if (here.arrived && here.area === to) throw new RideError("ALREADY_THERE", "you're already there");
    const from: Area = here.arrived ? here.area : (here.from ?? "street"); // turning around mid-ride starts from where you set off

    const fare = fareFor(mode, law?.effects.ridesFree === true);
    let txId: string | null = null;
    if (fare > 0) {
      const paid = await burn(tx, { accountId: userAccountId(userId), amount: fare, kind: "ride", idempotencyKey: `ride:${userId}:${input.idempotencyKey}`, meta: { to, mode } });
      txId = paid.txId;
    }

    let busId: string | null = null;
    let arriveAt = new Date(now.getTime() + RIDES[mode].seconds * 1000);
    if (mode === "rollup") {
      // One boarding at a time per destination, so a bus never takes a ninth rider.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"bus:" + to}))`);
      let [bus] = await tx
        .select()
        .from(buses)
        .where(and(eq(buses.toArea, to), gt(buses.departsAt, now), lt(buses.riders, ROLLUP.seats)))
        .orderBy(asc(buses.departsAt))
        .limit(1);
      if (!bus) {
        [bus] = await tx
          .insert(buses)
          .values({ toArea: to, departsAt: new Date(now.getTime() + ROLLUP.maxWaitSeconds * 1000), riders: 0, createdAt: now })
          .returning();
      }
      const riders = bus!.riders + 1;
      // Full: it leaves now.
      const departsAt = riders >= ROLLUP.seats && bus!.departsAt > now ? now : bus!.departsAt;
      await tx.update(buses).set({ riders, departsAt }).where(eq(buses.id, bus!.id));
      busId = bus!.id;
      arriveAt = new Date(departsAt.getTime() + ROLLUP.roadSeconds * 1000);
      // Leaving early: everyone already on board arrives early too.
      if (departsAt < bus!.departsAt) await tx.update(rides).set({ arriveAt }).where(eq(rides.busId, bus!.id));
    }

    const [ride] = await tx
      .insert(rides)
      .values({ userId, idempotencyKey: input.idempotencyKey, fromArea: from, toArea: to, mode, fare, txId, busId, departedAt: now, arriveAt })
      .returning();
    return { ride: ride!, replayed: false };
  });
}
