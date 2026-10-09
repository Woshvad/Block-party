import { type CityDay, cityWeekday } from "./clock";

// The bell is a show: stamps, moods, crew Bell Scores and the reel. None of
// it touches Aura, and only the Bell Stamp pays GM (for calling, never for
// winning, and never for money).

export const BELL_STAMP = { gm: 25, sundayGm: 150 } as const;
export const bellStampFor = (day: CityDay) => (cityWeekday(day) === 0 ? BELL_STAMP.sundayGm : BELL_STAMP.gm);

export const BELL_SCORE = { longShot: 1.5, snapWon: 2, chain: 1.25, chainDays: 7 } as const;

// A crew's chips are its CALLED IT receipts that day, one per resident per
// market; multipliers stack: ×1.5 per Long Shot a crewmate caught, ×2 per
// Snap a crewmate held and won, ×1.25 for a gm chain of 7+ days. Kept in
// thousandths so it stores and sorts exactly.
export function bellScoreMilli(input: { chips: number; longShots: number; snapsWon: number; chainDays: number }): number {
  if (input.chips <= 0) return 0;
  const m = BELL_SCORE.longShot ** input.longShots * BELL_SCORE.snapWon ** input.snapsWon * (input.chainDays >= BELL_SCORE.chainDays ? BELL_SCORE.chain : 1);
  return Math.round(input.chips * m * 1000);
}
