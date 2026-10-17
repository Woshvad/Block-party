import { describe, expect, it } from "vitest";
import { chooseCityView, chooseQuality, deviceFrom, rememberContextLost, savePick, savedPick, savedQuality, subscribePick, tierFor } from "../src/quality";

describe("choosing a quality tier", () => {
  it("gives a phone short on memory the low tier", () => {
    expect(chooseQuality({ search: "", memoryGb: 4, cores: 8 })).toBe("low");
    expect(chooseQuality({ search: "", memoryGb: 2 })).toBe("low");
    expect(chooseQuality({ search: "", memoryGb: 8, cores: 8 })).toBe("high");
  });

  it("goes low when the player saves data, or the device has two cores or fewer", () => {
    expect(chooseQuality({ search: "", memoryGb: 8, saveData: true })).toBe("low");
    expect(chooseQuality({ search: "", cores: 2 })).toBe("low");
    expect(chooseQuality({ search: "", cores: 4 })).toBe("high");
  });

  it("stays high when the browser says nothing (Safari shares no memory figure)", () => {
    expect(chooseQuality({ search: "" })).toBe("high");
  });

  it("does what ?quality= says, either way", () => {
    expect(chooseQuality({ search: "?quality=high", memoryGb: 1, saveData: true })).toBe("high");
    expect(chooseQuality({ search: "?perf&quality=low", memoryGb: 8 })).toBe("low");
    expect(chooseQuality({ search: "?quality=ultra", memoryGb: 2 })).toBe("low");
  });

  it("reads the device from navigator, leaving out what isn't a usable number", () => {
    expect(deviceFrom({ deviceMemory: 4, hardwareConcurrency: 8, connection: { saveData: true } }, "?quality=low")).toEqual({ search: "?quality=low", memoryGb: 4, cores: 8, saveData: true });
    expect(deviceFrom({ deviceMemory: "4", hardwareConcurrency: 0, connection: null }, "")).toEqual({ search: "" });
    expect(deviceFrom(undefined, "")).toEqual({ search: "" });
  });
});

describe("what the low tier turns off", () => {
  it("caps the pixel ratio and drops antialiasing, shadows, strollers and night lamps", () => {
    expect(tierFor("low")).toEqual({ quality: "low", dpr: 1, antialias: false, shadows: false, strollers: false, nightLamps: false });
    expect(tierFor("high")).toEqual({ quality: "high", dpr: [1, 1.5], antialias: true, shadows: true, strollers: true, nightLamps: true });
  });
});

describe("the player's pick, and a phone that ran short", () => {
  it("a pick in Me beats the guess either way; only ?quality= beats the pick", () => {
    expect(chooseQuality({ search: "", chosen: "low" })).toBe("low"); // an iPhone says nothing: the pick decides
    expect(chooseQuality({ search: "", memoryGb: 2, chosen: "high" })).toBe("high");
    expect(chooseQuality({ search: "?quality=high", chosen: "low" })).toBe("high");
  });

  it("a lost WebGL context means low from then on, until the player picks", () => {
    expect(chooseQuality({ search: "", contextLost: true })).toBe("low");
    expect(chooseQuality({ search: "", contextLost: true, chosen: "high" })).toBe("high");
  });

  it("remembers both on the device, and a pick forgets the lost context", () => {
    const g = globalThis as unknown as { window?: unknown };
    const stored = new Map<string, string>();
    g.window = { localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) } };
    try {
      expect(savedQuality()).toBeNull();
      rememberContextLost();
      expect(stored.get("bp.quality.contextLost")).toBe("1");
      savePick("high");
      expect(savedQuality()).toBe("high");
      expect(stored.has("bp.quality.contextLost")).toBe(false);
      savePick(null);
      expect(savedQuality()).toBeNull();
    } finally {
      delete g.window;
    }
    // No storage at all: nothing remembered, nothing thrown.
    expect(savedQuality()).toBeNull();
    expect(() => savePick("low")).not.toThrow();
  });
});

describe("the list instead of the 3D city", () => {
  const withStorage = (run: (stored: Map<string, string>) => void) => {
    const g = globalThis as unknown as { window?: unknown };
    const stored = new Map<string, string>();
    g.window = { localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) } };
    try {
      run(stored);
    } finally {
      delete g.window;
    }
  };

  it("is a third pick in Me, kept on the device, and draws what 3D is left on the low tier", () => {
    withStorage((stored) => {
      savePick("list");
      expect(stored.get("bp.quality")).toBe("list");
      expect(savedPick()).toBe("list");
      expect(savedQuality()).toBe("low"); // rooms and your home
      stored.set("bp.quality", "ultra");
      expect(savedPick()).toBeNull();
    });
    // No storage: the map, as before, and nothing thrown.
    expect(savedPick()).toBeNull();
    expect(() => savePick("list")).not.toThrow();
  });

  it("never probes WebGL once the list is picked, so no WebGL context is made", () => {
    let probed = 0;
    const webgl = () => (probed++, true);
    expect(chooseCityView({ search: "", pick: "list", webgl })).toBe("list");
    expect(chooseCityView({ search: "?city=list", pick: null, webgl })).toBe("list");
    expect(probed).toBe(0);
    expect(chooseCityView({ search: "", pick: "high", webgl })).toBe("map");
    expect(chooseCityView({ search: "", pick: null, webgl })).toBe("map");
    expect(probed).toBe(2);
  });

  it("is what a device without WebGL gets; ?city= forces either", () => {
    expect(chooseCityView({ search: "", pick: null, webgl: () => false })).toBe("list");
    expect(chooseCityView({ search: "", pick: "low", webgl: () => false })).toBe("list");
    expect(chooseCityView({ search: "?city=map", pick: "list", webgl: () => true })).toBe("map");
    expect(chooseCityView({ search: "?city=globe", pick: null, webgl: () => true })).toBe("map");
  });

  it("tells the board at once when the pick changes", () => {
    let heard = 0;
    const stop = subscribePick(() => heard++);
    savePick("list");
    savePick(null);
    stop();
    savePick("high");
    expect(heard).toBe(2);
  });
});
