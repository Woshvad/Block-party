// Frens, best frens, rivals and crew bonds. None of it ever touches GM.

export const RELATIONSHIPS = {
  bestFrens: 3,
  rivals: 3, // active and pending together, per resident
  bondLevels: [1, 5, 15, 40] as readonly number[], // shared days for levels 1 to 4
} as const;

export function bondLevel(days: number): number {
  return RELATIONSHIPS.bondLevels.filter((d) => days >= d).length;
}
