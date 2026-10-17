// Make-goods: when the city lets everyone down (an outage), staff give every
// resident some GM to say sorry. Each resident who had moved in before it went
// out collects it once, by hand; nothing ever runs over every resident.

export const MAKE_GOOD_MAX = 200; // whole GM, per resident

export const MAKE_GOOD = {
  max: MAKE_GOOD_MAX,
  everyDays: 7, // never two within 7 days of each other
  collectDays: 14, // each resident collects within 14 days of it going out
  reasonMinChars: 5,
  reasonMaxChars: 80, // every resident reads it on Today
  kind: "make_good", // the ledger kind it's minted under
} as const;

const DAY_MS = 86_400_000;

// A whole number of GM, 1 to the cap.
export function makeGoodAmountOk(amount: unknown): amount is number {
  return Number.isSafeInteger(amount) && (amount as number) >= 1 && (amount as number) <= MAKE_GOOD_MAX;
}

// The moment a make-good stops being collectable.
export const makeGoodClosesAt = (createdAt: Date) => new Date(createdAt.getTime() + MAKE_GOOD.collectDays * DAY_MS);

// No other make-good may go out within 7 days of this moment, either side, so
// it doesn't matter which order two are written in.
export const makeGoodQuietWindow = (now: Date) => ({
  from: new Date(now.getTime() - MAKE_GOOD.everyDays * DAY_MS),
  to: new Date(now.getTime() + MAKE_GOOD.everyDays * DAY_MS),
});

// Whether a resident can collect one: they had moved in before it went out
// (a guest never moved in), and it's out and not yet closed.
export function makeGoodOpenTo(m: { createdAt: Date }, movedInAt: Date | null, now: Date): "open" | "not_eligible" | "not_yet" | "closed" {
  if (!movedInAt || movedInAt.getTime() >= m.createdAt.getTime()) return "not_eligible";
  if (now.getTime() < m.createdAt.getTime()) return "not_yet";
  if (now.getTime() >= makeGoodClosesAt(m.createdAt).getTime()) return "closed";
  return "open";
}
