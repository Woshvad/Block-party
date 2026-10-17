import type { TowerMoment } from "@bp/core";
import { describe, expect, it } from "vitest";
import { MOMENT_TIMEOUT_MS, httpRoomsClient } from "../src/rooms-client";

function fake(routes: Record<string, (req: { url: string; init: RequestInit }) => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    return (routes[path] ?? (() => new Response("nope", { status: 404 })))({ url, init });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("the rooms Worker client", () => {
  it("asks for presence with the secret and an encoded place", async () => {
    const { f, calls } = fake({ "/internal/presence": () => Response.json({ here: true, copy: 2 }) });
    const c = httpRoomsClient({ url: "https://rooms.test", secret: "s".repeat(40), fetch: f });
    expect(await c.where("u1", "home:abc")).toBe(2);
    expect(calls[0]!.url).toBe("https://rooms.test/internal/presence?place=home%3Aabc&u=u1");
    expect((calls[0]!.init.headers as Record<string, string>)["x-internal-secret"]).toBe("s".repeat(40));
  });

  it("not here is null; evidence and takedown hit their routes", async () => {
    const { f, calls } = fake({
      "/internal/presence": () => Response.json({ here: false, copy: null }),
      "/internal/evidence": () => Response.json([{ id: "l", userId: "u", handle: "h", text: "t", at: 1 }]),
      "/internal/takedown": () => Response.json({ ok: true }),
    });
    const c = httpRoomsClient({ url: "https://rooms.test", secret: "s".repeat(40), fetch: f });
    expect(await c.where("u1", "diner")).toBeNull();
    expect((await c.evidence("diner", 1)).map((l) => l.text)).toEqual(["t"]);
    await c.takedown("diner", 1, "l");
    expect(calls.at(-1)!.init.method).toBe("POST");
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ lineId: "l" });
  });

  it("a failing Worker is an error, never a silent 'not here'", async () => {
    const { f } = fake({ "/internal/presence": () => new Response("down", { status: 503 }) });
    await expect(httpRoomsClient({ url: "https://rooms.test", secret: "s".repeat(40), fetch: f }).where("u", "diner")).rejects.toThrow(/503/);
  });

  const moment: TowerMoment = { id: "m1", kind: "swing", marketId: "0b7e8c1a-3f2d-4c5b-9a8e-7d6c5b4a3f2e", question: "Will Lagos FC win?", from: 41, to: 63, at: 1_800_000_000_000 };

  it("sends a moment to a place's screen as JSON, with the secret and a deadline", async () => {
    const { f, calls } = fake({ "/internal/moment": () => Response.json({ ok: true, copies: [0] }) });
    await httpRoomsClient({ url: "https://rooms.test", secret: "s".repeat(40), fetch: f }).moment("watch_party", moment);
    expect(calls[0]!.url).toBe("https://rooms.test/internal/moment?place=watch_party");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(moment);
    expect((calls[0]!.init.headers as Record<string, string>)["x-internal-secret"]).toBe("s".repeat(40));
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(MOMENT_TIMEOUT_MS).toBeLessThanOrEqual(5000); // short: the minute cron waits on it
  });

  it("a moment the Worker refuses, or doesn't answer in time, is an error the caller can log", async () => {
    const refused = fake({ "/internal/moment": () => Response.json({ error: "BAD_MOMENT" }, { status: 400 }) });
    await expect(httpRoomsClient({ url: "https://rooms.test", secret: "s".repeat(40), fetch: refused.f }).moment("watch_party", moment)).rejects.toThrow(/400/);
    // A Worker that never answers: the deadline gives up on it.
    const hung = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const started = Date.now();
    await expect(httpRoomsClient({ url: "https://rooms.test", secret: "s".repeat(40), fetch: hung, momentTimeoutMs: 50 }).moment("watch_party", moment)).rejects.toThrow(/time|abort/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
