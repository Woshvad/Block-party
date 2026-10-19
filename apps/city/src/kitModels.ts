import { KIT_PACKS } from "./kitPacks";

// Every Kenney kit model the city can ask for, by pack. KIT only takes these
// names, so a model the code asks for has to be on this list, and the kit
// test checks each one is in public/assets and that nothing else ships there.
// Spelled out in full rather than built from letters, so a search for a
// file's name finds who uses it. Order matters: citygen picks sheds by index.

export const SHOPS = ["building-a", "building-b", "building-c", "building-d", "building-e", "building-f", "building-g", "building-h", "building-i", "building-j", "building-k", "building-l", "building-m", "building-n"] as const;
export const TOWERS = ["building-skyscraper-a", "building-skyscraper-b", "building-skyscraper-c", "building-skyscraper-d", "building-skyscraper-e"] as const;
export const HOUSES = ["building-type-a", "building-type-b", "building-type-c", "building-type-d", "building-type-e", "building-type-f", "building-type-g", "building-type-h", "building-type-i", "building-type-j", "building-type-k", "building-type-l", "building-type-m", "building-type-n", "building-type-o", "building-type-p", "building-type-q", "building-type-r", "building-type-s", "building-type-t", "building-type-u"] as const;
export const SHEDS = ["building-a", "building-b", "building-c", "building-d", "building-e", "building-f", "building-g", "building-h", "building-i", "building-j"] as const;
export const CAR_MODELS = ["sedan", "taxi", "suv", "van", "police", "truck", "delivery", "hatchback-sports", "suv-luxury", "sedan-sports", "ambulance", "garbage-truck"] as const;

export const KIT_MODELS = {
  roads: ["road-straight", "road-crossing", "road-crossroad", "road-bridge", "light-square"],
  commercial: [...SHOPS, ...TOWERS],
  suburban: [...HOUSES, "tree-large", "tree-small"],
  industrial: [...SHEDS, "water-tower", "chimney-large", "detail-tank-large", "shipping-container-a", "shipping-container-b"],
  cars: CAR_MODELS,
} as const;

export type KitPack = keyof typeof KIT_MODELS;
export type KitModel<P extends KitPack> = (typeof KIT_MODELS)[P][number];
export const KIT_PACK_NAMES = Object.keys(KIT_MODELS) as KitPack[];

// A pack's folder, with its palette (Textures/colormap.png) and licence. The
// folder is named after a hash of its files (kitPacks.ts, written by
// scripts/assets.mjs), so its addresses can be cached for good.
export const kitDir = (pack: KitPack) => `/assets/kenney/${KIT_PACKS[pack]}/`;

// The pack a kit model's address is in, or null for anything else.
export function kitPackOf(url: string): KitPack | null {
  return KIT_PACK_NAMES.find((pack) => url.startsWith(kitDir(pack))) ?? null;
}

const kit = <P extends KitPack>(pack: P) => (name: KitModel<P>) => `${kitDir(pack)}${name}.glb`;

export const KIT = {
  roads: kit("roads"),
  commercial: kit("commercial"),
  suburban: kit("suburban"),
  industrial: kit("industrial"),
  cars: kit("cars"),
};

// Every model's address, for the tests.
export function kitUrls(): string[] {
  return KIT_PACK_NAMES.flatMap((pack) => (KIT_MODELS[pack] as readonly string[]).map((name) => (KIT[pack] as (n: string) => string)(name)));
}
