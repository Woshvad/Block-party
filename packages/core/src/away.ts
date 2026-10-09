import type { Trait } from "./resident";

// Away life: offline, your resident keeps living by its traits on a 15-minute
// server clock for up to 7 days, then stays home. Nothing runs while you're
// gone: each slot is a pure function of (resident, slot), worked out when
// someone looks. Story events are a template key plus values, never finished
// English, so every language can render them.

export const AWAY = {
  slotMinutes: 15,
  livesForDays: 7,
  recapMaxEvents: 8,
  minAwayMinutes: 15,
} as const;

const SLOT_MS = AWAY.slotMinutes * 60_000;

export type AwayPlace = "home" | "roof" | "tower" | "diner" | "faucet" | "gm_wall" | "watch_party" | "city_hall" | "crew_row";
const PLACES: AwayPlace[] = ["home", "roof", "tower", "diner", "faucet", "gm_wall", "watch_party", "city_hall", "crew_row"];

// Who you might bump into where (labelled NPCs, never real people).
export const NPC_AT: Partial<Record<AwayPlace, string>> = {
  roof: "nothing_9000",
  tower: "the_contrarian",
  faucet: "faucet_fren",
  diner: "hash_brown",
};

// Where each trait likes to drift. Weights add to the base of 1 per place.
const TRAIT_PULL: Record<Trait, Partial<Record<AwayPlace, number>>> = {
  contrarian: { tower: 4 },
  night_owl: { roof: 3 }, // and more so at night, see below
  early_bird: { gm_wall: 4 },
  diamond_hands: { home: 3 },
  copium_regular: { diner: 4 },
  roof_rat: { roof: 5 },
  bunker_lawyer: { tower: 3, city_hall: 2 },
  touch_grasser: { crew_row: 3 },
  builder: { watch_party: 2, crew_row: 2 },
  lurker: { home: 4 },
  hype_man: { watch_party: 4 },
  ape: { tower: 4 },
};

// xmur3 + mulberry32: a stable number in [0,1) for any string.
function rand01(key: string): number {
  let h = 1779033703 ^ key.length;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  let a = (h ^= h >>> 16) >>> 0;
  a = (a + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
}

export const slotOf = (t: number) => Math.floor(t / SLOT_MS);
export const slotStart = (slot: number) => slot * SLOT_MS;

// Where a resident's away self is during a slot. Pure and repeatable.
export function awayPlaceAt(userId: string, traits: readonly Trait[], slot: number, lastSeen: number): AwayPlace {
  // After 7 days away the resident stays home (like Sublet mode).
  if (slotStart(slot) - lastSeen >= AWAY.livesForDays * 86_400_000) return "home";
  const hour = new Date(slotStart(slot)).getUTCHours();
  const weights = new Map<AwayPlace, number>(PLACES.map((p) => [p, 1]));
  for (const t of traits) for (const [p, w] of Object.entries(TRAIT_PULL[t] ?? {})) weights.set(p as AwayPlace, weights.get(p as AwayPlace)! + (w ?? 0));
  if (traits.includes("night_owl") && (hour >= 22 || hour < 5)) weights.set("roof", weights.get("roof")! + 4);
  if (traits.includes("early_bird") && hour >= 5 && hour < 10) weights.set("gm_wall", weights.get("gm_wall")! + 4);
  // Everyone tends to be home in the small hours unless a trait says otherwise.
  if (hour >= 2 && hour < 7) weights.set("home", weights.get("home")! + 6);
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  let r = rand01(`${userId}:${slot}`) * total;
  for (const [p, w] of weights) {
    r -= w;
    if (r < 0) return p;
  }
  return "home";
}

export type AwayEvent =
  | { key: "away.went_to"; at: number; values: { place: AwayPlace } }
  | { key: "away.met_npc"; at: number; values: { npc: string; place: AwayPlace } }
  | { key: "away.met_resident"; at: number; values: { userId: string; place: AwayPlace } }
  | { key: "away.stayed_home"; at: number; values: { days: number } };

export type AwayPeer = { userId: string; traits: readonly Trait[]; lastSeen: number; awayUntil: number };

// Meetings are mutual by construction: both sides compute the same pair key.
function met(a: string, b: string, slot: number) {
  const [x, y] = a < b ? [a, b] : [b, a];
  return rand01(`meet:${x}:${y}:${slot}`) < 0.35;
}

// The story of one stretch away, slot by slot. Peers (crewmates and frens)
// can be bumped into when their away selves are in the same place.
export function awayStory(
  me: { userId: string; traits: readonly Trait[] },
  from: number,
  to: number,
  peers: readonly AwayPeer[] = [],
): AwayEvent[] {
  const events: AwayEvent[] = [];
  if (to - from < AWAY.minAwayMinutes * 60_000) return events;
  const first = slotOf(from) + 1;
  const last = slotOf(to);
  const homeFrom = from + AWAY.livesForDays * 86_400_000;
  let prev: AwayPlace | null = null;
  // loop-bound: one step per 15-minute slot, and slots past 7 days collapse
  // into a single "stayed home" event, so at most 672 iterations.
  for (let s = first; s <= last; s++) {
    const t = slotStart(s);
    if (t >= homeFrom) {
      events.push({ key: "away.stayed_home", at: t, values: { days: AWAY.livesForDays } });
      break;
    }
    const place = awayPlaceAt(me.userId, me.traits, s, from);
    if (place !== prev && place !== "home") events.push({ key: "away.went_to", at: t, values: { place } });
    prev = place;
    const npc = NPC_AT[place];
    if (npc && rand01(`npc:${me.userId}:${s}`) < 0.2) events.push({ key: "away.met_npc", at: t, values: { npc, place } });
    for (const p of peers) {
      if (p.userId === me.userId || t < p.lastSeen || t >= p.awayUntil) continue;
      if (awayPlaceAt(p.userId, p.traits, s, p.lastSeen) === place && place !== "home" && met(me.userId, p.userId, s)) {
        events.push({ key: "away.met_resident", at: t, values: { userId: p.userId, place } });
      }
    }
  }
  return events;
}

// The recap you see on coming back: the highlights, kept short, plus counts.
export function recap(events: readonly AwayEvent[]) {
  const places = new Map<string, number>();
  const people = new Set<string>();
  const npcs = new Set<string>();
  for (const e of events) {
    if (e.key === "away.went_to") places.set(e.values.place, (places.get(e.values.place) ?? 0) + 1);
    if (e.key === "away.met_resident") people.add(e.values.userId);
    if (e.key === "away.met_npc") npcs.add(e.values.npc);
  }
  // Meetings first (people matter most), then NPCs, then wandering.
  const rank = (e: AwayEvent) => (e.key === "away.met_resident" ? 0 : e.key === "away.stayed_home" ? 1 : e.key === "away.met_npc" ? 2 : 3);
  const highlights = [...events].sort((a, b) => rank(a) - rank(b) || a.at - b.at).slice(0, AWAY.recapMaxEvents).sort((a, b) => a.at - b.at);
  const favourite = [...places.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
  return { highlights, counts: { places: places.size, people: people.size, npcs: npcs.size }, favouritePlace: favourite };
}
