import { randomUUID } from "node:crypto";
import { type PrivyVerifier, TelegramAuthError, createPrivyVerifier, signTelegramInitData, userAccountId } from "@bp/core";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AccountError,
  createDb,
  createGuest,
  ensureSystemAccounts,
  getBalance,
  mint,
  reconcile,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  signInWithIdentity,
  signInWithPrivy,
  signInWithTelegram,
  sweepSessions,
} from "../src";
import { raceAt } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const BOT = "777:TEST";
const APP = "app_test";
let privyKey: CryptoKey;
let verify: PrivyVerifier;

let tgCounter = 1_000_000 + Math.floor(Math.random() * 1_000_000);
const tgId = () => ++tgCounter;
const initData = (id: number, extra: Record<string, string> = {}) =>
  signTelegramInitData(
    {
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id, first_name: "Ser", username: `u${id}`, language_code: "en" }),
      ...extra,
    },
    BOT,
  );
const privyToken = (did: string) =>
  new SignJWT({}).setProtectedHeader({ alg: "ES256" }).setIssuer("privy.io").setAudience(APP).setSubject(did).setExpirationTime("1h").sign(privyKey);
const newDid = () => `did:privy:${randomUUID()}`;

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof AccountError) return e.code;
    if (e instanceof TelegramAuthError) return `TG_${e.reason}`;
    throw e;
  }
}

const count = async (sql: string, ...params: unknown[]) =>
  (await client.unsafe(sql, params as never[]))[0]!.n as number;

const race = <T,>(table: string, n: number, racers: Array<() => Promise<T>>) => raceAt(client, table, n, racers);

beforeAll(async () => {
  await ensureSystemAccounts(db);
  const keys = await generateKeyPair("ES256", { extractable: true });
  privyKey = keys.privateKey;
  verify = await createPrivyVerifier({ appId: APP, verificationKeyPem: await exportSPKI(keys.publicKey) });
});
afterAll(async () => {
  expect(await reconcile(db)).toEqual([]);
  await close();
});

describe("guests", () => {
  it("needs the 18+ notice", async () => {
    expect(await code(createGuest(db, { ageAck: false }))).toBe("AGE_ACK_REQUIRED");
    expect(await code(createGuest(db, {} as { ageAck: boolean }))).toBe("AGE_ACK_REQUIRED");
  });

  it("gets a resident, a GM account and a working session", async () => {
    const g = await createGuest(db, { ageAck: true });
    expect(g).toMatchObject({ status: "guest", isNew: true, leftGuest: false });
    expect(await getBalance(db, userAccountId(g.userId))).toBe(0);
    expect(await resolveSession(db, g.sessionToken)).toMatchObject({ userId: g.userId, status: "guest" });
  });

  it("never stores the raw token", async () => {
    const g = await createGuest(db, { ageAck: true });
    expect(await count(`SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1`, g.sessionToken)).toBe(0);
  });
});

describe("sessions", () => {
  it("rejects garbage, unknown, revoked and expired tokens", async () => {
    const g = await createGuest(db, { ageAck: true });
    for (const t of [undefined, null, "", "bps_nope", 123, `bps_${"A".repeat(43)}`]) {
      expect(await resolveSession(db, t)).toBeNull();
    }
    const in31Days = new Date(Date.now() + 31 * 24 * 3600 * 1000);
    expect(await resolveSession(db, g.sessionToken, { now: in31Days })).toBeNull();

    await revokeSession(db, g.sessionToken);
    expect(await resolveSession(db, g.sessionToken)).toBeNull();
  });

  it("revokes every device at once", async () => {
    const id = tgId();
    const a = await signInWithTelegram(db, { initData: await initData(id), botToken: BOT, ageAck: true });
    const b = await signInWithTelegram(db, { initData: await initData(id), botToken: BOT });
    expect(await resolveSession(db, a.sessionToken)).not.toBeNull();
    expect(await resolveSession(db, b.sessionToken)).not.toBeNull();
    await revokeAllSessions(db, a.userId);
    expect(await resolveSession(db, a.sessionToken)).toBeNull();
    expect(await resolveSession(db, b.sessionToken)).toBeNull();
  });

  it("the sweep deletes sessions that ended over a week ago, a bounded batch at a time, and keeps the rest", async () => {
    const g = await createGuest(db, { ageAck: true });
    // Back-dated far before any other test's clock, so only these are old enough.
    const plant = async (expiresAt: string, revokedAt: string | null) =>
      ((await client`INSERT INTO sessions (user_id, token_hash, expires_at, revoked_at) VALUES (${g.userId}, ${randomUUID()}, ${expiresAt}, ${revokedAt}) RETURNING id`)[0]!.id as string);
    const now = new Date("1990-06-01T00:00:00Z");
    const gone: string[] = [];
    for (let i = 0; i < 5; i++) gone.push(await plant("1990-01-01T00:00:00Z", null)); // expired months ago
    for (let i = 0; i < 2; i++) gone.push(await plant("1990-09-01T00:00:00Z", "1990-05-01T00:00:00Z")); // signed out a month ago
    const kept = [
      await plant("1990-05-30T00:00:00Z", null), // expired 2 days ago
      await plant("1990-09-01T00:00:00Z", "1990-05-29T00:00:00Z"), // signed out 3 days ago
      await plant("1990-09-01T00:00:00Z", null), // still live
    ];
    expect(await sweepSessions(db, { now, batch: 3, maxBatches: 2 })).toBe(6);
    expect(await sweepSessions(db, { now, batch: 3, maxBatches: 2 })).toBe(1);
    expect(await sweepSessions(db, { now, batch: 3, maxBatches: 2 })).toBe(0);
    const left = await client`SELECT id FROM sessions WHERE id IN ${client([...gone, ...kept])}`;
    expect(left.map((r) => r.id as string).sort()).toEqual([...kept].sort());
    expect(await resolveSession(db, g.sessionToken)).not.toBeNull();
  });

  it("the sweep finds ended sessions by index, not by reading every session", async () => {
    // A scan ruled out, the sweep's lookup must find an index for each way a
    // session ends; without one the plan falls back to reading the table.
    const plan = (await client.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      return tx`EXPLAIN SELECT id FROM sessions WHERE expires_at < ${"1990-01-01T00:00:00Z"}::timestamptz OR revoked_at < ${"1990-01-01T00:00:00Z"}::timestamptz LIMIT 5000`;
    })) as unknown as Array<{ "QUERY PLAN": string }>;
    const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).toMatch(/Index Cond: .*expires_at </);
    expect(text).toMatch(/Index Cond: .*revoked_at </);
  });
});

describe("telegram sign-in", () => {
  it("creates a claimed resident on first sign-in, then signs back into it", async () => {
    const id = tgId();
    const first = await signInWithTelegram(db, { initData: await initData(id, { start_param: "ref_x" }), botToken: BOT, ageAck: true });
    expect(first).toMatchObject({ status: "claimed", isNew: true, startParam: "ref_x" });
    const again = await signInWithTelegram(db, { initData: await initData(id), botToken: BOT });
    expect(again).toMatchObject({ userId: first.userId, isNew: false });
    expect(again.sessionToken).not.toBe(first.sessionToken);
  });

  it("needs the 18+ notice for a brand-new resident", async () => {
    expect(await code(signInWithTelegram(db, { initData: await initData(tgId()), botToken: BOT }))).toBe("AGE_ACK_REQUIRED");
  });

  it("refuses forged data before touching the database", async () => {
    const before = await count(`SELECT count(*)::int AS n FROM users`);
    const forged = await signTelegramInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: '{"id":5}' }, "wrong");
    expect(await code(signInWithTelegram(db, { initData: forged, botToken: BOT, ageAck: true }))).toBe("TG_BAD_SIGNATURE");
    expect(await count(`SELECT count(*)::int AS n FROM users`)).toBe(before);
  });

  it("stores only username and language", async () => {
    const id = tgId();
    const r = await signInWithTelegram(db, { initData: await initData(id), botToken: BOT, ageAck: true });
    const [row] = await client`SELECT meta FROM identities WHERE user_id = ${r.userId}`;
    expect(row!.meta).toEqual({ username: `u${id}`, languageCode: "en" });
  });
});

describe("claiming a guest", () => {
  it("keeps the guest's GM and resident, rotates the session", async () => {
    const g = await createGuest(db, { ageAck: true });
    await mint(db, { accountId: userAccountId(g.userId), amount: 55, kind: "drip", idempotencyKey: randomUUID() });

    const claimed = await signInWithTelegram(db, { initData: await initData(tgId()), botToken: BOT, currentSessionToken: g.sessionToken });
    expect(claimed).toMatchObject({ userId: g.userId, status: "claimed", isNew: false, leftGuest: false });
    expect(await getBalance(db, userAccountId(g.userId))).toBe(55 + 1000); // their GM plus the move-in gift
    expect(await resolveSession(db, g.sessionToken)).toBeNull(); // old guest token is dead
    expect(await resolveSession(db, claimed.sessionToken)).toMatchObject({ status: "claimed" });
  });

  it("links a second provider to a claimed resident", async () => {
    const t = await signInWithTelegram(db, { initData: await initData(tgId()), botToken: BOT, ageAck: true });
    const did = newDid();
    const p = await signInWithPrivy(db, { accessToken: await privyToken(did), verify, currentSessionToken: t.sessionToken });
    expect(p.userId).toBe(t.userId);
    const back = await signInWithPrivy(db, { accessToken: await privyToken(did), verify });
    expect(back.userId).toBe(t.userId);
  });

  it("refuses a second login from the same provider", async () => {
    const t = await signInWithTelegram(db, { initData: await initData(tgId()), botToken: BOT, ageAck: true });
    expect(
      await code(signInWithTelegram(db, { initData: await initData(tgId()), botToken: BOT, currentSessionToken: t.sessionToken })),
    ).toBe("PROVIDER_ALREADY_LINKED");
  });

  it("signing in as an existing resident leaves the guest behind, never merges GM", async () => {
    const id = tgId();
    const owner = await signInWithTelegram(db, { initData: await initData(id), botToken: BOT, ageAck: true });
    const g = await createGuest(db, { ageAck: true });
    await mint(db, { accountId: userAccountId(g.userId), amount: 30, kind: "drip", idempotencyKey: randomUUID() });

    const r = await signInWithTelegram(db, { initData: await initData(id), botToken: BOT, currentSessionToken: g.sessionToken });
    expect(r).toMatchObject({ userId: owner.userId, leftGuest: true, isNew: false });
    expect(await getBalance(db, userAccountId(owner.userId))).toBe(1000); // move-in gift only, nothing merged
    expect(await getBalance(db, userAccountId(g.userId))).toBe(30);
    expect(await resolveSession(db, g.sessionToken)).toBeNull();
  });

  it("a stale session is an explicit error, not a silent new account", async () => {
    const g = await createGuest(db, { ageAck: true });
    await revokeSession(db, g.sessionToken);
    const before = await count(`SELECT count(*)::int AS n FROM users`);
    expect(
      await code(signInWithTelegram(db, { initData: await initData(tgId()), botToken: BOT, currentSessionToken: g.sessionToken, ageAck: true })),
    ).toBe("INVALID_SESSION");
    expect(await count(`SELECT count(*)::int AS n FROM users`)).toBe(before);
  });
});

describe("move-in", () => {
  const moveIns = (userId: string) =>
    count(`SELECT count(*)::int AS n FROM gm_transactions WHERE idempotency_key = $1`, `move_in:${userId}`);
  const hodl = async (userId: string) => (await client`SELECT hodl_days FROM streaks WHERE user_id = ${userId}`)[0]?.hodl_days;

  it("guests get no gift; claiming pays 1,000 GM and one Hodl Day, once", async () => {
    const g = await createGuest(db, { ageAck: true });
    expect(await getBalance(db, userAccountId(g.userId))).toBe(0);
    const c = await signInWithTelegram(db, { initData: await initData(tgId()), botToken: BOT, currentSessionToken: g.sessionToken });
    expect(await getBalance(db, userAccountId(g.userId))).toBe(1000);
    expect(await hodl(g.userId)).toBe(1);
    // linking a second provider is not a second move-in
    await signInWithPrivy(db, { accessToken: await privyToken(newDid()), verify, currentSessionToken: c.sessionToken });
    expect(await getBalance(db, userAccountId(g.userId))).toBe(1000);
    expect(await moveIns(g.userId)).toBe(1);
    expect(await hodl(g.userId)).toBe(1);
  });

  it("a brand-new claimed resident gets it too, and signing back in pays nothing", async () => {
    const id = tgId();
    const r = await signInWithTelegram(db, { initData: await initData(id), botToken: BOT, ageAck: true });
    await signInWithTelegram(db, { initData: await initData(id), botToken: BOT });
    expect(await getBalance(db, userAccountId(r.userId))).toBe(1000);
    expect(await moveIns(r.userId)).toBe(1);
  });

  it("20 racing first sign-ins pay exactly one gift", async () => {
    const data = await initData(tgId());
    const settled = await race("identities", 20, Array.from({ length: 20 }, () => () =>
      signInWithTelegram(db, { initData: data, botToken: BOT, ageAck: true }),
    ));
    const userId = (settled[0] as { v: { userId: string } }).v.userId;
    expect(await getBalance(db, userAccountId(userId))).toBe(1000);
    // the losers' rolled-back attempts left no gift anywhere
    expect(await count(`SELECT count(*)::int AS n FROM gm_transactions WHERE kind='move_in' AND idempotency_key LIKE 'move_in:%' AND idempotency_key NOT IN (SELECT 'move_in:' || id FROM users)`)).toBe(0);
  });
});

describe("races", () => {
  it("signing back into the current account revokes the supplied session", async () => {
    const data = await initData(tgId());
    const first = await signInWithTelegram(db, { initData: data, botToken: BOT, ageAck: true });
    const next = await signInWithTelegram(db, { initData: data, botToken: BOT, currentSessionToken: first.sessionToken });
    expect(await resolveSession(db, first.sessionToken)).toBeNull();
    expect(await resolveSession(db, next.sessionToken)).toMatchObject({ userId: first.userId });
  });

  it("a queued sign-in cannot reuse a session another sign-in just rotated", async () => {
    const data = await initData(tgId());
    const first = await signInWithTelegram(db, { initData: data, botToken: BOT, ageAck: true });
    const results = await race("sessions", 2, [0, 1].map(() => () => signInWithTelegram(db, { initData: data, botToken: BOT, currentSessionToken: first.sessionToken })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ e: { code: "INVALID_SESSION" } });
  });
  it("20 simultaneous first sign-ins with one Telegram id make exactly one resident", async () => {
    const raceStart = new Date(Date.now() - 1000);
    const id = tgId();
    const data = await initData(id);
    const settled = await race("identities", 20, Array.from({ length: 20 }, () => () =>
      signInWithTelegram(db, { initData: data, botToken: BOT, ageAck: true }),
    ));
    const failures = settled.filter((s) => !s.ok);
    expect(failures).toEqual([]);
    const results = settled.map((s) => (s as { v: Awaited<ReturnType<typeof signInWithTelegram>> }).v);
    expect(new Set(results.map((r) => r.userId)).size).toBe(1);
    expect(results.filter((r) => r.isNew)).toHaveLength(1);
    expect(await count(`SELECT count(*)::int AS n FROM identities WHERE provider='telegram' AND subject=$1`, String(id))).toBe(1);
    // and no orphan residents were left behind by the losers
    expect(
      await count(
        `SELECT count(*)::int AS n FROM users u WHERE u.status='claimed' AND u.created_at >= $1::timestamptz
         AND NOT EXISTS (SELECT 1 FROM identities i WHERE i.user_id=u.id)`,
        raceStart.toISOString(),
      ),
    ).toBe(0);
  });

  it("a guest claimed by four Telegram accounts at once keeps exactly one", async () => {
    const g = await createGuest(db, { ageAck: true });
    const datas = await Promise.all([tgId(), tgId(), tgId(), tgId()].map((id) => initData(id)));
    const settled = await race("identities", 4, datas.map((d) => () =>
      code(signInWithTelegram(db, { initData: d, botToken: BOT, currentSessionToken: g.sessionToken })),
    ));
    const outcomes = settled.map((s) => (s.ok ? s.v : `THREW ${String(s.e)}`));
    expect(outcomes.filter((o) => o === "OK")).toHaveLength(1);
    expect(outcomes.filter((o) => o !== "OK").every((o) => ["INVALID_SESSION", "PROVIDER_ALREADY_LINKED"].includes(o))).toBe(true);
    expect(await count(`SELECT count(*)::int AS n FROM identities WHERE user_id=$1`, g.userId)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM users WHERE id=$1 AND status='claimed'`, g.userId)).toBe(1);
  });

  it("one Telegram id claiming two guests at once lands on exactly one", async () => {
    const [g1, g2] = await Promise.all([createGuest(db, { ageAck: true }), createGuest(db, { ageAck: true })]);
    const data = await initData(tgId());
    const settled = await race("identities", 2, [g1!, g2!].map((g) => () =>
      signInWithTelegram(db, { initData: data, botToken: BOT, currentSessionToken: g.sessionToken }),
    ));
    expect(settled.every((s) => s.ok)).toBe(true);
    const results = settled.map((s) => (s as { v: Awaited<ReturnType<typeof signInWithTelegram>> }).v);
    expect(new Set(results.map((r) => r.userId)).size).toBe(1); // both end up as the same resident
    expect(results.filter((r) => r.leftGuest)).toHaveLength(1); // the loser's guest is left behind
  });

  it("an identity can never belong to two residents (DB guard)", async () => {
    const a = await createGuest(db, { ageAck: true });
    const b = await createGuest(db, { ageAck: true });
    const subject = `x${randomUUID()}`;
    await signInWithIdentity(db, { provider: "privy", subject, currentSessionToken: a.sessionToken });
    await expect(client`INSERT INTO identities (user_id, provider, subject) VALUES (${b.userId}, 'privy', ${subject})`).rejects.toThrow(
      /identities_provider_subject/,
    );
  });

  it("users table refuses an inconsistent claimed state (DB guard)", async () => {
    await expect(client`INSERT INTO users (age_ack_at, status) VALUES (now(), 'claimed')`).rejects.toThrow(/users_claimed_consistent/);
    await expect(client`INSERT INTO users (status) VALUES ('guest')`).rejects.toThrow(/age_ack_at/);
  });
});
