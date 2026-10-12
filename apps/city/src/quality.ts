// How hard the 3D views work. Phones short on memory get the low tier: the
// pixel ratio held at 1, no antialiasing and no shadows, and the city board
// leaves out its strollers and the two night lamps that light the streets
// (every lit surface pays for those). Everything you can tap is the same on
// both tiers. ?quality=low or ?quality=high in the address forces a tier, for
// checking either one on a device.

export type Quality = "low" | "high";

// What the browser tells us about the device. Each is missing where the
// browser doesn't share it (Safari shares neither memory nor data saver).
export type Device = {
  search: string; // the address's query, for ?quality=
  memoryGb?: number; // navigator.deviceMemory: Chromium rounds the RAM down to a power of two
  cores?: number; // navigator.hardwareConcurrency
  saveData?: boolean; // the player asked the browser to save data
};

export function chooseQuality(d: Device): Quality {
  const forced = new URLSearchParams(d.search).get("quality");
  if (forced === "low" || forced === "high") return forced;
  if (d.saveData) return "low";
  // Chromium says 4 for anything from 4 GB up to just under 8 GB: that's the
  // mid-range Android phone. Phones with 8 GB or more say 8 or more.
  if (d.memoryGb !== undefined && d.memoryGb <= 4) return "low";
  if (d.cores !== undefined && d.cores <= 2) return "low";
  return "high";
}

type NavigatorLike = { deviceMemory?: unknown; hardwareConcurrency?: unknown; connection?: { saveData?: unknown } | null };

// The Device for chooseQuality, from navigator and location.search. Odd or
// missing values are left out rather than guessed.
export function deviceFrom(nav: NavigatorLike | undefined, search: string): Device {
  const d: Device = { search };
  const memory = nav?.deviceMemory;
  if (typeof memory === "number" && memory > 0) d.memoryGb = memory;
  const cores = nav?.hardwareConcurrency;
  if (typeof cores === "number" && cores > 0) d.cores = cores;
  if (nav?.connection?.saveData === true) d.saveData = true;
  return d;
}

export type Tier = {
  quality: Quality;
  dpr: number | [number, number];
  antialias: boolean;
  shadows: boolean;
  strollers: boolean; // the city's walkers on the sidewalks
  nightLamps: boolean; // the city's two night point lights
};

export function tierFor(quality: Quality): Tier {
  return quality === "low"
    ? { quality, dpr: 1, antialias: false, shadows: false, strollers: false, nightLamps: false }
    : { quality, dpr: [1, 1.5], antialias: true, shadows: true, strollers: true, nightLamps: true };
}

// Chosen once per visit. A WebGL context's antialiasing is fixed when it's
// made, so the tier can't change under a view that's already open.
let chosen: Tier | null = null;
export function deviceTier(): Tier {
  if (!chosen) {
    const nav = typeof navigator === "undefined" ? undefined : (navigator as unknown as NavigatorLike);
    const search = typeof location === "undefined" ? "" : location.search;
    chosen = tierFor(chooseQuality(deviceFrom(nav, search)));
  }
  return chosen;
}
