import { describe, expect, it } from "vitest";
import { canRenderWebGL, failedAsset, noteModelAsked, noteModelLoaded, sceneFallback, takeFailedModels } from "../src/sceneHealth";

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

describe("what a failed scene shows", () => {
  const note = "Explore places still works.";
  it("draws the scene until something fails", () => {
    expect(sceneFallback("the city map", note, { webgl: true, failed: false, outdated: false })).toBeNull();
    // Known out of date, but nothing has failed (yet): still the scene.
    expect(sceneFallback("the city map", note, { webgl: true, failed: false, outdated: true })).toBeNull();
  });

  it("offers Try again for a failure a retry can fix", () => {
    expect(sceneFallback("the city map", note, { webgl: true, failed: true, outdated: false })).toEqual({ title: "Couldn't draw the city map.", detail: "A download failed or the 3D view stopped. Explore places still works.", action: "retry" });
  });

  it("offers Reload, and says why, when the game was updated since the page opened", () => {
    expect(sceneFallback("the city map", note, { webgl: true, failed: true, outdated: true })).toEqual({ title: "Block Party has been updated.", detail: "Reload to see the city map. Explore places still works.", action: "reload" });
    expect(sceneFallback("this room", undefined, { webgl: true, failed: true, outdated: true })?.detail).toBe("Reload to see this room.");
  });

  it("offers nothing on a device without WebGL", () => {
    for (const failed of [false, true]) expect(sceneFallback("the city map", note, { webgl: false, failed, outdated: failed })).toEqual({ title: "This device can't show the city map in 3D.", detail: note });
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
