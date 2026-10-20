import type { FeedMarket, KnownMarket, MarketCategory, OddsProvider } from "./tower";

// Polymarket's public Gamma API as an odds feed: read-only, no keys. We ask
// for the busiest open events per category tag and turn each YES/NO market
// into a FeedMarket. Multi-market events ("Bitcoin above ___ on Oct 10?") are
// price ladders. Markets we already hold are looked up again by id: that's how
// they freeze, resolve or void once they've left the listing, how the ones
// that must stay callable (today's Slate, a call waiting to lock) keep their
// price while they trade, and how a match keeps a live price after kickoff
// for the Watch Party Hall's in-play calls. The mapping is pure (tested on recorded payloads);
// only the provider touches the network.

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
  outcomePrices?: string; // JSON: ["0.53","0.47"]; once paid out ["1","0"], ["0","1"] or ["0.5","0.5"]
  endDate?: string;
  gameStartTime?: string | null;
  closed?: boolean;
  acceptingOrders?: boolean;
  umaResolutionStatus?: string; // "proposed", "disputed", "resolved"
  slug?: string; // the warm-up's 15-minute windows are found by slug ("btc-updown-15m-<start>")
  eventStartTime?: string; // and say here when they open
};
export type GammaEvent = { slug: string; markets?: GammaMarket[] };

const LADDER_FREEZE_MS = 60 * 60_000; // ladder calls close an hour before it settles
const REQUEST_TIMEOUT_MS = 8_000; // per request, so one hung category can't hold up the poll
const IDS_PER_LOOKUP = 100; // Gamma refuses more ids than this in one request
export const MAX_KNOWN_LOOKUPS = 500; // closed lookups a poll: 5 requests
const MAX_LIVE_LOOKUPS = 200; // trading lookups a poll, for markets that must stay callable: 2 requests
const MAX_IN_PLAY_LOOKUPS = 200; // matches looked up in play a poll, latest kickoff first: 2 requests
const MIN_PRICE = 3; // whole percent: a 97% market is no call at all

// Why markets were left out of a poll: the counts say when the API has
// changed shape (everything "unreadable") rather than just moved on.
export type Skips = { closed: number; notTrading: number; unpriced: number; frozen: number; extreme: number; notYesNo: number; unreadable: number };
export const noSkips = (): Skips => ({ closed: 0, notTrading: 0, unpriced: 0, frozen: 0, extreme: 0, notYesNo: 0, unreadable: 0 });
const describeSkips = (s: Skips) =>
  `skipped ${s.closed} closed, ${s.notTrading} not trading, ${s.unpriced} unpriced, ${s.frozen} frozen, ${s.extreme} at an extreme, ${s.notYesNo} not YES/NO, ${s.unreadable} unreadable`;

// Outcomes and prices come as JSON strings. null when they don't read as two
// lists of the same length with numeric prices.
function readOutcomes(m: GammaMarket): { names: unknown[]; prices: number[] } | null {
  try {
    const names = JSON.parse(m.outcomes ?? "") as unknown;
    const prices = JSON.parse(m.outcomePrices ?? "") as unknown;
    if (!Array.isArray(names) || !Array.isArray(prices) || names.length === 0 || names.length !== prices.length) return null;
    const ps = prices.map((p) => (typeof p === "string" || typeof p === "number" ? Number(p) : NaN));
    return ps.every(Number.isFinite) ? { names, prices: ps } : null;
  } catch {
    return null;
  }
}

// A two-outcome market whose outcomes are exactly these, in this order: YES/NO
// for the Tower, Up/Down for the warm-up's Bitcoin windows.
export type OutcomePair = readonly [string, string];
const YES_NO: OutcomePair = ["Yes", "No"];
const isPair = (names: unknown[], pair: OutcomePair) => names.length === 2 && names[0] === pair[0] && names[1] === pair[1];
const isYesNo = (names: unknown[]) => isPair(names, YES_NO);
export function outcomesAre(m: GammaMarket, pair: OutcomePair): boolean {
  const o = readOutcomes(m);
  return !!o && isPair(o.names, pair);
}

// One trading Gamma market as a FeedMarket, or null (counted in `skipped`)
// when it's closed, not trading, already frozen, or priced at the extremes.
// `inPlay`: a match we hold, looked up after kickoff. Past its freeze it
// comes back marked in play, at its live price, rather than skipped.
function feedMarketOf(m: GammaMarket, category: MarketCategory, ladder: string | null, now: Date, min: number, skipped: Skips, inPlay = false): FeedMarket | null {
  if (m.closed) {
    skipped.closed++;
    return null;
  }
  if (m.acceptingOrders === false) {
    skipped.notTrading++;
    return null;
  }
  // Placeholder markets ("Will [Placeholder X] win...?") carry no prices yet.
  if (m.outcomePrices == null) {
    skipped.unpriced++;
    return null;
  }
  const o = readOutcomes(m);
  const settlesBy = new Date(m.endDate ?? "");
  if (!o || Number.isNaN(settlesBy.getTime())) {
    skipped.unreadable++;
    return null;
  }
  if (!isYesNo(o.names)) {
    skipped.notYesNo++;
    return null;
  }
  const price = Math.round(o.prices[0]! * 100);
  if (price < min || price > 100 - min) {
    skipped.extreme++;
    return null;
  }
  const start = m.gameStartTime ? new Date(m.gameStartTime) : null;
  const kickoff = start && !Number.isNaN(start.getTime()) ? start : null;
  const freezesAt = kickoff ?? (ladder ? new Date(settlesBy.getTime() - LADDER_FREEZE_MS) : settlesBy);
  if (freezesAt <= now) {
    // Only a game with a kickoff plays on (one of an event's several markets
    // too: a match's win, draw and loss come as one event); a price ladder,
    // or a market that just ends, doesn't.
    if (inPlay && kickoff) return { externalId: `pm:${m.id}`, question: m.question, category, ladder, freezesAt, settlesBy, price, resolved: null, voided: false, inPlay: true };
    skipped.frozen++;
    return null;
  }
  return { externalId: `pm:${m.id}`, question: m.question, category, ladder, freezesAt, settlesBy, price, resolved: null, voided: false };
}

// Gamma events → our feed, by the rules above.
// A ladder keeps only its few rungs nearest 50/50, so one event can't fill the wall.
export function toFeedMarkets(
  events: readonly GammaEvent[],
  category: MarketCategory,
  now: Date,
  opts: { perCategory?: number; perLadder?: number; minPrice?: number; skipped?: Skips } = {},
): FeedMarket[] {
  const limit = opts.perCategory ?? 12;
  const perLadder = opts.perLadder ?? 3;
  const min = opts.minPrice ?? MIN_PRICE;
  const skipped = opts.skipped ?? noSkips();
  const out: FeedMarket[] = [];
  for (const e of events) {
    const ms = e.markets ?? [];
    const ladder = ms.length > 1 ? e.slug : null;
    const rungs: FeedMarket[] = [];
    for (const m of ms) {
      const f = feedMarketOf(m, category, ladder, now, min, skipped);
      if (f) rungs.push(f);
    }
    rungs.sort((a, b) => Math.abs(a.price - 50) - Math.abs(b.price - 50));
    for (const f of rungs.slice(0, perLadder)) {
      if (out.length >= limit) return out;
      out.push(f);
    }
  }
  return out;
}

// What a closed market has come to. Only a result Gamma marks "resolved" is
// final: YES or NO paid in full, or a 50/50 split (a cancelled game: void, and
// nobody scores). Anything else closed, a result still proposed or disputed
// or a payout that reads as neither, is frozen and we keep waiting. There's
// deliberately no timeout: how long a late result waits before its call is
// carried or voided is the owner's decision (PARKED.md), not this mapper's.
// null: still trading (nothing new to say), or not a YES/NO market we can read.
// `pair` reads another two-outcome market by the same rules (resolved: true
// is its first outcome), so the warm-up settles exactly as the Tower does.
export function closedOutcome(m: GammaMarket, pair: OutcomePair = YES_NO): Pick<FeedMarket, "resolved" | "voided" | "closed"> | null {
  if (!m.closed) return null;
  const o = readOutcomes(m);
  if (!o || !isPair(o.names, pair)) return null;
  const [yes, no] = o.prices;
  if (m.umaResolutionStatus === "resolved") {
    if (yes === 1 && no === 0) return { resolved: true, voided: false, closed: true };
    if (yes === 0 && no === 1) return { resolved: false, voided: false, closed: true };
    if (yes === 0.5 && no === 0.5) return { resolved: null, voided: true, closed: true };
  }
  return { resolved: null, voided: false, closed: true };
}

// Which known markets a poll asks Gamma about, at most `max`: first every one
// something rides on (a call, a duel, a Slate card), then a window over the
// rest that moves on every minute. Markets that never resolve cleanly (closed
// but never "resolved", deleted, long disputed) keep the oldest freeze times
// for good: in a fixed "first 500" they'd take every slot and starve newer
// markets of their results.
export function knownToLookUp(known: readonly KnownMarket[], now: Date, max = MAX_KNOWN_LOOKUPS): KnownMarket[] {
  const held = known.filter((k) => k.held);
  const rest = known.filter((k) => !k.held);
  if (held.length >= max) return held.slice(0, max);
  const room = max - held.length;
  if (rest.length <= room) return [...held, ...rest];
  const start = (Math.floor(now.getTime() / 60_000) * room) % rest.length;
  const wrapped = Math.max(0, start + room - rest.length);
  return [...held, ...rest.slice(start, start + room), ...rest.slice(0, wrapped)];
}

// What we stored about a market, ready to carry a new result.
const stored = (k: KnownMarket): Omit<FeedMarket, "resolved" | "voided" | "closed"> => ({
  externalId: k.externalId,
  question: k.question,
  category: k.category,
  ladder: k.ladder,
  freezesAt: k.freezesAt,
  settlesBy: k.settlesBy,
  price: k.price,
});

// Our Polymarket markets by Gamma id.
const byGammaId = (known: readonly KnownMarket[]) => new Map(known.filter((k) => k.externalId.startsWith("pm:")).map((k) => [k.externalId.slice(3), k]));

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// The live provider. One request per category; a failed category is skipped,
// and if every one fails, or together they hold no usable market at all, it
// throws, so the poller reads "odds paused". Alongside, the markets we hold
// are looked up by id among Gamma's closed ones, to freeze, resolve or void,
// and the ones that must stay callable among its trading ones.
export function polymarketProvider(
  opts: { fetch?: Fetch; perCategory?: number; baseUrl?: string; timeoutMs?: number; log?: (line: string) => void } = {},
): OddsProvider {
  const get: Fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const base = opts.baseUrl ?? GAMMA_URL;
  const log = opts.log ?? ((line: string) => console.warn(line));
  // The body, or null on any failure. Each request gets its own deadline.
  const getJson = async (url: string): Promise<unknown> => {
    const res = await get(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS) }).catch(() => null);
    return res?.ok ? await res.json().catch(() => null) : null;
  };

  // Gamma's answers are cached for 5 minutes by their whole address
  // (Cache-Control: max-age=300), and the poll asks the same things minute
  // after minute: without the poll's own time in each address, the ticks and
  // the closed lookups could lag the plan's 30 to 60 seconds by up to 5
  // minutes. One fresh request per address per poll, as before.
  const fresh = (now: Date) => `poll=${now.getTime()}`;

  // Gamma's closed or trading markets with these ids, 100 a request. A
  // request that fails is logged and just waits for the next poll.
  async function lookUp(ids: readonly string[], closed: boolean, what: string, now: Date): Promise<GammaMarket[]> {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += IDS_PER_LOOKUP) chunks.push(ids.slice(i, i + IDS_PER_LOOKUP));
    const found = await Promise.all(
      chunks.map(async (chunk) => {
        const body = await getJson(`${base}/markets?closed=${closed}&limit=${IDS_PER_LOOKUP}&${chunk.map((id) => `id=${encodeURIComponent(id)}`).join("&")}&${fresh(now)}`);
        if (!Array.isArray(body)) {
          log(`polymarket: looking up ${chunk.length} ${what} failed`);
          return [];
        }
        return body as GammaMarket[];
      }),
    );
    return found.flat();
  }

  // Known markets that Gamma now lists as closed, with what they came to.
  async function closedKnown(known: readonly KnownMarket[], now: Date, skipped: Skips): Promise<FeedMarket[]> {
    const all = byGammaId(known);
    const asked = byGammaId(knownToLookUp([...all.values()], now));
    if (all.size > asked.size) log(`polymarket: ${all.size} known markets, looking up ${asked.size} this poll`);
    const out: FeedMarket[] = [];
    for (const m of await lookUp([...asked.keys()], true, "known markets", now)) {
      const k = asked.get(String(m?.id));
      if (!k) continue;
      const outcome = closedOutcome(m);
      if (!outcome) {
        if (m.closed) skipped.unreadable++;
        continue;
      }
      out.push({ ...stored(k), ...outcome });
    }
    return out;
  }

  // Known markets that must stay callable while they trade (today's Slate
  // cards, calls waiting to lock), at their live price, whether or not the
  // listing still carries them: a card fixed for the day mustn't go dark
  // because the ladder moved past its rung or its event left the top 20.
  async function liveKnown(known: readonly KnownMarket[], now: Date, skipped: Skips): Promise<FeedMarket[]> {
    const live = byGammaId(known.filter((k) => k.live).slice(0, MAX_LIVE_LOOKUPS));
    if (live.size === 0) return [];
    const out: FeedMarket[] = [];
    for (const m of await lookUp([...live.keys()], false, "live markets", now)) {
      const k = live.get(String(m?.id));
      const f = k && feedMarketOf(m, k.category, k.ladder, now, MIN_PRICE, skipped);
      if (f) out.push(f);
    }
    return out;
  }

  // Matches we froze at kickoff that still trade: their live price, for the
  // Watch Party Hall's in-play calls, the latest kickoffs first. A match that's
  // over, or no longer trading, just doesn't come back (Gamma's closed lookup
  // says what became of it). Only an answer in play counts: one that now reads
  // as before kickoff (no kickoff time, or a later one) never reopens a frozen
  // match from here; a postponement comes through the listing.
  async function inPlayKnown(known: readonly KnownMarket[], now: Date, skipped: Skips): Promise<FeedMarket[]> {
    const latest = known.filter((k) => k.inPlay && k.category === "sports").sort((a, b) => b.freezesAt.getTime() - a.freezesAt.getTime());
    const playing = byGammaId(latest.slice(0, MAX_IN_PLAY_LOOKUPS));
    if (playing.size === 0) return [];
    const out: FeedMarket[] = [];
    for (const m of await lookUp([...playing.keys()], false, "matches in play", now)) {
      const k = playing.get(String(m?.id));
      const f = k && feedMarketOf(m, k.category, k.ladder, now, MIN_PRICE, skipped, true);
      if (f?.inPlay) out.push(f);
    }
    return out;
  }

  return {
    source: "polymarket",
    async fetch(now: Date, known: readonly KnownMarket[] = []) {
      const skipped = noSkips();
      let failed = 0;
      let events = 0;
      const [listed, closed, live, playing] = await Promise.all([
        Promise.all(
          (Object.entries(POLYMARKET_TAGS) as [MarketCategory, string][]).map(async ([category, tag]) => {
            const body = await getJson(`${base}/events?tag_slug=${tag}&active=true&closed=false&order=volume24hr&ascending=false&limit=20&${fresh(now)}`);
            if (!Array.isArray(body)) {
              failed++;
              return [];
            }
            events += body.length;
            return toFeedMarkets(body as GammaEvent[], category, now, { perCategory: opts.perCategory, skipped });
          }),
        ),
        closedKnown(known, now, skipped),
        liveKnown(known, now, skipped),
        inPlayKnown(known, now, skipped),
      ]);
      if (failed === Object.keys(POLYMARKET_TAGS).length) throw new Error("polymarket: every category request failed");
      // Answers that came back but held nothing we can use (the API changed
      // shape, or a tag stopped matching) are a failed poll, not an empty one.
      if (listed.every((ms) => ms.length === 0)) throw new Error(`polymarket: no usable market in ${events} events; ${describeSkips(skipped)}`);
      if (skipped.unreadable) log(`polymarket: ${describeSkips(skipped)}`);
      // A closed market's result comes first; then each market once, first
      // category wins (an event can carry two tags), and the listing's copy
      // of a live market over its own lookup. A match in play comes last: if
      // the listing says its kickoff moved, the listing's word stands.
      const seen = new Set<string>();
      return [...closed, ...listed.flat(), ...live, ...playing].filter((m) => !seen.has(m.externalId) && seen.add(m.externalId));
    },
  };
}
