import { type CityDay, daysBetween } from "./clock";
import { type MarketCategory, type Side, TOWER } from "./tower";

// The Daily Slate: one shared puzzle a day, the same six markets for everyone.

export const SLATE_TIERS = ["lock", "coin_flip", "coin_flip", "spicy", "spicy", "long_shot"] as const;
export type SlateTier = "lock" | "coin_flip" | "spicy" | "long_shot";

export const TIER_RANGE: Record<SlateTier, [number, number]> = {
  lock: [71, 99], // over 70%
  coin_flip: [40, 70],
  spicy: [15, 39],
  long_shot: [5, 14],
};
// When a tier can't be filled, the nearest one fills it.
const NEAREST: Record<SlateTier, SlateTier[]> = {
  lock: ["coin_flip", "spicy", "long_shot"],
  coin_flip: ["lock", "spicy", "long_shot"],
  spicy: ["coin_flip", "long_shot", "lock"],
  long_shot: ["spicy", "coin_flip", "lock"],
};

export const SLATE = {
  minCallableHours: 15,
  minNonCrypto: 2,
  maxPerLadder: 2,
  epoch: "2026-10-05" as CityDay, // Slate #1
} as const;

export type SlateCandidate = {
  id: string;
  category: MarketCategory;
  ladder: string | null;
  price: number;
  freezesAt: Date;
  settlesBy: Date;
  infoOnly: boolean;
};

export function tierOf(price: number): SlateTier | null {
  for (const t of ["lock", "coin_flip", "spicy", "long_shot"] as const) if (price >= TIER_RANGE[t][0] && price <= TIER_RANGE[t][1]) return t;
  return null;
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// Fits the day: callable for 15+ hours of it and settled before the next bell.
export function eligible(c: SlateCandidate, day: CityDay): boolean {
  const start = Date.parse(`${day}T00:00:00Z`);
  const bell = start + 86_400_000;
  return !c.infoOnly && c.category !== "politics" && c.freezesAt.getTime() - start >= SLATE.minCallableHours * 3_600_000 && c.settlesBy.getTime() < bell && c.price >= 1 && c.price <= 99;
}

// Picks the six. Deterministic for a day and a candidate set (the order of
// the input doesn't matter), so every server agrees.
export function pickSlate(candidates: readonly SlateCandidate[], day: CityDay): Array<{ slot: number; tier: SlateTier; id: string }> {
  const pool = candidates.filter((c) => eligible(c, day)).sort((a, b) => hash(`${day}:${a.id}`) - hash(`${day}:${b.id}`) || (a.id < b.id ? -1 : 1));
  const chosen: Array<{ slot: number; tier: SlateTier; id: string; c: SlateCandidate }> = [];
  const ladders = new Map<string, number>();
  const fits = (c: SlateCandidate, tier: SlateTier) =>
    tierOf(c.price) === tier && !chosen.some((x) => x.id === c.id) && (c.ladder === null || (ladders.get(c.ladder) ?? 0) < SLATE.maxPerLadder);
  const take = (slot: number, tier: SlateTier, c: SlateCandidate) => {
    chosen.push({ slot, tier, id: c.id, c });
    if (c.ladder) ladders.set(c.ladder, (ladders.get(c.ladder) ?? 0) + 1);
  };
  const nonCrypto = () => chosen.filter((x) => x.c.category !== "crypto").length;
  // loop-bound: six slots, each scanning the pool at most four times (its tier, then the nearest).
  for (const [slot, tier] of SLATE_TIERS.entries()) {
    const slotsLeft = SLATE_TIERS.length - slot;
    const mustBeNonCrypto = SLATE.minNonCrypto - nonCrypto() >= slotsLeft;
    let pick: SlateCandidate | undefined;
    for (const t of [tier, ...NEAREST[tier]]) {
      pick = pool.find((c) => fits(c, t) && (!mustBeNonCrypto || c.category !== "crypto"));
      if (pick) break;
    }
    if (pick) take(slot, tier, pick);
  }
  return chosen.map(({ slot, tier, id }) => ({ slot, tier, id }));
}

// --- The Bell Modifier ---------------------------------------------------------------

export const MODIFIERS = ["contrarian_day", "nothing_day", "blind_slate"] as const;
export type Modifier = (typeof MODIFIERS)[number];
export const modifierFor = (day: CityDay): Modifier => MODIFIERS[hash(`modifier:${day}`) % MODIFIERS.length]!;

// What a modifier decides is cosmetic: a gold border, a banner tile, a hidden
// bar. Never Aura, GM or real trades.

// Contrarian Day: the city's majority on a card is the side most of the City
// bar's calls took (neighbours only, never the cast). Under the City bar's 10
// neighbours, or a tie, there's no majority, so no call is against it.
export function cityMajority(yes: number, no: number): Side | null {
  if (!Number.isInteger(yes) || !Number.isInteger(no) || yes < 0 || no < 0) return null;
  if (yes + no < TOWER.cityBarMin || yes === no) return null;
  return yes > no ? "yes" : "no";
}

// A call against the majority gets the gold border.
export const againstCity = (side: Side, majority: Side | null): boolean => majority !== null && side !== majority;

// NOTHING Day: your Slate beats NOTHING-9000's grid with more Aura than its
// grid, counted the way the grid counts (an unsettled square is 0). A tie
// isn't a win, and no call that day, or no grid from the bot, beats nothing.
export const beatsBot = (mineCenti: number | null, botCenti: number | null): boolean => mineCenti !== null && botCenti !== null && mineCenti > botCenti;

// The banner tile NOTHING Day pays: an earned-only home piece (home.ts), once each.
export const NOTHING_DAY_TILE = "banner_tile_nothing";

export const slateNumber = (day: CityDay) => daysBetween(SLATE.epoch, day) + 1;

// --- The grid ---------------------------------------------------------------------------

export type Square = "green" | "white" | "red" | "black" | "gold" | "void" | "pending";
export const SQUARE_EMOJI: Record<Square, string> = { green: "🟩", white: "⬜", red: "🟥", black: "⬛", gold: "🟨", void: "⬜", pending: "⏳" };

// Coloured by Aura, not by win or loss: taking the favourite on everything
// makes a grey grid. Gold is a YES on the Long Shot that hit.
// "pending": its market hadn't settled by the bell (the late-settlement policy
// decides whether it carries to the next bell or is voided).
export function square(call: { side: "yes" | "no"; auraCenti: number | null } | null, tier: SlateTier, outcome: boolean | null, voided = false): Square {
  if (!call) return "black";
  if (voided) return "void";
  if (outcome === null || call.auraCenti === null) return "pending";
  if (tier === "long_shot" && call.side === "yes" && outcome) return "gold";
  if (call.auraCenti > 200) return "green";
  if (call.auraCenti < -200) return "red";
  return "white";
}

export function gridText(day: CityDay, squares: readonly Square[]): string {
  return `Block Party #${slateNumber(day)} ${squares.map((s) => SQUARE_EMOJI[s]).join("")}`;
}
