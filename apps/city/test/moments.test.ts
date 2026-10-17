import { EMOTES, type TowerMoment } from "@bp/core";
import { describe, expect, it } from "vitest";
import { MOMENT_REACTIONS, fading, momentBoard, momentDetail, momentHeadline, momentLine } from "../src/moments";

const base = { marketId: "0b7e8c1a-3f2d-4c5b-9a8e-7d6c5b4a3f2e", question: "Will Lagos FC win?", at: 1 };
const up: TowerMoment = { ...base, id: "a", kind: "swing", from: 41, to: 63 };
const down: TowerMoment = { ...base, id: "b", kind: "swing", from: 63, to: 41 };
const yes: TowerMoment = { ...base, id: "c", kind: "settled", outcome: "yes", from: 34 };
const no: TowerMoment = { ...base, id: "d", kind: "settled", outcome: "no" };

describe("what a moment says", () => {
  it("a swing says which way and by how much; a result says how it settled", () => {
    expect(momentHeadline(up)).toBe("Jumped 41% → 63%");
    expect(momentHeadline(down)).toBe("Dropped 63% → 41%");
    expect(momentHeadline(yes)).toBe("Settled: YES");
    expect(momentHeadline(no)).toBe("Settled: NO");
    expect(momentDetail(yes)).toBe("It's final. The Tower had it at 34%.");
    expect(momentDetail(no)).toBe("It's final.");
    expect(momentDetail(up)).toBe("Chance of YES, in the last half hour.");
  });

  it("in one line, for the stack under the card", () => {
    expect(momentLine(up)).toBe("Tower · Will Lagos FC win? jumped 41% → 63%");
    expect(momentLine(no)).toBe("Tower · Will Lagos FC win? settled NO");
  });

  it("on the big screen: the question, then the move, with the feed's credit", () => {
    expect(momentBoard(up, "Odds via Polymarket · Not affiliated")).toEqual({
      title: "TOWER · BIG SWING",
      rows: [{ left: "Will Lagos FC win?", tone: "plain" }, { left: "" }, { left: "Jumped 41% → 63%", tone: "plain" }],
      foot: "Odds via Polymarket · Not affiliated",
    });
    const long = momentBoard({ ...yes, question: "Will the home side come back from two goals down and win the cup final tonight in Lagos?" }, null);
    expect(long.title).toBe("TOWER · SETTLED");
    expect(long.rows.length).toBeLessThanOrEqual(5); // at most 3 lines of question
    expect(long.rows.every((r) => r.left.length <= 34)).toBe(true);
    expect(long.foot).toBeUndefined();
  });

  it("reactions are the room's own emotes, so nothing new goes to the server", () => {
    for (const list of Object.values(MOMENT_REACTIONS)) {
      expect(list.length).toBeGreaterThan(0);
      for (const e of list) expect(EMOTES).toContain(e);
    }
  });

  it("the card starts fading just before the 2 minutes are up", () => {
    expect(fading({ until: 10_000 }, 5_000)).toBe(false);
    expect(fading({ until: 10_000 }, 9_000)).toBe(true);
  });
});
