// The city runs on one UTC clock. A city day is the UTC date; the bell rings
// at 00:00 UTC when one city day becomes the next.

export type CityDay = string; // "YYYY-MM-DD"

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function cityDay(at: Date = new Date()): CityDay {
  if (Number.isNaN(at.getTime())) throw new RangeError("invalid date");
  return at.toISOString().slice(0, 10);
}

function toUtcMs(day: CityDay): number {
  if (!DAY_RE.test(day)) throw new RangeError(`not a city day: ${day}`);
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(ms) || cityDay(new Date(ms)) !== day) throw new RangeError(`not a city day: ${day}`);
  return ms;
}

export function addDays(day: CityDay, n: number): CityDay {
  if (!Number.isSafeInteger(n)) throw new RangeError("days must be an integer");
  return cityDay(new Date(toUtcMs(day) + n * DAY_MS));
}

// Whole days from `a` to `b` (positive if b is later).
export function daysBetween(a: CityDay, b: CityDay): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

export function nextBell(at: Date = new Date()): Date {
  return new Date(toUtcMs(cityDay(at)) + DAY_MS);
}

// 0 = Sunday ... 6 = Saturday, by the city clock.
export function cityWeekday(day: CityDay): number {
  return new Date(toUtcMs(day)).getUTCDay();
}
