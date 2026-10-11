import { randomUUID } from "node:crypto";
import { crewPotAccountId, lightsAccountId } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LightsError, bidLights, createCrew, createDb, createInvite, depositToPot, ensureSystemAccounts, getBalance, lightsBoard, lightsWinner, redeemInvite, reel, runBell, setDeputy, settleLights, supplyStats } from "../src";
import { makeResident, releaseTogether } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const H = 3_600_000;
const D = 24 * H;
let day0 = Date.parse("2042-08-04T00:00:00Z");
const freshDay = () => (day0 += 10 * D);
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const pot = (c: string) => getBalance(db, crewPotAccountId(c));

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof LightsError) return e.code;
    throw e;
  }
}
// A crew with a lead, a deputy and a member, and GM in the pot (from the lead and the deputy).
async function crew(potGm = 1800) {
  const [lead, deputy, member] = [await makeResident(db), await makeResident(db), await makeResident(db)];
  const c = await createCrew(db, lead, { name: `Lights ${randomUUID().slice(0, 6)}` });
  for (const u of [deputy, member]) await redeemInvite(db, u, (await createInvite(db, lead)).code);
  await setDeputy(db, lead, deputy, true);
  if (potGm > 0) await depositToPot(db, lead, Math.min(900, potGm), `pot:${randomUUID()}`);
  if (potGm > 900) await depositToPot(db, deputy, potGm - 900, `pot:${randomUUID()}`);
  return { id: c.id, name: c.name, lead, deputy, member };
}

beforeAll(() => ensureSystemAccounts(db));
afterAll(close);

describe("Tower Lights", () => {
  it("the lead or a deputy bids from the pot, at the reserve or more, and only raises", async () => {
    const d0 = freshDay();
    const at = new Date(d0 + 10 * H);
    const c = await crew();
    expect(await code(bidLights(db, c.member, 1200, { now: at }))).toBe("NOT_ALLOWED");
    expect(await code(bidLights(db, c.lead, 999, { now: at }))).toBe("UNDER_RESERVE");
    expect(await bidLights(db, c.lead, 1200, { now: at })).toMatchObject({ amount: 1200 });
    expect(await pot(c.id)).toBe(600);
    expect(await code(bidLights(db, c.deputy, 1200, { now: at }))).toBe("NOT_HIGHER");
    await bidLights(db, c.deputy, 1500, { now: at }); // a raise takes only the difference
    expect(await pot(c.id)).toBe(300);
    expect(await getBalance(db, lightsAccountId(dayOf(d0)))).toBe(1500);
    expect(await code(bidLights(db, c.lead, 5000, { now: at }))).toBe("NOT_ENOUGH_GM");
    expect(await code(bidLights(db, c.lead, 1.5, { now: at }))).toBe("INVALID_INPUT");
  });

  it("the Tower shows the top bid all day, and tells a crew it's been outbid", async () => {
    const d0 = freshDay();
    const at = new Date(d0 + 10 * H);
    const [a, b] = [await crew(), await crew()];
    await bidLights(db, a.lead, 1100, { now: at });
    await bidLights(db, b.lead, 1300, { now: at });
    expect(await lightsBoard(db, a.id, { now: at })).toMatchObject({ reserve: 1000, top: { crew: b.name, amount: 1300 }, mine: { amount: 1100, leading: false, outbidBy: b.name } });
    expect((await lightsBoard(db, b.id, { now: at })).mine).toMatchObject({ leading: true, outbidBy: null });
  });

  it("at the bell the top bid burns and lights the Tower; the rest go home", async () => {
    const d0 = freshDay();
    // Earlier tests leave their days' bids open, and the bell settles every
    // open day up to its own: settle those first so only tonight's count here.
    await settleLights(db, dayOf(d0 - D));
    const at = new Date(d0 + 10 * H);
    const [a, b] = [await crew(), await crew()];
    await bidLights(db, a.lead, 1100, { now: at });
    await bidLights(db, b.lead, 1300, { now: at });
    const burned0 = (await supplyStats(db)).destroyed;
    const r = await runBell(db, { now: new Date(d0 + D + 60_000), only: ["tower"] });
    expect(r.ran.tower).toMatchObject({ lightsBurned: 1300 });
    expect(await pot(a.id)).toBe(1800); // refunded in full
    expect(await pot(b.id)).toBe(500);
    expect((await supplyStats(db)).destroyed - burned0).toBe(1300);
    expect(await getBalance(db, lightsAccountId(dayOf(d0)))).toBe(0);
    expect((await reel(db, a.lead, { now: new Date(d0 + D + 120_000) }))!.towerLights).toEqual({ crew: b.name, amount: 1300 });
  });

  it("a day whose bell never ran is settled by the next bell, not left in escrow", async () => {
    const d0 = freshDay();
    await settleLights(db, dayOf(d0 - D)); // as above: only this test's bids
    const at = new Date(d0 + 10 * H);
    const [a, b] = [await crew(), await crew()];
    await bidLights(db, a.lead, 1100, { now: at });
    await bidLights(db, b.lead, 1300, { now: at });
    // d0's bell never runs (the cron was down all day); the next night's does.
    const r = await runBell(db, { now: new Date(d0 + 2 * D + 60_000), only: ["tower"] });
    expect(r.ran.tower).toMatchObject({ lightsBurned: 1300 });
    expect(await pot(a.id)).toBe(1800);
    expect(await pot(b.id)).toBe(500);
    expect(await getBalance(db, lightsAccountId(dayOf(d0)))).toBe(0);
    expect(await lightsWinner(db, dayOf(d0))).toEqual({ crew: b.name, amount: 1300 });
  });

  it("racing bids from two crews: the books always balance", async () => {
    const d0 = freshDay();
    const at = new Date(d0 + 10 * H);
    const [a, b] = [await crew(), await crew()];
    const res = await releaseTogether(client, "SELECT pg_advisory_xact_lock(hashtext($1))", [`lights:${dayOf(d0)}`], 2, [() => code(bidLights(db, a.lead, 1400, { now: at })), () => code(bidLights(db, b.lead, 1400, { now: at }))]);
    expect(res.every((r) => r.ok && r.v === "OK")).toBe(true);
    expect(await getBalance(db, lightsAccountId(dayOf(d0)))).toBe(2800);
  });

  it("after a week of winners the reserve is half the median winning bid", async () => {
    const d0 = freshDay();
    const filler = await crew(0);
    const someone = filler.lead;
    for (let i = 1; i <= 7; i++) {
      await client`INSERT INTO light_bids (city_day, crew_id, amount, placed_by, status, at) VALUES (${dayOf(d0 - i * D)}, ${filler.id}, ${1000 + i * 200}, ${someone}, 'won', now())`;
    }
    // Winning bids 1200..2400: median 1800, so the reserve is 900.
    expect((await lightsBoard(db, null, { now: new Date(d0 + H) })).reserve).toBe(900);
  });
});
