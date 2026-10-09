import { type Mood } from "./moods";
import { getPiece } from "./home";
import { type Trait } from "./resident";

// --- Naps ---------------------------------------------------------------------

// A long action: it runs for real minutes on its own, then pings (opt-in).
// Any Rested piece in your own home does it, and the same at every price.
export const NAP = { minutes: 20 } as const;

export const napsOn = (pieceId: string) => getPiece(pieceId)?.mood === "rested";

// --- Free will ------------------------------------------------------------------

// What an object says it's good for. Free will only ever walks to one and
// uses it: it never spends GM, calls, votes or chats, so nothing that does
// can be advertised here.
export type Advert = { id: string; mood?: "rested" | "cozy"; suits?: readonly Trait[] };

// Objects in the city's places (homes advertise their own furniture).
export const PLACE_ADVERTS: Record<string, readonly Advert[]> = {
  diner: [
    { id: "diner:booth", mood: "cozy", suits: ["copium_regular"] },
    { id: "diner:counter", suits: ["early_bird"] },
  ],
  roof: [{ id: "roof:ledge", suits: ["roof_rat", "night_owl"] }],
  tower: [{ id: "tower:bunker_bench", suits: ["contrarian", "bunker_lawyer", "ape"] }],
  watch_party: [{ id: "watch_party:front_row", suits: ["hype_man", "builder"] }],
  gm_wall: [{ id: "gm_wall:wall", suits: ["early_bird"] }],
  faucet: [{ id: "faucet:bench" }],
  city_hall: [{ id: "city_hall:gallery", suits: ["bunker_lawyer"] }],
  crew_row: [{ id: "crew_row:stoop", suits: ["touch_grasser"] }],
};

export function homeAdverts(placed: ReadonlyArray<{ itemId: string; pieceId: string }>): Advert[] {
  return placed.flatMap((p) => {
    const mood = getPiece(p.pieceId)?.mood;
    return mood ? [{ id: p.itemId, mood }] : [];
  });
}

// The best match for how the resident feels and who they are; ties broken by
// the seed so a crowd doesn't all pick the same chair. Null when nothing here
// is worth walking to.
export function freeWillPick(input: { moods: readonly Mood[]; traits: readonly Trait[]; adverts: readonly Advert[]; seed: number }): string | null {
  const low = input.moods.includes("rekt") || input.moods.includes("tilted");
  const rested = input.moods.includes("rested");
  let best: Advert[] = [];
  let top = 0;
  for (const a of input.adverts) {
    let score = 0;
    if (a.mood === "cozy") score += low ? 6 : 2; // Cozy clears REKT and Tilted
    if (a.mood === "rested") score += rested ? 0 : 3;
    score += 2 * (a.suits ?? []).filter((t) => input.traits.includes(t)).length;
    if (score <= 0) continue;
    if (score > top) {
      top = score;
      best = [a];
    } else if (score === top) best.push(a);
  }
  if (!best.length) return null;
  return best[Math.abs(Math.trunc(input.seed)) % best.length]!.id;
}

// --- One clock, three evenings ---------------------------------------------------

export const REGION_EVENINGS = { asia: 12, europe: 19, americas: 1 } as const; // hour UTC
export type Region = keyof typeof REGION_EVENINGS;
const REGIONS: Region[] = ["asia", "europe", "americas"];

export type BigNight =
  | { place: string; kind: "bell"; days: "daily" | readonly number[] } // tied to the 00:00 UTC bell, never rotates
  | { place: string; kind: "rotating"; day: number | null; region: Region; hourUtc: number } // day: 0 = Monday; null = whenever there's a match
  | { place: string; kind: "follows_sun" }; // every morning, somewhere

// Places whose big night rotates, each starting the cycle in a different
// region so the same week never gives two of them to one region.
const ROTATING: Array<{ place: string; day: number | null }> = [
  { place: "diner", day: 6 }, // Sunday Bags
  { place: "watch_party", day: null }, // match nights
];

// Weeks since the Monday 1970-01-05 (UTC), for rotation.
export function cityWeek(at: Date): number {
  return Math.floor((at.getTime() - Date.UTC(1970, 0, 5)) / (7 * 86_400_000));
}

export function bigNights(at: Date): BigNight[] {
  const w = cityWeek(at);
  return [
    { place: "tower", kind: "bell", days: "daily" },
    { place: "roof", kind: "bell", days: "daily" },
    { place: "faucet", kind: "bell", days: "daily" }, // right after the bell
    { place: "crew_row", kind: "bell", days: "daily" }, // bell night on the crew TV
    { place: "city_hall", kind: "bell", days: [0, 4, 6] }, // Monday swearing-in, Friday ballot box, Sunday count
    { place: "gm_wall", kind: "follows_sun" },
    ...ROTATING.map(({ place, day }, i) => {
      const region = REGIONS[(((w + i) % 3) + 3) % 3]!;
      return { place, kind: "rotating" as const, day, region, hourUtc: REGION_EVENINGS[region] };
    }),
  ];
}
