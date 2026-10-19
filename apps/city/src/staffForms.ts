import { HANDLE_RENAME, MODERATION, ResidentInputError, renameReason, validateHandle } from "@bp/core";

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
  if (item.kind === "resident_name") return "Resident's name";
  if (item.kind === "resident_handle") return "Resident's handle";
  if (item.kind === "make_good") return "Make-good reason";
  return item.kind;
}

// Where a queued item stands: flagged text is down (a flagged name shows as
// the @handle; a handle can't be taken down, so it stays shown); text the
// check couldn't read is still up.
export function itemState(item: Pick<ModerationItem, "kind" | "status" | "categories">): string {
  if (item.status === "error") return "the AI check couldn't read it; still up";
  const why = `flagged: ${item.categories.join(", ").replace(/_/g, " ") || "no category"}`;
  return item.kind === "resident_handle" ? `${why}; still shown` : `${why}; taken down`;
}

// The buttons a queued item gets. Flagged text is already down: staff put it
// back or keep it down. Text the AI check never read is still up: staff pass
// it or take it down. A room line can't come back once taken down, and a
// flagged handle stays shown until it's renamed (Rename, which also clears it
// from the queue), so those get only what can actually happen.
export function reviewChoices(item: Pick<ModerationItem, "kind" | "status">): Array<{ verdict: "restore" | "remove"; label: string }> {
  if (item.kind === "resident_handle") return [{ verdict: "restore", label: "It's fine" }, { verdict: "remove", label: "Handled another way" }];
  if (item.status === "error") return [{ verdict: "restore", label: "It's fine" }, { verdict: "remove", label: "Take it down" }];
  if (item.kind === "room") return [{ verdict: "remove", label: "Keep it down" }];
  return [{ verdict: "restore", label: "Put it back" }, { verdict: "remove", label: "Keep it down" }];
}

// --- Renaming a flagged @handle -------------------------------------------------

// Who a Rename button renames: a flagged handle's or display name's resident
// (the item's ref; a name taken down shows the @handle, so a handle saying the
// same thing needs renaming too), or the target of an impersonation report.
export function renameTarget(item: Pick<ModerationItem, "kind" | "ref">): string | null {
  return item.kind === "resident_handle" || item.kind === "resident_name" ? item.ref : null;
}
export const reportRenames = (r: { reason?: unknown }) => r.reason === "impersonation";

// The handle a Rename on a queued item goes from (the API needs it): a
// flagged handle's own text, as that's what staff are judging, so if they've
// been renamed since nothing happens; for a flagged name, their handle as the
// console loaded it (null until it has).
export function itemRenameFrom(item: Pick<ModerationItem, "kind" | "text">, loaded: string | null): string | null {
  return item.kind === "resident_handle" ? item.text : loaded;
}

// What a rename still needs before the API will take it, in words, or null
// when it's ready. An empty handle means a neutral one. The same rules the
// API checks (core's handle rules, the reason's limits); it also checks the
// handle is free and staff's blocked words.
export function renameProblem(f: { newHandle: string; reason: string }): string | null {
  if (f.newHandle.trim()) {
    try {
      validateHandle(f.newHandle);
    } catch (e) {
      if (e instanceof ResidentInputError) return `New handle: ${e.reason}.`;
      throw e;
    }
  }
  if (renameReason(f.reason) === null) return `The reason the resident reads needs ${HANDLE_RENAME.reasonMinChars} to ${HANDLE_RENAME.reasonMaxChars} characters.`;
  return null;
}

// The confirm before renaming. Telegram's own dialog takes up to 256 characters.
export function renameConfirm(f: { from: string; newHandle: string }): string {
  const h = f.newHandle.trim().replace(/^@/, "");
  return `Rename @${f.from} to ${h ? `@${h}` : "a neutral handle"}? They see your reason next time they open the app. Their old profile link stops working, and no one else can take the old handle for ${HANDLE_RENAME.holdDays} days.`;
}

// The request: trimmed, and only what's filled in, but always `from`, the
// handle staff were looking at: the API needs it, so a resident someone else
// renamed a moment ago isn't renamed twice.
export function renameBody(f: { newHandle: string; reason: string }, from: string, reportId?: string) {
  const h = f.newHandle.trim().replace(/^@/, "");
  return { reason: f.reason.trim(), from, ...(h ? { newHandle: h } : {}), ...(reportId ? { reportId } : {}) };
}
