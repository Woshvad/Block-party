import { cleanText } from "./moderation";
import type { RandomInt } from "./random";
import { validateHandle } from "./resident";

// Staff renames for flagged @handles. Handles are fixed at MVP: only staff can
// change one, with a reason the resident reads (the EU statement of reasons,
// as with a restriction). The old handle then rests, so nobody else can pick
// it up and pass as them; the plan doesn't say for how long, so 30 days.

export const HANDLE_RENAME = {
  holdDays: 30,
  reasonMinChars: 20, // the same minimum as a restriction's reason
  reasonMaxChars: 200, // a short notice, read once
  neutralPrefix: "neighbour_",
} as const;

const DAY_MS = 86_400_000;

// When an old handle stops resting and anyone may take it again.
export const handleHeldUntil = (renamedAt: Date) => new Date(renamedAt.getTime() + HANDLE_RENAME.holdDays * DAY_MS);

// A neutral handle for a rename where staff give none: "neighbour_" and five
// digits. Always valid under validateHandle (property-tested); whether it's
// free is the database's business, so the caller tries another if not.
export function neutralHandle(rand: RandomInt): string {
  return validateHandle(`${HANDLE_RENAME.neutralPrefix}${String(rand(100_000)).padStart(5, "0")}`);
}

// The reason as the resident will read it: invisible characters gone, one
// line, and between the limits. null when it isn't a usable reason.
export function renameReason(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 4 * HANDLE_RENAME.reasonMaxChars) return null;
  const r = cleanText(input).replace(/\s+/g, " ").trim();
  const n = [...r].length;
  return n >= HANDLE_RENAME.reasonMinChars && n <= HANDLE_RENAME.reasonMaxChars ? r : null;
}
