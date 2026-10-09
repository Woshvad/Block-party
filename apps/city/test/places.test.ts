import { readFileSync } from "node:fs";
import { AREAS, RIDES, areaOf as coreAreaOf } from "@bp/core";
import { describe, expect, it } from "vitest";
import { RIDE_OPTIONS, ROOM_SIZE, areaOf } from "../src/places";

describe("places", () => {
  it("room sizes match the rooms Worker exactly", () => {
    const src = readFileSync(new URL("../../rooms/src/worker.ts", import.meta.url), "utf8");
    const table = src.slice(src.indexOf("const PLACES"), src.indexOf("};", src.indexOf("const PLACES")));
    const theirs: Record<string, { w: number; h: number }> = {};
    for (const m of table.matchAll(/(\w+): \{ w: (\d+), h: (\d+)/g)) theirs[m[1]!] = { w: Number(m[2]), h: Number(m[3]) };
    expect(Object.keys(theirs).length).toBeGreaterThan(5);
    expect(ROOM_SIZE).toEqual(theirs);
  });

  it("areas agree with @bp/core for every place", () => {
    for (const p of [...Object.keys(ROOM_SIZE), "home:abc", "crew_house:x", "bunker:x:yes", "nowhere"]) expect(areaOf(p)).toBe(coreAreaOf(p));
    for (const a of AREAS) if (a !== "street") expect(areaOf(a)).toBe(a);
  });

  it("ride fares and times match @bp/core", () => {
    for (const r of RIDE_OPTIONS) expect({ fare: r.fare, seconds: r.seconds }).toEqual(RIDES[r.mode]);
    expect(RIDE_OPTIONS.map((r) => r.mode).sort()).toEqual(Object.keys(RIDES).sort());
  });
});
