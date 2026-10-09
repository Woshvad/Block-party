import { randomUUID } from "node:crypto";
import type { ModerationProvider } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SafetyError,
  activeRestrictions,
  allowNewDmThread,
  appealRestriction,
  blockUser,
  createDb,
  createGuest,
  decideAppeal,
  enqueueModeration,
  ensureSystemAccounts,
  fileReport,
  isBlockedEitherWay,
  isMuted,
  isRestricted,
  muteUser,
  openAppeals,
  openReports,
  reportSla,
  resolveReport,
  restrictUser,
  runModerationBatch,
  unblockUser,
  unmuteUser,
} from "../src";
import { makeResident } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const HOUR = 3_600_000;
const REASON = "Repeatedly asked other residents for their seed phrases in DMs.";

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof SafetyError) return e.code;
    throw e;
  }
}

async function staffer(role: "moderator" | "admin" = "moderator") {
  const u = await makeResident(db);
  await client`INSERT INTO staff (user_id, role) VALUES (${u}, ${role})`;
  return u;
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("block and mute", () => {
  it("a block works both ways and can be lifted by the blocker", async () => {
    const [a, b] = [await makeResident(db), await makeResident(db)];
    await blockUser(db, a, b);
    await blockUser(db, a, b); // idempotent
    expect(await isBlockedEitherWay(db, a, b)).toBe(true);
    expect(await isBlockedEitherWay(db, b, a)).toBe(true);
    await unblockUser(db, b, a); // b never blocked a: no effect
    expect(await isBlockedEitherWay(db, a, b)).toBe(true);
    await unblockUser(db, a, b);
    expect(await isBlockedEitherWay(db, a, b)).toBe(false);
  });

  it("refuses self, unknown and garbage targets", async () => {
    const a = await makeResident(db);
    expect(await code(blockUser(db, a, a))).toBe("NOT_SELF");
    for (const bad of [randomUUID(), "x", null, "'; DROP TABLE blocks;--"]) expect(await code(blockUser(db, a, bad))).toBe("NO_SUCH_USER");
  });

  it("mutes can expire", async () => {
    const [a, b] = [await makeResident(db), await makeResident(db)];
    const now = new Date();
    await muteUser(db, a, b, { hours: 1, now });
    expect(await isMuted(db, a, b, now)).toBe(true);
    expect(await isMuted(db, a, b, new Date(now.getTime() + 2 * HOUR))).toBe(false);
    expect(await isMuted(db, b, a, now)).toBe(false); // one-way
    for (const bad of [0, -1, NaN, "2", 24 * 366]) expect(await code(muteUser(db, a, b, { hours: bad }))).toBe("INVALID_INPUT");
    await muteUser(db, a, b);
    expect(await isMuted(db, a, b, new Date(now.getTime() + 1000 * HOUR))).toBe(true); // until unmuted
    await unmuteUser(db, a, b);
    expect(await isMuted(db, a, b, now)).toBe(false);
  });
});

describe("reports", () => {
  it("files with a 24-hour deadline; under-18 reports jump the queue", async () => {
    const [a, b, c] = [await makeResident(db), await makeResident(db), await makeResident(db)];
    const now = new Date();
    const spam = await fileReport(db, a, { target: b, reason: "spam" }, { now });
    expect(+spam.dueAt - +now).toBe(24 * HOUR);
    const minor = await fileReport(db, a, { target: c, reason: "under_18" }, { now: new Date(now.getTime() + 1000) });
    expect(minor.priority).toBe(true);
    const mod = await staffer();
    const queue = await openReports(db, mod);
    expect(queue.findIndex((r) => r.id === minor.id)).toBeLessThan(queue.findIndex((r) => r.id === spam.id));
  });

  it("the same open report twice is one report; a different reason is another", async () => {
    const [a, b] = [await makeResident(db), await makeResident(db)];
    const r1 = await fileReport(db, a, { target: b, reason: "scam" });
    const r2 = await fileReport(db, a, { target: b, reason: "scam" });
    expect(r2.id).toBe(r1.id);
    expect((await fileReport(db, a, { target: b, reason: "impersonation" })).id).not.toBe(r1.id);
  });

  it("10 identical reports racing make one", async () => {
    const [a, b] = [await makeResident(db), await makeResident(db)];
    const res = await Promise.all(Array.from({ length: 10 }, () => fileReport(db, a, { target: b, reason: "harassment" })));
    expect(new Set(res.map((r) => r.id)).size).toBe(1);
  });

  it("validates reason and target; nobody reports themself", async () => {
    const [a, b] = [await makeResident(db), await makeResident(db)];
    expect(await code(fileReport(db, a, { target: a, reason: "spam" }))).toBe("NOT_SELF");
    expect(await code(fileReport(db, a, { target: b, reason: "rude" }))).toBe("INVALID_INPUT");
    expect(await code(fileReport(db, a, { target: randomUUID(), reason: "spam" }))).toBe("NO_SUCH_USER");
  });

  it("caps reports at 20 a day per reporter", async () => {
    const a = await makeResident(db);
    const targets = await Promise.all(Array.from({ length: 21 }, () => createGuest(db, { ageAck: true }).then((g) => g.userId)));
    const now = new Date();
    const out = [];
    for (const t of targets) out.push(await code(fileReport(db, a, { target: t, reason: "spam" }, { now })));
    expect(out.filter((o) => o === "OK")).toHaveLength(20);
    expect(out.at(-1)).toBe("TOO_MANY_REPORTS");
  });

  it("keeps server-side evidence, capped and trimmed", async () => {
    const [a, b] = [await makeResident(db), await makeResident(db)];
    const evidence = Array.from({ length: 30 }, (_, i) => ({ at: new Date().toISOString(), authorId: b, text: `msg ${i} ${"x".repeat(3000)}` }));
    const r = await fileReport(db, a, { target: b, reason: "scam", evidence });
    expect(r.evidence).toHaveLength(20);
    expect(r.evidence[0]!.text).toMatch(/^msg 10 /);
    expect(r.evidence[0]!.text.length).toBe(2000);
  });
});

describe("staff, restrictions and appeals", () => {
  it("only staff see reports or restrict anyone", async () => {
    const [a, b] = [await makeResident(db), await makeResident(db)];
    expect(await code(openReports(db, a))).toBe("NOT_STAFF");
    expect(await code(restrictUser(db, a, { userId: b, kind: "suspended", reason: REASON }))).toBe("NOT_STAFF");
  });

  it("a restriction needs a written reason the player can read", async () => {
    const [mod, b] = [await staffer(), await makeResident(db)];
    expect(await code(restrictUser(db, mod, { userId: b, kind: "chat_mute", reason: "bad" }))).toBe("INVALID_INPUT");
    expect(await code(restrictUser(db, mod, { userId: b, kind: "ban", reason: REASON }))).toBe("INVALID_INPUT");
    await restrictUser(db, mod, { userId: b, kind: "chat_mute", hours: 24, reason: REASON });
    const mine = await activeRestrictions(db, b);
    expect(mine).toEqual([expect.objectContaining({ kind: "chat_mute", reason: REASON })]);
    expect(await isRestricted(db, b, "chat_mute")).toBe(true);
    expect(await isRestricted(db, b, "suspended")).toBe(false);
    expect(await isRestricted(db, b, "chat_mute", new Date(Date.now() + 25 * HOUR))).toBe(false);
  });

  it("a suspension also covers chat", async () => {
    const [mod, b] = [await staffer(), await makeResident(db)];
    await restrictUser(db, mod, { userId: b, kind: "suspended", reason: REASON });
    expect(await isRestricted(db, b, "chat_mute")).toBe(true);
  });

  it("resolving a report: dismiss or restrict, always with a note, once", async () => {
    const [a, b, mod] = [await makeResident(db), await makeResident(db), await staffer()];
    const r = await fileReport(db, a, { target: b, reason: "scam" });
    expect(await code(resolveReport(db, mod, r.id, { action: "dismiss", note: "ok" }))).toBe("INVALID_INPUT");
    expect(await code(resolveReport(db, mod, r.id, { action: "restrict", note: "Confirmed scam DMs." }))).toBe("INVALID_INPUT");
    const done = await resolveReport(db, mod, r.id, { action: "restrict", note: "Confirmed scam DMs.", restriction: { kind: "suspended", hours: 72, reason: REASON } });
    expect(done.report.status).toBe("actioned");
    expect(done.restriction!.reportId).toBe(r.id);
    expect(await code(resolveReport(db, mod, r.id, { action: "dismiss", note: "Changed my mind." }))).toBe("NO_SUCH_REPORT");
  });

  it("one appeal per restriction, decided by someone other than who restricted", async () => {
    const [mod, other, b] = [await staffer(), await staffer("admin"), await makeResident(db)];
    const r = await restrictUser(db, mod, { userId: b, kind: "suspended", reason: REASON });
    expect(await code(appealRestriction(db, b, r.id, "short"))).toBe("INVALID_INPUT");
    const a = await appealRestriction(db, b, r.id, "I was helping someone recover a lost wallet, not scamming.");
    expect(await code(appealRestriction(db, b, r.id, "Please look again at this one."))).toBe("ALREADY_APPEALED");
    expect(await code(appealRestriction(db, await makeResident(db), r.id, "Not my restriction at all."))).toBe("NO_SUCH_RESTRICTION");
    expect((await openAppeals(db, other)).map((x) => x.id)).toContain(a.id);
    expect(await code(decideAppeal(db, mod, a.id, { overturn: true, note: "My own mistake." }))).toBe("NOT_STAFF");
    expect(await decideAppeal(db, other, a.id, { overturn: true, note: "Context shows good faith." })).toEqual({ overturned: true });
    expect(await isRestricted(db, b, "suspended")).toBe(false);
    expect(await code(decideAppeal(db, other, a.id, { overturn: false, note: "Second thoughts here." }))).toBe("NO_SUCH_APPEAL");
  });

  it("the 24-hour report SLA", async () => {
    const [a, b, c, mod] = [await makeResident(db), await makeResident(db), await makeResident(db), await staffer()];
    const t0 = new Date("2030-01-01T00:00:00Z");
    const fast = await fileReport(db, a, { target: b, reason: "spam" }, { now: t0 });
    const slow = await fileReport(db, a, { target: c, reason: "spam" }, { now: t0 });
    await resolveReport(db, mod, fast.id, { action: "dismiss", note: "Not spam, just excited." }, { now: new Date(t0.getTime() + 2 * HOUR) });
    await resolveReport(db, mod, slow.id, { action: "dismiss", note: "Not spam, just late." }, { now: new Date(t0.getTime() + 30 * HOUR) });
    const sla = await reportSla(db, { from: t0, to: new Date(t0.getTime() + 1000), now: new Date(t0.getTime() + 40 * HOUR) });
    expect(sla).toEqual({ total: 2, onTime: 1, overdueOpen: 0, onTimeShare: 0.5 });
  });
});

describe("new-account DM limit", () => {
  it("5 new conversations a day for accounts under 7 days; none after", async () => {
    const u = await makeResident(db);
    const now = new Date();
    const out = [];
    for (let i = 0; i < 6; i++) out.push(await code(allowNewDmThread(db, u, { now })));
    expect(out).toEqual(["OK", "OK", "OK", "OK", "OK", "DM_LIMIT"]);
    const later = new Date(now.getTime() + 8 * 24 * HOUR);
    for (let i = 0; i < 10; i++) expect(await code(allowNewDmThread(db, u, { now: later }))).toBe("OK");
  });
});

describe("the AI moderation queue", () => {
  const provider = (fn: ModerationProvider["classify"]): ModerationProvider => ({ classify: fn });

  async function freshQueue() {
    // Clear earlier tests' pending items so each test sees its own batch.
    await client`UPDATE moderation_items SET status = 'clean' WHERE status = 'pending'`;
  }

  it("checks in batches, flags what the provider flags, hooks run after commit", async () => {
    await freshQueue();
    const u = await makeResident(db);
    const items = await Promise.all(["gm", "you are trash", "nice call"].map((t, i) => enqueueModeration(db, { kind: "chat", ref: `m${i}`, authorId: u, text: t })));
    const hooked: string[] = [];
    const out = await runModerationBatch(db, provider(async (ts) => ts.map((t) => ({ flagged: t.includes("trash"), categories: t.includes("trash") ? ["harassment"] : [] }))), {
      onFlagged: async (f) => {
        hooked.push(f.ref);
      },
    });
    expect(out).toEqual({ checked: 3, flagged: 1, failed: 0 });
    expect(hooked).toEqual(["m1"]);
    const rows = await client`SELECT status, categories FROM moderation_items WHERE id IN ${client(items.map((i) => i.id))} ORDER BY ref`;
    expect(rows.map((r) => r.status)).toEqual(["clean", "flagged", "clean"]);
  });

  it("a failing provider never marks anything clean; 5 failures go to staff as errors", async () => {
    await freshQueue();
    const it1 = await enqueueModeration(db, { kind: "pitch", ref: "p1", authorId: null, text: "vote for me" });
    const down = provider(async () => {
      throw new Error("down");
    });
    for (let i = 0; i < 4; i++) expect(await runModerationBatch(db, down)).toEqual({ checked: 0, flagged: 0, failed: 1 });
    expect((await client`SELECT status, attempts FROM moderation_items WHERE id = ${it1.id}`)[0]).toMatchObject({ status: "pending", attempts: 4 });
    await runModerationBatch(db, down);
    expect((await client`SELECT status FROM moderation_items WHERE id = ${it1.id}`)[0]!.status).toBe("error");
  });

  it("a provider returning the wrong number of results counts as a failure", async () => {
    await freshQueue();
    await enqueueModeration(db, { kind: "chat", ref: "x1", authorId: null, text: "a" });
    await enqueueModeration(db, { kind: "chat", ref: "x2", authorId: null, text: "b" });
    expect(await runModerationBatch(db, provider(async () => [{ flagged: false, categories: [] }]))).toMatchObject({ failed: 2 });
  });

  it("two workers run side by side (SKIP LOCKED) and never check the same item", async () => {
    await freshQueue();
    for (let i = 0; i < 40; i++) await enqueueModeration(db, { kind: "chat", ref: `w${i}`, authorId: null, text: `t${i}` });
    const seen: string[] = [];
    // Both workers must be inside the provider at the same moment. If the
    // second were stuck behind the first's row locks, this times out.
    let arrived = 0;
    let release!: () => void;
    const together = new Promise<void>((r) => (release = r));
    const meet = provider(async (ts) => {
      seen.push(...ts);
      if (++arrived === 2) release();
      await Promise.race([together, new Promise((_, rej) => setTimeout(() => rej(new Error("workers did not overlap")), 3000))]);
      return ts.map(() => ({ flagged: false, categories: [] }));
    });
    const [a, b] = await Promise.all([runModerationBatch(db, meet, { batchSize: 20 }), runModerationBatch(db, meet, { batchSize: 20 })]);
    expect([a.checked, b.checked]).toEqual([20, 20]);
    expect(new Set(seen).size).toBe(40);
  });
});

describe("database guards", () => {
  it("restrictions need a 20+ character reason; reports can't be closed without a note", async () => {
    const [mod, b] = [await staffer(), await makeResident(db)];
    await expect(client`INSERT INTO restrictions (user_id, kind, reason, starts_at, created_by) VALUES (${b}, 'suspended', 'too short', now(), ${mod})`).rejects.toThrow(/restrictions_reason/);
    const a = await makeResident(db);
    const r = await fileReport(db, a, { target: b, reason: "spam" });
    await expect(client`UPDATE reports SET status = 'dismissed', resolved_at = now(), resolution = 'meh' WHERE id = ${r.id}`).rejects.toThrow(/reports_resolution_text/);
    await expect(client`INSERT INTO blocks (blocker_id, blocked_id) VALUES (${a}, ${a})`).rejects.toThrow(/blocks_not_self/);
  });
});
