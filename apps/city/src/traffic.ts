import { CITY_SIZE, SQUARE, roads } from "./citygen";

// Traffic, the game way: cars drive in lanes (keep right), hold a following
// distance behind the car ahead, and obey traffic lights at every junction.
// The lights alternate the two directions with an all-red gap, so crossing
// cars are never in a junction together. Pure and seeded: tested headless.

// The all-red gap must outlast the slowest clear: a car crossing the line at the
// end of amber needs (stopBack + half a road + a car length) / vmax ≈ 1.3 s.
export const LIGHTS = { green: 5, amber: 1, allRed: 1.5 } as const;
export const CYCLE = 2 * (LIGHTS.green + LIGHTS.amber + LIGHTS.allRed);
export const CAR = { len: 0.95, gap: 0.6, vmax: 2.6, accel: 3, brake: 6, lane: 0.45, stopBack: 1.35 } as const;

export type Light = "green" | "amber" | "red";
// x-roads run first, then z-roads; each gets green, amber, then an all-red gap.
export function lightFor(along: "x" | "z", t: number): Light {
  const c = ((t % CYCLE) + CYCLE) % CYCLE;
  const phase = along === "x" ? c : (c + CYCLE / 2) % CYCLE;
  if (phase < LIGHTS.green) return "green";
  if (phase < LIGHTS.green + LIGHTS.amber) return "amber";
  return "red";
}

export type Lane = { along: "x" | "z"; a: number; dir: 1 | -1; junctions: number[] };
export type Car = { lane: number; s: number; v: number; color: number };

// Every lane in the city: two per road, except roads paved over by Tower Square.
export function lanes(): Lane[] {
  const rs = roads();
  const crossers = (along: "x" | "z") => rs.filter((r) => r.along !== along).map((r) => r.a);
  const out: Lane[] = [];
  for (const r of rs) {
    const throughSquare = Math.abs(r.a - (r.along === "x" ? SQUARE.z : SQUARE.x)) < SQUARE.w / 2;
    if (throughSquare) continue;
    for (const dir of [1, -1] as const) out.push({ along: r.along, a: r.a, dir, junctions: crossers(r.along) });
  }
  return out;
}

const HALF = CITY_SIZE / 2;

// World position and heading of a car.
export function carPose(l: Lane, c: Car): { x: number; z: number; yaw: number } {
  const off = l.dir * CAR.lane; // keep right
  if (l.along === "x") return { x: c.s, z: l.a + off, yaw: l.dir > 0 ? Math.PI / 2 : -Math.PI / 2 };
  return { x: l.a - off, z: c.s, yaw: l.dir > 0 ? 0 : Math.PI };
}

export function makeTraffic(n: number, seed = 3): { lanes: Lane[]; cars: Car[] } {
  const ls = lanes();
  const cars: Car[] = [];
  let a = seed;
  const r = () => ((a = (a * 16807) % 2147483647) / 2147483647);
  // Spread cars out along their lanes so nobody starts inside another car.
  for (let i = 0; i < n; i++) {
    const lane = i % ls.length;
    const k = Math.floor(i / ls.length);
    let s0 = -HALF + 2 + ((k * 7.3 + r() * 2) % (CITY_SIZE - 4));
    // Never start in (or just before) a junction: that car couldn't stop for a red.
    for (let tries = 0; tries < 20 && ls[lane]!.junctions.some((j) => Math.abs(s0 - j) < CAR.stopBack + 1.2); tries++) s0 += 1.1; // loop-bound: 20 tries
    cars.push({ lane, s: s0, v: 0, color: i });
  }
  return { lanes: ls, cars };
}

// One step for every car.
export function stepTraffic(lanes: Lane[], cars: Car[], t: number, dt: number) {
  // Cars ahead in each lane, by position in the direction of travel.
  const byLane = new Map<number, Car[]>();
  for (const c of cars) (byLane.get(c.lane) ?? byLane.set(c.lane, []).get(c.lane)!).push(c);
  for (const [li, list] of byLane) {
    const l = lanes[li]!;
    list.sort((p, q) => (q.s - p.s) * l.dir); // front of the queue first
    const light = lightFor(l.along, t);
    list.forEach((c, i) => {
      let target: number = CAR.vmax;
      // Follow the car ahead at a safe distance.
      const ahead = list[i - 1];
      if (ahead) {
        const gap = (ahead.s - c.s) * l.dir - CAR.len;
        target = Math.min(target, Math.max(0, (gap - CAR.gap) * 2.2));
      }
      // Stop at the line for a red, or an amber we can still stop for.
      if (light !== "green") {
        for (const j of l.junctions) {
          const stopAt = j - l.dir * CAR.stopBack;
          const dist = (stopAt - c.s) * l.dir;
          const canStop = dist > (c.v * c.v) / (2 * CAR.brake) - 0.05;
          if (dist >= -0.02 && dist < 6 && (light === "red" || canStop)) {
            target = Math.min(target, Math.max(0, dist * 1.8));
            break;
          }
        }
      }
      const dv = target - c.v;
      c.v += Math.max(-CAR.brake * dt, Math.min(CAR.accel * dt, dv));
      c.v = Math.max(0, c.v);
      c.s += c.v * dt * l.dir;
      // Off the edge of the map: back in at the other end (a car leaving town, another arriving).
      if (c.s * l.dir > HALF + 1) c.s = -l.dir * (HALF + 1);
    });
  }
}
