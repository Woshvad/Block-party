import { afterAll, describe, expect, it } from "vitest";
import { ipBucketKey } from "../src/app";
import { runMinute } from "../src/cron";
import { SECRET, call, client, close, db, makeApp, resident } from "./harness";

afterAll(close);

describe("rate limits keep no client IPs", () => {
  it("per-IP buckets hold a keyed hash of the address, and still limit each address", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
    // Not the harness's sequential 10.0.x.y: other files may have used those in the last hour.
    const other = `100.64.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const strict = makeApp({ limits: { guestsPerIpPerHour: 1 } });
    expect((await call("POST", "/v1/auth/guest", { body: { ageAck: true }, ip, via: strict })).status).toBe(201);
    expect((await call("POST", "/v1/auth/guest", { body: { ageAck: true }, ip, via: strict })).status).toBe(429);
    expect((await call("POST", "/v1/auth/guest", { body: { ageAck: true }, ip: other, via: strict })).status).toBe(201); // another address
    expect((await call("GET", "/v1/receipts/not-a-receipt", { ip })).status).toBe(404);

    expect(await client`SELECT bucket FROM rate_limits WHERE bucket LIKE ${`%${ip}%`}`).toHaveLength(0);
    const key = await ipBucketKey(SECRET, ip);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    const buckets = (await client`SELECT DISTINCT bucket FROM rate_limits WHERE bucket LIKE ${`%${key}%`}`).map((r) => r.bucket as string).sort();
    expect(buckets).toEqual([`ip:${key}:auth`, `ip:${key}:guest`, `receipt-ip:${key}`]);
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
