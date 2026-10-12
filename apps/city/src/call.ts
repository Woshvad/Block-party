import { auraCenti, chanceOnSide, sideOpen, sliderStart } from "@bp/core";
import type { Side } from "./api";

// The call slider: "Chance of YES", only on your side of the market's price.
// Built on @bp/core's own rules, so the client can't offer a chance the API refuses.

export type Range = { min: number; max: number; start: number };

export function sliderRange(side: Side, world: number): Range | null {
  if (!Number.isInteger(world) || world < 1 || world > 99 || !sideOpen(side, world)) return null;
  const min = side === "yes" ? world + 1 : 1;
  const max = side === "yes" ? 99 : world - 1;
  return { min, max, start: sliderStart(side, world) };
}

// Keeps a dragged or stale value on the right side after a side flip or a price move.
export function clampChance(side: Side, world: number, chance: number): number | null {
  const r = sliderRange(side, world);
  if (!r) return null;
  const c = Math.round(chance);
  return Number.isFinite(c) ? Math.min(r.max, Math.max(r.min, c)) : r.start;
}

export const validCall = (side: Side, world: number, chance: number) => chanceOnSide(side, world, chance);

// Whether the market takes calls: open, not frozen yet, and carried by the
// latest poll (a market the feed dropped has a stale price; the API refuses it).
export function callsOpen(m: { status: string; inFeed?: boolean; freezesAt: string }, now: number): boolean {
  return m.status === "open" && m.inFeed !== false && Date.parse(m.freezesAt) > now;
}

// What this call would score either way, in whole Aura (the API keeps hundredths).
export function auraIf(world: number, chance: number): { yes: number; no: number } {
  return { yes: auraCenti(true, world, chance) / 100, no: auraCenti(false, world, chance) / 100 };
}

export const TIER_LABEL: Record<string, string> = { lock: "Lock", coin_flip: "Coin flip", spicy: "Spicy", long_shot: "Long shot" };

export const CALL_STATE_LABEL: Record<string, string> = {
  pending: "waiting for the next tick",
  locked: "locked in",
  price_moved: "price moved; call again",
  expired: "dropped (no tick in time)",
};
