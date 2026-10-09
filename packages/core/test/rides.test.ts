import { describe, expect, it } from "vitest";
import { AREAS, RIDES, areaOf, fareFor, isArea, isRideMode } from "../src";

describe("rides", () => {
  it("match the plan: walk free ~40s, Rollup 5 GM ~20s, priority 15 GM ~5s", () => {
    expect(RIDES).toEqual({ walk: { fare: 0, seconds: 40 }, rollup: { fare: 5, seconds: 20 }, priority: { fare: 15, seconds: 5 } });
  });

  it("Gas Holiday makes every ride free; walking is always free", () => {
    expect([fareFor("walk", false), fareFor("rollup", false), fareFor("priority", false)]).toEqual([0, 5, 15]);
    expect([fareFor("walk", true), fareFor("rollup", true), fareFor("priority", true)]).toEqual([0, 0, 0]);
  });

  it("homes, Crew Houses and Crew Row are on the street; board places are their own areas", () => {
    expect(areaOf("home:abc")).toBe("street");
    expect(areaOf("crew_house:xyz")).toBe("street");
    expect(areaOf("crew_row")).toBe("street");
    expect(areaOf("city_hall")).toBe("city_hall");
    expect(areaOf("street")).toBeNull(); // not a room
    expect(areaOf("narnia")).toBeNull();
    expect(AREAS).toContain("street");
  });

  it("refuses unknown modes and areas, including prototype keys", () => {
    for (const bad of ["teleport", "__proto__", "toString", "", null, 1]) expect(isRideMode(bad)).toBe(false);
    for (const bad of ["narnia", "__proto__", "", null]) expect(isArea(bad)).toBe(false);
    expect(isRideMode("rollup")).toBe(true);
  });
});
