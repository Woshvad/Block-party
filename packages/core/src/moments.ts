// Watch Party big moments: when a sports market on the Tower settles, or its
// price swings hard, the Watch Party's big screen says so and everyone there
// can react. The API spots them after each odds poll; the rooms carry them.
// Pure: the thresholds, the swing rule and the payload the rooms accept.

export const MOMENTS = {
  swingPoints: 15, // a swing: the price moved 15+ points...
  swingWindowMinutes: 30, // ...within the last 30 minutes of ticks
  swingEveryMinutes: 60, // at most one swing per market an hour
  settledWithinMinutes: 15, // a result older than this is old news, not a moment
  perPoll: 3, // at most 3 moments a poll
  showSeconds: 120, // a room keeps the latest for 2 minutes, and the card fades with it
  questionChars: 300, // as the Tower stores a question
  idChars: 80,
  bodyBytes: 2048, // the rooms refuse a bigger payload
} as const;

// Only places with a big screen take moments.
export const MOMENT_PLACES: readonly string[] = ["watch_party"];
export const hasScreen = (place: string) => MOMENT_PLACES.includes(place);

export type MomentKind = "swing" | "settled";

// What the rooms carry. Prices are the chance of YES in whole percent. A
// swing says where the price came from and where it is now; a result says
// how it settled, and may say where the price last stood. `at`: when the
// poll saw it (ms).
export type TowerMoment = {
  id: string;
  kind: MomentKind;
  marketId: string;
  question: string;
  from?: number;
  to?: number;
  outcome?: "yes" | "no";
  at: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9:_-]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const isPct = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 99;

// A moment as the rooms accept it, rebuilt from the known fields only, or
// null. A swing needs both prices and no outcome; a result needs its outcome
// and no "to".
export function parseMoment(x: unknown): TowerMoment | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const m = x as Record<string, unknown>;
  if (typeof m.id !== "string" || m.id.length > MOMENTS.idChars || !ID.test(m.id)) return null;
  if (m.kind !== "swing" && m.kind !== "settled") return null;
  if (typeof m.marketId !== "string" || !UUID.test(m.marketId)) return null;
  if (typeof m.question !== "string") return null;
  const question = m.question.trim();
  if (!question || question.length > MOMENTS.questionChars || CONTROL.test(question)) return null;
  if (!Number.isSafeInteger(m.at) || (m.at as number) <= 0) return null;
  if ((m.from !== undefined && !isPct(m.from)) || (m.to !== undefined && !isPct(m.to))) return null;
  if (m.outcome !== undefined && m.outcome !== "yes" && m.outcome !== "no") return null;
  const out: TowerMoment = { id: m.id, kind: m.kind, marketId: m.marketId.toLowerCase(), question, at: m.at as number };
  if (m.kind === "swing") {
    if (m.from === undefined || m.to === undefined || m.from === m.to || m.outcome !== undefined) return null;
    out.from = m.from as number;
    out.to = m.to as number;
  } else {
    if (m.outcome === undefined || m.to !== undefined) return null;
    out.outcome = m.outcome;
    if (m.from !== undefined) out.from = m.from as number;
  }
  return out;
}

const ms = (at: Date | number) => (typeof at === "number" ? at : at.getTime());

// A swing: over the ticks of the last 30 minutes (up to `now`, both ends
// counted), the latest price against the one farthest from it, when they're
// 15 or more points apart. Of equally far prices, the earliest. Ticks at the
// same moment keep the order given (the caller passes them oldest first).
export function swingOf(ticks: ReadonlyArray<{ price: number; at: Date | number }>, now: Date | number): { from: number; to: number } | null {
  const t = ms(now);
  const since = t - MOMENTS.swingWindowMinutes * 60_000;
  const recent = ticks.filter((k) => isPct(k.price) && ms(k.at) >= since && ms(k.at) <= t).sort((a, b) => ms(a.at) - ms(b.at));
  const last = recent[recent.length - 1];
  if (!last || recent.length < 2) return null;
  let from = last.price;
  for (const k of recent) if (Math.abs(k.price - last.price) > Math.abs(from - last.price)) from = k.price;
  return Math.abs(last.price - from) >= MOMENTS.swingPoints ? { from, to: last.price } : null;
}

// Which hour a swing belongs to: one per market per bucket, and a stored
// moment's key. A result's bucket is always 0: one per market, ever.
export const swingBucket = (at: Date | number) => Math.floor(ms(at) / (MOMENTS.swingEveryMinutes * 60_000));
