import type { Api } from "./api";
export const previewHomeApi: Pick<Api, "binder" | "reel"> = {
  binder: async () => ({ season: 1, receipts: [{ callId: "preview", question: "Will the home side win the weekend final?", side: "yes", chance: 65, world: 51, aura: 12.5, resolvedAt: "2026-10-10T12:00:00Z" }] }),
  reel: async () => ({ bellDay: "2026-10-11", slate: [{ slot: 0, question: "Will the home side win the weekend final?", result: "yes" }] }),
};
