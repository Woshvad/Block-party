import { describe, expect, it } from "vitest";
import { BOARD, clampTarget, fitCamera, shortCount } from "../src/camera";

describe("fitCamera", () => {
  it("widens the lens and pulls back on a tall phone", () => {
    const phone = fitCamera(390 / 844);
    const laptop = fitCamera(16 / 9);
    expect(phone.fov).toBe(50);
    expect(laptop.fov).toBe(36);
    expect(phone.distance).toBeGreaterThan(laptop.distance);
  });

  it("always lands inside the zoom range, even for junk aspects", () => {
    for (const a of [0, -1, NaN, Infinity, 0.01, 0.3, 1, 3, 100]) {
      const { distance } = fitCamera(a);
      expect(Number.isFinite(distance)).toBe(true);
      expect(distance).toBeGreaterThanOrEqual(26);
      expect(distance).toBeLessThanOrEqual(60);
    }
  });

  it("gets wider as the screen gets wider (never jumps the wrong way)", () => {
    let last = Infinity;
    for (let a = 0.4; a <= 0.99; a += 0.05) {
      const d = fitCamera(a).distance;
      expect(d).toBeLessThanOrEqual(last);
      last = d;
    }
  });
});

describe("fitCamera for rooms", () => {
  it("fits any room on a phone, inside the room's own zoom range", () => {
    for (const span of [8, 10, 16, 20, 30]) {
      const { distance } = fitCamera(390 / 844, span * 1.25, { min: span * 0.9, max: span * 3 });
      expect(distance).toBeGreaterThanOrEqual(span * 0.9);
      expect(distance).toBeLessThanOrEqual(span * 3);
    }
  });
});

describe("clampTarget", () => {
  it("keeps the focus on the board", () => {
    expect(clampTarget(0, 0)).toEqual({ x: 0, z: 0 });
    const far = clampTarget(999, -999);
    expect(far.x).toBe(BOARD.width / 2 - 3);
    expect(far.z).toBe(-(BOARD.depth / 2 - 3));
  });
});

describe("shortCount", () => {
  it("shortens big numbers and never shows junk", () => {
    expect(shortCount(212)).toBe("212");
    expect(shortCount(1250)).toBe("1.2k");
    expect(shortCount(9999)).toBe("9.9k");
    expect(shortCount(12_400)).toBe("12k");
    expect(shortCount(-5)).toBe("0");
    expect(shortCount(NaN)).toBe("0");
  });
});
