// Alt checks: GM moved between each pair of accounts over 14 days, across
// every channel. More than 500 GM one way with under 20% coming back is
// flagged for staff (and that pair can't duel).

export const ALTS = { windowDays: 14, threshold: 500, backShare: 0.2 } as const;

export type PairFlow = { a: string; b: string; ab: number; ba: number }; // a < b

export function altFlag(f: PairFlow): { from: string; to: string; amount: number; back: number } | null {
  const [from, to, amount, back] = f.ab >= f.ba ? [f.a, f.b, f.ab, f.ba] : [f.b, f.a, f.ba, f.ab];
  if (amount <= ALTS.threshold) return null;
  if (back >= amount * ALTS.backShare) return null;
  return { from, to, amount, back };
}

// A City market's losers pay its winners in proportion to their stakes: the
// pair flows that implies (rounded down; dust and the bell burn go nowhere).
export function marketPairFlows(positions: ReadonlyArray<{ userId: string; side: "yes" | "no"; stake: number }>, outcome: boolean): Array<{ from: string; to: string; amount: number }> {
  const win = outcome ? "yes" : "no";
  const winners = positions.filter((p) => p.side === win);
  const W = winners.reduce((a, p) => a + p.stake, 0);
  if (!W) return [];
  const out: Array<{ from: string; to: string; amount: number }> = [];
  for (const l of positions.filter((p) => p.side !== win))
    for (const w of winners) {
      const amount = Math.floor((l.stake * w.stake) / W);
      if (amount > 0 && l.userId !== w.userId) out.push({ from: l.userId, to: w.userId, amount });
    }
  return out;
}
