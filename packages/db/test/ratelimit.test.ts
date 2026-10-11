import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { RATE_LIMIT_MAX_WINDOW_SECONDS, createDb, hitRateLimit, sweepRateLimits } from "../src";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
afterAll(() => close());

describe("rate limits", () => {
  it("allows up to the limit in a window, then refuses, then resets", async () => {
    const b = `t:${randomUUID()}`;
    const t = new Date("2026-10-09T12:00:10Z");
    const res = [];
    for (let i = 0; i < 4; i++) res.push(await hitRateLimit(db, b, { limit: 3, windowSeconds: 60, now: t }));
    expect(res.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(res[0]!.resetAt.toISOString()).toBe("2026-10-09T12:01:00.000Z");
    expect((await hitRateLimit(db, b, { limit: 3, windowSeconds: 60, now: new Date("2026-10-09T12:01:00Z") })).allowed).toBe(true);
  });

  it("50 concurrent hits on a limit of 10: exactly 10 allowed", async () => {
    const b = `t:${randomUUID()}`;
    const now = new Date();
    const res = await Promise.all(Array.from({ length: 50 }, () => hitRateLimit(db, b, { limit: 10, windowSeconds: 60, now })));
    expect(res.filter((r) => r.allowed)).toHaveLength(10);
    expect(new Set(res.map((r) => r.count)).size).toBe(50); // every hit got its own count
  });

  it("buckets are independent", async () => {
    const now = new Date();
    await hitRateLimit(db, "t:a:" + randomUUID(), { limit: 1, windowSeconds: 60, now });
    expect((await hitRateLimit(db, "t:b:" + randomUUID(), { limit: 1, windowSeconds: 60, now })).allowed).toBe(true);
  });

  it("refuses nonsense limits", async () => {
    for (const bad of [{ limit: 0, windowSeconds: 60 }, { limit: 1.5, windowSeconds: 60 }, { limit: 1, windowSeconds: 0 }]) {
      await expect(hitRateLimit(db, "x", bad)).rejects.toThrow(RangeError);
    }
    await expect(hitRateLimit(db, "", { limit: 1, windowSeconds: 1 })).rejects.toThrow(RangeError);
  });

  it("sweeps old windows", async () => {
    const b = `t:${randomUUID()}`;
    await hitRateLimit(db, b, { limit: 1, windowSeconds: 60, now: new Date("2020-01-01T00:00:00Z") });
    await sweepRateLimits(db, new Date("2021-01-01T00:00:00Z"));
    expect((await hitRateLimit(db, b, { limit: 1, windowSeconds: 60, now: new Date("2020-01-01T00:00:30Z") })).count).toBe(1);
  });

  it("sweeps a bounded batch at a time, and keeps windows that started after the cutoff", async () => {
    // Back-dated far before any other test's clock, so only these are old enough.
    const p = `t:sweep:${randomUUID()}:`;
    for (let i = 0; i < 7; i++) await hitRateLimit(db, `${p}${i}`, { limit: 1, windowSeconds: 60, now: new Date("1991-01-01T00:00:00Z") });
    await hitRateLimit(db, `${p}fresh`, { limit: 1, windowSeconds: 60, now: new Date("1991-01-02T12:00:00Z") });
    const cutoff = new Date("1991-01-02T00:00:00Z");
    expect(await sweepRateLimits(db, cutoff, { batch: 3, maxBatches: 2 })).toBe(6);
    expect(await sweepRateLimits(db, cutoff, { batch: 3, maxBatches: 2 })).toBe(1);
    expect(await sweepRateLimits(db, cutoff, { batch: 3, maxBatches: 2 })).toBe(0);
    expect((await client`SELECT bucket FROM rate_limits WHERE bucket LIKE ${p + "%"}`).map((r) => r.bucket)).toEqual([`${p}fresh`]);
  });

  it("no window is longer than a day, so anything that started a day ago has ended", async () => {
    await expect(hitRateLimit(db, "x", { limit: 1, windowSeconds: RATE_LIMIT_MAX_WINDOW_SECONDS + 1 })).rejects.toThrow(RangeError);
    expect((await hitRateLimit(db, `t:${randomUUID()}`, { limit: 1, windowSeconds: RATE_LIMIT_MAX_WINDOW_SECONDS })).allowed).toBe(true);
  });
});
