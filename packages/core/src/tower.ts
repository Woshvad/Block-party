// The Prediction Tower: markets, odds, calls and Aura. Prices and chances are
// whole percentage points (1 to 99), so every score is exact integer math.

export const TOWER = {
  maxSlip: 2, // a call locks at the next tick only within 2 points of what you saw
  sliderStart: 10, // the slider starts 10 points past the market, on your side
  halfAuraLastMinutes: 30, // off-slate calls this close to the freeze earn half
  ticketsPerDay: 3,
  ticketsMax: 9,
  tailsPerDay: 2,
  cityBarMin: 10, // neighbours before the City bar shows
  crewBarMin: 3, // crewmates before the Crew bar shows
  feedPausedAfterSeconds: 180, // no good poll for this long: "odds paused"
  pendingExpiresSeconds: 300, // a call still waiting for a tick after this is dropped
  // The Watch Party Hall's in-play calls, on a match after kickoff: free calls
  // that lock at the first tick at least 2 minutes after you confirm (still
  // within maxSlip of what you saw), for half the Aura.
  inPlayDelaySeconds: 120,
  inPlayHours: 4, // a match is looked up for its live price this long after kickoff, at most
} as const;

export const MARKET_CATEGORIES = ["crypto", "sports", "politics", "culture", "other"] as const;
export type MarketCategory = (typeof MARKET_CATEGORIES)[number];
export type Side = "yes" | "no";

const isPct = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 99;

// --- Aura ---------------------------------------------------------------------

// Aura in hundredths: 100 × [(o − q_market)² − (o − q_you)²] with q in percent
// is ((100o − m)² − (100o − y)²) / 100, so hundredths are an exact integer.
// Runs from −10,000 to +10,000 (−100 to +100). Halved calls round toward zero.
export function auraCenti(outcomeYes: boolean, marketPct: number, youPct: number, half = false): number {
  if (!isPct(marketPct) || !isPct(youPct)) throw new Error("prices are whole percents, 1 to 99");
  const o = outcomeYes ? 100 : 0;
  const full = (o - marketPct) ** 2 - (o - youPct) ** 2;
  return half ? Math.trunc(full / 2) : full;
}

// The slider only moves on your side of the market's price: YES above it, NO
// below it (you can still say "about the same" by 1 point).
export function chanceOnSide(side: Side, marketPct: number, chance: unknown): chance is number {
  if (!isPct(chance) || !isPct(marketPct)) return false;
  return side === "yes" ? chance > marketPct : chance < marketPct;
}

export function sliderStart(side: Side, marketPct: number): number {
  return side === "yes" ? Math.min(99, marketPct + TOWER.sliderStart) : Math.max(1, marketPct - TOWER.sliderStart);
}

// A call can't exist when the market is pinned at an edge with no room on your side.
export const sideOpen = (side: Side, marketPct: number) => (side === "yes" ? marketPct < 99 : marketPct > 1);

// --- Tickets -------------------------------------------------------------------

// 3 a day, stacking up to 9: the balance as of `day`, from a stored balance as of `asOf`.
export function ticketsAfter(balance: number, daysSince: number): number {
  if (daysSince <= 0) return Math.min(balance, TOWER.ticketsMax);
  return Math.min(TOWER.ticketsMax, balance + TOWER.ticketsPerDay * daysSince);
}

// --- The crowd -----------------------------------------------------------------

// The city's view: the median of neighbours' first chances, one head one vote.
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function vibeGap(world: number, city: number | null): number | null {
  return city === null ? null : city - world;
}

// --- The odds feed ----------------------------------------------------------------

// What a feed tells us about a market (Polymarket's API in production).
export type FeedMarket = {
  externalId: string;
  question: string;
  category: MarketCategory;
  ladder: string | null; // price-ladder group, e.g. "btc-above-2026-10-10"
  freezesAt: Date; // calls close (kickoff, or 60 min before a ladder settles)
  settlesBy: Date;
  price: number; // YES, whole percent
  resolved: boolean | null; // null: not yet; true/false: YES/NO happened
  voided: boolean;
  closed?: boolean; // trading has stopped: frozen from now on, until the result is final
  // A sports market past kickoff that still trades: `price` is its live
  // price, for the Watch Party Hall's in-play calls only. The market stays
  // frozen for everything else (the Floor, the Slate, duels, real money).
  inPlay?: boolean;
};

// A market the database holds that isn't final yet, as we last stored it.
export type KnownMarket = Omit<FeedMarket, "resolved" | "voided" | "closed" | "inPlay"> & {
  // Something rides on it (a call, a duel, a Slate card): its result is
  // looked up before any other market's.
  held?: boolean;
  // It must stay callable while it trades, listed or not: a card on today's
  // Slate, or a call waiting to lock.
  live?: boolean;
  // A sports market frozen at kickoff in the last few hours (TOWER.inPlayHours):
  // its live price is looked up for the Watch Party Hall's in-play calls.
  inPlay?: boolean;
};

export interface OddsProvider {
  readonly source: string;
  // `known` is this source's markets we still hold open or frozen. A feed that
  // only lists what's trading (Polymarket) looks those up again by id, so a
  // market that has left its listing can still close, resolve or void.
  fetch(now: Date, known?: readonly KnownMarket[]): Promise<FeedMarket[]>;
}

// --- A deterministic mock feed (development and tests) -------------------------

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export type MockMarketSpec = {
  externalId: string;
  question: string;
  category: MarketCategory;
  ladder?: string | null;
  openAt: Date;
  freezesAt: Date;
  settlesBy: Date;
  start: number; // starting price
  outcome?: boolean; // what happens at settlesBy (default: decided by the walk)
  voided?: boolean;
  inPlay?: boolean; // a match: it trades on from kickoff until it settles, for the Hall's in-play calls
};

// Prices take a seeded walk of ±3 points a minute, so any moment's price is a
// pure function of (market, minute): replayable, and the same for every poller.
export function mockPrice(spec: MockMarketSpec, at: Date): number {
  const minutes = Math.max(0, Math.floor((Math.min(at.getTime(), spec.freezesAt.getTime()) - spec.openAt.getTime()) / 60_000));
  let p = spec.start;
  const steps = Math.min(minutes, 60 * 24 * 14); // loop-bound: at most two weeks of minutes
  for (let m = 1; m <= steps; m++) {
    p += (hash(`${spec.externalId}:${m}`) % 7) - 3;
    p = Math.min(97, Math.max(3, p));
  }
  return p;
}

// A match's price in play: the same walk, carried on past kickoff, until it settles.
export function mockLivePrice(spec: MockMarketSpec, at: Date): number {
  const end = at < spec.settlesBy ? at : spec.settlesBy;
  return mockPrice({ ...spec, freezesAt: spec.settlesBy }, end);
}

export function mockProvider(specs: () => readonly MockMarketSpec[]): OddsProvider {
  return {
    source: "mock",
    async fetch(now) {
      return specs()
        .filter((s) => s.openAt <= now)
        .map((s) => {
          const price = mockPrice(s, now);
          const settled = now >= s.settlesBy;
          // Between kickoff and the result, a match trades on, in play.
          const inPlay = !!s.inPlay && !s.voided && now >= s.freezesAt && !settled;
          return {
            externalId: s.externalId,
            question: s.question,
            category: s.category,
            ladder: s.ladder ?? null,
            freezesAt: s.freezesAt,
            settlesBy: s.settlesBy,
            price: inPlay ? mockLivePrice(s, now) : price,
            // A match settles where its play ended, not where it kicked off.
            resolved: settled && !s.voided ? (s.outcome ?? (s.inPlay ? mockLivePrice(s, s.settlesBy) : price) >= 50) : null,
            voided: settled && !!s.voided,
            ...(inPlay ? { inPlay: true } : {}),
          };
        });
    },
  };
}

// The credit line under odds we show. Only Polymarket's own prices carry its
// name; the sample feed's are made up, and say so.
export function oddsCredit(source: string): string {
  return source === "polymarket" ? "Odds via Polymarket · Not affiliated" : "Sample odds · Not real";
}

// A rolling set of sample markets for development and staging: each city day
// gets a handful across the tiers and categories, so the Floor is never empty.
// They're invented: shown under oddsCredit("mock"), never Polymarket's name.
export function sampleMarkets(now: Date, days = 3): MockMarketSpec[] {
  const out: MockMarketSpec[] = [];
  const day0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const kinds: Array<[string, MarketCategory, number, string | null]> = [
    ["Bitcoin above the line at noon New York time?", "crypto", 78, "btc-ladder"],
    ["Ethereum above the line at noon New York time?", "crypto", 55, "eth-ladder"],
    ["Home side wins tonight's EPL fixture?", "sports", 45, null],
    ["Over 220.5 points in tonight's NBA game?", "sports", 30, null],
    ["New all-time high for SOL this week?", "crypto", 12, null],
    ["Chart-topping single changes this week?", "culture", 62, null],
    ["Will a senator post about stablecoins today?", "politics", 40, null],
  ];
  for (let d = -1; d < days; d++) {
    const dayStart = day0 + d * 86_400_000;
    for (const [i, [question, category, start, ladder]] of kinds.entries()) {
      const date = new Date(dayStart).toISOString().slice(0, 10);
      out.push({
        externalId: `sample:${date}:${i}`,
        question,
        category,
        ladder: ladder ? `${ladder}-${date}` : null,
        openAt: new Date(dayStart - 12 * 3_600_000),
        freezesAt: new Date(dayStart + 15 * 3_600_000 + i * 600_000),
        settlesBy: new Date(dayStart + 16 * 3_600_000 + i * 600_000),
        start,
        ...(category === "sports" ? { inPlay: true } : {}),
      });
    }
  }
  // A pickup game kicks off at half past every third hour and plays for two,
  // so the Watch Party Hall has a match in play most of the day, whenever
  // someone's trying it. Fixed per slot, so every poller sees the same ones.
  const slot = 3 * 3_600_000;
  const first = Math.floor(now.getTime() / slot) * slot + 30 * 60_000;
  for (let k = -1; k <= 1; k++) {
    const kickoff = first + k * slot;
    out.push({
      externalId: `sample:pickup:${new Date(kickoff).toISOString()}`,
      question: "Pickup game at the Hall: home side wins?",
      category: "sports",
      openAt: new Date(kickoff - 2 * 3_600_000),
      freezesAt: new Date(kickoff),
      settlesBy: new Date(kickoff + 2 * 3_600_000),
      start: 50,
      inPlay: true,
    });
  }
  return out;
}
