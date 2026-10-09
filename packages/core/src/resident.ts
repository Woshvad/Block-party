import { type CityDay, daysBetween } from "./clock";
import { type RandomInt, pick, pickDistinct } from "./random";

// --- Catalogue (MVP) ------------------------------------------------------

export const TRAITS = [
  "contrarian",
  "night_owl",
  "early_bird",
  "diamond_hands",
  "copium_regular",
  "roof_rat",
  "bunker_lawyer",
  "touch_grasser",
  "builder",
  "lurker",
  "hype_man",
  "ape",
] as const;
export type Trait = (typeof TRAITS)[number];

export const GOALS = ["oracle", "crew_captain", "mayor", "homebody"] as const;
export type Goal = (typeof GOALS)[number];

export const KIT_STYLES = ["neon", "cozy", "minimal"] as const;
export type KitStyle = (typeof KIT_STYLES)[number];

// Each backstory's starter item is cosmetic and carries the same GM value.
export const BACKSTORIES = {
  airdrop_baby: { starterItem: "poster_airdrop_baby" },
  exit_liquidity: { starterItem: "tee_exit_liquidity" },
  og_kid: { starterItem: "cap_og_kid" },
  bear_market_survivor: { starterItem: "poster_bear_survivor" },
} as const;
export type Backstory = keyof typeof BACKSTORIES;
export const BACKSTORY_IDS = Object.keys(BACKSTORIES) as Backstory[];

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

// Our own low-poly kit: parts on one skeleton, colours from palettes.
export const LOOK_PARTS = {
  bodyType: ids("body", 3),
  face: ids("face", 8),
  hair: ["none", ...ids("hair", 10)],
  top: ids("top", 8),
  bottom: ids("bottom", 5),
  shoes: ids("shoes", 4),
  hat: ["none", ...ids("hat", 4)],
  glasses: ["none", ...ids("glasses", 4)],
} as const;
export const LOOK_PALETTES = { skinTone: 10, hairColor: 12, outfitColor: 16 } as const;

export type Look = { v: 1 } & { [K in keyof typeof LOOK_PARTS]: string } & {
  [K in keyof typeof LOOK_PALETTES]: number;
};

// --- Seasons --------------------------------------------------------------

export const SEASON_LENGTH_DAYS = 28;
// First day of season 1. Set to the beta's first Monday before launch.
export const SEASON_EPOCH: CityDay = "2026-10-05";

export function seasonOf(day: CityDay, epoch: CityDay = SEASON_EPOCH): number {
  const d = daysBetween(epoch, day);
  return d < 0 ? 0 : Math.floor(d / SEASON_LENGTH_DAYS) + 1;
}

// --- Validation -----------------------------------------------------------

export type ResidentField = "handle" | "name" | "look" | "traits" | "goal" | "kitStyle";

export class ResidentInputError extends Error {
  constructor(
    readonly field: ResidentField,
    readonly reason: string,
  ) {
    super(`${field}: ${reason}`);
    this.name = "ResidentInputError";
  }
}

// Collapse a string to letters and digits, undo common leetspeak, so
// "N0TH1NG_9000", "Faucet-Fren" and "bl0ckp4rty" match what they imitate.
export function skeleton(s: string): string {
  const leet: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", $: "s", "@": "a", "|": "i", "!": "i" };
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[0-9$@|!]/g, (c) => leet[c] ?? c)
    .replace(/[^a-z]/g, "");
}

// The city's cast and its staff: nobody may look like them. Matched against
// the whole name's skeleton. Real first names (Steve, Dev) are deliberately
// not here; only the cast's full names are.
const RESERVED_EXACT = [
  "nothing9000",
  "nothing",
  "contrarian",
  "thecontrarian",
  "faucetfren",
  "hashbrown",
  "50xsteve",
  "parkranger",
  "mayor",
  "mod",
  "mods",
  "staff",
  "system",
  "root",
  "bot",
  "gm",
  "ser",
].map(skeleton);

// Multi-word impersonation or scam bait: blocked anywhere in the name.
const RESERVED_ANYWHERE = [
  "blockparty",
  "nothing9000",
  "faucetfren",
  "hashbrown",
  "seedphrase",
  "privatekey",
  "walletconnect",
].map(skeleton);

// Single risky words: blocked when a word starts or ends with them
// ("superadmin", "admin123", "support_bot"), so "Badminton" stays fine.
const RESERVED_WORD_EDGE = ["admin", "official", "support", "helpdesk", "moderator", "verify", "verified", "airdrop", "giveaway"].map(
  skeleton,
);

function words(s: string): string[] {
  return s
    .normalize("NFKC")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}$@|!]+/u)
    .map(skeleton)
    .filter(Boolean);
}

function reservedReason(s: string): string | null {
  const k = skeleton(s);
  if (!k) return null;
  if (RESERVED_EXACT.includes(k)) return "reserved";
  if (RESERVED_ANYWHERE.some((r) => k.includes(r))) return "reserved";
  if (words(s).some((w) => RESERVED_WORD_EDGE.some((r) => w.startsWith(r) || w.endsWith(r)))) return "reserved";
  return null;
}

const HANDLE_RE = /^[A-Za-z0-9_]{3,15}$/;

export function validateHandle(input: unknown): string {
  if (typeof input !== "string") throw new ResidentInputError("handle", "required");
  const h = input.trim().replace(/^@/, "");
  if (!HANDLE_RE.test(h)) throw new ResidentInputError("handle", "3 to 15 letters, digits or _");
  if (/^[0-9_]+$/.test(h)) throw new ResidentInputError("handle", "needs a letter");
  if (/__/.test(h)) throw new ResidentInputError("handle", "no double underscores");
  const r = reservedReason(h);
  if (r) throw new ResidentInputError("handle", r);
  return h;
}

// Invisible and direction-changing characters that let one name pose as
// another, plus Unicode tag characters (hidden "ASCII smuggling" text) and
// variation selectors.
const INVISIBLE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const TAG = /[\u{e0020}-\u{e007f}]/u;
const BLACK_FLAG = "\u{1f3f4}";
const CANCEL_TAG = "\u{e007f}";

// Emoji keep the joiners, selectors and modifiers that make them render;
// tags survive only inside a real subdivision flag (England, Scotland, Wales).
function cleanGrapheme(g: string): string {
  if (!PICTOGRAPHIC.test(g)) return g.replace(INVISIBLE, "");
  const isTagFlag = g.startsWith(BLACK_FLAG) && g.endsWith(CANCEL_TAG) && /^[\u{1f3f4}][\u{e0061}-\u{e007a}]{2,6}\u{e007f}$/u.test(g);
  if (isTagFlag) return g;
  if (TAG.test(g)) return g.replace(INVISIBLE, ""); // smuggled tags: strip everything invisible
  return g.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "");
}

const URLISH = /(https?:|www\.|\.(com|io|xyz|org|net|gg|me|app|finance)\b|t\.me\/|discord\.gg)/i;

export const NAME_MAX_GRAPHEMES = 24;

export function graphemeCount(s: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;
}

export function normalizeName(input: unknown, maxGraphemes: number = NAME_MAX_GRAPHEMES): string {
  if (typeof input !== "string") throw new ResidentInputError("name", "required");
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(input.normalize("NFKC"));
  const n = [...segments]
    .map((x) => cleanGrapheme(x.segment))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!n) throw new ResidentInputError("name", "required");
  if (graphemeCount(n) > maxGraphemes) throw new ResidentInputError("name", `at most ${maxGraphemes} characters`);
  if (URLISH.test(n)) throw new ResidentInputError("name", "no links");
  if (!/[\p{L}\p{N}]/u.test(n)) throw new ResidentInputError("name", "needs a letter or digit");
  const r = reservedReason(n);
  if (r) throw new ResidentInputError("name", r);
  return n;
}

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;

export function validateLook(input: unknown): Look {
  if (!isPlainObject(input)) throw new ResidentInputError("look", "must be an object");
  const allowed = new Set(["v", ...Object.keys(LOOK_PARTS), ...Object.keys(LOOK_PALETTES)]);
  for (const k of Object.keys(input)) {
    if (!allowed.has(k)) throw new ResidentInputError("look", `unknown part ${k}`);
  }
  if (input.v !== 1) throw new ResidentInputError("look", "unknown version");
  const out: Record<string, unknown> = { v: 1 };
  for (const [part, options] of Object.entries(LOOK_PARTS)) {
    const v = input[part];
    if (typeof v !== "string" || !(options as readonly string[]).includes(v)) {
      throw new ResidentInputError("look", `bad ${part}`);
    }
    out[part] = v;
  }
  for (const [palette, size] of Object.entries(LOOK_PALETTES)) {
    const v = input[palette];
    if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) >= size) {
      throw new ResidentInputError("look", `bad ${palette}`);
    }
    out[palette] = v;
  }
  return out as Look;
}

export function validateTraits(input: unknown): Trait[] {
  if (!Array.isArray(input) || input.length !== 3) throw new ResidentInputError("traits", "pick exactly 3");
  for (const t of input) {
    if (typeof t !== "string" || !(TRAITS as readonly string[]).includes(t)) {
      throw new ResidentInputError("traits", "unknown trait");
    }
  }
  if (new Set(input).size !== 3) throw new ResidentInputError("traits", "pick 3 different traits");
  // Stored sorted so the same set always compares equal.
  return [...(input as Trait[])].sort();
}

export function validateGoal(input: unknown): Goal {
  if (typeof input !== "string" || !(GOALS as readonly string[]).includes(input)) {
    throw new ResidentInputError("goal", "unknown goal");
  }
  return input as Goal;
}

export function validateKitStyle(input: unknown): KitStyle {
  if (typeof input !== "string" || !(KIT_STYLES as readonly string[]).includes(input)) {
    throw new ResidentInputError("kitStyle", "unknown style");
  }
  return input as KitStyle;
}

export type ResidentInput = {
  handle: string;
  name: string;
  look: Look;
  traits: Trait[];
  goal: Goal;
  kitStyle: KitStyle;
};

export function validateResidentInput(input: unknown): ResidentInput {
  if (!isPlainObject(input)) throw new ResidentInputError("name", "missing resident");
  return {
    handle: validateHandle(input.handle),
    name: normalizeName(input.name),
    look: validateLook(input.look),
    traits: validateTraits(input.traits),
    goal: validateGoal(input.goal),
    kitStyle: validateKitStyle(input.kitStyle),
  };
}

// --- "Pick for me" and the deal -------------------------------------------

export function randomLook(rand: RandomInt): Look {
  const look: Record<string, unknown> = { v: 1 };
  for (const [part, options] of Object.entries(LOOK_PARTS)) look[part] = pick(options, rand);
  for (const [palette, size] of Object.entries(LOOK_PALETTES)) look[palette] = rand(size);
  return look as Look;
}

const HANDLE_ADJ = ["based", "comfy", "rekt", "bullish", "salty", "lucky", "early", "sleepy", "spicy", "chill", "giga", "smol"];
const HANDLE_NOUN = ["frog", "ape", "whale", "shrimp", "degen", "anon", "oracle", "builder", "bagel", "candle", "penguin", "hodler"];

export function suggestHandle(rand: RandomInt): string {
  const base = `${pick(HANDLE_ADJ, rand)}_${pick(HANDLE_NOUN, rand)}`;
  const room = Math.min(3, 15 - base.length); // handles top out at 15
  return room > 0 ? `${base}${rand(10 ** room)}` : base;
}

export function pickForMe(rand: RandomInt): ResidentInput {
  const handle = suggestHandle(rand);
  return {
    handle,
    name: handle.replace(/_/g, " ").replace(/\d+$/, "").trim(),
    look: randomLook(rand),
    traits: pickDistinct(TRAITS, 3, rand).sort(),
    goal: pick(GOALS, rand),
    kitStyle: pick(KIT_STYLES, rand),
  };
}

export function dealBackstory(rand: RandomInt): { backstory: Backstory; starterItem: string } {
  const backstory = pick(BACKSTORY_IDS, rand);
  return { backstory, starterItem: BACKSTORIES[backstory].starterItem };
}
