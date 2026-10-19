import { SQUARE_EMOJI } from "@bp/core";
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

export const auraText = (aura: number) => `${aura > 0 ? "+" : aura < 0 ? "−" : ""}${Math.abs(aura).toFixed(1)}`;

// What the day's modifier came to for you, or null when there's nothing to
// say: a Blind Slate, or a day you made no call.
export function modifierResult(g: OpenGrid): { title: string; text: string } | null {
  if (g.aura === null) return null;
  if (g.modifier === "contrarian_day" && g.contrarian) {
    const n = g.contrarian.filter(Boolean).length;
    return { title: "Contrarian Day", text: n ? `${n === 1 ? "1 call" : `${n} calls`} went against the city majority and got a gold border.` : "None of your calls went against the city majority." };
  }
  if (g.modifier === "nothing_day" && g.nothing) {
    const title = "NOTHING Day";
    const bot = g.nothing;
    if (bot.beat === null) return { title, text: "The bell is still settling NOTHING Day." };
    if (bot.aura === null) return { title, text: "NOTHING-9000 had no grid that day, so there was nothing to beat." };
    if (bot.beat) return { title, text: `You beat NOTHING-9000's grid, Aura ${auraText(g.aura)} to ${auraText(bot.aura)}. ${bot.tile ? "Banner tile earned: it's in your home's storage." : "You already have its banner tile."}` };
    return { title, text: `NOTHING-9000's grid held, Aura ${auraText(bot.aura)} to your ${auraText(g.aura)}.` };
  }
  return null;
}

// The city day the last bell closed (UTC, the city's clock).
export const lastBellDay = (now: number) => new Date(now - 86_400_000).toISOString().slice(0, 10);
