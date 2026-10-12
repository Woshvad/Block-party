import type { ModerationProvider, OddsProvider } from "@bp/core";
import type { Db } from "@bp/db";
import type { RoomsClient } from "./rooms-client";

// One job's outcome, with its name so a failure in the logs says which one.
export type CronResult = PromiseSettledResult<unknown> & { job: string };

// The minute cron: the bell, finished actions, Last Call, the Ratio prompt,
// real-trade settling, notifications, the daily pings every 15 minutes, the
// sweeps every 10 minutes, the odds poll that publishes the Slate and the
// NPCs' calls, and the AI moderation check over the queue (with the rooms, for
// room lines). One list for the Worker's scheduled() and the local Node
// server, so they can't drift apart. Every job runs even if another fails.
// Add a job as its own named entry.
export async function runMinute(
  db: Db,
  at: Date,
  deps: {
    odds?: OddsProvider;
    sender?: Parameters<typeof import("@bp/db").runNotificationBatch>[1];
    moderation?: ModerationProvider;
    rooms?: RoomsClient;
  },
): Promise<CronResult[]> {
  const { runBell, runNotificationBatch, finishDueActions, queueDailyPings, pollOdds, publishSlate, npcCalls, runLastCall, pickRatioPrompt, settleRealTrades } = await import("@bp/db");
  const jobs: Record<string, Promise<unknown>> = {
    bell: runBell(db),
    finishedActions: finishDueActions(db),
    lastCall: runLastCall(db, { now: at }),
    ratioPrompt: pickRatioPrompt(db, { now: at }),
    realTrades: settleRealTrades(db, { now: at }),
  };
  if (deps.sender) jobs.notifications = runNotificationBatch(db, deps.sender, { batch: 200 });
  if (at.getUTCMinutes() % 15 === 0) jobs.dailyPings = queueDailyPings(db, { now: at });
  // Every 10 minutes, the sweeps: rate-limit windows that started over a day ago
  // (none is longer, so they've ended) and sessions that ended over a week ago.
  if (at.getUTCMinutes() % 10 === 5) {
    const { RATE_LIMIT_MAX_WINDOW_SECONDS, sweepRateLimits, sweepSessions } = await import("@bp/db");
    jobs.rateLimitSweep = sweepRateLimits(db, new Date(at.getTime() - RATE_LIMIT_MAX_WINDOW_SECONDS * 1000));
    jobs.sessionSweep = sweepSessions(db, { now: at });
  }
  if (deps.odds) {
    // The Slate and the cast follow the poll whether or not it threw: a streak
    // day the poll couldn't grant is its own failure (retried by the next
    // poll), not a reason to hold back the day's Slate.
    const poll = pollOdds(db, deps.odds, { now: at });
    jobs.odds = poll;
    jobs.slate = poll.catch(() => undefined).then(() => publishSlate(db, { now: at })).then(() => npcCalls(db, { now: at }));
  }
  const moderation = deps.moderation;
  if (moderation) jobs.moderation = import("./moderation").then(({ runModerationJob }) => runModerationJob(db, moderation, deps.rooms ? { rooms: deps.rooms } : {}));
  const names = Object.keys(jobs);
  const settled = await Promise.allSettled(Object.values(jobs));
  return settled.map((r, i) => ({ ...r, job: names[i]! }));
}

// Logs every job that failed, by name, and says how many did. Nothing else
// reports a failing job: a bell that throws every minute would otherwise
// stop rent, settling and the Daily Close without a trace.
export function logCronFailures(results: CronResult[], log: (msg: string, extra: Record<string, unknown>) => void = (msg, extra) => console.error(msg, extra)): number {
  let failed = 0;
  for (const r of results) {
    if (r.status !== "rejected") continue;
    failed++;
    const e = r.reason as { stack?: unknown } | undefined;
    log(`cron job failed: ${r.job}`, { job: r.job, error: String(e?.stack ?? r.reason) });
  }
  return failed;
}
