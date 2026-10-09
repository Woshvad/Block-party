import { median } from "./tower";
import { escrowAccountId } from "./ledger";

// Tower Lights: crews bid from their pot to light the Prediction Tower in
// their colours at the bell. The winning bid burns; the others go home.

export const LIGHTS = { betaReserve: 1000, weekOfWinners: 7 } as const;
export const lightsAccountId = (cityDay: string) => escrowAccountId("lights", cityDay);

// 1,000 GM until there's a week of winners, then half of last week's median winning bid.
export function lightsReserve(lastWeekWinningBids: readonly number[]): number {
  if (lastWeekWinningBids.length < LIGHTS.weekOfWinners) return LIGHTS.betaReserve;
  return Math.max(1, Math.floor(median(lastWeekWinningBids)! / 2));
}

// The top bid: highest amount, then whoever got there first.
export function topBid<T extends { amount: number; at: number }>(bids: readonly T[]): T | null {
  return [...bids].sort((a, b) => b.amount - a.amount || a.at - b.at)[0] ?? null;
}
