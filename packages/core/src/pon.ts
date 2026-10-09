// Proof of Neighbour limits (the checks themselves live in the db package).
export const PON = {
  minAccountDays: 3,
  neighboursNeeded: 5,
  overlapSeconds: 60, // sharing a room means being there together for a minute
  openVisitCapHours: 6, // a visit whose end was never reported counts for at most this long
  codeTtlMinutes: 10,
  codeAttempts: 5,
  startsPerHour: 3,
  startsPerNumberPerDay: 5,
} as const;
