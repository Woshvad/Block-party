import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FAQ, FAUCET_FREN_FALLBACK, GM, HUNT_TROPHIES, NEVER_SAY, RENT, RIDES, faucetFrenAnswer } from "../src";

// NPCs never mention real trades, wallets, deposits or dollar amounts, and never tell anyone what to call.
const NPC_NEVER = /\b(wallet|deposit|withdraw|usdc|usd|dollars?|real trades?|back it for real|you should (call|bet|pick)|go long|go short)\b|\$/i;

describe("Faucet Fren", () => {
  it("no answer breaks the NPC rules or the push rules' money words", () => {
    for (const f of [...FAQ, { id: "fallback", keywords: [], answer: FAUCET_FREN_FALLBACK }]) {
      expect(f.answer, f.id).not.toMatch(NPC_NEVER);
      expect(NEVER_SAY.test(f.answer.replace(/\bburn(ed|s)?\b/g, "")), f.id).toBe(false);
    }
  });

  it("ids are unique, and every entry answers a natural question about its first keyword", () => {
    expect(new Set(FAQ.map((f) => f.id)).size).toBe(FAQ.length);
    for (const f of FAQ) expect(faucetFrenAnswer(`hey fren, how does ${f.keywords[0]} work?`).id, f.keywords[0]).toBe(f.id);
  });

  it("real questions land on the right answer", () => {
    const cases: Array<[string, string]> = [
      ["Will an admin ever ask for my seed phrase??", "safety"],
      ["how much is RENT", "rent"],
      ["i'm rekt, what now", "moods"],
      ["what's a Hodl Day", "streak"],
      ["how do I get Proof of Neighbour", "pon"],
      ["too many pings, how do I stop them", "pings"],
      ["can I take the bus to the tower", "rides"],
      ["what happens at the halving", "halving"],
      ["someone keeps harassing me", "block"],
      ["gm fren, how much is rent?", "rent"],
      ["hey ser what's a nap for", "nap"],
      ["gm", "gm"],
      ["what is gm", "gm"],
      ["how do I add frens", "frens"],
      ["where is today's clue hidden?", "hunt"],
      ["how does the daily clue hunt work", "hunt"],
    ];
    for (const [q, id] of cases) expect(faucetFrenAnswer(q).id, q).toBe(id);
  });

  it("numbers come from the game's constants", () => {
    expect(faucetFrenAnswer("rent").answer).toContain(String(RENT.tenement));
    expect(faucetFrenAnswer("drip").answer).toContain(`${GM.drip} GM`);
    expect(faucetFrenAnswer("rollup").answer).toContain(`${RIDES.rollup.fare} GM`);
    expect(faucetFrenAnswer("clue").answer).toContain(`${HUNT_TROPHIES[1]!.finds} finds bring ${HUNT_TROPHIES[1]!.name}`);
  });

  it("anything else gets the fallback; nothing ever throws", () => {
    for (const q of [null, undefined, 5, {}, "", "   ", "🍔🍔", "x".repeat(100_000), "wen moon", "gmgmgm"]) expect(faucetFrenAnswer(q).id).toBeNull();
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (s) => {
        const r = faucetFrenAnswer(s);
        expect(typeof r.answer).toBe("string");
      }),
      { seed: 21, numRuns: 3000 },
    );
  });
});
