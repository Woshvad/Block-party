import { type ModerationProvider, OPENAI_MODERATION_BATCH } from "@bp/core";
import { type Db, type FlaggedItem, runModerationBatch } from "@bp/db";
import type { RoomsClient } from "./rooms-client";

// What the AI check's verdict does outside the database, shared by the
// minute cron, POST /internal/moderation/run and staff's review so they
// can't drift apart. The database's own text (board, crew and DM posts,
// Ratio headlines, pitches, crew and resident names) comes down with the
// verdict, in runModerationBatch; room lines live in the rooms Worker.
export function takeDown(rooms?: RoomsClient) {
  return async (f: Pick<FlaggedItem, "kind" | "ref" | "text">) => {
    if (f.kind === "room" && rooms) {
      const [place, copy, lineId] = f.ref.split("#");
      // A room copy that has since emptied has no line left to take down.
      if (place && copy && lineId) await rooms.takedown(place, Number(copy), lineId).catch(() => undefined);
    }
  };
}

// The minute cron's share of the queue. Batches run one after another until
// the queue is empty, the time budget is spent or the provider fails; a
// failure ends the job for this minute, so an outage costs each item one of
// its 5 attempts a minute rather than all of them at once.
export const MODERATION_JOB = { budgetMs: 20_000, maxBatches: 20 } as const;

export async function runModerationJob(
  db: Db,
  provider: ModerationProvider,
  opts: { rooms?: RoomsClient; budgetMs?: number; maxBatches?: number; clock?: () => number } = {},
) {
  const clock = opts.clock ?? Date.now;
  const budgetMs = opts.budgetMs ?? MODERATION_JOB.budgetMs;
  const maxBatches = opts.maxBatches ?? MODERATION_JOB.maxBatches;
  const onFlagged = takeDown(opts.rooms);
  const started = clock();
  const total = { batches: 0, checked: 0, flagged: 0, failed: 0 };
  // loop-bound: at most maxBatches batches, and none starts once the budget is spent.
  while (total.batches < maxBatches && clock() - started < budgetMs) {
    const r = await runModerationBatch(db, provider, { onFlagged });
    total.batches++;
    total.checked += r.checked;
    total.flagged += r.flagged;
    total.failed += r.failed;
    // A short batch: the queue is empty, or the provider failed and checked nothing.
    if (r.checked < OPENAI_MODERATION_BATCH) break;
  }
  return total;
}
