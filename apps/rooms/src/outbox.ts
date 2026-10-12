// Room effects (Cozy, visits, lines for the moderation queue) wait here, in
// the room's own storage, until the API has them, so an API blip or a deploy
// loses nothing. They go oldest first, in batches. Each carries an id, unique
// to its room copy, that the API uses to apply it once however many times it
// arrives (a reply lost on the way back means the batch is sent again).
//
// Bounded: past OUTBOX.max waiting, the oldest are dropped (and logged). That
// only happens after the API has been unreachable for a long while.
//
// The backoff after a failed send (5 s, doubling to 5 minutes, jittered) is
// stored with the queue: a room naps after a few idle seconds and an empty
// one is evicted within minutes, and a backoff kept only in memory started
// over at 5 s every time, so thousands of rooms kept hammering a down API.

export const OUTBOX = {
  max: 1000,
  batch: 50,
  // The API refuses a body over 16 KB (maxBody in apps/api/src/app.ts), and
  // one room line can be about 8 KB, so a batch is cut by size too. The rest
  // of the 16 KB is room for the place, the copy and the JSON around them.
  maxBatchBytes: 12 * 1024,
  roundsPerDrain: 20, // batches per drain; the room's alarm sends the rest
  firstRetryMs: 5_000,
  maxRetryMs: 5 * 60_000,
};

// The part of Durable Object storage the outbox uses.
export type OutboxStorage = {
  get(keys: string[]): Promise<Map<string, unknown>>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<unknown>;
};

// ids head..tail-1 are waiting; after failed sends, the next try waits for retryAt.
type Meta = { head: number; tail: number; failures?: number; retryAt?: number | null };
const META = "outbox";
const fxKey = (id: number) => `fx:${String(id).padStart(12, "0")}`;
const CHUNK = 100; // storage takes at most 128 keys a call
const utf8 = new TextEncoder();

export class Outbox {
  private meta: Promise<Meta> | null = null;
  private sending: Promise<void> | null = null;

  constructor(
    private storage: OutboxStorage,
    private max = OUTBOX.max,
    // 0..1: where in the upper half of its window a retry lands, so rooms
    // that failed together don't all come back together.
    private jitter: () => number = Math.random,
  ) {}

  private load(): Promise<Meta> {
    if (!this.meta) {
      const p = this.storage.get([META]).then((m) => (m.get(META) as Meta | undefined) ?? { head: 0, tail: 0 });
      // A failed read is tried again next time, not remembered.
      p.catch(() => {
        if (this.meta === p) this.meta = null;
      });
      this.meta = p;
    }
    return this.meta;
  }

  // When to try again after a failed send (null: no failure pending).
  async retryAt(): Promise<number | null> {
    return (await this.load()).retryAt ?? null;
  }

  // After a failed send, wait for the retry time rather than trying again on
  // every new effect while the API is down.
  async due(now: number): Promise<boolean> {
    const at = await this.retryAt();
    return at === null || now >= at;
  }

  async waiting(): Promise<number> {
    const m = await this.load();
    return m.tail - m.head;
  }

  // Keeps effects to send. Returns how many old ones were dropped to stay
  // under the cap.
  async add(effects: ReadonlyArray<object>): Promise<number> {
    if (!effects.length) return 0;
    const m = await this.load();
    const entries: Record<string, unknown> = {};
    for (const fx of effects) {
      entries[fxKey(m.tail)] = { ...fx, id: String(m.tail) };
      m.tail++;
    }
    const over = Math.max(0, m.tail - m.head - this.max);
    const dropped: string[] = [];
    for (let i = 0; i < over; i++) dropped.push(fxKey(m.head + i));
    m.head += over;
    await this.write(entries);
    await this.storage.put({ [META]: { ...m } });
    await this.remove(dropped);
    if (over) console.error(`rooms: outbox full, dropped the ${over} oldest effects`);
    return over;
  }

  // Sends what's waiting. `post` sends one batch and resolves to the API's
  // HTTP status, or 0 when the API couldn't be reached. One drain at a time:
  // a second call gets the drain already under way.
  drain(post: (effects: unknown[]) => Promise<number>, now: () => number): Promise<void> {
    this.sending ??= this.send(post, now).finally(() => {
      this.sending = null;
    });
    return this.sending;
  }

  private async send(post: (effects: unknown[]) => Promise<number>, now: () => number) {
    const m = await this.load();
    let most = OUTBOX.batch; // effects per request; a 413 halves it
    // loop-bound: at most OUTBOX.roundsPerDrain batches, and it stops when nothing is waiting
    for (let round = 0; round < OUTBOX.roundsPerDrain && m.head < m.tail; round++) {
      const from = m.head;
      const keys = Array.from({ length: Math.min(m.tail, from + most) - from }, (_, i) => fxKey(from + i));
      const rows = await this.storage.get(keys);
      // Oldest first, as many as fit in one request, and always at least one.
      const batch: unknown[] = [];
      let bytes = 0;
      let to = from;
      for (const k of keys) {
        const fx = rows.get(k);
        const size = fx === undefined ? 0 : utf8.encode(JSON.stringify(fx)).length;
        if (batch.length && bytes + size > OUTBOX.maxBatchBytes) break;
        if (fx !== undefined) batch.push(fx);
        bytes += size;
        to++;
      }
      const status = batch.length ? await post(batch) : 200;
      // Too big for the API after all: send fewer at a time.
      if (status === 413 && batch.length > 1) {
        most = Math.max(1, Math.floor(batch.length / 2));
        continue;
      }
      const ok = status >= 200 && status < 300;
      // A 400 means the batch itself is malformed, and a 413 for a single
      // effect means it's too big on its own: neither will ever succeed.
      const hopeless = status === 400 || status === 413;
      if (!ok && !hopeless) {
        m.failures = (m.failures ?? 0) + 1;
        const wait = Math.min(OUTBOX.maxRetryMs, OUTBOX.firstRetryMs * 2 ** (m.failures - 1));
        m.retryAt = now() + Math.round(wait * (0.5 + this.jitter() / 2));
        await this.storage.put({ [META]: { ...m } });
        console.warn(`rooms: effects not delivered (${status || "unreachable"}); ${m.tail - m.head} waiting, retry in ${m.retryAt - now()} ms`);
        return;
      }
      if (!ok) console.error(`rooms: the API refused ${batch.length} effects (${status}); dropped them`);
      m.head = Math.max(m.head, to);
      m.failures = 0;
      m.retryAt = null;
      await this.storage.put({ [META]: { ...m } });
      await this.remove(keys.slice(0, to - from));
    }
  }

  private async write(entries: Record<string, unknown>) {
    const keys = Object.keys(entries);
    for (let i = 0; i < keys.length; i += CHUNK) await this.storage.put(Object.fromEntries(keys.slice(i, i + CHUNK).map((k) => [k, entries[k]])));
  }

  private async remove(keys: string[]) {
    for (let i = 0; i < keys.length; i += CHUNK) await this.storage.delete(keys.slice(i, i + CHUNK));
  }
}
