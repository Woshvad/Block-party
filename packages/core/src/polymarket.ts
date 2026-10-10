import type { FeedMarket, MarketCategory, OddsProvider } from "./tower";

// Polymarket's public Gamma API as an odds feed: read-only, no keys. We ask
// for the busiest open events per category tag and turn each YES/NO market
// into a FeedMarket. Multi-market events ("Bitcoin above ___ on Oct 10?") are
// price ladders. The mapping is pure (tested on fixtures); only the provider
// touches the network.

export const GAMMA_URL = "https://gamma-api.polymarket.com";

// Our categories, and the Gamma tag that fills each.
export const POLYMARKET_TAGS: Record<Exclude<MarketCategory, "other">, string> = {
  crypto: "crypto",
  sports: "sports",
  politics: "politics",
  culture: "pop-culture",
};

export type GammaMarket = {
  id: string;
  question: string;
  outcomes?: string; // JSON: ["Yes","No"]
  outcomePrices?: string; // JSON: ["0.53","0.47"]
  endDate?: string;
  gameStartTime?: string | null;
  closed?: boolean;
  acceptingOrders?: boolean;
};
export type GammaEvent = { slug: string; markets?: GammaMarket[] };

const LADDER_FREEZE_MS = 60 * 60_000; // ladder calls close an hour before it settles

function yesPrice(m: GammaMarket): number | null {
  try {
    const outcomes = JSON.parse(m.outcomes ?? "[]") as unknown;
    const prices = JSON.parse(m.outcomePrices ?? "[]") as unknown;
    if (!Array.isArray(outcomes) || !Array.isArray(prices) || outcomes.length !== 2 || outcomes[0] !== "Yes") return null;
    const p = Math.round(Number(prices[0]) * 100);
    return Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

// Gamma events → our feed. Skips anything closed, not trading, already frozen,
// or priced at the extremes (a 99% market is no call at all).
// A ladder keeps only its few rungs nearest 50/50, so one event can't fill the wall.
export function toFeedMarkets(events: readonly GammaEvent[], category: MarketCategory, now: Date, opts: { perCategory?: number; perLadder?: number; minPrice?: number } = {}): FeedMarket[] {
  const limit = opts.perCategory ?? 12;
  const perLadder = opts.perLadder ?? 3;
  const min = opts.minPrice ?? 3;
  const out: FeedMarket[] = [];
  for (const e of events) {
    const ms = e.markets ?? [];
    const ladder = ms.length > 1 ? e.slug : null;
    const rungs: FeedMarket[] = [];
    for (const m of ms) {
      if (m.closed || m.acceptingOrders === false || !m.endDate) continue;
      const price = yesPrice(m);
      if (price === null || price < min || price > 100 - min) continue;
      const settlesBy = new Date(m.endDate);
      if (Number.isNaN(settlesBy.getTime())) continue;
      const kickoff = m.gameStartTime ? new Date(m.gameStartTime) : null;
      const freezesAt = kickoff && !Number.isNaN(kickoff.getTime()) ? kickoff : ladder ? new Date(settlesBy.getTime() - LADDER_FREEZE_MS) : settlesBy;
      if (freezesAt <= now) continue;
      rungs.push({ externalId: `pm:${m.id}`, question: m.question, category, ladder, freezesAt, settlesBy, price, resolved: null, voided: false });
    }
    rungs.sort((a, b) => Math.abs(a.price - 50) - Math.abs(b.price - 50));
    for (const f of rungs.slice(0, perLadder)) {
      if (out.length >= limit) return out;
      out.push(f);
    }
  }
  return out;
}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// The live provider. One request per category; a failed category is skipped,
// and if every one fails it throws, so the poller reads "odds paused".
export function polymarketProvider(opts: { fetch?: Fetch; perCategory?: number; baseUrl?: string } = {}): OddsProvider {
  const get: Fetch = opts.fetch ?? ((url) => fetch(url));
  const base = opts.baseUrl ?? GAMMA_URL;
  return {
    source: "polymarket",
    async fetch(now: Date) {
      let failed = 0;
      const all = await Promise.all(
        (Object.entries(POLYMARKET_TAGS) as [MarketCategory, string][]).map(async ([category, tag]) => {
          const res = await get(`${base}/events?tag_slug=${tag}&active=true&closed=false&order=volume24hr&ascending=false&limit=20`).catch(() => null);
          const body = res?.ok ? await res.json().catch(() => null) : null;
          if (!Array.isArray(body)) {
            failed++;
            return [];
          }
          return toFeedMarkets(body as GammaEvent[], category, now, { perCategory: opts.perCategory });
        }),
      );
      if (failed === Object.keys(POLYMARKET_TAGS).length) throw new Error("polymarket: every category request failed");
      // An event can carry two tags: keep each market once, first category wins.
      const seen = new Set<string>();
      return all.flat().filter((m) => !seen.has(m.externalId) && seen.add(m.externalId));
    },
  };
}
