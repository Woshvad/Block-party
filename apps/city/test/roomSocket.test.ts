import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, type SocketStatus, backoffMs, openRoomSocket } from "../src/roomSocket";

// A fake socket and a manual clock, so every reconnect path runs instantly.
function harness(ticket: () => Promise<{ url: string }> = async () => ({ url: "ws://room" })) {
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
  const conn = openRoomSocket(
    {
      ticket,
      makeSocket: (url) => new FakeWs(url),
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
    const t = timers.find((x) => x.live && x.ms !== 25_000);
    if (!t) return false;
    t.live = false;
    t.fn();
    await flush();
    return true;
  };
  return { sockets, statuses, events, conn, flush, fireRetry, timers };
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

  it("gives up after MAX_ATTEMPTS failures in a row instead of looping forever", async () => {
    const h = harness();
    await h.flush();
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      h.sockets.at(-1)!.drop(1006);
      if (!(await h.fireRetry())) break;
    }
    expect(h.statuses.at(-1)).toEqual({ kind: "stopped", reason: "Lost the connection to the room." });
    expect(h.sockets.length).toBe(MAX_ATTEMPTS + 1);
  });

  it("never reconnects when another tab takes over or the room refuses", async () => {
    for (const code of [4000, 4001]) {
      const h = harness();
      await h.flush();
      h.sockets[0]!.open();
      h.sockets[0]!.drop(code);
      expect(h.statuses.at(-1)!.kind).toBe("stopped");
      expect(await h.fireRetry()).toBe(false);
      expect(h.sockets).toHaveLength(1);
    }
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
