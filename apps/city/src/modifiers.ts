import { CAST, SQUARE_EMOJI } from "@bp/core";
import type { GridSquare, OpenGrid } from "./api";

// The Bell Modifiers' results in plain words: Contrarian Day's gold borders
// and NOTHING Day's banner tile. Every one has text, never colour alone.

export const MODIFIER_NAMES: Record<string, string> = { contrarian_day: "Contrarian Day", nothing_day: "NOTHING Day", blind_slate: "Blind Slate" };

const SQUARE_WORDS: Record<GridSquare, string> = {
  green: "beat the market",
  white: "hugged the market",
  red: "REKT",
  black: "no call",
  gold: "Long Shot hit",
  void: "voided",
  pending: "not settled by the bell",
};

export const CONTRARIAN_LINE = "Against the city · Contrarian Day";

export type GridCell = { emoji: string; label: string; contrarian: boolean };

// One cell per card: its square, what a screen reader says, and the gold border.
export function gridCells(squares: readonly GridSquare[], contrarian: readonly boolean[] | null = null): GridCell[] {
  return squares.map((s, i) => {
    const gold = contrarian?.[i] === true;
    return { emoji: SQUARE_EMOJI[s] ?? "⬛", label: `Card ${i + 1}: ${SQUARE_WORDS[s] ?? "unknown"}${gold ? ", against the city (gold border)" : ""}`, contrarian: gold };
  });
}

export type GridLineProps = { who: string; label: string; cells: GridCell[] };

// The rows a revealed grid draws: yours, then NOTHING-9000's on NOTHING Day.
// Each list's name for a screen reader says what's written over it, so the
// bot's row is NPC · AI out loud too, never only on screen.
export function gridLines(g: OpenGrid): GridLineProps[] {
  const lines = [{ who: "You", label: `Your grid, Block Party #${g.number}`, cells: gridCells(g.squares, g.contrarian) }];
  const bot = CAST.nothing_9000;
  if (g.nothing) lines.push({ who: `${bot.name} · ${bot.label}`, label: `${bot.name}'s grid, ${bot.label}`, cells: gridCells(g.nothing.squares) });
  return lines;
}

export const auraText = (aura: number) => `${aura > 0 ? "+" : aura < 0 ? "−" : ""}${Math.abs(aura).toFixed(1)}`;

// The grid opens at midnight, but the bell settles its modifier a few minutes
// later: until then neither Contrarian Day nor NOTHING Day has a result.
export const stillSettling = (g: OpenGrid) => (g.modifier === "contrarian_day" && g.contrarian === null) || (g.modifier === "nothing_day" && g.nothing?.beat === null);

// What the day's modifier came to for you, or null when there's nothing to
// say: a Blind Slate, or a day you made no call.
export function modifierResult(g: OpenGrid): { title: string; text: string } | null {
  if (g.aura === null) return null;
  if (g.modifier === "contrarian_day") {
    const title = "Contrarian Day";
    if (!g.contrarian) return { title, text: "The bell is still settling Contrarian Day." };
    const n = g.contrarian.filter(Boolean).length;
    return { title, text: n ? `${n === 1 ? "1 call" : `${n} calls`} went against the city majority and got a gold border.` : "None of your calls went against the city majority." };
  }
  if (g.modifier === "nothing_day" && g.nothing) {
    const title = "NOTHING Day";
    const bot = g.nothing;
    if (bot.beat === null) return { title, text: "The bell is still settling NOTHING Day." };
    // The verdict's own numbers are the bell's. A card that settled after it
    // moves both grids (and the Aura shown with them), never the verdict.
    const at = bot.atBell;
    if (!at) return { title, text: "You had no call when the bell judged NOTHING Day." };
    if (at.bot === null) return { title, text: "NOTHING-9000 had no grid that day, so there was nothing to beat." };
    const moved = at.mine !== g.aura || at.bot !== bot.aura ? " A card that settled after the bell doesn't change it." : "";
    if (bot.beat) return { title, text: `You beat NOTHING-9000's grid at the bell, Aura ${auraText(at.mine)} to ${auraText(at.bot)}. ${bot.tile ? "Banner tile earned: it's in your home's storage." : "You already have its banner tile."}${moved}` };
    return { title, text: `NOTHING-9000's grid held at the bell, Aura ${auraText(at.bot)} to your ${auraText(at.mine)}.${moved}` };
  }
  return null;
}

// The city day the last bell closed (UTC, the city's clock).
export const lastBellDay = (now: number) => new Date(now - 86_400_000).toISOString().slice(0, 10);
