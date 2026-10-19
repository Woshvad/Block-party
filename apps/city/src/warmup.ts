import { CAST, WARMUP } from "@bp/core";
import type { Warmup, WarmupEntry, WarmupSide, WarmupStamp } from "./api";
import { until } from "./clock";

// How the warm-up card at the Tower door reads: pure, so every line is tested.

// The Contrarian's line, word for word from the plan.
export const CONTRARIAN_LINE = "Bitcoin. Up or down in the next 15 minutes? Free call, ser.";
export const CONTRARIAN = { name: CAST.contrarian.name, label: CAST.contrarian.label };

export const SIDE_LABEL: Record<WarmupSide, string> = { up: "UP", down: "DOWN" };
export const STAMP_LABEL: Record<WarmupStamp, string> = { called_it: "CALLED IT", rekt: "REKT", void: "VOID" };

const MIN = 60_000;
// A settled warm-up's reel stays on the card for a day.
const REEL_SHOWS_MS = 24 * 60 * MIN;

export type ReelLine = { text: string; tone: "good" | "bad" | "plain" };

// The mini-reel, one line at a time (the card plays them about 2.5 seconds
// apart): what Bitcoin did, your stamp, how the window's newcomers did, and
// how the bot got on. Null until it has settled.
export function reelLines(e: WarmupEntry): ReelLine[] | null {
  const r = e.reel;
  if (!r || !e.stamp) return null;
  const you = `You called ${SIDE_LABEL[e.side]}.`;
  return [
    r.voided || !r.result ? { text: "This window was called off: a 50/50 void.", tone: "plain" } : { text: `Bitcoin went ${SIDE_LABEL[r.result]}.`, tone: "plain" },
    e.stamp === "called_it"
      ? { text: `${you} CALLED IT.`, tone: "good" }
      : e.stamp === "rekt"
        ? { text: `${you} REKT. A free Copium is yours.`, tone: "bad" }
        : { text: `${you} VOID: nobody wins, nobody loses.`, tone: "plain" },
    { text: windowLine(r.newcomers, r.calledIt, r.voided), tone: "plain" },
    { text: `${r.bot.name} called ${SIDE_LABEL[r.bot.side]}: ${STAMP_LABEL[r.bot.stamp]}.`, tone: "plain" },
  ];
}

function windowLine(newcomers: number, calledIt: number, voided: boolean): string {
  if (newcomers <= 1) return "Just you in this window.";
  if (voided) return `${newcomers} newcomers in this window.`;
  return `${calledIt} of ${newcomers} newcomers called it.`;
}

// The Rookie Bell: everyone else who called the same window.
export function newcomersLine(n: number): string {
  if (!Number.isSafeInteger(n) || n <= 1) return "Just you in this window so far. NOTHING-9000 called DOWN, as always.";
  return `${n} newcomers in this window. NOTHING-9000 called DOWN, as always.`;
}

export type WarmupView = {
  // UP and DOWN, while a window takes calls and you have one today.
  call: { closesIn: string; left: number } | null;
  // Your receipt while the window runs and its result comes in.
  waiting: { side: string; settles: string; newcomers: string } | null;
  // Your latest warm-up's reel, for a day after it settles.
  reel: ReelLine[] | null;
  // When there's nothing to call right now.
  next: string | null;
  fallback: { id: string; question: string } | null;
  note: string | null;
  credit: string | null;
};

// The card, or null for none: switched off, or nothing to call and nothing
// recent to show.
export function warmupView(w: Warmup | null | undefined, now: number): WarmupView | null {
  if (!w) return null;
  const latest = w.mine[0];
  const waiting = latest && !latest.stamp ? latest : null;
  const settled = latest?.stamp && latest.settledAt && now - Date.parse(latest.settledAt) < REEL_SHOWS_MS ? latest : null;
  if (!w.eligible && !waiting && !settled) return null;
  const callable = w.eligible && w.window && Date.parse(w.window.entryClosesAt) > now ? w.window : null;
  const ends = waiting ? Date.parse(waiting.endsAt) : NaN;
  return {
    call: callable ? { closesIn: until(callable.entryClosesAt, now), left: w.left } : null,
    waiting: waiting
      ? {
          side: SIDE_LABEL[waiting.side],
          settles: ends > now ? `Settles in about ${until(waiting.endsAt, now)}` : "Settling: the result lands a minute or two after the window closes.",
          newcomers: newcomersLine(waiting.newcomers),
        }
      : null,
    reel: settled ? reelLines(settled) : null,
    next: w.eligible && !callable ? (w.feed.live ? `Next window opens in ${until(w.nextWindowAt, now)}. Calls are taken in its first ${WARMUP.entryMinutes} minutes.` : "The Bitcoin feed is quiet right now.") : null,
    fallback: w.eligible && !callable && w.fallback ? { id: w.fallback.id, question: w.fallback.question } : null,
    note: w.eligible ? null : w.reason === "used_today" && w.left > 0 ? "Your next warm-up opens tomorrow." : w.reason === "used_today" ? "That was your last warm-up." : `Warm-ups are for your first ${WARMUP.days} days. The Slate's yours now.`,
    credit: w.feed.credit,
  };
}

// When the card should ask again: when the next window opens, and while a
// warm-up waits, a minute after its window ends and every minute after
// that. Null when nothing will change by itself.
export function nextRefresh(w: Warmup | null | undefined, now: number): number | null {
  if (!w) return null;
  const at: number[] = [];
  if (w.eligible) at.push(Date.parse(w.window && Date.parse(w.window.entryClosesAt) > now ? w.window.entryClosesAt : w.nextWindowAt));
  const waiting = w.mine[0] && !w.mine[0].stamp ? w.mine[0] : null;
  if (waiting) at.push(Math.max(Date.parse(waiting.endsAt) + MIN, now + MIN));
  const due = at.filter((t) => Number.isFinite(t) && t > now);
  return due.length ? Math.min(...due) : null;
}

// What a call says back.
export const calledLine = (side: WarmupSide, newcomers: number) => `Receipt printed: you called ${SIDE_LABEL[side]}. ${newcomersLine(newcomers)}`;
