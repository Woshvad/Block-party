import { randomUUID } from "node:crypto";
import { SHIFT, SYS_BURN, SYS_PURSE, addDays, cityDay, cityWeekday, shiftPuzzle, userAccountId } from "@bp/core";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EconomyError,
  buyPiece,
  collectAwayShift,
  collectRent,
  collectShift,
  createCrew,
  createDb,
  economyReport,
  ensureSystemAccounts,
  getBalance,
  mint,
  reconcile,
  recordStreakDay,
  sayGm,
  startShift,
  submitShift,
  tenancy,
} from "../src";
import { makeResident, releaseTogether } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const DAY = 86_400_000;
const MIN = 60_000;
const at = (days: number, hour = 12, minute = 0) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
};
const today = cityDay();
// Days from today to the next Saturday after today (1..7).
const toSat = ((6 - cityWeekday(today) + 7) % 7) || 7;
const bal = (u: string) => getBalance(db, userAccountId(u));

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof EconomyError) return e.code;
    if ((e as { code?: string }).code) return (e as { code: string }).code;
    throw e;
  }
}

const answersWithWrong = (seed: number, wrong: number) => shiftPuzzle(seed).answers.map((a, i) => (i < wrong ? !a : a));

beforeAll(() => ensureSystemAccounts(db));
afterAll(async () => {
  expect(await reconcile(db)).toEqual([]);
  await close();
});

describe("rent", () => {
  it("250 at the Saturday bell: 225 burns, 25 to the City Purse", async () => {
    const u = await makeResident(db);
    await sayGm(db, u, { now: at(0) });
    const burn0 = await getBalance(db, SYS_BURN);
    const purse0 = await getBalance(db, SYS_PURSE);
    const out = await collectRent(db, u, { now: at(toSat, 0, 1) });
    expect(out).toEqual([{ saturday: addDays(today, toSat), status: "paid", amount: 250 }]);
    expect(await bal(u)).toBe(1000 + 50 - 250);
    expect((await getBalance(db, SYS_BURN)) - burn0).toBe(225);
    expect((await getBalance(db, SYS_PURSE)) - purse0).toBe(25);
  });

  it("nothing is due before the first Saturday after moving in", async () => {
    const u = await makeResident(db);
    expect(await collectRent(db, u, { now: at(0) })).toEqual([]);
    expect(await collectRent(db, u, { now: at(toSat - 1, 23, 59) })).toEqual([]);
  });

  it("collecting again, or 10 at once, charges each Saturday once", async () => {
    const u = await makeResident(db);
    await collectRent(db, u, { now: at(toSat) });
    await Promise.all(Array.from({ length: 10 }, () => collectRent(db, u, { now: at(toSat, 18) })));
    expect(await bal(u)).toBe(750);
    const [n] = await client`SELECT count(*)::int AS n FROM rent_charges WHERE user_id = ${u}`;
    expect(n!.n).toBe(1);
  });

  it("can't pay: a week on the crew's couch, or the bench, and never debt", async () => {
    const solo = await makeResident(db);
    await buyPiece(db, solo, "aquarium", randomUUID()); // 1000 -> 550
    await buyPiece(db, solo, "double_bed", randomUUID()); // -> 150
    expect(await collectRent(db, solo, { now: at(toSat) })).toEqual([expect.objectContaining({ status: "couch", amount: 0 })]);
    expect(await bal(solo)).toBe(150);
    expect(await tenancy(db, solo, { now: at(toSat) })).toEqual({ where: "bench" });

    const crewed = await makeResident(db);
    const c = await createCrew(db, crewed, { name: `Couch ${randomUUID().slice(0, 6)}` });
    await buyPiece(db, crewed, "lambo_bed", randomUUID()).catch(() => null);
    await buyPiece(db, crewed, "aquarium", randomUUID());
    await buyPiece(db, crewed, "double_bed", randomUUID());
    await collectRent(db, crewed, { now: at(toSat) });
    expect(await tenancy(db, crewed, { now: at(toSat) })).toEqual({ where: "crew_couch", crewId: c.id });
  });

  it("sublet: no rent once you've been away 7 full days", async () => {
    const away = await makeResident(db);
    const out = await collectRent(db, away, { now: at(toSat + 7) });
    expect(out.map((o) => o.status)).toEqual(["paid", "sublet"]); // moved in today; gone since
    expect(await bal(away)).toBe(750);
  });

  it("sublet boundary: 6 full days away still pays, 7 doesn't", async () => {
    const sixDays = await makeResident(db);
    await sayGm(db, sixDays, { now: at(toSat) }); // last seen on the first Saturday
    const sevenDays = await makeResident(db);
    await sayGm(db, sevenDays, { now: at(toSat - 1) });
    const second = toSat + 7;
    expect((await collectRent(db, sixDays, { now: at(second) })).at(-1)!.status).toBe("paid");
    expect((await collectRent(db, sevenDays, { now: at(second) })).at(-1)!.status).toBe("sublet");
  });

  it("a long absence never stacks: at most 8 weeks are looked at, all sublet", async () => {
    const u = await makeResident(db);
    const out = await collectRent(db, u, { now: at(toSat + 7 * 20) });
    expect(out.length).toBeLessThanOrEqual(8);
    expect(out.every((o) => o.status === "sublet")).toBe(true);
    expect(await bal(u)).toBe(1000);
  });

  it("coming back after the Saturday doesn't un-sublet it", async () => {
    const u = await makeResident(db);
    await sayGm(db, u, { now: at(toSat + 8) }); // back the day after the second Saturday
    const out = await collectRent(db, u, { now: at(toSat + 8) });
    expect(out.map((o) => o.status)).toEqual(["paid", "sublet"]);
  });

  it("random collection times never double-charge (property)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 30 }), { minLength: 1, maxLength: 8 }), async (days) => {
        const u = await makeResident(db);
        for (let d = 0; d <= 30; d += 3) await sayGm(db, u, { now: at(d) });
        for (const d of days) await collectRent(db, u, { now: at(d, 13) });
        const rows = await client`SELECT status, amount FROM rent_charges WHERE user_id = ${u}`;
        const paid = rows.filter((r) => r.status === "paid").length;
        const minted = await client`SELECT COALESCE(SUM(e.amount),0)::int AS n FROM gm_entries e JOIN gm_transactions t ON t.id = e.tx_id WHERE e.account_id = ${userAccountId(u)} AND t.kind = 'rent'`;
        return minted[0]!.n === -250 * paid && new Set(rows.map((r) => r)).size === rows.length;
      }),
      { numRuns: 8 },
    );
  }, 60_000);

  it("a purchase landing as rent runs: rent sees the new balance and couch-surfs, no error", async () => {
    const u = await makeResident(db);
    await buyPiece(db, u, "double_bed", randomUUID()); // 1000 -> 600
    await buyPiece(db, u, "gaming_desk", randomUUID()); // -> 250
    await mint(db, { accountId: userAccountId(u), amount: 50, kind: "test_seed", idempotencyKey: randomUUID() }); // -> 300
    expect(await bal(u)).toBe(300);

    // Hold the account so both writers queue: the purchase first, then rent.
    const barrier = await client.reserve();
    await barrier`BEGIN`;
    await barrier`SELECT 1 FROM gm_accounts WHERE id = ${userAccountId(u)} FOR UPDATE`;
    const waiting = async (n: number) => {
      for (let i = 0; i < 300; i++) {
        const [w] = await client`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (w!.n >= n) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("racers never queued");
    };
    const purchase = code(buyPiece(db, u, "guestbook", randomUUID())); // 60: leaves 240
    await waiting(1);
    const rent = collectRent(db, u, { now: at(toSat) }).then((r) => r, (e) => e);
    await waiting(2);
    await barrier`COMMIT`;
    barrier.release();
    expect(await purchase).toBe("OK");
    const out = await rent;
    expect(out).toEqual([expect.objectContaining({ status: "couch" })]);
    expect(await bal(u)).toBe(240);
  });

  it("the City Purse never pays GM back to anyone", async () => {
    const out = await client`SELECT count(*)::int AS n FROM gm_entries WHERE account_id = ${SYS_PURSE} AND amount < 0`;
    expect(out[0]!.n).toBe(0);
  });
});

describe("Mod Shift", () => {
  it("the server scores the mini-game; a perfect run pays 12 after the shift runs", async () => {
    const u = await makeResident(db);
    const t = at(1, 10);
    const s = await startShift(db, u, { now: t, seed: 4242 });
    expect(s.items).toHaveLength(SHIFT.items);
    // The answers never leave the server: items carry text only, no booleans anywhere.
    expect(s.items.every((i) => Object.keys(i).join() === "text")).toBe(true);
    expect(JSON.stringify(s)).not.toMatch(/\b(true|false)\b/);
    expect(await submitShift(db, u, s.shiftId, shiftPuzzle(4242).answers, { now: new Date(t.getTime() + 20_000) })).toEqual({ score: 10, pay: 12 });
    expect(await code(collectShift(db, u, s.shiftId, { now: new Date(t.getTime() + 14 * MIN) }))).toBe("NOT_DONE");
    expect(await collectShift(db, u, s.shiftId, { now: new Date(t.getTime() + 15 * MIN) })).toEqual({ pay: 12, replayed: false });
    expect(await collectShift(db, u, s.shiftId, { now: new Date(t.getTime() + 60 * MIN) })).toEqual({ pay: 12, replayed: true });
    expect(await bal(u)).toBe(1012);
  });

  it("late, skipped or junk answers pay the base 10", async () => {
    const u = await makeResident(db);
    const t1 = at(1, 8);
    const late = await startShift(db, u, { now: t1, seed: 1 });
    expect(await code(submitShift(db, u, late.shiftId, shiftPuzzle(1).answers, { now: new Date(t1.getTime() + 61_000) }))).toBe("LATE");
    expect((await collectShift(db, u, late.shiftId, { now: new Date(t1.getTime() + 16 * MIN) })).pay).toBe(10);
    const t2 = at(1, 9);
    const junk = await startShift(db, u, { now: t2, seed: 2 });
    expect((await submitShift(db, u, junk.shiftId, { score: 10 }, { now: t2 })).pay).toBe(10);
    expect((await collectShift(db, u, junk.shiftId, { now: new Date(t2.getTime() + 15 * MIN) })).pay).toBe(10);
  });

  it("answers once, and never before the shift started", async () => {
    const u = await makeResident(db);
    const t = at(1, 10);
    const s = await startShift(db, u, { now: t, seed: 9 });
    expect(await code(submitShift(db, u, s.shiftId, [], { now: new Date(t.getTime() - 1000) }))).toBe("LATE");
    await submitShift(db, u, s.shiftId, answersWithWrong(9, 3), { now: t });
    expect(await code(submitShift(db, u, s.shiftId, shiftPuzzle(9).answers, { now: t }))).toBe("ALREADY_SUBMITTED");
  });

  it("one shift at a time, 2 a day, fresh cap tomorrow", async () => {
    const u = await makeResident(db);
    const t = at(1, 10);
    const a = await startShift(db, u, { now: t });
    expect(await code(startShift(db, u, { now: new Date(t.getTime() + 5 * MIN) }))).toBe("SHIFT_IN_PROGRESS");
    await startShift(db, u, { now: new Date(t.getTime() + 15 * MIN) });
    expect(await code(startShift(db, u, { now: new Date(t.getTime() + 40 * MIN) }))).toBe("DAILY_CAP");
    expect(await code(startShift(db, u, { now: at(2, 10) }))).toBe("OK");
    expect(a.shiftId).toBeTruthy();
  });

  it("other people's shifts and made-up ids are not yours", async () => {
    const a = await makeResident(db);
    const b = await makeResident(db);
    const s = await startShift(db, a, { now: at(1) });
    expect(await code(submitShift(db, b, s.shiftId, [], { now: at(1) }))).toBe("NO_SUCH_SHIFT");
    expect(await code(collectShift(db, b, s.shiftId, { now: at(2) }))).toBe("NO_SUCH_SHIFT");
    for (const bad of [randomUUID(), "x", null, 1, "'; DROP TABLE shifts;--"]) expect(await code(collectShift(db, a, bad, { now: at(2) }))).toBe("NO_SUCH_SHIFT");
  });

  it("5 racing starts: one shift; 5 racing collects: paid once", async () => {
    const u = await makeResident(db);
    const t = at(1, 10);
    const starts = await releaseTogether(client, "SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [u], 5,
      Array.from({ length: 5 }, () => () => code(startShift(db, u, { now: t }))));
    expect(starts.map((s) => (s.ok ? s.v : "THREW")).sort()).toEqual(["OK", "SHIFT_IN_PROGRESS", "SHIFT_IN_PROGRESS", "SHIFT_IN_PROGRESS", "SHIFT_IN_PROGRESS"]);
    const [row] = await client`SELECT id FROM shifts WHERE user_id = ${u}`;
    await Promise.all(Array.from({ length: 5 }, () => collectShift(db, u, row!.id, { now: new Date(t.getTime() + 20 * MIN) })));
    expect(await bal(u)).toBe(1010);
  });

  it("no sequence of starts, answers and collects beats 2 shifts and 24 GM a day (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ op: fc.constantFrom("start", "submit", "collect", "away"), minute: fc.integer({ min: 0, max: 2 * 24 * 60 }) }), { maxLength: 25 }),
        async (ops) => {
          const u = await makeResident(db);
          await client`UPDATE users SET proof_of_neighbour_at = now() WHERE id = ${u}`;
          const base = at(1, 0);
          await sayGm(db, u, { now: base });
          await sayGm(db, u, { now: new Date(base.getTime() + DAY) });
          const sorted = [...ops].sort((a, b) => a.minute - b.minute);
          for (const o of sorted) {
            const now = new Date(base.getTime() + o.minute * MIN);
            const [last] = await client`SELECT id, seed FROM shifts WHERE user_id = ${u} ORDER BY started_at DESC LIMIT 1`;
            if (o.op === "start") await startShift(db, u, { now }).catch(() => null);
            if (o.op === "away") await collectAwayShift(db, u, { now }).catch(() => null);
            if (o.op === "submit" && last?.seed) await submitShift(db, u, last.id, shiftPuzzle(last.seed).answers, { now }).catch(() => null);
            if (o.op === "collect" && last) await collectShift(db, u, last.id, { now }).catch(() => null);
          }
          const perDay = await client`
            SELECT s.city_day, count(*)::int AS n, COALESCE(SUM(s.pay) FILTER (WHERE s.collected_tx IS NOT NULL), 0)::int AS paid
            FROM shifts s WHERE s.user_id = ${u} GROUP BY s.city_day`;
          return perDay.every((d) => d.n <= 2 && d.paid <= 24);
        },
      ),
      { numRuns: 15 },
    );
  }, 120_000);
});

describe("the away shift", () => {
  async function ponResident() {
    const u = await makeResident(db);
    await client`UPDATE users SET proof_of_neighbour_at = now() WHERE id = ${u}`;
    return u;
  }

  it("Proof of Neighbour only", async () => {
    const u = await makeResident(db);
    await sayGm(db, u, { now: at(1) });
    expect(await code(collectAwayShift(db, u, { now: at(1, 13) }))).toBe("NOT_PON");
  });

  it("pays 5 within 24 hours of a gm, not after, and not before the gm", async () => {
    const u = await ponResident();
    await sayGm(db, u, { now: at(1, 23, 59) });
    expect(await code(collectAwayShift(db, u, { now: at(1, 23, 0) }))).toBe("NO_RECENT_GM"); // gm hasn't happened yet
    expect(await collectAwayShift(db, u, { now: at(2, 23, 0) })).toEqual({ pay: 5 }); // 23h after
    expect(await code(collectAwayShift(db, u, { now: at(3, 0, 30) }))).toBe("NO_RECENT_GM"); // 24.5h after
  });

  it("one a day, and it takes one of the 2 slots", async () => {
    const u = await ponResident();
    await sayGm(db, u, { now: at(1, 8) });
    await collectAwayShift(db, u, { now: at(1, 9) });
    expect(await code(collectAwayShift(db, u, { now: at(1, 10) }))).toBe("DAILY_CAP");
    await startShift(db, u, { now: at(1, 11) });
    expect(await code(startShift(db, u, { now: at(1, 12) }))).toBe("DAILY_CAP");
    const v = await ponResident();
    await sayGm(db, v, { now: at(1, 8) });
    await startShift(db, v, { now: at(1, 9) });
    await startShift(db, v, { now: at(1, 10) });
    expect(await code(collectAwayShift(db, v, { now: at(1, 11) }))).toBe("DAILY_CAP");
  });
});

describe("the plan's weekly math, end to end", () => {
  it("an active resident creates 679 GM in a settled week and pays 250 rent", async () => {
    const u = await makeResident(db);
    const windowStart = new Date(Date.now() - 1000);
    // Build the streak for a week so the bonus is at its cap.
    for (let d = 0; d < 7; d++) await recordStreakDay(db, u, { now: at(d, 1) });
    const weekStart = new Date();
    for (let d = 7; d < 14; d++) {
      await sayGm(db, u, { now: at(d, 1) });
      await recordStreakDay(db, u, { now: at(d, 1) });
      for (const h of [2, 3]) {
        const s = await startShift(db, u, { now: at(d, h), seed: d * 10 + h });
        await submitShift(db, u, s.shiftId, answersWithWrong(d * 10 + h, 2), { now: at(d, h) }); // score 8: pay 11
        await collectShift(db, u, s.shiftId, { now: at(d, h, 30) });
      }
    }
    const week = await client`
      SELECT t.kind, SUM(e.amount)::int AS gm FROM gm_entries e JOIN gm_transactions t ON t.id = e.tx_id
      WHERE e.account_id = ${userAccountId(u)} AND e.created_at >= ${weekStart.toISOString()} GROUP BY t.kind ORDER BY t.kind`;
    expect(Object.fromEntries(week.map((r) => [r.kind, r.gm]))).toEqual({ drip: 350, mod_shift: 154, streak_bonus: 175 });
    const rent = await collectRent(db, u, { now: at(14) });
    expect(rent.filter((r) => r.status === "paid").length).toBeGreaterThanOrEqual(1);

    const report = await economyReport(db, { from: windowStart, to: new Date(Date.now() + 1000) });
    expect(report.activeWeeklyIncome).toBe(679);
    expect(report.created.drip).toBeGreaterThanOrEqual(350);
    expect(report.destroyed.rent).toBeGreaterThanOrEqual(250);
    expect(report.ratio).not.toBeNull();
  }, 60_000);

  it("the report counts only the mint and the sinks, never transfers", async () => {
    const from = new Date(); // exactly now: earlier tests' residents must not count
    const u = await makeResident(db); // 1000 move-in gift minted
    await buyPiece(db, u, "sofa", randomUUID()); // 300 burned
    const r = await economyReport(db, { from, to: new Date(Date.now() + 1000) });
    expect(r.created.move_in).toBe(1000);
    expect(r.destroyed.furniture).toBe(300);
    expect(r.totalCreated).toBe(1000);
    expect(r.totalDestroyed).toBe(300);
    expect(r.ratio).toBeCloseTo(0.3);
    expect(r.healthyRatio).toBe(false);
  });

  it("an empty window reports no ratio rather than dividing by zero", async () => {
    const far = new Date("2000-01-01T00:00:00Z");
    const r = await economyReport(db, { from: far, to: new Date("2000-01-02T00:00:00Z") });
    expect(r).toMatchObject({ totalCreated: 0, ratio: null, healthyRatio: null, medianActiveBalance: null });
  });
});

describe("database guards (bypassing app code)", () => {
  it("refuses a third shift in a day, a second away shift, and paid rent with no money moved", async () => {
    const u = await makeResident(db);
    const d = addDays(today, 3);
    const ins = (slot: number, kind: "active" | "away") =>
      client`INSERT INTO shifts (user_id, city_day, slot, kind, seed, started_at, ends_at)
             VALUES (${u}, ${d}, ${slot}, ${kind}, ${kind === "active" ? 1 : null}, now(), now())`;
    await ins(1, "away");
    await expect(ins(1, "active")).rejects.toThrow(/shifts_daily_cap/);
    await expect(ins(3, "active")).rejects.toThrow(/shifts_slot/);
    await expect(ins(2, "away")).rejects.toThrow(/shifts_one_away_a_day/);
    await expect(client`INSERT INTO rent_charges (user_id, saturday, status, amount) VALUES (${u}, ${d}, 'paid', 250)`).rejects.toThrow(/rent_charges_paid/);
    await expect(client`INSERT INTO rent_charges (user_id, saturday, status, amount) VALUES (${u}, ${d}, 'couch', 250)`).rejects.toThrow(/rent_charges_unpaid_zero/);
  });
});
