import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CREW,
  CrewInputError,
  type CrewRole,
  DEFAULT_BANNER,
  can,
  addDays,
  chainHolds,
  chainLength,
  chainThreshold,
  crewNameKey,
  crewStatus,
  invitePreApproved,
  validateBanner,
  validateCrewName,
  validateJoinPolicy,
} from "../src";

const reason = (fn: () => unknown) => {
  try {
    fn();
    return "OK";
  } catch (e) {
    if (e instanceof CrewInputError) return e.reason;
    throw e;
  }
};

describe("crew names", () => {
  it("accepts and cleans normal names", () => {
    expect(validateCrewName("  Roof   Rats ")).toBe("Roof Rats");
    expect(validateCrewName("Los Degens 🐸")).toBe("Los Degens 🐸");
    expect(validateCrewName("김치 크루")).toBe("김치 크루");
  });

  it.each([
    ["too short", "ab"],
    ["too long", "a".repeat(25)],
    ["impersonates the city", "Block Party Official"],
    ["impersonates an NPC", "NOTHING 9000"],
    ["scam bait", "Free Airdrop Crew"],
    ["link", "join t.me/x"],
    ["invisible tricks", "​​"],
    ["not a string", 7],
  ])("rejects %s", (_n, v) => {
    expect(reason(() => validateCrewName(v))).not.toBe("OK");
  });

  it("name keys ignore case, spacing, accents and punctuation", () => {
    expect(crewNameKey("Roof Rats")).toBe(crewNameKey("roof-rats"));
    expect(crewNameKey("Roof Rats")).toBe(crewNameKey("ROOFRATS"));
    expect(crewNameKey("Café Crew")).toBe(crewNameKey("Cafe crew"));
    expect(crewNameKey("Roof Rats")).not.toBe(crewNameKey("Roof Rat"));
  });
});

describe("banner and policy", () => {
  it("banner is 8 rows of 16 tiles", () => {
    expect(validateBanner(DEFAULT_BANNER)).toEqual(DEFAULT_BANNER);
    const art = Array.from({ length: 8 }, (_, i) => "0123456789abcdef".slice(i) + "0".repeat(i));
    expect(reason(() => validateBanner(art))).toBe("OK");
    for (const bad of [[], DEFAULT_BANNER.slice(1), [...DEFAULT_BANNER, "0".repeat(16)], DEFAULT_BANNER.map((r, i) => (i ? r : r + "0")), DEFAULT_BANNER.map((r, i) => (i ? r : "g".repeat(16))), DEFAULT_BANNER.map((r, i) => (i ? r : "A".repeat(16))), "0".repeat(128), null]) {
      expect(reason(() => validateBanner(bad))).not.toBe("OK");
    }
  });

  it("join policy is approval or open", () => {
    expect(validateJoinPolicy("open")).toBe("open");
    for (const bad of ["Open", "closed", "", null]) expect(reason(() => validateJoinPolicy(bad))).not.toBe("OK");
  });
});

describe("permissions", () => {
  const roles: CrewRole[] = ["lead", "deputy", "member"];

  it("matches the plan's lead tools", () => {
    expect(can("lead", "approve_join")).toBe(true);
    expect(can("deputy", "approve_join")).toBe(true);
    expect(can("member", "approve_join")).toBe(false);
    expect(can("member", "invite")).toBe(true);
    expect(can("deputy", "set_deputy")).toBe(false);
    expect(can("deputy", "dissolve")).toBe(false);
    expect(can("lead", "dissolve")).toBe(true);
  });

  it("removal: strictly downward, and never the lead", () => {
    const table = roles.flatMap((a) => roles.map((t) => `${a}>${t}:${can(a, "remove", t)}`));
    expect(table).toEqual([
      "lead>lead:false",
      "lead>deputy:true",
      "lead>member:true",
      "deputy>lead:false",
      "deputy>deputy:false",
      "deputy>member:true",
      "member>lead:false",
      "member>deputy:false",
      "member>member:false",
    ]);
    expect(can("lead", "remove")).toBe(false); // no target, no removal
  });

  it("only lead and deputy invites skip approval", () => {
    expect(roles.map(invitePreApproved)).toEqual([true, true, false]);
  });

  it("a crew is forming until 3 members", () => {
    expect([0, 1, 2, 3, 50].map(crewStatus)).toEqual(["forming", "forming", "forming", "active", "active"]);
  });
});

describe("gm chain threshold", () => {
  it("is 60% of active members, at least 3", () => {
    const expected: Record<number, number> = { 0: 3, 1: 3, 3: 3, 5: 3, 6: 4, 10: 6, 15: 9, 20: 12, 25: 15, 35: 21, 50: 30 };
    for (const [a, t] of Object.entries(expected)) expect(chainThreshold(Number(a))).toBe(t);
  });

  it("matches exact integer math for every crew size", () => {
    for (let a = 0; a <= CREW.maxMembers; a++) {
      const exact = Math.max(3, Math.ceil((a * 3) / 5)); // 60% as an exact fraction
      const viaInts = Math.max(3, Math.floor((a * 3 + 4) / 5));
      expect(chainThreshold(a)).toBe(exact);
      expect(chainThreshold(a)).toBe(viaInts);
    }
  });

  it("holds exactly at the threshold, not one below", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 }), (a) => chainHolds(a, chainThreshold(a)) && !chainHolds(a, chainThreshold(a) - 1)),
    );
  });
});

describe("gm chain length", () => {
  const T = "2026-10-20";
  const day = (back: number) => addDays(T, -back);
  const H = (back: number) => ({ day: day(back), held: true, relit: false });
  const MISS = (back: number) => ({ day: day(back), held: false, relit: false });
  const RELIT = (back: number) => ({ day: day(back), held: false, relit: true });

  it("counts consecutive held days up to yesterday", () => {
    expect(chainLength([H(1), H(2), H(3)], T)).toEqual({ length: 3, needsRelight: null });
  });

  it("a miss more than a day ago breaks it", () => {
    expect(chainLength([H(1), H(2), MISS(3), H(4), H(5)], T)).toEqual({ length: 2, needsRelight: null });
  });

  it("yesterday's miss is still relightable and shows the chain it would save", () => {
    expect(chainLength([MISS(1), H(2), H(3)], T)).toEqual({ length: 2, needsRelight: day(1) });
  });

  it("a relit day bridges without counting", () => {
    expect(chainLength([H(1), RELIT(2), H(3), H(4)], T)).toEqual({ length: 3, needsRelight: null });
  });

  it("a gap in settled days ends the chain (the crew didn't exist or was never settled)", () => {
    expect(chainLength([H(1), H(2), H(4), H(5)], T)).toEqual({ length: 2, needsRelight: null });
  });

  it("today and the future are ignored; nothing settled means 0", () => {
    expect(chainLength([{ day: T, held: true, relit: false }, H(1)], T)).toEqual({ length: 1, needsRelight: null });
    expect(chainLength([], T)).toEqual({ length: 0, needsRelight: null });
    expect(chainLength([H(2), H(3)], T)).toEqual({ length: 0, needsRelight: null }); // yesterday unsettled
  });

  it("input order doesn't matter", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("H", "M", "R"), { maxLength: 40 }), fc.integer(), (kinds, seed) => {
        const days = kinds.map((k, i) => ({ day: day(i + 1), held: k === "H", relit: k === "R" }));
        const shuffled = [...days].sort(() => ((seed = (seed * 9301 + 49297) % 233280) / 233280) - 0.5);
        const a = chainLength(days, T);
        const b = chainLength(shuffled, T);
        return a.length === b.length && a.needsRelight === b.needsRelight && a.length <= kinds.filter((k) => k === "H").length;
      }),
    );
  });
});
