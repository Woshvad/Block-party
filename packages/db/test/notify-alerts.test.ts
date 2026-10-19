import { DAILY_TOPIC_TEMPLATES, NOTIFY, SHIFT, TEMPLATES, cityDay, render } from "@bp/core";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type NotificationSender,
  collectAwayShift,
  collectMakeGood,
  collectShift,
  createDb,
  createMakeGood,
  ensureSystemAccounts,
  markOpened,
  notify,
  queueAwayShiftPings,
  queueBellPings,
  queueDailyPings,
  queueShiftPings,
  runNotificationBatch,
  sayGm,
  searchHere,
  setPrefs,
  startShift,
  takeRide,
  todaysHunt,
  touchActivity,
  whereabouts,
} from "../src";
import { makeResident, raceAt } from "./helpers";

// The alerts the cron raises (a Mod Shift done, an away shift ready, the bell
// in 2 hours) and what the daily ping mentions (a make-good, today's clue).

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
// Each test gets a month of its own, starting at a bell, long after anything
// else in the shared database: make-goods and hunt days are city-wide, and a
// batch run sends whatever is due.
let base = Date.UTC(2090, 0, 1);
const fresh = () => (base += 30 * D);

function recorder() {
  const out: Array<{ userId: string; text: string }> = [];
  const sender: NotificationSender = {
    send: async (userId, text) => {
      out.push({ userId, text });
      return "sent";
    },
  };
  return { sender, to: (u: string) => out.filter((o) => o.userId === u).map((o) => o.text) };
}
const run = (s: NotificationSender, at: number) => runNotificationBatch(db, s, { now: new Date(at), batch: 1000 });
const alerts = (u: string, kind: string) => client`SELECT * FROM notifications WHERE user_id = ${u} AND kind = ${kind} ORDER BY created_at, id`;

async function residentWith(prefs: Record<string, unknown>) {
  const u = await makeResident(db);
  await setPrefs(db, u, prefs);
  return u;
}

// Pushes as [when, text]: no wording comes back within 5 days of its last use.
function noRepeatWithin5Days(sent: Array<[number, string]>) {
  for (const [i, [at, text]] of sent.entries())
    for (const [before, was] of sent.slice(0, i)) if (was === text) expect(at - before, text).toBeGreaterThan(NOTIFY.noRepeatDays * D);
}

// Three pushes already out today, so the cap is reached.
async function capped(u: string, at: number) {
  for (let i = 0; i < NOTIFY.dailyCap; i++) await notify(db, u, "daily", {}, { now: new Date(at + i * MIN) });
  await run(recorder().sender, at + NOTIFY.dailyCap * MIN);
  expect((await alerts(u, "daily")).filter((r) => r.status === "sent")).toHaveLength(NOTIFY.dailyCap);
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("a Mod Shift is done", () => {
  it("fires once when the shift's time is up, however many crons overlap, and once for each shift", async () => {
    const t = fresh() + 12 * H;
    const u = await residentWith({ alerts: ["shift_done"] });
    const first = await startShift(db, u, { now: new Date(t), seed: 1 });
    await queueShiftPings(db, { now: new Date(t + 14 * MIN) }); // still running
    expect(await alerts(u, "shift_done")).toHaveLength(0);

    const done = t + SHIFT.minutes * MIN + 30_000;
    const res = await raceAt(client, "notifications", 3, [1, 2, 3].map(() => () => queueShiftPings(db, { now: new Date(done) })));
    expect(res.every((r) => r.ok)).toBe(true);
    await queueShiftPings(db, { now: new Date(done + MIN) }); // the next minute's cron
    expect((await alerts(u, "shift_done")).map((r) => r.ref)).toEqual([first.shiftId]);
    const { sender, to } = recorder();
    await run(sender, done + MIN);
    expect(to(u)).toHaveLength(1);
    expect(TEMPLATES.shift_done).toContain(to(u)[0]);

    // The day's second shift is an event of its own, in other words.
    const second = await startShift(db, u, { now: new Date(t + 30 * MIN), seed: 2 });
    await queueShiftPings(db, { now: new Date(t + 46 * MIN) });
    await run(sender, t + 46 * MIN);
    expect((await alerts(u, "shift_done")).map((r) => r.ref)).toEqual([first.shiftId, second.shiftId]);
    expect(to(u)).toHaveLength(2);
    expect(to(u)[1]).not.toBe(to(u)[0]);
  });

  it("reaches only residents who switched it on, never anyone with push off", async () => {
    const t = fresh() + 12 * H;
    const off = await residentWith({});
    const others = await residentWith({ alerts: ["nap_done", "snap"] });
    const muted = await residentWith({ alerts: ["shift_done"], pushOff: true });
    const on = await residentWith({ alerts: ["shift_done"] });
    for (const u of [off, others, muted, on]) await startShift(db, u, { now: new Date(t) });
    await queueShiftPings(db, { now: new Date(t + 16 * MIN) });
    for (const u of [off, others, muted]) expect(await alerts(u, "shift_done")).toHaveLength(0);
    expect(await alerts(on, "shift_done")).toHaveLength(1);
  });

  it("never mentions a shift already collected, whether before the cron saw it or before the push went out", async () => {
    const t = fresh() + 12 * H;
    const quick = await residentWith({ alerts: ["shift_done"] });
    const later = await residentWith({ alerts: ["shift_done"] });
    const a = await startShift(db, quick, { now: new Date(t) });
    const b = await startShift(db, later, { now: new Date(t) });
    const end = t + SHIFT.minutes * MIN;
    await collectShift(db, quick, a.shiftId, { now: new Date(end + 10_000) }); // on the spot
    await queueShiftPings(db, { now: new Date(end + 30_000) });
    expect(await alerts(quick, "shift_done")).toHaveLength(0);
    expect(await alerts(later, "shift_done")).toHaveLength(1);

    await collectShift(db, later, b.shiftId, { now: new Date(end + 40_000) }); // queued, not sent yet
    const { sender, to } = recorder();
    await run(sender, end + MIN);
    expect(to(later)).toEqual([]);
    expect((await alerts(later, "shift_done"))[0]).toMatchObject({ status: "suppressed", reason: "done" });
  });

  it("waits out quiet hours, and goes nowhere if it's collected or switched off meanwhile", async () => {
    const t = fresh();
    const [sleeper, early, changed] = [await residentWith({ alerts: ["shift_done"] }), await residentWith({ alerts: ["shift_done"] }), await residentWith({ alerts: ["shift_done"] })];
    const night = t + 22 * H + 50 * MIN; // ends at 23:05 UTC, inside quiet hours
    const shiftOf = new Map<string, string>();
    for (const u of [sleeper, early, changed]) shiftOf.set(u, (await startShift(db, u, { now: new Date(night) })).shiftId);
    await queueShiftPings(db, { now: new Date(night + 16 * MIN) });
    const { sender, to } = recorder();
    await run(sender, night + 16 * MIN);
    expect(to(sleeper)).toEqual([]);
    expect(new Date((await alerts(sleeper, "shift_done"))[0]!.scheduled_for).toISOString()).toBe(new Date(t + D + 8 * H).toISOString());

    await collectShift(db, early, shiftOf.get(early)!, { now: new Date(t + D + 7 * H) }); // up before the push
    await setPrefs(db, changed, { alerts: ["nap_done"] });
    await run(sender, t + D + 8 * H);
    expect(to(sleeper)).toHaveLength(1);
    expect(to(early)).toEqual([]);
    expect(to(changed)).toEqual([]);
    expect((await alerts(early, "shift_done"))[0]).toMatchObject({ status: "suppressed", reason: "done" });
    expect((await alerts(changed, "shift_done"))[0]).toMatchObject({ status: "suppressed", reason: "switched_off" });
  });

  it("both shifts a day for a week, never the same words twice in 5 days", async () => {
    const t = fresh();
    const u = await residentWith({ alerts: ["shift_done"] });
    const { sender, to } = recorder();
    const sent: Array<[number, string]> = [];
    for (let d = 0; d < 7; d++)
      for (const start of [12 * H, 13 * H]) {
        await startShift(db, u, { now: new Date(t + d * D + start) });
        const done = t + d * D + start + SHIFT.minutes * MIN;
        await queueShiftPings(db, { now: new Date(done) });
        await run(sender, done);
        sent.push([done, to(u).at(-1)!]);
        // Opened, so a week of them isn't a run of ignored pushes.
        for (const r of await alerts(u, "shift_done")) if (r.status === "sent" && !r.opened_at) await markOpened(db, u, r.id, { now: new Date(done) });
      }
    expect(to(u)).toHaveLength(14);
    noRepeatWithin5Days(sent);
  });

  it("counts toward the 3 a day, and a shift whose ping was missed for an hour gets none", async () => {
    const t = fresh() + 12 * H;
    const u = await residentWith({ alerts: ["shift_done"] });
    await capped(u, t - 3 * H);
    await startShift(db, u, { now: new Date(t) });
    await queueShiftPings(db, { now: new Date(t + 16 * MIN) });
    const { sender, to } = recorder();
    await run(sender, t + 16 * MIN);
    expect(to(u)).toEqual([]);
    expect((await alerts(u, "shift_done"))[0]).toMatchObject({ status: "suppressed", reason: "cap" });

    const v = await residentWith({ alerts: ["shift_done"] });
    await startShift(db, v, { now: new Date(t) });
    await queueShiftPings(db, { now: new Date(t + (SHIFT.minutes + NOTIFY.shiftPingWithinMinutes + 1) * MIN) });
    expect(await alerts(v, "shift_done")).toHaveLength(0);
  });
});

describe("an away shift is ready", () => {
  async function neighbour(prefs: Record<string, unknown> = { alerts: ["away_shift_ready"] }) {
    const u = await residentWith(prefs);
    await client`UPDATE users SET proof_of_neighbour_at = now() WHERE id = ${u}`;
    return u;
  }
  // Played and said gm at that moment (and not since).
  async function gmAt(u: string, at: number) {
    await touchActivity(db, u, { now: new Date(at) });
    await sayGm(db, u, { now: new Date(at) });
  }

  it("fires once, at the bell after a gm, for a proven neighbour who hasn't been back", async () => {
    const t = fresh(); // a bell
    const u = await neighbour();
    await gmAt(u, t - 4 * H); // 20:00 the day before
    const res = await raceAt(client, "notifications", 3, [1, 2, 3].map(() => () => queueAwayShiftPings(db, { now: new Date(t + 15 * MIN) })));
    expect(res.every((r) => r.ok)).toBe(true);
    await queueAwayShiftPings(db, { now: new Date(t + 30 * MIN) });
    const rows = await alerts(u, "away_shift_ready");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ref: cityDay(new Date(t)) });
    expect(new Date(rows[0]!.expires_at).getTime()).toBe(t + 20 * H); // a day after the gm
    const { sender, to } = recorder();
    await run(sender, t + 8 * H); // quiet hours are over
    expect(to(u)).toHaveLength(1);
    expect(TEMPLATES.away_shift_ready).toContain(to(u)[0]);
    // No gm today: tomorrow there's no away shift to mention.
    await queueAwayShiftPings(db, { now: new Date(t + D + 15 * MIN) });
    expect(await alerts(u, "away_shift_ready")).toHaveLength(1);
  });

  it("only proven neighbours who switched it on, never anyone with push off", async () => {
    const t = fresh();
    const off = await neighbour({});
    const unproven = await residentWith({ alerts: ["away_shift_ready"] });
    const muted = await neighbour({ alerts: ["away_shift_ready"], pushOff: true });
    const on = await neighbour();
    for (const u of [off, unproven, muted, on]) await gmAt(u, t - 4 * H);
    await queueAwayShiftPings(db, { now: new Date(t + 15 * MIN) });
    for (const u of [off, unproven, muted]) expect(await alerts(u, "away_shift_ready")).toHaveLength(0);
    expect(await alerts(on, "away_shift_ready")).toHaveLength(1);
  });

  it("not for anyone who's been in since the bell, has taken it, or has no slot left", async () => {
    const t = fresh();
    const [back, took, busy, due] = [await neighbour(), await neighbour(), await neighbour(), await neighbour()];
    for (const u of [back, took, busy, due]) await gmAt(u, t - 4 * H);
    await touchActivity(db, back, { now: new Date(t + 5 * MIN) }); // dropped in after the bell
    // Taken, and both slots used, in the database alone (no session recorded),
    // so only the away shift's own rules can stop the ping.
    await collectAwayShift(db, took, { now: new Date(t + 5 * MIN) });
    await startShift(db, busy, { now: new Date(t + MIN) });
    await startShift(db, busy, { now: new Date(t + 20 * MIN) });
    await queueAwayShiftPings(db, { now: new Date(t + 45 * MIN) });
    for (const u of [back, took, busy]) expect(await alerts(u, "away_shift_ready")).toHaveLength(0);
    expect(await alerts(due, "away_shift_ready")).toHaveLength(1);
  });

  it("not on the bell's own tick: whoever is watching the bell isn't told they were out", async () => {
    const t = fresh(); // a bell, and the cron's tick at that very second
    const [watching, out] = [await neighbour(), await neighbour()];
    for (const u of [watching, out]) await gmAt(u, t - 9 * H); // 15:00 the day before
    await touchActivity(db, watching, { now: new Date(t - 20_000) }); // in the city, last heard from at 23:59:40
    expect(await queueAwayShiftPings(db, { now: new Date(t) })).toEqual({ checked: 0, queued: 0 });
    for (const u of [watching, out]) expect(await alerts(u, "away_shift_ready")).toHaveLength(0);
    await touchActivity(db, watching, { now: new Date(t + 40_000) }); // still there: the next write, a minute on
    await queueAwayShiftPings(db, { now: new Date(t + NOTIFY.awayPingAfterMinutes * MIN) });
    expect(await alerts(watching, "away_shift_ready")).toHaveLength(0);
    expect(await alerts(out, "away_shift_ready")).toHaveLength(1);
  });

  it("dropped as it goes out if they've been in since the bell while quiet hours held it", async () => {
    const t = fresh();
    const lagos = { alerts: ["away_shift_ready"], timeZone: "Africa/Lagos" }; // UTC+1, quiet until 07:00 UTC
    const [early, asleep] = [await neighbour(lagos), await neighbour(lagos)];
    for (const u of [early, asleep]) await gmAt(u, t - 4 * H);
    await queueAwayShiftPings(db, { now: new Date(t + 15 * MIN) }); // 01:15 there: held until 08:00
    for (const u of [early, asleep]) expect(await alerts(u, "away_shift_ready")).toHaveLength(1);
    await touchActivity(db, early, { now: new Date(t + 6 * H) }); // opened the city at 07:00 there, didn't collect
    const { sender, to } = recorder();
    await run(sender, t + 7 * H);
    expect(to(early)).toEqual([]);
    expect((await alerts(early, "away_shift_ready"))[0]).toMatchObject({ status: "suppressed", reason: "done" });
    expect(to(asleep)).toHaveLength(1);
  });

  it("never sent once it's taken or out of reach, and not queued if quiet hours outlast it", async () => {
    const t = fresh();
    const [taker, lapsed, early] = [await neighbour(), await neighbour(), await neighbour()];
    await gmAt(taker, t - 4 * H); // reachable until 20:00
    await gmAt(lapsed, t - 15 * H); // until 09:00: queued for 08:00, but the dispatcher is late
    await gmAt(early, t - 18 * H); // until 06:00, before quiet hours end
    await queueAwayShiftPings(db, { now: new Date(t + 15 * MIN) });
    expect(await alerts(taker, "away_shift_ready")).toHaveLength(1);
    expect(await alerts(lapsed, "away_shift_ready")).toHaveLength(1);
    expect(await alerts(early, "away_shift_ready")).toHaveLength(0);

    await collectAwayShift(db, taker, { now: new Date(t + 7 * H) });
    const { sender, to } = recorder();
    await run(sender, t + 9 * H + 30 * MIN);
    expect(to(taker)).toEqual([]);
    expect(to(lapsed)).toEqual([]);
    expect((await alerts(taker, "away_shift_ready"))[0]).toMatchObject({ status: "suppressed", reason: "done" });
    expect((await alerts(lapsed, "away_shift_ready"))[0]).toMatchObject({ status: "suppressed", reason: "expired" });
  });

  it("every day for a week, never the same words twice in 5 days", async () => {
    const t = fresh();
    const u = await neighbour();
    const { sender, to } = recorder();
    const sent: Array<[number, string]> = [];
    for (let d = 0; d < 7; d++) {
      const bell = t + d * D;
      await gmAt(u, bell - 4 * H);
      await queueAwayShiftPings(db, { now: new Date(bell + 15 * MIN) });
      await run(sender, bell + 8 * H);
      sent.push([bell + 8 * H, to(u).at(-1)!]);
    }
    expect(to(u)).toHaveLength(7);
    noRepeatWithin5Days(sent);
  });

  it("counts toward the 3 a day", async () => {
    const t = fresh();
    const u = await neighbour({ alerts: ["away_shift_ready"], quietStart: 0, quietEnd: 0 }); // no quiet hours
    await gmAt(u, t - 4 * H);
    for (let i = 0; i < NOTIFY.dailyCap; i++) await notify(db, u, "daily", {}, { now: new Date(t + i * MIN) });
    const { sender, to } = recorder();
    await run(sender, t + 5 * MIN);
    await queueAwayShiftPings(db, { now: new Date(t + 15 * MIN) });
    await run(sender, t + 15 * MIN);
    expect(to(u)).toHaveLength(NOTIFY.dailyCap);
    expect((await alerts(u, "away_shift_ready"))[0]).toMatchObject({ status: "suppressed", reason: "cap" });
  });
});

describe("the bell in 2 hours", () => {
  it("queued from two hours before the bell, once a night, for those who switched it on", async () => {
    const t = fresh();
    const on = await residentWith({ bell2h: true });
    const off = await residentWith({});
    const muted = await residentWith({ bell2h: true, pushOff: true });
    const alertsOnly = await residentWith({ alerts: ["shift_done", "nap_done"] });
    await queueBellPings(db, { now: new Date(t + 21 * H + 45 * MIN) }); // not yet
    expect(await alerts(on, "bell_2h")).toHaveLength(0);

    const ten = t + 22 * H;
    const res = await raceAt(client, "notifications", 3, [1, 2, 3].map(() => () => queueBellPings(db, { now: new Date(ten) })));
    expect(res.every((r) => r.ok)).toBe(true);
    await queueBellPings(db, { now: new Date(ten + 15 * MIN) }); // the next tick
    expect((await alerts(on, "bell_2h")).map((r) => r.ref)).toEqual([cityDay(new Date(ten))]);
    for (const u of [off, muted, alertsOnly]) expect(await alerts(u, "bell_2h")).toHaveLength(0);
    const { sender, to } = recorder();
    await run(sender, ten);
    expect(to(on)).toHaveLength(1);
    expect(TEMPLATES.bell_2h).toContain(to(on)[0]);

    // Tomorrow night's bell is another.
    await queueBellPings(db, { now: new Date(ten + D) });
    await run(sender, ten + D);
    expect(to(on)).toHaveLength(2);
    expect(to(on)[1]).not.toBe(to(on)[0]);
  });

  it("never late: not queued if quiet hours would hold it, dropped if it can't go out within half an hour", async () => {
    const t = fresh();
    const tokyo = await residentWith({ bell2h: true, timeZone: "Asia/Tokyo" }); // 22:00 UTC is 07:00 there, still quiet
    const ny = await residentWith({ bell2h: true, timeZone: "America/New_York" }); // 18:00 there
    const slow = await residentWith({ bell2h: true });
    await queueBellPings(db, { now: new Date(t + 22 * H) });
    expect(await alerts(tokyo, "bell_2h")).toHaveLength(0);
    expect(await alerts(ny, "bell_2h")).toHaveLength(1);
    expect(await alerts(slow, "bell_2h")).toHaveLength(1);

    const { sender, to } = recorder();
    await run(sender, t + 22 * H + 31 * MIN); // the dispatcher only gets there at 22:31
    expect(to(ny)).toEqual([]);
    expect(to(slow)).toEqual([]);
    expect((await alerts(slow, "bell_2h"))[0]).toMatchObject({ status: "suppressed", reason: "expired" });

    // Outside those two hours before the bell, nothing at all.
    for (const at of [t + D + 22 * H + 30 * MIN, t + D + 12 * H, t + D + 23 * H + 59 * MIN]) expect(await queueBellPings(db, { now: new Date(at) })).toEqual({ checked: 0, queued: 0 });
    expect(await alerts(slow, "bell_2h")).toHaveLength(1);
  });

  it("every night for a week, never the same words twice in 5 days", async () => {
    const t = fresh();
    const u = await residentWith({ bell2h: true });
    const { sender, to } = recorder();
    const sent: Array<[number, string]> = [];
    for (let d = 0; d < 7; d++) {
      const ten = t + d * D + 22 * H;
      await queueBellPings(db, { now: new Date(ten) });
      await run(sender, ten);
      sent.push([ten, to(u).at(-1)!]);
    }
    expect(to(u)).toHaveLength(7);
    noRepeatWithin5Days(sent);
  });

  it("counts toward the 3 a day, and goes nowhere once switched off", async () => {
    const t = fresh();
    const full = await residentWith({ bell2h: true });
    const changed = await residentWith({ bell2h: true });
    await capped(full, t + 20 * H);
    await queueBellPings(db, { now: new Date(t + 22 * H) });
    await setPrefs(db, changed, { bell2h: false });
    const { sender, to } = recorder();
    await run(sender, t + 22 * H + MIN);
    expect(to(full)).toEqual([]);
    expect(to(changed)).toEqual([]);
    expect((await alerts(full, "bell_2h"))[0]).toMatchObject({ status: "suppressed", reason: "cap" });
    expect((await alerts(changed, "bell_2h"))[0]).toMatchObject({ status: "suppressed", reason: "switched_off" });
  });
});

describe("what the daily ping mentions", () => {
  const SORRY = "The city's sorry about the outage.";
  async function makeGood(at: number, amount = 50) {
    const staff = await makeResident(db);
    await client`INSERT INTO staff (user_id, role) VALUES (${staff}, 'moderator')`;
    return createMakeGood(db, staff, { reason: SORRY, amount }, { now: new Date(at) });
  }
  // One search today, wherever the hunt is hiding.
  async function searchToday(u: string, at: number) {
    const now = new Date(at);
    await todaysHunt(db, u, { now });
    const here = await whereabouts(db, u, { now });
    if (!(here.arrived && here.area === "diner")) await takeRide(db, u, { to: "diner", mode: "walk", idempotencyKey: randomUUID() }, { now: new Date(at - MIN) });
    return searchHere(db, u, { now });
  }

  it("a make-good they can still collect, worked out as it goes out, then today's clue", async () => {
    const t = fresh() + 12 * H;
    const mg = await makeGood(t - H);
    const u = await makeResident(db);
    const { sender, to } = recorder();
    await notify(db, u, "daily", { streak: 4 }, { now: new Date(t) });
    await run(sender, t);
    expect(DAILY_TOPIC_TEMPLATES.make_good).toContain(to(u)[0]);

    // Collected after the ping was queued but before it went out: not mentioned.
    await notify(db, u, "daily", { streak: 5 }, { now: new Date(t + D) });
    await collectMakeGood(db, u, mg.id, randomUUID(), { now: new Date(t + D) });
    await run(sender, t + D);
    expect(DAILY_TOPIC_TEMPLATES.clue).toContain(to(u)[1]);
  });

  it("today's clue until they've searched, then the usual lines", async () => {
    const t = fresh() + 12 * H;
    const u = await makeResident(db);
    const { sender, to } = recorder();
    await notify(db, u, "daily", { streak: 4 }, { now: new Date(t) });
    await run(sender, t);
    expect(DAILY_TOPIC_TEMPLATES.clue).toContain(to(u)[0]);

    await notify(db, u, "daily", { streak: 5 }, { now: new Date(t + D) });
    await searchToday(u, t + D - H);
    await run(sender, t + D);
    expect(TEMPLATES.daily.map((x) => render(x, { streak: 5 }))).toContain(to(u)[1]);
  });

  it("from the scheduler: one a day, a make-good first, no line twice in 5 days, inside the 3 a day", async () => {
    const day0 = fresh();
    await makeGood(day0 + H);
    const u = await residentWith({ alerts: ["snap"] });
    // A live streak, and a session the day before, so the usual hour is 18:00.
    await client`INSERT INTO streaks (user_id, current, longest, last_day, hodl_days) VALUES (${u}, 5, 5, ${cityDay(new Date(day0 - D))}, 0)
      ON CONFLICT (user_id) DO UPDATE SET current = 5, longest = 5, last_day = EXCLUDED.last_day, hodl_days = 0`;
    const s = new Date(day0 - D + 12 * H).toISOString();
    await client`INSERT INTO play_sessions (user_id, started_at, last_seen_at) VALUES (${u}, ${s}, ${s})`;
    const { sender, to } = recorder();
    for (let d = 0; d < 5; d++) {
      const six = day0 + d * D + 18 * H;
      await client`UPDATE streaks SET last_day = ${cityDay(new Date(six - D))} WHERE user_id = ${u}`; // played yesterday, not yet today
      if (d === 4) {
        for (let i = 0; i < NOTIFY.dailyCap; i++) await notify(db, u, "snap", { handle: "frog" }, { now: new Date(six - H + i * MIN) });
        await run(sender, six - 30 * MIN);
      }
      await queueDailyPings(db, { now: new Date(six) });
      await queueDailyPings(db, { now: new Date(six + 15 * MIN) }); // the next tick doesn't add one
      await run(sender, six + 15 * MIN);
    }
    const daily = to(u).filter((x) => !x.includes("Snap") && !x.includes("@frog"));
    expect(daily).toHaveLength(4);
    expect(daily.slice(0, 3).every((x) => DAILY_TOPIC_TEMPLATES.make_good.includes(x))).toBe(true);
    expect(DAILY_TOPIC_TEMPLATES.clue).toContain(daily[3]); // the make-good's lines are used up: the clue, not a repeat
    expect((await alerts(u, "daily")).map((r) => r.status)).toEqual(["sent", "sent", "sent", "sent", "suppressed"]);
    expect((await alerts(u, "daily"))[4]).toMatchObject({ reason: "cap" });
  });
});
