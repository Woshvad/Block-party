import type { OddsProvider } from "@bp/core";
import type { Db } from "@bp/db";

// One job's outcome, with its name so a failure in the logs says which one.
export type CronResult = PromiseSettledResult<unknown> & { job: string };

// The minute cron: the bell, finished actions, Last Call, the Ratio prompt,
// real-trade settling, notifications, the daily pings every 15 minutes, and
// the odds poll that publishes the Slate and the NPCs' calls. One list for the
// Worker's scheduled() and the local Node server, so they can't drift apart.
// Every job runs even if another fails. Add a job as its own named entry.
export async function runMinute(
  db: Db,
  at: Date,
  deps: { odds?: OddsProvider; sender?: Parameters<typeof import("@bp/db").runNotificationBatch>[1] },
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
  if (deps.odds) jobs.odds = pollOdds(db, deps.odds, { now: at }).then(() => publishSlate(db, { now: at })).then(() => npcCalls(db, { now: at }));
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
