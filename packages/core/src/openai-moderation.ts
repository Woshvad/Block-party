// The AI moderation check, behind an interface so tests and other providers
// can stand in. OpenAI's moderation endpoint is free; Perspective API shuts at
// the end of 2026, so the plan rules it out.

export type ModerationResult = { flagged: boolean; categories: string[] };

export interface ModerationProvider {
  // One result per input, in order. Throws if the check couldn't run; a
  // failed check is never treated as clean.
  classify(texts: string[]): Promise<ModerationResult[]>;
}

export class ModerationUnavailable extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`moderation unavailable (${status})`);
    this.name = "ModerationUnavailable";
  }
}

export const OPENAI_MODERATION_BATCH = 32;

// How long one check may take, body included. The cron runs it inside the
// transaction that holds its batch, so a stalled connection must not hold
// those locks (and that minute's other jobs) for as long as the platform
// lets a fetch hang.
export const OPENAI_MODERATION_TIMEOUT_MS = 10_000;

export function openAiModeration(opts: { apiKey: string; fetch?: typeof fetch; model?: string; url?: string; timeoutMs?: number }): ModerationProvider {
  const doFetch = opts.fetch ?? fetch;
  return {
    async classify(texts) {
      if (texts.length === 0) return [];
      if (texts.length > OPENAI_MODERATION_BATCH) throw new RangeError(`at most ${OPENAI_MODERATION_BATCH} texts per call`);
      let res: Response;
      try {
        res = await doFetch(opts.url ?? "https://api.openai.com/v1/moderations", {
          method: "POST",
          headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: opts.model ?? "omni-moderation-latest", input: texts }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? OPENAI_MODERATION_TIMEOUT_MS),
        });
      } catch {
        throw new ModerationUnavailable(0, null); // network down, or no answer in time
      }
      if (!res.ok) {
        const ra = Number(res.headers.get("retry-after"));
        throw new ModerationUnavailable(res.status, Number.isFinite(ra) && ra > 0 ? ra : null);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ModerationUnavailable(res.status, null);
      }
      const results = (body as { results?: unknown })?.results;
      if (!Array.isArray(results) || results.length !== texts.length) throw new ModerationUnavailable(res.status, null);
      return results.map((r) => {
        const cats = (r as { categories?: Record<string, unknown> })?.categories ?? {};
        const flagged = (r as { flagged?: unknown })?.flagged;
        if (typeof flagged !== "boolean") throw new ModerationUnavailable(res.status, null);
        return { flagged, categories: Object.entries(cats).filter(([, v]) => v === true).map(([k]) => k).sort() };
      });
    },
  };
}
