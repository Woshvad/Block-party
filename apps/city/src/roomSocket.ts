// One live connection to a room: a fresh ticket per attempt (they last 60 s),
// a ping to keep it warm, and reconnects with backoff. Some closes are final:
// another tab took over (4000) or the room refused us (4001); reconnecting
// would just fight the other tab or hit the same wall, so we stop and say why.

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
};

export const MAX_ATTEMPTS = 8;
export const PING_MS = 25_000;
export const backoffMs = (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));

const FINAL: Record<number, string> = {
  4000: "You opened this room somewhere else.",
  4001: "The room wouldn't let you in.",
};

export function openRoomSocket(deps: RoomSocketDeps, on: { event: (ev: unknown) => void; status: (s: SocketStatus) => void }) {
  const make = deps.makeSocket ?? ((url: string) => new WebSocket(url) as unknown as WsLike);
  const setT = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let ws: WsLike | null = null;
  let stopped = false;
  let attempt = 0;
  let ping: unknown = null;
  let retry: unknown = null;

  const stop = (reason: string) => {
    if (stopped) return;
    stopped = true;
    if (ping) clearT(ping);
    if (retry) clearT(retry);
    on.status({ kind: "stopped", reason });
  };

  const schedule = () => {
    if (stopped) return;
    attempt++;
    if (attempt > MAX_ATTEMPTS) return stop("Lost the connection to the room.");
    on.status({ kind: "reconnecting", attempt });
    retry = setT(() => void connect(), backoffMs(attempt));
  };

  const keepAlive = () => {
    ping = setT(() => {
      if (stopped || !ws) return;
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: "ping" }));
      keepAlive();
    }, PING_MS);
  };

  async function connect() {
    if (stopped) return;
    let url: string;
    try {
      url = (await deps.ticket()).url;
    } catch (e) {
      // Refused by the API (not arrived, door closed, no Bunker for you): final.
      const err = e as { status?: number; message?: string };
      if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) return stop(err.message ?? "You can't go in there.");
      return schedule();
    }
    if (stopped) return;
    const sock = make(url);
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
