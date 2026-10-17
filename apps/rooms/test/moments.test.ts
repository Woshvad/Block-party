import { MOMENTS, type TowerMoment } from "@bp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, INTERNAL_SECRET, type Rooms, fakeApi, quiet, startRooms } from "./harness";

// The Watch Party's big moments in the real Worker: from the API's POST,
// through the place's directory, to every copy's sockets.
const api = fakeApi();
let rooms: Rooms;

beforeAll(async () => {
  rooms = await startRooms(api);
});
afterAll(() => rooms?.dispose());

let seq = 0;
const moment = (over: Partial<TowerMoment> = {}): TowerMoment => ({
  id: `m${++seq}`,
  kind: "swing",
  marketId: "0b7e8c1a-3f2d-4c5b-9a8e-7d6c5b4a3f2e",
  question: "Will Lagos FC win tonight?",
  from: 41,
  to: 63,
  at: Date.now(),
  ...over,
});
const post = (place: string, body: unknown, headers: Record<string, string> = { "x-internal-secret": INTERNAL_SECRET }) =>
  rooms.mf.dispatchFetch(`http://rooms.test/internal/moment?place=${encodeURIComponent(place)}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers });
const moments = (c: Client) => c.events.filter((e) => e.t === "moment");
// In, welcomed, and nothing left over: an earlier test's moment may still be
// kept for newcomers.
async function settledIn(u: string, place: string) {
  const c = await rooms.connect(u, { place });
  await c.next("welcome");
  await quiet();
  c.events.length = 0;
  return c;
}

describe("a moment on the big screen", () => {
  it("reaches every socket in every live copy of the Watch Party", async () => {
    const crowd: Client[] = [];
    for (let i = 0; i < 60; i++) crowd.push(await rooms.connect(`wp${i}`, { place: "watch_party" }));
    for (const p of crowd) await p.next("welcome");
    const extra = await rooms.connect("wp60", { place: "watch_party" }); // the 61st: copy 1
    await extra.next("welcome");
    expect(await (await rooms.internal("/internal/presence?place=watch_party&u=wp60")).json()).toEqual({ here: true, copy: 1 });
    const m = moment();
    const res = await post("watch_party", m);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, copies: [0, 1], failed: [] });
    for (const p of [...crowd, extra]) expect(await p.next("moment")).toEqual({ t: "moment", moment: m, showForMs: MOMENTS.showSeconds * 1000 });
    for (const p of [...crowd, extra]) p.ws.close();
    await quiet(500);
  }, 60_000);

  it("anyone who joins within 2 minutes gets it, even after the room naps; the newest replaces it", async () => {
    const a = await settledIn("join-a", "watch_party");
    const m = moment();
    expect((await post("watch_party", m)).status).toBe(200);
    expect((await a.next("moment")).moment).toEqual(m);
    const b = await rooms.connect("join-b", { place: "watch_party" });
    await b.next("welcome");
    const late = await b.next("moment");
    expect(late.moment).toEqual(m);
    expect(late.showForMs).toBeGreaterThan(0);
    expect(late.showForMs).toBeLessThanOrEqual(MOMENTS.showSeconds * 1000);
    // The room forgets everything but its sockets and storage: the moment is in storage.
    expect((await rooms.internal("/internal/forget?place=watch_party&copy=0", { method: "POST" })).status).toBe(200);
    const c = await rooms.connect("join-c", { place: "watch_party" });
    await c.next("welcome");
    expect((await c.next("moment")).moment).toEqual(m);
    // A newer one replaces it, for everyone here and whoever comes next.
    const newer = moment({ kind: "settled", from: 63, to: undefined, outcome: "yes" });
    expect((await post("watch_party", newer)).status).toBe(200);
    for (const x of [a, b, c]) expect((await x.next("moment")).moment).toEqual(newer);
    // The same moment again (a retried delivery) isn't shown twice.
    expect((await post("watch_party", newer)).status).toBe(200);
    const d = await rooms.connect("join-d", { place: "watch_party" });
    await d.next("welcome");
    expect((await d.next("moment")).moment).toEqual(newer);
    await quiet();
    expect([...moments(a), ...moments(d)]).toEqual([]);
    for (const x of [a, b, c, d]) x.ws.close();
  });

  it("a Watch Party nobody's in keeps it for the first to walk in", async () => {
    // Copy 0 of a place with a screen that no one has ever joined in this Worker:
    // a fresh Worker of its own, so the earlier tests' copies don't count.
    const fresh = await startRooms(fakeApi());
    try {
      const m = moment();
      const res = await fresh.mf.dispatchFetch("http://rooms.test/internal/moment?place=watch_party", { method: "POST", body: JSON.stringify(m), headers: { "x-internal-secret": INTERNAL_SECRET } });
      expect(await res.json()).toEqual({ ok: true, copies: [0], failed: [] });
      const first = await fresh.connect("first-in", { place: "watch_party" });
      await first.next("welcome");
      expect((await first.next("moment")).moment).toEqual(m);
      first.ws.close();
      await quiet();
    } finally {
      await fresh.dispose();
    }
  }, 60_000);
});

describe("what a moment can't do", () => {
  it("bad payloads are refused before any room sees them", async () => {
    const a = await settledIn("bad-a", "watch_party");
    const refused: Array<[unknown, number, string]> = [
      ["not json", 400, "BAD_MOMENT"],
      [null, 400, "BAD_MOMENT"],
      [[], 400, "BAD_MOMENT"],
      [{ ...moment(), kind: "goal" }, 400, "BAD_MOMENT"],
      [{ ...moment(), marketId: "nope" }, 400, "BAD_MOMENT"],
      [{ ...moment(), question: "" }, 400, "BAD_MOMENT"],
      [{ ...moment(), from: 0 }, 400, "BAD_MOMENT"],
      [{ ...moment(), outcome: "yes" }, 400, "BAD_MOMENT"],
      [{ ...moment(), question: "q".repeat(MOMENTS.questionChars + 1) }, 400, "BAD_MOMENT"],
      [{ ...moment(), padding: "x".repeat(MOMENTS.bodyBytes) }, 413, "TOO_LARGE"],
    ];
    for (const [body, status, error] of refused) {
      const res = await post("watch_party", body);
      expect([res.status, ((await res.json()) as { error: string }).error], JSON.stringify(body).slice(0, 80)).toEqual([status, error]);
    }
    await quiet();
    expect(moments(a)).toEqual([]);
    a.ws.close();
  });

  it("only a place with a screen takes one: other places are refused, and so is a room asked directly", async () => {
    const d = await settledIn("noscreen-d", "diner");
    for (const place of ["diner", "tower", "watch_party:2", "home:someone"]) {
      const res = await post(place, moment());
      expect([res.status, ((await res.json()) as { error: string }).error], place).toEqual([400, "NO_SCREEN"]);
    }
    expect((await post("narnia", moment())).status).toBe(404);
    // Straight to the Diner's room, the way another object in the Worker would: still no.
    const diner = await rooms.roomStub("diner#0");
    const direct = await diner.fetch("https://room/moment", { method: "POST", body: JSON.stringify(moment()), headers: { "x-place": "diner", "x-copy": "0" } });
    expect([direct.status, await direct.json()]).toEqual([400, { error: "NO_SCREEN" }]);
    // And a Watch Party room checks the payload itself.
    const wp = await rooms.roomStub("watch_party#0");
    const junk = await wp.fetch("https://room/moment", { method: "POST", body: JSON.stringify({ ...moment(), kind: "goal" }), headers: { "x-place": "watch_party", "x-copy": "0" } });
    expect([junk.status, await junk.json()]).toEqual([400, { error: "BAD_MOMENT" }]);
    await quiet();
    expect(moments(d)).toEqual([]);
    d.ws.close();
  });

  it("needs the internal secret, and a POST", async () => {
    const a = await settledIn("secret-a", "watch_party");
    expect((await post("watch_party", moment(), {})).status).toBe(404);
    expect((await post("watch_party", moment(), { "x-internal-secret": "x".repeat(40) })).status).toBe(404);
    expect((await rooms.mf.dispatchFetch("http://rooms.test/internal/moment?place=watch_party", { headers: { "x-internal-secret": INTERNAL_SECRET } })).status).toBe(404);
    await quiet();
    expect(moments(a)).toEqual([]);
    a.ws.close();
  });
});
