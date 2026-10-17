import { describe, expect, it } from "vitest";
import { MAKE_GOOD, MAKE_GOOD_MAX, makeGoodAmountOk, makeGoodClosesAt, makeGoodOpenTo, makeGoodQuietWindow } from "../src";

const DAY = 86_400_000;
const out = new Date("2026-10-01T12:00:00Z");

describe("make-goods", () => {
  it("the amount is a whole number of GM, 1 to the cap of 200", () => {
    expect(MAKE_GOOD_MAX).toBe(200);
    expect(MAKE_GOOD.max).toBe(MAKE_GOOD_MAX);
    for (const ok of [1, 100, 200]) expect(makeGoodAmountOk(ok), String(ok)).toBe(true);
    for (const bad of [0, -1, 201, 1.5, NaN, Infinity, "100", null, undefined, [100], Number.MAX_SAFE_INTEGER + 2]) expect(makeGoodAmountOk(bad), String(bad)).toBe(false);
  });

  it("collectable for 14 days from when it went out", () => {
    expect(makeGoodClosesAt(out).getTime() - out.getTime()).toBe(14 * DAY);
  });

  it("no other make-good within 7 days either side", () => {
    const w = makeGoodQuietWindow(out);
    expect([out.getTime() - w.from.getTime(), w.to.getTime() - out.getTime()]).toEqual([7 * DAY, 7 * DAY]);
  });

  it("only residents who had moved in before it went out, and only while it's open", () => {
    const before = new Date(out.getTime() - 1);
    expect(makeGoodOpenTo({ createdAt: out }, before, out)).toBe("open");
    expect(makeGoodOpenTo({ createdAt: out }, before, new Date(out.getTime() + 14 * DAY - 1))).toBe("open");
    expect(makeGoodOpenTo({ createdAt: out }, before, new Date(out.getTime() + 14 * DAY))).toBe("closed");
    expect(makeGoodOpenTo({ createdAt: out }, before, new Date(out.getTime() - 1))).toBe("not_yet");
    // Moving in at the very moment it went out is too late, and a guest never moved in.
    expect(makeGoodOpenTo({ createdAt: out }, out, out)).toBe("not_eligible");
    expect(makeGoodOpenTo({ createdAt: out }, new Date(out.getTime() + DAY), new Date(out.getTime() + 2 * DAY))).toBe("not_eligible");
    expect(makeGoodOpenTo({ createdAt: out }, null, out)).toBe("not_eligible");
  });
});
