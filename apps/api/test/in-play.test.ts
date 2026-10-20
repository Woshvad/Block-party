import { randomUUID } from "node:crypto";
import { type FeedMarket, type OddsProvider, TOWER } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SECRET, call, close, makeApp, ready, resident } from "./harness";

beforeAll(ready);
afterAll(close);

const MIN = 60_000;

describe("in-play calls over HTTP", () => {
  it("the Hall's matches in play, a call from inside the Hall that locks 2 minutes on, and none from outside", async () => {
    // The app's clock runs from just after now (sessions are checked against it).
    const t = Date.now() + 5_000;
    let clock = new Date(t);
    const ms = new Map<string, FeedMarket>();
    const odds: OddsProvider = { source: "api-in-play-test", fetch: async () => [...ms.values()].map((m) => ({ ...m })) };
    const m: FeedMarket = { externalId: randomUUID(), question: "Home side wins tonight?", category: "sports", ladder: null, freezesAt: new Date(t + 60 * MIN), settlesBy: new Date(t + 180 * MIN), price: 50, resolved: null, voided: false };
    ms.set(m.externalId, m);
    const app = makeApp({ odds, now: () => clock });
    const internal = { "x-internal-secret": SECRET };
    const poll = async (at: number) => {
      clock = new Date(at);
      expect((await call("POST", "/internal/tower/poll", { headers: internal, via: app })).body).toMatchObject({ ok: true });
    };
    await poll(t);
    const me = await resident();
    const away = await resident();
    // Not in play before kickoff.
    expect((await call("GET", "/v1/tower/in-play", { token: me.token, via: app })).body.some((x: { question: string }) => x.question === m.question)).toBe(false);
    // Kickoff: the feed carries it in play.
    const k = t + 60 * MIN;
    m.inPlay = true;
    m.price = 64;
    await poll(k + MIN);
    const list = (await call("GET", "/v1/tower/in-play", { token: me.token, via: app })).body as Array<{ id: string; question: string; price: number; kickoffAt: string }>;
    const live = list.find((x) => x.question === m.question)!;
    expect(live).toMatchObject({ price: 64, kickoffAt: new Date(k).toISOString() });
    expect((await call("GET", `/v1/tower/markets/${live.id}`, { token: me.token, via: app })).body).toMatchObject({ inPlay: true, world: 64, status: "frozen" });
    // The rooms report you walked into the Hall.
    const effects = { place: "watch_party", copy: 1, effects: [{ id: "v1", kind: "visit_start", userId: me.userId, at: k }] };
    expect((await call("POST", "/internal/rooms/effects", { headers: internal, via: app, body: effects })).status).toBe(200);
    clock = new Date(k + MIN + 5_000);
    const body = { marketId: live.id, side: "yes", chance: 80, seenPrice: 64, inPlay: true };
    const refused = await call("POST", "/v1/tower/calls", { token: away.token, via: app, body });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "NOT_IN_HALL" } } });
    const made = await call("POST", "/v1/tower/calls", { token: me.token, via: app, body });
    expect(made).toMatchObject({ status: 201, body: { status: "pending", inPlay: true, onSlate: false, ticket: true } });
    // Not without inPlay: the market is frozen for ordinary calls.
    expect((await call("POST", "/v1/tower/calls", { token: away.token, via: app, body: { ...body, inPlay: undefined } })).body).toMatchObject({ error: { code: "MARKET_CLOSED" } });
    await poll(k + 2 * MIN);
    expect((await call("GET", `/v1/tower/calls/${made.body.id}`, { token: me.token, via: app })).body).toMatchObject({ status: "pending", inPlay: true });
    await poll(k + MIN + 5_000 + TOWER.inPlayDelaySeconds * 1000);
    expect((await call("GET", `/v1/tower/calls/${made.body.id}`, { token: me.token, via: app })).body).toMatchObject({ status: "locked", lockedPrice: 64, half: true, inPlay: true });
  });
});
