"use client";
import type { OpenGrid } from "./api";
import { type GridCell, gridCells } from "./modifiers";

// A revealed grid as squares. On Contrarian Day a call against the city
// majority gets a gold border and a star; on NOTHING Day NOTHING-9000's grid
// sits under yours. Each square says what it is to a screen reader.
export default function GridRows({ g }: { g: OpenGrid }) {
  const gold = g.contrarian?.some(Boolean) ?? false;
  return (
    <div className="grid-rows">
      <GridLine who="You" label={`Your grid, Block Party #${g.number}`} cells={gridCells(g.squares, g.contrarian)} />
      {g.nothing && <GridLine who="NOTHING-9000 · NPC · AI" label="NOTHING-9000's grid" cells={gridCells(g.nothing.squares)} />}
      {gold && (
        <p className="grid-key">
          <span className="grid-key-mark" aria-hidden="true">★</span> Gold border: a call against the city majority.
        </p>
      )}
    </div>
  );
}

function GridLine({ who, label, cells }: { who: string; label: string; cells: GridCell[] }) {
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
