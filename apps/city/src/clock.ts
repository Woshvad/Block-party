import { useEffect, useState } from "react";

// "2h 14m", "14m", "45s", or "now" once it's passed. Never negative, never NaN.
export function countdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export const until = (iso: string | null | undefined, now: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  return countdown(t - now);
};

// A clock that ticks every `everyMs` while the page is open.
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

// Whether something redrawn every `every` seconds is due, by a 3D scene's
// clock. That clock starts again from 0 when a hidden view is shown again, so
// a clock behind the last draw counts as due rather than waiting to catch up.
export function due(last: number | null, now: number, every: number): boolean {
  return last === null || now < last || now - last >= every;
}
