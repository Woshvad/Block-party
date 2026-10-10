import { HASH_BROWN_ALPHA } from "@bp/core";
import type { CityHall, MarketRow } from "./api";
import { until } from "./clock";

// What the big screens in the rooms show: live boards built from the API.
// Pure: the room fetches, these shape, Interior.tsx paints. Tested headless.

export type FeedKey = "odds" | "match" | "hall" | "diner";
export type BoardRow = { left: string; right?: string; tone?: "up" | "down" | "plain" };
export type Board = { title: string; rows: BoardRow[]; foot?: string };

export const POLYMARKET_CREDIT = "Odds via Polymarket · Not affiliated";
const ROWS = 6;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oddsRow = (m: MarketRow, now: number): BoardRow => ({
  left: clip(m.question, 52),
  right: `${m.price}% YES · ${until(m.freezesAt, now)}`,
  tone: m.price >= 50 ? "up" : "down",
});
const open = (ms: readonly MarketRow[], now: number) => ms.filter((m) => Date.parse(m.freezesAt) > now).sort((a, b) => Date.parse(a.freezesAt) - Date.parse(b.freezesAt));

// The Tower's ground floor: real odds, read-only, soonest to close first, one per category up top.
export function oddsBoard(markets: readonly MarketRow[], now: number): Board {
  const live = open(markets, now);
  const firsts = live.filter((m, i) => live.findIndex((o) => o.category === m.category) === i); // soonest per category
  const rows = [...firsts, ...live.filter((m) => !firsts.includes(m))].slice(0, ROWS).map((m) => oddsRow(m, now));
  return { title: "THE ODDS WALL", rows: rows.length ? rows : [{ left: "Odds paused. Back soon, ser.", tone: "plain" }], foot: POLYMARKET_CREDIT };
}

// The Watch Party Hall's big screen: tonight's matches.
export function matchBoard(markets: readonly MarketRow[], now: number): Board {
  const rows = open(markets, now)
    .filter((m) => m.category === "sports")
    .slice(0, ROWS)
    .map((m) => oddsRow(m, now));
  return { title: "WATCH PARTY · ON TONIGHT", rows: rows.length ? rows : [{ left: "No match on right now. Grab a beanbag.", tone: "plain" }], foot: POLYMARKET_CREDIT };
}

// City Hall's noticeboard: who runs the city, this week's Law, the election.
export function hallBoard(hall: CityHall | null, now: number): Board {
  const rows: BoardRow[] = [
    { left: "Mayor", right: hall?.mayor ? `@${hall.mayor.handle}` : "No Mayor yet" },
    { left: "Law of the Week", right: hall?.law?.name ?? "None this week" },
  ];
  const e = hall?.election;
  if (e) {
    rows.push({ left: `Election ${e.week}`, right: e.phase === "voting" ? `Polls close in ${until(e.pollsClose, now)}` : e.phase === "counted" ? "Counted" : `Voting opens in ${until(e.votingOpens, now)}` });
    const ranked = [...e.candidates].sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0));
    for (const c of ranked.slice(0, ROWS - rows.length)) rows.push({ left: `@${c.handle}`, right: c.votes === undefined ? clip(c.pitch, 34) : `${c.votes} votes`, tone: "plain" });
  }
  return { title: "CITY HALL · NOTICEBOARD", rows, foot: e?.youVoted ? "You voted. Results at the Sunday count." : "Vote in person at the ballot box." };
}

// Word-wrap to lines of at most n characters (a small chalkboard).
export function wrap(text: string, n: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(" ")) {
    const last = lines[lines.length - 1];
    if (last !== undefined && (last + " " + word).length <= n) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

// The Diner's chalkboard: Hash Brown's alpha of the day (fiction, labelled).
export function dinerBoard(cityDay: string): Board {
  let h = 0;
  for (const ch of cityDay) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    title: "HASH BROWN'S ALPHA",
    rows: [...wrap(`"${HASH_BROWN_ALPHA[h % HASH_BROWN_ALPHA.length]!}"`, 26), "", "Ser, this is a diner."].map((left) => ({ left, tone: "plain" as const })),
    foot: "Pure fiction. Not advice. Never about anything real.",
  };
}
