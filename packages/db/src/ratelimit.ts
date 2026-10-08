import { lt, sql } from "drizzle-orm";
import type { Db } from "./client";
import { rateLimits } from "./schema";

export type RateResult = { allowed: boolean; count: number; limit: number; resetAt: Date };

// One atomic upsert per hit, so concurrent requests can't both slip under the
// limit. Counts keep rising past the limit within a window; that's fine.
export async function hitRateLimit(
  db: Db,
  bucket: string,
  opts: { limit: number; windowSeconds: number; now?: Date },
): Promise<RateResult> {
  if (!bucket || !Number.isSafeInteger(opts.limit) || opts.limit < 1 || !Number.isSafeInteger(opts.windowSeconds) || opts.windowSeconds < 1) {
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

export async function sweepRateLimits(db: Db, olderThan: Date) {
  await db.delete(rateLimits).where(lt(rateLimits.windowStart, olderThan));
}
