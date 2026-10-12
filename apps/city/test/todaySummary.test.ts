import { describe, expect, it } from "vitest";
import type { Slate, SlateCard } from "../src/api";
import { slateSummary } from "../src/todaySummary";
const now = Date.parse("2026-10-10T12:00:00Z");
const card = (status: NonNullable<SlateCard["mine"]>["status"] | null): SlateCard => ({ slot: 0, tier: "lock", marketId: "test", question: "Test", category: "test", world: 50, freezesAt: "2026-10-10T13:00:00Z", open: true, mine: status ? { side: "yes", chance: 60, status } : null });
const slate = (cards: SlateCard[]): Slate => ({ cityDay: "2026-10-10", number: 1, modifier: "none", sealed: true, bellAt: "2026-10-11T00:00:00Z", credit: null, cards });
describe("Today progress", () => {
  it("counts accepted and pending calls while allowing rejected calls to be retried", () => {
    expect(slateSummary(slate([card("locked"), card("pending"), card("expired"), card("price_moved"), card(null)]), now)).toEqual({ submitted: 2, available: 3, total: 5 });
  });
  it("does not invite calls on frozen or closed cards", () => {
    expect(slateSummary(slate([{ ...card(null), open: false }, { ...card("expired"), freezesAt: "2026-10-10T11:00:00Z" }]), now)).toEqual({ submitted: 0, available: 0, total: 2 });
  });
  it("handles an empty Slate", () => { expect(slateSummary(slate([]), now)).toEqual({ submitted: 0, available: 0, total: 0 }); });
});
