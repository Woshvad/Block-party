// Room effects (Cozy, visits, lines for the moderation queue) wait here, in
// the room's own storage, until the API has them, so an API blip or a deploy
// loses nothing. They go oldest first, in batches. Each carries an id, unique
// to its room copy, that the API uses to apply it once however many times it
// arrives (a reply lost on the way back means the batch is sent again).
//
// Bounded: past OUTBOX.max waiting, the oldest are dropped (and logged). That
// only happens after the API has been unreachable for a long while.

export const OUTBOX = {
  max: 1000,
  batch: 50,
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

type Meta = { head: number; tail: number }; // ids head..tail-1 are waiting
const META = "outbox";
const fxKey = (id: number) => `fx:${String(id).padStart(12, "0")}`;
const CHUNK = 100; // storage takes at most 128 keys a call

export class Outbox {
  private meta: Promise<Meta> | null = null;
  private sending: Promise<void> | null = null;
  private failures = 0;
  retryAt: number | null = null; // when to try again after a failed send

  constructor(
    private storage: OutboxStorage,
    private max = OUTBOX.max,
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

  // After a failed send, wait for the retry time rather than trying again on
  // every new effect while the API is down.
  due(now: number): boolean {
    return this.retryAt === null || now >= this.retryAt;
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
    // loop-bound: at most OUTBOX.roundsPerDrain batches, and it stops when nothing is waiting
    for (let round = 0; round < OUTBOX.roundsPerDrain && m.head < m.tail; round++) {
      const from = m.head;
      const to = Math.min(m.tail, from + OUTBOX.batch);
      const keys = Array.from({ length: to - from }, (_, i) => fxKey(from + i));
      const rows = await this.storage.get(keys);
      const batch = keys.map((k) => rows.get(k)).filter((x) => x !== undefined);
      const status = batch.length ? await post(batch) : 200;
      const ok = status >= 200 && status < 300;
      if (!ok && status !== 400) {
        this.failures++;
        this.retryAt = now() + Math.min(OUTBOX.maxRetryMs, OUTBOX.firstRetryMs * 2 ** (this.failures - 1));
        console.warn(`rooms: effects not delivered (${status || "unreachable"}); ${m.tail - m.head} waiting, retry in ${this.retryAt - now()} ms`);
        return;
      }
      // A 400 means the batch itself is malformed and never will succeed.
      if (!ok) console.error(`rooms: the API refused ${batch.length} effects as malformed; dropped them`);
      m.head = Math.max(m.head, to);
      await this.storage.put({ [META]: { ...m } });
      await this.remove(keys);
      this.failures = 0;
      this.retryAt = null;
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
