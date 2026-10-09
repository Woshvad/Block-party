import { describe, expect, it } from "vitest";
import { httpRoomsClient } from "../src/rooms-client";

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
});
