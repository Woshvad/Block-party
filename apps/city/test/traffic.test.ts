import { describe, expect, it } from "vitest";
import { CAR, CYCLE, carPose, lightFor, makeTraffic, stepTraffic } from "../src/traffic";

describe("traffic lights", () => {
  it("never show green (or amber) both ways at once, and each way gets its turn", () => {
    let xGreen = 0;
    let zGreen = 0;
    for (let t = 0; t < CYCLE * 3; t += 0.05) {
      const x = lightFor("x", t);
      const z = lightFor("z", t);
      expect(x !== "red" && z !== "red", `t=${t.toFixed(2)}`).toBe(false);
      if (x === "green") xGreen++;
      if (z === "green") zGreen++;
    }
    expect(xGreen).toBeGreaterThan(0);
    expect(Math.abs(zGreen - xGreen)).toBeLessThanOrEqual(1); // sampling rounding
  });
});

describe("cars", () => {
  const sim = (seconds: number, n = 40, check?: (t: number, w: ReturnType<typeof makeTraffic>) => void) => {
    const w = makeTraffic(n);
    for (let t = 0; t < seconds; t += 1 / 30) {
      stepTraffic(w.lanes, w.cars, t, 1 / 30);
      check?.(t, w);
    }
    return w;
  };

  it("never drive into the car ahead in their lane", () => {
    sim(120, 48, (_t, w) => {
      const byLane = new Map<number, number[]>();
      for (const c of w.cars) (byLane.get(c.lane) ?? byLane.set(c.lane, []).get(c.lane)!).push(c.s);
      for (const ss of byLane.values()) {
        ss.sort((a, b) => a - b);
        for (let i = 1; i < ss.length; i++) {
          const gap = ss[i]! - ss[i - 1]!;
          // A car wrapping round the map edge is the only way two can be close: they're off the board.
          if (Math.abs(ss[i]!) < 23 && Math.abs(ss[i - 1]!) < 23) expect(gap).toBeGreaterThan(CAR.len * 0.9);
        }
      }
    });
  });

  it("crossing cars are never in the same junction at the same time", () => {
    let conflicts = 0;
    sim(120, 48, (_t, w) => {
      const inJunction = w.cars.map((c) => {
        const l = w.lanes[c.lane]!;
        const p = carPose(l, c);
        return { along: l.along, x: p.x, z: p.z };
      });
      const xs = inJunction.filter((c) => c.along === "x");
      const zs = inJunction.filter((c) => c.along === "z");
      for (const a of xs) for (const b of zs) if (Math.abs(a.x - b.x) < 0.7 && Math.abs(a.z - b.z) < 0.7) conflicts++;
    });
    expect(conflicts).toBe(0);
  });

  it("traffic flows: cars actually get somewhere", () => {
    const w = makeTraffic(30);
    const start = w.cars.map((c) => c.s);
    for (let t = 0; t < 60; t += 1 / 30) stepTraffic(w.lanes, w.cars, t, 1 / 30);
    const moved = w.cars.filter((c, i) => Math.abs(c.s - start[i]!) > 5).length;
    expect(moved).toBeGreaterThan(w.cars.length * 0.6);
  });
});
