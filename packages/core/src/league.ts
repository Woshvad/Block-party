// The Crew League: weekly, by division, like football. Ranked by the average
// Aura of a crew's top 5 callers plus a point per member who locks a full
// Slate (up to 10 a night). Champions win the banner, never tokens or cash.

export const LEAGUE = { minCallers: 5, topCallers: 5, fullSlateCapPerNight: 10, divisionSize: 10, moves: 3 } as const;

export const SIZE_GROUPS = [
  { key: "small", min: 3, max: 10 },
  { key: "medium", min: 11, max: 25 },
  { key: "large", min: 26, max: 50 },
] as const;
export type SizeGroup = (typeof SIZE_GROUPS)[number]["key"];
export const sizeGroupOf = (members: number): SizeGroup | null => SIZE_GROUPS.find((g) => members >= g.min && members <= g.max)?.key ?? null;

// Average of the top 5 callers' weekly Aura (in Aura, not hundredths), plus full-Slate points.
export function leagueScore(callerAuraCenti: readonly number[], fullSlatesPerNight: readonly number[]): number {
  const top = [...callerAuraCenti].sort((a, b) => b - a).slice(0, LEAGUE.topCallers);
  const avg = top.length ? top.reduce((a, b) => a + b, 0) / top.length / 100 : 0;
  const points = fullSlatesPerNight.reduce((a, n) => a + Math.min(LEAGUE.fullSlateCapPerNight, Math.max(0, n)), 0);
  return avg + points;
}

// One week on the ladder. `ladder` is the size group's crews in ladder order
// (division 1 is the first 10, and so on); `score` ranks crews inside a
// division (ineligible crews have null and sink to its bottom). Within each
// division crews sort by score; then the top 3 of each division swap with
// the bottom 3 of the division above. Returns the new ladder.
export function promote(ladder: readonly string[], score: ReadonlyMap<string, number | null>): string[] {
  const divisions: string[][] = [];
  for (let i = 0; i < ladder.length; i += LEAGUE.divisionSize) {
    const d = ladder.slice(i, i + LEAGUE.divisionSize);
    // Ladder order breaks ties, so a crew already above stays above.
    d.sort((a, b) => {
      const sa = score.get(a) ?? null;
      const sb = score.get(b) ?? null;
      if (sa === null && sb === null) return ladder.indexOf(a) - ladder.indexOf(b);
      if (sa === null) return 1;
      if (sb === null) return -1;
      return sb - sa || ladder.indexOf(a) - ladder.indexOf(b);
    });
    divisions.push(d);
  }
  for (let k = 1; k < divisions.length; k++) {
    const above = divisions[k - 1]!;
    const below = divisions[k]!;
    const n = Math.min(LEAGUE.moves, below.length, above.length);
    const up = below.slice(0, n).filter((c) => score.get(c) !== null && score.get(c) !== undefined);
    const swap = Math.min(up.length, n);
    if (!swap) continue;
    const down = above.slice(above.length - swap);
    divisions[k - 1] = [...above.slice(0, above.length - swap), ...up.slice(0, swap)];
    divisions[k] = [...down, ...below.filter((c) => !up.slice(0, swap).includes(c))];
  }
  return divisions.flat();
}
