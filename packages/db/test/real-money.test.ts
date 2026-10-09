import { randomUUID } from "node:crypto";
import type { FeedMarket, OddsProvider } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RealMoneyError,
  askBack,
  changeLimit,
  confirmRaise,
  createDb,
  ensureSystemAccounts,
  grantMood,
  pollOdds,
  realTradeGate,
  setCountrySwitch,
  setupReal,
  takeBreak,
} from "../src";
import { makeResident } from "./helpers";

const { db, client, close } = createDb(process.env.TEST_DATABASE_URL!, { max: 30 });
const H = 3_600_000;
const D = 24 * H;
const now = new Date("2044-05-10T12:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);
const limits = { weeklyCents: 50_00, monthlyCents: 200_00, lossCents: 100_00 };
const setup = (u: string, over: Record<string, unknown> = {}) => setupReal(db, u, { birthYear: 1990, notRestricted: true, noVpn: true, ...limits, ...over }, { now });
const gate = (u: string, over: Record<string, unknown> = {}, at = now) =>
  realTradeGate(db, u, { switchOn: true, country: "ZZ", locationOk: true, firstSession: false, inMiniApp: false, ...over }, { now: at });

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    if (e instanceof RealMoneyError) return e.code;
    throw e;
  }
}

let staff = "";
beforeAll(async () => {
  await ensureSystemAccounts(db);
  staff = await makeResident(db);
  await client`INSERT INTO staff (user_id, role) VALUES (${staff}, 'admin')`;
  await setCountrySwitch(db, staff, "ZZ", true, { now });
});
afterAll(close);

describe("setting up", () => {
  it("18+ by the year given, both declarations, and limits first", async () => {
    expect(await code(setup(await makeResident(db), { birthYear: 2030 }))).toBe("UNDER_18");
    expect(await code(setup(await makeResident(db), { noVpn: false }))).toBe("INVALID_INPUT");
    expect(await code(setup(await makeResident(db), { lossCents: 0 }))).toBe("INVALID_INPUT");
    const u = await makeResident(db);
    expect(await code(setup(u))).toBe("OK");
    expect(await code(setup(u))).toBe("INVALID_INPUT");
  });
});

describe("limits", () => {
  it("lower at once; higher waits 24 hours and asks again; a lower one cancels a pending raise", async () => {
    const u = await makeResident(db);
    await setup(u);
    expect(await changeLimit(db, u, "weekly", 30_00, { now })).toEqual({ applied: true });
    const r = await changeLimit(db, u, "weekly", 90_00, { now });
    expect(r.applied).toBe(false);
    const id = (r as { raiseId: string }).raiseId;
    expect(await code(confirmRaise(db, u, id, { now: later(23 * H) }))).toBe("NOT_YET");
    expect(await code(confirmRaise(db, await makeResident(db), id, { now: later(25 * H) }))).toBe("NO_SUCH_RAISE");
    await confirmRaise(db, u, id, { now: later(25 * H) });
    expect((await client`SELECT weekly_cents FROM real_profiles WHERE user_id = ${u}`)[0]!.weekly_cents).toBe(90_00);
    const r2 = await changeLimit(db, u, "loss", 500_00, { now });
    await changeLimit(db, u, "loss", 50_00, { now });
    expect(await code(confirmRaise(db, u, (r2 as { raiseId: string }).raiseId, { now: later(2 * D) }))).toBe("NO_SUCH_RAISE");
    expect(await code(changeLimit(db, u, "daily", 10, { now }))).toBe("INVALID_INPUT");
  });
});

describe("breaks", () => {
  it("a time-out can't end early; after it ends, real money waits until you ask, then a day more", async () => {
    const u = await makeResident(db);
    await setup(u);
    expect(await gate(u)).toEqual({ ok: true });
    await takeBreak(db, u, "timeout", "24h", { now });
    expect(await gate(u, {}, later(H))).toEqual({ ok: false, reason: "timeout" });
    expect(await code(askBack(db, u, { now: later(H) }))).toBe("ON_A_BREAK");
    const [b] = await client`SELECT id FROM real_breaks WHERE user_id = ${u}`;
    await expect(client`UPDATE real_breaks SET ends_at = ${now.toISOString()} WHERE id = ${b!.id}`).rejects.toThrow(/never shortened/);
    await expect(client`DELETE FROM real_breaks WHERE id = ${b!.id}`).rejects.toThrow(/never deleted/);
    expect(await gate(u, {}, later(2 * D))).toEqual({ ok: false, reason: "excluded" }); // ended, not asked back
    await askBack(db, u, { now: later(2 * D) });
    expect(await gate(u, {}, later(2 * D + 23 * H))).toEqual({ ok: false, reason: "excluded" }); // one more day
    expect(await gate(u, {}, later(3 * D + H))).toEqual({ ok: true });
  });

  it("self-exclusion for good never lifts; lengths are the plan's", async () => {
    const u = await makeResident(db);
    await setup(u);
    await takeBreak(db, u, "exclusion", "forever", { now });
    expect(await gate(u, {}, later(3650 * D))).toEqual({ ok: false, reason: "excluded" });
    expect(await code(askBack(db, u, { now: later(3650 * D) }))).toBe("ON_A_BREAK");
    const [b] = await client`SELECT id FROM real_breaks WHERE user_id = ${u}`;
    await expect(client`UPDATE real_breaks SET ends_at = now() WHERE id = ${b!.id}`).rejects.toThrow(/never shortened/);
    for (const bad of [["timeout", 43], ["timeout", 0], ["timeout", "2w"], ["exclusion", "2y"], ["nap", "1y"]]) expect(await code(takeBreak(db, u, bad[0], bad[1], { now }))).toBe("INVALID_INPUT");
    expect((await takeBreak(db, u, "timeout", 42, { now })).endsAt).toEqual(later(42 * D));
  });
});

describe("the gate", () => {
  it("the switch, the country, set-up, tilt, the market and the money all close it", async () => {
    const u = await makeResident(db);
    expect(await gate(u, { switchOn: false })).toEqual({ ok: false, reason: "switch_off" });
    expect(await gate(u, { country: "YY" })).toEqual({ ok: false, reason: "country_off" }); // off by default
    expect(await gate(u)).toEqual({ ok: false, reason: "not_set_up" });
    await setup(u);
    expect(await code(setCountrySwitch(db, u, "YY", true))).toBe("NOT_STAFF");
    await grantMood(db, u, "tilted", { now });
    expect(await gate(u, {}, later(H))).toEqual({ ok: false, reason: "tilt_pause" }); // until the next bell
    expect(await gate(u, {}, later(13 * H))).toEqual({ ok: true });
    // Markets: politics never; an open sports market yes.
    const ms = new Map<string, FeedMarket>();
    const provider: OddsProvider = { source: "real-test", fetch: async () => [...ms.values()].map((m) => ({ ...m })) };
    for (const c of ["politics", "sports"] as const) {
      const m: FeedMarket = { externalId: `${c}-${randomUUID()}`, question: `${c}?`, category: c, ladder: null, freezesAt: later(10 * D), settlesBy: later(11 * D), price: 50, resolved: null, voided: false };
      ms.set(m.externalId, m);
    }
    const t = later(2 * D);
    await pollOdds(db, provider, { now: t });
    const [pol] = await client`SELECT id FROM markets WHERE source = 'real-test' AND category = 'politics' ORDER BY created_at DESC LIMIT 1`;
    const [spo] = await client`SELECT id FROM markets WHERE source = 'real-test' AND category = 'sports' ORDER BY created_at DESC LIMIT 1`;
    expect(await gate(u, { marketId: pol!.id }, t)).toEqual({ ok: false, reason: "market_not_real" });
    expect(await gate(u, { marketId: spo!.id, amountCents: 100_01 }, t)).toEqual({ ok: false, reason: "over_trade_cap" });
    expect(await gate(u, { marketId: spo!.id, amountCents: 40_00 }, t)).toEqual({ ok: true });
    // Money already in this week counts against the weekly limit.
    await client`INSERT INTO real_trades (user_id, market_id, side, amount_cents, polymarket_fee_cents, builder_fee_cents, status, created_at) VALUES (${u}, ${spo!.id}, 'yes', 4000, 0, 20, 'filled', ${t.toISOString()})`;
    expect(await gate(u, { marketId: spo!.id, amountCents: 20_00 }, t)).toEqual({ ok: false, reason: "over_limit" });
    expect(await gate(u, { firstSession: true })).toEqual({ ok: false, reason: "first_session" });
    expect(await gate(u, { inMiniApp: true })).toEqual({ ok: false, reason: "mini_app" });
    expect(await gate(u, { locationOk: false })).toEqual({ ok: false, reason: "location" });
  });

  it("18 to 24: the city's $250 a month sits above a higher personal limit", async () => {
    const u = await makeResident(db);
    await setupReal(db, u, { birthYear: 2024, notRestricted: true, noVpn: true, weeklyCents: 10_000_00, monthlyCents: 10_000_00, lossCents: 10_000_00 }, { now }); // 20 in 2044
    const ms = new Map<string, FeedMarket>();
    const m: FeedMarket = { externalId: `young-${randomUUID()}`, question: "Young?", category: "sports", ladder: null, freezesAt: later(10 * D), settlesBy: later(11 * D), price: 50, resolved: null, voided: false };
    ms.set(m.externalId, m);
    await pollOdds(db, { source: "real-young", fetch: async () => [...ms.values()] }, { now });
    const [mk] = await client`SELECT id FROM markets WHERE external_id = ${m.externalId}`;
    for (let i = 0; i < 2; i++) await client`INSERT INTO real_trades (user_id, market_id, side, amount_cents, polymarket_fee_cents, builder_fee_cents, status, created_at) VALUES (${u}, ${mk!.id}, 'yes', 10000, 0, 50, 'filled', ${now.toISOString()})`;
    expect(await gate(u, { marketId: mk!.id, amountCents: 50_00 })).toEqual({ ok: true }); // 250 exactly
    expect(await gate(u, { marketId: mk!.id, amountCents: 50_01 })).toEqual({ ok: false, reason: "over_limit" });
  });
});
