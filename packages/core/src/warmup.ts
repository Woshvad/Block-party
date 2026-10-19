import { CAST } from "./cast";
import { GAMMA_URL, type GammaEvent, type GammaMarket, type OutcomePair, closedOutcome, outcomesAre } from "./polymarket";

// The 15-minute warm-up: a newcomer's first result, long before the bell.
// The Contrarian at the Tower door asks "Bitcoin. Up or down in the next 15
// minutes?", and the call is free: UP or DOWN on one of Polymarket's rolling
// "Bitcoin Up or Down" 15-minute windows. No stake, no GM, no Aura, never a
// real trade, and nothing about the Tower's own markets (the Slate, the City
// bar, Aura) ever sees it. It settles into a short reel for that window's
// newcomers, CALLED IT or REKT with a free Copium, and an opt-in push.
// Behind FEATURE_WARMUP until Polymarket's written OK and a legal check
// (PARKED.md).

export const WARMUP = {
  windowMinutes: 15,
  entryMinutes: 2, // calls only in a window's first 2 minutes, at its opening price, so nobody snipes it from a live chart
  days: 3, // a resident's first 3 days, counted from their first tap
  max: 3, // one a day for those 3 days
  feedPausedAfterSeconds: 180, // no good poll of the warm-up feed for this long: it's down
  lookupsPerPoll: 100, // ended windows asked about for their result each poll (one request)
} as const;

export const WARMUP_SIDES = ["up", "down"] as const;
export type WarmupSide = (typeof WARMUP_SIDES)[number];
export const isWarmupSide = (x: unknown): x is WarmupSide => x === "up" || x === "down";

const MIN = 60_000;
const WINDOW_MS = WARMUP.windowMinutes * MIN;
const ENTRY_MS = WARMUP.entryMinutes * MIN;
const DAY_MS = 86_400_000;

// --- Windows and the clock ------------------------------------------------------

// The window `at` falls in, by its start: :00, :15, :30 or :45 past the hour.
export const windowStart = (at: Date) => new Date(Math.floor(at.getTime() / WINDOW_MS) * WINDOW_MS);

// The window after the one `at` falls in.
export const nextWindowAt = (at: Date) => new Date(windowStart(at).getTime() + WINDOW_MS);

// Calls are taken from a window's first moment until 2 minutes in.
export const entryClosesAt = (startsAt: Date) => new Date(startsAt.getTime() + ENTRY_MS);
export const takingCalls = (startsAt: Date, now: Date) => now.getTime() >= startsAt.getTime() && now.getTime() < startsAt.getTime() + ENTRY_MS;

// A real window: starts on a quarter hour and runs exactly 15 minutes.
export const isWindow = (startsAt: Date, endsAt: Date) =>
  !Number.isNaN(startsAt.getTime()) && startsAt.getTime() % WINDOW_MS === 0 && endsAt.getTime() - startsAt.getTime() === WINDOW_MS;

// --- Who may call, and how often ----------------------------------------------------

// Which of a resident's days `now` is: 0 for the 24 hours from their first
// tap, then 1, then 2. A clock a moment behind the database's still reads 0.
export function accountDay(arrivedAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - arrivedAt.getTime()) / DAY_MS));
}

export type WarmupEligibility = { ok: true; day: number; left: number } | { ok: false; reason: "not_new" | "used_today"; day: number; left: number };

// One warm-up a day for a resident's first 3 days, so 3 at most. `usedDays`
// are the account days they've already had one on. `left` counts this day
// and the ones after it still to come; a day skipped is gone.
export function warmupEligibility(arrivedAt: Date, now: Date, usedDays: readonly number[]): WarmupEligibility {
  const day = accountDay(arrivedAt, now);
  if (day >= WARMUP.days) return { ok: false, reason: "not_new", day, left: 0 };
  const usedToday = usedDays.includes(day);
  const left = WARMUP.days - day - (usedToday ? 1 : 0);
  return usedToday ? { ok: false, reason: "used_today", day, left } : { ok: true, day, left };
}

// --- Settling --------------------------------------------------------------------------

export type WarmupStamp = "called_it" | "rekt" | "void";

// A settled call's stamp; null while the window is still waiting on its result.
export function warmupStamp(side: WarmupSide, outcome: WarmupSide | null, voided: boolean): WarmupStamp | null {
  if (voided) return "void";
  if (outcome === null) return null;
  return side === outcome ? "called_it" : "rekt";
}

// NOTHING-9000 calls DOWN in every window, so a newcomer always has someone to beat.
export const NOTHING_WARMUP_SIDE: WarmupSide = "down";

export type WarmupReel = {
  result: WarmupSide | null; // null when the window was voided
  voided: boolean;
  newcomers: number; // everyone who called this window
  up: number;
  down: number;
  calledIt: number;
  bot: { name: string; label: string; side: WarmupSide; stamp: WarmupStamp };
};

// The mini-reel for a window's newcomers, once it has settled: what Bitcoin
// did, how the window split, and how the bot got on. Counts only, never who.
export function warmupReel(outcome: WarmupSide | null, voided: boolean, sides: readonly WarmupSide[]): WarmupReel {
  const up = sides.filter((s) => s === "up").length;
  const result = voided ? null : outcome;
  return {
    result,
    voided,
    newcomers: sides.length,
    up,
    down: sides.length - up,
    calledIt: result === null ? 0 : sides.filter((s) => s === result).length,
    bot: { name: CAST.nothing_9000.name, label: CAST.nothing_9000.label, side: NOTHING_WARMUP_SIDE, stamp: warmupStamp(NOTHING_WARMUP_SIDE, outcome, voided) ?? "void" },
  };
}

// --- The feed --------------------------------------------------------------------------

// A window as a feed lists it. `open`: taking orders on Polymarket right now.
export type WarmupWindow = { externalId: string; question: string; startsAt: Date; endsAt: Date; open: boolean };
// What became of a window that has closed: Up or Down, a 50/50 void, or
// still waiting on its result (outcome null, not voided).
export type WarmupResult = { externalId: string; outcome: WarmupSide | null; voided: boolean };

export interface WarmupFeed {
  readonly source: string;
  // The window `now` falls in and the next one, plus the results of
  // `pending`: ended windows someone called that haven't settled yet. No
  // window listed is a failed poll (pollWarmup), but its results still count.
  fetch(now: Date, pending?: readonly string[]): Promise<{ windows: WarmupWindow[]; results: WarmupResult[] }>;
}

// Each window is its own Gamma event, "btc-updown-15m-<start in Unix seconds>",
// with one Up/Down market, so a poll asks for exactly the two it needs.
export const WARMUP_SERIES = "btc-updown-15m";
export const warmupSlug = (startsAt: Date) => `${WARMUP_SERIES}-${Math.floor(startsAt.getTime() / 1000)}`;
const UP_DOWN: OutcomePair = ["Up", "Down"];

// One Gamma market as a window, or null unless it's one of the series: Up
// and Down, on a quarter hour, 15 minutes long, under its own slug.
export function toWarmupWindow(m: GammaMarket): WarmupWindow | null {
  if (!m || typeof m.id !== "string" || typeof m.question !== "string") return null;
  const startsAt = new Date(m.eventStartTime ?? "");
  const endsAt = new Date(m.endDate ?? "");
  if (!isWindow(startsAt, endsAt) || m.slug !== warmupSlug(startsAt) || !outcomesAre(m, UP_DOWN)) return null;
  return { externalId: `pm:${m.id}`, question: m.question, startsAt, endsAt, open: !m.closed && m.acceptingOrders !== false };
}

// A closed window's result, by the Tower's own rules (closedOutcome): only a
// result Gamma marks resolved counts, Up or Down paid in full or a 50/50
// void; anything else closed waits. null while it still trades.
export function warmupResultOf(m: GammaMarket): WarmupResult | null {
  const o = closedOutcome(m, UP_DOWN);
  if (!o) return null;
  return { externalId: `pm:${m.id}`, outcome: o.resolved === null ? null : o.resolved ? "up" : "down", voided: o.voided };
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
const REQUEST_TIMEOUT_MS = 8_000;

// The live feed, read-only and keyless like the Tower's. A failed or empty
// window request lists no window, so the poll is recorded as failed and the
// warm-up reads "feed down"; the results it looked up still come back, so a
// series that's paused or changed shape doesn't strand the windows people
// already called. A failed result lookup is logged and waits for the next poll.
export function polymarketWarmupFeed(opts: { fetch?: Fetch; baseUrl?: string; timeoutMs?: number; log?: (line: string) => void } = {}): WarmupFeed {
  const get: Fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const base = opts.baseUrl ?? GAMMA_URL;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const getJson = async (url: string): Promise<unknown> => {
    const res = await get(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS) }).catch(() => null);
    return res?.ok ? await res.json().catch(() => null) : null;
  };
  return {
    source: "polymarket",
    async fetch(now: Date, pending: readonly string[] = []) {
      const slugs = [windowStart(now), nextWindowAt(now)].map(warmupSlug);
      const ids = pending.filter((id) => id.startsWith("pm:")).slice(0, WARMUP.lookupsPerPoll).map((id) => id.slice(3));
      // Gamma's answers are cached for 5 minutes by their whole address
      // (Cache-Control: max-age=300), and a poll asks the same thing minute
      // after minute: without the poll's own time in the address, a result
      // in 1 to 3 minutes waits out a cached "not yet" for up to 5 more.
      const fresh = `poll=${now.getTime()}`;
      const [listed, closed] = await Promise.all([
        getJson(`${base}/events?${slugs.map((s) => `slug=${s}`).join("&")}&${fresh}`),
        ids.length ? getJson(`${base}/markets?closed=true&limit=${WARMUP.lookupsPerPoll}&${ids.map((id) => `id=${encodeURIComponent(id)}`).join("&")}&${fresh}`) : Promise.resolve([]),
      ]);
      if (!Array.isArray(closed)) log(`polymarket warm-up: looking up ${ids.length} ended windows failed`);
      const results = Array.isArray(closed) ? (closed as GammaMarket[]).flatMap((m) => warmupResultOf(m) ?? []) : [];
      if (!Array.isArray(listed)) {
        log("polymarket warm-up: the window request failed");
        return { windows: [], results };
      }
      const windows = (listed as GammaEvent[]).flatMap((e) => e?.markets ?? []).flatMap((m) => toWarmupWindow(m) ?? []);
      // Nothing usable for the window we're in: the series has stopped, or
      // the API changed shape. Either way there's no window to call.
      if (windows.length === 0) log(`polymarket warm-up: no readable window in ${listed.length} events`);
      return { windows, results };
    },
  };
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const hhmm = (d: Date) => d.toISOString().slice(11, 16);

// A sample feed for development and staging: every window open, each
// settling a minute after it ends, Up or Down by a hash of its start. It's
// invented, so it's credited as a sample (warmupCredit), never as Polymarket.
export function mockWarmupFeed(): WarmupFeed {
  const window = (startsAt: Date): WarmupWindow => {
    const endsAt = new Date(startsAt.getTime() + WINDOW_MS);
    return { externalId: `sample:${warmupSlug(startsAt)}`, question: `Bitcoin up or down, ${hhmm(startsAt)} to ${hhmm(endsAt)} UTC? (sample)`, startsAt, endsAt, open: true };
  };
  return {
    source: "mock",
    async fetch(now: Date, pending: readonly string[] = []) {
      const results = pending.flatMap((id): WarmupResult[] => {
        const start = Number(/^sample:btc-updown-15m-(\d+)$/.exec(id)?.[1]) * 1000;
        if (!Number.isFinite(start) || now.getTime() < start + WINDOW_MS + MIN) return [];
        return [{ externalId: id, outcome: hash(id) % 2 ? "up" : "down", voided: false }];
      });
      return { windows: [window(windowStart(now)), window(nextWindowAt(now))], results };
    },
  };
}

// The feed for an API's ODDS_SOURCE: Polymarket's windows, the sample ones, or none.
export function warmupFeedFor(oddsSource: string | undefined): WarmupFeed | undefined {
  return oddsSource === "polymarket" ? polymarketWarmupFeed() : oddsSource === "mock" ? mockWarmupFeed() : undefined;
}

// The credit under the warm-up. It shows no odds, only whose window it is.
export const warmupCredit = (source: string) => (source === "polymarket" ? "Window from Polymarket · Not affiliated" : "Sample window · Not real");
