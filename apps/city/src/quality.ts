// How hard the 3D views work. Phones short on memory get the low tier: the
// pixel ratio held at 1, no antialiasing and no shadows, and the city board
// leaves out its strollers and the two night lamps that light the streets
// (every lit surface pays for those). Everything you can tap is the same on
// both tiers. ?quality=low or ?quality=high in the address forces a tier, for
// checking either one on a device.
//
// iPhones say nothing about their memory (WebKit shares no deviceMemory and
// rounds the core count to 4 or 8), so the guess alone gives every one the
// high tier. Inside Telegram the address can't be changed either, so the
// player can pick the tier in Me (saved on the device), and a phone where a
// 3D view lost its WebGL context (it ran short) gets the low tier from then
// on until they pick otherwise.
//
// Me also offers the list: no 3D city at all. The board is the list of
// places, with the same headcounts and trips, and makes no WebGL context;
// rooms and your home (which need their 3D) draw on the low tier. A device
// without WebGL gets the list too. ?city=list or ?city=map forces either.

import { webglSupported } from "./sceneHealth";

export type Quality = "low" | "high";
export type GraphicsPick = Quality | "list";
export type CityView = "map" | "list";

// What the browser tells us about the device. Each is missing where the
// browser doesn't share it (Safari shares neither memory nor data saver).
export type Device = {
  search: string; // the address's query, for ?quality=
  memoryGb?: number; // navigator.deviceMemory: Chromium rounds the RAM to the nearest power of two, at most 8
  cores?: number; // navigator.hardwareConcurrency
  saveData?: boolean; // the player asked the browser to save data
  chosen?: Quality; // the player's own pick in Me, saved on this device
  contextLost?: boolean; // a 3D view here lost its WebGL context before
};

export function chooseQuality(d: Device): Quality {
  const forced = new URLSearchParams(d.search).get("quality");
  if (forced === "low" || forced === "high") return forced;
  if (d.chosen) return d.chosen;
  if (d.contextLost) return "low";
  if (d.saveData) return "low";
  // Chromium says 4 for about 3 to 6 GB (a 6 GB phone's usable RAM rounds
  // down to it): that's the mid-range Android phone. More says 8.
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

// What this device remembers: the player's pick, and a lost context. Local
// storage can be missing or throw; then nothing is remembered.
const CHOSEN_KEY = "bp.quality";
const LOST_KEY = "bp.quality.contextLost";
const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // not remembered
  }
};

// The player's pick in Me (null: let the device decide).
export function savedPick(): GraphicsPick | null {
  const v = read(CHOSEN_KEY);
  return v === "low" || v === "high" || v === "list" ? v : null;
}

// The tier picked, if any: the list draws what 3D is left on the low tier.
export function savedQuality(): Quality | null {
  const p = savedPick();
  return p === "list" ? "low" : p;
}

// A tier takes effect the next time a 3D view is made: a context's
// antialiasing is fixed when it's created. The board follows a switch to or
// from the list at once (subscribePick). Picking anything also forgets a
// lost context.
const listeners = new Set<() => void>();
export function savePick(p: GraphicsPick | null) {
  write(CHOSEN_KEY, p);
  write(LOST_KEY, null);
  for (const l of listeners) l();
}

export function subscribePick(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// The board's view. WebGL is only probed when it might be used: never once
// the list is picked, so the list makes no WebGL context at all.
export function chooseCityView(d: { search: string; pick: GraphicsPick | null; webgl: () => boolean }): CityView {
  const forced = new URLSearchParams(d.search).get("city");
  if (forced === "list" || forced === "map") return forced;
  if (d.pick === "list") return "list";
  return d.webgl() ? "map" : "list";
}

export function cityView(): CityView {
  return chooseCityView({ search: typeof location === "undefined" ? "" : location.search, pick: savedPick(), webgl: webglSupported });
}

// A 3D view lost its WebGL context: low from now on, unless the player picks.
export function rememberContextLost() {
  write(LOST_KEY, "1");
}

// For a tiered Canvas's onCreated: remember if its context is lost.
export function watchContext({ gl }: { gl: { domElement: HTMLCanvasElement } }) {
  gl.domElement.addEventListener("webglcontextlost", rememberContextLost, { once: true });
}

// Chosen once per visit. A WebGL context's antialiasing is fixed when it's
// made, so the tier can't change under a view that's already open.
let chosen: Tier | null = null;
export function deviceTier(): Tier {
  if (!chosen) {
    const nav = typeof navigator === "undefined" ? undefined : (navigator as unknown as NavigatorLike);
    const search = typeof location === "undefined" ? "" : location.search;
    const d = deviceFrom(nav, search);
    const pick = savedQuality();
    if (pick) d.chosen = pick;
    if (read(LOST_KEY) === "1") d.contextLost = true;
    chosen = tierFor(chooseQuality(d));
  }
  return chosen;
}
