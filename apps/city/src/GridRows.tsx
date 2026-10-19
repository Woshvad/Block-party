"use client";
import type { OpenGrid } from "./api";
import { type GridLineProps, gridLines } from "./modifiers";

// A revealed grid as squares. On Contrarian Day a call against the city
// majority gets a gold border and a star; on NOTHING Day NOTHING-9000's grid
// sits under yours. Each square says what it is to a screen reader.
export default function GridRows({ g }: { g: OpenGrid }) {
  const gold = g.contrarian?.some(Boolean) ?? false;
  return (
    <div className="grid-rows">
      {gridLines(g).map((l) => (
        <GridLine key={l.who} {...l} />
      ))}
      {gold && (
        <p className="grid-key">
          <span className="grid-key-mark" aria-hidden="true">★</span> Gold border: a call against the city majority.
        </p>
      )}
    </div>
  );
}

function GridLine({ who, label, cells }: GridLineProps) {
  return (
    <div className="grid-line">
      <span className="grid-who" aria-hidden="true">{who}</span>
      <ol className="grid-row" aria-label={label}>
        {cells.map((c, i) => (
          <li key={i} className={`grid-square${c.contrarian ? " contrarian" : ""}`}>
            <span aria-hidden="true">{c.emoji}</span>
            {c.contrarian && <span className="contrarian-mark" aria-hidden="true">★</span>}
            <span className="sr-only">{c.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
