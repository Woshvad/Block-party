import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type GammaEvent, type GammaMarket, closedOutcome, knownToLookUp, noSkips, polymarketProvider, toFeedMarkets } from "../src/polymarket";
import type { KnownMarket } from "../src/tower";

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

// Real Gamma payloads, recorded 2026-10-11 around 18:47 UTC and trimmed to the
// fields we read: the crypto and sports listings (/events?tag_slug=...), and
// /markets?closed=true&id=... for a market that resolved YES, one that
// resolved NO, a cancelled fight paid out 50/50, and one closed with its
// result still "proposed".
const fixture = <T,>(name: string): T => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8")) as T;
const crypto = fixture<GammaEvent[]>("gamma-events-crypto.json");
const sports = fixture<GammaEvent[]>("gamma-events-sports.json");
const resolvedYes = fixture<GammaMarket[]>("gamma-market-resolved-yes.json")[0]!;
const resolvedNo = fixture<GammaMarket[]>("gamma-market-resolved-no.json")[0]!;
const voided = fixture<GammaMarket[]>("gamma-market-void.json")[0]!;
const proposed = fixture<GammaMarket[]>("gamma-market-proposed.json")[0]!;
const recordedAt = new Date("2026-10-11T19:00:00Z");

describe("recorded Gamma listings", () => {
  it("maps the live crypto listing: ladders keep their rungs nearest 50/50, closed rungs and extremes are skipped", () => {
    const skipped = noSkips();
    const fs = toFeedMarkets(crypto, "crypto", recordedAt, { skipped });
    expect(fs.map((f) => [f.externalId, f.price, f.ladder])).toEqual([
      ["pm:5330080", 46, "bitcoin-above-on-october-12-2026"],
      ["pm:5330077", 95, "bitcoin-above-on-october-12-2026"],
      ["pm:5330083", 5, "bitcoin-above-on-october-12-2026"],
      ["pm:1163699", 5, null],
      ["pm:5170738", 54, "what-price-will-bitcoin-hit-in-october-2026"],
      ["pm:5170735", 57, "what-price-will-bitcoin-hit-in-october-2026"],
      ["pm:5170734", 39, "what-price-will-bitcoin-hit-in-october-2026"],
    ]);
    expect(fs[0]!.freezesAt.toISOString()).toBe("2026-10-12T15:00:00.000Z"); // an hour before it settles
    expect(fs.every((f) => f.resolved === null && !f.voided && !f.closed)).toBe(true);
    // "Will Bitcoin reach $85,000 in October?" already closed YES inside its open event.
    expect(skipped).toMatchObject({ closed: 1, extreme: 2, unreadable: 0 });
  });

  it("maps the live sports listing: freezes at kickoff, skips team-name outcomes and unpriced placeholders", () => {
    const skipped = noSkips();
    const fs = toFeedMarkets(sports, "sports", recordedAt, { skipped });
    expect(fs.map((f) => [f.externalId, f.price, f.freezesAt.toISOString()])).toEqual([["pm:5304665", 34, "2026-10-11T20:25:00.000Z"]]);
    expect(skipped).toMatchObject({ notYesNo: 1, unpriced: 1, extreme: 1, unreadable: 0 });
  });
});

describe("what a closed market came to", () => {
  it("reads recorded results: YES, NO, a 50/50 void, and a result still proposed (frozen, waiting)", () => {
    expect(closedOutcome(resolvedYes)).toEqual({ resolved: true, voided: false, closed: true });
    expect(closedOutcome(resolvedNo)).toEqual({ resolved: false, voided: false, closed: true });
    expect(closedOutcome(voided)).toEqual({ resolved: null, voided: true, closed: true });
    // Paid ["0","1"] but UMA still says "proposed": not final, so we wait.
    expect(closedOutcome(proposed)).toEqual({ resolved: null, voided: false, closed: true });
    // The closed rung inside the live listing resolved YES.
    const rung = crypto.flatMap((e) => e.markets ?? []).find((m) => m.id === "5170736")!;
    expect(closedOutcome(rung)).toMatchObject({ resolved: true });
  });

  it("says nothing about a market still trading, or one it can't read; a disputed or odd payout waits", () => {
    const open = crypto[0]!.markets![2]!;
    expect(closedOutcome(open)).toBeNull();
    expect(closedOutcome({ ...resolvedYes, outcomes: '["A", "B"]' })).toBeNull();
    expect(closedOutcome({ ...resolvedYes, outcomePrices: "nope" })).toBeNull();
    expect(closedOutcome({ ...resolvedYes, umaResolutionStatus: "disputed" })).toEqual({ resolved: null, voided: false, closed: true });
    expect(closedOutcome({ ...resolvedYes, umaResolutionStatus: undefined })).toEqual({ resolved: null, voided: false, closed: true });
    expect(closedOutcome({ ...resolvedYes, outcomePrices: '["0.9995", "0.0005"]' })).toEqual({ resolved: null, voided: false, closed: true });
  });
});

describe("Polymarket provider on recorded payloads", () => {
  const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  const closedById = new Map([resolvedYes, resolvedNo, voided, proposed].map((m) => [m.id, m]));
  // Gamma as recorded: the listing per tag, and /markets?closed=true&id=...
  // answering with just the requested markets that are closed.
  function gamma(opts: { listing?: Record<string, unknown>; urls?: string[]; lookup?: (ids: string[]) => ReturnType<typeof ok> } = {}) {
    return (url: string) => {
      opts.urls?.push(url);
      const u = new URL(url);
      if (u.pathname === "/events") return ok((opts.listing ?? { crypto, sports })[u.searchParams.get("tag_slug")!] ?? []);
      const ids = u.searchParams.getAll("id");
      if (opts.lookup) return opts.lookup(ids);
      return ok(ids.flatMap((id) => (closedById.has(id) ? [closedById.get(id)!] : [])));
    };
  }
  const known = (id: string, over: Partial<KnownMarket> = {}): KnownMarket => ({
    externalId: `pm:${id}`,
    question: `Stored ${id}?`,
    category: "sports",
    ladder: null,
    freezesAt: new Date("2026-10-11T12:30:00Z"),
    settlesBy: new Date("2026-10-11T14:00:00Z"),
    price: 40,
    ...over,
  });

  it("looks up the markets we hold among Gamma's closed ones and reports what each came to", async () => {
    const urls: string[] = [];
    const p = polymarketProvider({ fetch: gamma({ urls }), log: () => {} });
    const fs = await p.fetch(recordedAt, [known("5046295"), known("5551089"), known("4266840"), known("5227663"), known("5330080")]);
    const byId = new Map(fs.map((f) => [f.externalId, f]));
    // What we stored stays as stored; only the result is new.
    expect(byId.get("pm:5046295")).toMatchObject({ question: "Stored 5046295?", price: 40, resolved: true, voided: false, closed: true });
    expect(byId.get("pm:5551089")).toMatchObject({ resolved: false, voided: false });
    expect(byId.get("pm:4266840")).toMatchObject({ resolved: null, voided: true });
    expect(byId.get("pm:5227663")).toMatchObject({ resolved: null, voided: false, closed: true });
    // Still trading: the listing carries it, open, at its live price.
    expect(byId.get("pm:5330080")).toMatchObject({ price: 46, resolved: null, voided: false });
    expect(byId.get("pm:5330080")!.closed).toBeUndefined();
    const lookups = urls.filter((u) => new URL(u).pathname === "/markets").map((u) => new URL(u));
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.searchParams.get("closed")).toBe("true");
    expect(lookups[0]!.searchParams.getAll("id")).toEqual(["5046295", "5551089", "4266840", "5227663", "5330080"]);
  });

  it("puts the poll's time in every address, so Gamma's 5-minute cache can't serve an old answer", async () => {
    const urls: string[] = [];
    const p = polymarketProvider({ fetch: gamma({ urls }), log: () => {} });
    await p.fetch(recordedAt, [known("5046295"), known("5330080", { live: true })]);
    const later = new Date(recordedAt.getTime() + 60_000);
    await p.fetch(later, [known("5046295"), known("5330080", { live: true })]);
    const polls = urls.map((u) => new URL(u).searchParams.get("poll"));
    // The listing, the closed lookup and the live lookup, both polls.
    expect(new Set(urls.map((u) => `${new URL(u).pathname}?closed=${new URL(u).searchParams.get("closed")}`)).size).toBe(3);
    expect(polls.every((t) => t === String(recordedAt.getTime()) || t === String(later.getTime()))).toBe(true);
    expect(polls.filter((t) => t === String(later.getTime()))).toHaveLength(urls.length / 2);
  });

  it("a market's result wins over a stale listing of it; nothing known means no lookup", async () => {
    const urls: string[] = [];
    const p = polymarketProvider({ fetch: gamma({ urls, lookup: (ids) => ok(ids.includes("5330080") ? [{ ...resolvedYes, id: "5330080" }] : []) }), log: () => {} });
    const fs = await p.fetch(recordedAt, [known("5330080")]);
    expect(fs.filter((f) => f.externalId === "pm:5330080")).toEqual([expect.objectContaining({ resolved: true, price: 40 })]);
    urls.length = 0;
    await p.fetch(recordedAt);
    expect(urls.every((u) => new URL(u).pathname === "/events")).toBe(true);
  });

  it("looks up 100 ids a request, at most 500 a poll, and says when it stops short", async () => {
    const urls: string[] = [];
    const lines: string[] = [];
    const p = polymarketProvider({ fetch: gamma({ urls }), log: (l) => lines.push(l) });
    await p.fetch(recordedAt, Array.from({ length: 250 }, (_, i) => known(String(i + 1))));
    const sizes = () => urls.filter((u) => new URL(u).pathname === "/markets").map((u) => new URL(u).searchParams.getAll("id").length);
    expect(sizes()).toEqual([100, 100, 50]);
    expect(lines).toEqual([]);
    urls.length = 0;
    await p.fetch(recordedAt, Array.from({ length: 640 }, (_, i) => known(String(i + 1))));
    expect(sizes()).toEqual([100, 100, 100, 100, 100]);
    expect(lines).toEqual(["polymarket: 640 known markets, looking up 500 this poll"]);
  });

  it("past 500, what something rides on is always looked up, and the rest take turns", () => {
    // 600 markets that never resolve, frozen first, then 100 newer ones
    // nobody called and 5 with calls on them, all freezing later.
    const stuck = Array.from({ length: 600 }, (_, i) => known(`s${i}`));
    const fresh = Array.from({ length: 100 }, (_, i) => known(`f${i}`));
    const called = Array.from({ length: 5 }, (_, i) => known(`c${i}`, { held: true }));
    const all = [...stuck, ...fresh, ...called];
    const asked = new Set<string>();
    for (let minute = 0; minute < 3; minute++) {
      const poll = knownToLookUp(all, new Date(recordedAt.getTime() + minute * 60_000));
      expect(poll).toHaveLength(500);
      expect(poll.slice(0, 5).map((k) => k.externalId)).toEqual(called.map((k) => k.externalId)); // every poll, first
      for (const k of poll) asked.add(k.externalId);
    }
    // Within a few minutes every market has had its turn: the newer ones aren't starved.
    expect(asked.size).toBe(all.length);
    expect(knownToLookUp(all.slice(0, 300), recordedAt)).toHaveLength(300); // under the cap: everyone, every poll
  });

  it("keeps a market that must stay callable live after the listing drops it, at its trading price", async () => {
    const urls: string[] = [];
    // A Slate card's rung, no longer among the ladder's 3 nearest 50/50 in the listing.
    const offList = { id: "777001", question: "Bitcoin above 115k on October 12?", outcomes: '["Yes", "No"]', outcomePrices: '["0.31", "0.69"]', endDate: "2026-10-12T16:00:00Z", closed: false, acceptingOrders: true };
    const trading = new Map([["777001", offList], ["5330080", { ...offList, id: "5330080", outcomePrices: '["0.50", "0.50"]' }]]);
    const fetch = (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/markets" && u.searchParams.get("closed") === "false") return ok(u.searchParams.getAll("id").flatMap((id) => (trading.has(id) ? [trading.get(id)!] : [])));
      return gamma({ urls })(url);
    };
    const p = polymarketProvider({ fetch: (u) => (urls.push(u), fetch(u)), log: () => {} });
    const card = known("777001", { category: "crypto", ladder: "bitcoin-above-on-october-12-2026", held: true, live: true });
    const fs = await p.fetch(recordedAt, [card, known("5330080", { live: true }), known("5046295")]);
    const byId = new Map(fs.map((f) => [f.externalId, f]));
    // Carried, open, at its live price, and freezing an hour before it settles like any rung.
    expect(byId.get("pm:777001")).toMatchObject({ price: 31, category: "crypto", ladder: "bitcoin-above-on-october-12-2026", resolved: null, voided: false });
    expect(byId.get("pm:777001")!.closed).toBeUndefined();
    expect(byId.get("pm:777001")!.freezesAt.toISOString()).toBe("2026-10-12T15:00:00.000Z");
    // The listing's own copy wins over the lookup (same market, listed price).
    expect(fs.filter((f) => f.externalId === "pm:5330080")).toEqual([expect.objectContaining({ price: 46 })]);
    const liveLookups = urls.map((u) => new URL(u)).filter((u) => u.pathname === "/markets" && u.searchParams.get("closed") === "false");
    expect(liveLookups.map((u) => u.searchParams.getAll("id"))).toEqual([["777001", "5330080"]]); // only what must stay live
    // Nothing live: no trading lookup at all.
    urls.length = 0;
    await p.fetch(recordedAt, [known("5046295")]);
    expect(urls.some((u) => new URL(u).pathname === "/markets" && new URL(u).searchParams.get("closed") === "false")).toBe(false);
  });

  it("looks up the matches we froze at kickoff and carries the ones still trading, in play, at their live price", async () => {
    const urls: string[] = [];
    // An EPL match that kicked off at 18:30, trading on at 63%.
    const match = { id: "880001", question: "Arsenal win?", outcomes: '["Yes", "No"]', outcomePrices: '["0.63", "0.37"]', endDate: "2026-10-11T21:00:00Z", gameStartTime: "2026-10-11 18:30:00+00", closed: false, acceptingOrders: true };
    const trading = new Map<string, Record<string, unknown>>([
      ["880001", match],
      // No kickoff: a market that just ends doesn't play on.
      ["880002", { ...match, id: "880002", gameStartTime: null, endDate: "2026-10-11T18:00:00Z" }],
      // Stopped taking orders: not in play.
      ["880003", { ...match, id: "880003", acceptingOrders: false }],
      // Pinned at an extreme: no call there.
      ["880004", { ...match, id: "880004", outcomePrices: '["0.98", "0.02"]' }],
    ]);
    const fetch = (url: string) => {
      urls.push(url);
      const u = new URL(url);
      if (u.pathname === "/markets" && u.searchParams.get("closed") === "false") return ok(u.searchParams.getAll("id").flatMap((id) => (trading.has(id) ? [trading.get(id)!] : [])));
      return gamma()(url);
    };
    const p = polymarketProvider({ fetch, log: () => {} });
    const kicked = { freezesAt: new Date("2026-10-11T18:30:00Z"), settlesBy: new Date("2026-10-11T21:00:00Z"), inPlay: true };
    const fs = await p.fetch(recordedAt, [known("880001", kicked), known("880002", kicked), known("880003", kicked), known("880004", kicked), known("880005", kicked), known("5046295")]);
    const byId = new Map(fs.map((f) => [f.externalId, f]));
    expect(byId.get("pm:880001")).toMatchObject({ price: 63, inPlay: true, resolved: null, voided: false, category: "sports" });
    expect(byId.get("pm:880001")!.freezesAt.toISOString()).toBe("2026-10-11T18:30:00.000Z");
    expect(byId.get("pm:880001")!.closed).toBeUndefined();
    for (const id of ["pm:880002", "pm:880003", "pm:880004", "pm:880005"]) expect(byId.has(id)).toBe(false);
    // Nothing else comes back in play: the listing's markets are before kickoff.
    expect(fs.filter((f) => f.inPlay).map((f) => f.externalId)).toEqual(["pm:880001"]);
    const lookups = urls.map((u) => new URL(u)).filter((u) => u.pathname === "/markets" && u.searchParams.get("closed") === "false");
    expect(lookups.map((u) => u.searchParams.getAll("id"))).toEqual([["880001", "880002", "880003", "880004", "880005"]]);
    // Only matches are looked up in play, and a result beats a live price.
    urls.length = 0;
    const settled = polymarketProvider({ fetch: gamma({ urls, lookup: (ids) => ok(ids.includes("880001") ? [{ ...resolvedYes, id: "880001" }] : []) }), log: () => {} });
    const after = await settled.fetch(recordedAt, [known("880001", kicked), known("880006", { ...kicked, category: "crypto" })]);
    expect(after.filter((f) => f.externalId === "pm:880001")).toEqual([expect.objectContaining({ resolved: true, closed: true })]);
    expect(after.some((f) => f.inPlay)).toBe(false);
    const inPlayIds = urls.map((u) => new URL(u)).filter((u) => u.pathname === "/markets" && u.searchParams.get("closed") === "false").flatMap((u) => u.searchParams.getAll("id"));
    expect(inPlayIds).toEqual(["880001"]);
  });

  it("plays on one of an event's markets (a match's win, draw and loss come as one event), never reopens a match from the in-play lookup, and asks for the latest kickoffs first", async () => {
    const urls: string[] = [];
    const base = { outcomes: '["Yes", "No"]', endDate: "2026-10-11T21:00:00Z", gameStartTime: "2026-10-11 18:30:00+00", closed: false, acceptingOrders: true };
    const trading = new Map<string, Record<string, unknown>>([
      ["990001", { ...base, id: "990001", question: "Arsenal win?", outcomePrices: '["0.55", "0.45"]' }],
      // Gamma now gives no kickoff time: it would read as open until it ends.
      ["990002", { ...base, id: "990002", question: "Draw?", outcomePrices: '["0.25", "0.75"]', gameStartTime: null }],
      // A later kickoff (postponed): that's the listing's to say, not this lookup's.
      ["990003", { ...base, id: "990003", question: "Chelsea win?", outcomePrices: '["0.20", "0.80"]', gameStartTime: "2026-10-12 18:30:00+00" }],
    ]);
    const fetch = (url: string) => {
      urls.push(url);
      const u = new URL(url);
      if (u.pathname === "/markets" && u.searchParams.get("closed") === "false") return ok(u.searchParams.getAll("id").flatMap((id) => (trading.has(id) ? [trading.get(id)!] : [])));
      return gamma()(url);
    };
    const p = polymarketProvider({ fetch, log: () => {} });
    const kicked = { freezesAt: new Date("2026-10-11T18:30:00Z"), settlesBy: new Date("2026-10-11T21:00:00Z"), inPlay: true, ladder: "arsenal-vs-chelsea" };
    const fs = await p.fetch(recordedAt, [known("990001", kicked), known("990002", kicked), known("990003", kicked)]);
    expect(fs.find((f) => f.externalId === "pm:990001")).toMatchObject({ inPlay: true, price: 55, ladder: "arsenal-vs-chelsea" });
    expect(fs.some((f) => f.externalId === "pm:990002" || f.externalId === "pm:990003")).toBe(false);
    // More matches than one poll looks up: the latest kickoffs come first.
    urls.length = 0;
    const many = Array.from({ length: 250 }, (_, i) => known(`7${String(i).padStart(5, "0")}`, { ...kicked, freezesAt: new Date(Date.parse("2026-10-11T15:00:00Z") + i * 60_000) }));
    await p.fetch(recordedAt, many);
    const asked = urls.map((u) => new URL(u)).filter((u) => u.pathname === "/markets" && u.searchParams.get("closed") === "false").flatMap((u) => u.searchParams.getAll("id"));
    expect(asked).toHaveLength(200);
    expect(asked[0]).toBe("700249");
    expect(asked).not.toContain("700049");
  });

  it("a failed lookup doesn't fail the poll: the listing still counts, and it's logged", async () => {
    const lines: string[] = [];
    const refused = () => Promise.resolve({ ok: false, status: 422, json: () => Promise.resolve({ error: "no" }) });
    const p = polymarketProvider({ fetch: gamma({ lookup: refused }), log: (l) => lines.push(l) });
    const fs = await p.fetch(recordedAt, [known("5046295")]);
    expect(fs.some((f) => f.externalId === "pm:5046295")).toBe(false);
    expect(fs.length).toBeGreaterThan(0);
    expect(lines).toEqual(["polymarket: looking up 1 known markets failed"]);
  });

  it("answers that hold no usable market are a failed poll, with the skip counts", async () => {
    // Gamma changes shape: outcomes come back as real arrays, not JSON strings.
    const drifted = crypto.map((e) => ({ ...e, markets: (e.markets ?? []).map((m) => ({ ...m, outcomes: ["Yes", "No"] })) }));
    const p = polymarketProvider({ fetch: gamma({ listing: { crypto: drifted } }), log: () => {} });
    await expect(p.fetch(recordedAt)).rejects.toThrow(/^polymarket: no usable market in 3 events; skipped 1 closed, .* 9 unreadable$/);
    // Every tag answering with nothing at all (a renamed tag, say) is no better.
    const empty = polymarketProvider({ fetch: gamma({ listing: {} }), log: () => {} });
    await expect(empty.fetch(recordedAt)).rejects.toThrow(/no usable market in 0 events/);
  });

  it("logs the skip counts when some markets can't be read, though others can", async () => {
    const lines: string[] = [];
    const half = [...crypto.slice(0, 1), ...crypto.slice(1).map((e) => ({ ...e, markets: (e.markets ?? []).map((m) => ({ ...m, outcomePrices: "0.5" })) }))];
    const p = polymarketProvider({ fetch: gamma({ listing: { crypto: half } }), log: (l) => lines.push(l) });
    expect((await p.fetch(recordedAt)).length).toBe(3);
    expect(lines).toEqual(["polymarket: skipped 1 closed, 0 not trading, 0 unpriced, 0 frozen, 2 at an extreme, 0 not YES/NO, 4 unreadable"]);
  });

  it("a hung category times out on its own; the others still count", async () => {
    const hung = (url: string, init?: { signal?: AbortSignal }) =>
      new URL(url).searchParams.get("tag_slug") === "sports"
        ? new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))
        : gamma()(url);
    const p = polymarketProvider({ fetch: hung, timeoutMs: 50, log: () => {} });
    const started = Date.now();
    const fs = await p.fetch(recordedAt);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fs.map((f) => f.category)).toEqual(Array(7).fill("crypto"));
  });
});
