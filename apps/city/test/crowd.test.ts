import { describe, expect, it } from "vitest";
import { ROOM, animatedThisFrame, makeCrowd, rng, stepCrowd } from "../src/crowd";

describe("the room test crowd", () => {
  it("60 residents and 10 away, the same on every phone for a seed", () => {
    const a = makeCrowd(7);
    expect(a).toHaveLength(70);
    expect(a.filter((c) => c.away)).toHaveLength(10);
    expect(makeCrowd(7)).toEqual(a);
  });

  it("everyone stays inside the room, however long they walk", () => {
    const crowd = makeCrowd(3);
    const r = rng(9);
    for (let i = 0; i < 5000; i++) stepCrowd(crowd, 1 / 30, r);
    for (const c of crowd) {
      expect(Math.abs(c.x)).toBeLessThanOrEqual(ROOM.width / 2);
      expect(Math.abs(c.z)).toBeLessThanOrEqual(ROOM.depth / 2);
    }
  });

  it("walkers arrive and pick a new spot", () => {
    const [c] = makeCrowd(1, 1, 0);
    c!.idle = 0;
    const target = { x: c!.tx, z: c!.tz };
    const r = rng(2);
    for (let i = 0; i < 2000 && (c!.x !== target.x || c!.z !== target.z); i++) stepCrowd([c!], 1 / 30, r);
    expect([c!.x, c!.z]).toEqual([target.x, target.z]);
    expect(c!.idle).toBeGreaterThan(0);
  });

  it("the 15 nearest always animate; the rest share frames", () => {
    const crowd = makeCrowd(5);
    const cam = { x: 0, z: 10 };
    const nearest = [...crowd].sort((a, b) => (a.x - cam.x) ** 2 + (a.z - cam.z) ** 2 - ((b.x - cam.x) ** 2 + (b.z - cam.z) ** 2)).slice(0, 15);
    let total = 0;
    for (let f = 0; f < 3; f++) {
      const set = animatedThisFrame(crowd, cam, f);
      for (const n of nearest) expect(set.has(n.id)).toBe(true);
      total += set.size;
    }
    // Over 3 frames, the far ones each animate once: far fewer updates than everyone every frame.
    expect(total).toBeLessThan(crowd.length * 3);
    expect(total).toBeGreaterThanOrEqual(15 * 3 + (crowd.length - 15));
  });
});
