import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChainError,
  chainStatus,
  createCrew,
  createDb,
  createInvite,
  dissolveCrew,
  ensureSystemAccounts,
  reconcile,
  redeemInvite,
  relightChain,
  removeMember,
  sayGm,
  settleCrewChain,
} from "../src";
import { makeResident } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });

const DAY = 86_400_000;
const at = (days: number, hour = 12) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};

async function crewOf(size: number) {
  const lead = await makeResident(db);
  const crew = await createCrew(db, lead, { name: `Chain ${randomUUID().slice(0, 8)}` });
  const inv = await createInvite(db, lead);
  const all = [lead];
  for (let i = 1; i < size; i++) {
    const u = await makeResident(db);
    await redeemInvite(db, u, inv.code);
    all.push(u);
  }
  return { crewId: crew.id, lead, all, invite: inv.code };
}

const gm = (users: string[], day: number) => Promise.all(users.map((u) => sayGm(db, u, { now: at(day) })));
const status = (crewId: string, day: number) => chainStatus(db, crewId, { now: at(day) });
const dayRows = (crewId: string) =>
  client`SELECT city_day::text AS d, members, active, gms, held, relit FROM crew_chain_days WHERE crew_id = ${crewId} ORDER BY city_day`;

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof ChainError) return e.code;
    throw e;
  }
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(async () => {
  expect(await reconcile(db)).toEqual([]);
  await close();
});

describe("holding the chain", () => {
  it("grows one link per held day", async () => {
    const c = await crewOf(5);
    for (let d = 0; d < 3; d++) await gm(c.all, d);
    expect(await status(c.crewId, 3)).toMatchObject({ length: 3, needsRelight: null });
  });

  it("holds at exactly 60% (at least 3), misses one below", async () => {
    const c = await crewOf(6);
    await gm(c.all, 0); // all 6 active
    await gm(c.all.slice(0, 4), 1); // 4 of 6 = 67%: needs ceil(3.6) = 4 -> holds
    await gm(c.all.slice(0, 3), 2); // 3 of 6 = 50% -> misses
    await settleCrewChain(db, c.crewId, { now: at(3) });
    const rows = await dayRows(c.crewId);
    expect(rows.map((r) => [r.active, r.gms, r.held])).toEqual([
      [6, 6, true],
      [6, 4, true],
      [6, 3, false],
    ]);
  });

  it("members quiet for 7 days stop counting as active", async () => {
    const c = await crewOf(10);
    await gm(c.all, 0);
    for (let d = 1; d <= 7; d++) await gm(c.all.slice(0, 3), d);
    await settleCrewChain(db, c.crewId, { now: at(8) });
    const rows = await dayRows(c.crewId);
    expect(rows.map((r) => r.active)).toEqual([10, 10, 10, 10, 10, 10, 10, 3]);
    expect(rows.at(-1)).toMatchObject({ gms: 3, held: true }); // window has rolled past day 0
  });

  it("a crew under 3 members can't hold it", async () => {
    const c = await crewOf(2);
    await gm(c.all, 0);
    await settleCrewChain(db, c.crewId, { now: at(1) });
    expect((await dayRows(c.crewId))[0]).toMatchObject({ members: 2, gms: 2, held: false });
  });

  it("someone who left before the bell doesn't count, either way", async () => {
    const c = await crewOf(4);
    await gm(c.all, 0);
    await removeMember(db, c.lead, c.all[3]!); // left before today's bell
    await settleCrewChain(db, c.crewId, { now: at(1) });
    expect((await dayRows(c.crewId))[0]).toMatchObject({ members: 3, active: 3, gms: 3, held: true });
  });

  it("catches up 30 unsettled days in one go, in order", async () => {
    const c = await crewOf(3);
    for (let d = 0; d < 30; d++) if (d !== 10) await gm(c.all, d);
    expect(await status(c.crewId, 30)).toMatchObject({ length: 19 }); // days 11..29
    expect(await dayRows(c.crewId)).toHaveLength(30);
  }, 30_000);
});

describe("relighting", () => {
  async function missedYesterday() {
    const c = await crewOf(5);
    await gm(c.all, 0);
    await gm(c.all, 1);
    await gm(c.all.slice(0, 2), 2); // miss
    return c;
  }

  it("yesterday's miss shows as needing a relight, over the chain it would save", async () => {
    const c = await missedYesterday();
    expect(await status(c.crewId, 3)).toMatchObject({ length: 2, needsRelight: expect.any(String), relightVotes: 0, relightNeeded: 3 });
  });

  it("3 members relight it; duplicate votes count once", async () => {
    const c = await missedYesterday();
    expect(await relightChain(db, c.all[0]!, { now: at(3) })).toEqual({ votes: 1, relit: false });
    expect(await relightChain(db, c.all[0]!, { now: at(3) })).toEqual({ votes: 1, relit: false });
    await relightChain(db, c.all[1]!, { now: at(3) });
    expect(await relightChain(db, c.all[2]!, { now: at(3) })).toEqual({ votes: 3, relit: true });
    await gm(c.all, 3);
    expect(await status(c.crewId, 4)).toMatchObject({ length: 3, needsRelight: null }); // 0, 1, (relit 2), 3
  });

  it("the window closes at the next bell", async () => {
    const c = await missedYesterday();
    await relightChain(db, c.all[0]!, { now: at(3) });
    expect(await status(c.crewId, 4)).toMatchObject({ length: 0, needsRelight: expect.any(String) }); // day 3 itself missed
    expect(await code(relightChain(db, c.all[1]!, { now: at(5) }))).toBe("OK"); // that's relighting day 4, not day 2
    const rows = await dayRows(c.crewId);
    expect(rows.find((r) => r.relit)).toBeUndefined();
  });

  it("nothing to relight on a held day; outsiders can't vote", async () => {
    const c = await crewOf(5);
    await gm(c.all, 0);
    expect(await code(relightChain(db, c.lead, { now: at(1) }))).toBe("NOTHING_TO_RELIGHT");
    await gm(c.all.slice(0, 1), 1); // miss
    expect(await code(relightChain(db, await makeResident(db), { now: at(2) }))).toBe("NOT_IN_CREW");
  });

  it("only members on the roster at the missed day's bell can relight it", async () => {
    const c = await crewOf(5);
    await gm(c.all, 0);
    await gm(c.all.slice(0, 1), 1); // day 1 missed; its bell is at(2, 0)
    // A stint that starts after that bell (history can't be edited, so insert it that way).
    const alt = await makeResident(db);
    await client`INSERT INTO crew_members (crew_id, user_id, role, joined_at) VALUES (${c.crewId}, ${alt}, 'member', ${at(2, 1).toISOString()})`;
    expect(await code(relightChain(db, alt, { now: at(2, 2) }))).toBe("NOT_A_MEMBER_THAT_DAY");
    const before = await makeResident(db); // joined now: before day 1's bell
    await redeemInvite(db, before, c.invite);
    expect(await code(relightChain(db, before, { now: at(2, 2) }))).toBe("OK");
  });

  it("5 members racing to relight: relit once, all votes kept, no errors", async () => {
    const c = await missedYesterday();
    const results = await Promise.all(c.all.map((u) => relightChain(db, u, { now: at(3) })));
    expect(results.filter((r) => r.relit).length).toBe(3); // votes 3, 4 and 5 all see it lit
    expect(Math.max(...results.map((r) => r.votes))).toBe(5);
    expect((await dayRows(c.crewId)).filter((r) => r.relit)).toHaveLength(1);
  });
});

describe("settlement safety", () => {
  it("settling is idempotent, and 10 racing settles write each day once", async () => {
    const c = await crewOf(3);
    for (let d = 0; d < 5; d++) await gm(c.all, d);
    await Promise.all(Array.from({ length: 10 }, () => settleCrewChain(db, c.crewId, { now: at(5) })));
    await settleCrewChain(db, c.crewId, { now: at(5) });
    expect(await dayRows(c.crewId)).toHaveLength(5);
  });

  it("a dissolved crew stops settling on the day it dissolved", async () => {
    const c = await crewOf(3);
    await gm(c.all, 0);
    await dissolveCrew(db, c.lead);
    await settleCrewChain(db, c.crewId, { now: at(10) });
    expect(await dayRows(c.crewId)).toHaveLength(0); // dissolved before today's bell
  });

  it("status reports counts only, never who missed", async () => {
    const c = await crewOf(4);
    await gm(c.all.slice(0, 1), 0);
    const s = JSON.stringify(await status(c.crewId, 1));
    for (const u of c.all) expect(s).not.toContain(u);
    const cols = await client`SELECT column_name FROM information_schema.columns WHERE table_name = 'crew_chain_days'`;
    expect(cols.map((r) => r.column_name)).not.toContain("user_id");
  });

  it("today's progress shows how many more gms are needed", async () => {
    const c = await crewOf(5);
    await gm(c.all, 0);
    await gm(c.all.slice(0, 2), 1);
    expect((await status(c.crewId, 1)).today).toEqual({ gms: 2, active: 5, needed: 3 });
  });

  it("the database refuses impossible counts", async () => {
    const c = await crewOf(3);
    await gm(c.all, 0);
    await settleCrewChain(db, c.crewId, { now: at(1) });
    await expect(client`UPDATE crew_chain_days SET relit = true WHERE crew_id = ${c.crewId}`).rejects.toThrow(/crew_chain_days_relit/);
    await expect(client`UPDATE crew_chain_days SET gms = 99 WHERE crew_id = ${c.crewId}`).rejects.toThrow(/crew_chain_days_counts/);
  });
});
