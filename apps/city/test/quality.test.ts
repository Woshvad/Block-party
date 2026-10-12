import { describe, expect, it } from "vitest";
import { chooseQuality, deviceFrom, tierFor } from "../src/quality";

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
