import { describe, expect, it } from "vitest";
import { FAST_ATTEMPTS, PING_MS, SLOW_RETRY_MS, type SocketStatus, backoffMs, openRoomSocket, retryDelayMs, socketUrl } from "../src/roomSocket";

// A fake socket and a manual clock, so every reconnect path runs instantly.
function harness(ticket: () => Promise<{ url: string }> = async () => ({ url: "ws://room" }), opts: { random?: () => number; makeSocket?: (url: string) => unknown } = {}) {
  const sockets: FakeWs[] = [];
  const timers: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
  let n = 0;
  class FakeWs {
    readyState = 0;
    sent: string[] = [];
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: ((e: { code: number; reason: string }) => void) | null = null;
    constructor(readonly url: string) {
      sockets.push(this);
    }
    send(d: string) {
      this.sent.push(d);
    }
    close(code = 1000) {
      this.readyState = 3;
      this.onclose?.({ code, reason: "" });
    }
    open() {
      this.readyState = 1;
      this.onopen?.({});
    }
    drop(code: number) {
      this.readyState = 3;
      this.onclose?.({ code, reason: "" });
    }
  }
  const statuses: SocketStatus[] = [];
  const events: unknown[] = [];
  // What the page would call when the device is back online or visible again.
  const resume = { fn: null as null | (() => void), listening: false };
  const conn = openRoomSocket(
    {
      ticket,
      makeSocket: (url) => (opts.makeSocket ? opts.makeSocket(url) : new FakeWs(url)) as FakeWs,
      random: opts.random ?? (() => 0.5),
      onResume: (fn) => {
        resume.fn = fn;
        resume.listening = true;
        return () => {
          resume.listening = false;
        };
      },
      setTimer: (fn, ms) => {
        const t = { fn, ms, id: ++n, live: true };
        timers.push(t);
        return t.id;
      },
      clearTimer: (id) => {
        const t = timers.find((x) => x.id === id);
        if (t) t.live = false;
      },
    },
    { event: (e) => events.push(e), status: (s) => statuses.push(s) },
  );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  // Fire the next live non-ping timer (a reconnect).
  const fireRetry = async () => {
    const t = timers.find((x) => x.live && x.ms !== PING_MS);
    if (!t) return false;
    t.live = false;
    t.fn();
    await flush();
    return true;
  };
  const retries = () => timers.filter((x) => x.live && x.ms !== PING_MS);
  return { sockets, statuses, events, conn, flush, fireRetry, timers, retries, resume, FakeWs };
}

describe("openRoomSocket", () => {
  it("keeps heartbeats scheduled while waiting for a ticket and after a reconnect", async () => {
    let resolve!: (v: { url: string }) => void;
    const h = harness(() => new Promise((r) => { resolve = r; }));
    const ping = () => {
      const t = h.timers.find((t) => t.live && t.ms === 25_000)!;
      expect(t).toBeDefined();
      t.live = false;
      t.fn();
    };
    ping(); // ticket still pending after 25 seconds
    resolve({ url: "ws://room" });
    await h.flush();
    h.sockets[0]!.open();
    ping();
    expect(h.sockets[0]!.sent).toEqual(['{"t":"ping"}']);
    h.sockets[0]!.drop(1006);
    ping(); // between connections
    await h.fireRetry();
    resolve({ url: "ws://room2" });
    await h.flush();
    h.sockets[1]!.open();
    ping();
    expect(h.sockets[1]!.sent).toEqual(['{"t":"ping"}']);
    h.conn.close();
  });
  it("connects, goes live, and passes parsed events through", async () => {
    const h = harness();
    await h.flush();
    h.sockets[0]!.open();
    h.sockets[0]!.onmessage!({ data: JSON.stringify({ t: "pong" }) });
    h.sockets[0]!.onmessage!({ data: "not json" });
    expect(h.statuses.map((s) => s.kind)).toEqual(["connecting", "live"]);
    expect(h.events).toEqual([{ t: "pong" }]);
    expect(h.conn.send({ t: "chat", text: "gm" })).toBe(true);
    expect(h.sockets[0]!.sent).toEqual([JSON.stringify({ t: "chat", text: "gm" })]);
  });

  it("reconnects after a drop with a fresh ticket, and backs off", async () => {
    let tickets = 0;
    const h = harness(async () => ({ url: `ws://room/${++tickets}` }));
    await h.flush();
    h.sockets[0]!.open();
    h.sockets[0]!.drop(1006);
    expect(h.statuses.at(-1)).toEqual({ kind: "reconnecting", attempt: 1 });
    expect(await h.fireRetry()).toBe(true);
    expect(h.sockets[1]!.url).toBe("ws://room/2");
    h.sockets[1]!.open();
    expect(h.statuses.at(-1)!.kind).toBe("live");
    expect([1, 2, 3, 4, 5, 6].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
  });

  it("never gives up: after the fast attempts it keeps trying, slowly", async () => {
    const h = harness();
    await h.flush();
    const waits: number[] = [];
    for (let i = 0; i < FAST_ATTEMPTS + 4; i++) {
      h.sockets.at(-1)!.drop(1006);
      waits.push(h.retries()[0]!.ms);
      expect(await h.fireRetry()).toBe(true);
    }
    expect(h.statuses.some((s) => s.kind === "stopped")).toBe(false);
    expect(h.statuses.at(-1)).toEqual({ kind: "reconnecting", attempt: FAST_ATTEMPTS + 4 });
    expect(h.sockets.length).toBe(FAST_ATTEMPTS + 5);
    // Half of each wait (random pinned at 0.5): the fast backoff, then the slow interval.
    expect(waits).toEqual([...Array.from({ length: FAST_ATTEMPTS }, (_, i) => backoffMs(i + 1) / 2), ...Array(4).fill(SLOW_RETRY_MS / 2)]);
    // Connecting again starts the count over.
    h.sockets.at(-1)!.open();
    h.sockets.at(-1)!.drop(1006);
    expect(h.statuses.at(-1)).toEqual({ kind: "reconnecting", attempt: 1 });
  });

  it("spreads reconnects out at random (full jitter), so a city doesn't come back in step", () => {
    expect(retryDelayMs(3, () => 0)).toBe(0);
    expect(retryDelayMs(3, () => 0.999)).toBe(Math.floor(0.999 * backoffMs(3)));
    expect(retryDelayMs(FAST_ATTEMPTS + 1, () => 0.999)).toBe(Math.floor(0.999 * SLOW_RETRY_MS));
    // A seeded spread over 1,000 clients on their third attempt.
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const waits = Array.from({ length: 1000 }, () => retryDelayMs(3, rand));
    expect(Math.min(...waits)).toBeLessThan(backoffMs(3) / 10);
    expect(Math.max(...waits)).toBeGreaterThan(backoffMs(3) * 0.9);
    expect(new Set(waits).size).toBeGreaterThan(500);
  });

  it("never reconnects when another tab takes over, the room refuses, or the account is restricted", async () => {
    const reasons: string[] = [];
    for (const code of [4000, 4001, 4002]) {
      const h = harness();
      await h.flush();
      h.sockets[0]!.open();
      h.sockets[0]!.drop(code);
      const last = h.statuses.at(-1)!;
      expect(last.kind).toBe("stopped");
      reasons.push(last.kind === "stopped" ? last.reason : "");
      expect(await h.fireRetry()).toBe(false);
      expect(h.sockets).toHaveLength(1);
      expect(h.resume.listening).toBe(false);
    }
    expect(reasons[2]).toMatch(/restricted/);
    expect(new Set(reasons).size).toBe(3); // a suspension is never "you opened this room somewhere else"
  });

  it("asks for a ws(s) URL even though the API hands out http(s)", async () => {
    expect(socketUrl("https://rooms.blockparty.city/connect?ticket=a.b")).toBe("wss://rooms.blockparty.city/connect?ticket=a.b");
    expect(socketUrl("http://localhost:8788/connect?ticket=x")).toBe("ws://localhost:8788/connect?ticket=x");
    expect(socketUrl("HTTPS://rooms.test/connect")).toBe("wss://rooms.test/connect");
    expect(socketUrl("wss://already/connect")).toBe("wss://already/connect");
    const h = harness(async () => ({ url: "https://rooms.test/connect?ticket=t" }));
    await h.flush();
    expect(h.sockets[0]!.url).toBe("wss://rooms.test/connect?ticket=t");
  });

  it("a WebSocket constructor that throws is a failed attempt, not a stuck panel", async () => {
    let calls = 0;
    const h = harness(undefined, {
      makeSocket: (url) => {
        if (++calls === 1) throw new SyntaxError("The URL scheme is not allowed");
        return new h.FakeWs(url);
      },
    });
    await h.flush();
    expect(h.statuses.at(-1)).toEqual({ kind: "reconnecting", attempt: 1 });
    expect(await h.fireRetry()).toBe(true);
    h.sockets[0]!.open();
    expect(h.statuses.at(-1)!.kind).toBe("live");
  });

  it("back online or back in view: a waiting retry goes at once; otherwise nothing happens", async () => {
    const h = harness();
    await h.flush();
    h.sockets[0]!.open();
    h.resume.fn!(); // live: nothing to do
    expect(h.sockets).toHaveLength(1);
    for (let i = 0; i < FAST_ATTEMPTS + 2; i++) {
      h.sockets.at(-1)!.drop(1006);
      await h.fireRetry();
    }
    h.sockets.at(-1)!.drop(1006); // now waiting on a slow retry
    const before = h.sockets.length;
    expect(h.retries()).toHaveLength(1);
    h.resume.fn!();
    await h.flush();
    expect(h.sockets).toHaveLength(before + 1); // reconnected without waiting
    expect(h.retries()).toHaveLength(0); // and the slow retry was called off
    h.resume.fn!(); // already on its way: no second socket
    await h.flush();
    expect(h.sockets).toHaveLength(before + 1);
    h.sockets.at(-1)!.open();
    expect(h.statuses.at(-1)!.kind).toBe("live");
    h.conn.close();
    expect(h.resume.listening).toBe(false);
    h.resume.fn!(); // after closing: still nothing
    await h.flush();
    expect(h.sockets).toHaveLength(before + 1);
  });

  it("an API refusal for the ticket is final; a server error retries", async () => {
    const refused = harness(async () => Promise.reject({ status: 409, message: "you're not there yet" }));
    await refused.flush();
    expect(refused.statuses.at(-1)).toEqual({ kind: "stopped", reason: "you're not there yet" });
    let calls = 0;
    const flaky = harness(async () => (++calls === 1 ? Promise.reject({ status: 503 }) : { url: "ws://ok" }));
    await flaky.flush();
    expect(flaky.statuses.at(-1)!.kind).toBe("reconnecting");
    await flaky.fireRetry();
    expect(flaky.sockets[0]!.url).toBe("ws://ok");
  });

  it("closing stops everything, and a late close event does nothing", async () => {
    const h = harness();
    await h.flush();
    h.sockets[0]!.open();
    h.conn.close();
    expect(h.statuses.at(-1)).toEqual({ kind: "stopped", reason: "closed" });
    expect(h.timers.filter((t) => t.live)).toHaveLength(0);
    expect(h.conn.send({ t: "chat" })).toBe(false);
  });
});
