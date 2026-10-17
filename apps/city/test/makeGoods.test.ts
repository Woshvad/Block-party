import { MAKE_GOOD } from "@bp/core";
import { describe, expect, it } from "vitest";
import type { MakeGood } from "../src/api";
import { collectedLine, makeGoodConfirm, makeGoodProblem, makeGoodToShow, setAsideStore } from "../src/makeGoods";

const now = Date.parse("2026-10-17T12:00:00Z");
const mg = (id: string, closesInHours: number): MakeGood => ({ id, reason: "The city's sorry about the outage.", amount: 100, createdAt: "2026-10-10T12:00:00Z", closesAt: new Date(now + closesInHours * 3_600_000).toISOString() });

describe("the make-good card on Today", () => {
  it("shows the oldest one still open that hasn't been set aside", () => {
    expect(makeGoodToShow(undefined, new Set(), now)).toBeNull();
    expect(makeGoodToShow([], new Set(), now)).toBeNull();
    expect(makeGoodToShow([mg("a", 1), mg("b", 200)], new Set(), now)?.id).toBe("a");
    expect(makeGoodToShow([mg("a", 1), mg("b", 200)], new Set(["a"]), now)?.id).toBe("b");
    expect(makeGoodToShow([mg("a", 0), mg("b", -1)], new Set(), now)).toBeNull(); // closed while the screen was open
  });

  it("says what was collected, and that a retried tap was already paid", () => {
    expect(collectedLine({ amount: 100, already: false })).toBe("+100 GM collected. Thanks for sticking with the city.");
    expect(collectedLine({ amount: 100, already: true })).toBe("Already collected: +100 GM");
  });

  it("set aside with × for the session only, and still works without storage", () => {
    const backing = new Map<string, string>();
    const storage = { getItem: (k: string) => backing.get(k) ?? null, setItem: (k: string, v: string) => void backing.set(k, v) };
    const a = setAsideStore(() => storage);
    expect([...a.ids()]).toEqual([]);
    expect([...a.add("x")]).toEqual(["x"]);
    expect([...setAsideStore(() => storage).ids()]).toEqual(["x"]); // a reload in the same session remembers
    backing.set("bp.makeGoods.setAside", "not json");
    expect([...setAsideStore(() => storage).ids()]).toEqual([]);
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const b = setAsideStore(() => broken);
    expect([...b.add("y")]).toEqual(["y"]);
    expect([...b.ids()]).toEqual(["y"]); // this page load still remembers
    expect([...setAsideStore(() => null).add("z")]).toEqual(["z"]);
  });
});

describe("the staff form", () => {
  it("holds the reason and amount to the API's own rules", () => {
    const reason = "The city's sorry about the outage.";
    expect(makeGoodProblem({ reason, amount: "100" })).toBeNull();
    expect(makeGoodProblem({ reason, amount: String(MAKE_GOOD.max) })).toBeNull();
    expect(makeGoodProblem({ reason: "  oops ", amount: "100" })).toMatch(/at least 5/);
    expect(makeGoodProblem({ reason: "x".repeat(MAKE_GOOD.reasonMaxChars + 1), amount: "100" })).toMatch(/80 characters at most/);
    for (const amount of ["", "0", "201", "1.5", "-3", "1e2", "abc"]) expect(makeGoodProblem({ reason, amount }), amount).toMatch(/whole number of GM, 1 to 200/);
  });

  it("the confirm states the cap and that every resident can collect it, and fits Telegram's dialog", () => {
    const text = makeGoodConfirm({ reason: "x".repeat(MAKE_GOOD.reasonMaxChars), amount: MAKE_GOOD.max });
    expect(text).toContain("Every resident who has moved in can collect it once");
    expect(text).toContain(`The cap is ${MAKE_GOOD.max} GM`);
    expect(text).toContain(`+${MAKE_GOOD.max} GM`);
    expect(text.length).toBeLessThanOrEqual(256);
  });
});
