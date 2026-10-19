import { HANDLE_RENAME, renameAppeal } from "@bp/core";
import type { HandleNotice, RenameAppeal } from "./api";

// What a renamed resident reads the next time they open the app (GET /v1/me
// carries the notice until they tap OK). Kept out of the .tsx so it can be
// tested.
//
// Profile links carry the handle, so old ones stop finding them: nobody while
// the old handle rests, then whoever takes it next. So the line says only that
// they won't find you. Back to the same letters in another case, they still do.
// Every staff action can be appealed, a rename too, from Me; not the rename
// that gave a handle back after an appeal.
export function handleNoticeText(n: Pick<HandleNotice, "from" | "to" | "reason" | "appealable">) {
  return {
    title: `You're @${n.to} now`,
    changed: `Staff changed your handle from @${n.from}.`,
    why: `Why: ${n.reason}`,
    links: n.from.toLowerCase() === n.to.toLowerCase() ? null : "Old links to your profile won't find you any more.",
    appeal: n.appealable === false ? null : `Think we got it wrong? You can appeal in Me for ${HANDLE_RENAME.holdDays} days.`,
  };
}

// The notice to show: the one /v1/me sent, unless it was dismissed this visit.
export function noticeToShow(n: HandleNotice | null | undefined, dismissed: ReadonlySet<string>): HandleNotice | null {
  return n && !dismissed.has(n.id) ? n : null;
}

// What an appeal still needs before the API will take it, in words, or null
// when it's ready (the same limits it checks).
export function appealProblem(text: string): string | null {
  return renameAppeal(text) === null ? `Your appeal needs ${HANDLE_RENAME.appealMinChars} to ${HANDLE_RENAME.appealMaxChars} characters.` : null;
}

// Where their appeal stands, in Me.
export function appealState(a: Pick<RenameAppeal, "status" | "note">): string {
  if (a.status === "open") return "Appeal sent: a person will look at it.";
  const why = a.note ? ` Why: ${a.note}` : "";
  return a.status === "upheld" ? `Staff looked again and kept your new handle.${why}` : `Staff gave your old handle back.${why}`;
}
