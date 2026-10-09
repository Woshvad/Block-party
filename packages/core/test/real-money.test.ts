import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type GateInput, feeQuote, isAdult, monthlyCityCap, realGate } from "../src";

const now = new Date("2030-06-01T12:00:00Z");
const base: GateInput = {
  switchOn: true,
  countryOn: true,
  locationOk: true,
  firstSession: false,
  inMiniApp: false,
  setUp: true,
  excludedUntil: null,
  timeoutUntil: null,
  awaitingReturnUntil: null,
  tiltPauseUntil: null,
  marketReal: true,
  feedPaused: false,
  amountCents: 10_00,
  spentThisWeekCents: 0,
  spentThisMonthCents: 0,
  lostThisMonthCents: 0,
  limits: { weeklyCents: 50_00, monthlyCents: 200_00, lossCents: 100_00 },
  monthlyCityCapCents: 500_00,
  now,
};

describe("real money: the gate", () => {
  it("open only when every check passes", () => {
    expect(realGate(base)).toEqual({ ok: true });
  });

  it("each check closes it, with the reason", () => {
    const later = new Date(now.getTime() + 3_600_000);
    const cases: Array<[Partial<GateInput>, string]> = [
      [{ switchOn: false }, "switch_off"],
      [{ countryOn: false }, "country_off"],
      [{ locationOk: false }, "location"],
      [{ firstSession: true }, "first_session"],
      [{ inMiniApp: true }, "mini_app"],
      [{ setUp: false }, "not_set_up"],
      [{ limits: null }, "not_set_up"],
      [{ excludedUntil: "forever" }, "excluded"],
      [{ excludedUntil: later }, "excluded"],
      [{ awaitingReturnUntil: later }, "excluded"],
      [{ timeoutUntil: later }, "timeout"],
      [{ tiltPauseUntil: later }, "tilt_pause"],
      [{ marketReal: false }, "market_not_real"],
      [{ feedPaused: true }, "feed_paused"],
      [{ amountCents: 100_01 }, "over_trade_cap"],
      [{ spentThisWeekCents: 45_00 }, "over_limit"],
      [{ spentThisMonthCents: 195_00 }, "over_limit"],
      [{ monthlyCityCapCents: 5_00 }, "over_limit"], // the city cap sits above the player's own
      [{ lostThisMonthCents: 100_00 }, "over_limit"],
    ];
    for (const [over, reason] of cases) expect(realGate({ ...base, ...over }), reason).toEqual({ ok: false, reason });
  });

  it("past breaks don't block; the switch beats everything", () => {
    const before = new Date(now.getTime() - 1);
    expect(realGate({ ...base, excludedUntil: before, timeoutUntil: before, tiltPauseUntil: before, awaitingReturnUntil: before })).toEqual({ ok: true });
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (a, b, c) => {
        expect(realGate({ ...base, switchOn: false, firstSession: a, inMiniApp: b, feedPaused: c })).toEqual({ ok: false, reason: "switch_off" });
      }),
    );
  });
});

describe("real money: caps and fees", () => {
  it("$250 a month for 18 to 24, $500 from 25; 18+ by the birth year given", () => {
    expect(monthlyCityCap(2010, now)).toBe(250_00); // 20
    expect(monthlyCityCap(2005, now)).toBe(500_00); // 25
    expect(isAdult(2012, now)).toBe(true);
    expect(isAdult(2013, now)).toBe(false);
    expect(isAdult(1850, now)).toBe(false);
    expect(isAdult(2000.5, now)).toBe(false);
  });

  it("a $10 trade: our fee is 5¢ at 0.5%, never more than the 1% cap", () => {
    expect(feeQuote(10_00, 35)).toEqual({ amountCents: 1000, polymarketFeeCents: 35, builderFeeCents: 5, totalCents: 1040 });
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_00 }), (a) => {
        const q = feeQuote(a, 0);
        expect(q.builderFeeCents).toBeLessThanOrEqual(Math.floor(a / 100));
      }),
      { seed: 39, numRuns: 2000 },
    );
    expect(() => feeQuote(0, 0)).toThrow();
  });
});
