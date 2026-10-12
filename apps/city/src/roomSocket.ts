// One live connection to a room: a fresh ticket per attempt (they last 60 s),
// a ping to keep it warm, and reconnects with backoff. Some closes are final:
// another tab took over (4000), the room refused us (4001) or the account is
// restricted (4002); reconnecting would just fight the other tab or hit the
// same wall, so we stop and say why.
//
// Anything else, we keep trying: quickly at first, with a random spread so a
// whole city doesn't reconnect in step after a rooms deploy, then slowly for
// as long as the room is open, and straight away when the device comes back
// online or the app comes back into view.

export type SocketStatus = { kind: "connecting" } | { kind: "live" } | { kind: "reconnecting"; attempt: number } | { kind: "stopped"; reason: string };

type WsLike = {
  readyState: number;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type RoomSocketDeps = {
  ticket: () => Promise<{ url: string }>;
  makeSocket?: (url: string) => WsLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  random?: () => number; // the backoff's spread (tests pin it)
  // Calls `resume` when it's a good moment to try again at once; returns a
  // function that stops listening. By default: back online, or visible again.
  onResume?: (resume: () => void) => () => void;
};

export const FAST_ATTEMPTS = 8;
export const SLOW_RETRY_MS = 60_000;
export const PING_MS = 25_000;
export const backoffMs = (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));

// Full jitter: anywhere from no wait up to the backoff (or the slow interval
// once the fast attempts are used up).
export const retryDelayMs = (attempt: number, random: () => number) => Math.floor(random() * (attempt > FAST_ATTEMPTS ? SLOW_RETRY_MS : backoffMs(attempt)));

// The API hands out the rooms URL as http(s), which it also fetches; a
// WebSocket wants ws(s), and older WebViews throw on anything else.
export const socketUrl = (url: string) => url.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s.toLowerCase()}://`);

const FINAL: Record<number, string> = {
  4000: "You opened this room somewhere else.",
  4001: "The room wouldn't let you in.",
  4002: "Your account is restricted right now, so you can't be in rooms.",
};

function whenBack(resume: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const online = () => resume();
  const visible = () => {
    if (document.visibilityState === "visible") resume();
  };
  window.addEventListener("online", online);
  document.addEventListener("visibilitychange", visible);
  return () => {
    window.removeEventListener("online", online);
    document.removeEventListener("visibilitychange", visible);
  };
}

export function openRoomSocket(deps: RoomSocketDeps, on: { event: (ev: unknown) => void; status: (s: SocketStatus) => void }) {
  const make = deps.makeSocket ?? ((url: string) => new WebSocket(url) as unknown as WsLike);
  const setT = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const random = deps.random ?? Math.random;
  let ws: WsLike | null = null;
  let stopped = false;
  let connecting = false; // waiting for a ticket
  let attempt = 0;
  let ping: unknown = null;
  let retry: unknown = null;
  let stopListening = () => {};

  const stop = (reason: string) => {
    if (stopped) return;
    stopped = true;
    if (ping) clearT(ping);
    if (retry) clearT(retry);
    retry = null;
    stopListening();
    on.status({ kind: "stopped", reason });
  };

  const schedule = () => {
    if (stopped) return;
    attempt++;
    on.status({ kind: "reconnecting", attempt });
    retry = setT(() => {
      retry = null;
      void connect();
    }, retryDelayMs(attempt, random));
  };

  // Back online or back in view: if we're waiting to retry, go now.
  const resume = () => {
    if (stopped || connecting || ws) return;
    if (retry) clearT(retry);
    retry = null;
    void connect();
  };

  const keepAlive = () => {
    ping = setT(() => {
      if (stopped) return;
      if (ws?.readyState === 1) ws.send(JSON.stringify({ t: "ping" }));
      keepAlive();
    }, PING_MS);
  };

  async function connect() {
    if (stopped || connecting) return;
    connecting = true;
    let url: string;
    try {
      url = (await deps.ticket()).url;
    } catch (e) {
      connecting = false;
      // Refused by the API (not arrived, door closed, no Bunker for you): final.
      const err = e as { status?: number; message?: string };
      if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) return stop(err.message ?? "You can't go in there.");
      return schedule();
    }
    connecting = false;
    if (stopped) return;
    let sock: WsLike;
    try {
      sock = make(socketUrl(url));
    } catch {
      // The WebView refused to open it at all: try again like any other drop.
      return schedule();
    }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      attempt = 0;
      on.status({ kind: "live" });
    };
    sock.onmessage = (m) => {
      if (ws !== sock || typeof m.data !== "string") return;
      try {
        on.event(JSON.parse(m.data));
      } catch {
        // not JSON: ignore
      }
    };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = null;
      if (stopped) return;
      if (FINAL[e.code]) return stop(FINAL[e.code]!);
      schedule();
    };
  }

  on.status({ kind: "connecting" });
  keepAlive();
  stopListening = (deps.onResume ?? whenBack)(resume);
  void connect();

  return {
    send(msg: unknown): boolean {
      if (!ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    close() {
      const s = ws;
      stop("closed");
      ws = null;
      s?.close(1000, "bye");
    },
  };
}
