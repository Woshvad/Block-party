import { NOTIFY, TEMPLATES, cityDay } from "@bp/core";
import { notify } from "@bp/db";
import { afterAll, describe, expect, it } from "vitest";
import { PUSH_RUN, runMinute } from "../src/cron";
import { call, client, close, db, fakeNotifier, pushes, resident } from "./harness";

afterAll(close);

describe("the minute cron raises the opt-in alerts", () => {
  it("a Mod Shift done: queued by the cron once its time is up, sent once, never again", async () => {
    const me = await resident();
    expect((await call("PATCH", "/v1/notifications/prefs", { token: me.token, body: { alerts: ["shift_done"], quietStart: 0, quietEnd: 0 } })).status).toBe(200);
    const s = await call("POST", "/v1/shifts", { token: me.token });
    expect(s.status).toBe(201);
    // Its 15 minutes, already over.
    await client`UPDATE shifts SET started_at = now() - interval '20 minutes', ends_at = now() - interval '5 minutes' WHERE id = ${s.body.shiftId}`;
    const first = await runMinute(db, new Date(), {});
    expect(first.find((r) => r.job === "shiftPings")).toMatchObject({ status: "fulfilled" });
    expect(await client`SELECT ref, status FROM notifications WHERE user_id = ${me.userId} AND kind = 'shift_done'`).toEqual([{ ref: s.body.shiftId, status: "queued" }]);
    await runMinute(db, new Date(), { sender: fakeNotifier });
    await runMinute(db, new Date(), { sender: fakeNotifier });
    const mine = pushes.filter((p) => p.userId === me.userId).map((p) => p.text);
    expect(mine).toHaveLength(1);
    expect(TEMPLATES.shift_done).toContain(mine[0]);
  });

  it("the bell in 2 hours, from the 22:00 tick", async () => {
    const me = await resident();
    expect((await call("PATCH", "/v1/notifications/prefs", { token: me.token, body: { bell2h: true, quietStart: 0, quietEnd: 0 } })).status).toBe(200);
    const ten = new Date();
    ten.setUTCHours(22, 0, 0, 0);
    const results = await runMinute(db, ten, {});
    expect(results.find((r) => r.job === "bellPings")).toMatchObject({ status: "fulfilled" });
    expect(await client`SELECT ref FROM notifications WHERE user_id = ${me.userId} AND kind = 'bell_2h'`).toEqual([{ ref: cityDay(ten) }]);
  });

  it("pushes go out several at a time, paced under Telegram's limit, done inside the minute", async () => {
    expect(PUSH_RUN.perSecond).toBeLessThan(30); // Telegram's rough limit for a bot
    expect(PUSH_RUN.budgetMs).toBeLessThan(60_000);
    expect(PUSH_RUN.batch * NOTIFY.bellPingLateMinutes).toBeGreaterThanOrEqual(15_000); // a big "Bell in 2h" in its half hour
    const mine = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const me = await resident();
      expect((await call("PATCH", "/v1/notifications/prefs", { token: me.token, body: { quietStart: 0, quietEnd: 0 } })).status).toBe(200);
      await notify(db, me.userId, "daily", {});
      mine.add(me.userId);
    }
    let inFlight = 0;
    let most = 0;
    const starts: number[] = [];
    const reached = new Set<string>();
    const sender = {
      send: async (userId: string) => {
        starts.push(performance.now());
        most = Math.max(most, ++inFlight);
        await new Promise((r) => setTimeout(r, 300));
        inFlight--;
        if (mine.has(userId)) reached.add(userId);
        return "sent" as const;
      },
    };
    const results = await runMinute(db, new Date(), { sender });
    expect(results.find((r) => r.job === "notifications")).toMatchObject({ status: "fulfilled" });
    expect(reached.size).toBe(mine.size);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(PUSH_RUN.concurrency);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[0]!).toBeGreaterThanOrEqual((i * 1000) / PUSH_RUN.perSecond - 5);
  });

  it("the away-shift and bell pings run on the 15-minute ticks, the shift pings every minute", async () => {
    const tick = new Date();
    tick.setUTCMinutes(15, 0, 0);
    const jobs = async (at: Date) => {
      const results = await runMinute(db, at, {});
      for (const name of ["shiftPings", "dailyPings", "awayShiftPings", "bellPings"]) {
        const r = results.find((x) => x.job === name);
        if (r) expect(r, name).toMatchObject({ status: "fulfilled" });
      }
      return results.map((r) => r.job);
    };
    expect(await jobs(tick)).toEqual(expect.arrayContaining(["shiftPings", "dailyPings", "awayShiftPings", "bellPings"]));
    const other = await jobs(new Date(tick.getTime() + 60_000));
    expect(other).toContain("shiftPings");
    for (const name of ["dailyPings", "awayShiftPings", "bellPings"]) expect(other).not.toContain(name);
  });
});
