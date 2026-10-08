import { type CityDay, addDays, daysBetween } from "./clock";

// Numbers from the plan's GM economy. Set before the beta; the drip only
// ever goes up.
export const GM = {
  moveInGift: 1000,
  drip: 50,
  brokeFloorDrip: 100,
  brokeFloorBelow: 100,
  streakBonusPerDay: 5,
  streakBonusCap: 25,
  hodlDayMax: 2,
  hodlDayAtMoveIn: 1,
  hodlDayFreeEvery: 7,
  hodlDayPrice: 150,
  streakCards: [7, 30, 100, 365] as readonly number[],
  // Burns that still count toward net worth for the broke floor, and for how long.
  netWorthBurnKinds: ["furniture", "decor", "wardrobe"] as readonly string[],
  netWorthBurnLookbackDays: 7,
} as const;

export function dripFor(netWorth: number): { amount: number; brokeFloor: boolean } {
  const brokeFloor = netWorth < GM.brokeFloorBelow;
  return { amount: brokeFloor ? GM.brokeFloorDrip : GM.drip, brokeFloor };
}

export function streakBonus(streak: number): number {
  return Math.min(streak * GM.streakBonusPerDay, GM.streakBonusCap);
}

export type StreakState = {
  current: number;
  longest: number;
  lastDay: CityDay | null;
  hodlDays: number;
};

export type StreakAdvance = {
  state: StreakState;
  changed: boolean;
  bonus: number;
  // Missed days a Hodl Day covered, oldest first.
  coveredDays: CityDay[];
  broken: boolean; // a previous streak ended
  hodlGranted: boolean;
  cards: number[];
};

// Records `day` as a played day (a day with a call). Missed days since the
// last played day are covered by Hodl Days only if there are enough to save
// the streak; otherwise the streak quietly restarts and no Hodl Day is spent.
export function advanceStreak(s: StreakState, day: CityDay): StreakAdvance {
  if (s.lastDay === day) {
    return { state: s, changed: false, bonus: 0, coveredDays: [], broken: false, hodlGranted: false, cards: [] };
  }
  if (s.lastDay !== null && daysBetween(s.lastDay, day) < 0) {
    throw new RangeError(`streak day ${day} is before last played day ${s.lastDay}`);
  }

  let current: number;
  let hodlDays = s.hodlDays;
  let coveredDays: CityDay[] = [];
  let broken = false;

  if (s.lastDay === null) {
    current = 1;
  } else {
    const gap = daysBetween(s.lastDay, day) - 1;
    if (gap <= hodlDays) {
      current = s.current + 1;
      hodlDays -= gap;
      coveredDays = Array.from({ length: gap }, (_, i) => addDays(s.lastDay!, i + 1));
    } else {
      current = 1;
      broken = s.current > 0;
    }
  }

  let hodlGranted = false;
  if (current % GM.hodlDayFreeEvery === 0 && hodlDays < GM.hodlDayMax) {
    hodlDays += 1;
    hodlGranted = true;
  }

  return {
    state: { current, longest: Math.max(s.longest, current), lastDay: day, hodlDays },
    changed: true,
    bonus: streakBonus(current),
    coveredDays,
    broken,
    hodlGranted,
    cards: GM.streakCards.filter((c) => c === current),
  };
}

// What the Today sheet shows, without changing anything.
export function streakView(s: StreakState, today: CityDay) {
  if (s.lastDay === null) return { streak: 0, playedToday: false, alive: false, hodlNeeded: 0 };
  const since = daysBetween(s.lastDay, today);
  const missed = Math.max(0, since - 1);
  const alive = missed <= s.hodlDays;
  return {
    streak: alive ? s.current : 0,
    playedToday: since === 0,
    alive,
    // Hodl Days that will be spent if you play today.
    hodlNeeded: alive ? missed : 0,
  };
}
