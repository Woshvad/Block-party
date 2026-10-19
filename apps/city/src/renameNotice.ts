import type { HandleNotice } from "./api";

// What a renamed resident reads the next time they open the app (GET /v1/me
// carries the notice until they tap OK). Kept out of the .tsx so it can be
// tested.
//
// Profile links carry the handle, so old ones stop finding them: nobody while
// the old handle rests, then whoever takes it next. So the line says only that
// they won't find you. Back to the same letters in another case, they still do.
export function handleNoticeText(n: Pick<HandleNotice, "from" | "to" | "reason">) {
  return {
    title: `You're @${n.to} now`,
    changed: `Staff changed your handle from @${n.from}.`,
    why: `Why: ${n.reason}`,
    links: n.from.toLowerCase() === n.to.toLowerCase() ? null : "Old links to your profile won't find you any more.",
  };
}

// The notice to show: the one /v1/me sent, unless it was dismissed this visit.
export function noticeToShow(n: HandleNotice | null | undefined, dismissed: ReadonlySet<string>): HandleNotice | null {
  return n && !dismissed.has(n.id) ? n : null;
}
