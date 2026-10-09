import { type CityDay, addDays, cityDay, cityWeekday } from "./clock";

// --- The weekly calendar ----------------------------------------------------
// Week W runs Monday 00:00 UTC to the next Monday. During week W the city
// elects the Mayor for week W+1: candidates declare Monday to Thursday, the
// booth opens Friday 00:00, polls close Sunday 23:00, and the winner is sworn
// in at Monday 00:00.

export type ElectionPhase = "candidacy" | "voting" | "counted";

// The Monday that starts the week containing `day`.
export function weekStart(day: CityDay): CityDay {
  const wd = cityWeekday(day); // 0 Sunday .. 6 Saturday
  return addDays(day, -((wd + 6) % 7));
}

export function electionClock(now: Date) {
  const day = cityDay(now);
  const week = weekStart(day);
  const friday = new Date(`${addDays(week, 4)}T00:00:00.000Z`);
  const close = new Date(`${addDays(week, 6)}T23:00:00.000Z`);
  const phase: ElectionPhase = now < friday ? "candidacy" : now < close ? "voting" : "counted";
  return {
    week, // the week this election runs in
    termWeek: addDays(week, 7), // the week the winner serves
    phase,
    votingOpens: friday,
    pollsClose: close,
    swornIn: new Date(`${addDays(week, 7)}T00:00:00.000Z`),
  };
}

// Most votes wins; a tie goes to whoever declared first. Public and
// deterministic, so nobody can argue about a coin flip.
export function electionWinner(tally: ReadonlyArray<{ candidateId: string; votes: number; declaredAt: Date }>): string | null {
  const ranked = tally
    .filter((t) => t.votes > 0)
    .sort((a, b) => b.votes - a.votes || a.declaredAt.getTime() - b.declaredAt.getTime() || (a.candidateId < b.candidateId ? -1 : 1));
  return ranked[0]?.candidateId ?? null;
}

// --- The Law of the Week ----------------------------------------------------
// Each law says exactly what it touches. A law can never touch rent, stamps,
// Tower Lights, the drip, furniture prices, any cap, or real trades and fees.

export const FORBIDDEN_LAW_TARGETS = ["rent", "stamps", "tower_lights", "drip", "furniture_prices", "caps", "real_trades", "fees", "gm_supply"] as const;

export type LawTarget = "rides" | "copium_price" | "place:diner" | "place:rollup" | "place:roof" | "chat";

export type Law = {
  id: string;
  name: string;
  touches: readonly LawTarget[];
  // Numeric effects, all bounded and applied by the system that owns them.
  effects: Readonly<{ copiumDiscount?: number; ridesFree?: boolean; placeTrait?: string }>;
};

export const LAWS: readonly Law[] = [
  { id: "gas_holiday", name: "Gas Holiday", touches: ["rides"], effects: { ridesFree: true } },
  { id: "copium_subsidy", name: "Copium Subsidy", touches: ["copium_price"], effects: { copiumDiscount: 0.3 } },
  { id: "happy_hour", name: "Happy Hour", touches: ["place:diner"], effects: { placeTrait: "happy_hour" } },
  { id: "gremlins", name: "Gremlins", touches: ["place:rollup"], effects: { placeTrait: "gremlins" } },
  { id: "roof_party", name: "Roof Party", touches: ["place:roof"], effects: { placeTrait: "roof_party" } },
  { id: "memes_only", name: "Memes-Only Monday", touches: ["chat"], effects: { placeTrait: "memes_only" } },
];

export const getLaw = (id: unknown): Law | null => (typeof id === "string" ? (LAWS.find((l) => l.id === id) ?? null) : null);

// Copium under the Law of the Week (whole GM, rounded up so a discount never
// makes it free).
export function copiumPriceUnder(law: Law | null, base: number): number {
  const d = law?.effects.copiumDiscount ?? 0;
  if (!(d > 0 && d < 1)) return base;
  return Math.max(1, Math.ceil(base * (1 - d)));
}
