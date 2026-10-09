// The room test's crowd, as plain data: where each resident stands and walks,
// who animates every frame (the 15 nearest the camera) and who less often.
// Pure and seeded, so it's the same on every phone and easy to test.

export const ROOM = { width: 20, depth: 16, residents: 60, away: 10, fullAnimate: 15, slowEvery: 3 } as const;

export type Resident = {
  id: number;
  away: boolean; // drawn dimmed, never takes a seat
  x: number;
  z: number;
  tx: number; // where they're walking to
  tz: number;
  speed: number; // metres a second
  phase: number; // where in the walk cycle
  hue: number; // outfit colour, 0..1
  idle: number; // seconds left standing before picking a new spot
};

// mulberry32: a small seeded random.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const inRoom = (r: () => number) => ({ x: (r() - 0.5) * (ROOM.width - 2), z: (r() - 0.5) * (ROOM.depth - 2) });

export function makeCrowd(seed = 1, residents: number = ROOM.residents, away: number = ROOM.away): Resident[] {
  const r = rng(seed);
  return Array.from({ length: residents + away }, (_, id) => {
    const p = inRoom(r);
    const t = inRoom(r);
    return { id, away: id >= residents, x: p.x, z: p.z, tx: t.x, tz: t.z, speed: 0.9 + r() * 0.6, phase: r() * Math.PI * 2, hue: r(), idle: r() * 3 };
  });
}

// One step of the crowd: walk toward the target, stand a moment on arrival,
// then pick a new spot. Away residents wander slower. Mutates in place (no
// allocation per frame on a phone).
export function stepCrowd(crowd: Resident[], dt: number, r: () => number) {
  for (const c of crowd) {
    if (c.idle > 0) {
      c.idle -= dt;
      continue;
    }
    const dx = c.tx - c.x;
    const dz = c.tz - c.z;
    const d = Math.hypot(dx, dz);
    const step = c.speed * (c.away ? 0.5 : 1) * dt;
    if (d <= step) {
      c.x = c.tx;
      c.z = c.tz;
      c.idle = 1 + r() * 4;
      const t = inRoom(r);
      c.tx = t.x;
      c.tz = t.z;
    } else {
      c.x += (dx / d) * step;
      c.z += (dz / d) * step;
      c.phase += dt * c.speed * 6;
    }
  }
}

// The nearest N to the camera animate every frame; the rest every few frames.
export function animatedThisFrame(crowd: readonly Resident[], cam: { x: number; z: number }, frame: number): Set<number> {
  const near = [...crowd]
    .map((c) => ({ id: c.id, d: (c.x - cam.x) ** 2 + (c.z - cam.z) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, ROOM.fullAnimate)
    .map((c) => c.id);
  const out = new Set(near);
  for (const c of crowd) if (!out.has(c.id) && (c.id + frame) % ROOM.slowEvery === 0) out.add(c.id);
  return out;
}

export const walking = (c: Resident) => c.idle <= 0;
