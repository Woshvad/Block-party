"use client";
import type { InPlayRow } from "./api";

// The Watch Party Hall's matches in play, over the room: each at its live
// price, with a way to call it. An in-play call locks about 2 minutes after
// you confirm, if the price holds, for half the Aura (the call sheet says so).
// The credit says where the odds came from ("Sample odds · Not real" off the
// sample feed).
export const IN_PLAY_SHOWN = 3;

export default function InPlayStrip({ rows, onCall }: { rows: readonly InPlayRow[]; onCall: (marketId: string) => void }) {
  if (!rows.length) return null;
  const shown = rows.slice(0, IN_PLAY_SHOWN);
  const credits = [...new Set(shown.map((m) => m.source))];
  return (
    <section className="inplay-strip" aria-label="Matches in play">
      <p className="inplay-eyebrow">
        <span className="inplay-dot" aria-hidden="true" />
        In play · half Aura
      </p>
      <ul>
        {shown.map((m) => (
          <li key={m.id}>
            <span className="inplay-q" title={m.question}>
              {m.question}
            </span>
            <b className="inplay-price">{m.price}% YES</b>
            <button onClick={() => onCall(m.id)} aria-label={`Call it in play: ${m.question}`}>
              Call it
            </button>
          </li>
        ))}
      </ul>
      {credits.length > 0 && <p className="inplay-credit">{credits.join(" · ")}</p>}
    </section>
  );
}
