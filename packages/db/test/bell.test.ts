import { randomUUID } from "node:crypto";
import { SYS_PURSE, crewPotAccountId, escrowAccountId, seasonLastDay, userAccountId } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bellStatus,
  buyPiece,
  createCrew,
  createDb,
  depositToPot,
  ensureSystemAccounts,
  getBalance,
  mint,
  openEscrowAccount,
  reconcile,
  runBell,
  sayGm,
  supplyStats,
} from "../src";
import { makeResident } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });

// Each test uses its own season boundary: the Halving and bell steps are
// global, so sharing a season between tests would couple them.
const bellOf = (season: number, lateDays = 0, minute = 5) => {
  const d = new Date(`${seasonLastDay(season)}T00:00:00.000Z`);
  return new Date(d.getTime() + (1 + lateDays) * 86_400_000 + minute * 60_000);
};

async function richResident(gm: number) {
  const u = await makeResident(db); // 1000 from move-in
  if (gm > 1000) await mint(db, { accountId: userAccountId(u), amount: gm - 1000, kind: "test_seed", idempotencyKey: randomUUID() });
  return u;
}
const bal = (u: string) => getBalance(db, userAccountId(u));
const halvedRows = (accountId: string) => client`SELECT season, balance_before, burned FROM halvings WHERE account_id = ${accountId}`;

beforeAll(() => ensureSystemAccounts(db));
afterAll(async () => {
  expect(await reconcile(db)).toEqual([]);
  await close();
});

describe("the Halving", () => {
  it("the full bell at season 1's end: halves balances and crew pots above 2,000, leaves the rest", async () => {
    const big = await richResident(5000);
    const odd = await richResident(5001);
    const line = await richResident(2000);
    const justOver = await richResident(2001);
    const small = await richResident(1500);
    const lead = await richResident(5000);
    const c = await createCrew(db, lead, { name: `Halving ${randomUUID().slice(0, 6)}` });
    await depositToPot(db, lead, 4000, randomUUID());
    const duel = await openEscrowAccount(db, escrowAccountId("duel", randomUUID()));
    await mint(db, { accountId: duel, amount: 9000, kind: "test_seed", idempotencyKey: randomUUID() });
    const purseBefore = await getBalance(db, SYS_PURSE);
    const burnBefore = (await supplyStats(db)).destroyed;

    const out = await runBell(db, { now: bellOf(1) });
    expect(Object.keys(out.ran).sort()).toEqual(["alts", "chains", "close", "election", "halving", "league", "npc_lines", "tower"]); // 2026-11-02 is a Monday

    expect(await bal(big)).toBe(3500);
    expect(await bal(odd)).toBe(3501); // rounds for the player
    expect(await bal(line)).toBe(2000);
    expect(await bal(justOver)).toBe(2001); // excess of 1: nothing to burn
    expect(await bal(small)).toBe(1500);
    expect(await bal(lead)).toBe(1000); // deposited down to 1000: untouched
    expect(await getBalance(db, crewPotAccountId(c.id))).toBe(3000);
    expect(await getBalance(db, duel)).toBe(9000); // only resident balances and crew pots
    expect(await getBalance(db, SYS_PURSE)).toBe(purseBefore);
    expect((await supplyStats(db)).destroyed - burnBefore).toBeGreaterThanOrEqual(1500 + 1500 + 1000);
    const rows = await halvedRows(userAccountId(big)); // bigint columns arrive as strings
    expect(rows.map((r) => [r.season, Number(r.balance_before), Number(r.burned)])).toEqual([[1, 5000, 1500]]);
  }, 180_000);

  it("re-running the same bell changes nothing (no second Halving, no key conflict)", async () => {
    const u = await richResident(8000);
    await runBell(db, { now: bellOf(2), only: ["halving"] });
    expect(await bal(u)).toBe(5000);
    const again = await runBell(db, { now: bellOf(2, 0, 30), only: ["halving"] });
    expect(again.ran.halving).toBe("already done");
    expect(await bal(u)).toBe(5000); // still above 2,000, but never halved twice
  });

  it("a late job still halves, up to 7 days; once only", async () => {
    const u = await richResident(6000);
    const late = await runBell(db, { now: bellOf(3, 3), only: ["halving"] });
    expect(late.ran.halving).toMatchObject({ season: 3 });
    expect(await bal(u)).toBe(4000);
    await runBell(db, { now: bellOf(3, 4), only: ["halving"] });
    expect(await bal(u)).toBe(4000);
    expect(await halvedRows(userAccountId(u))).toHaveLength(1);
  });

  it("too late (7+ days): skipped, not applied retroactively", async () => {
    const u = await richResident(6000);
    const out = await runBell(db, { now: bellOf(4, 7), only: ["halving"] });
    expect(out.ran).toEqual({});
    expect(await bal(u)).toBe(6000);
  });

  it("a crash midway resumes cleanly: everyone halved exactly once", async () => {
    const users = await Promise.all(Array.from({ length: 6 }, () => richResident(6000)));
    let calls = 0;
    await expect(
      runBell(db, {
        now: bellOf(5),
        only: ["halving"],
        onHalvingAccount: () => {
          if (++calls === 4) throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");
    expect((await bellStatus(db, seasonLastDay(5))).map((s) => s.step)).not.toContain("halving");
    const resumed = await runBell(db, { now: bellOf(5, 0, 20), only: ["halving"] });
    expect(resumed.ran.halving).toMatchObject({ season: 5 });
    for (const u of users) {
      expect(await bal(u)).toBe(4000);
      expect(await halvedRows(userAccountId(u))).toHaveLength(1);
    }
  });

  it("5 bell runners at once: the Halving happens once", async () => {
    const u = await richResident(10000);
    const results = await Promise.all(Array.from({ length: 5 }, () => runBell(db, { now: bellOf(6), only: ["halving"] })));
    // The others found the bell busy, or the step already done.
    expect(results.filter((r) => r.ran.halving !== undefined && r.ran.halving !== "already done")).toHaveLength(1);
    expect(await bal(u)).toBe(6000);
  });

  it("a runner that finds the bell busy returns at once instead of queueing", async () => {
    const u = await richResident(6000);
    const holder = await client.reserve();
    await holder`SELECT pg_advisory_lock(hashtext('bell_runner'))`;
    try {
      const waited = new Promise<"queued">((r) => setTimeout(() => r("queued"), 5_000));
      const out = await Promise.race([runBell(db, { now: bellOf(9), only: ["halving"] }), waited]);
      expect(out).toEqual({ bellDay: seasonLastDay(9), ran: {}, busy: true });
      expect(await bal(u)).toBe(6000);
    } finally {
      await holder`SELECT pg_advisory_unlock(hashtext('bell_runner'))`;
      holder.release();
    }
    // Free again: the next minute's runner does the work.
    expect((await runBell(db, { now: bellOf(9, 0, 6), only: ["halving"] })).ran.halving).toMatchObject({ season: 9 });
    expect(await bal(u)).toBe(4000);
  });

  it("a purchase can't slip in between the Halving reading a balance and burning it", async () => {
    const u = await richResident(5000);
    let purchase: Promise<unknown> | null = null;
    let slippedIn = false;
    await runBell(db, {
      now: bellOf(7),
      only: ["halving"],
      onHalvingAccount: async (accountId) => {
        if (accountId !== userAccountId(u)) return;
        purchase = buyPiece(db, u, "arcade_cabinet", randomUUID());
        // Give it a moment: it must be blocked behind the Halving's lock.
        const done = await Promise.race([purchase.then(() => true), new Promise((r) => setTimeout(() => r(false), 500))]);
        slippedIn = done === true;
      },
    });
    await purchase;
    expect(slippedIn).toBe(false);
    expect(await bal(u)).toBe(5000 - 1500 - 1500); // halved on 5000, then bought
  });

  it("every Halving burn matches the balance it was taken from (ledger audit)", async () => {
    const rows = await client`
      SELECT h.account_id, h.balance_before, h.burned, e.balance_after
      FROM halvings h JOIN gm_entries e ON e.tx_id = h.tx_id AND e.account_id = h.account_id`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const before = Number(r.balance_after) + Number(r.burned); // the balance at the moment of the burn
      expect(before).toBe(Number(r.balance_before));
      expect(Number(r.burned)).toBe(Math.floor((before - 2000) / 2));
    }
  });

  it("walks every page: 12 accounts with a page size of 3", async () => {
    const users = await Promise.all(Array.from({ length: 12 }, () => richResident(3000)));
    await runBell(db, { now: bellOf(8), only: ["halving"], pageSize: 3 });
    for (const u of users) expect(await bal(u)).toBe(2500);
  });

  it("the database refuses a Halving row with the wrong maths", async () => {
    const u = await richResident(5000);
    const [t] = await client`SELECT tx_id FROM halvings LIMIT 1`;
    await expect(
      client`INSERT INTO halvings (season, account_id, balance_before, burned, tx_id) VALUES (99, ${userAccountId(u)}, 5000, 2000, ${t!.tx_id})`,
    ).rejects.toThrow(/halvings_math/);
  });
});

describe("other bell steps", () => {
  it("collects rent on the Saturday bell only, once", async () => {
    const u = await makeResident(db);
    await sayGm(db, u);
    // The next Saturday bell after today.
    const now = new Date();
    const sat = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + (((6 - now.getUTCDay() + 7) % 7) || 7), 0, 5));
    const friday = new Date(sat.getTime() - 86_400_000);
    expect((await runBell(db, { now: friday, only: ["rent"] })).ran).toEqual({});
    const first = await runBell(db, { now: sat, only: ["rent"] });
    expect(first.ran.rent).toMatchObject({ paid: expect.any(Number) });
    expect(await bal(u)).toBe(1050 - 250);
    const second = await runBell(db, { now: new Date(sat.getTime() + 60_000), only: ["rent"] });
    expect(second.ran.rent).toBe("already done");
    expect(await bal(u)).toBe(800);
  }, 120_000);

  it("settles crew chains and records each step with its result", async () => {
    const lead = await makeResident(db);
    const c = await createCrew(db, lead, { name: `Bell ${randomUUID().slice(0, 6)}` });
    const now = new Date(Date.now() + 2 * 86_400_000);
    const out = await runBell(db, { now, only: ["chains"] });
    expect(out.ran.chains).toMatchObject({ crews: expect.any(Number) });
    const [row] = await client`SELECT count(*)::int AS n FROM crew_chain_days WHERE crew_id = ${c.id}`;
    expect(row!.n).toBe(2);
    const status = await bellStatus(db, out.bellDay);
    expect(status.map((s) => s.step)).toContain("chains");
  }, 120_000);
});
