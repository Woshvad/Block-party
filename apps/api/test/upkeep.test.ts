import type { OddsProvider } from "@bp/core";
import { afterAll, describe, expect, it } from "vitest";
import { ipBucketKey } from "../src/app";
import { runMinute } from "../src/cron";
import { SECRET, call, client, close, db, makeApp, resident, telegramInit } from "./harness";

afterAll(close);

describe("rate limits keep no client IPs", () => {
  it("per-IP buckets hold a keyed hash of the address, and still limit each address", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
    const strict = makeApp({ limits: { guestsPerIpPerHour: 1 } });
    expect((await call("POST", "/v1/auth/guest", { body: { ageAck: true }, ip, via: strict })).status).toBe(201);
    expect((await call("POST", "/v1/auth/guest", { body: { ageAck: true }, ip, via: strict })).status).toBe(429);
    expect((await call("POST", "/v1/auth/guest", { body: { ageAck: true }, via: strict })).status).toBe(201); // another address
    expect((await call("GET", "/v1/receipts/not-a-receipt", { ip })).status).toBe(404);

    expect(await client`SELECT bucket FROM rate_limits WHERE bucket LIKE ${`%${ip}%`}`).toHaveLength(0);
    const key = await ipBucketKey(SECRET, ip);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    const buckets = (await client`SELECT DISTINCT bucket FROM rate_limits WHERE bucket LIKE ${`%${key}%`}`).map((r) => r.bucket as string).sort();
    expect(buckets).toEqual([`ip:${key}:auth`, `ip:${key}:guest`, `receipt-ip:${key}`]);
  });

  it("Telegram sign-in keys its buckets the same way, and forged launch data shares the IP's auth budget", async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}`;
    const strict = makeApp({ limits: { authPerIpPerMinute: 1 } });
    expect((await call("POST", "/v1/auth/telegram", { body: { initData: await telegramInit(), ageAck: true }, ip, via: strict })).status).toBe(200);
    // One guest sign-in uses up this address's auth budget; forged launch data
    // then counts against the same bucket, not a second one of its own.
    expect((await call("POST", "/v1/auth/guest", { body: { ageAck: true }, ip, via: strict })).status).toBe(201);
    expect((await call("POST", "/v1/auth/telegram", { body: { initData: "user=%7B%7D&hash=00", ageAck: true }, ip, via: strict })).status).toBe(429);

    expect(await client`SELECT bucket FROM rate_limits WHERE bucket LIKE ${`%${ip}%`}`).toHaveLength(0);
    const key = await ipBucketKey(SECRET, ip);
    const buckets = (await client`SELECT DISTINCT bucket FROM rate_limits WHERE bucket LIKE ${`%${key}%`}`).map((r) => r.bucket as string).sort();
    expect(buckets).toEqual([`ip:${key}:auth`, `ip:${key}:auth-telegram`, `ip:${key}:guest`]);
  });

  it("the hash is keyed with the server's secret", async () => {
    const ip = "203.0.113.9";
    expect(await ipBucketKey(SECRET, ip)).toBe(await ipBucketKey(SECRET, ip));
    expect(await ipBucketKey(SECRET, ip)).not.toBe(await ipBucketKey("t".repeat(40), ip));
    expect(await ipBucketKey(SECRET, ip)).not.toBe(await ipBucketKey(SECRET, "203.0.113.10"));
  });
});

describe("the minute cron's sweeps", () => {
  it("every 10 minutes: rate-limit windows over a day old and sessions that ended over a week ago go; the rest stay", async () => {
    const me = await resident();
    const at = new Date();
    at.setUTCMinutes(5, 0, 0); // a sweep minute
    const ago = (hours: number) => new Date(at.getTime() - hours * 3_600_000).toISOString();
    const tag = crypto.randomUUID();
    await client`INSERT INTO rate_limits (bucket, window_start, count) VALUES (${`old:${tag}`}, ${ago(25)}, 1), (${`open:${tag}`}, ${ago(23)}, 1)`;
    const plant = async (expiresAt: string, revokedAt: string | null) =>
      ((await client`INSERT INTO sessions (user_id, token_hash, expires_at, revoked_at) VALUES (${me.userId}, ${crypto.randomUUID()}, ${expiresAt}, ${revokedAt}) RETURNING id`)[0]!.id as string);
    const expiredLongAgo = await plant(ago(8 * 24), null);
    const signedOutLongAgo = await plant(ago(-24), ago(8 * 24));
    const signedOutRecently = await plant(ago(-24), ago(2 * 24));
    const buckets = async () => (await client`SELECT bucket FROM rate_limits WHERE bucket LIKE ${`%:${tag}`}`).map((r) => r.bucket as string).sort();
    const sessions = async () => (await client`SELECT id FROM sessions WHERE id IN ${client([expiredLongAgo, signedOutLongAgo, signedOutRecently])}`).map((r) => r.id as string).sort();

    // Any other minute: nothing swept.
    await runMinute(db, new Date(at.getTime() + 60_000), {});
    expect(await buckets()).toEqual([`old:${tag}`, `open:${tag}`]);
    expect(await sessions()).toHaveLength(3);

    const results = await runMinute(db, at, {});
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await buckets()).toEqual([`open:${tag}`]);
    expect(await sessions()).toEqual([signedOutRecently]);
    expect((await call("GET", "/v1/me", { token: me.token })).status).toBe(200); // a live session is never touched
  });
});

describe("the minute cron's odds", () => {
  it("the Slate and the cast still run when the poll throws, and the poll's failure is its own", async () => {
    // A provider pollOdds refuses outright: the poll job rejects.
    const broken = { source: undefined, fetch: async () => [] } as unknown as OddsProvider;
    const at = new Date();
    at.setUTCMinutes(1, 0, 0); // no sweeps, no daily pings
    const results = await runMinute(db, at, { odds: broken });
    const job = (name: string) => results.find((r) => r.job === name);
    expect(job("odds")).toMatchObject({ status: "rejected" });
    expect(job("slate")).toMatchObject({ status: "fulfilled" });
  });
});
