import { describe, expect, it } from "vitest";
import { CAST, HASH_BROWN_ALPHA, NEVER_SAY, NPC_IDS, NPC_LINES, contrarianCall, npcById, npcLine, nothingCall } from "../src";

const NPC_NEVER = /\b(wallet|deposit|withdraw|usdc|usd|dollars?|real trades?|back it for real|buy|sell|you should|go long|go short)\b|\$/i;

describe("the cast", () => {
  it("fixed, distinct, labelled ids", () => {
    expect(new Set(NPC_IDS).size).toBe(4);
    for (const c of Object.values(CAST)) expect(c.label).toBe("NPC · AI");
    expect(npcById(CAST.contrarian.id)).toBe("contrarian");
    expect(npcById("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("NOTHING-9000 says NO to everything it can", () => {
    expect(nothingCall(50)).toEqual({ side: "no", chance: 40 });
    expect(nothingCall(5)).toEqual({ side: "no", chance: 1 });
    expect(nothingCall(1)).toBeNull();
  });

  it("the Contrarian goes against the city, or against the world's favourite when nobody's called", () => {
    expect(contrarianCall(40, 10, 3)).toEqual({ side: "no", chance: 30 });
    expect(contrarianCall(40, 2, 9)).toEqual({ side: "yes", chance: 50 });
    expect(contrarianCall(40, 5, 5)).toEqual({ side: "no", chance: 30 }); // a tie leans YES, so NO
    expect(contrarianCall(70, 0, 0)).toEqual({ side: "no", chance: 60 });
    expect(contrarianCall(20, 0, 0)).toEqual({ side: "yes", chance: 30 });
    expect(contrarianCall(99, 0, 9)).toBeNull();
    expect(contrarianCall(1, 9, 0)).toBeNull();
  });

  it("every line and every bit of alpha keeps to the NPC rules", () => {
    for (const lines of Object.values(NPC_LINES)) for (const l of Object.values(lines)) {
      expect(l).not.toMatch(NPC_NEVER);
      expect(NEVER_SAY.test(l)).toBe(false);
    }
    for (const a of HASH_BROWN_ALPHA) expect(a).not.toMatch(NPC_NEVER);
    expect(npcLine("faucet_fren", "streak", { streak: 12 })).toContain("day 12");
    expect(() => npcLine("hash_brown", "nope")).toThrow();
  });
});
