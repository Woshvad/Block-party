import { escrowAccountId } from "./ledger";

// City markets: staff-written questions about the city, settled from game
// data, staked in GM (never Aura, never real money). Winners split the
// losers' stakes; no GM is ever created.

export const CITY = {
  lockBeforeBellHours: 2,
  bellBurnRate: 0.02, // of a win over 50 GM
  bellBurnOver: 50,
  bellBurnCap: 500,
  stakeShare: 0.25, // of your GM
  stakeBase: 100,
  stakePerDay: 10, // per day as a resident
  stakeMax: 800,
  beforePonCap: 200,
  tiltedCap: 10,
} as const;

export const cityAccountId = (marketId: string) => escrowAccountId("city", marketId);

// The most you can stake right now.
export function cityStakeCap(i: { balance: number; residentDays: number; pon: boolean; tilted: boolean }): number {
  let cap = Math.min(Math.floor(i.balance * CITY.stakeShare), CITY.stakeMax, CITY.stakeBase + CITY.stakePerDay * Math.max(0, Math.floor(i.residentDays)));
  if (!i.pon) cap = Math.min(cap, CITY.beforePonCap);
  if (i.tilted) cap = Math.min(cap, CITY.tiltedCap);
  return Math.max(0, cap);
}

export const bellBurnOn = (profit: number) => (profit > CITY.bellBurnOver ? Math.min(CITY.bellBurnCap, Math.floor(profit * CITY.bellBurnRate)) : 0);

export type CityPosition = { id: string; side: "yes" | "no"; stake: number };

// Who gets what. Winners split the losers' pool by stake (rounded down), pay
// the bell burn on their profit, and any rounding dust burns. A one-sided
// market refunds everyone. paid + burned always equals what was staked.
export function settleCity(positions: readonly CityPosition[], outcome: boolean): { payouts: Map<string, number>; burned: number; dust: number } {
  const win = outcome ? "yes" : "no";
  const W = positions.filter((p) => p.side === win).reduce((a, p) => a + p.stake, 0);
  const L = positions.filter((p) => p.side !== win).reduce((a, p) => a + p.stake, 0);
  const payouts = new Map<string, number>();
  if (W === 0 || L === 0) {
    for (const p of positions) payouts.set(p.id, p.stake);
    return { payouts, burned: 0, dust: 0 };
  }
  let shared = 0;
  let burned = 0;
  for (const p of positions) {
    if (p.side !== win) {
      payouts.set(p.id, 0);
      continue;
    }
    const profit = Math.floor((L * p.stake) / W);
    shared += profit;
    const b = bellBurnOn(profit);
    burned += b;
    payouts.set(p.id, p.stake + profit - b);
  }
  const dust = L - shared;
  return { payouts, burned, dust };
}
