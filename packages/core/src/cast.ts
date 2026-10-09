// The cast: labelled AI parody characters who live in the city. In the MVP
// they run on rules and templates. They never earn, hold or lose GM, never
// move the City or Crew bars, and never tell anyone what to call.

export type NpcKey = "nothing_9000" | "contrarian" | "faucet_fren" | "hash_brown";

export const CAST: Record<NpcKey, { id: string; name: string; home: string; label: "NPC · AI" }> = {
  nothing_9000: { id: "00000000-0000-4000-8000-000000000901", name: "NOTHING-9000", home: "roof", label: "NPC · AI" },
  contrarian: { id: "00000000-0000-4000-8000-000000000902", name: "The Contrarian", home: "tower", label: "NPC · AI" },
  faucet_fren: { id: "00000000-0000-4000-8000-000000000903", name: "Faucet Fren", home: "faucet", label: "NPC · AI" },
  hash_brown: { id: "00000000-0000-4000-8000-000000000904", name: "Hash Brown", home: "diner", label: "NPC · AI" },
};
export const NPC_IDS: readonly string[] = Object.values(CAST).map((c) => c.id);
export const npcById = (id: string) => (Object.entries(CAST) as Array<[NpcKey, (typeof CAST)[NpcKey]]>).find(([, c]) => c.id === id)?.[0] ?? null;

export const NPC = {
  contrarianCallsAtHour: 12, // UTC: late enough to see where the city leans
  linesPerBoardPerDay: 3,
} as const;

// NOTHING-9000 says NO to everything, one slider-step past the market.
export const nothingCall = (price: number) => (price > 1 ? { side: "no" as const, chance: Math.max(1, price - 10) } : null);

// The Contrarian takes the side against the city's majority (or against the
// world's favourite when nobody has called yet).
export function contrarianCall(price: number, yes: number, no: number): { side: "yes" | "no"; chance: number } | null {
  const side: "yes" | "no" = yes + no > 0 ? (yes >= no ? "no" : "yes") : price >= 50 ? "no" : "yes";
  if (side === "yes" && price >= 99) return null;
  if (side === "no" && price <= 1) return null;
  return { side, chance: side === "yes" ? Math.min(99, price + 10) : Math.max(1, price - 10) };
}

// After-the-bell lines, one per NPC on its home Board. Templates with values only.
export const NPC_LINES: Record<NpcKey, Record<string, string>> = {
  nothing_9000: {
    mostly_no: "Nothing happened. Again.",
    mostly_yes: "Something happened. Statistically irrelevant.",
    no_slate: "No Slate, no problem. Nothing happened anyway.",
  },
  contrarian: {
    beat: "The city leaned {cityLean}. I didn't. Contrarian of the Week energy.",
    lost: "The city leaned {cityLean} and got it right. Even a stopped clock, ser.",
    no_slate: "No Slate today. I disagree with that too.",
  },
  faucet_fren: {
    streak: "gm! That's day {streak} of my streak. Not that I'm counting. I'm counting.",
  },
  hash_brown: {
    alpha: "Today's alpha, straight from the grill: {alpha} (Pure fiction, ser.)",
  },
};

// Hash Brown's "alpha": always fiction, never a tip about anything real.
export const HASH_BROWN_ALPHA = [
  "the toaster is bullish on breakfast.",
  "a frog walked in with a hoodie. Read into it.",
  "the special is leaving the menu soon. Or not. I'm a cook.",
  "someone ordered extra copium on the side.",
  "the coffee machine has been accumulating.",
  "the grill says the bell rings at midnight. The grill is always right.",
];

export function npcLine(key: NpcKey, kind: string, values: Record<string, string | number> = {}): string {
  const t = NPC_LINES[key][kind];
  if (!t) throw new Error(`no line ${key}.${kind}`);
  return t.replace(/\{(\w+)\}/g, (_m, k: string) => String(values[k] ?? ""));
}
