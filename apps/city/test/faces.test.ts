import { LOOK_PARTS, MOODS } from "@bp/core";
import { describe, expect, it } from "vitest";
import { BLINK_CELL, CELL_COUNT, FACE_NAMES, MOOD_CELLS, SHEET, cellFor, cellUv, faceIndex } from "../src/chibi/faces";

describe("face sheet", () => {
  it("has a cell for every face a resident can pick, every mood, and a blink", () => {
    expect(CELL_COUNT).toBe(SHEET.cols * SHEET.rows);
    expect(FACE_NAMES).toHaveLength(CELL_COUNT);
    const faces = LOOK_PARTS.face.map(faceIndex);
    expect(new Set(faces).size).toBe(LOOK_PARTS.face.length);
    for (const m of MOODS) expect(MOOD_CELLS[m]).toBeGreaterThanOrEqual(8);
    const used = [...faces, ...Object.values(MOOD_CELLS), BLINK_CELL];
    expect(new Set(used).size).toBe(used.length); // no two share a cell
  });

  it("a mood beats the face, a blink beats both; junk falls back to face 1", () => {
    expect(cellFor("face3")).toBe(2);
    expect(cellFor("face3", "rekt")).toBe(MOOD_CELLS.rekt);
    expect(cellFor("face3", "rekt", true)).toBe(BLINK_CELL);
    expect(cellFor("face3", "unknown_mood")).toBe(2);
    for (const junk of ["", "face0", "face9", "face", "nonsense"]) expect(cellFor(junk)).toBe(0);
  });

  it("cells tile the texture exactly", () => {
    const seen = new Set<string>();
    for (let i = 0; i < CELL_COUNT; i++) {
      const r = cellUv(i);
      expect(r.u).toBeGreaterThanOrEqual(0);
      expect(r.v).toBeGreaterThanOrEqual(0);
      expect(r.u + r.w).toBeLessThanOrEqual(1);
      expect(r.v + r.h).toBeLessThanOrEqual(1);
      seen.add(`${r.u},${r.v}`);
    }
    expect(seen.size).toBe(CELL_COUNT);
    expect(cellUv(0)).toEqual({ u: 0, v: 0.75, w: 0.25, h: 0.25 }); // top-left of the image
  });
});
