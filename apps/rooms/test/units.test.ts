import { parseBlockedWords as apiParseBlockedWords } from "@bp/core";
import { describe, expect, it } from "vitest";
import { DIRECTORY_TTL_MS, type DirState, RESERVATION_MS, emptyDirectory, expire, headcounts, joined, left, present, reserve, synced, where } from "../src/directory";
import { OUTBOX, Outbox, type OutboxStorage } from "../src/outbox";
import { BUCKET, configProblems, parseBlockedWords, takeToken } from "../src/worker";

// The rooms' pure parts, on an explicit clock. The Worker around them runs
// in workerd in rooms.test.ts and hotpath.test.ts.
const T = 1_800_000_000_000;

describe("the directory's memory", () => {
  it("forgets anyone no room has confirmed within the TTL; a room's list renews them", () => {
    const s = emptyDirectory();
    joined(s, 0, "a", "c1", T);
    joined(s, 0, "b", null, T);
    expect(present(s, "a")).toBe(0);
    // The room confirms only a: b was a ghost (a deploy dropped b's socket).
    expect(synced(s, 0, [{ u: "a", crew: "c1" }], T + 60_000)).toEqual(["b"]);
    expect(present(s, "b")).toBeNull();
    expect(expire(s, T + 60_000 + DIRECTORY_TTL_MS)).toBe(false); // a was confirmed at +60 s
    expect(present(s, "a")).toBe(0);
    expect(expire(s, T + 60_001 + DIRECTORY_TTL_MS)).toBe(true); // and nobody since
    expect(present(s, "a")).toBeNull();
    expect(headcounts(s)).toEqual({ 0: 0 });
  });

  it("a room's list also seats people the directory had only reserved", () => {
    const s = emptyDirectory();
    reserve(s, "r", 1, null, T);
    expect(where(s, "r", T)).toBe(1);
    expect(present(s, "r")).toBeNull(); // a reservation isn't presence
    synced(s, 1, [{ u: "r", crew: null }], T + 1000);
    expect(s.reservations.r).toBeUndefined();
    expect(present(s, "r")).toBe(1);
    // An unconfirmed reservation lapses on its own.
    reserve(s, "x", 1, null, T);
    expect(expire(s, T + RESERVATION_MS)).toBe(true);
    expect(where(s, "x", T + RESERVATION_MS)).toBeNull();
  });

  it("'left' says whether there was anyone to remove", () => {
    const s = emptyDirectory();
    joined(s, 2, "a", null, T);
    expect(left(s, 2, "a")).toBe(true);
    expect(left(s, 2, "a")).toBe(false);
    expect(left(s, 9, "nobody")).toBe(false);
  });

  it("a directory saved in the old shape (plain lists) gets one TTL, then forgets", () => {
    const s = { copies: { 0: { members: ["old"], crews: {} } }, reservations: {} } as unknown as DirState;
    expect(expire(s, T)).toBe(true);
    expect(present(s, "old")).toBe(0);
    expire(s, T + DIRECTORY_TTL_MS + 1);
    expect(present(s, "old")).toBeNull();
  });
});

// A Durable Object's storage, as far as the outbox uses it.
function memoryStorage() {
  const data = new Map<string, unknown>();
  const storage: OutboxStorage = {
    get: async (keys) => new Map(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))])),
    put: async (entries) => {
      if (Object.keys(entries).length > 128) throw new Error("128 keys per call");
      for (const [k, v] of Object.entries(entries)) data.set(k, structuredClone(v));
    },
    delete: async (keys) => {
      if (keys.length > 128) throw new Error("128 keys per call");
      for (const k of keys) data.delete(k);
    },
  };
  return { data, storage };
}
const effects = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ kind: "moderate", n: from + i }));

describe("the effects outbox", () => {
  it("sends oldest first in batches, each effect with an id, and forgets what the API took", async () => {
    const { data, storage } = memoryStorage();
    const box = new Outbox(storage);
    await box.add(effects(3));
    await box.add(effects(OUTBOX.batch, 3));
    const sent: Array<Array<{ id: string; n: number }>> = [];
    await box.drain(async (b) => (sent.push(b as never), 200), () => T);
    expect(sent.map((b) => b.length)).toEqual([OUTBOX.batch, 3]);
    expect(sent.flat().map((x) => x.n)).toEqual(Array.from({ length: OUTBOX.batch + 3 }, (_, i) => i));
    expect(sent.flat().map((x) => x.id)).toEqual(Array.from({ length: OUTBOX.batch + 3 }, (_, i) => String(i)));
    expect(await box.waiting()).toBe(0);
    expect([...data.keys()]).toEqual(["outbox"]);
  });

  // No jitter: each retry lands at the end of its window.
  const latest = () => 1;

  it("keeps everything through failures, backing off, and a fresh outbox picks up where it was", async () => {
    const { storage } = memoryStorage();
    const box = new Outbox(storage, OUTBOX.max, latest);
    await box.add(effects(2));
    let status = 503;
    const posts: unknown[][] = [];
    const post = async (b: unknown[]) => (posts.push(b), status);
    await box.drain(post, () => T);
    expect(await box.retryAt()).toBe(T + OUTBOX.firstRetryMs);
    await box.drain(post, () => T);
    expect(await box.retryAt()).toBe(T + 2 * OUTBOX.firstRetryMs);
    status = 0; // unreachable counts the same
    for (let i = 0; i < 20; i++) await box.drain(post, () => T);
    expect(await box.retryAt()).toBe(T + OUTBOX.maxRetryMs);
    // A nap: a new outbox over the same storage still has both, under the same ids.
    const again = new Outbox(storage, OUTBOX.max, latest);
    expect(await again.waiting()).toBe(2);
    status = 200;
    const sent: Array<{ id: string }> = [];
    await again.drain(async (b) => (sent.push(...(b as never[])), 200), () => T);
    expect(sent.map((x) => x.id)).toEqual(["0", "1"]);
    expect(posts.every((b) => JSON.stringify(b) === JSON.stringify(posts[0]))).toBe(true); // every retry was the same batch
    expect(await again.retryAt()).toBeNull();
  });

  it("the backoff survives a nap or an eviction: a fresh outbox waits, and keeps doubling", async () => {
    const { storage } = memoryStorage();
    const box = new Outbox(storage, OUTBOX.max, latest);
    await box.add(effects(1));
    await box.drain(async () => 503, () => T);
    await box.drain(async () => 503, () => T);
    // The room naps: a new outbox over the same storage.
    const woken = new Outbox(storage, OUTBOX.max, latest);
    expect(await woken.retryAt()).toBe(T + 2 * OUTBOX.firstRetryMs);
    expect(await woken.due(T + OUTBOX.firstRetryMs)).toBe(false);
    expect(await woken.due(T + 2 * OUTBOX.firstRetryMs)).toBe(true);
    await woken.drain(async () => 503, () => T + 2 * OUTBOX.firstRetryMs);
    expect(await new Outbox(storage, OUTBOX.max, latest).retryAt()).toBe(T + 6 * OUTBOX.firstRetryMs); // the third failure: 4x
  });

  it("jitters each retry within the upper half of its window", async () => {
    const at = async (jitter: number) => {
      const box = new Outbox(memoryStorage().storage, OUTBOX.max, () => jitter);
      await box.add(effects(1));
      await box.drain(async () => 503, () => T);
      return (await box.retryAt())! - T;
    };
    expect([await at(0), await at(0.5), await at(1)]).toEqual([OUTBOX.firstRetryMs / 2, (OUTBOX.firstRetryMs * 3) / 4, OUTBOX.firstRetryMs]);
  });

  it("drops a batch the API calls malformed (400) instead of retrying it forever", async () => {
    const { storage } = memoryStorage();
    const box = new Outbox(storage);
    await box.add(effects(2));
    await box.drain(async () => 400, () => T);
    expect(await box.waiting()).toBe(0);
  });

  it("is bounded: past the cap the oldest go, and ids keep counting", async () => {
    const { data, storage } = memoryStorage();
    const box = new Outbox(storage, 5);
    expect(await box.add(effects(4))).toBe(0);
    expect(await box.add(effects(3, 4))).toBe(2);
    expect(await box.waiting()).toBe(5);
    expect(data.size).toBe(5 + 1);
    const sent: Array<{ id: string; n: number }> = [];
    await box.drain(async (b) => (sent.push(...(b as never[])), 200), () => T);
    expect(sent.map((x) => x.n)).toEqual([2, 3, 4, 5, 6]);
    expect(sent.map((x) => x.id)).toEqual(["2", "3", "4", "5", "6"]);
    // A big burst is written in chunks the storage accepts.
    const big = new Outbox(memoryStorage().storage, 1000);
    await big.add(effects(300));
    expect(await big.waiting()).toBe(300);
  });

  it("one drain at a time; effects added while it runs wait for the next", async () => {
    const { storage } = memoryStorage();
    const box = new Outbox(storage);
    await box.add(effects(1));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sent: number[] = [];
    const post = async (b: unknown[]) => {
      await gate;
      sent.push(...(b as Array<{ n: number }>).map((x) => x.n));
      return 200;
    };
    const first = box.drain(post, () => T);
    expect(box.drain(post, () => T)).toBe(first);
    await box.add(effects(1, 1));
    release();
    await first;
    expect(sent).toEqual([0, 1]); // the second was picked up by the next round of the same drain
    expect(await box.waiting()).toBe(0);
  });

  // The API refuses a request body over 16 KB with a 413 (maxBody in
  // apps/api/src/app.ts). A room line can be 2,000 characters of up to 4
  // bytes each, so a count-only batch of long lines would be refused every
  // time and hold up everything behind it.
  it("keeps every request under the API's 16 KB body limit, however long the lines", async () => {
    const { storage } = memoryStorage();
    const box = new Outbox(storage);
    const longest = (n: number) => ({ kind: "moderate", n, line: { id: `l${n}`, userId: crypto.randomUUID(), handle: "h".repeat(20), text: "\u{1F600}".repeat(2000), at: T } });
    await box.add(Array.from({ length: 12 }, (_, i) => longest(i)));
    await box.add(effects(30, 12)); // and small ones behind them
    const bodies: number[] = [];
    const sent: number[] = [];
    await box.drain(async (b) => {
      // The request the room sends, with the longest place name there can be.
      bodies.push(new TextEncoder().encode(JSON.stringify({ place: "x".repeat(64), copy: 999_999, effects: b })).length);
      sent.push(...(b as Array<{ n: number }>).map((x) => x.n));
      return 200;
    }, () => T);
    expect(sent).toEqual(Array.from({ length: 42 }, (_, i) => i));
    expect(Math.max(...bodies)).toBeLessThanOrEqual(16 * 1024);
    expect(await box.waiting()).toBe(0);
  });

  it("a 413 sends fewer at a time; one effect the API still won't take is dropped, not retried forever", async () => {
    const { storage } = memoryStorage();
    const box = new Outbox(storage);
    await box.add(effects(8));
    // An API that takes at most 2 effects a request, and never effect 5.
    const tries: number[][] = [];
    const taken: number[] = [];
    await box.drain(async (b) => {
      const ns = (b as Array<{ n: number }>).map((x) => x.n);
      tries.push(ns);
      if (ns.length > 2 || ns.includes(5)) return 413;
      taken.push(...ns);
      return 200;
    }, () => T);
    expect(taken).toEqual([0, 1, 2, 3, 4, 6, 7]);
    expect(tries.map((t) => t.length)).toEqual([8, 4, 2, 2, 2, 1, 1, 1, 1]);
    expect(await box.waiting()).toBe(0);
    expect(await box.retryAt()).toBeNull();
  });
});

describe("the per-socket bucket", () => {
  it("lets a burst of BUCKET.size through, then refills at BUCKET.perSecond", () => {
    let b = takeToken(undefined, T)!;
    let taken = 1;
    // loop-bound: stops at the first refusal, and the bucket only holds BUCKET.size
    while (takeToken(b, T)) {
      b = takeToken(b, T)!;
      taken++;
    }
    expect(taken).toBe(BUCKET.size);
    expect(takeToken(b, T)).toBeNull();
    expect(takeToken(b, T + 900 / BUCKET.perSecond)).toBeNull();
    expect(takeToken(b, T + 1001 / BUCKET.perSecond)).not.toBeNull();
    expect(takeToken(b, T + 3_600_000)!.tokens).toBe(BUCKET.size - 1); // never more than a full bucket
  });
});

describe("BLOCKED_WORDS", () => {
  it("is read exactly as the API reads it", () => {
    expect(parseBlockedWords).toBe(apiParseBlockedWords);
    // Symbol-only entries go: kept, "@" or "$" would read as a letter.
    expect(parseBlockedWords(" rugpull, honeypot\r\nScamCoin\n\n,  ,@,$$,rugpull")).toEqual(["rugpull", "honeypot", "scamcoin"]);
    expect(parseBlockedWords(undefined)).toEqual([]);
    expect(parseBlockedWords("")).toEqual([]);
  });
});

describe("the rooms config check", () => {
  const good = { TICKET_SECRET: "t".repeat(32), INTERNAL_SECRET: "i".repeat(40) };
  it("names each missing, short or placeholder secret, never its value", () => {
    expect(configProblems(good)).toEqual([]);
    expect(configProblems({})).toEqual(["TICKET_SECRET is not set", "INTERNAL_SECRET is not set"]);
    expect(configProblems({ ...good, TICKET_SECRET: "short" })).toEqual(["TICKET_SECRET must be 32+ characters"]);
    const placeholder = "replace-me-with-a-long-random-secret-value";
    expect(configProblems({ ...good, INTERNAL_SECRET: placeholder })).toEqual(["INTERNAL_SECRET is still the .env.example placeholder"]);
    expect(JSON.stringify(configProblems({ ...good, TICKET_SECRET: "short" }))).not.toContain("short\"");
  });
});
