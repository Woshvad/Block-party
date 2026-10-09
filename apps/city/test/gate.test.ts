import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GATE_WORDS } from "../src/gate";

describe("gate words", () => {
  it("explain every reason the API's gate can give, and nothing else", () => {
    const src = readFileSync(new URL("../../../packages/core/src/real-money.ts", import.meta.url), "utf8");
    const union = src.slice(src.indexOf("export type GateReason"), src.indexOf(";", src.indexOf("export type GateReason")));
    const reasons = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).sort();
    expect(reasons.length).toBeGreaterThan(10);
    expect(Object.keys(GATE_WORDS).sort()).toEqual(reasons);
  });
});
