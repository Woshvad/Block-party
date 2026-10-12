import { describe, expect, it } from "vitest";
import { ActionKeys, outcomeUnknown } from "../src/actionKeys";
import { ApiError, createApi, memoryTokenStore } from "../src/api";

// Numbered keys, so a test can say which one went out.
const counter = () => {
  let n = 0;
  return () => `key-${++n}`;
};
const fail = (e: unknown) => () => Promise.reject(e);

// Sends once with `outcome`, then once more, and returns the two keys used.
async function twoTaps(outcome: (key: string) => Promise<unknown>) {
  const keys = new ActionKeys(counter());
  const used: string[] = [];
  await keys.send("pot:500", (k) => (used.push(k), outcome(k))).catch(() => {});
  await keys.send("pot:500", async (k) => void used.push(k));
  return used;
}

describe("idempotency keys", () => {
  it("a success is final: the next tap is a new action with a new key", async () => {
    expect(await twoTaps(async () => "ok")).toEqual(["key-1", "key-2"]);
  });

  it("no reply, a timeout or a 5xx keeps the key, so the retry can't charge twice", async () => {
    expect(await twoTaps(fail(new ApiError(0, "OFFLINE", "can't reach the city right now")))).toEqual(["key-1", "key-1"]);
    expect(await twoTaps(fail(new ApiError(0, "TIMEOUT", "the city is taking too long to answer")))).toEqual(["key-1", "key-1"]);
    expect(await twoTaps(fail(new ApiError(502, "HTTP_502", "something went wrong")))).toEqual(["key-1", "key-1"]);
    expect(await twoTaps(fail(new TypeError("unexpected")))).toEqual(["key-1", "key-1"]);
  });

  it("a refusal (4xx) is final: nothing happened, the next tap gets a new key", async () => {
    expect(await twoTaps(fail(new ApiError(409, "INSUFFICIENT_FUNDS", "not enough GM")))).toEqual(["key-1", "key-2"]);
    expect(await twoTaps(fail(new ApiError(429, "RATE_LIMITED", "slow down")))).toEqual(["key-1", "key-2"]);
  });

  it("each action keeps its own key", async () => {
    const keys = new ActionKeys(counter());
    const used: Record<string, string[]> = { bike: [], bus: [] };
    await keys.send("bike", (k) => (used.bike!.push(k), Promise.reject(new ApiError(0, "OFFLINE", "x")))).catch(() => {});
    await keys.send("bus", async (k) => void used.bus!.push(k));
    await keys.send("bike", async (k) => void used.bike!.push(k));
    expect(used).toEqual({ bike: ["key-1", "key-1"], bus: ["key-2"] });
  });

  it("passes the answer and the error through unchanged", async () => {
    const keys = new ActionKeys(counter());
    expect(await keys.send("x", async () => 42)).toBe(42);
    const e = new ApiError(409, "NO", "no");
    expect(await keys.send("x", fail(e)).catch((x) => x)).toBe(e);
  });

  it("knows which failures leave the outcome unknown", () => {
    expect([0, 500, 503].map((s) => outcomeUnknown(new ApiError(s, "X", "x")))).toEqual([true, true, true]);
    expect([400, 401, 404, 409, 429].map((s) => outcomeUnknown(new ApiError(s, "X", "x")))).toEqual([false, false, false, false, false]);
  });

  it("end to end: the deposit commits, the reply is lost, the retry is replayed, not charged again", async () => {
    // A fake API that dedupes by Idempotency-Key, like the real ledger, and
    // drops the reply to the first request after committing it.
    const seen = new Map<string, unknown>();
    let charges = 0;
    let dropNext = true;
    const f = (async (_url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)["idempotency-key"]!;
      if (!seen.has(key)) {
        charges += 1;
        seen.set(key, { ok: true });
      }
      if (dropNext) {
        dropNext = false;
        throw new TypeError("Failed to fetch");
      }
      return new Response(JSON.stringify(seen.get(key)), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createApi({ base: "http://x", store: memoryTokenStore("t"), fetch: f });
    const keys = new ActionKeys();
    const first = await keys.send("500", (k) => api.pot(500, k)).catch((e) => e.code);
    expect(first).toBe("OFFLINE");
    expect(await keys.send("500", (k) => api.pot(500, k))).toEqual({ ok: true });
    expect(charges).toBe(1);
  });
});
