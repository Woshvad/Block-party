import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Rooms, fakeApi, quiet, startRooms } from "./harness";

// The room's hot path: what each message costs, and what a hostile or
// unlucky resident can do to everyone else in the room.

const uuids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());
const chatFrom = (c: { events: Array<Record<string, any>> }, text: string) => c.events.some((e) => e.t === "chat" && e.line.text === text);

describe("with the production settings", () => {
  const api = fakeApi();
  let rooms: Rooms;
  beforeAll(async () => {
    rooms = await startRooms(api, { BLOCKED_WORDS: "rugpull, honeypot\r\nScamCoin\n\n" });
  });
  afterAll(() => rooms?.dispose());

  it("a resident with 600 mutes and 600 blocks joins, chats and naps like anyone else", async () => {
    const heavy = "hp-heavy";
    const blocks = uuids(600);
    api.access.set(heavy, { userId: heavy, hidden: [...blocks, ...uuids(600), "hp-muted"], blocked: blocks, chat: true, suspended: false });
    const other = await rooms.connect("hp-other", { place: "faucet" });
    await other.next("welcome");
    const h = await rooms.connect(heavy, { place: "faucet" });
    await h.next("welcome");
    expect((await other.next("joined")).member.userId).toBe(heavy);
    const muted = await rooms.connect("hp-muted", { place: "faucet" });
    await muted.next("welcome");
    h.send({ t: "chat", text: "gm from a long list" });
    expect((await other.next("chat")).line.text).toBe("gm from a long list");
    other.send({ t: "chat", text: "gm back" });
    await quiet();
    expect(chatFrom(h, "gm back")).toBe(true);
    // A nap: the room rebuilds from its sockets, and the lists come back from the API.
    expect((await rooms.internal("/internal/forget?place=faucet&copy=0", { method: "POST" })).status).toBe(200);
    muted.send({ t: "chat", text: "you muted me" });
    other.send({ t: "chat", text: "still here" });
    await other.next("chat");
    await quiet();
    expect(chatFrom(h, "still here")).toBe(true);
    expect(chatFrom(h, "you muted me")).toBe(false);
    h.send({ t: "move", to: { x: 2, y: 2 } });
    expect((await other.next("moving")).userId).toBe(heavy);
    for (const c of [h, other, muted]) c.ws.close();
  });

  it("a flood is turned away before it costs anything, and the room keeps talking", async () => {
    const a = await rooms.connect("flood-a", { place: "gm_wall" });
    const b = await rooms.connect("flood-b", { place: "gm_wall" });
    await a.next("welcome");
    await b.next("welcome");
    await quiet();
    const asked = api.accessCalls.length;
    for (let i = 0; i < 60; i++) a.send({ t: "sit", seat: "nowhere" });
    b.send({ t: "chat", text: "still talking" });
    expect((await a.next("chat", 2000)).line.text).toBe("still talking");
    await quiet(500);
    const codes = a.events.filter((e) => e.t === "error").map((e) => e.code);
    // The bucket lets about 20 through (plus a little refill); the rest never reach the room.
    expect(codes.filter((c) => c === "BAD_SEAT").length).toBeLessThanOrEqual(25);
    expect(codes.filter((c) => c === "SLOW_DOWN").length).toBeGreaterThanOrEqual(35);
    // Fresh access is reused: the flood made no access checks at all.
    expect(api.accessCalls.length).toBe(asked);
    a.ws.close();
    b.ws.close();
  });

  it("a slow access check for a newcomer doesn't hold up the room", async () => {
    const a = await rooms.connect("slow-a", { place: "roof" });
    await a.next("welcome");
    api.accessDelayMs = 2000;
    let joined = false;
    const late = rooms.connect("slow-late", { place: "roof" }).then((c) => {
      joined = true;
      return c;
    });
    await quiet(200);
    try {
      const sent = Date.now();
      a.send({ t: "chat", text: "no waiting" });
      expect((await a.next("chat", 1500)).line.text).toBe("no waiting");
      expect(Date.now() - sent).toBeLessThan(1000);
      expect(joined).toBe(false); // the newcomer's check really was still going
    } finally {
      api.accessDelayMs = 0;
    }
    const c = await late;
    await c.next("welcome");
    a.ws.close();
    c.ws.close();
  });

  it("staff's blocked words never reach the room", async () => {
    const a = await rooms.connect("bw-a", { place: "tower" });
    const b = await rooms.connect("bw-b", { place: "tower" });
    await a.next("welcome");
    await b.next("welcome");
    for (const text of ["total rugpull ser", "a SCAMCOIN for you", "honeypot"]) {
      a.send({ t: "chat", text, requestId: text });
      expect(await a.next("chat_result")).toMatchObject({ requestId: text, ok: false, code: "BLOCKED_WORD" });
      expect((await a.next("error")).code).toBe("BLOCKED_WORD");
    }
    a.send({ t: "chat", text: "pulling the rug out from under the couch" });
    expect((await b.next("chat")).line.text).toBe("pulling the rug out from under the couch");
    expect(b.events.filter((e) => e.t === "chat")).toEqual([]);
    a.ws.close();
    b.ws.close();
  });

  it("a suspended resident is turned away with the restricted close code, not 'somewhere else'", async () => {
    api.access.set("sus-join", { userId: "sus-join", hidden: [], blocked: [], chat: false, suspended: true });
    const s = await rooms.connect("sus-join", { place: "watch_party" });
    expect(await s.closed).toBe(4002);
    expect(await (await rooms.internal("/internal/presence?place=watch_party&u=sus-join")).json()).toEqual({ here: false, copy: null });
  });
});

// A short trust window, so a test can watch lists go stale.
describe("with a 3-second access window", () => {
  const api = fakeApi();
  let rooms: Rooms;
  beforeAll(async () => {
    rooms = await startRooms(api, { ACCESS_TTL_MS: "3000" });
  });
  afterAll(() => rooms?.dispose());
  const pastTheWindow = () => quiet(3200);

  it("a mute or block made mid-visit applies once the window passes, without reconnecting", async () => {
    const a = await rooms.connect("safety-a", { place: "faucet" });
    const b = await rooms.connect("safety-b", { place: "faucet" });
    await a.next("welcome");
    await b.next("welcome");
    api.access.set("safety-a", { userId: "safety-a", hidden: ["safety-b"], blocked: [], chat: true, suspended: false });
    await pastTheWindow();
    b.send({ t: "chat", text: "muted line" });
    await b.next("chat");
    await quiet();
    expect(chatFrom(a, "muted line")).toBe(false);
    a.send({ t: "chat", text: "outgoing still works" });
    expect((await b.next("chat")).line.text).toBe("outgoing still works");
    api.access.get("safety-a")!.blocked = ["safety-b"];
    await pastTheWindow();
    a.send({ t: "chat", text: "blocked outgoing" });
    await a.next("chat"); // own echo
    await quiet();
    expect(chatFrom(b, "blocked outgoing")).toBe(false);
    api.access.get("safety-a")!.hidden = [];
    api.access.get("safety-a")!.blocked = [];
    await pastTheWindow();
    b.send({ t: "chat", text: "unblocked line" });
    await b.next("chat");
    await quiet();
    expect(chatFrom(a, "unblocked line")).toBe(true);
    a.ws.close();
    b.ws.close();
  });

  it("a restriction made mid-visit stops chat; a suspension closes with 4002 and clears presence", async () => {
    const a = await rooms.connect("restricted-live", { place: "gm_wall" });
    await a.next("welcome");
    api.access.get("restricted-live")!.chat = false;
    await pastTheWindow();
    a.send({ t: "chat", text: "cannot send this" });
    expect((await a.next("error")).code).toBe("CHAT_RESTRICTED");
    api.access.get("restricted-live")!.suspended = true;
    await pastTheWindow();
    a.send({ t: "move", to: { x: 1, y: 1 } });
    expect(await a.closed).toBe(4002);
    expect(await (await rooms.internal("/internal/presence?place=gm_wall&u=restricted-live")).json()).toEqual({ here: false, copy: null });
  });

  it("when the API is down, only a member whose lists are stale is refused; the rest carry on", async () => {
    const stale = await rooms.connect("outage-stale", { place: "roof" });
    await stale.next("welcome");
    await quiet(1500);
    const fresh = await rooms.connect("outage-fresh", { place: "roof" });
    await fresh.next("welcome");
    await quiet(1800); // the first one's lists are past the window; the second's aren't
    api.accessAvailable = false;
    try {
      stale.send({ t: "chat", text: "cannot bypass an outage", requestId: "o1" });
      expect(await stale.next("chat_result")).toMatchObject({ requestId: "o1", ok: false, code: "ACCESS_UNAVAILABLE" });
      fresh.send({ t: "chat", text: "fresh lists still talk" });
      expect((await stale.next("chat")).line.text).toBe("fresh lists still talk");
      await fresh.next("chat"); // own echo
    } finally {
      api.accessAvailable = true;
    }
    // Back up: the stale one is checked again and talks.
    await quiet(1100);
    stale.send({ t: "chat", text: "back again" });
    expect((await fresh.next("chat")).line.text).toBe("back again");
    stale.ws.close();
    fresh.ws.close();
  });

  it("after a nap nobody's lists are known, so an outage refuses everyone until the API answers", async () => {
    const a = await rooms.connect("nap-a", { place: "tower" });
    const b = await rooms.connect("nap-b", { place: "tower", hidden: ["nap-a"] });
    await a.next("welcome");
    await b.next("welcome");
    await rooms.internal("/internal/forget?place=tower&copy=0", { method: "POST" });
    api.accessAvailable = false;
    try {
      a.send({ t: "chat", text: "nobody hears this" });
      expect((await a.next("error")).code).toBe("ACCESS_UNAVAILABLE");
    } finally {
      api.accessAvailable = true;
    }
    await quiet(1100);
    a.send({ t: "chat", text: "after the nap" });
    expect((await a.next("chat")).line.text).toBe("after the nap");
    await quiet();
    expect(chatFrom(b, "after the nap")).toBe(false); // b's block came back with the lists
    a.ws.close();
    b.ws.close();
  });
});

