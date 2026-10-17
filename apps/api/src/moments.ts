import { MOMENT_PLACES } from "@bp/core";
import type { Db } from "@bp/db";
import type { RoomsClient } from "./rooms-client";

type Log = (msg: string, extra: Record<string, unknown>) => void;

// The Watch Party's big moments, after a poll that polled: picked and
// recorded once (pickTowerMoments), then sent to every place with a big
// screen. Best effort: a moment the rooms don't take is logged and not sent
// again, and nothing here throws, so the odds job's result stays the poll's.
// The most important goes last, so it's the one the rooms keep for anyone
// who walks in over the next 2 minutes.
export async function announceMoments(db: Db, rooms: RoomsClient, at: Date, log: Log = (msg, extra) => console.warn(msg, extra)): Promise<{ picked: number; delivered: number }> {
  let picked;
  try {
    const { pickTowerMoments } = await import("@bp/db");
    picked = await pickTowerMoments(db, { now: at });
  } catch (e) {
    log("moments: picking failed", { error: String((e as Error)?.stack ?? e) });
    return { picked: 0, delivered: 0 };
  }
  let delivered = 0;
  for (const m of [...picked].reverse()) {
    for (const place of MOMENT_PLACES) {
      try {
        await rooms.moment(place, m);
        delivered++;
      } catch (e) {
        log(`moments: the rooms didn't take moment ${m.id}`, { id: m.id, marketId: m.marketId, place, error: String((e as Error)?.message ?? e) });
      }
    }
  }
  return { picked: picked.length, delivered };
}
