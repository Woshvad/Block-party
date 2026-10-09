import { escrowAccountId } from "./ledger";

// Fade Duels (Marvel Snap's doubling cube): a GM side pot between two
// residents on opposite sides of a market. Never a stake in the market,
// never real money, never Aura. No GM is created: the winner takes the pot.

export const DUEL = {
  ante: 10,
  maxStake: 80, // per player: 10, a Snap each (×2 ×2), and Last Call (×2)
  openMax: 3, // offered or active, per resident
  minGm: 300, // to start or accept one
  pairWindowDays: 7, // one duel per pair of accounts a week
  lastCallHour: 23, // "Bell in 60"
} as const;

export const duelAccountId = (duelId: string) => escrowAccountId("duel", duelId);

// A retreat: your ante goes to your opponent, the rest of your stake burns,
// and your opponent gets their own stake back. "Retreated · 30 GM burned".
export function retreatSplit(stake: number): { toOpponent: number; burned: number } {
  if (!Number.isSafeInteger(stake) || stake < DUEL.ante) throw new Error("a stake is at least the ante");
  return { toOpponent: DUEL.ante, burned: stake - DUEL.ante };
}

// Doubling never takes a stake past the cap.
export const canDouble = (stake: number) => stake * 2 <= DUEL.maxStake;

// The Grudge Match: the one duel a newcomer can play from minute one, against
// the friend who invited them, head to head on tomorrow's Slate. 10 GM each,
// no Snap, once per pair, never real money.
export const GRUDGE = { stake: 10 } as const;
export const grudgeAccountId = (matchId: string) => escrowAccountId("grudge", matchId);

// Higher Slate Aura wins the pot; a tie gives both stakes back.
export function grudgeWinner(a: { id: string; auraCenti: number }, b: { id: string; auraCenti: number }): string | null {
  if (a.auraCenti === b.auraCenti) return null;
  return a.auraCenti > b.auraCenti ? a.id : b.id;
}
