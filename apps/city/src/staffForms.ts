import { MODERATION } from "@bp/core";

// The staff console's rules, kept out of the .tsx so they can be tested.

// How long a restriction from a report lasts. null: until staff lift it.
export const RESTRICT_FOR: ReadonlyArray<{ hours: number | null; label: string }> = [
  { hours: 24, label: "24 h" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
  { hours: null, label: "Until lifted" },
];

// What closing a report still needs before the API will take it, in words,
// or null when it's ready. The note is for staff; a restriction also needs a
// reason, which the resident reads, so it has its own field and a longer
// minimum (the same minimums the API checks).
export function resolveProblem(f: { action: "dismiss" | "restrict"; note: string; kind?: string; reason?: string }): string | null {
  if (f.note.trim().length < MODERATION.noteMinChars) return `The note needs at least ${MODERATION.noteMinChars} characters.`;
  if (f.action === "dismiss") return null;
  if (!f.kind) return "Pick a restriction.";
  if ((f.reason ?? "").trim().length < MODERATION.reasonMinChars) return `The reason the resident reads needs at least ${MODERATION.reasonMinChars} characters.`;
  return null;
}

export type ModerationItem = { id: string; kind: string; ref: string; authorId: string | null; text: string; status: string; categories: string[] };

// Where a queued item lives, in words.
export function itemPlace(item: Pick<ModerationItem, "kind" | "ref">): string {
  if (item.kind === "board" && item.ref.startsWith("ratio:")) return "Ratio headline";
  if (item.kind === "board") return "Board post";
  if (item.kind === "crew") return "Crew chat";
  if (item.kind === "dm") return "DM";
  if (item.kind === "room") return `Room line (${item.ref.split("#")[0]})`;
  if (item.kind === "crew_name") return "Crew name";
  if (item.kind === "pitch") return "Mayor pitch";
  if (item.kind === "resident_name") return "Resident's handle and name";
  return item.kind;
}

// The buttons a queued item gets. Flagged text is already down: staff put it
// back or keep it down. Text the AI check never read is still up: staff pass
// it or take it down. A room line can't come back once taken down, and a
// handle can't be changed, so those get only what can actually happen.
export function reviewChoices(item: Pick<ModerationItem, "kind" | "status">): Array<{ verdict: "restore" | "remove"; label: string }> {
  if (item.kind === "resident_name") return [{ verdict: "restore", label: "It's fine" }, { verdict: "remove", label: "Handled (restrict them in Controls)" }];
  if (item.status === "error") return [{ verdict: "restore", label: "It's fine" }, { verdict: "remove", label: "Take it down" }];
  if (item.kind === "room") return [{ verdict: "remove", label: "Keep it down" }];
  return [{ verdict: "restore", label: "Put it back" }, { verdict: "remove", label: "Keep it down" }];
}
