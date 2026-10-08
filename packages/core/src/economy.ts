import { type CityDay, addDays, cityWeekday, daysBetween } from "./clock";
import { SEASON_EPOCH, SEASON_LENGTH_DAYS, seasonOf } from "./resident";
import { seededRandomInt } from "./random";

export const SYS_PURSE = "sys:city_purse"; // the Mayor's GM, only ever spent on things everyone sees

// --- Rent -----------------------------------------------------------------

export const RENT = {
  tenement: 250,
  purseShare: 0.1, // 10% of rent to the City Purse; the rest burns
  subletAfterDaysAway: 7,
} as const;

export function rentSplit(amount: number): { burn: number; purse: number } {
  const purse = Math.floor(amount / 10); // integer GM, exact 10%
  return { burn: amount - purse, purse };
}

export const isSaturday = (day: CityDay) => cityWeekday(day) === 6;

// Every Saturday in [from, to], oldest first.
export function saturdaysBetween(from: CityDay, to: CityDay): CityDay[] {
  const out: CityDay[] = [];
  if (daysBetween(from, to) < 0) return out;
  let d = addDays(from, (6 - cityWeekday(from) + 7) % 7);
  // loop-bound: one step per week between two dates, and callers pass at most
  // a bounded window (see MAX_RENT_WEEKS).
  while (daysBetween(d, to) >= 0) {
    out.push(d);
    d = addDays(d, 7);
  }
  return out;
}

// Rent pauses once you've been away 7 full days before the Saturday.
export function isSublet(lastActive: CityDay, saturday: CityDay): boolean {
  return daysBetween(lastActive, saturday) - 1 >= RENT.subletAfterDaysAway;
}

export const MAX_RENT_WEEKS = 8; // catch-up never charges more than this many Saturdays

// --- Mod Shift ------------------------------------------------------------

export const SHIFT = {
  perDay: 2, // covers every job, away shift included
  minutes: 15, // the shift runs on its own after the mini-game
  answerWindowSeconds: 60, // the mini-game is 30 s; a little slack for the network
  items: 10,
  awayPay: 5, // half pay
} as const;

export function shiftPay(score: number | null): number {
  if (score === null || score < 7) return 10;
  return score >= 9 ? 12 : 11;
}

// The Mod Shift mini-game: a moderation queue. Spot the scams.
const OK_LINES = [
  "gm frens",
  "who's on the roof for the bell tonight?",
  "the diner special slaps",
  "called it on the long shot ser",
  "crew house needs a bigger couch",
  "nothing-9000 is wrong again",
  "wen bell",
  "rekt but vibing",
  "anyone up for a fade duel?",
  "touched grass today, feeling rested",
];
const SCAM_LINES = [
  "DM me to claim your airdrop",
  "send your seed phrase to verify your wallet",
  "admin here, connect wallet at the link to unlock rewards",
  "guaranteed 100x, send USDC first",
  "support team: share your private key to fix the bug",
  "free GM giveaway, just sign this transaction",
  "verify your account at blockparty-claim dot xyz",
  "I'm the Mayor's assistant, pay me for votes",
];

export type ShiftItem = { text: string };

// Deterministic from the seed, so the server can rebuild the answers and
// never has to store or send them.
export function shiftPuzzle(seed: number): { items: ShiftItem[]; answers: boolean[] } {
  const rand = seededRandomInt(seed);
  const items: ShiftItem[] = [];
  const answers: boolean[] = [];
  for (let i = 0; i < SHIFT.items; i++) {
    const scam = rand(2) === 1;
    const pool = scam ? SCAM_LINES : OK_LINES;
    items.push({ text: pool[rand(pool.length)]! });
    answers.push(scam);
  }
  return { items, answers };
}

// Score = how many items were labelled right. Anything malformed scores 0.
export function scoreShift(seed: number, submitted: unknown): number {
  const { answers } = shiftPuzzle(seed);
  if (!Array.isArray(submitted) || submitted.length !== answers.length) return 0;
  if (!submitted.every((x) => typeof x === "boolean")) return 0;
  return submitted.reduce((n, x, i) => n + (x === answers[i] ? 1 : 0), 0);
}

// --- The Halving ----------------------------------------------------------

export const HALVING_LINE = 2000;

// The excess above 2,000 is halved and burned. Whole GM, rounded in the
// player's favour: an excess of 3,001 burns 1,500 and keeps 1,501.
export function halvingBurn(balance: number): number {
  if (!Number.isSafeInteger(balance) || balance <= HALVING_LINE) return 0;
  return Math.floor((balance - HALVING_LINE) / 2);
}

// The bell at 00:00 UTC ends the city day before `today`. If that day was the
// last of a season, this is the season's last bell.
export function seasonEndedAt(today: CityDay, seasonOf: (d: CityDay) => number): number | null {
  const ended = seasonOf(addDays(today, -1));
  return ended >= 1 && seasonOf(today) !== ended ? ended : null;
}

export const HALVING_LATE_DAYS = 7; // a missed Halving still runs this many days into the new season

// The last city day of a season; a season's Halving is recorded against it,
// so however late the job runs, that season is halved once.
export const seasonLastDay = (season: number, epoch = SEASON_EPOCH) => addDays(epoch, season * SEASON_LENGTH_DAYS - 1);

// The season whose Halving is due at this bell, if any: the season that just
// ended, as long as we're within HALVING_LATE_DAYS of its end.
export function halvingDue(today: string, epoch = SEASON_EPOCH): number | null {
  const current = seasonOf(today, epoch);
  const ended = current - 1;
  if (ended < 1) return null;
  const seasonStart = addDays(epoch, (current - 1) * SEASON_LENGTH_DAYS);
  return daysBetween(seasonStart, today) < HALVING_LATE_DAYS ? ended : null;
}

