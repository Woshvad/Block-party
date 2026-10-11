import type { Slate, SlateCard } from "./api";
export function callSubmitted(card: SlateCard) { return card.mine?.status === "locked" || card.mine?.status === "pending"; }
export function slateSummary(slate: Slate, now: number) {
  const submitted = slate.cards.filter(callSubmitted).length;
  const available = slate.cards.filter((c) => !callSubmitted(c) && c.open && Date.parse(c.freezesAt) > now).length;
  return { submitted, available, total: slate.cards.length };
}
