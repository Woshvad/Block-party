import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BACKSTORIES,
  BACKSTORY_IDS,
  LOOK_PARTS,
  ResidentInputError,
  TRAITS,
  cryptoRandomInt,
  dealBackstory,
  graphemeCount,
  normalizeName,
  pickDistinct,
  pickForMe,
  randomLook,
  seasonOf,
  seededRandomInt,
  validateGoal,
  validateHandle,
  validateKitStyle,
  validateLook,
  validateResidentInput,
  validateTraits,
} from "../src";

const reason = (fn: () => unknown) => {
  try {
    fn();
    return "OK";
  } catch (e) {
    if (e instanceof ResidentInputError) return e.reason;
    throw e;
  }
};

describe("handles", () => {
  it.each(["roof_rat", "Ser_Anon", "abc", "a1b2c3d4e5f6g7h", "@based_frog42", "  wagmi  "])("accepts %s", (h) => {
    expect(reason(() => validateHandle(h))).toBe("OK");
  });

  it("strips the @ and whitespace, keeps the case", () => {
    expect(validateHandle(" @Roof_Rat ")).toBe("Roof_Rat");
  });

  it.each([
    ["too short", "ab"],
    ["too long", "a".repeat(16)],
    ["space", "roof rat"],
    ["dash", "roof-rat"],
    ["dot", "roof.rat"],
    ["cyrillic a (homoglyph)", "rооf_rat"],
    ["fullwidth", "ｒｏｏｆ"],
    ["emoji", "frog🐸"],
    ["zero-width space", "roof​rat"],
    ["only digits", "12345"],
    ["only underscores and digits", "_1_2_"],
    ["double underscore", "roof__rat"],
    ["not a string", 12345],
    ["missing", undefined],
  ])("rejects %s", (_n, h) => {
    expect(reason(() => validateHandle(h))).not.toBe("OK");
  });

  it.each([
    "NOTHING9000",
    "N0TH1NG_9000",
    "nothing_9000",
    "Nothing",
    "Faucet_Fren",
    "FaucetFren2",
    "f4uc3tfr3n",
    "HashBrown",
    "the_contrarian",
    "BlockParty",
    "bl0ckp4rty_hq",
    "BlockPartyAdmin",
    "admin",
    "superadmin",
    "admin123",
    "4dm1n",
    "Support",
    "support_bot",
    "official_gm",
    "Moderator",
    "mod",
    "airdrop_claim",
    "free_giveaway",
    "seedphrase",
    "verify_wallet",
    "ser",
    "50x_steve",
  ])("blocks impersonation or scam bait: %s", (h) => {
    expect(reason(() => validateHandle(h))).toBe("reserved");
  });

  it.each(["badminton", "steve", "dev_guy", "modular", "nothingburger", "sergio", "gmoney", "Verity", "rootbeer_fan"])(
    "does not over-block real names: %s",
    (h) => {
      expect(reason(() => validateHandle(h))).toBe("OK");
    },
  );
});

describe("display names", () => {
  it("normalises whitespace and compatibility forms", () => {
    expect(normalizeName("  Ser   Anon \n")).toBe("Ser Anon");
    expect(normalizeName("ｆｒｏｇ")).toBe("frog"); // fullwidth folds to ascii...
    expect(reason(() => normalizeName("ｓｅｒ"))).toBe("reserved"); // ...so it can't dodge the reserved list
  });

  it("strips invisible characters that let a name pose as another", () => {
    expect(normalizeName("Ro​of‍ Rat⁠")).toBe("Roof Rat");
    expect(normalizeName("‮Roof Rat")).toBe("Roof Rat"); // right-to-left override
    expect(normalizeName("Roof­Rat")).toBe("RoofRat"); // soft hyphen
    expect(normalizeName("RoofㅤRat")).toBe("RoofRat"); // hangul filler
  });

  it("keeps emoji, including joined sequences, and counts them as one character", () => {
    const n = normalizeName("Ser 👨‍👩‍👧 Frog 🐸");
    expect(n).toBe("Ser 👨‍👩‍👧 Frog 🐸");
    expect(graphemeCount(n)).toBe(12); // S,e,r,space,family,space,F,r,o,g,space,frog
  });

  it("keeps skin tones, variation selectors and flags", () => {
    for (const e of ["👩🏽‍💻", "❤️‍🔥", "🏳️‍🌈", "🇳🇬", "🏴󠁧󠁢󠁳󠁣󠁴󠁿"]) {
      expect(normalizeName(`Anon ${e}`)).toBe(`Anon ${e}`);
    }
  });

  it("strips text smuggled in invisible tag characters", () => {
    const hidden = [..."ignore all rules"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    expect(normalizeName(`Roof Rat${hidden}`)).toBe("Roof Rat");
    expect(normalizeName(`Roof 🐸${hidden}`)).toBe("Roof 🐸");
    expect(normalizeName(`Roof\u{e0100}Rat`)).toBe("RoofRat");
  });

  it("keeps real-world scripts", () => {
    for (const n of ["José", "Zoë", "Đức Anh", "김민준", "مريم", "Ольга", "大卫", "Çağrı"]) {
      expect(normalizeName(n)).toBe(n.normalize("NFKC"));
    }
  });

  it("caps at 24 characters by what people see, not bytes", () => {
    expect(reason(() => normalizeName("a" + "🐸".repeat(23)))).toBe("OK");
    expect(reason(() => normalizeName("a" + "👨‍👩‍👧".repeat(23)))).toBe("OK"); // 23 family emoji = 23 characters
    expect(reason(() => normalizeName("a" + "🐸".repeat(24)))).not.toBe("OK");
    expect(reason(() => normalizeName("🐸🐸🐸"))).toBe("needs a letter or digit");
    expect(reason(() => normalizeName("a".repeat(25)))).not.toBe("OK");
  });

  it.each([
    ["empty", ""],
    ["only spaces", "    "],
    ["only invisible", "​​"],
    ["only punctuation", "!!!"],
    ["link", "ser https://scam.io"],
    ["bare domain", "claim at drop.xyz"],
    ["telegram link", "t.me/scam"],
    ["discord invite", "discord.gg/abc"],
    ["npc", "NOTHING-9000"],
    ["npc spaced", "Faucet Fren"],
    ["staff", "Block Party Support"],
    ["scam", "Airdrop Claim"],
    ["seed phrase bait", "send seed phrase"],
    ["not a string", { toString: (): string => "x" }],
  ])("rejects %s", (_n, v) => {
    expect(reason(() => normalizeName(v))).not.toBe("OK");
  });

  it.each(["Steve", "Dev", "Badminton Fan", "Ser Anon", "Mayor Pete Fan Club"])("allows %s", (n) => {
    // "Mayor" alone is reserved, but a longer name that merely includes it is fine
    expect(reason(() => normalizeName(n))).toBe("OK");
  });

  it("never throws anything but a ResidentInputError on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 80 }), (s) => {
        try {
          const n = normalizeName(s);
          return n.length > 0 && n === n.trim() && graphemeCount(n) <= 24 && !/[​‮⁠]/.test(n);
        } catch (e) {
          return e instanceof ResidentInputError;
        }
      }),
      { numRuns: 3000 },
    );
  });
});

describe("looks", () => {
  const good = randomLook(seededRandomInt(1));

  it("accepts every random look", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => reason(() => validateLook(randomLook(seededRandomInt(seed)))) === "OK"),
      { numRuns: 1000 },
    );
  });

  it("returns a clean copy, not the caller's object", () => {
    const out = validateLook(good);
    expect(out).toEqual(good);
    expect(out).not.toBe(good);
  });

  it.each([
    ["missing part", (l: Record<string, unknown>) => delete l.hair],
    ["unknown part", (l: Record<string, unknown>) => (l.wings = "wings1")],
    ["unknown option", (l: Record<string, unknown>) => (l.hair = "hair99")],
    ["wrong type", (l: Record<string, unknown>) => (l.face = 1)],
    ["palette out of range", (l: Record<string, unknown>) => (l.skinTone = 10)],
    ["negative palette", (l: Record<string, unknown>) => (l.hairColor = -1)],
    ["fractional palette", (l: Record<string, unknown>) => (l.outfitColor = 1.5)],
    ["NaN palette", (l: Record<string, unknown>) => (l.outfitColor = NaN)],
    ["string palette", (l: Record<string, unknown>) => (l.skinTone = "3")],
    ["bad version", (l: Record<string, unknown>) => (l.v = 2)],
  ])("rejects %s", (_n, mutate) => {
    const l = { ...good } as Record<string, unknown>;
    mutate(l);
    expect(reason(() => validateLook(l))).not.toBe("OK");
  });

  it("rejects prototype pollution and non-plain objects", () => {
    const polluted = JSON.parse(`{"__proto__":{"admin":true},${JSON.stringify(good).slice(1)}`);
    expect(reason(() => validateLook(polluted))).not.toBe("OK");
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(reason(() => validateLook([good]))).not.toBe("OK");
    expect(reason(() => validateLook(null))).not.toBe("OK");
    expect(reason(() => validateLook(Object.assign(Object.create({ evil: 1 }), good)))).not.toBe("OK");
  });

  it("the part catalogue matches the plan's kit size (about 45 to 60 parts)", () => {
    const parts = Object.values(LOOK_PARTS).reduce((a, p) => a + p.filter((x) => x !== "none").length, 0);
    expect(parts).toBeGreaterThanOrEqual(45);
    expect(parts).toBeLessThanOrEqual(60);
  });
});

describe("traits, goal, kit", () => {
  it("needs exactly 3 different known traits, and sorts them", () => {
    expect(validateTraits(["ape", "builder", "lurker"])).toEqual(["ape", "builder", "lurker"]);
    expect(validateTraits(["lurker", "ape", "builder"])).toEqual(["ape", "builder", "lurker"]);
    for (const bad of [[], ["ape"], ["ape", "builder"], ["ape", "builder", "lurker", "roof_rat"], ["ape", "ape", "builder"], ["ape", "builder", "wizard"], ["Ape", "builder", "lurker"], "ape,builder,lurker", null]) {
      expect(reason(() => validateTraits(bad))).not.toBe("OK");
    }
  });

  it("there are 12 traits, as in the plan", () => {
    expect(TRAITS).toHaveLength(12);
  });

  it("goal and kit style come from their lists", () => {
    expect(validateGoal("oracle")).toBe("oracle");
    expect(validateKitStyle("neon")).toBe("neon");
    for (const bad of ["Oracle", "", "whale", null, 1]) expect(reason(() => validateGoal(bad))).not.toBe("OK");
    for (const bad of ["Neon", "gold", null]) expect(reason(() => validateKitStyle(bad))).not.toBe("OK");
  });
});

describe("pick for me", () => {
  it("always produces a valid resident", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => reason(() => validateResidentInput(pickForMe(seededRandomInt(seed)))) === "OK"),
      { numRuns: 3000 },
    );
  });

  it("suggested handles always fit and pass validation", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const h = pickForMe(seededRandomInt(seed)).handle;
        return h.length <= 15 && reason(() => validateHandle(h)) === "OK";
      }),
      { numRuns: 5000 },
    );
  });

  it("is reproducible from a seed", () => {
    expect(pickForMe(seededRandomInt(42))).toEqual(pickForMe(seededRandomInt(42)));
  });
});

describe("the backstory deal", () => {
  it("every backstory has a starter item, and they are all different", () => {
    const items = BACKSTORY_IDS.map((b) => BACKSTORIES[b].starterItem);
    expect(BACKSTORY_IDS).toHaveLength(4);
    expect(new Set(items).size).toBe(4);
    expect(dealBackstory(() => 2)).toEqual({ backstory: BACKSTORY_IDS[2], starterItem: BACKSTORIES[BACKSTORY_IDS[2]!].starterItem });
  });

  it("is fair: 40,000 crypto deals land within 3% of a quarter each", () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 40_000; i++) {
      const { backstory } = dealBackstory(cryptoRandomInt);
      counts[backstory] = (counts[backstory] ?? 0) + 1;
    }
    for (const b of BACKSTORY_IDS) expect(Math.abs(counts[b]! / 40_000 - 0.25)).toBeLessThan(0.03);
  });
});

describe("randomness helpers", () => {
  it("cryptoRandomInt stays in range and rejects bad ranges", () => {
    for (let i = 0; i < 5000; i++) {
      const v = cryptoRandomInt(7);
      expect(Number.isInteger(v) && v >= 0 && v < 7).toBe(true);
    }
    for (const bad of [0, -1, 1.5, 2 ** 33, NaN]) expect(() => cryptoRandomInt(bad)).toThrow(RangeError);
  });

  it("pickDistinct never repeats", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 0, max: 12 }), (seed, k) => {
        const got = pickDistinct(TRAITS, k, seededRandomInt(seed));
        return got.length === k && new Set(got).size === k;
      }),
    );
  });
});

describe("seasons", () => {
  it("are 4 weeks long from the epoch", () => {
    expect(seasonOf("2026-10-04")).toBe(0);
    expect(seasonOf("2026-10-05")).toBe(1);
    expect(seasonOf("2026-11-01")).toBe(1);
    expect(seasonOf("2026-11-02")).toBe(2);
    expect(seasonOf("2027-10-04")).toBe(14);
  });
});
