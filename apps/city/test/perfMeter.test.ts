import { describe, expect, it } from "vitest";
import { meterText } from "../src/perfMeter";

describe("the ?perf meter", () => {
  it("shows what the GPU holds and the shader programs", () => {
    const text = meterText({ fps: 60, calls: 256, triangles: 793684, geometries: 124, textures: 23, programs: 27, heapMb: 81, quality: "high" });
    expect(text.split("\n")).toEqual(["60 fps", "256 draw calls (all passes)", "793.7k triangles", "124 geometries · 23 textures", "27 shader programs", "81 MB js heap", "high quality"]);
  });

  it("leaves out the heap where the browser doesn't report it", () => {
    expect(meterText({ fps: 30, calls: 1, triangles: 0, geometries: 0, textures: 0, programs: 1 })).not.toContain("heap");
  });
});
