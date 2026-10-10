import { describe, expect, it } from "vitest";
import { type GammaEvent, polymarketProvider, toFeedMarkets } from "../src/polymarket";

const now = new Date("2026-10-10T12:00:00Z");
const m = (id: string, yes: string, extra: Record<string, unknown> = {}) => ({ id, question: `Q${id}?`, outcomes: '["Yes", "No"]', outcomePrices: `["${yes}", "0"]`, endDate: "2026-10-12T04:00:00Z", closed: false, acceptingOrders: true, ...extra });

describe("Polymarket feed mapping", () => {
  it("maps a single market: whole-percent YES price, freezes at settlement", () => {
    const [f] = toFeedMarkets([{ slug: "e", markets: [m("1", "0.534")] }], "crypto", now);
    expect(f).toMatchObject({ externalId: "pm:1", question: "Q1?", category: "crypto", ladder: null, price: 53, resolved: null, voided: false });
    expect(f!.freezesAt.toISOString()).toBe("2026-10-12T04:00:00.000Z");
  });

  it("treats a multi-market event as a ladder that freezes an hour early", () => {
    const fs = toFeedMarkets([{ slug: "btc-above-oct-10", markets: [m("1", "0.4"), m("2", "0.7")] }], "crypto", now);
    expect(fs.map((f) => f.ladder)).toEqual(["btc-above-oct-10", "btc-above-oct-10"]);
    expect(fs[0]!.freezesAt.toISOString()).toBe("2026-10-12T03:00:00.000Z");
  });

  it("freezes sports at kickoff", () => {
    const [f] = toFeedMarkets([{ slug: "g", markets: [m("1", "0.5", { gameStartTime: "2026-10-11T19:00:00Z" })] }], "sports", now);
    expect(f!.freezesAt.toISOString()).toBe("2026-10-11T19:00:00.000Z");
  });

  it("skips closed, not trading, already frozen, extreme, non-YES/NO and junk markets", () => {
    const events: GammaEvent[] = [
      {
        slug: "e",
        markets: [
          m("closed", "0.5", { closed: true }),
          m("paused", "0.5", { acceptingOrders: false }),
          m("frozen", "0.5", { endDate: "2026-10-10T11:00:00Z" }),
          m("sure", "0.995"),
          m("never", "0.01"),
          m("multi", "0.5", { outcomes: '["A", "B"]' }),
          m("junk", "abc"),
          m("badjson", "0.5", { outcomePrices: "nope" }),
          m("nodate", "0.5", { endDate: undefined }),
          m("ok", "0.5"),
        ],
      },
    ];
    expect(toFeedMarkets(events, "other", now, { perLadder: 99 }).map((f) => f.externalId)).toEqual(["pm:ok"]);
  });

  it("caps markets per category", () => {
    const events = Array.from({ length: 30 }, (_, i) => ({ slug: `e${i}`, markets: [m(String(i), "0.5")] }));
    expect(toFeedMarkets(events, "culture", now, { perCategory: 5 })).toHaveLength(5);
  });

  it("keeps only a ladder's rungs nearest 50/50", () => {
    const markets = ["0.05", "0.2", "0.45", "0.55", "0.7", "0.9"].map((p, i) => m(String(i), p));
    expect(toFeedMarkets([{ slug: "e", markets }], "culture", now).map((f) => f.price).sort()).toEqual([45, 55, 70]);
  });
});

describe("Polymarket provider", () => {
  const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

  it("asks once per category tag and keeps each market once", async () => {
    const urls: string[] = [];
    const p = polymarketProvider({ fetch: (u) => (urls.push(u), ok([{ slug: "e", markets: [m("1", "0.5")] }])) });
    const fs = await p.fetch(now);
    expect(urls.map((u) => new URL(u).searchParams.get("tag_slug")).sort()).toEqual(["crypto", "politics", "pop-culture", "sports"]);
    expect(fs.map((f) => f.externalId)).toEqual(["pm:1"]);
    expect(p.source).toBe("polymarket");
  });

  it("skips a failed category but throws when the whole feed is down", async () => {
    let n = 0;
    const some = polymarketProvider({ fetch: () => (n++ === 0 ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) }) : ok([{ slug: "e", markets: [m(String(n), "0.5")] }])) });
    expect((await some.fetch(now)).length).toBe(3);
    const down = polymarketProvider({ fetch: () => Promise.reject(new Error("offline")) });
    await expect(down.fetch(now)).rejects.toThrow(/every category/);
  });
});
