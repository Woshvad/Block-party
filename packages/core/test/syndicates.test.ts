import { describe, expect, it } from "vitest";
import { shakesNeeded } from "../src";

describe("syndicate calls", () => {
  it("5 shakes, or a quarter of today's active members if fewer, never zero", () => {
    expect([0, 1, 3, 4, 5, 8, 12, 19, 20, 21, 50].map(shakesNeeded)).toEqual([1, 1, 1, 1, 2, 2, 3, 5, 5, 5, 5]);
  });
});
