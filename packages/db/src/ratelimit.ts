import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { rateLimits } from "./schema";

export type RateResult = { allowed: boolean; count: number; limit: number; resetAt: Date };

// The longest window any limit may use (the daily ones). A window that
// started longer ago than this has ended, which is what lets the sweep
// delete it.
export const RATE_LIMIT_MAX_WINDOW_SECONDS = 86_400;

// One atomic upsert per hit, so concurrent requests can't both slip under the
// limit. Counts keep rising past the limit within a window; that's fine.
export async function hitRateLimit(
  db: Db,
  bucket: string,
  opts: { limit: number; windowSeconds: number; now?: Date },
): Promise<RateResult> {
  if (!bucket || !Number.isSafeInteger(opts.limit) || opts.limit < 1 || !Number.isSafeInteger(opts.windowSeconds) || opts.windowSeconds < 1 || opts.windowSeconds > RATE_LIMIT_MAX_WINDOW_SECONDS) {
    throw new RangeError("bad rate limit");
  }
  const now = opts.now ?? new Date();
  const ms = opts.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / ms) * ms);
  const [row] = await db
    .insert(rateLimits)
    .values({ bucket, windowStart, count: 1 })
    .onConflictDoUpdate({ target: [rateLimits.bucket, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count });
  return { allowed: row!.count <= opts.limit, count: row!.count, limit: opts.limit, resetAt: new Date(windowStart.getTime() + ms) };
}

// Deletes windows that started before `olderThan`, a batch at a time, so a
// backlog never turns into one long statement on the hottest table. Stops
// after maxBatches; the next run carries on. Returns how many rows went.
// The minute cron runs it with a cutoff a day back (see the cap above).
export async function sweepRateLimits(db: Db, olderThan: Date, opts: { batch?: number; maxBatches?: number } = {}) {
  const cutoff = olderThan.toISOString();
  const batch = opts.batch ?? 5000;
  const maxBatches = opts.maxBatches ?? 20;
  let deleted = 0;
  // loop-bound: at most maxBatches statements; a short batch means nothing older is left.
  for (let i = 0; i < maxBatches; i++) {
    const gone = await db.execute(sql`
      DELETE FROM rate_limits WHERE (bucket, window_start) IN (
        SELECT bucket, window_start FROM rate_limits WHERE window_start < ${cutoff}::timestamptz LIMIT ${batch})
      RETURNING 1`);
    deleted += gone.length;
    if (gone.length < batch) break;
  }
  return deleted;
}
