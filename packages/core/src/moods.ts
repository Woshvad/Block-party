import { nextBell } from "./clock";
import type { Trait } from "./resident";

// MVP moods. Hyped, Main Character and Fed arrive at Launch.
export const MOODS = ["called_it", "rekt", "tilted", "cozy", "rested", "chart_brain"] as const;
export type Mood = (typeof MOODS)[number];

// Moods that change a rule, not just how you look. Traits never touch these.
export const SAFETY_MOODS: readonly Mood[] = ["tilted", "chart_brain"];

export const MOOD = {
  copiumPrice: 30,
  sessionGapMinutes: 60, // an hour away ends a play session (and clears Chart-brain)
  restedAfterOfflineHours: 6,
  restedLastsMinutes: 90,
  chartBrainAfterMinutes: 90,
  cozyClearsAfterMinutes: 60, // an hour of Cozy clears REKT and Tilted
  copiumRegularCozyMinutes: 30, // Copium Regular: REKT clears faster with your crew
  tiltedStakeCap: 10,
  tiltRektSquares: 4,
  tiltLossShare: 0.25,
  touchThrottleSeconds: 60, // write activity at most once a minute per player
} as const;

// --- Play sessions ----------------------------------------------------------

export type PlaySession = { startedAt: Date; lastSeenAt: Date };

const MIN = 60_000;

// What the play clock says right now. Sessions are newest first.
export function playState(sessions: readonly PlaySession[], now: Date) {
  const [current, previous] = sessions;
  const live = current && now.getTime() - current.lastSeenAt.getTime() < MOOD.sessionGapMinutes * MIN;
  if (!current || !live) return { inSession: false, sessionMinutes: 0, rested: false, chartBrain: false };
  const sessionMinutes = Math.max(0, (now.getTime() - current.startedAt.getTime()) / MIN);
  const offlineBefore = previous ? (current.startedAt.getTime() - previous.lastSeenAt.getTime()) / MIN : 0;
  return {
    inSession: true,
    sessionMinutes,
    // Rested: came back after 6+ hours away, for the first ~90 minutes.
    rested: !!previous && offlineBefore >= MOOD.restedAfterOfflineHours * 60 && sessionMinutes < MOOD.restedLastsMinutes,
    // Chart-brain: 90 minutes without an hour's break. Only time away clears it.
    chartBrain: sessionMinutes >= MOOD.chartBrainAfterMinutes,
  };
}

// --- Tilt -------------------------------------------------------------------

export type TiltSignals = {
  rektSquares?: number; // on one grid
  lostSnap?: boolean;
  gmLostToday?: number; // on calls and duels
  gmAtStartOfDay?: number;
};

export function tiltTriggered(s: TiltSignals): boolean {
  if ((s.rektSquares ?? 0) >= MOOD.tiltRektSquares) return true;
  if (s.lostSnap) return true;
  const start = s.gmAtStartOfDay ?? 0;
  return start > 0 && (s.gmLostToday ?? 0) >= start * MOOD.tiltLossShare;
}

// Real trades stay paused until the bell after a tilt began, whatever clears
// the mood in the meantime.
export const realTradePauseUntil = (tiltStartedAt: Date) => nextBell(tiltStartedAt);

// --- Traits -----------------------------------------------------------------

// How long Cozy must last to clear a mood. Traits may speed up REKT; nothing
// may change Tilted or Chart-brain.
export function cozyMinutesToClear(mood: Mood, traits: readonly Trait[]): number | null {
  if (mood === "rekt") return traits.includes("copium_regular") ? MOOD.copiumRegularCozyMinutes : MOOD.cozyClearsAfterMinutes;
  if (mood === "tilted") return MOOD.cozyClearsAfterMinutes;
  return null;
}

// --- The candle -------------------------------------------------------------

export type ActiveMood = { mood: Mood; since: Date };

// One mood shows at a time: the newest. Ties go to the safety moods, so a
// player never looks fine while a rule is holding them back.
export function candleMood(active: readonly ActiveMood[]): Mood | null {
  if (active.length === 0) return null;
  return [...active].sort((a, b) => {
    const t = b.since.getTime() - a.since.getTime();
    if (t !== 0) return t;
    return Number(SAFETY_MOODS.includes(b.mood)) - Number(SAFETY_MOODS.includes(a.mood));
  })[0]!.mood;
}
