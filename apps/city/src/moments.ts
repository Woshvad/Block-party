import type { Emote, MomentKind, TowerMoment } from "@bp/core";
import { type Board, wrap } from "./roomfeeds";

// What a Tower moment says in the Watch Party: on the card, in one line, and
// on the big screen. Pure, tested headless. Prices are the chance of YES.

// "Jumped 41% → 63%", "Dropped 63% → 41%", "Settled: YES".
export function momentHeadline(m: TowerMoment): string {
  if (m.kind === "settled") return `Settled: ${m.outcome === "yes" ? "YES" : "NO"}`;
  return `${m.to! > m.from! ? "Jumped" : "Dropped"} ${m.from}% → ${m.to}%`;
}

// The small print under it.
export function momentDetail(m: TowerMoment): string {
  if (m.kind === "settled") return m.from === undefined ? "It's final." : `It's final. The Tower had it at ${m.from}%.`;
  return "Chance of YES, in the last half hour.";
}

// "Tower · Will Lagos FC win? jumped 41% → 63%", for the stack under the card.
export function momentLine(m: TowerMoment): string {
  const h = momentHeadline(m).replace(":", "");
  return `Tower · ${m.question} ${h.charAt(0).toLowerCase()}${h.slice(1)}`;
}

export const momentLabel = (kind: MomentKind) => (kind === "settled" ? "Tower · Settled" : "Tower · Big swing");

// Quick reactions on the card: the room's own emotes, nothing new to send.
export const MOMENT_REACTIONS: Record<MomentKind, readonly Emote[]> = {
  swing: ["lfg", "watching", "aping", "bull_trap"],
  settled: ["victory_lap", "rekt", "ring_it", "actually"],
};

// The card starts fading this long before the room's 2 minutes are up.
export const FADE_MS = 1_500;
export const fading = (m: { until: number }, now: number) => m.until - now <= FADE_MS;

// The big screen while a moment is on, in place of tonight's matches. The
// credit is the odds feed's own line, as on every board with its prices.
export function momentBoard(m: TowerMoment, credit: string | null): Board {
  const question = wrap(m.question, 34).slice(0, 3);
  return {
    title: momentLabel(m.kind).toUpperCase(),
    rows: [...question.map((left) => ({ left, tone: "plain" as const })), { left: "" }, { left: momentHeadline(m), tone: "plain" as const }],
    ...(credit ? { foot: credit } : {}),
  };
}
