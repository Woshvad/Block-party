// Real money, safely. Built behind a switch and turned on only after the
// legal opinion. Every amount here is in US cents. The city never holds funds
// or keys; this is the gate, the limits and the record around a trade the
// player's own device signs and sends to Polymarket.

export const REAL = {
  perTradeCap: 100_00, // $100 a trade
  monthlyCapAdult: 500_00, // $500 a month from age 25
  monthlyCapYoung: 250_00, // $250 a month for ages 18 to 24
  youngUntilAge: 25,
  raiseWaitHours: 24,
  timeoutMaxDays: 42, // any length up to 6 weeks
  returnWaitHours: 24, // after a fixed break ends and you ask back: one more day
  builderFeeBps: 50, // our builder fee: 0.5%
  polymarketFeeCapBps: 100, // never more than Polymarket's 1% cap
  realityCheckMinutes: 60,
} as const;

export const TIMEOUTS = { "24h": 1, "1w": 7, "1m": 30 } as const; // or any number of days up to 42
export const EXCLUSIONS = { "6m": 183, "1y": 365, "5y": 1826, forever: null } as const;

export const ageOn = (birthYear: number, at: Date) => at.getUTCFullYear() - birthYear;

// The city's monthly cap, by the birth year the player gave (there's no age check).
export function monthlyCityCap(birthYear: number, at: Date): number {
  return ageOn(birthYear, at) < REAL.youngUntilAge ? REAL.monthlyCapYoung : REAL.monthlyCapAdult;
}

export const isAdult = (birthYear: number, at: Date) => Number.isInteger(birthYear) && ageOn(birthYear, at) >= 18 && birthYear >= 1900;

// Fees shown in dollars before you sign. Polymarket's taker fee is passed in
// (it varies by market); ours is 0.5%, and never more than the 1% cap.
export function feeQuote(amountCents: number, polymarketFeeCents: number) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error("an amount in cents");
  const builder = Math.min(Math.round((amountCents * REAL.builderFeeBps) / 10_000), Math.floor((amountCents * REAL.polymarketFeeCapBps) / 10_000));
  return { amountCents, polymarketFeeCents, builderFeeCents: builder, totalCents: amountCents + polymarketFeeCents + builder };
}

// Why "Back it for real" may not show, in the order a player would hit it.
export type GateReason =
  | "switch_off" // the whole path is off (before the legal opinion)
  | "country_off" // this country's switch is off (off by default)
  | "location" // location checks disagree, or a VPN/proxy
  | "first_session"
  | "mini_app" // never in the Telegram Mini App
  | "not_set_up" // no birth year, declarations or limits yet
  | "excluded"
  | "timeout"
  | "tilt_pause"
  | "market_not_real" // City/Crew markets, duels, the warm-up, up-or-down windows, politics
  | "feed_paused"
  | "over_trade_cap"
  | "over_limit";

export type GateInput = {
  switchOn: boolean;
  countryOn: boolean;
  locationOk: boolean;
  firstSession: boolean;
  inMiniApp: boolean;
  setUp: boolean;
  excludedUntil: Date | null | "forever";
  timeoutUntil: Date | null;
  awaitingReturnUntil: Date | null;
  tiltPauseUntil: Date | null;
  marketReal: boolean;
  feedPaused: boolean;
  amountCents: number | null;
  spentThisWeekCents: number;
  spentThisMonthCents: number;
  lostThisMonthCents: number;
  limits: { weeklyCents: number; monthlyCents: number; lossCents: number } | null;
  monthlyCityCapCents: number;
  now: Date;
};

export function realGate(i: GateInput): { ok: true } | { ok: false; reason: GateReason } {
  const no = (reason: GateReason) => ({ ok: false as const, reason });
  if (!i.switchOn) return no("switch_off");
  if (!i.countryOn) return no("country_off");
  if (!i.locationOk) return no("location");
  if (i.firstSession) return no("first_session");
  if (i.inMiniApp) return no("mini_app");
  if (!i.setUp || !i.limits) return no("not_set_up");
  if (i.excludedUntil === "forever" || (i.excludedUntil && i.now < i.excludedUntil)) return no("excluded");
  if (i.awaitingReturnUntil && i.now < i.awaitingReturnUntil) return no("excluded");
  if (i.timeoutUntil && i.now < i.timeoutUntil) return no("timeout");
  if (i.tiltPauseUntil && i.now < i.tiltPauseUntil) return no("tilt_pause");
  if (!i.marketReal) return no("market_not_real");
  if (i.feedPaused) return no("feed_paused");
  if (i.amountCents !== null) {
    if (i.amountCents > REAL.perTradeCap) return no("over_trade_cap");
    const monthly = Math.min(i.limits.monthlyCents, i.monthlyCityCapCents);
    if (i.spentThisWeekCents + i.amountCents > i.limits.weeklyCents) return no("over_limit");
    if (i.spentThisMonthCents + i.amountCents > monthly) return no("over_limit");
    if (i.lostThisMonthCents >= i.limits.lossCents) return no("over_limit");
  }
  return { ok: true };
}
