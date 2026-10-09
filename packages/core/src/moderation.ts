import { validateMnemonic } from "@scure/bip39";
import { wordlist as BIP39 } from "@scure/bip39/wordlists/english.js";

// Checks every message gets before it's sent. Pure, so it runs the same in the
// API, in Workers and in rooms. The AI check runs after sending, in batches.

export const MODERATION = {
  maxChars: 2000,
  linksAfterDays: 7, // no links at all from accounts younger than this
  newAccountDmThreadsPerDay: 5,
  reportDueHours: 24,
  reportsPerDay: 20,
} as const;

export const LINK_ALLOWLIST = [
  "x.com",
  "twitter.com",
  "polymarket.com",
  "dexscreener.com",
  "coingecko.com",
  "coinmarketcap.com",
  "basescan.org",
  "etherscan.io",
  "solscan.io",
  "youtube.com",
  "youtu.be",
] as const;

// Crypto scam bait. Matched on a squashed form, so spacing and leetspeak don't help.
const SCAM_PHRASES = [
  "connect your wallet to claim",
  "connect wallet to claim",
  "validate your wallet",
  "wallet validation",
  "verify your wallet",
  "dm me for the airdrop",
  "dm me for airdrop",
  "claim your airdrop",
  "send usdc first",
  "send me your seed",
  "share your seed",
  "share your private key",
  "double your crypto",
  "guaranteed returns",
  "recover your wallet",
];

export type MessageContext = {
  accountAgeDays: number;
  firstDm?: boolean;
  // Words the city blocks outright, from a maintained list chosen by staff.
  blockedWords?: readonly string[];
};

export type Verdict =
  | { ok: true; text: string; strippedLinks: number; flags: Array<"links_stripped" | "wallet_address"> }
  | { ok: false; reason: "EMPTY" | "TOO_LONG" | "SECRET" | "FIRST_DM_LINK" | "FIRST_DM_ADDRESS" | "SCAM" | "BLOCKED_WORD"; message: string };

// --- Normalising ------------------------------------------------------------

const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ﻿ﾠ\u{e0000}-\u{e007f}]/gu;

// What the filters read: compatibility forms folded, invisible characters
// gone. (The text people see keeps emoji and accents.)
export function cleanText(input: string): string {
  return input.normalize("NFKC").replace(INVISIBLE, "");
}

const leet: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };
const squash = (s: string) =>
  s
    .toLowerCase()
    .replace(/[0-9@$]/g, (c) => leet[c] ?? c)
    .replace(/[^a-z]/g, "");

// --- Secrets: seed phrases and private keys ---------------------------------

const BIP39_SET = new Set(BIP39);

// One edit (insert, delete or substitute a letter) away from a BIP39 word:
// a plausible typo in a pasted phrase.
function nearBip39(word: string): boolean {
  if (word.length < 4) return false;
  for (const w of BIP39) {
    if (Math.abs(w.length - word.length) > 1) continue;
    let i = 0;
    let j = 0;
    let edits = 0;
    // loop-bound: i and j only grow, each at most to its word's length.
    while (i < w.length && j < word.length) {
      if (w[i] === word[j]) {
        i++;
        j++;
        continue;
      }
      if (++edits > 1) break;
      if (w.length > word.length) i++;
      else if (w.length < word.length) j++;
      else {
        i++;
        j++;
      }
    }
    edits += w.length - i + (word.length - j);
    if (edits <= 1) return true;
  }
  return false;
}

// Everyday English words that are also BIP39 words. A real phrase draws its
// words uniformly from all 2,048, so it averages under one of these in 12;
// chat is full of them. (Intersected with BIP39 below, so a stray non-BIP39
// entry here does nothing.)
const EVERYDAY = new Set(
  `about above across act action add again age agree air all alone also always amount answer any area army around art ask away baby back bad bag ball bank base basic beach because become before begin behind believe below best better between big bird black blood blue board body book born boss bottom box boy brain bread bring brother brown build business busy buy call can car card care carry case cash cat catch cause chair chance change chart cheap check child city claim class clean click close coin cold come common cool cost could country course cover crazy crew cross cry day deal deep dog dollar door down dream drink drive drop early earn east easy end enjoy enough enter even evening ever every exit eye face fact fade fall family fan far farm father feel few file film find fine fire first fish five fix floor fly follow food foot forget free friend front fun funny future game gas get gift girl give glad glass goal gold good great green group grow guess gun half hand happy hard have head hear heart help hero high hill hold home hope horse hour house huge human idea job join joke jump just keep key kid kind king know lady later laugh law learn leave left life light like line link list little live long love lucky make man market maybe meet message mind minute miss mom money month moon more morning mother move movie much music must name near need never news next nice night nothing now number off often old once one only open order other over own page paper party pay people person phone pick place plan play please point poor post price print profit pull push put quick quit rain read ready real reason red rich ride right road roof room run sad safe same save say school sea second see seed sell send seven share shop short show sick side sign simple sing sister sit size sleep small smart smile some son song soon sorry sound south speak spend sport stay still stop story strong stuff such sun sure swap talk team tell ten thank that then there they thing this three time today together token tomorrow tonight top town trade true trust try turn two under until use very video visit wait walk wall want war warm watch water way week west what when where white wife will win window winter wish with woman word work world worry write wrong yard year yellow you young`.split(/\s+/),
);
const EVERYDAY_MAX = 4;

// 12 words in a row that read as a seed phrase:
//  - all BIP39 words, (nearly) all different, with a valid checksum, or
//  - all BIP39 words, all different, and at most 4 everyday words (chat
//    repeats itself and leans on common words; a random phrase does neither), or
//  - the same with 11 BIP39 words plus one plausible typo of one.
// Whatever sits between the words (commas, "1." numbering, line breaks) is ignored.
export function looksLikeSeedPhrase(text: string): boolean {
  const words = cleanText(text).toLowerCase().match(/[a-z]+/g) ?? [];
  const size = 12;
  if (words.length < size) return false;
  for (let i = 0; i + size <= words.length; i++) {
    const window = words.slice(i, i + size);
    const hits = window.filter((w) => BIP39_SET.has(w));
    const misses = window.filter((w) => !BIP39_SET.has(w));
    const distinct = new Set(hits).size;
    // Any 12 BIP39 words pass the checksum 1 time in 16 by luck, so chat
    // that happens to be all BIP39 words also needs to look random.
    if (hits.length === size && distinct >= size - 1 && validateMnemonic(window.join(" "), BIP39)) return true;
    const everyday = hits.filter((w) => EVERYDAY.has(w)).length;
    if (hits.length === size && distinct === size && everyday <= EVERYDAY_MAX) return true;
    if (hits.length === size - 1 && distinct === size - 1 && everyday <= EVERYDAY_MAX && nearBip39(misses[0]!)) return true;
  }
  return false;
}

const B58 = "[1-9A-HJ-NP-Za-km-z]";
const PRIVATE_KEY = new RegExp(
  [
    "\\b(?:0x)?[0-9a-fA-F]{64}\\b", // EVM / raw 32-byte key
    `(?<![1-9A-HJ-NP-Za-km-z])${B58}{86,90}(?![1-9A-HJ-NP-Za-km-z])`, // Solana 64-byte secret key
    `(?<![1-9A-HJ-NP-Za-km-z])[5KL]${B58}{50,51}(?![1-9A-HJ-NP-Za-km-z])`, // Bitcoin WIF
    "\\bxprv[1-9A-HJ-NP-Za-km-z]{100,}", // extended private key
  ].join("|"),
);

export const looksLikePrivateKey = (text: string) => PRIVATE_KEY.test(cleanText(text));

// --- Wallet addresses (blocked only in a first DM) ---------------------------

const ADDRESS = new RegExp(
  [
    "\\b0x[0-9a-fA-F]{40}\\b",
    "\\bbc1[02-9ac-hj-np-z]{25,62}\\b",
    `(?<![1-9A-HJ-NP-Za-km-z])${B58}{32,44}(?![1-9A-HJ-NP-Za-km-z])`,
    "\\b[a-z0-9-]{3,}\\.(?:eth|sol)\\b",
  ].join("|"),
  "i",
);
export const containsWalletAddress = (text: string) => ADDRESS.test(cleanText(text));

// --- Links ----------------------------------------------------------------------

const FILLER = new Set(["the", "a", "an", "this", "that", "my", "your", "our", "his", "her", "their", "its", "big", "old", "first"]);

// Spelled-out dots and defanged schemes get read as the real thing.
function unDisguise(text: string): string {
  return cleanText(text)
    .replace(/h\s*x\s*x\s*p(s?)/gi, "http$1")
    .replace(/\s*[[(]\s*(?:\.|dot)\s*[\])]\s*/gi, ".")
    // "evil dot com" is a disguised link; "the dot com bubble" is history.
    .replace(/(\S+)\s+dot\s+(?=[a-z]{2,}\b)/gi, (m, word: string) => (FILLER.has(word.toLowerCase()) ? m : `${word}.`))
    .replace(/[。．｡]/g, ".");
}

// Bare domains count as links only with a TLD people actually use for links;
// "lol.wtf" or "end.Next" in a sentence are not links. Anything with a scheme
// or www. always is.
const TLDS = "com|net|org|io|xyz|gg|me|app|co|ai|sh|fi|to|ly|tv|cc|ru|cn|info|biz|site|online|link|click|top|live|fun|finance|money|exchange|claims?|gift|vip|pro|dev|so|lol|meme|world|art|club|store|shop|tech|us|uk|de|fr|ng|in|br|tr|kr|vn|cx|pw|tk|ml|ga|cf|gq|eth|sol";
const LINK = new RegExp(
  `\\b(?:(?:https?|ftp):\\/\\/|www\\.)[^\\s<>"']+|\\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS})\\b(?::\\d{2,5})?(?:\\/[^\\s<>"']*)?`,
  "gi",
);
// .eth and .sol names are handles, not links.
const NOT_A_LINK = /^[a-z0-9-]+\.(?:eth|sol)$/i;

export function hostOf(link: string): string | null {
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(link) ? link : `https://${link}`);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function isAllowedHost(host: string): boolean {
  return LINK_ALLOWLIST.some((d) => host === d || host.endsWith(`.${d}`));
}

export function findLinks(text: string): string[] {
  return (unDisguise(text).match(LINK) ?? []).filter((l) => !NOT_A_LINK.test(l.replace(/\/.*$/, "")));
}

// Strips links the sender may not post, reading through disguises ("evil dot
// com", hxxp). Allowlisted links stay once the account is old enough.
function stripLinks(text: string, allowAny: boolean): { text: string; stripped: number } {
  let stripped = 0;
  const out = unDisguise(text).replace(LINK, (m) => {
    if (NOT_A_LINK.test(m.replace(/\/.*$/, ""))) return m;
    const host = hostOf(m);
    if (allowAny && host && isAllowedHost(host)) return m;
    stripped++;
    return "[link removed]";
  });
  return { text: out, stripped };
}

// Explorer links to a transaction are fine to share; the hash inside one is
// not a secret.
const EXPLORER_TX = /\b(?:www\.)?(?:etherscan\.io|basescan\.org|solscan\.io)\/tx\/[A-Za-z0-9]+/gi;

// --- The verdict ----------------------------------------------------------

const SECRET_WARNING = "No one from Block Party will ever ask for your seed phrase or your funds. Not the Mayor. Not your crew.";

export function checkMessage(input: unknown, ctx: MessageContext): Verdict {
  if (typeof input !== "string") return { ok: false, reason: "EMPTY", message: "say something" };
  const visible = cleanText(input).replace(/\s+/g, " ").trim();
  if (!visible) return { ok: false, reason: "EMPTY", message: "say something" };
  if ([...visible].length > MODERATION.maxChars) return { ok: false, reason: "TOO_LONG", message: `at most ${MODERATION.maxChars} characters` };

  // Never let a secret leave the sender's device, whatever else is true. A
  // bare transaction hash has the same shape as a key, so it's held too; the
  // explorer link goes through.
  const outsideExplorerLinks = cleanText(input).replace(EXPLORER_TX, " ");
  if (looksLikeSeedPhrase(input) || looksLikePrivateKey(outsideExplorerLinks)) {
    return {
      ok: false,
      reason: "SECRET",
      message: `That looks like a seed phrase or private key, so it wasn't sent. If it's a transaction, share the explorer link instead. ${SECRET_WARNING}`,
    };
  }

  const links = findLinks(input);
  if (ctx.firstDm && links.length > 0) return { ok: false, reason: "FIRST_DM_LINK", message: "a first message can't carry links" };
  if (ctx.firstDm && containsWalletAddress(outsideExplorerLinks)) return { ok: false, reason: "FIRST_DM_ADDRESS", message: "a first message can't carry wallet addresses" };

  const squashed = squash(unDisguise(input));
  if (SCAM_PHRASES.some((p) => squashed.includes(squash(p)))) {
    return { ok: false, reason: "SCAM", message: `That reads like a scam, so it wasn't sent. ${SECRET_WARNING}` };
  }
  const words: string[] = cleanText(input).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (ctx.blockedWords?.some((w) => words.includes(w.toLowerCase()))) return { ok: false, reason: "BLOCKED_WORD", message: "that word isn't allowed here" };

  const { text, stripped } = stripLinks(input, ctx.accountAgeDays >= MODERATION.linksAfterDays);
  const flags: Array<"links_stripped" | "wallet_address"> = [];
  if (stripped > 0) flags.push("links_stripped");
  if (containsWalletAddress(outsideExplorerLinks)) flags.push("wallet_address");
  return { ok: true, text: text.trim(), strippedLinks: stripped, flags };
}

// --- Reports --------------------------------------------------------------

export const REPORT_REASONS = ["impersonation", "scam", "unwanted_romance", "under_18", "harassment", "spam", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
