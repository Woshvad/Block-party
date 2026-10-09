// The Daily Close: the city paper at every bell, written from the day's game
// data as template keys and values (ready to translate; AI lines come at
// Launch). It names the Mayor and crews, never residents, and never prints
// real trades, amounts, wallets or real people.

export type CloseItem = { key: keyof typeof CLOSE_TEMPLATES; values: Record<string, string | number> };

export const CLOSE_TEMPLATES = {
  "front.long_shot_hit": "The Long Shot hit: {question} (the world said {world}%). {callers} neighbours called it.",
  "front.long_shot_missed": "The Long Shot missed: {question}. The world said {world}%, and the world was right.",
  "front.vibe_gap": "Biggest Vibe Gap: {question}. World {world}% · City {city}%. {verdict}",
  "front.quiet": "A quiet day on the Slate. The city is resting its candles.",
  "cityhall.law": "Law of the Week: {law}, by order of Mayor {mayor}.",
  "cityhall.no_law": "No Law of the Week. City Hall is open; the ballot box is waiting.",
  "crews.top": "#{rank} on the Bell Score: {crew} with {score}.",
  "crews.none": "No crew scored tonight. The Roof is wide open.",
  "cast.line": "{npc}: “{text}”",
  "cast.feud": "NOTHING-9000: “Nothing happened.” Something happened.",
  "weather.today": "Weather: {green}% green candles · {copium} Copium · {rekt} REKT.",
  "you.long_shot": "Local {trait} Calls the Long Shot. Neighbours Stunned.",
  "you.faded_city": "Local {trait} Fades City, Lives.",
  "you.hugged": "Local {trait} Hugs the Market All Day. Grid Comes Out Grey.",
  "you.rekt": "REKT but Unbowed: Local {trait} Vows to Call Again.",
  "you.good_day": "Local {trait} Beats the Market {wins} Times.",
  "you.quiet": "Quiet Day for Local {trait}. The Slate Will Be There Tomorrow.",
} as const;

export const VERDICTS = { city: "The city called it.", world: "The world was right. The city is coping.", void: "Voided. Nobody wins an argument with a void." } as const;

export function renderClose(item: CloseItem): string {
  return CLOSE_TEMPLATES[item.key].replace(/\{(\w+)\}/g, (_m, k: string) => String(item.values[k] ?? ""));
}

const TRAIT_TITLE: Record<string, string> = {
  contrarian: "Contrarian",
  night_owl: "Night Owl",
  early_bird: "Early Bird",
  diamond_hands: "Diamond Hands",
  copium_regular: "Copium Regular",
  roof_rat: "Roof Rat",
  bunker_lawyer: "Bunker Lawyer",
  touch_grasser: "Touch Grasser",
  builder: "Builder",
  lurker: "Lurker",
  hype_man: "Hype Man",
  ape: "Ape",
};

// One headline about your own day, from your real stats.
export function yourHeadline(s: { trait: string | null; calls: number; wins: number; reds: number; whites: number; gold: boolean; fadedAgainstCityAndWon: boolean }): CloseItem {
  const trait = (s.trait && TRAIT_TITLE[s.trait]) || "Resident";
  if (s.calls === 0) return { key: "you.quiet", values: { trait } };
  if (s.gold) return { key: "you.long_shot", values: { trait } };
  if (s.fadedAgainstCityAndWon) return { key: "you.faded_city", values: { trait } };
  if (s.whites === s.calls) return { key: "you.hugged", values: { trait } };
  if (s.reds * 2 > s.calls) return { key: "you.rekt", values: { trait } };
  return { key: "you.good_day", values: { trait, wins: s.wins } };
}
