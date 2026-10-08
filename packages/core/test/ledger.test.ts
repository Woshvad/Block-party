import { describe, expect, it } from "vitest";
import { LedgerError, MAX_LEG_AMOUNT, postingHash, validateLegs } from "../src";

const code = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return (e as LedgerError).code;
  }
  return "OK";
};

describe("validateLegs", () => {
  it("accepts a balanced two-leg posting", () => {
    expect(code(() => validateLegs([{ accountId: "a", amount: -5 }, { accountId: "b", amount: 5 }]))).toBe("OK");
  });

  it("accepts a balanced multi-leg posting", () => {
    const legs = [
      { accountId: "pot", amount: -40 },
      { accountId: "winner", amount: 30 },
      { accountId: "sys:burn", amount: 10 },
    ];
    expect(code(() => validateLegs(legs))).toBe("OK");
  });

  it.each([
    ["single leg", [{ accountId: "a", amount: 0 }]],
    ["no legs", []],
    ["unbalanced", [{ accountId: "a", amount: -5 }, { accountId: "b", amount: 6 }]],
    ["zero amount", [{ accountId: "a", amount: 0 }, { accountId: "b", amount: 0 }]],
    ["fractional", [{ accountId: "a", amount: -0.5 }, { accountId: "b", amount: 0.5 }]],
    ["NaN", [{ accountId: "a", amount: NaN }, { accountId: "b", amount: NaN }]],
    ["duplicate account", [{ accountId: "a", amount: -5 }, { accountId: "a", amount: 5 }]],
    ["empty account id", [{ accountId: "", amount: -5 }, { accountId: "b", amount: 5 }]],
    ["too large", [{ accountId: "a", amount: -(MAX_LEG_AMOUNT + 1) }, { accountId: "b", amount: MAX_LEG_AMOUNT + 1 }]],
  ])("rejects %s", (_name, legs) => {
    expect(code(() => validateLegs(legs))).toBe("INVALID_LEGS");
  });
});

describe("postingHash", () => {
  it("ignores leg order", async () => {
    const a = await postingHash("drip", [{ accountId: "x", amount: -1 }, { accountId: "y", amount: 1 }]);
    const b = await postingHash("drip", [{ accountId: "y", amount: 1 }, { accountId: "x", amount: -1 }]);
    expect(a).toBe(b);
  });

  it("changes with kind or amount", async () => {
    const base = await postingHash("drip", [{ accountId: "x", amount: -1 }, { accountId: "y", amount: 1 }]);
    expect(await postingHash("shift", [{ accountId: "x", amount: -1 }, { accountId: "y", amount: 1 }])).not.toBe(base);
    expect(await postingHash("drip", [{ accountId: "x", amount: -2 }, { accountId: "y", amount: 2 }])).not.toBe(base);
  });
});
