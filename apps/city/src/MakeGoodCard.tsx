"use client";
import type { MakeGood } from "./api";

// Today's card when the city owes everyone one: the reason, the GM, Collect,
// and × to set it aside for this visit.
export default function MakeGoodCard({ m, pending, onCollect, onSetAside }: { m: MakeGood; pending: boolean; onCollect: () => void; onSetAside: () => void }) {
  return (
    <section className="make-good" aria-labelledby={`make-good-${m.id}`}>
      <div>
        <span className="eyebrow">FROM THE CITY</span>
        <p id={`make-good-${m.id}`}>
          {m.reason} <b>+{m.amount} GM</b>
        </p>
      </div>
      <div className="make-good-actions">
        <button className="cta" onClick={onCollect} disabled={pending}>
          {pending ? "Collecting…" : "Collect"}
        </button>
        <button className="make-good-close" aria-label="Not now" onClick={onSetAside} disabled={pending}>
          ×
        </button>
      </div>
    </section>
  );
}
