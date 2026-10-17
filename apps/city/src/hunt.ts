import { HUNT_PLACE_NAMES, HUNT_TROPHIES, type HuntPlace, huntTrophies, isHuntPlace } from "@bp/core";
import type { Hunt, HuntSearch, Whereabouts } from "./api";

// How the Daily clue card reads: pure, so every line is tested.

// "the Diner", or the street for anywhere you can't search.
export const spotName = (place: string) => (isHuntPlace(place) ? HUNT_PLACE_NAMES[place] : "the street");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function foundByLine(n: number): string {
  if (!Number.isSafeInteger(n) || n <= 0) return "Nobody's found it yet today";
  return `Found by ${n} ${n === 1 ? "neighbour" : "neighbours"} today`;
}

export type HuntState = { kind: "open" | "found" | "missed"; text: string; detail?: string };
export function huntState(h: Pick<Hunt, "searched">): HuntState {
  if (!h.searched) return { kind: "open", text: "Not searched yet", detail: "One search a day, wherever you are." };
  if (h.searched.found) return { kind: "found", text: "Found it ✓", detail: `It was at ${spotName(h.searched.place)}.` };
  return { kind: "missed", text: "Not here, try again tomorrow", detail: `You searched ${spotName(h.searched.place)}.` };
}

export function trophyLine(finds: number): string {
  const t = huntTrophies(finds);
  const n = t.earned.length;
  if (!t.next) return `${finds} finds · all ${HUNT_TROPHIES.length} trophies won`;
  if (n === 0 && t.next.toGo === 1) return `Your first find wins ${t.next.name}`;
  return `${finds} ${finds === 1 ? "find" : "finds"} · ${t.next.toGo} more for ${t.next.name}`;
}

export function yesterdayLine(y: Hunt["yesterday"]): string {
  if (!y) return "No hunt yesterday.";
  return `${cap(spotName(y.place))} · found by ${y.finders}`;
}

// What the Search button can do from where you are. An arrival time that has
// passed counts as arrived, so the card needn't reload when you get there.
export type SearchPrompt = { can: true; place: HuntPlace; name: string; confirm: string } | { can: false; hint: string; board: boolean };
export function searchPrompt(where: Whereabouts | null | undefined, now: number): SearchPrompt {
  if (!where) return { can: false, hint: "Checking where you are…", board: false };
  const arrived = where.arrived || (where.arriveAt !== null && Date.parse(where.arriveAt) <= now);
  if (!arrived) return { can: false, hint: `You're on your way${isHuntPlace(where.area) ? ` to ${spotName(where.area)}` : ""}. Search when you get there.`, board: false };
  if (!isHuntPlace(where.area)) return { can: false, hint: "You're on the street. Ride to a place from the city board, then search it.", board: true };
  const name = spotName(where.area);
  return { can: true, place: where.area, name, confirm: `One search a day. Search ${name}?` };
}

export function searchResult(r: HuntSearch): string {
  if (!r.found) return `Not at ${spotName(r.place)}. Try again tomorrow.`;
  const won = r.trophies.flatMap((id) => HUNT_TROPHIES.find((t) => t.pieceId === id)?.name ?? []);
  return won.length ? `Found it! ✓ You won ${won.join(" and ")}: it's in your home storage.` : "Found it! ✓";
}
