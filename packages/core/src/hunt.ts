import { type RandomInt, pick } from "./random";
import type { Area } from "./rides";

// The Daily Clue Hunt: each city day the city hides something at one public
// place and leaves a riddle about it. Ride there, search once, and the first
// find (and the seventh) brings a trophy for your home. No GM: the clue bank
// is in the public repo, so the prize is a trophy, never money.

// Every place a resident can ride to, except the street (Crew Row, homes and
// Crew Houses are all "street" to the ride system, so nothing is hidden at a
// private door).
export const HUNT_PLACES = ["city_hall", "tower", "roof", "watch_party", "gm_wall", "faucet", "diner"] as const satisfies readonly Area[];
export type HuntPlace = (typeof HUNT_PLACES)[number];

export const isHuntPlace = (x: unknown): x is HuntPlace => typeof x === "string" && (HUNT_PLACES as readonly string[]).includes(x);

// How the game says each place mid-sentence ("Search the Diner?").
export const HUNT_PLACE_NAMES: Record<HuntPlace, string> = {
  city_hall: "City Hall",
  tower: "the Tower",
  roof: "the Roof",
  watch_party: "the Watch Party",
  gm_wall: "the gm Wall",
  faucet: "the Faucet",
  diner: "the Diner",
};

// Riddles that point at a place by what happens there, never by its name.
export const HUNT_CLUES: Record<HuntPlace, readonly string[]> = {
  city_hall: [
    "One neighbour, one vote, and you have to turn up in person.",
    "Pitches go up Monday, the booth opens Friday, someone's sworn in Monday.",
    "Flags, pews, a podium and a ballot box nobody gets to peek in.",
    "Whoever wins here picks the Law of the Week.",
    "Run for Mayor here. Lose gracefully here too.",
  ],
  tower: [
    "Chance of YES? Lock it in and wait for the next tick.",
    "The Contrarian hangs out here, fading whatever the city thinks.",
    "A YES room and a NO room, and you only get into the side you called.",
    "Crews burn their pots to light up its crown at the bell.",
    "Odds on everything, and Aura for being right about it.",
  ],
  roof: [
    "The best seats in the city when the bell rings at midnight.",
    "NOTHING-9000 sits up here saying NO to everything.",
    "After 23:00 the day's headlines fight it out in pairs up here.",
    "Rats love it. Night owls too. Mind the ledge.",
    "Highest benches in town, and the bell's right there.",
  ],
  watch_party: [
    "Big games, a bigger screen, and a hype man in the front row.",
    "Match night? Grab a sofa and yell at the replay.",
    "Floodlights, stepped seats and a striped pitch.",
    "Somewhere in the world there's a match on, so the sofas are full here.",
    "The front row's already screaming, whatever the score.",
  ],
  gm_wall: [
    "Every morning, somewhere, someone says it here first.",
    "Early birds leave their two letters here before coffee.",
    "Two letters, said by everyone, painted big.",
    "It follows the sun: whoever's waking up stops by to say it.",
    "A mural that says good morning back.",
  ],
  faucet: [
    "A fountain, a bench, and a fren who answers from a script.",
    "Ask how rent works and someone here quotes you the numbers.",
    "Right after the bell, the city drifts here for a sip.",
    "Nobody here will ever ask for your seed phrase. Ask anything else.",
    "Running water and free answers for anyone who's lost.",
  ],
  diner: [
    "Chrome outside, booths inside, and alpha that's always fiction.",
    "Hash Brown is spilling alpha at the counter. Don't believe a word.",
    "Copium regulars slide into a booth here to feel Cozy again.",
    "Sunday Bags night: bring your bags, order the fries.",
    "Cheap gas, cheaper coffee, your crew in the corner booth.",
  ],
};

// Earned-only home pieces (see home.ts), granted once each.
export const HUNT_TROPHIES: ReadonlyArray<{ finds: number; pieceId: string; name: string }> = [
  { finds: 1, pieceId: "poster_clue_map", name: "the clue map" },
  { finds: 7, pieceId: "magnifier_trophy", name: "the golden magnifier" },
];

// The day's hiding place and clue: never yesterday's place, so the same
// answer never runs two days. The server calls this with crypto randomness
// the first time anyone asks for a day; tests pass a seeded generator.
export function pickHuntDay(rand: RandomInt, yesterday: HuntPlace | null): { place: HuntPlace; clueIndex: number } {
  const place = pick(
    HUNT_PLACES.filter((p) => p !== yesterday),
    rand,
  );
  return { place, clueIndex: rand(HUNT_CLUES[place].length) };
}

// The clue a stored index points at. An index past the end (the bank shrank
// since) wraps instead of showing nothing.
export function huntClue(place: HuntPlace, clueIndex: number): string {
  const clues = HUNT_CLUES[place];
  const i = Number.isSafeInteger(clueIndex) ? clueIndex : 0;
  return clues[((i % clues.length) + clues.length) % clues.length]!;
}

// Trophies a resident has from their total finds, and the next one to go for.
export function huntTrophies(finds: number): { earned: string[]; next: { pieceId: string; name: string; finds: number; toGo: number } | null } {
  const n = Number.isSafeInteger(finds) && finds > 0 ? finds : 0;
  const next = HUNT_TROPHIES.find((t) => n < t.finds);
  return {
    earned: HUNT_TROPHIES.filter((t) => n >= t.finds).map((t) => t.pieceId),
    next: next ? { ...next, toGo: next.finds - n } : null,
  };
}
