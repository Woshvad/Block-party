// The Ratio of the Day (Quiplash): the day's biggest Vibe Gap becomes a
// headline prompt at 18:00 UTC, the Roof votes head-to-head pairs from 23:00,
// and the winner plays on the reel. It pays no GM.

export const RATIO = { promptHour: 18, voteHour: 23, maxChars: 80, minNeighbours: 10 } as const;

export function ratioPrompt(world: number, city: number) {
  return `World ${world}% · City ${city}%. Write the headline for when it settles.`;
}

// The winner: most head-to-head wins, then the best win rate, then the earliest entry.
export function ratioWinner(entries: ReadonlyArray<{ id: string; wins: number; shown: number; at: number }>): string | null {
  const contenders = entries.filter((e) => e.wins > 0);
  if (!contenders.length) return null;
  const rate = (e: { wins: number; shown: number }) => (e.shown ? e.wins / e.shown : 0);
  return [...contenders].sort((a, b) => b.wins - a.wins || rate(b) - rate(a) || a.at - b.at || (a.id < b.id ? -1 : 1))[0]!.id;
}
