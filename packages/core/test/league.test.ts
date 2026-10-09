import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { leagueScore, promote, sizeGroupOf } from "../src";

describe("the Crew League", () => {
  it("size groups", () => {
    expect([2, 3, 10, 11, 25, 26, 50, 51].map(sizeGroupOf)).toEqual([null, "small", "small", "medium", "medium", "large", "large", null]);
  });

  it("score: the average of the top 5 callers' Aura, plus full-Slate points capped at 10 a night", () => {
    expect(leagueScore([1000, 2000, 3000, 4000, 5000, 100], [])).toBe((5000 + 4000 + 3000 + 2000 + 1000) / 5 / 100);
    expect(leagueScore([500], [12, 3])).toBe(5 + 10 + 3); // one sharp caller can't carry the average past themselves
    expect(leagueScore([], [])).toBe(0);
  });

  it("top 3 of each division go up, bottom 3 go down", () => {
    const ladder = Array.from({ length: 20 }, (_, i) => `c${i}`); // div 1: c0..c9, div 2: c10..c19
    const score = new Map(ladder.map((c, i) => [c, i < 10 ? 10 - i : 100 - i])); // div 2 all outscore div 1, best is c10
    const next = promote(ladder, score);
    expect(next.slice(0, 10)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c10", "c11", "c12"]);
    expect(next.slice(10, 13)).toEqual(["c7", "c8", "c9"]);
  });

  it("crews that didn't play (5+ callers) never go up, and sink within their division", () => {
    const ladder = Array.from({ length: 13 }, (_, i) => `c${i}`);
    const score = new Map<string, number | null>(ladder.map((c, i) => [c, i === 2 ? null : 13 - i]));
    score.set("c10", null);
    score.set("c11", 50);
    const next = promote(ladder, score);
    expect(next.slice(0, 10)).toContain("c11");
    expect(next.slice(0, 10)).not.toContain("c10");
    expect(next.indexOf("c2")).toBeGreaterThanOrEqual(10 - 1); // the idle crew sank to the bottom and went down
  });

  it("the ladder is always a permutation of the crews", () => {
    fc.assert(
      fc.property(fc.array(fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: null }), { maxLength: 57 }), (scores) => {
        const ladder = scores.map((_, i) => `c${i}`);
        const next = promote(ladder, new Map(ladder.map((c, i) => [c, scores[i]!])));
        expect([...next].sort()).toEqual([...ladder].sort());
      }),
      { seed: 34, numRuns: 2000 },
    );
  });
});
