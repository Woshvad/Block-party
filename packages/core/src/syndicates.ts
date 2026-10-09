// Syndicate calls: a crew member proposes, the crew shakes on it. On a Tower
// market it's a coordinated call (each shake locks the shaker's own free call;
// real money is never pooled). On a City market it stakes GM from the crew pot,
// up to 50 GM per member who shook, and winnings go back to the pot.

export const SYNDICATE = { windowHours: 2, maxPerShake: 50, shakes: 5, activeShare: 0.25 } as const;

// Live at 5 shakes, or a quarter of the members active that day if that's fewer (at least 1).
export function shakesNeeded(activeToday: number): number {
  return Math.max(1, Math.min(SYNDICATE.shakes, Math.ceil(Math.max(0, activeToday) * SYNDICATE.activeShare)));
}
