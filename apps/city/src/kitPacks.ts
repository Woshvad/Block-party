// Written by scripts/assets.mjs (pnpm --filter @bp/city assets): don't edit.
// Each kit pack's folder under public/assets/kenney, named after a hash of
// its files, so a changed file gets a new address and the old one can be
// cached for good.
export const KIT_PACKS = {
  cars: "cars-8825ff8e",
  commercial: "commercial-ab0837f9",
  industrial: "industrial-2f454176",
  roads: "roads-91c6626b",
  suburban: "suburban-aeb088e9",
} as const;
