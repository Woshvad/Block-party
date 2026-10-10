import { type Plan, toTile } from "./plan";

// Game movement for residents: each one is a small round body that steers.
// Seek the next waypoint (easing in on arrival), push apart from anyone too
// close (a spatial hash keeps that cheap with 60 in a room), accelerate and
// turn at human rates, and never end a step inside furniture or a wall.
// Pure and allocation-free per step, so it runs every frame on a phone.

export type Body = {
  x: number;
  z: number;
  vx: number;
  vz: number;
  yaw: number;
  path: { x: number; z: number }[];
  r?: number; // radius (default BODY_R)
  speed?: number; // top speed (default STEER.maxSpeed)
  fixed?: boolean; // NPCs and the seated: others push off them, they don't move
};

export const BODY_R = 0.28;
export const STEER = {
  maxSpeed: 2.6, // tiles a second
  accel: 9, // how fast you get up to speed
  arrive: 0.9, // start easing in this far from the last waypoint
  reach: 0.12, // close enough to a waypoint
  turnRate: 10, // radians a second
  push: 14, // separation strength
  lookAhead: 1.1, // seconds: dodge anyone we'd bump into within this
  dodge: 2.2, // sideways speed when dodging
} as const;

const angDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

// Is this world point inside the room and off the furniture, with a body's room to spare?
export function standable(plan: Plan | null, x: number, z: number, r = BODY_R): boolean {
  if (!plan) return true;
  if (Math.abs(x) > plan.w / 2 - r || Math.abs(z) > plan.h / 2 - r) return false;
  for (const [ox, oz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]] as const) {
    const t = toTile(plan, x + ox, z + oz);
    if (t.x < 0 || t.y < 0 || t.x >= plan.w || t.y >= plan.h || plan.blocked[t.y * plan.w + t.x]) return false;
  }
  return true;
}

// One physics step for everyone. Returns nothing; bodies are updated in place.
export function step(bodies: Body[], dt: number, plan: Plan | null) {
  const n = bodies.length;
  if (!n || dt <= 0) return;
  // Spatial hash: 1-tile cells, so each body checks only its neighbours.
  const cells = new Map<number, number[]>();
  const key = (x: number, z: number) => (Math.floor(x) + 512) * 4096 + (Math.floor(z) + 512);
  for (let i = 0; i < n; i++) {
    const k = key(bodies[i]!.x, bodies[i]!.z);
    const c = cells.get(k);
    if (c) c.push(i);
    else cells.set(k, [i]);
  }

  for (let i = 0; i < n; i++) {
    const b = bodies[i]!;
    if (b.fixed) {
      b.vx = b.vz = 0;
      continue;
    }
    const top = b.speed ?? STEER.maxSpeed;
    // Seek: toward the next waypoint, easing in on the last one.
    let dvx = 0;
    let dvz = 0;
    while (b.path.length && Math.hypot(b.path[0]!.x - b.x, b.path[0]!.z - b.z) < STEER.reach) b.path.shift(); // loop-bound: the path only shrinks
    const wp = b.path[0];
    if (wp) {
      const dx = wp.x - b.x;
      const dz = wp.z - b.z;
      const d = Math.hypot(dx, dz) || 1;
      const last = b.path.length === 1;
      const want = last ? Math.min(top, (top * d) / STEER.arrive) : top;
      dvx = (dx / d) * want;
      dvz = (dz / d) * want;
    }
    // Separation: a soft push away from anyone overlapping our personal space.
    const ri = b.r ?? BODY_R;
    let px = 0;
    let pz = 0;
    const cx = Math.floor(b.x);
    const cz = Math.floor(b.z);
    let ax2 = 0;
    let az2 = 0;
    for (let gx = cx - 2; gx <= cx + 2; gx++)
      for (let gz = cz - 2; gz <= cz + 2; gz++) {
        const c = cells.get((gx + 512) * 4096 + (gz + 512));
        if (!c) continue;
        for (const j of c) {
          if (j === i) continue;
          const o = bodies[j]!;
          const dx = b.x - o.x;
          const dz = b.z - o.z;
          const min = ri + (o.r ?? BODY_R);
          const d2 = dx * dx + dz * dz;
          // Look ahead: where will we be closest, and how close? If we'd bump,
          // step aside now (always to our right, so two people never mirror-dodge).
          const rvx = (wp ? dvx : b.vx) - o.vx;
          const rvz = (wp ? dvz : b.vz) - o.vz;
          const rv2 = rvx * rvx + rvz * rvz;
          if (rv2 > 1e-4) {
            const tc = -(dx * rvx + dz * rvz) / rv2;
            if (tc > 0 && tc < STEER.lookAhead) {
              const mx = dx + rvx * tc;
              const mz = dz + rvz * tc;
              if (mx * mx + mz * mz < (min * 1.15) ** 2) {
                const rv = Math.sqrt(rv2);
                const urgency = 1 - tc / STEER.lookAhead;
                ax2 += (rvz / rv) * STEER.dodge * urgency; // right of our relative heading
                az2 += (-rvx / rv) * STEER.dodge * urgency;
              }
            }
          }
          if (d2 >= min * min) continue;
          const d = Math.sqrt(d2) || 1e-3;
          const overlap = (min - d) / min;
          // Ties (exactly on top of each other) split by index, so they always separate.
          const ux = d2 > 1e-8 ? dx / d : i < j ? 1 : -1;
          const uz = d2 > 1e-8 ? dz / d : 0;
          px += ux * overlap * STEER.push;
          pz += uz * overlap * STEER.push;
        }
      }
    dvx += px + ax2;
    dvz += pz + az2;
    // Accelerate toward the wanted velocity, at a human rate.
    const ax = dvx - b.vx;
    const az = dvz - b.vz;
    const am = Math.hypot(ax, az);
    const maxDv = STEER.accel * dt;
    const k = am > maxDv ? maxDv / am : 1;
    b.vx += ax * k;
    b.vz += az * k;
    const sp = Math.hypot(b.vx, b.vz);
    const cap = top * 1.4; // a crowd shove can briefly beat walking speed
    if (sp > cap) {
      b.vx *= cap / sp;
      b.vz *= cap / sp;
    }
    // Move, sliding along furniture and walls instead of entering them.
    const nx = b.x + b.vx * dt;
    const nz = b.z + b.vz * dt;
    if (standable(plan, nx, nz, ri * 0.8)) {
      b.x = nx;
      b.z = nz;
    } else if (standable(plan, nx, b.z, ri * 0.8)) {
      b.x = nx;
      b.vz = 0;
    } else if (standable(plan, b.x, nz, ri * 0.8)) {
      b.z = nz;
      b.vx = 0;
    } else {
      b.vx = b.vz = 0;
    }
    // Turn toward where we're going, at a natural rate.
    if (sp > 0.15) {
      const want = Math.atan2(b.vx, b.vz);
      const dYaw = angDiff(b.yaw, want);
      const maxTurn = STEER.turnRate * dt;
      b.yaw += Math.max(-maxTurn, Math.min(maxTurn, dYaw));
    }
  }
  resolve(bodies, plan);
}

// After everyone moves: bodies are solid. Push apart any pair that still
// overlaps (the fixed one doesn't budge), never into furniture or walls.
// A few passes settle even a packed crowd.
export function resolve(bodies: Body[], plan: Plan | null, passes = 3) {
  const n = bodies.length;
  for (let pass = 0; pass < passes; pass++) {
    const cells = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const k = (Math.floor(bodies[i]!.x) + 512) * 4096 + (Math.floor(bodies[i]!.z) + 512);
      const c = cells.get(k);
      if (c) c.push(i);
      else cells.set(k, [i]);
    }
    for (let i = 0; i < n; i++) {
      const a = bodies[i]!;
      const cx = Math.floor(a.x);
      const cz = Math.floor(a.z);
      for (let gx = cx - 1; gx <= cx + 1; gx++)
        for (let gz = cz - 1; gz <= cz + 1; gz++) {
          for (const j of cells.get((gx + 512) * 4096 + (gz + 512)) ?? []) {
            if (j <= i) continue;
            const o = bodies[j]!;
            if (a.fixed && o.fixed) continue;
            let dx = o.x - a.x;
            let dz = o.z - a.z;
            const min = (a.r ?? BODY_R) + (o.r ?? BODY_R);
            let d = Math.hypot(dx, dz);
            if (d >= min) continue;
            if (d < 1e-6) {
              dx = 1;
              dz = 0;
              d = 1;
            }
            const over = min - d;
            const ux = dx / d;
            const uz = dz / d;
            const wa = a.fixed ? 0 : o.fixed ? 1 : 0.5;
            const wo = 1 - wa;
            const nax = a.x - ux * over * wa;
            const naz = a.z - uz * over * wa;
            const nox = o.x + ux * over * wo;
            const noz = o.z + uz * over * wo;
            if (wa && standable(plan, nax, naz, (a.r ?? BODY_R) * 0.8)) {
              a.x = nax;
              a.z = naz;
            }
            if (wo && standable(plan, nox, noz, (o.r ?? BODY_R) * 0.8)) {
              o.x = nox;
              o.z = noz;
            }
          }
        }
    }
  }
}

export const speedOf = (b: Body) => Math.hypot(b.vx, b.vz);
