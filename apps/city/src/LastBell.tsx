"use client";
import { useEffect } from "react";
import type { Api, OpenGrid } from "./api";
import GridRows from "./GridRows";
import { lastBellDay, modifierResult, stillSettling } from "./modifiers";
import { useLoad } from "./useLoad";

// Today's card for what last night's Bell Modifier came to for you: your
// Contrarian Day gold borders, or whether you beat NOTHING-9000's grid. Today
// works the same without it, so a failed load just shows no card.
export default function LastBell({ api, now }: { api: Pick<Api, "grid">; now: number }) {
  const day = lastBellDay(now);
  const grid = useLoad(() => api.grid(day).catch(() => null), [api, day]);
  const g = grid.data;
  const settling = !!g && !g.sealed && stillSettling(g);
  const { reload } = grid;
  // The grid opens at midnight, the result a few minutes later: look again
  // each minute until the bell has settled it (a failed look stops it).
  useEffect(() => {
    if (!settling) return;
    const t = setTimeout(() => void reload(), 60_000);
    return () => clearTimeout(t);
  }, [settling, g, reload]);
  return g && !g.sealed ? <LastBellView g={g} /> : null;
}

export function LastBellView({ g }: { g: OpenGrid }) {
  const r = modifierResult(g);
  if (!r) return null;
  return (
    <section className="last-bell" aria-labelledby="last-bell-title">
      <span className="eyebrow">LAST NIGHT'S BELL · #{g.number}</span>
      <h2 id="last-bell-title">{r.title}</h2>
      <GridRows g={g} />
      <p>{r.text}</p>
    </section>
  );
}
