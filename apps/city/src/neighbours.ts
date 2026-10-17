// "12 neighbours in the city now" on the board: the sum of the public places'
// live headcounts (CityBoard polls them every 15 s). Only real counts add up.
// A place whose count failed comes back null, which makes the total a floor
// ("12+"); with no real count at all there's no total, never a 0.
// Pure, so it's tested headless.

export type CityTotal = { n: number; partial: boolean } | null;

export function cityTotal(counts: Record<string, number | null | undefined>): CityTotal {
  let n = 0;
  let known = 0;
  let unknown = 0;
  for (const v of Object.values(counts)) {
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) {
      n += v;
      known++;
    } else unknown++;
  }
  return known ? { n, partial: unknown > 0 } : null;
}

export function cityTotalLabel(t: CityTotal): string | null {
  if (!t) return null;
  const one = t.n === 1 && !t.partial;
  return `${t.n.toLocaleString("en-US")}${t.partial ? "+" : ""} ${one ? "neighbour" : "neighbours"} in the city now`;
}
