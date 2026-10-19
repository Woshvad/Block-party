import type { HandleNotice } from "./api";

// What a renamed resident reads the next time they open the app (GET /v1/me
// carries the notice until they tap OK). Kept out of the .tsx so it can be
// tested.
export function handleNoticeText(n: Pick<HandleNotice, "from" | "to" | "reason">) {
  return {
    title: `You're @${n.to} now`,
    changed: `Staff changed your handle from @${n.from}.`,
    why: `Why: ${n.reason}`,
    links: "Links to your old profile won't open any more.",
  };
}

// The notice to show: the one /v1/me sent, unless it was dismissed this visit.
export function noticeToShow(n: HandleNotice | null | undefined, dismissed: ReadonlySet<string>): HandleNotice | null {
  return n && !dismissed.has(n.id) ? n : null;
}
