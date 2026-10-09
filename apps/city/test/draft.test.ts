import { pickForMe, seededRandomInt, validateResidentInput } from "@bp/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Look, ResidentDraft } from "../src/api";
import { LOOK_PALETTES, LOOK_PARTS, TRAITS, cycle, fieldErrors, latestOnly, stepLook, toggleTrait } from "../src/draft";

const SEED = { seed: 20261009 };
const draft = (seed: number) => pickForMe(seededRandomInt(seed)) as unknown as ResidentDraft;

describe("fieldErrors agrees with the API's own check", () => {
  it("a picked-for-me resident has no errors", () => {
    fc.assert(
      fc.property(fc.integer(), (s) => Object.keys(fieldErrors(draft(s))).length === 0),
      { ...SEED, numRuns: 300 },
    );
  });

  it("flags exactly what the server would refuse", () => {
    const keys = ["handle", "name", "goal", "kitStyle", "traits", "look"] as const;
    fc.assert(
      fc.property(fc.integer(), fc.constantFrom(...keys), fc.anything(), (s, k, junk) => {
        const d = { ...draft(s), [k]: junk } as ResidentDraft;
        const errs = fieldErrors(d);
        let serverOk = true;
        try {
          validateResidentInput(d);
        } catch {
          serverOk = false;
        }
        return serverOk === (Object.keys(errs).length === 0);
      }),
      { ...SEED, numRuns: 2000 },
    );
  });

  it("names the field", () => {
    expect(Object.keys(fieldErrors({ ...draft(1), handle: "a" }))).toEqual(["handle"]);
    expect(Object.keys(fieldErrors({ ...draft(1), traits: ["ape"] }))).toEqual(["traits"]);
  });
});

describe("traits", () => {
  it("never holds more than 3 or a duplicate, whatever is tapped", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...TRAITS), { maxLength: 40 }), (taps) => {
        let t: string[] = [];
        for (const x of taps) {
          t = toggleTrait(t, x);
          if (t.length > 3 || new Set(t).size !== t.length) return false;
        }
        return true;
      }),
      SEED,
    );
  });

  it("tapping twice undoes", () => {
    expect(toggleTrait(toggleTrait([], "ape"), "ape")).toEqual([]);
  });
});

describe("look arrows", () => {
  it("wrap both ways", () => {
    expect(cycle(["a", "b", "c"], "c", 1)).toBe("a");
    expect(cycle(["a", "b", "c"], "a", -1)).toBe("c");
    expect(cycle(["a", "b"], "zzz" as string, 1)).toBe("a");
  });

  it("every press of every arrow keeps a look the server accepts", () => {
    const parts = [...Object.keys(LOOK_PARTS), ...Object.keys(LOOK_PALETTES)] as (keyof typeof LOOK_PARTS)[];
    fc.assert(
      fc.property(fc.integer(), fc.array(fc.tuple(fc.constantFrom(...parts), fc.constantFrom(1 as const, -1 as const)), { maxLength: 60 }), (s, presses) => {
        let look = draft(s).look as Look;
        for (const [p, dir] of presses) look = stepLook(look, p, dir);
        return Object.keys(fieldErrors({ ...draft(s), look })).length === 0;
      }),
      { ...SEED, numRuns: 300 },
    );
  });

  it("going forward n times then back n times returns home", () => {
    const start = draft(3).look as Look;
    let l = start;
    for (let i = 0; i < 17; i++) l = stepLook(l, "hair", 1);
    for (let i = 0; i < 17; i++) l = stepLook(l, "hair", -1);
    expect(l).toEqual(start);
  });
});

describe("latestOnly", () => {
  it("only the newest request may land", () => {
    const l = latestOnly();
    const a = l.begin();
    const b = l.begin();
    expect(a()).toBe(false);
    expect(b()).toBe(true);
  });
});
