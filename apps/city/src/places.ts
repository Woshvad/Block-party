// The city's places: where they sit on the board, and the size of each live
// room in tiles. Room sizes mirror apps/rooms (a test reads that file and
// fails if they drift); the board positions are ours.

export type Area = "street" | "city_hall" | "tower" | "roof" | "watch_party" | "gm_wall" | "faucet" | "diner";

export const ROOM_SIZE: Record<string, { w: number; h: number }> = {
  city_hall: { w: 16, h: 12 },
  tower: { w: 16, h: 16 },
  roof: { w: 20, h: 16 },
  watch_party: { w: 20, h: 14 },
  gm_wall: { w: 12, h: 8 },
  faucet: { w: 10, h: 8 },
  diner: { w: 14, h: 10 },
  crew_row: { w: 30, h: 8 },
  crew_house: { w: 10, h: 10 },
  home: { w: 8, h: 8 },
  bunker: { w: 12, h: 10 },
};

export const roomSize = (place: string) => ROOM_SIZE[place.split(":")[0]!] ?? null;

// Which area a room is in (homes and Crew Houses are on the street).
export function areaOf(place: string): Area | null {
  const kind = place.split(":")[0]!;
  if (kind === "home" || kind === "crew_house" || kind === "crew_row") return "street";
  if (kind === "bunker") return "tower";
  return kind in ROOM_SIZE ? (kind as Area) : null;
}

export type PlaceInfo = { place: string; name: string; icon: string; info: string };

export const PLACE_INFO: Record<string, PlaceInfo> = {
  tower: { place: "tower", name: "Prediction Tower", icon: "🔮", info: "The odds wall and every call" },
  roof: { place: "roof", name: "The Roof", icon: "🌃", info: "Where the city watches the bell ring" },
  city_hall: { place: "city_hall", name: "City Hall", icon: "🏛️", info: "The Mayor, the Law and the election" },
  watch_party: { place: "watch_party", name: "Watch Party Hall", icon: "📺", info: "Big games on the big screen" },
  gm_wall: { place: "gm_wall", name: "gm Wall", icon: "☀️", info: "Say gm with the city" },
  faucet: { place: "faucet", name: "The Faucet", icon: "🚰", info: "Free GM help from Faucet Fren" },
  diner: { place: "diner", name: "Gwei Diner", icon: "🍔", info: "Booths for you and your crew" },
  crew_row: { place: "crew_row", name: "Crew Row", icon: "🏠", info: "Homes, and the crews' houses" },
};

export const placeName = (place: string) => {
  const kind = place.split(":")[0]!;
  if (kind === "home") return "Home";
  if (kind === "crew_house") return "Crew House";
  if (kind === "bunker") return place.endsWith(":yes") ? "The YES Bunker" : "The NO Bunker";
  return PLACE_INFO[kind]?.name ?? kind;
};

export const RIDE_OPTIONS = [
  { mode: "walk", label: "Walk", fare: 0, seconds: 40 },
  { mode: "rollup", label: "Rollup", fare: 5, seconds: 20 },
  { mode: "priority", label: "Priority", fare: 15, seconds: 5 },
] as const;
export type RideMode = (typeof RIDE_OPTIONS)[number]["mode"];
