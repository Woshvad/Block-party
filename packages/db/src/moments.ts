import { MOMENTS, type TowerMoment, swingBucket, swingOf } from "@bp/core";
import { and, asc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "./client";
import { marketTicks, markets, towerMoments } from "./schema";

// A question as the rooms take it: one line, no control characters.
const oneLine = (q: string) => q.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MOMENTS.questionChars);

// Watch Party big moments, picked after an odds poll: sports markets on the
// Tower that settled YES or NO in the last 15 minutes (a void is nobody's
// moment), or swung 15+ points within the last 30 minutes of stored ticks
// while still open. Each is recorded once: a result once ever, a swing once
// an hour per market. At most 3 a poll, results first, then the biggest
// swings. Returns only the moments this call recorded, most important first:
// only the recorder announces, so racing crons and isolates can't announce
// one twice, and a result the cap held back is picked by the next poll.
export async function pickTowerMoments(db: Db, opts: { now?: Date } = {}): Promise<TowerMoment[]> {
  const now = opts?.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("pickTowerMoments needs a date");
  return db.transaction(async (tx) => {
    // One picker at a time, so the hour between swings and the cap per poll
    // are read and written together. The unique key backs both up.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('tower_moments'))`);
    const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(towerMoments).where(eq(towerMoments.at, now));
    let room = MOMENTS.perPoll - n;
    if (room <= 0) return [];

    // (Spelled out: in a one-table select drizzle writes columns unqualified.)
    const results = await tx
      .select({ id: markets.id, question: markets.question, outcome: markets.outcome, price: markets.price })
      .from(markets)
      .where(
        and(
          eq(markets.category, "sports"),
          eq(markets.status, "resolved"),
          gte(markets.resolvedAt, new Date(now.getTime() - MOMENTS.settledWithinMinutes * 60_000)),
          lte(markets.resolvedAt, now),
          sql`NOT EXISTS (SELECT 1 FROM tower_moments tm WHERE tm.market_id = markets.id AND tm.kind = 'settled')`,
        ),
      )
      .orderBy(asc(markets.resolvedAt), asc(markets.id));

    // Open sports markets the latest poll carried, with their ticks in the
    // window, oldest first.
    const ticks = await tx
      .select({ marketId: marketTicks.marketId, price: marketTicks.price, at: marketTicks.at, question: markets.question })
      .from(marketTicks)
      .innerJoin(markets, eq(markets.id, marketTicks.marketId))
      .where(
        and(
          eq(markets.category, "sports"),
          eq(markets.status, "open"),
          eq(markets.inFeed, true),
          gte(marketTicks.at, new Date(now.getTime() - MOMENTS.swingWindowMinutes * 60_000)),
          lte(marketTicks.at, now),
        ),
      )
      .orderBy(asc(marketTicks.marketId), asc(marketTicks.at), asc(marketTicks.id));
    const byMarket = new Map<string, { question: string; ticks: Array<{ price: number; at: Date }> }>();
    for (const t of ticks) {
      const m = byMarket.get(t.marketId) ?? { question: t.question, ticks: [] };
      m.ticks.push({ price: t.price, at: t.at });
      byMarket.set(t.marketId, m);
    }
    let swings = [...byMarket].flatMap(([marketId, m]) => {
      const s = swingOf(m.ticks, now);
      return s ? [{ marketId, question: m.question, ...s }] : [];
    });
    // A market that had a swing in the last hour waits, across the hour's edge too.
    if (swings.length) {
      const recent = await tx
        .select({ marketId: towerMoments.marketId })
        .from(towerMoments)
        .where(
          and(
            inArray(
              towerMoments.marketId,
              swings.map((s) => s.marketId),
            ),
            eq(towerMoments.kind, "swing"),
            gt(towerMoments.at, new Date(now.getTime() - MOMENTS.swingEveryMinutes * 60_000)),
          ),
        );
      const waiting = new Set(recent.map((r) => r.marketId));
      swings = swings.filter((s) => !waiting.has(s.marketId));
    }
    swings.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from) || a.marketId.localeCompare(b.marketId));

    const picked: TowerMoment[] = [];
    const at = now.getTime();
    for (const r of results) {
      if (room <= 0) break;
      const [row] = await tx
        .insert(towerMoments)
        .values({ marketId: r.id, kind: "settled", bucket: 0, fromPrice: r.price, outcome: r.outcome, at: now })
        .onConflictDoNothing()
        .returning({ id: towerMoments.id });
      if (!row) continue;
      picked.push({ id: row.id, kind: "settled", marketId: r.id, question: oneLine(r.question), outcome: r.outcome ? "yes" : "no", from: r.price, at });
      room--;
    }
    for (const s of swings) {
      if (room <= 0) break;
      const [row] = await tx
        .insert(towerMoments)
        .values({ marketId: s.marketId, kind: "swing", bucket: swingBucket(now), fromPrice: s.from, toPrice: s.to, at: now })
        .onConflictDoNothing()
        .returning({ id: towerMoments.id });
      if (!row) continue;
      picked.push({ id: row.id, kind: "swing", marketId: s.marketId, question: oneLine(s.question), from: s.from, to: s.to, at });
      room--;
    }
    return picked;
  });
}
