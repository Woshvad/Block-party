import { describe, expect, it } from "vitest";
import { ModerationUnavailable, OPENAI_MODERATION_BATCH, openAiModeration } from "../src";

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (body: { input: string[]; model: string }) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(JSON.parse(String(init.body)));
  }) as unknown as typeof fetch;
  return { f, calls };
}
const ok = (results: unknown) => new Response(JSON.stringify({ id: "modr-1", results }), { status: 200, headers: { "content-type": "application/json" } });

describe("OpenAI moderation adapter", () => {
  it("sends one batched request with the key and model, and maps results in order", async () => {
    const { f, calls } = fakeFetch((b) => ok(b.input.map((t) => ({ flagged: t.includes("bad"), categories: { harassment: t.includes("bad"), violence: false } }))));
    const p = openAiModeration({ apiKey: "sk-test", fetch: f });
    expect(await p.classify(["gm", "you bad", "hi"])).toEqual([
      { flagged: false, categories: [] },
      { flagged: true, categories: ["harassment"] },
      { flagged: false, categories: [] },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/moderations");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ model: "omni-moderation-latest", input: ["gm", "you bad", "hi"] });
  });

  it("no input, no call", async () => {
    const { f, calls } = fakeFetch(() => ok([]));
    expect(await openAiModeration({ apiKey: "k", fetch: f }).classify([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("refuses oversized batches", async () => {
    const { f } = fakeFetch(() => ok([]));
    await expect(openAiModeration({ apiKey: "k", fetch: f }).classify(Array(OPENAI_MODERATION_BATCH + 1).fill("x"))).rejects.toThrow(RangeError);
  });

  it.each([
    ["rate limited", () => new Response("slow", { status: 429, headers: { "retry-after": "20" } })],
    ["server error", () => new Response("oops", { status: 500 })],
    ["bad key", () => new Response("no", { status: 401 })],
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["missing results", () => ok(undefined)],
    ["too few results", () => ok([{ flagged: false, categories: {} }])],
    ["flagged not a boolean", () => ok([{ flagged: "no", categories: {} }, { flagged: false, categories: {} }])],
    ["network down", () => Promise.reject(new TypeError("fetch failed"))],
  ])("%s: throws, never pretends it's clean", async (_n, respond) => {
    const { f } = fakeFetch(respond as () => Response);
    const err = await openAiModeration({ apiKey: "k", fetch: f }).classify(["a", "b"]).catch((e) => e);
    expect(err).toBeInstanceOf(ModerationUnavailable);
  });

  it("passes on Retry-After", async () => {
    const { f } = fakeFetch(() => new Response("", { status: 429, headers: { "retry-after": "17" } }));
    const err = (await openAiModeration({ apiKey: "k", fetch: f }).classify(["a"]).catch((e) => e)) as ModerationUnavailable;
    expect(err.retryAfterSeconds).toBe(17);
    expect(err.status).toBe(429);
  });
});
