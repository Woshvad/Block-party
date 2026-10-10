import { describe, expect, it } from "vitest";
import { findPath, makePlan, toWorld } from "../src/plan";
import { BODY_R, type Body, STEER, standable, step } from "../src/steer";

const body = (x: number, z: number, path: { x: number; z: number }[] = []): Body => ({ x, z, vx: 0, vz: 0, yaw: 0, path });
const run = (bs: Body[], seconds: number, plan: ReturnType<typeof makePlan> | null = null) => {
  for (let t = 0; t < seconds; t += 1 / 60) step(bs, 1 / 60, plan);
};
const minGap = (bs: Body[]) => {
  let m = Infinity;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) m = Math.min(m, Math.hypot(bs[i]!.x - bs[j]!.x, bs[i]!.z - bs[j]!.z));
  return m;
};

describe("steering", () => {
  it("bodies spawned on top of each other spread out until nobody overlaps", () => {
    const bs = Array.from({ length: 12 }, () => body(0, 0));
    run(bs, 3, makePlan(10, 10));
    expect(minGap(bs)).toBeGreaterThan(BODY_R * 2 * 0.85);
  });

  it("two people walking head-on pass each other instead of merging", () => {
    const a = body(-3, 0, [{ x: 3, z: 0 }]);
    const b = body(3, 0.05, [{ x: -3, z: 0 }]);
    let closest = Infinity;
    for (let t = 0; t < 6; t += 1 / 60) {
      step([a, b], 1 / 60, makePlan(10, 6));
      closest = Math.min(closest, Math.hypot(a.x - b.x, a.z - b.z));
    }
    expect(closest).toBeGreaterThan(BODY_R * 2 * 0.6);
    expect(a.x).toBeGreaterThan(2);
    expect(b.x).toBeLessThan(-2);
  });

  it("a crowd heading for one spot queues round it, and everyone arrives near it without stacking", () => {
    const plan = makePlan(14, 14);
    const bs = Array.from({ length: 20 }, (_, i) => body(-5 + (i % 5) * 2.5, -5 + Math.floor(i / 5) * 2.5, [{ x: 0, z: 0 }]));
    run(bs, 10, plan);
    expect(minGap(bs)).toBeGreaterThan(BODY_R * 2 * 0.8);
    for (const b of bs) expect(Math.hypot(b.x, b.z)).toBeLessThan(3.2);
  });

  it("never ends a step inside furniture or a wall, even when shoved", () => {
    const plan = makePlan(10, 8, [{ x: 4, y: 2, w: 2, d: 4 }]);
    const bs = Array.from({ length: 30 }, (_, i) => {
      const start = toWorld(plan, { x: i % 3, y: (i * 3) % 8 });
      const to = toWorld(plan, { x: 9, y: (i * 5) % 8 });
      return body(start.x, start.z, findPath(plan, { x: i % 3, y: (i * 3) % 8 }, { x: 9, y: (i * 5) % 8 }).map((t) => toWorld(plan, t)).concat([to]));
    });
    for (let t = 0; t < 12; t += 1 / 60) {
      step(bs, 1 / 60, plan);
      for (const b of bs) expect(standable(plan, b.x, b.z, BODY_R * 0.79)).toBe(true);
    }
  });

  it("speeds up and turns at human rates, and stands still when there's nowhere to go", () => {
    const b = body(0, 0, [{ x: 5, z: 0 }]);
    step([b], 1 / 60, null);
    expect(Math.hypot(b.vx, b.vz)).toBeLessThanOrEqual((STEER.accel / 60) * 1.0001);
    const still = body(1, 1);
    run([still], 1, null);
    expect(Math.hypot(still.x - 1, still.z - 1)).toBeLessThan(1e-9);
  });

  it("fixed bodies (NPCs, the seated) don't move, and others step round them", () => {
    const npc: Body = { ...body(0, 0), fixed: true };
    const walker = body(-3, 0.02, [{ x: 3, z: 0 }]);
    let closest = Infinity;
    for (let t = 0; t < 5; t += 1 / 60) {
      step([npc, walker], 1 / 60, null);
      closest = Math.min(closest, Math.hypot(walker.x, walker.z));
    }
    expect([npc.x, npc.z]).toEqual([0, 0]);
    expect(closest).toBeGreaterThan(BODY_R * 2 * 0.55);
  });
});
