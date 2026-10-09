// Pings: hard limits, not starting numbers (the plan's own words).

export const NOTIFY = {
  dailyCap: 3, // pushes a day, all kinds together, by the resident's local day
  noRepeatDays: 5, // the same wording never twice within 5 days
  ignoredBeforeWeekly: 7, // after 7 ignored pushes, one a week
  ignoredAfterHours: 24, // a push not opened within a day counts as ignored
  defaultQuietStart: 23,
  defaultQuietEnd: 8,
  staleAfterHours: 12, // a deferred ping older than this is dropped, not sent late
  crewPostsPerDay: 3,
} as const;

export const ALERT_KINDS = ["shift_done", "nap_done", "away_shift_ready", "faded", "snap", "syndicate_shake", "warmup_settled"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export type NotifyKind = "daily" | "bell_2h" | AlertKind;

export const CREW_POST_KINDS = ["syndicate_call", "bell_in_15", "crew_card"] as const;
export type CrewPostKind = (typeof CREW_POST_KINDS)[number];

// The CT voice. {placeholders} are filled from values; nothing else is said.
export const TEMPLATES: Record<NotifyKind, readonly string[]> = {
  daily: [
    "gm ser. Your Slate is ready.",
    "The Slate is up. Your streak is on the line.",
    "gm. Six calls, one grid, same for everyone.",
    "Your candle's waiting. Pull up.",
    "The city's arguing about today's Slate. Pick a side.",
    "Streak check: {streak} days and counting.",
    "gm. NOTHING-9000 already locked its grid. Beat the bot.",
    "Today's Long Shot is live. Call it or fade it.",
    "Your crew's on the Slate. Pull up.",
    "gm. The bell rings at 00:00 UTC.",
    "A new city day. Your gm is waiting.",
    "Probably nothing. Unless you call it.",
  ],
  bell_2h: ["Bell in 2h. Lock your calls.", "Two hours to the bell. The Roof is filling up.", "Bell in 2h, ser."],
  shift_done: ["Your Mod Shift is done. Collect your pay.", "Shift's over. Your GM is ready."],
  nap_done: ["Nap's over. Your resident woke up Rested.", "Your resident's up from a nap, fresh eyes and all."],
  away_shift_ready: ["Your away shift is ready to collect.", "While you were out, your resident worked a shift. Collect it."],
  faded: ["@{handle} faded your call.", "Someone took the other side: @{handle}."],
  snap: ["@{handle} hit Snap on your duel.", "Snap from @{handle}. The pot just doubled."],
  syndicate_shake: ["Your crew wants a shake on a syndicate call.", "Syndicate call needs your shake."],
  warmup_settled: ["Your warm-up settled. See your receipt.", "The 15-minute window closed. Your receipt is in."],
};

export const FAREWELL = "We'll stop pinging. The city's still here, ser.";

// Words a push must never carry: money, wallets, FOMO, asks to share or trade.
export const NEVER_SAY = /\b(balance|wallet|deposit|withdraw|usdc|\$|trade|buy|sell|share|post|missing out|fomo|don'?t miss|last chance|hurry|limited)\b/i;

export function render(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => (k in values ? String(values[k]) : ""));
}

// Every {placeholder} in the wording has a value to fill it.
export function fillable(template: string, values: Record<string, string | number>): boolean {
  return [...template.matchAll(/\{(\w+)\}/g)].every((m) => m[1]! in values && String(values[m[1]!]).trim() !== "");
}

// Pick wording not used in the last 5 days; if all were, the least recent.
// Only wording whose placeholders can all be filled; null if none can.
export function chooseTemplate(kind: NotifyKind, recentlyUsed: ReadonlyMap<string, number>, now: number, seed: number, values: Record<string, string | number> = {}): string | null {
  const all = TEMPLATES[kind].filter((t) => fillable(t, values));
  if (!all.length) return null;
  const cutoff = now - NOTIFY.noRepeatDays * 86_400_000;
  const fresh = all.filter((t) => (recentlyUsed.get(t) ?? 0) < cutoff);
  const pool = fresh.length ? fresh : [...all].sort((a, b) => (recentlyUsed.get(a) ?? 0) - (recentlyUsed.get(b) ?? 0)).slice(0, 1);
  return pool[Math.abs(seed) % pool.length]!;
}

// --- Time zones and quiet hours -------------------------------------------

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localParts(at: Date, tz: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

export function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// The next moment quiet hours are over (hour precision), or `at` if they aren't on.
export function afterQuietHours(at: Date, tz: string, start: number, end: number): Date {
  let t = new Date(Math.ceil(at.getTime() / 3_600_000) * 3_600_000);
  if (!inQuietHours(localParts(at, tz).hour, start, end)) return at;
  // loop-bound: at most 24 hourly steps to leave a quiet window shorter than a day.
  for (let i = 0; i < 24 && inQuietHours(localParts(t, tz).hour, start, end); i++) t = new Date(t.getTime() + 3_600_000);
  return t;
}
