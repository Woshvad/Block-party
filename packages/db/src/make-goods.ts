import { MAKE_GOOD, checkMessage, cleanText, makeGoodAmountOk, makeGoodClosesAt, makeGoodOpenTo, makeGoodQuietWindow, userAccountId } from "@bp/core";
import { and, asc, desc, eq, gt, lt, lte, sql } from "drizzle-orm";
import type { Db } from "./client";
import { getBalance, mint } from "./ledger";
import { accountAgeDays, enqueueModeration, isStaff } from "./safety";
import { makeGoodCollections, makeGoods, residents, users } from "./schema";

export class MakeGoodError extends Error {
  constructor(
    readonly code: "NOT_STAFF" | "INVALID_INPUT" | "MODERATED" | "TOO_SOON" | "NO_SUCH_MAKE_GOOD" | "NO_RESIDENT" | "NOT_ELIGIBLE" | "TOO_LATE",
    message: string,
  ) {
    super(message);
    this.name = "MakeGoodError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

type Row = typeof makeGoods.$inferSelect;
const view = (m: Row) => ({ id: m.id, reason: m.reason, amount: m.amount, createdAt: m.createdAt, closesAt: makeGoodClosesAt(m.createdAt) });

// --- Staff -------------------------------------------------------------------

// Staff only, and the same refusal as every other staff tool. The reason goes
// through the chat filter before anyone sees it (secrets, scam bait, staff's
// blocked words, links read through their disguises) and the AI check after,
// like every other line the city shows; invisible characters go, and it's
// kept to one short line. Never two within 7 days of each other: checked
// under a lock, so two staff sending one at once make one.
export async function createMakeGood(
  db: Db,
  staffId: string,
  input: { reason?: unknown; amount?: unknown },
  opts: { now?: Date; blockedWords?: readonly string[] } = {},
) {
  const now = opts.now ?? new Date();
  if (!(await isStaff(db, staffId))) throw new MakeGoodError("NOT_STAFF", "staff only");
  if (!makeGoodAmountOk(input.amount)) throw new MakeGoodError("INVALID_INPUT", `a whole number of GM, 1 to ${MAKE_GOOD.max}`);
  const amount = input.amount;
  const short = `a reason of ${MAKE_GOOD.reasonMinChars} to ${MAKE_GOOD.reasonMaxChars} characters`;
  if (typeof input.reason !== "string" || [...input.reason.trim()].length > MAKE_GOOD.reasonMaxChars) throw new MakeGoodError("INVALID_INPUT", short);
  const v = checkMessage(input.reason, { accountAgeDays: await accountAgeDays(db, staffId, now), blockedWords: opts.blockedWords });
  if (!v.ok && v.reason !== "EMPTY") throw new MakeGoodError("MODERATED", v.message);
  const reason = v.ok ? cleanText(v.text).replace(/\s+/g, " ").trim() : "";
  if ([...reason].length < MAKE_GOOD.reasonMinChars || [...reason].length > MAKE_GOOD.reasonMaxChars) throw new MakeGoodError("INVALID_INPUT", short);
  return db.transaction(async (tx) => {
    // One writer at a time, so nobody gets past the check below while
    // another is between it and the insert.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('make_goods'))`);
    const { from, to } = makeGoodQuietWindow(now);
    const [near] = await tx
      .select({ createdAt: makeGoods.createdAt })
      .from(makeGoods)
      .where(and(gt(makeGoods.createdAt, from), lt(makeGoods.createdAt, to)))
      .limit(1);
    if (near) throw new MakeGoodError("TOO_SOON", `one make-good a week: there's already one from ${near.createdAt.toISOString().slice(0, 10)}`);
    const [m] = await tx.insert(makeGoods).values({ reason, amount, createdBy: staffId, createdAt: now }).returning();
    await enqueueModeration(tx, { kind: "make_good", ref: m!.id, authorId: staffId, text: reason });
    return { ...view(m!), createdBy: staffId, collected: 0, paid: 0 };
  });
}

// Newest first: who made each one and when, how many residents have
// collected it and how much GM that came to.
export async function staffMakeGoods(db: Db, staffId: string) {
  if (!(await isStaff(db, staffId))) throw new MakeGoodError("NOT_STAFF", "staff only");
  const rows = await db
    .select({
      m: makeGoods,
      collected: sql<number>`count(${makeGoodCollections.userId})::int`,
      paid: sql<number>`COALESCE(SUM(${makeGoodCollections.amount}), 0)::int`,
    })
    .from(makeGoods)
    .leftJoin(makeGoodCollections, eq(makeGoodCollections.makeGoodId, makeGoods.id))
    .groupBy(makeGoods.id)
    .orderBy(desc(makeGoods.createdAt))
    .limit(50);
  return rows.map((r) => ({ ...view(r.m), createdBy: r.m.createdBy, collected: r.collected, paid: r.paid }));
}

// --- Residents ---------------------------------------------------------------

// The make-goods this resident can still collect, oldest first: out, not yet
// closed, made after they moved in, and not collected. A guest or a claimed
// account that hasn't moved in gets none. Worked out when they look, so
// nothing ever runs over every resident.
export async function myMakeGoods(db: Db, userId: string, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const [me] = await db
    .select({ movedIn: residents.createdAt })
    .from(residents)
    .innerJoin(users, eq(users.id, residents.userId))
    .where(and(eq(residents.userId, userId), eq(users.status, "claimed")));
  if (!me) return [];
  const rows = await db
    .select()
    .from(makeGoods)
    .where(
      and(
        // makeGoodOpenTo's rule, as a query: made after they moved in, out, not closed.
        gt(makeGoods.createdAt, me.movedIn),
        lte(makeGoods.createdAt, now),
        gt(makeGoods.createdAt, new Date(now.getTime() - MAKE_GOOD.collectDays * DAY_MS)),
        sql`NOT EXISTS (SELECT 1 FROM ${makeGoodCollections} WHERE ${makeGoodCollections.makeGoodId} = ${makeGoods.id} AND ${makeGoodCollections.userId} = ${userId})`,
      ),
    )
    .orderBy(asc(makeGoods.createdAt));
  return rows.map(view);
}

// Collecting mints the GM to you under the make_good kind. The ledger key is
// one per make-good and resident, so a retry, or two devices at once, is
// paid once whatever key the request carried (that key is kept in the
// transaction's meta). Restrictions are the API's business, as with the
// drip: a suspension refuses every write there.
export async function collectMakeGood(db: Db, userId: string, makeGoodId: unknown, idempotencyKey: unknown, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  if (typeof makeGoodId !== "string" || !UUID.test(makeGoodId)) throw new MakeGoodError("NO_SUCH_MAKE_GOOD", "no such make-good");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 300) throw new MakeGoodError("INVALID_INPUT", "an idempotency key is needed");
  const id = makeGoodId.toLowerCase();
  return db.transaction(async (tx) => {
    // The resident first, as everything that pays them locks: two devices
    // collecting at once queue here, and the second finds the first's row.
    const [u] = await tx.select({ status: users.status }).from(users).where(eq(users.id, userId)).for("no key update");
    const [r] = u?.status === "claimed" ? await tx.select({ movedIn: residents.createdAt }).from(residents).where(eq(residents.userId, userId)) : [];
    if (!r) throw new MakeGoodError("NO_RESIDENT", "move in first");
    const [m] = await tx.select().from(makeGoods).where(eq(makeGoods.id, id));
    if (!m) throw new MakeGoodError("NO_SUCH_MAKE_GOOD", "no such make-good");
    const acct = userAccountId(userId);
    const [had] = await tx
      .select({ amount: makeGoodCollections.amount })
      .from(makeGoodCollections)
      .where(and(eq(makeGoodCollections.makeGoodId, id), eq(makeGoodCollections.userId, userId)));
    if (had) return { makeGoodId: id, amount: had.amount, already: true, balance: await getBalance(tx, acct) };
    const open = makeGoodOpenTo(m, r.movedIn, now);
    if (open === "not_yet") throw new MakeGoodError("NO_SUCH_MAKE_GOOD", "no such make-good");
    if (open === "not_eligible") throw new MakeGoodError("NOT_ELIGIBLE", "this one's for residents who'd moved in before it went out");
    if (open === "closed") throw new MakeGoodError("TOO_LATE", `a make-good waits ${MAKE_GOOD.collectDays} days, and this one has closed`);
    const res = await mint(tx, {
      accountId: acct,
      amount: m.amount,
      kind: MAKE_GOOD.kind,
      idempotencyKey: `make_good:${id}:${userId}`,
      meta: { makeGoodId: id, requestKey: idempotencyKey },
    });
    await tx.insert(makeGoodCollections).values({ makeGoodId: id, userId, amount: m.amount, txId: res.txId, createdAt: now });
    return { makeGoodId: id, amount: m.amount, already: false, balance: res.balances[acct]! };
  });
}
