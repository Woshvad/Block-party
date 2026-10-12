import { describe, expect, it } from "vitest";
import { canRenderWebGL, failedAsset, noteModelAsked, noteModelLoaded, takeFailedModels } from "../src/sceneHealth";

describe("models that never arrived", () => {
  it("a retry clears only the models that didn't load, once", () => {
    takeFailedModels(); // start clean: the registry is module-wide
    for (const u of ["/a.glb", "/b.glb", "/c.glb"]) noteModelAsked(u);
    noteModelLoaded("/b.glb");
    expect(takeFailedModels().sort()).toEqual(["/a.glb", "/c.glb"]);
    expect(takeFailedModels()).toEqual([]);
    // Asked again after the retry, and this time it arrives.
    noteModelAsked("/a.glb");
    noteModelLoaded("/a.glb");
    expect(takeFailedModels()).toEqual([]);
  });

  it("reads the file a loader error names, and nothing else", () => {
    expect(failedAsset(new Error("Could not load /assets/kenney/commercial/building-a.glb: Failed to fetch"))).toBe("/assets/kenney/commercial/building-a.glb");
    expect(failedAsset(new Error("Could not load https://cdn.example/x.glb: undefined"))).toBe("https://cdn.example/x.glb");
    expect(failedAsset(new Error("WebGL context lost"))).toBeNull();
    expect(failedAsset("Could not load /x.glb: no")).toBeNull();
    expect(failedAsset(null)).toBeNull();
  });
});

describe("the WebGL check", () => {
  it("says yes only when the canvas gives a WebGL 2 context, and releases it", () => {
    let released = 0;
    const gl2 = { getExtension: (n: string) => (n === "WEBGL_lose_context" ? { loseContext: () => void released++ } : null) };
    expect(canRenderWebGL({ getContext: (k) => (k === "webgl2" ? gl2 : null) })).toBe(true);
    expect(released).toBe(1);
  });

  it("says no without WebGL 2, when the canvas throws, or with no canvas at all", () => {
    expect(canRenderWebGL({ getContext: (k) => (k === "webgl" ? {} : null) })).toBe(false);
    expect(canRenderWebGL({ getContext: () => null })).toBe(false);
    expect(
      canRenderWebGL({
        getContext: () => {
          throw new Error("blocklisted");
        },
      }),
    ).toBe(false);
    expect(canRenderWebGL(null)).toBe(false);
  });
});
