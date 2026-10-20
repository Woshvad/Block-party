"use client";
import type { InPlayRow } from "./api";

// The Watch Party Hall's matches in play, over the room: each at its live
// price, with a way to call it. An in-play call locks about 2 minutes after
// you confirm, if the price holds, for half the Aura (the call sheet says so).
export const IN_PLAY_SHOWN = 3;

export default function InPlayStrip({ rows, onCall }: { rows: readonly InPlayRow[]; onCall: (marketId: string) => void }) {
  if (!rows.length) return null;
  return (
    <section className="inplay-strip" aria-label="Matches in play">
      <p className="inplay-eyebrow">
        <span className="inplay-dot" aria-hidden="true" />
        In play · half Aura
      </p>
      <ul>
        {rows.slice(0, IN_PLAY_SHOWN).map((m) => (
          <li key={m.id}>
            <span className="inplay-q" title={m.question}>
              {m.question}
            </span>
            <b className="inplay-price">{m.price}%</b>
            <button onClick={() => onCall(m.id)} aria-label={`Call it in play: ${m.question}`}>
              Call it
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
