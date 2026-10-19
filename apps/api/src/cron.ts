import type { ModerationProvider, OddsProvider } from "@bp/core";
import type { Db } from "@bp/db";
import type { RoomsClient } from "./rooms-client";

// One job's outcome, with its name so a failure in the logs says which one.
export type CronResult = PromiseSettledResult<unknown> & { job: string };

// Each minute's pushes: 25 a second at most (Telegram takes about 30 from a
// bot), 6 in flight, and no new one after 45 seconds, so a slow Telegram
// can't run one minute into the next. 600 a minute sends a 22:00 "Bell in 2h"
// to about 18,000 residents inside its half hour (it was 200 a minute, one at
// a time); past that the rest expire. Kept under 1,000 Telegram calls a run,
// a Worker's subrequest limit.
export const PUSH_RUN = { batch: 600, concurrency: 6, perSecond: 25, budgetMs: 45_000 } as const;

// The minute cron: the bell, finished actions, finished Mod Shifts' pings,
// Last Call, the Ratio prompt, real-trade settling, notifications, the daily,
// away-shift and bell-in-2h pings every 15 minutes, the sweeps every 10
// minutes, the odds poll that publishes the Slate and the
// NPCs' calls and sends the Watch Party its big moments (with the rooms), and
// the AI moderation check over the queue (with the rooms, for room lines). One list for the Worker's scheduled() and the local Node
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
  const { runBell, runNotificationBatch, finishDueActions, queueShiftPings, queueDailyPings, queueAwayShiftPings, queueBellPings, pollOdds, publishSlate, npcCalls, runLastCall, pickRatioPrompt, settleRealTrades } =
    await import("@bp/db");
  const jobs: Record<string, Promise<unknown>> = {
    bell: runBell(db),
    finishedActions: finishDueActions(db),
    shiftPings: queueShiftPings(db, { now: at }),
    lastCall: runLastCall(db, { now: at }),
    ratioPrompt: pickRatioPrompt(db, { now: at }),
    realTrades: settleRealTrades(db, { now: at }),
  };
  if (deps.sender) jobs.notifications = runNotificationBatch(db, deps.sender, PUSH_RUN);
  if (at.getUTCMinutes() % 15 === 0) {
    jobs.dailyPings = queueDailyPings(db, { now: at });
    jobs.awayShiftPings = queueAwayShiftPings(db, { now: at });
    jobs.bellPings = queueBellPings(db, { now: at }); // does nothing outside the two hours before the bell
  }
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
    // A poll that polled may have brought big moments for the Watch Party.
    // Best effort, and only with the rooms to send them to: the odds job's
    // result is the poll's whatever becomes of them.
    const rooms = deps.rooms;
    jobs.odds = rooms
      ? poll.then(async (r) => {
          if (r.ok && !r.skipped) await (await import("./moments")).announceMoments(db, rooms, at);
          return r;
        })
      : poll;
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
