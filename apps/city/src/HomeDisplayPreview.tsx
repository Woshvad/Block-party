"use client";
import { useState } from "react";
import HomeDisplay from "./HomeDisplay";
import type { Api } from "./api";
const api: Pick<Api, "binder" | "reel"> = {
  binder: async () => ({ season: 1, receipts: [{ callId: "preview", question: "Will the home side win the weekend final?", side: "yes", chance: 65, world: 51, aura: 12.5, resolvedAt: "2026-10-10T12:00:00Z" }] }),
  reel: async () => ({ bellDay: "2026-10-11", slate: [{ slot: 0, question: "Will the home side win the weekend final?", result: "yes" }] }),
};
export default function HomeDisplayPreview() {
 const [kind, setKind] = useState<"trophy_wall" | "tv" | null>(null);
 return <main className="screen center"><span className="eyebrow">SIMULATED HOME DISPLAYS</span><h1>Make room for your story.</h1><button className="btn" onClick={() => setKind("trophy_wall")}>Trophy wall</button><button className="btn" onClick={() => setKind("tv")}>Watch TV</button>{kind && <HomeDisplay api={api} owner="preview" kind={kind} onClose={() => setKind(null)} />}</main>;
}
