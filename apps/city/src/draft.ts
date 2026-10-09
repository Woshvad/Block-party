import { GOALS, KIT_STYLES, LOOK_PALETTES, LOOK_PARTS, ResidentInputError, TRAITS, normalizeName, validateGoal, validateHandle, validateKitStyle, validateLook, validateTraits } from "@bp/core";
import type { Look, ResidentDraft } from "./api";

// Move-in rules, checked with the very validators the API runs, so the form
// can't call something fine that the server then refuses (or the reverse).

export { GOALS, KIT_STYLES, LOOK_PALETTES, LOOK_PARTS, TRAITS };
export type Field = "handle" | "name" | "look" | "traits" | "goal" | "kitStyle";

const reasonOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof ResidentInputError) return e.reason;
    throw e;
  }
};

export function fieldErrors(d: ResidentDraft): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  const checks: [Field, () => unknown][] = [
    ["handle", () => validateHandle(d.handle)],
    ["name", () => normalizeName(d.name)],
    ["look", () => validateLook(d.look)],
    ["traits", () => validateTraits(d.traits)],
    ["goal", () => validateGoal(d.goal)],
    ["kitStyle", () => validateKitStyle(d.kitStyle)],
  ];
  for (const [f, fn] of checks) {
    const r = reasonOf(fn);
    if (r) out[f] = r;
  }
  return out;
}

// Up to three traits: tapping a picked one drops it, a fourth is ignored.
export function toggleTrait(traits: readonly string[], t: string): string[] {
  if (traits.includes(t)) return traits.filter((x) => x !== t);
  return traits.length >= 3 ? [...traits] : [...traits, t];
}

// Arrows on a look part or palette wrap around in both directions.
export function cycle<T>(options: readonly T[], current: T, dir: 1 | -1): T {
  const i = options.indexOf(current);
  const n = options.length;
  return options[(((i < 0 ? 0 : i + dir) % n) + n) % n]!;
}

export const paletteRange = (palette: keyof typeof LOOK_PALETTES) => Array.from({ length: LOOK_PALETTES[palette] }, (_, i) => i);

export function stepLook(look: Look, part: keyof typeof LOOK_PARTS | keyof typeof LOOK_PALETTES, dir: 1 | -1): Look {
  if (part in LOOK_PARTS) {
    const p = part as keyof typeof LOOK_PARTS;
    return { ...look, [p]: cycle(LOOK_PARTS[p] as readonly string[], look[p], dir) };
  }
  const p = part as keyof typeof LOOK_PALETTES;
  return { ...look, [p]: cycle(paletteRange(p), look[p], dir) };
}

// Handle checks race as the player types: only the newest answer may land.
export function latestOnly() {
  let n = 0;
  return {
    begin(): () => boolean {
      const mine = ++n;
      return () => mine === n;
    },
  };
}
