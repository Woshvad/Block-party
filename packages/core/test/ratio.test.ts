import { describe, expect, it } from "vitest";
import { ratioPrompt, ratioWinner } from "../src";

describe("the Ratio of the Day", () => {
  it("the prompt", () => {
    expect(ratioPrompt(8, 61)).toBe("World 8% · City 61%. Write the headline for when it settles.");
  });
  it("most wins, then win rate, then the earliest; no wins, no winner", () => {
    expect(ratioWinner([])).toBeNull();
    expect(ratioWinner([{ id: "a", wins: 0, shown: 4, at: 1 }])).toBeNull();
    expect(ratioWinner([{ id: "a", wins: 3, shown: 9, at: 1 }, { id: "b", wins: 4, shown: 9, at: 2 }])).toBe("b");
    expect(ratioWinner([{ id: "a", wins: 3, shown: 9, at: 1 }, { id: "b", wins: 3, shown: 4, at: 2 }])).toBe("b");
    expect(ratioWinner([{ id: "a", wins: 3, shown: 4, at: 5 }, { id: "b", wins: 3, shown: 4, at: 2 }])).toBe("b");
  });
});
