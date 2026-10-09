import { describe, expect, it } from "vitest";
import { DUEL, canDouble, duelAccountId, retreatSplit } from "../src";

describe("Fade Duel rules", () => {
  it("a retreat: the ante to the opponent, the rest burns", () => {
    expect(retreatSplit(10)).toEqual({ toOpponent: 10, burned: 0 });
    expect(retreatSplit(40)).toEqual({ toOpponent: 10, burned: 30 }); // "Retreated · 30 GM burned"
    expect(() => retreatSplit(5)).toThrow();
    expect(() => retreatSplit(10.5)).toThrow();
  });

  it("10 → 20 → 40 → 80 and no further", () => {
    let s: number = DUEL.ante;
    const path = [s];
    while (canDouble(s)) path.push((s *= 2)); // loop-bound: doubles until the 80 cap, 3 times
    expect(path).toEqual([10, 20, 40, 80]);
  });

  it("each duel has its own escrow", () => {
    expect(duelAccountId("abc")).toBe("escrow:duel:abc");
  });
});

describe("Grudge Match rules", () => {
  it("higher Slate Aura wins; a tie is a draw; its own escrow", async () => {
    const { grudgeWinner, grudgeAccountId } = await import("../src");
    expect(grudgeWinner({ id: "a", auraCenti: 100 }, { id: "b", auraCenti: -50 })).toBe("a");
    expect(grudgeWinner({ id: "a", auraCenti: -1 }, { id: "b", auraCenti: 0 })).toBe("b");
    expect(grudgeWinner({ id: "a", auraCenti: 0 }, { id: "b", auraCenti: 0 })).toBeNull();
    expect(grudgeAccountId("x")).toBe("escrow:grudge:x");
  });
});
