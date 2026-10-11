"use client";
import { useState } from "react";
import HomeDisplay from "./HomeDisplay";
import { previewHomeApi } from "./homeDisplayFixture";
export default function HomeDisplayPreview() {
 const [kind, setKind] = useState<"trophy_wall" | "tv" | null>(null);
 return <main className="screen center"><span className="eyebrow">SIMULATED HOME DISPLAYS</span><h1>Make room for your story.</h1><button className="btn" onClick={() => setKind("trophy_wall")}>Trophy wall</button><button className="btn" onClick={() => setKind("tv")}>Watch TV</button>{kind && <HomeDisplay preview api={previewHomeApi} owner="preview" kind={kind} onClose={() => setKind(null)} />}</main>;
}
