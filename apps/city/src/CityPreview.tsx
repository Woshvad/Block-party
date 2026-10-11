"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import type { Api, Me } from "./api";
const CityBoard = dynamic(() => import("./CityBoard"), { ssr: false });
// Isolated art review: no account, API calls, fabricated live counts or trades.
const api: Pick<Api, "cityHall" | "slate"> = { cityHall: async () => ({ mayor: null, law: null, election: null }), slate: async () => null };
const guest: Me = { userId: "preview", status: "guest", gm: 0, resident: null, crew: null };
export default function CityPreview() {
  const [showcase, setShowcase] = useState(false);
  return <><CityBoard api={api} me={guest} showcase={showcase} /><nav className="preview-switch" aria-label="Design previews"><button onClick={() => setShowcase((v) => !v)}>{showcase ? "← City view" : "Explore the diner block"}</button><a href="/room-test">Interiors ↗</a></nav></>;
}
