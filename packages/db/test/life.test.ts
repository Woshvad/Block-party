import { NAP } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LifeError,
  type WhereCheck,
  cancelLongAction,
  createDb,
  ensureSystemAccounts,
  finishDueActions,
  moodState,
  myLongAction,
  setPrefs,
  startNap,
  touchActivity,
} from "../src";
import { makeResident, releaseTogether } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const MIN = 60_000;
const atHome: WhereCheck = async (u, place) => (place === `home:${u}` ? 1 : null);
const out: WhereCheck = async () => null;

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof LifeError) return e.code;
    throw e;
  }
}
const bedOf = async (u: string, piece = "%_bed") => {
  const [r] = await client`SELECT i.id FROM items i JOIN placements p ON p.item_id = i.id WHERE i.owner_user_id = ${u} AND i.piece_id LIKE ${piece}`;
  return r!.id as string;
};

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("naps", () => {
  it("20 real minutes on your own bed, then Rested and an opt-in ping", async () => {
    const u = await makeResident(db);
    await setPrefs(db, u, { alerts: ["nap_done"] });
    const t = new Date();
    const nap = await startNap(db, u, await bedOf(u), atHome, { now: t });
    expect(nap.endsAt.getTime() - t.getTime()).toBe(NAP.minutes * MIN);
    expect(await myLongAction(db, u, { now: new Date(t.getTime() + 5 * MIN) })).toMatchObject({ kind: "nap" });
    expect((await moodState(db, u, { now: new Date(t.getTime() + 5 * MIN) })).active.map((a) => a.mood)).not.toContain("rested");
    // Logged off the whole time: the cron finishes it.
    await finishDueActions(db, { now: new Date(t.getTime() + 21 * MIN) });
    expect(await myLongAction(db, u, { now: new Date(t.getTime() + 21 * MIN) })).toBeNull();
    expect((await moodState(db, u, { now: new Date(t.getTime() + 21 * MIN) })).active.map((a) => a.mood)).toContain("rested");
    const pings = await client`SELECT kind FROM notifications WHERE user_id = ${u}`;
    expect(pings.map((p) => p.kind)).toEqual(["nap_done"]);
  });

  it("no ping unless asked for", async () => {
    const u = await makeResident(db);
    const t = new Date();
    await startNap(db, u, await bedOf(u), atHome, { now: t });
    await finishDueActions(db, { now: new Date(t.getTime() + 30 * MIN) });
    expect(await client`SELECT 1 FROM notifications WHERE user_id = ${u}`).toHaveLength(0);
  });

  it("only at home, on your own placed Rested piece", async () => {
    const [u, v] = [await makeResident(db), await makeResident(db)];
    expect(await code(startNap(db, u, await bedOf(u), out))).toBe("NOT_HOME");
    expect(await code(startNap(db, u, await bedOf(v), atHome))).toBe("CANT_NAP_THERE"); // someone else's bed
    expect(await code(startNap(db, u, await bedOf(u, "%_desk"), atHome))).toBe("CANT_NAP_THERE");
    for (const bad of [null, 1, "bed", "'; --", "0".repeat(36)]) expect(await code(startNap(db, u, bad, atHome))).toBe("INVALID_INPUT");
    // A stored bed doesn't count.
    const bed = await bedOf(u);
    await client`DELETE FROM placements WHERE item_id = ${bed}`;
    expect(await code(startNap(db, u, bed, atHome))).toBe("CANT_NAP_THERE");
  });

  it("one long action at a time, even racing; a finished one frees the slot", async () => {
    const u = await makeResident(db);
    const bed = await bedOf(u);
    const t = new Date();
    const res = await releaseTogether(client, "SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [u], 1, [1, 2, 3, 4].map(() => () => code(startNap(db, u, bed, atHome, { now: t }))));
    expect(res.map((r) => (r.ok ? r.v : "THREW")).sort()).toEqual(["BUSY", "BUSY", "BUSY", "OK"]);
    // Due now: starting again finishes the old one first.
    expect(await code(startNap(db, u, bed, atHome, { now: new Date(t.getTime() + 25 * MIN) }))).toBe("OK");
    const [n] = await client`SELECT count(*)::int AS n FROM long_actions WHERE user_id = ${u} AND status = 'done'`;
    expect(n!.n).toBe(1);
  });

  it("each nap finishes exactly once, however many finishers race", async () => {
    const users = await Promise.all(Array.from({ length: 4 }, () => makeResident(db)));
    const t = new Date(Date.now() - 60 * MIN);
    for (const u of users) {
      await setPrefs(db, u, { alerts: ["nap_done"] });
      await startNap(db, u, await bedOf(u), atHome, { now: t });
    }
    const res = await Promise.all(Array.from({ length: 5 }, () => finishDueActions(db, { now: new Date() })));
    expect(res.every((r) => r.finished >= 0)).toBe(true);
    for (const u of users) {
      const [n] = await client`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${u} AND kind = 'nap_done'`;
      expect(n!.n).toBe(1);
      const [m] = await client`SELECT count(*)::int AS n FROM moods WHERE user_id = ${u} AND mood = 'rested'`;
      expect(m!.n).toBe(1);
    }
  });

  it("waking early: no Rested; nothing to stop is an error", async () => {
    const u = await makeResident(db);
    const t = new Date();
    await startNap(db, u, await bedOf(u), atHome, { now: t });
    await cancelLongAction(db, u, { now: new Date(t.getTime() + 5 * MIN) });
    await finishDueActions(db, { now: new Date(t.getTime() + 30 * MIN) });
    expect((await moodState(db, u, { now: new Date(t.getTime() + 30 * MIN) })).active.map((a) => a.mood)).not.toContain("rested");
    expect(await code(cancelLongAction(db, u))).toBe("NOTHING_RUNNING");
  });

  it("a nap after it was due doesn't stop early: cancelling a finished nap still leaves you Rested", async () => {
    const u = await makeResident(db);
    const t = new Date(Date.now() - 25 * MIN);
    await startNap(db, u, await bedOf(u), atHome, { now: t });
    expect(await code(cancelLongAction(db, u))).toBe("NOTHING_RUNNING"); // it had already finished
    expect((await moodState(db, u)).active.map((a) => a.mood)).toContain("rested");
  });

  it("finished late, it counts as of when it ended: no fresh Rested hours afterwards", async () => {
    const u = await makeResident(db);
    const t = new Date(Date.now() - 4 * 60 * MIN);
    const nap = await startNap(db, u, await bedOf(u), atHome, { now: t });
    await finishDueActions(db, { now: new Date() });
    const [row] = await client`SELECT finished_at FROM long_actions WHERE id = ${nap.id}`;
    expect(new Date(row!.finished_at).getTime()).toBe(nap.endsAt.getTime());
    expect((await moodState(db, u)).active.map((a) => a.mood)).not.toContain("rested"); // its 90 minutes ran out long ago
  });

  it("a nap never clears Chart-brain", async () => {
    const u = await makeResident(db);
    const t0 = Date.now() - 120 * MIN;
    for (let m = 0; m <= 120; m += 1) await touchActivity(db, u, { now: new Date(t0 + m * MIN) });
    expect((await moodState(db, u)).chartBrain.hideCrowdBars).toBe(true);
    await startNap(db, u, await bedOf(u), atHome, { now: new Date(Date.now() - 21 * MIN) });
    await finishDueActions(db);
    const s = await moodState(db, u);
    expect(s.active.map((a) => a.mood)).toContain("rested");
    expect(s.chartBrain.hideCrowdBars).toBe(true);
  });
});
