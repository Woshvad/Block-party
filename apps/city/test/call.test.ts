import { chanceOnSide } from "@bp/core";
import { describe, expect, it } from "vitest";
import { auraIf, callsOpen, clampChance, sliderRange } from "../src/call";
import { countdown, until } from "../src/clock";

const SIDES = ["yes", "no"] as const;

describe("sliderRange", () => {
  it("offers exactly the chances the API accepts, for every price and side", () => {
    for (const side of SIDES) {
      for (let world = 1; world <= 99; world++) {
        const r = sliderRange(side, world);
        for (let c = 1; c <= 99; c++) {
          const offered = r !== null && c >= r.min && c <= r.max;
          expect(offered, `${side} at ${world}%, chance ${c}`).toBe(chanceOnSide(side, world, c));
        }
        if (r) expect(chanceOnSide(side, world, r.start)).toBe(true);
      }
    }
  });

  it("has no slider when the market is pinned against your side", () => {
    expect(sliderRange("yes", 99)).toBeNull();
    expect(sliderRange("no", 1)).toBeNull();
    for (const junk of [0, 100, 50.5, NaN, -3]) expect(sliderRange("yes", junk)).toBeNull();
  });
});

describe("clampChance", () => {
  it("always lands on a valid chance after a side flip or price move", () => {
    for (const side of SIDES) {
      for (let world = 2; world <= 98; world++) {
        for (const c of [-50, 0, 1, world - 1, world, world + 1, 99, 150, NaN, 33.7]) {
          const out = clampChance(side, world, c);
          expect(out !== null && chanceOnSide(side, world, out), `${side} ${world} ${c} -> ${out}`).toBe(true);
        }
      }
    }
  });
});

describe("auraIf", () => {
  it("rewards being righter than the market and costs being wronger", () => {
    const a = auraIf(40, 70); // YES call, 70% vs a 40% market
    expect(a.yes).toBeGreaterThan(0);
    expect(a.no).toBeLessThan(0);
    expect(auraIf(40, 10).yes).toBeLessThan(0); // a NO call loses if YES happens
  });
});

describe("countdown", () => {
  it("reads like a clock and never goes negative", () => {
    expect(countdown((2 * 3600 + 14 * 60 + 5) * 1000)).toBe("2h 14m");
    expect(countdown(14 * 60_000)).toBe("14m");
    expect(countdown(45_000)).toBe("45s");
    expect(countdown(3 * 86_400_000 + 3_600_000)).toBe("3d 1h");
    for (const v of [0, -5, NaN, -Infinity]) expect(countdown(v)).toBe("now");
    expect(until(null, 0)).toBe("now");
    expect(until("garbage", 0)).toBe("now");
    expect(until("2026-10-10T00:00:00Z", Date.parse("2026-10-09T21:46:00Z"))).toBe("2h 14m");
  });
});

describe("callsOpen", () => {
  const now = Date.parse("2026-10-12T10:00:00Z");
  const later = "2026-10-12T15:00:00Z";
  it("takes calls only while open, unfrozen and carried by the latest poll", () => {
    expect(callsOpen({ status: "open", inFeed: true, freezesAt: later }, now)).toBe(true);
    expect(callsOpen({ status: "open", inFeed: false, freezesAt: later }, now)).toBe(false); // the feed dropped it: stale price
    expect(callsOpen({ status: "frozen", inFeed: true, freezesAt: later }, now)).toBe(false);
    expect(callsOpen({ status: "open", inFeed: true, freezesAt: "2026-10-12T09:59:00Z" }, now)).toBe(false);
  });
});
