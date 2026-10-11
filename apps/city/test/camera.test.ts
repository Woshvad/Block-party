import { describe, expect, it } from "vitest";
import { BOARD, ZOOM, clampTarget, fitCamera, screenOffset, shortCount, startZoom, zoomLevel } from "../src/camera";
import { LANDMARKS } from "../src/citygen";
import { PLACE_INFO } from "../src/places";

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

describe("the board on a phone", () => {
  it("opens at a zoom that shows the pins' names, on every common phone", () => {
    for (const [w, h] of [[320, 568], [360, 740], [375, 667], [390, 844], [414, 896], [430, 932]] as const) {
      expect(zoomLevel(startZoom(w, h)), `${w}x${h}`).not.toBe("far");
    }
    expect(startZoom(1440, 900)).toBeCloseTo(1440 / 65);
  });

  it("measures the iso view the way the camera draws it", () => {
    const o = { x: 0, y: 0, z: 0 };
    // Straight up is straight up on screen, shortened by the camera's tilt.
    expect(screenOffset(o, { x: 0, y: 1, z: 0 }, 10).dx).toBeCloseTo(0);
    expect(screenOffset(o, { x: 0, y: 1, z: 0 }, 10).dy).toBeCloseTo(8.57, 1);
    // Along the screen's own right (x up, z down) nothing moves vertically.
    expect(screenOffset(o, { x: 1, y: 0, z: -1 }, 10)).toEqual({ dx: expect.closeTo(14.14, 1), dy: expect.closeTo(0, 5) });
  });

  it("the Tower and Roof pins never cover each other, at any zoom", () => {
    // A phone pin is at least 42 px square (globals.css). From ZOOM.names up
    // the pins carry their names, about 7 px a letter plus the icon.
    const PIN = 42;
    const wide = (key: string) => 26 + 24 + PLACE_INFO[key]!.name.length * 7;
    const t = { ...LANDMARKS.tower, y: LANDMARKS.tower.pinY };
    const r = { ...LANDMARKS.roof, y: LANDMARKS.roof.pinY };
    for (let zoom = ZOOM.min; zoom <= ZOOM.max; zoom += 0.25) {
      const { dx, dy } = screenOffset(t, r, zoom);
      const w = zoom >= ZOOM.names ? (wide("tower") + wide("roof")) / 2 : PIN;
      expect(Math.abs(dx) >= w || Math.abs(dy) >= PIN, `zoom ${zoom}: ${dx.toFixed(0)}, ${dy.toFixed(0)}`).toBe(true);
    }
  });
});
