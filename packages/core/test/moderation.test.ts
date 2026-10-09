import { randomBytes } from "node:crypto";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkMessage, containsWalletAddress, findLinks, looksLikePrivateKey, looksLikeSeedPhrase } from "../src";

// Seeded phrases, so these tests can never flake on a rare unlucky draw.
function phrases(n: number, seed: number) {
  let x = seed >>> 0;
  const byte = () => ((x = (Math.imul(x ^ (x >>> 15), 2246822507) + 0x9e3779b9) >>> 0) & 255);
  return Array.from({ length: n }, (_, i) => entropyToMnemonic(Uint8Array.from({ length: i % 2 ? 16 : 32 }, byte), wordlist));
}
const generateMnemonic = (_w: unknown, strength = 128) => phrases(1, strength)[0]!;

const OLD = { accountAgeDays: 30 };
const NEW = { accountAgeDays: 1 };
const reason = (text: unknown, ctx = OLD) => {
  const v = checkMessage(text, ctx);
  return v.ok ? "OK" : v.reason;
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array) {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) if (b === 0) out = `1${out}`;
  else break;
  return out;
}

// Ordinary crypto chat that must never be blocked.
const NORMAL = [
  "gm frens, who's on the roof for the bell tonight?",
  "I think the city is coping hard on that base token market, world says 8% and we say 61%",
  "faded the long shot and lived, called it on the lock, rekt on both coin flips lol",
  "anyone want to split a sofa for the crew house? the pot has like 800 gm in it",
  "the diner special slaps today, hash brown is cooking",
  "wen bell. also wen party. also wen lambo",
  "can someone explain how aura works? is it better to say 70% or 99% if I'm pretty sure",
  "just bought the arcade cabinet, my room finally looks like a degen lives there",
  "we need three more gms or the chain breaks, wake up crew",
  "ngl the contrarian npc was right again, nothing-9000 is never right about anything",
  "check out the dashboard on dexscreener later, the chart is wild",
  "this is going to be a long winter for alts but bitcoin looks strong above the old high",
  "the mayor picked gas holiday so rides are free this week, go visit everyone",
  "my streak is 29 days, one more and I get the gm lamp",
  "lol.wtf was that bell reel, end.Next time I'm watching from the roof",
  "v2.0 of the slate looks better, 1.5x more readable",
  "send me the explorer link for that tx when it lands",
  "vitalik.eth and toly.sol are both handles not links",
  "the dot com bubble had nothing on this",
];

describe("seed phrases are blocked before sending", () => {
  it("real 12 and 24 word phrases, however they are pasted (fixed sample)", () => {
    const misses: string[] = [];
    for (const m of phrases(100, 1)) {
      const words = m.split(" ");
      const forms = [
        m,
        m.toUpperCase(),
        words.join(", "),
        words.join("\n"),
        words.map((w, j) => `${j + 1}. ${w}`).join(" "),
        words.map((w, j) => `${j + 1})${w}`).join(" "),
        `here is my seed phrase pls help: ${m} thanks`,
        words.join("\u200b "),
        words.join("  -  "),
      ];
      for (const f of forms) if (reason(f) !== "SECRET") misses.push(f.slice(0, 50));
    }
    expect(misses).toEqual([]);
  });

  it("catch rates on 2,000 phrases: exact 99.9%+, one typo 95%+, one word misremembered 95%+", () => {
    const sample = phrases(2000, 99);
    const rate = (f: (m: string) => string) => sample.filter((m) => looksLikeSeedPhrase(f(m))).length / sample.length;
    expect(rate((m) => m)).toBeGreaterThanOrEqual(0.999);
    expect(rate((m) => m.split(" ").map((w, i) => (i === 2 ? `${w}s` : w)).join(" "))).toBeGreaterThanOrEqual(0.95);
    expect(rate((m) => m.split(" ").map((w, i) => (i === 5 ? wordlist[(wordlist.indexOf(w) + 1) % 2048]! : w)).join(" "))).toBeGreaterThanOrEqual(0.95);
  });

  it("two typos in one window is no longer confidently a phrase", () => {
    const words = phrases(1, 5)[0]!.split(" ").slice(0, 12);
    words[3] = `${words[3]}xq`;
    words[7] = `${words[7]}yq`;
    expect(looksLikeSeedPhrase(words.join(" "))).toBe(false);
  });

  it("ordinary chat is never mistaken for one", () => {
    for (const msg of NORMAL) expect(reason(msg), msg).not.toBe("SECRET");
  });

  // Deterministic, so the test can't flake: a fixed seed and a measured rate.
  it("adversarial word salad of crypto words that are also BIP39 words: under 0.25% flagged", () => {
    const salad = ["over", "hold", "moon", "roof", "crew", "call", "long", "city", "market", "price", "today", "about", "above", "again", "all", "also", "the", "gm", "ser", "so", "it", "is", "wen", "lol"];
    const samples = fc.sample(fc.array(fc.constantFrom(...salad), { minLength: 12, maxLength: 40 }), { seed: 42, numRuns: 10_000 });
    const flagged = samples.filter((ws) => looksLikeSeedPhrase(ws.join(" "))).length;
    expect(flagged / samples.length).toBeLessThan(0.0025);
  });

  it("realistic chat sentences: zero flagged", () => {
    const subject = ["I", "we", "the crew", "my bag", "the city", "nobody", "the mayor", "this market"];
    const verb = ["is going to", "will", "should", "can't", "might", "has to", "is about to"];
    const act = ["hold the long shot", "call it over the price", "moon above the old high", "fade the city again", "go to the roof tonight", "buy the dip today", "say gm before the bell"];
    const tail = ["lol", "ngl", "fr", "ser", "trust me", "probably nothing", "wagmi", "it's so over", "we're so back"];
    const sentences = fc.sample(
      fc.array(fc.tuple(fc.constantFrom(...subject), fc.constantFrom(...verb), fc.constantFrom(...act), fc.constantFrom(...tail)), { minLength: 1, maxLength: 4 }),
      { seed: 7, numRuns: 5_000 },
    ).map((parts) => parts.map((p) => p.join(" ")).join(", "));
    expect(sentences.filter(looksLikeSeedPhrase)).toEqual([]);
  });

  it("the warning says the city never asks for it", () => {
    const v = checkMessage(generateMnemonic(wordlist), OLD);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/No one from Block Party will ever ask for your seed phrase/);
  });
});

describe("private keys are blocked; transaction links are not", () => {
  it("EVM, Solana and Bitcoin WIF keys, bare", () => {
    for (let i = 0; i < 30; i++) {
      const hex = randomBytes(32).toString("hex");
      expect(reason(hex)).toBe("SECRET");
      expect(reason(`0x${hex}`)).toBe("SECRET");
      expect(reason(`my key ${hex.toUpperCase()} oops`)).toBe("SECRET");
      const sol = base58(new Uint8Array(randomBytes(64)));
      expect(reason(sol), sol).toBe("SECRET");
    }
    expect(reason("5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ")).toBe("SECRET"); // WIF test vector
    expect(reason("KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617")).toBe("SECRET");
  });

  it("a transaction shared as an explorer link goes through", () => {
    const hex = randomBytes(32).toString("hex");
    const sig = base58(new Uint8Array(randomBytes(64)));
    expect(reason(`landed: https://basescan.org/tx/0x${hex}`)).toBe("OK");
    expect(reason(`landed: etherscan.io/tx/0x${hex}`)).toBe("OK");
    expect(reason(`sig: https://solscan.io/tx/${sig}`)).toBe("OK");
    // but a key tucked into some other link is still a key
    expect(reason(`https://x.com/${hex}`)).toBe("SECRET");
  });

  it("a 40-hex address is not a key", () => {
    expect(looksLikePrivateKey(`0x${randomBytes(20).toString("hex")}`)).toBe(false);
  });
});

describe("links", () => {
  it("new accounts can't post any; older ones keep only the allowlist", () => {
    const msg = "chart: https://dexscreener.com/base/xyz and claim at https://free-gm.xyz now";
    const fresh = checkMessage(msg, NEW);
    const old = checkMessage(msg, OLD);
    expect(fresh.ok && fresh.text).toBe("chart: [link removed] and claim at [link removed] now");
    expect(old.ok && old.text).toBe("chart: https://dexscreener.com/base/xyz and claim at [link removed] now");
    expect(old.ok && old.strippedLinks).toBe(1);
  });

  it("sees through disguises", () => {
    for (const disguised of ["evil dot com", "evil[.]com", "evil (dot) com", "hxxps://evil.com", "hxxp://evil.zzz/claim", "evil．com", "ev​il.com", "www.evil.io", "EVIL.COM/claim"]) {
      const v = checkMessage(`go to ${disguised}`, OLD);
      expect(v.ok && v.text, disguised).toContain("[link removed]");
      expect(v.ok && v.text, disguised).not.toMatch(/evil/i);
    }
  });

  it("lookalike allowlisted domains don't count", () => {
    for (const fake of ["https://x.com.evil.io/claim", "https://polymarket.com-claim.xyz", "https://dexscreener.co/", "https://polymarkett.com"]) {
      const v = checkMessage(fake, OLD);
      expect(v.ok && v.text, fake).toBe("[link removed]");
    }
    const sub = checkMessage("https://docs.polymarket.com/x", OLD);
    expect(sub.ok && sub.text).toBe("https://docs.polymarket.com/x");
  });

  it("ordinary chat keeps its words", () => {
    for (const msg of NORMAL) {
      const v = checkMessage(msg, NEW);
      if (msg.includes("dexscreener")) continue;
      expect(v.ok && v.strippedLinks, msg).toBe(0);
    }
    expect(findLinks("vitalik.eth")).toEqual([]);
  });
});

describe("first DMs", () => {
  it("carry no links and no wallet addresses", () => {
    const first = { ...OLD, firstDm: true };
    expect(reason("hey, check https://x.com/me", first)).toBe("FIRST_DM_LINK");
    expect(reason("hey check evil dot com", first)).toBe("FIRST_DM_LINK");
    expect(reason(`send to 0x${randomBytes(20).toString("hex")}`, first)).toBe("FIRST_DM_ADDRESS");
    expect(reason("send to vitalik.eth", first)).toBe("FIRST_DM_ADDRESS");
    expect(reason(`send to ${base58(new Uint8Array(randomBytes(32)))}`, first)).toBe("FIRST_DM_ADDRESS");
    expect(reason("gm, saw you on the roof, good call on the long shot", first)).toBe("OK");
  });

  it("later messages may mention an address (flagged, not blocked)", () => {
    const v = checkMessage(`my address is 0x${randomBytes(20).toString("hex")}`, OLD);
    expect(v.ok && v.flags).toEqual(["wallet_address"]);
    expect(containsWalletAddress("no address here, just gm")).toBe(false);
  });
});

describe("scam bait and blocked words", () => {
  it.each([
    "Connect your wallet to claim the GM airdrop",
    "c0nnect y0ur w4llet t0 cl41m",
    "DM me for the airdrop ser",
    "admin here: please verify your wallet",
    "send USDC first and I'll double it",
    "hey can you share your seed so I can help",
  ])("blocks: %s", (msg) => {
    expect(reason(msg)).toBe("SCAM");
  });

  it("a staff word list blocks whole words only", () => {
    const ctx = { ...OLD, blockedWords: ["badword"] };
    expect(reason("you are a BADWORD", ctx)).toBe("BLOCKED_WORD");
    expect(reason("notbadwordish is fine", ctx)).toBe("OK");
  });
});

describe("shape", () => {
  it("empty, invisible-only, non-string and oversized messages are refused", () => {
    for (const bad of ["", "   ", "​​", null, 42, {}, undefined]) expect(reason(bad)).toBe("EMPTY");
    expect(reason("a".repeat(2001))).toBe("TOO_LONG");
    expect(reason("🐸".repeat(2000))).toBe("OK"); // counted by what people see
  });

  it("never throws on any input (property)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), fc.integer({ min: 0, max: 30 }), fc.boolean(), (s, age, first) => {
        const v = checkMessage(s, { accountAgeDays: age, firstDm: first });
        return v.ok ? typeof v.text === "string" : typeof v.message === "string";
      }),
      { numRuns: 3000 },
    );
  });
});
