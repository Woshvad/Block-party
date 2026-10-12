import type { FeedMarket, KnownMarket, MarketCategory, OddsProvider } from "./tower";

// Polymarket's public Gamma API as an odds feed: read-only, no keys. We ask
// for the busiest open events per category tag and turn each YES/NO market
// into a FeedMarket. Multi-market events ("Bitcoin above ___ on Oct 10?") are
// price ladders. Markets we already hold are looked up again by id: that's how
// they freeze, resolve or void once they've left the listing. The mapping is
// pure (tested on recorded payloads); only the provider touches the network.

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
};
export type GammaEvent = { slug: string; markets?: GammaMarket[] };

const LADDER_FREEZE_MS = 60 * 60_000; // ladder calls close an hour before it settles
const REQUEST_TIMEOUT_MS = 8_000; // per request, so one hung category can't hold up the poll
const IDS_PER_LOOKUP = 100; // Gamma refuses more ids than this in one request
const MAX_LOOKUPS = 5; // so at most 500 known markets a poll, the ones that freeze first

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

const isYesNo = (names: unknown[]) => names.length === 2 && names[0] === "Yes" && names[1] === "No";

// Gamma events → our feed. Skips anything closed, not trading, already frozen,
// or priced at the extremes (a 99% market is no call at all).
// A ladder keeps only its few rungs nearest 50/50, so one event can't fill the wall.
export function toFeedMarkets(
  events: readonly GammaEvent[],
  category: MarketCategory,
  now: Date,
  opts: { perCategory?: number; perLadder?: number; minPrice?: number; skipped?: Skips } = {},
): FeedMarket[] {
  const limit = opts.perCategory ?? 12;
  const perLadder = opts.perLadder ?? 3;
  const min = opts.minPrice ?? 3;
  const skipped = opts.skipped ?? noSkips();
  const out: FeedMarket[] = [];
  for (const e of events) {
    const ms = e.markets ?? [];
    const ladder = ms.length > 1 ? e.slug : null;
    const rungs: FeedMarket[] = [];
    for (const m of ms) {
      if (m.closed) {
        skipped.closed++;
        continue;
      }
      if (m.acceptingOrders === false) {
        skipped.notTrading++;
        continue;
      }
      // Placeholder markets ("Will [Placeholder X] win...?") carry no prices yet.
      if (m.outcomePrices == null) {
        skipped.unpriced++;
        continue;
      }
      const o = readOutcomes(m);
      const settlesBy = new Date(m.endDate ?? "");
      if (!o || Number.isNaN(settlesBy.getTime())) {
        skipped.unreadable++;
        continue;
      }
      if (!isYesNo(o.names)) {
        skipped.notYesNo++;
        continue;
      }
      const price = Math.round(o.prices[0]! * 100);
      if (price < min || price > 100 - min) {
        skipped.extreme++;
        continue;
      }
      const kickoff = m.gameStartTime ? new Date(m.gameStartTime) : null;
      const freezesAt = kickoff && !Number.isNaN(kickoff.getTime()) ? kickoff : ladder ? new Date(settlesBy.getTime() - LADDER_FREEZE_MS) : settlesBy;
      if (freezesAt <= now) {
        skipped.frozen++;
        continue;
      }
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

// What a closed market has come to. Only a result Gamma marks "resolved" is
// final: YES or NO paid in full, or a 50/50 split (a cancelled game: void, and
// nobody scores). Anything else closed, a result still proposed or disputed
// or a payout that reads as neither, is frozen and we keep waiting. There's
// deliberately no timeout: how long a late result waits before its call is
// carried or voided is the owner's decision (PARKED.md), not this mapper's.
// null: still trading (nothing new to say), or not a YES/NO market we can read.
export function closedOutcome(m: GammaMarket): Pick<FeedMarket, "resolved" | "voided" | "closed"> | null {
  if (!m.closed) return null;
  const o = readOutcomes(m);
  if (!o || !isYesNo(o.names)) return null;
  const [yes, no] = o.prices;
  if (m.umaResolutionStatus === "resolved") {
    if (yes === 1 && no === 0) return { resolved: true, voided: false, closed: true };
    if (yes === 0 && no === 1) return { resolved: false, voided: false, closed: true };
    if (yes === 0.5 && no === 0.5) return { resolved: null, voided: true, closed: true };
  }
  return { resolved: null, voided: false, closed: true };
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// The live provider. One request per category; a failed category is skipped,
// and if every one fails, or together they hold no usable market at all, it
// throws, so the poller reads "odds paused". Alongside, the markets we hold
// are looked up by id among Gamma's closed ones, to freeze, resolve or void.
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

  // Known markets that Gamma now lists as closed, with what they came to.
  // A lookup that fails just waits for the next poll.
  async function closedKnown(known: readonly KnownMarket[], skipped: Skips): Promise<FeedMarket[]> {
    const ours = new Map(known.filter((k) => k.externalId.startsWith("pm:")).map((k) => [k.externalId.slice(3), k]));
    const ids = [...ours.keys()].slice(0, IDS_PER_LOOKUP * MAX_LOOKUPS);
    if (ours.size > ids.length) log(`polymarket: ${ours.size} known markets, looking up the first ${ids.length} this poll`);
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += IDS_PER_LOOKUP) chunks.push(ids.slice(i, i + IDS_PER_LOOKUP));
    const found = await Promise.all(
      chunks.map(async (chunk) => {
        const body = await getJson(`${base}/markets?closed=true&limit=${IDS_PER_LOOKUP}&${chunk.map((id) => `id=${encodeURIComponent(id)}`).join("&")}`);
        if (!Array.isArray(body)) {
          log(`polymarket: looking up ${chunk.length} known markets failed`);
          return [];
        }
        return body as GammaMarket[];
      }),
    );
    const out: FeedMarket[] = [];
    for (const m of found.flat()) {
      const k = ours.get(String(m?.id));
      if (!k) continue;
      const outcome = closedOutcome(m);
      if (!outcome) {
        if (m.closed) skipped.unreadable++;
        continue;
      }
      out.push({ ...k, ...outcome });
    }
    return out;
  }

  return {
    source: "polymarket",
    async fetch(now: Date, known: readonly KnownMarket[] = []) {
      const skipped = noSkips();
      let failed = 0;
      let events = 0;
      const [listed, closed] = await Promise.all([
        Promise.all(
          (Object.entries(POLYMARKET_TAGS) as [MarketCategory, string][]).map(async ([category, tag]) => {
            const body = await getJson(`${base}/events?tag_slug=${tag}&active=true&closed=false&order=volume24hr&ascending=false&limit=20`);
            if (!Array.isArray(body)) {
              failed++;
              return [];
            }
            events += body.length;
            return toFeedMarkets(body as GammaEvent[], category, now, { perCategory: opts.perCategory, skipped });
          }),
        ),
        closedKnown(known, skipped),
      ]);
      if (failed === Object.keys(POLYMARKET_TAGS).length) throw new Error("polymarket: every category request failed");
      // Answers that came back but held nothing we can use (the API changed
      // shape, or a tag stopped matching) are a failed poll, not an empty one.
      if (listed.every((ms) => ms.length === 0)) throw new Error(`polymarket: no usable market in ${events} events; ${describeSkips(skipped)}`);
      if (skipped.unreadable) log(`polymarket: ${describeSkips(skipped)}`);
      // A closed market's result comes first; then each market once, first
      // category wins (an event can carry two tags).
      const seen = new Set<string>();
      return [...closed, ...listed.flat()].filter((m) => !seen.has(m.externalId) && seen.add(m.externalId));
    },
  };
}
