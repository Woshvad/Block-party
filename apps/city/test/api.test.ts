import { describe, expect, it } from "vitest";
import { ApiError, createApi, memoryTokenStore } from "../src/api";
import { outcomeUnknown } from "../src/actionKeys";

type Seen = { url: string; init: RequestInit };

function server(reply: (s: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const s = { url, init };
    seen.push(s);
    return reply(s);
  }) as unknown as typeof fetch;
  return { seen, f };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("api client", () => {
  it("sends the session and stores a new one on sign-in", async () => {
    const store = memoryTokenStore();
    const s = server(() => json(201, { userId: "u", sessionToken: "bps_new", status: "guest" }));
    const api = createApi({ base: "http://x/", store, fetch: s.f });
    await api.guest();
    expect(store.get()).toBe("bps_new");
    expect(s.seen[0]!.url).toBe("http://x/v1/auth/guest");
    expect(JSON.parse(String(s.seen[0]!.init.body))).toEqual({ ageAck: true });
    await api.me().catch(() => {});
    expect((s.seen[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer bps_new");
    expect((s.seen[1]!.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  it("turns the API's error body into ApiError with code and field", async () => {
    const s = server(() => json(409, { error: { code: "HANDLE_TAKEN", message: "that handle is taken", field: "handle", requestId: "r" } }));
    const api = createApi({ base: "http://x", store: memoryTokenStore("t"), fetch: s.f });
    const e = await api.moveIn({} as never).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect([e.status, e.code, e.message, e.field]).toEqual([409, "HANDLE_TAKEN", "that handle is taken", "handle"]);
  });

  it("forgets a dead session on 401, and only on 401", async () => {
    const store = memoryTokenStore("t");
    const api = createApi({ base: "http://x", store, fetch: server(() => json(403, { error: { code: "RESTRICTED", message: "no" } })).f });
    await api.me().catch(() => {});
    expect(store.get()).toBe("t");
    const api2 = createApi({ base: "http://x", store, fetch: server(() => json(401, { error: { code: "UNAUTHENTICATED", message: "sign in first" } })).f });
    await api2.me().catch(() => {});
    expect(store.get()).toBeNull();
  });

  it("a late 401 for an old session never erases a newer one", async () => {
    // A slow request goes out with session A; a sign-in meanwhile stores B;
    // then the old request comes back 401. B must survive.
    const store = memoryTokenStore("bps_a");
    let answer!: (r: Response) => void;
    const api = createApi({ base: "http://x", store, fetch: server(() => new Promise<Response>((r) => (answer = r))).f });
    const slow = api.me().catch((e) => e.status);
    await Promise.resolve();
    store.set("bps_b");
    answer(json(401, { error: { code: "INVALID_SESSION", message: "sign in again" } }));
    expect(await slow).toBe(401);
    expect(store.get()).toBe("bps_b");
  });

  it("gives up on a stalled request with a status-0 TIMEOUT", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const api = createApi({ base: "http://x", store: memoryTokenStore("t"), fetch: hang, timeoutMs: 20 });
    expect(await api.me().catch((e) => [e.constructor.name, e.status, e.code])).toEqual(["ApiError", 0, "TIMEOUT"]);
  });

  it("staff rename a handle, and the resident's OK on the notice, go where the API expects", async () => {
    const s = server(() => json(200, { ok: true }));
    const api = createApi({ base: "http://x", store: memoryTokenStore("t"), fetch: s.f });
    await api.renameHandle("u/1", { reason: "Your handle named a real person.", from: "old_one" });
    expect([s.seen[0]!.url, s.seen[0]!.init.method]).toEqual(["http://x/v1/staff/residents/u%2F1/handle", "POST"]);
    expect(JSON.parse(String(s.seen[0]!.init.body))).toEqual({ reason: "Your handle named a real person.", from: "old_one" });
    await api.seeHandleNotice("n1");
    expect([s.seen[1]!.url, s.seen[1]!.init.method, s.seen[1]!.init.body]).toEqual(["http://x/v1/resident/handle-notice/n1/seen", "POST", undefined]);
  });

  it("takes a 204 as done, and only a 204 may be empty", async () => {
    const s = server(() => new Response(null, { status: 204 }));
    const api = createApi({ base: "http://x", store: memoryTokenStore("t"), fetch: s.f });
    expect(await api.notificationOpened("4f0c2a8e-1d7b-4c3e-9a51-0b6f2d9e7c11")).toBeNull();
    expect(s.seen[0]!.url).toBe("http://x/v1/notifications/4f0c2a8e-1d7b-4c3e-9a51-0b6f2d9e7c11/opened");
    expect(s.seen[0]!.init.method).toBe("POST");
  });

  it("the Daily Close is null only when there's no paper (404), and a failure otherwise", async () => {
    const none = createApi({ base: "http://x", store: memoryTokenStore("t"), fetch: server(() => json(404, { error: { code: "NOT_FOUND", message: "no paper for that day" } })).f });
    expect(await none.dailyClose("2026-10-10")).toBeNull();
    const down = createApi({ base: "http://x", store: memoryTokenStore("t"), fetch: server(() => json(500, { error: { code: "INTERNAL", message: "something went wrong" } })).f });
    expect(await down.dailyClose("2026-10-10").catch((e) => e.status)).toBe(500);
  });

  it("network failures, HTML error pages and empty replies are all ApiErrors", async () => {
    const offline = createApi({ base: "http://x", store: memoryTokenStore(), fetch: (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch });
    expect(await offline.me().catch((e) => e.code)).toBe("OFFLINE");
    const html = createApi({ base: "http://x", store: memoryTokenStore(), fetch: server(() => new Response("<h1>502</h1>", { status: 502 })).f });
    expect(await html.me().catch((e) => [e.constructor.name, e.code])).toEqual(["ApiError", "HTTP_502"]);
    const empty = createApi({ base: "http://x", store: memoryTokenStore(), fetch: server(() => new Response("", { status: 200 })).f });
    expect(await empty.me().catch((e) => e.code)).toBe("BAD_REPLY");
    const junk = createApi({ base: "http://x", store: memoryTokenStore(), fetch: server(() => json(500, { error: { code: 7, message: null } })).f });
    expect(await junk.me().catch((e) => [e.code, e.message])).toEqual(["HTTP_500", "something went wrong"]);
  });

  it("a JSON null is an answer, not an unreadable reply (no Mod Shift running)", async () => {
    // GET /v1/shifts/current answers 200 with the body `null` when nothing is running.
    const api = createApi({ base: "http://x", store: memoryTokenStore("t"), fetch: server(() => new Response("null", { status: 200 })).f });
    expect(await api.currentShift()).toBeNull();
    expect(await api.ratioPair()).toBeNull();
  });

  it("a 2xx whose body never arrives is status 0: the work may be done, so the key is kept", async () => {
    // The headers come, then the body read fails (the deadline fired mid-body).
    const cut = server(() => {
      const body = new ReadableStream({
        start(c) {
          c.error(new DOMException("The operation timed out.", "TimeoutError"));
        },
      });
      return new Response(body, { status: 200 });
    });
    const api = createApi({ base: "http://x", store: memoryTokenStore("t"), fetch: cut.f });
    const e = await api.pot(500, "key-1").catch((x) => x);
    expect([e.constructor.name, e.status]).toEqual(["ApiError", 0]);
    expect(outcomeUnknown(e)).toBe(true);
    // A refusal whose body is cut keeps its own status: nothing happened.
    const refused = server(() => new Response(new ReadableStream({ start: (c) => c.error(new Error("reset")) }), { status: 409 }));
    const e2 = await createApi({ base: "http://x", store: memoryTokenStore("t"), fetch: refused.f })
      .me()
      .catch((x) => x);
    expect([e2.status, e2.code]).toEqual([409, "HTTP_409"]);
  });

  it("says it's the Mini App on every request when told to, and not otherwise", async () => {
    const s = server(() => json(200, {}));
    await createApi({ base: "http://x", store: memoryTokenStore("t"), fetch: s.f, client: "telegram-mini-app" }).me();
    await createApi({ base: "http://x", store: memoryTokenStore("t"), fetch: s.f }).me();
    expect((s.seen[0]!.init.headers as Record<string, string>)["x-client"]).toBe("telegram-mini-app");
    expect((s.seen[1]!.init.headers as Record<string, string>)["x-client"]).toBeUndefined();
  });

  it("escapes handles in the path", async () => {
    const s = server(() => json(200, { available: true }));
    const api = createApi({ base: "http://x", store: memoryTokenStore("t"), fetch: s.f });
    await api.handleAvailable("../me?x=1");
    expect(s.seen[0]!.url).toBe("http://x/v1/handles/..%2Fme%3Fx%3D1/available");
  });
});
