import { afterAll, describe, expect, it } from "vitest";
import { runMinute } from "../src/cron";
import { call, client, close, db, resident } from "./harness";

afterAll(close);

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
