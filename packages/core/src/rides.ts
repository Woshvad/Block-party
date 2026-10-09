// Getting around: tap a place, pick a ride. Walking costs only time; faster
// rides cost GM, like paying higher gas. Fares burn.

export const RIDES = {
  walk: { fare: 0, seconds: 40 },
  rollup: { fare: 5, seconds: 20 }, // a bus: waits up to 10 s for riders, then 10 s on the road
  priority: { fare: 15, seconds: 5 },
} as const;
export type RideMode = keyof typeof RIDES;

export const ROLLUP = { seats: 8, maxWaitSeconds: 10, roadSeconds: 10 } as const;

// The board's areas. "street" is Crew Row with the homes and Crew Houses on it,
// where everyone starts and steps out of their door.
export const AREAS = ["street", "city_hall", "tower", "roof", "watch_party", "gm_wall", "faucet", "diner"] as const;
export type Area = (typeof AREAS)[number];

// Which area a room belongs to: homes and Crew Houses are on the street.
export function areaOf(place: string): Area | null {
  const kind = place.split(":")[0]!;
  if (kind === "home" || kind === "crew_house" || kind === "crew_row") return "street";
  return (AREAS as readonly string[]).includes(kind) && kind !== "street" ? (kind as Area) : null;
}

export const isArea = (x: unknown): x is Area => typeof x === "string" && (AREAS as readonly string[]).includes(x);
export const isRideMode = (x: unknown): x is RideMode => typeof x === "string" && Object.hasOwn(RIDES, x);

// The Mayor's Gas Holiday makes every ride free.
export const fareFor = (mode: RideMode, ridesFree: boolean) => (ridesFree ? 0 : RIDES[mode].fare);
