import { NOTIFY, TEMPLATES } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type NotificationSender, NotifyError, createDb, ensureSystemAccounts, notify, runNotificationBatch, setPrefs } from "../src";
import { makeResident } from "./helpers";

// How the dispatcher works through a big batch: what goes first, how many
// at once, how fast, and for how long.

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
// Long after every other file's pushes, so none of theirs is still sendable
// here; each test drains its own.
let base = Date.UTC(2120, 0, 1, 12);
const fresh = () => (base += 30 * D);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = (s: NotificationSender, at: number, opts: { concurrency?: number; perSecond?: number; budgetMs?: number } = {}) =>
  runNotificationBatch(db, s, { now: new Date(at), batch: 5000, ...opts });
const statuses = async (us: string[]) => (await client`SELECT status FROM notifications WHERE user_id = ANY(${us}::uuid[])`).map((r) => r.status as string);
const ok: NotificationSender = { send: async () => "sent" };

// Residents with no quiet hours, each with a daily ping due at `at`.
async function due(n: number, at: number) {
  const us: string[] = [];
  for (let i = 0; i < n; i++) {
    const u = await makeResident(db);
    await setPrefs(db, u, { quietStart: 0, quietEnd: 0 });
    await notify(db, u, "daily", {}, { now: new Date(at) });
    us.push(u);
  }
  return us;
}

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

describe("the dispatcher", () => {
  it("whatever stops being sendable soonest goes first", async () => {
    const t = fresh();
    const u = await makeResident(db);
    await setPrefs(db, u, { bell2h: true, quietStart: 0, quietEnd: 0 });
    await notify(db, u, "daily", {}, { now: new Date(t - 10 * H) }); // due for 10 hours: 2 left before it's stale
    await notify(db, u, "bell_2h", {}, { now: new Date(t), ref: "bell", expiresAt: new Date(t + 30 * MIN) }); // half an hour left
    const order: string[] = [];
    const sender: NotificationSender = {
      send: async (userId, text) => {
        if (userId === u) order.push(text);
        return "sent";
      },
    };
    await run(sender, t);
    expect(order).toHaveLength(2);
    expect(TEMPLATES.bell_2h).toContain(order[0]);
    expect(NOTIFY.staleAfterHours).toBeGreaterThan(10);
  });

  it("several in flight at once, never more than asked, and still 3 a day for one resident", async () => {
    const t = fresh();
    const us = await due(8, t);
    let inFlight = 0;
    let most = 0;
    const sender: NotificationSender = {
      send: async () => {
        most = Math.max(most, ++inFlight);
        await sleep(150);
        inFlight--;
        return "sent";
      },
    };
    await run(sender, t, { concurrency: 4 });
    expect(most).toBe(4);
    expect(await statuses(us)).toEqual(us.map(() => "sent"));

    // Six of one resident's at once: the per-resident lock still holds them to the cap.
    const [v] = await due(1, t + D);
    for (let i = 0; i < 5; i++) await notify(db, v!, "daily", {}, { now: new Date(t + D) });
    await run(ok, t + D, { concurrency: 6 });
    expect((await statuses([v!])).filter((s) => s === "sent")).toHaveLength(NOTIFY.dailyCap);
  });

  it("paced: never more sends than the rate allows, however many are in flight", async () => {
    const t = fresh();
    await due(6, t);
    const starts: number[] = [];
    const sender: NotificationSender = {
      send: async () => {
        starts.push(performance.now());
        await sleep(20);
        return "sent";
      },
    };
    await run(sender, t, { concurrency: 4, perSecond: 20 }); // one every 50 ms
    expect(starts.length).toBeGreaterThanOrEqual(6);
    // The nth send starts no sooner than n slots after the first (a late
    // timer can bring two closer, never get ahead of the rate).
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[0]!).toBeGreaterThanOrEqual(i * 50 - 5);
  });

  it("takes no new push once its time is up, and leaves the rest queued for the next run", async () => {
    const t = fresh();
    const us = await due(10, t);
    const slow: NotificationSender = {
      send: async () => {
        await sleep(100);
        return "sent";
      },
    };
    const t0 = performance.now();
    await run(slow, t, { budgetMs: 250 });
    expect(performance.now() - t0).toBeLessThan(800); // ten at 100 ms each would take a second
    expect((await statuses(us)).filter((s) => s === "queued").length).toBeGreaterThan(0);
    await run(ok, t + MIN);
    expect(await statuses(us)).toEqual(us.map(() => "sent"));
  });

  it("a send that throws stops every lane taking more, and is thrown once those in flight are done", async () => {
    const t = fresh();
    const us = await due(8, t);
    let calls = 0;
    let inFlight = 0;
    const crashing: NotificationSender = {
      send: async () => {
        if (++calls === 1) throw new Error("worker evicted");
        inFlight++;
        await sleep(50);
        inFlight--;
        return "sent";
      },
    };
    await expect(run(crashing, t, { concurrency: 2 })).rejects.toThrow("worker evicted");
    expect(inFlight).toBe(0);
    expect(calls).toBeLessThanOrEqual(2);
    expect((await statuses(us)).filter((s) => s === "queued").length).toBeGreaterThanOrEqual(6);
    // The one that threw counts as sent, never sent again; the rest go next time.
    let again = 0;
    await run({ send: async () => (again++, "sent") }, t + MIN);
    expect(again).toBe(us.length - calls);
  });

  it("refuses junk settings", async () => {
    for (const bad of [{ concurrency: 0 }, { concurrency: 51 }, { concurrency: 1.5 }, { perSecond: 0 }, { perSecond: "25" }, { budgetMs: -1 }, { batch: 0 }, { now: "today" }])
      expect(await code(runNotificationBatch(db, ok, bad as never)), JSON.stringify(bad)).toBe("INVALID_INPUT");
  });
});
