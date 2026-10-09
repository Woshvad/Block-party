import { HALVING_LINE, SYS_BURN, addDays, cityDay, cityWeekday, halvingBurn, halvingDue, isSaturday, seasonLastDay } from "@bp/core";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { settleCrewChain } from "./chain";
import type { Db } from "./client";
import { collectRent } from "./economy";
import { lockAccounts, post } from "./ledger";
import { finalizeElection } from "./politics";
import { bellSteps, crews, gmAccounts, halvings, residents } from "./schema";

type StepResult = Record<string, unknown>;

export type BellOptions = {
  now?: Date;
  pageSize?: number;
  // Test hook: called inside each account's Halving transaction, after its
  // balance is read under lock. Throw to simulate a crash; await to let
  // another writer try to race in.
  onHalvingAccount?: (accountId: string, index: number, balanceRead: number) => void | Promise<void>;
  // Run only these steps (ops tooling and tests). The default runs every due step.
  only?: Array<"chains" | "rent" | "halving" | "election">;
};

// Keyset pagination over a sorted id column. Each page starts strictly after
// the last id of the previous one, so the walk always moves forward.
async function* pages<T extends { id: string }>(fetch: (after: string, limit: number) => Promise<T[]>, limit: number) {
  let after = "";
  // loop-bound: ids strictly increase page to page and the table is finite, so
  // this ends after ceil(rows / limit) + 1 queries.
  for (;;) {
    const rows = await fetch(after, limit);
    if (rows.length === 0) return;
    yield rows;
    const next = rows[rows.length - 1]!.id;
    if (next <= after) throw new Error("pagination did not advance");
    after = next;
    if (rows.length < limit) return;
  }
}

async function stepChains(db: Db, now: Date, pageSize: number): Promise<StepResult> {
  let crewCount = 0;
  let days = 0;
  const dayStart = new Date(`${cityDay(now)}T00:00:00.000Z`);
  const fetch = (after: string, limit: number) =>
    db
      .select({ id: sql<string>`${crews.id}::text` })
      .from(crews)
      // Live crews, plus any that dissolved in the last week (their last days still settle).
      .where(and(gt(sql`${crews.id}::text`, after), or(isNull(crews.dissolvedAt), gt(crews.dissolvedAt, new Date(dayStart.getTime() - 7 * 86_400_000)))))
      .orderBy(asc(sql`${crews.id}::text`))
      .limit(limit);
  for await (const page of pages(fetch, pageSize)) {
    for (const c of page) {
      days += (await settleCrewChain(db, c.id, { now })).settled;
      crewCount++;
    }
  }
  return { crews: crewCount, daysSettled: days };
}

async function stepRent(db: Db, now: Date, pageSize: number): Promise<StepResult> {
  let checked = 0;
  let paid = 0;
  let couch = 0;
  let sublet = 0;
  const fetch = (after: string, limit: number) =>
    db
      .select({ id: sql<string>`${residents.userId}::text` })
      .from(residents)
      .where(gt(sql`${residents.userId}::text`, after))
      .orderBy(asc(sql`${residents.userId}::text`))
      .limit(limit);
  for await (const page of pages(fetch, pageSize)) {
    for (const r of page) {
      for (const o of await collectRent(db, r.id, { now })) {
        if (o.status === "paid") paid++;
        else if (o.status === "couch") couch++;
        else sublet++;
      }
      checked++;
    }
  }
  return { residents: checked, paid, couch, sublet };
}

// Halves and burns the excess above 2,000 on every resident balance and crew
// pot. Each account is read under its lock, recorded in `halvings`, and
// skipped on any re-run, so a crash midway resumes cleanly and nobody is
// halved twice.
async function stepHalving(db: Db, season: number, pageSize: number, hook?: BellOptions["onHalvingAccount"]): Promise<StepResult> {
  let accounts = 0;
  let burned = 0;
  let index = 0;
  const fetch = (after: string, limit: number) =>
    db
      .select({ id: gmAccounts.id })
      .from(gmAccounts)
      .where(
        and(
          gt(gmAccounts.id, after),
          gt(gmAccounts.balance, HALVING_LINE),
          or(eq(gmAccounts.kind, "user"), sql`${gmAccounts.id} LIKE 'escrow:crew:%'`),
        ),
      )
      .orderBy(asc(gmAccounts.id))
      .limit(limit);
  for await (const page of pages(fetch, pageSize)) {
    for (const { id } of page) {
      const r = await db.transaction(async (tx) => {
        const [done] = await tx.select().from(halvings).where(and(eq(halvings.season, season), eq(halvings.accountId, id)));
        if (done) return 0;
        // Lock in the ledger's order (sys:burn sorts first). Locking the
        // account alone, then posting, deadlocked against any purchase.
        const balance = (await lockAccounts(tx, [id, SYS_BURN])).get(id)!;
        await hook?.(id, index++, balance);
        const burn = halvingBurn(balance);
        if (burn === 0) return 0;
        const res = await post(tx, {
          idempotencyKey: `halving:${season}:${id}`,
          kind: "halving",
          legs: [
            { accountId: id, amount: -burn },
            { accountId: SYS_BURN, amount: burn },
          ],
          meta: { season, balanceBefore: balance },
        });
        await tx.insert(halvings).values({ season, accountId: id, balanceBefore: balance, burned: burn, txId: res.txId });
        return burn;
      });
      if (r > 0) {
        accounts++;
        burned += r;
      }
    }
  }
  // Report the season's full total, including accounts halved by an earlier, crashed run.
  const [total] = await db
    .select({ n: sql<number>`count(*)::int`, burned: sql<string>`COALESCE(SUM(${halvings.burned}), 0)::text` })
    .from(halvings)
    .where(eq(halvings.season, season));
  return { season, accountsThisRun: accounts, burnedThisRun: burned, accounts: total!.n, burned: Number(total!.burned) };
}

// Runs tonight's bell: every due step, each at most once per bell. Safe to
// call again and again (a cron every minute after 00:00 is fine); only one
// runner works at a time.
export async function runBell(db: Db, opts: BellOptions = {}) {
  const now = opts.now ?? new Date();
  const today = cityDay(now);
  const bellDay = addDays(today, -1);
  const pageSize = opts.pageSize ?? 200;

  const due: Array<{ day: string; step: string; run: () => Promise<StepResult> }> = [
    { day: bellDay, step: "chains", run: () => stepChains(db, now, pageSize) },
  ];
  if (isSaturday(today)) due.push({ day: bellDay, step: "rent", run: () => stepRent(db, now, pageSize) });
  // Monday 00:00: last week's count closes and the new Mayor is sworn in.
  if (cityWeekday(today) === 1) {
    due.push({ day: bellDay, step: "election", run: async () => ({ ...(await finalizeElection(db, addDays(today, -7), { now })) }) });
  }
  const season = halvingDue(today);
  if (season !== null) {
    due.push({ day: seasonLastDay(season), step: "halving", run: () => stepHalving(db, season, pageSize, opts.onHalvingAccount) });
  }

  const selected = opts.only ? due.filter((d) => opts.only!.includes(d.step as "chains" | "rent" | "halving" | "election")) : due;

  // One runner at a time: a transaction-scoped advisory lock held for the
  // whole run. Steps do their own work in their own transactions; the done
  // check and the record both go through the lock holder.
  return db.transaction(async (lockTx) => {
    await lockTx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('bell_runner'))`);
    const ran: Record<string, StepResult | "already done"> = {};
    for (const d of selected) {
      const [done] = await lockTx
        .select()
        .from(bellSteps)
        .where(and(eq(bellSteps.bellDay, d.day), eq(bellSteps.step, d.step)));
      if (done) {
        ran[d.step] = "already done";
        continue;
      }
      const result = await d.run();
      await lockTx.insert(bellSteps).values({ bellDay: d.day, step: d.step, result });
      ran[d.step] = result;
    }
    return { bellDay, ran };
  });
}

export async function bellStatus(db: Db, bellDay: string) {
  return db.select().from(bellSteps).where(eq(bellSteps.bellDay, bellDay)).orderBy(asc(bellSteps.step));
}
