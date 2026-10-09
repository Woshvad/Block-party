import { describe, expect, it } from "vitest";
import { ApiError, createApi, memoryTokenStore } from "../src/api";

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
