import { validateMnemonic } from "@scure/bip39";
import { wordlist as BIP39 } from "@scure/bip39/wordlists/english.js";
import { foldLookalikes } from "./lookalikes";

// Checks every message gets before it's sent. Pure, so it runs the same in the
// API, in Workers and in rooms. The AI check runs after sending, in batches.

export const MODERATION = {
  maxChars: 2000,
  linksAfterDays: 7, // no links at all from accounts younger than this
  newAccountDmThreadsPerDay: 5,
  reportDueHours: 24,
  reportsPerDay: 20,
  // Staff notes (closing a report, deciding an appeal) and appeals need 10
  // characters; a restriction needs a longer reason, which the player reads
  // (the EU statement of reasons).
  noteMinChars: 10,
  reasonMinChars: 20,
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

// Characters that draw nothing: Unicode's default-ignorable code points (zero-
// width spaces and joiners, direction marks, fillers, variation selectors, tag
// characters) and control characters other than tabs and line breaks. One
// slipped between "gm-drop" and ".xyz" would hide a link from the filters.
// Emoji keep the joiners and presentation selectors that make them render:
// straight after an emoji (or before a keycap) they can't split a word.
const INVISIBLE =
  /(?<![\p{Extended_Pictographic}\p{Emoji_Modifier}][\u200d\ufe0e\ufe0f]?)[\u200d\ufe0e\ufe0f](?!\u20e3)|(?![\t\n\r\u200d\ufe0e\ufe0f])[\p{Default_Ignorable_Code_Point}\p{Cc}]/gu;

// What the filters read: compatibility forms folded, invisible characters
// gone. (The text people see keeps emoji and accents.)
export function cleanText(input: string): string {
  return input.normalize("NFKC").replace(INVISIBLE, "");
}

const leet: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };
// Lookalike letters from other scripts read as the Latin ones they imitate,
// so a Cyrillic "о" in "соnnect" doesn't hide the phrase.
const squash = (s: string) =>
  foldLookalikes(s.normalize("NFKD").replace(/\p{M}/gu, ""))
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

// Anything with a scheme or www. is a link. So is a bare name like
// "gm-drop.sbs", "telegra.ph" or "claim.example.foo", judged by countsAsLink
// below. Labels may be in any script ("gm-drор.xyz" with a Cyrillic о and р
// is a real, registrable name).
const LABEL = "[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]{0,61}[\\p{L}\\p{N}])?";
const LINK = new RegExp(
  `\\b(?:(?:https?|ftp):\\/\\/|www\\.)[^\\s<>"']+|(?<![\\p{L}\\p{N}_-])(?:${LABEL}\\.)+(?:\\p{L}{2,24}|xn--[a-z0-9-]{1,59})(?![\\p{L}\\p{N}_-])(?::\\d{2,5})?(?:\\/[^\\s<>"']*)?`,
  "giu",
);

// Every country code top-level domain, then the generic ones people link to
// and the ones phishing favours (.sbs, .icu, .cyou, .bond...). An ending on
// this list makes "label.tld" a link.
const COUNTRY_TLDS =
  "ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw";
const GENERIC_TLDS =
  "com net org info biz name pro mobi asia tel travel jobs cat coop aero museum int edu gov mil xxx " +
  "app dev page xyz top icu sbs cfd bond cyou buzz click link live online site website store shop tech space fun club vip win bet loan work men date " +
  "racing review stream download trade science party faith cricket accountant gdn kim bid webcam rest quest monster autos boats homes motorcycles yachts " +
  "beauty hair skin makeup lat ltd lol mom pics uno one today world life news email digital network solutions services support help cloud host press ink " +
  "zone tokyo nyc london berlin finance money exchange claims gift gifts cash capital fund investments markets trading credit loans meme art design " +
  "studio agency company center systems ventures group global social media community chat wiki games casino poker bingo lotto blog best cool codes " +
  "tools tips guru ninja rocks expert academy school college camp zip mov foo baby bar pub cafe red blue pink black green gold plus city town land " +
  "house wtf fyi fit fan fans team vote video film events tickets sale deals promo discount inc llc gmbh bio eco foundation moe ooo mba tax lawyer rip";
const KNOWN_TLDS = new Set([...COUNTRY_TLDS.split(" "), ...GENERIC_TLDS.split(" ")]);

// A reply that lost its space after the full stop ("lol.no", "ok.so", "yes.me")
// isn't an address, even when the ending is a real TLD.
const CHAT_WORDS = new Set(
  "lol lmao lmfao rofl ok okay kk yes yeah yep yup no nah nope gm gn ngl tbh imo idk omg wow haha hehe kek ty thx thanks pls plz yo hey hi hello bruh bro ser sir fr wtf damn nice cool true same wait sure oh ah hmm rip gg jk lfg wagmi ngmi rekt based so and but also well right done".split(
    " ",
  ),
);

// .eth and .sol names are handles, not links.
const NOT_A_LINK = /^[a-z0-9-]+\.(?:eth|sol)$/i;

// Whether a LINK match is really an address. A known ending makes it one
// ("telegra.ph", "gm-drop.sbs"). So does an unknown ending when the rest
// looks like an address: a path or port, a subdomain, or a digit or hyphen in
// a name ("gm-drop.whatever", "claim.gm.whatever"). Plain "word.word" with an
// unknown ending is a sentence that lost its space: "e.g.", "lol.ok",
// "end.Next", "done.thanks".
function countsAsLink(m: string): boolean {
  if (/^(?:(?:https?|ftp):\/\/|www\.)/i.test(m)) return true;
  const host = m.replace(/[:/].*$/s, "");
  const rest = m.slice(host.length);
  if (NOT_A_LINK.test(host)) return false;
  const labels = host.toLowerCase().split(".");
  const tld = labels.pop()!;
  if (KNOWN_TLDS.has(tld) || tld.startsWith("xn--")) return !(labels.length === 1 && rest === "" && CHAT_WORDS.has(labels[0]!));
  if (!/^[a-z]+$/.test(tld)) return false;
  return rest !== "" || labels.length > 1 || labels.some((l) => /[\d-]/.test(l));
}

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
  return (unDisguise(text).match(LINK) ?? []).filter(countsAsLink);
}

// Strips links the sender may not post, reading through disguises ("evil dot
// com", hxxp). Allowlisted links stay once the account is old enough.
function stripLinks(text: string, allowAny: boolean): { text: string; stripped: number } {
  let stripped = 0;
  const out = unDisguise(text).replace(LINK, (m) => {
    if (!countsAsLink(m)) return m;
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

// --- Blocked words ----------------------------------------------------------

// Staff's list, from the BLOCKED_WORDS setting: comma- or newline-separated.
// Case doesn't matter; blank entries and repeats are dropped.
export function parseBlockedWords(raw?: string): string[] {
  if (typeof raw !== "string") return [];
  const words = raw
    .split(/[,\r\n]+/)
    .map((w) => w.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " "))
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  return [...new Set(words)];
}

// Latin letters, digits and the leetspeak stand-ins squash() reads.
const LATIN_ENTRY = /^[a-z0-9@$\s'.-]+$/;

// A blocked word counts as a whole word, read the way scam phrases are:
// through leetspeak, lookalike letters and punctuation, so "b4dw0rd",
// "bаdword" (Cyrillic а), "b.a.d.w.o.r.d" and "b a d w o r d" all match
// "badword", while "notbadwordish" doesn't. An entry written in another
// script is matched word for word as written.
function hasBlockedWord(input: string, blocked: readonly string[]): boolean {
  const tokens = cleanText(input).split(/\s+/).map(squash).filter(Boolean);
  // Letters spaced out one at a time read as one word.
  const spelled: string[] = [];
  let run = "";
  for (const t of [...tokens, ""]) {
    if (t.length === 1) run += t;
    else {
      if (run.length > 1) spelled.push(run);
      run = "";
    }
  }
  const words: string[] = cleanText(input).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokenSet = new Set([...tokens, ...spelled]);
  const wordSet = new Set(words);
  // A multi-word entry matches the same words in a row.
  const inARow = (list: string[], parts: string[], join: string) => {
    const want = parts.join(join);
    for (let i = 0; i + parts.length <= list.length; i++) if (list.slice(i, i + parts.length).join(join) === want) return true;
    return false;
  };
  return blocked.some((entry) => {
    const plain = entry.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    if (LATIN_ENTRY.test(plain) && squash(plain)) {
      const parts = plain.split(/\s+/).map(squash).filter(Boolean);
      return parts.length === 1 ? tokenSet.has(parts[0]!) : inARow(tokens, parts, "") || tokenSet.has(parts.join(""));
    }
    const parts = entry.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return parts.length === 1 ? wordSet.has(parts[0]!) : parts.length > 1 && inARow(words, parts, " ");
  });
}

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
  if (ctx.blockedWords?.length && hasBlockedWord(input, ctx.blockedWords)) return { ok: false, reason: "BLOCKED_WORD", message: "that word isn't allowed here" };

  const { text, stripped } = stripLinks(input, ctx.accountAgeDays >= MODERATION.linksAfterDays);
  const flags: Array<"links_stripped" | "wallet_address"> = [];
  if (stripped > 0) flags.push("links_stripped");
  if (containsWalletAddress(outsideExplorerLinks)) flags.push("wallet_address");
  return { ok: true, text: text.trim(), strippedLinks: stripped, flags };
}

// --- Reports --------------------------------------------------------------

export const REPORT_REASONS = ["impersonation", "scam", "unwanted_romance", "under_18", "harassment", "spam", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
