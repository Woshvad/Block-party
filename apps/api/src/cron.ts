import type { OddsProvider } from "@bp/core";
import type { Db } from "@bp/db";

// The minute cron: the bell, finished actions, Last Call, the Ratio prompt,
// real-trade settling, notifications, the daily pings every 15 minutes, and
// the odds poll that publishes the Slate and the NPCs' calls. One list for the
// Worker's scheduled() and the local Node server, so they can't drift apart.
// Every job runs even if another fails.
export async function runMinute(
  db: Db,
  at: Date,
  deps: { odds?: OddsProvider; sender?: Parameters<typeof import("@bp/db").runNotificationBatch>[1] },
): Promise<PromiseSettledResult<unknown>[]> {
  const { runBell, runNotificationBatch, finishDueActions, queueDailyPings, pollOdds, publishSlate, npcCalls, runLastCall, pickRatioPrompt, settleRealTrades } = await import("@bp/db");
  const jobs: Array<Promise<unknown>> = [runBell(db), finishDueActions(db), runLastCall(db, { now: at }), pickRatioPrompt(db, { now: at }), settleRealTrades(db, { now: at })];
  if (deps.sender) jobs.push(runNotificationBatch(db, deps.sender, { batch: 200 }));
  if (at.getUTCMinutes() % 15 === 0) jobs.push(queueDailyPings(db, { now: at }));
  if (deps.odds) jobs.push(pollOdds(db, deps.odds, { now: at }).then(() => publishSlate(db, { now: at })).then(() => npcCalls(db, { now: at })));
  return Promise.allSettled(jobs);
}
