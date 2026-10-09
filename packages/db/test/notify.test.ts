import { FAREWELL, NOTIFY, TEMPLATES } from "@bp/core";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type NotificationSender,
  NotifyError,
  createCrew,
  createDb,
  createInvite,
  crewBotPostAllowed,
  ensureSystemAccounts,
  getPrefs,
  markOpened,
  maybeQueueDaily,
  notify,
  redeemInvite,
  runNotificationBatch,
  setCrewBotMutes,
  setDeputy,
  setPrefs,
  usualHour,
} from "../src";
import { makeResident, releaseTogether } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const H = 3_600_000;
const D = 24 * H;
let base = new Date("2029-03-05T12:00:00Z").getTime();
// Each test gets its own stretch of time, so queued rows from one never fall due in another.
const fresh = () => (base += 400 * D);

// A fake delivery channel: records what it was asked to send.
function recorder(result: (u: string) => "sent" | "no_channel" | "error" = () => "sent") {
  const out: Array<{ userId: string; text: string }> = [];
  const sender: NotificationSender = {
    send: async (userId, text) => {
      out.push({ userId, text });
      return result(userId);
    },
  };
  return { sender, out, to: (u: string) => out.filter((o) => o.userId === u).map((o) => o.text) };
}
const run = (s: NotificationSender, now: Date) => runNotificationBatch(db, s, { now, batch: 1000 });
const rows = (u: string) => client`SELECT * FROM notifications WHERE user_id = ${u} ORDER BY created_at, id`;

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof NotifyError) return e.code;
    throw e;
  }
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("preferences", () => {
  it("defaults, validated changes, and junk refused", async () => {
    const u = await makeResident(db);
    expect(await getPrefs(db, u)).toMatchObject({ timeZone: "UTC", quietStart: 23, quietEnd: 8, alerts: [], bell2h: false, pushOff: false });
    await setPrefs(db, u, { timeZone: "Africa/Lagos", alerts: ["snap", "faded", "snap"], bell2h: true });
    expect(await getPrefs(db, u)).toMatchObject({ timeZone: "Africa/Lagos", alerts: ["snap", "faded"], bell2h: true, quietStart: 23 });
    await setPrefs(db, u, { quietStart: 0 });
    expect((await getPrefs(db, u)).timeZone).toBe("Africa/Lagos"); // a partial change keeps the rest
    for (const bad of [
      { timeZone: "Mars/Olympus" },
      { timeZone: "x".repeat(200) },
      { quietStart: 24 },
      { quietEnd: -1 },
      { quietEnd: 1.5 },
      { quietStart: "8" },
      { alerts: ["balance_low"] },
      { alerts: "snap" },
      { pushOff: "yes" },
    ])
      expect(await code(setPrefs(db, u, bad))).toBe("INVALID_INPUT");
  });
});

describe("queueing", () => {
  it("opt-in kinds go nowhere unless switched on; push off stops everything", async () => {
    const u = await makeResident(db);
    const now = new Date(fresh());
    expect(await notify(db, u, "snap", { handle: "x" }, { now })).toBeNull();
    expect(await notify(db, u, "bell_2h", {}, { now })).toBeNull();
    await setPrefs(db, u, { alerts: ["snap"], bell2h: true });
    expect(await notify(db, u, "snap", { handle: "x" }, { now })).not.toBeNull();
    expect(await notify(db, u, "bell_2h", {}, { now })).not.toBeNull();
    await setPrefs(db, u, { pushOff: true });
    expect(await notify(db, u, "daily", {}, { now })).toBeNull();
  });

  it("anything due in quiet hours waits until they end, in the resident's time zone", async () => {
    const u = await makeResident(db);
    await setPrefs(db, u, { timeZone: "Africa/Lagos" }); // UTC+1
    const t = fresh();
    const night = new Date(t + 11 * H); // 23:00 UTC = 00:00 Lagos
    const row = await notify(db, u, "daily", {}, { now: night });
    expect(row!.scheduledFor.toISOString()).toBe(new Date(t + 19 * H).toISOString()); // 08:00 Lagos
    const day = new Date(t); // 13:00 Lagos
    expect((await notify(db, u, "daily", {}, { now: day }))!.scheduledFor).toEqual(day);
  });
});

describe("sending", () => {
  it("sends due pings, never before they're due, and never twice", async () => {
    const u = await makeResident(db);
    const t = fresh();
    const { sender, to } = recorder();
    await notify(db, u, "daily", {}, { now: new Date(t + 11 * H) }); // deferred to 08:00 tomorrow
    await run(sender, new Date(t + 12 * H));
    expect(to(u)).toEqual([]);
    await run(sender, new Date(t + 20 * H));
    await run(sender, new Date(t + 20 * H));
    expect(to(u)).toHaveLength(1);
    expect(TEMPLATES.daily).toContain(to(u)[0]);
  });

  it("3 a day at most, by local day, all kinds together", async () => {
    const u = await makeResident(db);
    await setPrefs(db, u, { alerts: ["snap"] });
    const t = fresh();
    const { sender, to } = recorder();
    for (let i = 0; i < 5; i++) await notify(db, u, i % 2 ? "snap" : "daily", { handle: "frog" }, { now: new Date(t + i * 60_000) });
    await run(sender, new Date(t + 10 * 60_000));
    expect(to(u)).toHaveLength(NOTIFY.dailyCap);
    expect((await rows(u)).filter((r) => r.reason === "cap")).toHaveLength(2);
    // Tomorrow's allowance is fresh.
    await notify(db, u, "daily", {}, { now: new Date(t + D) });
    await run(sender, new Date(t + D));
    expect(to(u)).toHaveLength(4);
  });

  it("two dispatchers racing on one resident still respect the cap", async () => {
    const u = await makeResident(db);
    const t = fresh();
    const { sender, to } = recorder();
    for (let i = 0; i < 8; i++) await notify(db, u, "daily", {}, { now: new Date(t) });
    const res = await releaseTogether(client, "SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE", [u], 2, [() => run(sender, new Date(t + 60_000)), () => run(sender, new Date(t + 60_000))]);
    expect(res.every((r) => r.ok)).toBe(true);
    expect(to(u)).toHaveLength(NOTIFY.dailyCap);
    expect((await rows(u)).filter((r) => r.status === "queued")).toHaveLength(0);
  });

  it("a ping deferred for too long is dropped, not sent late", async () => {
    const u = await makeResident(db);
    const t = fresh();
    const { sender, to } = recorder();
    await notify(db, u, "daily", {}, { now: new Date(t) });
    await run(sender, new Date(t + (NOTIFY.staleAfterHours + 1) * H));
    expect(to(u)).toEqual([]);
    expect((await rows(u))[0]).toMatchObject({ status: "suppressed", reason: "stale" });
  });

  it("a long quiet window doesn't make the deferred ping stale", async () => {
    const u = await makeResident(db);
    await setPrefs(db, u, { quietStart: 18, quietEnd: 10 }); // 16 hours of quiet
    const t = fresh(); // 12:00 UTC
    const { sender, to } = recorder();
    await notify(db, u, "daily", {}, { now: new Date(t + 6 * H) }); // 18:00, waits until 10:00
    await run(sender, new Date(t + 22 * H));
    expect(to(u)).toHaveLength(1);
  });

  it("quiet hours are re-checked at send time (prefs changed after queueing)", async () => {
    const u = await makeResident(db);
    const t = fresh();
    const { sender, to } = recorder();
    await notify(db, u, "daily", {}, { now: new Date(t) }); // 12:00 UTC, not quiet
    await setPrefs(db, u, { timeZone: "Asia/Tokyo" }); // 12:00 UTC = 21:00 Tokyo
    await setPrefs(db, u, { quietStart: 20, quietEnd: 7 });
    expect(await run(sender, new Date(t))).toMatchObject({ deferred: 1 });
    expect(to(u)).toEqual([]);
    expect(new Date((await rows(u))[0]!.scheduled_for).toISOString()).toBe(new Date(t + 10 * H).toISOString()); // 07:00 Tokyo
    await run(sender, new Date(t + 10 * H));
    expect(to(u)).toHaveLength(1);
  });

  it("push off after queueing: nothing goes out", async () => {
    const u = await makeResident(db);
    const t = fresh();
    const { sender, to } = recorder();
    await notify(db, u, "daily", {}, { now: new Date(t) });
    await setPrefs(db, u, { pushOff: true });
    await run(sender, new Date(t));
    expect(to(u)).toEqual([]);
    expect((await rows(u))[0]).toMatchObject({ status: "suppressed", reason: "push_off" });
  });

  it("the same wording never twice in 5 days", async () => {
    const u = await makeResident(db);
    const t = fresh();
    const { sender, to } = recorder();
    for (let d = 0; d < 5; d++) {
      for (let i = 0; i < 2; i++) await notify(db, u, "daily", {}, { now: new Date(t + d * D + i * H) });
      await run(sender, new Date(t + d * D + 2 * H));
      // Open them, so weekly mode stays out of it.
      for (const r of await rows(u)) if (r.status === "sent") await markOpened(db, u, r.id, { now: new Date(t + d * D + 3 * H) });
    }
    expect(to(u)).toHaveLength(10);
    expect(new Set(to(u)).size).toBe(10);
  });

  it("no channel and failed sends: retried with backoff, then given up after 3", async () => {
    const u = await makeResident(db);
    const v = await makeResident(db);
    const t = fresh();
    const { sender, to } = recorder((id) => (id === u ? "error" : "no_channel"));
    await notify(db, u, "daily", {}, { now: new Date(t) });
    await notify(db, v, "daily", {}, { now: new Date(t) });
    await run(sender, new Date(t));
    expect((await rows(v))[0]).toMatchObject({ status: "suppressed", reason: "no_channel" });
    expect((await rows(u))[0]).toMatchObject({ status: "queued", attempts: 1 });
    await run(sender, new Date(t + 60_000)); // backing off: not yet
    expect(to(u)).toHaveLength(1);
    await run(sender, new Date(t + 5 * 60_000));
    await run(sender, new Date(t + 15 * 60_000));
    expect(to(u)).toHaveLength(3);
    expect((await rows(u))[0]).toMatchObject({ status: "failed", attempts: 3 });
    await run(sender, new Date(t + H));
    expect(to(u)).toHaveLength(3);
  });

  it("values can't smuggle money talk or FOMO into a push", async () => {
    const u = await makeResident(db);
    await setPrefs(db, u, { alerts: ["snap"] });
    const t = fresh();
    const { sender, to } = recorder();
    await notify(db, u, "snap", { handle: "buy_now" }, { now: new Date(t) });
    await notify(db, u, "snap", { handle: "usdc-drop" }, { now: new Date(t) });
    await run(sender, new Date(t));
    expect(to(u)).toEqual([]);
    expect((await rows(u)).map((r) => r.reason)).toEqual(["unsafe_text", "unsafe_text"]);
  });

  it("wording with a blank in it is never sent: other wording, or nothing", async () => {
    const u = await makeResident(db);
    await setPrefs(db, u, { alerts: ["faded"] });
    const t = fresh();
    const { sender, to } = recorder();
    await notify(db, u, "faded", {}, { now: new Date(t) });
    for (let i = 0; i < 3; i++) await notify(db, u, "daily", {}, { now: new Date(t) }); // no streak given
    await run(sender, new Date(t));
    expect((await rows(u)).find((r) => r.kind === "faded")).toMatchObject({ status: "suppressed", reason: "missing_values" });
    expect(to(u)).toHaveLength(3);
    for (const x of to(u)) expect(x).not.toMatch(/\{|Streak check/);
  });
});

describe("ignored pushes", () => {
  // Sends one ping a day for `days` days, none opened.
  async function ignore(u: string, t: number, days: number, s: NotificationSender) {
    for (let d = 0; d < days; d++) {
      await notify(db, u, "daily", {}, { now: new Date(t + d * D) });
      await run(s, new Date(t + d * D));
    }
  }

  it("after 7 ignored: one a week, the first with the farewell line, and only once", async () => {
    const u = await makeResident(db);
    const t = fresh();
    const { sender, to } = recorder();
    await ignore(u, t, 7, sender);
    expect(to(u)).toHaveLength(7);
    await ignore(u, t + 7 * D, 6, sender); // 7 ignored: days 7..12 are inside the week since the last
    expect(to(u)).toHaveLength(7);
    expect((await rows(u)).filter((r) => r.reason === "weekly")).toHaveLength(6);
    await ignore(u, t + 13 * D, 1, sender); // a week after the last
    expect(to(u)).toHaveLength(8);
    expect(to(u)[7]!.endsWith(FAREWELL)).toBe(true);
    await ignore(u, t + 14 * D, 6, sender);
    await ignore(u, t + 20 * D, 1, sender);
    expect(to(u)).toHaveLength(9);
    expect(to(u)[8]!.endsWith(FAREWELL)).toBe(false);
    expect(to(u).filter((x) => x.includes(FAREWELL))).toHaveLength(1);
  });

  it("opening one resets the count", async () => {
    const u = await makeResident(db);
    const t = fresh();
    const { sender, to } = recorder();
    await ignore(u, t, 7, sender);
    const [last] = await client`SELECT id FROM notifications WHERE user_id = ${u} AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`;
    await markOpened(db, u, last!.id, { now: new Date(t + 6 * D + H) });
    await ignore(u, t + 7 * D, 3, sender);
    expect(to(u)).toHaveLength(10);
  });

  it("pushes less than a day old don't count as ignored yet", async () => {
    const u = await makeResident(db);
    const t = fresh();
    const { sender, to } = recorder();
    // Three a day for three days: by day 3's last push, 8 are unopened but only 6 are a day old.
    for (let d = 0; d < 3; d++)
      for (let i = 0; i < 3; i++) {
        await notify(db, u, "daily", {}, { now: new Date(t + d * D + i * H) });
        await run(sender, new Date(t + d * D + i * H));
      }
    expect(to(u)).toHaveLength(9);
  });

  it("a push not yet sent can't be marked opened", async () => {
    const u = await makeResident(db);
    const t = fresh();
    const r = await notify(db, u, "daily", {}, { now: new Date(t) });
    await markOpened(db, u, r!.id);
    expect((await rows(u))[0]!.opened_at).toBeNull();
  });

  it("only the owner can mark a push opened; junk ids are ignored", async () => {
    const [u, v] = [await makeResident(db), await makeResident(db)];
    const t = fresh();
    const { sender } = recorder();
    await notify(db, u, "daily", {}, { now: new Date(t) });
    await run(sender, new Date(t));
    const [r] = await rows(u);
    await markOpened(db, v, r!.id);
    for (const junk of [null, 5, "x", "'; DROP TABLE notifications; --", "0".repeat(36)]) await markOpened(db, u, junk);
    expect((await rows(u))[0]!.opened_at).toBeNull();
    await markOpened(db, u, r!.id);
    expect((await rows(u))[0]!.opened_at).not.toBeNull();
  });
});

describe("the daily ping", () => {
  async function sessions(u: string, hoursUtc: number[], t: number) {
    for (const [i, h] of hoursUtc.entries()) {
      const s = new Date(t - (i + 1) * D + h * H - 12 * H);
      await client`INSERT INTO play_sessions (user_id, started_at, last_seen_at) VALUES (${u}, ${s.toISOString()}, ${s.toISOString()})`;
    }
  }

  it("usual hour: the median start hour in local time, 18:00 until there's enough to tell", async () => {
    const u = await makeResident(db);
    const t = fresh(); // 12:00 UTC
    expect(await usualHour(db, u, "UTC", new Date(t))).toBe(18);
    await sessions(u, [7, 7], t);
    expect(await usualHour(db, u, "UTC", new Date(t))).toBe(18); // two sessions aren't a habit
    await sessions(u, [9, 20, 7], t);
    expect(await usualHour(db, u, "UTC", new Date(t))).toBe(7);
    expect(await usualHour(db, u, "Africa/Lagos", new Date(t))).toBe(8);
    // Sessions older than 14 days don't count.
    expect(await usualHour(db, u, "UTC", new Date(t + 30 * D))).toBe(18);
  });

  it("queued only at the usual hour, only with a reason, once a day even when schedulers race", async () => {
    const u = await makeResident(db);
    const t = fresh() + 6 * H; // 18:00 UTC: the default usual hour
    const reason = { streakUnprotected: true, riding: false, streak: 4 };
    expect(await maybeQueueDaily(db, u, { streakUnprotected: false, riding: false }, { now: new Date(t) })).toBeNull();
    expect(await maybeQueueDaily(db, u, reason, { now: new Date(t - H) })).toBeNull();
    const res = await releaseTogether(client, "SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE", [u], 3, [1, 2, 3].map(() => () => maybeQueueDaily(db, u, reason, { now: new Date(t) })));
    expect(res.filter((r) => r.ok && r.v)).toHaveLength(1);
    expect(await maybeQueueDaily(db, u, reason, { now: new Date(t + 10 * 60_000) })).toBeNull();
    expect(await maybeQueueDaily(db, u, { streakUnprotected: false, riding: true }, { now: new Date(t + D) })).not.toBeNull();
    const { sender, to } = recorder();
    await run(sender, new Date(t));
    expect(to(u)).toHaveLength(1);
  });
});

describe("the crew group bot", () => {
  async function crew() {
    const lead = await makeResident(db);
    const [dep, mem] = [await makeResident(db), await makeResident(db)];
    const c = await createCrew(db, lead, { name: `Bot ${randomUUID().slice(0, 6)}` });
    for (const u of [dep, mem]) await redeemInvite(db, u, (await createInvite(db, lead)).code);
    await setDeputy(db, lead, dep, true);
    return { crewId: c.id, lead, dep, mem };
  }

  it("3 posts a day, one of each kind, even racing", async () => {
    const { crewId } = await crew();
    const kinds = ["syndicate_call", "bell_in_15", "crew_card", "syndicate_call", "bell_in_15"] as const;
    const res = await releaseTogether(client, "SELECT 1 FROM crews WHERE id = $1 FOR NO KEY UPDATE", [crewId], kinds.length, kinds.map((k) => () => crewBotPostAllowed(db, crewId, k, "2029-01-01")));
    expect(res.filter((r) => r.ok && r.v === true)).toHaveLength(3);
    expect(await crewBotPostAllowed(db, crewId, "crew_card", "2029-01-02")).toBe(true);
    expect(await code(crewBotPostAllowed(db, crewId, "pump" as never, "2029-01-02"))).toBe("INVALID_INPUT");
  });

  it("the lead and deputies mute post types; members can't", async () => {
    const { crewId, lead, dep, mem } = await crew();
    expect(await code(setCrewBotMutes(db, mem, ["crew_card"]))).toBe("NOT_ALLOWED");
    expect(await code(setCrewBotMutes(db, await makeResident(db), ["crew_card"]))).toBe("NOT_ALLOWED");
    expect(await code(setCrewBotMutes(db, lead, ["spam"]))).toBe("INVALID_INPUT");
    expect(await code(setCrewBotMutes(db, lead, "crew_card"))).toBe("INVALID_INPUT");
    await setCrewBotMutes(db, dep, ["crew_card", "crew_card"]);
    expect(await crewBotPostAllowed(db, crewId, "crew_card", "2029-02-01")).toBe(false);
    expect(await crewBotPostAllowed(db, crewId, "bell_in_15", "2029-02-01")).toBe(true);
    await setCrewBotMutes(db, lead, []);
    expect(await crewBotPostAllowed(db, crewId, "crew_card", "2029-02-01")).toBe(true);
  });
});
