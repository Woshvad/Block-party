import { describe, expect, it } from "vitest";
import type { OpenGrid } from "../src/api";
import { CONTRARIAN_LINE, MODIFIER_NAMES, auraText, gridCells, lastBellDay, modifierResult } from "../src/modifiers";

const grid = (over: Partial<OpenGrid> = {}): OpenGrid => ({
  cityDay: "2026-10-18",
  sealed: false,
  number: 14,
  modifier: "blind_slate",
  squares: ["green", "red", "white", "black", "pending", "gold"],
  share: "Block Party #14 🟩🟥⬜⬛⏳🟨",
  aura: 7.4,
  percentile: 50,
  contrarian: null,
  nothing: null,
  ...over,
});
const nothing = (over: Partial<NonNullable<OpenGrid["nothing"]>> = {}) => ({ squares: grid().squares, aura: -3.1, beat: true, tile: true, ...over });

describe("the grid's squares", () => {
  it("each says what it is in words; a gold border says so too, never by colour alone", () => {
    const cells = gridCells(["green", "red", "black"], [false, true, false]);
    expect(cells.map((c) => c.emoji)).toEqual(["🟩", "🟥", "⬛"]);
    expect(cells.map((c) => c.label)).toEqual(["Card 1: beat the market", "Card 2: REKT, against the city (gold border)", "Card 3: no call"]);
    expect(cells.map((c) => c.contrarian)).toEqual([false, true, false]);
  });

  it("no border list (another day) means no gold border, and every square has words", () => {
    const all = ["green", "white", "red", "black", "gold", "void", "pending"] as const;
    const cells = gridCells(all);
    expect(cells.every((c) => !c.contrarian && !c.label.includes("gold") && !c.label.includes("unknown"))).toBe(true);
    expect(gridCells(["green"], [])).toEqual([{ emoji: "🟩", label: "Card 1: beat the market", contrarian: false }]);
  });
});

describe("what the modifier came to", () => {
  it("Contrarian Day counts your gold borders", () => {
    expect(modifierResult(grid({ modifier: "contrarian_day", contrarian: [false, true, false, false, false, true] }))).toEqual({ title: "Contrarian Day", text: "2 calls went against the city majority and got a gold border." });
    expect(modifierResult(grid({ modifier: "contrarian_day", contrarian: [true, false, false, false, false, false] }))!.text).toBe("1 call went against the city majority and got a gold border.");
    expect(modifierResult(grid({ modifier: "contrarian_day", contrarian: [false, false, false, false, false, false] }))!.text).toBe("None of your calls went against the city majority.");
  });

  it("NOTHING Day: beat it (tile or not), held, still settling, or no bot grid", () => {
    const day = (n: ReturnType<typeof nothing>, aura = 7.4) => modifierResult(grid({ modifier: "nothing_day", nothing: n, aura }))!.text;
    expect(day(nothing())).toBe("You beat NOTHING-9000's grid, Aura +7.4 to −3.1. Banner tile earned: it's in your home's storage.");
    expect(day(nothing({ tile: false }))).toBe("You beat NOTHING-9000's grid, Aura +7.4 to −3.1. You already have its banner tile.");
    expect(day(nothing({ beat: false, tile: false, aura: 2 }), -5)).toBe("NOTHING-9000's grid held, Aura +2.0 to your −5.0.");
    expect(day(nothing({ beat: null, tile: false }))).toBe("The bell is still settling NOTHING Day.");
    expect(day(nothing({ beat: false, tile: false, aura: null, squares: [] }))).toBe("NOTHING-9000 had no grid that day, so there was nothing to beat.");
    expect(modifierResult(grid({ modifier: "nothing_day", nothing: nothing() }))!.title).toBe("NOTHING Day");
  });

  it("nothing to say on a Blind Slate, or on a day you made no call", () => {
    expect(modifierResult(grid())).toBeNull();
    expect(modifierResult(grid({ modifier: "contrarian_day", contrarian: [true, false, false, false, false, false], aura: null }))).toBeNull();
    expect(modifierResult(grid({ modifier: "nothing_day", nothing: nothing(), aura: null }))).toBeNull();
  });

  it("names, Aura and the receipt line read plainly", () => {
    expect(MODIFIER_NAMES).toEqual({ contrarian_day: "Contrarian Day", nothing_day: "NOTHING Day", blind_slate: "Blind Slate" });
    expect([auraText(7.44), auraText(-3.06), auraText(0)]).toEqual(["+7.4", "−3.1", "0.0"]);
    expect(CONTRARIAN_LINE).toBe("Against the city · Contrarian Day");
  });

  it("the last bell closed the city day before (UTC)", () => {
    expect(lastBellDay(Date.parse("2026-10-19T00:05:00Z"))).toBe("2026-10-18");
    expect(lastBellDay(Date.parse("2026-10-19T23:59:00Z"))).toBe("2026-10-18");
  });
});
