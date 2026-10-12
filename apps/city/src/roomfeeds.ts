import { HASH_BROWN_ALPHA, nextBell } from "@bp/core";
import type { CityHall, MarketRow } from "./api";
import { until } from "./clock";

// What the big screens in the rooms show: live boards built from the API.
// Pure: the room fetches, these shape, Interior.tsx paints. Tested headless.

export type FeedKey = "odds" | "match" | "hall" | "diner";
export type BoardRow = { left: string; right?: string; tone?: "up" | "down" | "plain" };
// dim: the data may be stale (the odds feed is paused), so the screen fades.
export type Board = { title: string; rows: BoardRow[]; foot?: string; dim?: boolean };

const ROWS = 6;

// The odds feed, as /v1/tower/feed reports it. `credit` names where the odds
// came from ("Odds via Polymarket · Not affiliated", or "Sample odds · Not
// real" for the sample feed); null when the API hasn't said.
export type FeedStatus = { paused: boolean; lastTickAt: string | null; credit: string | null };

// The feed after one refresh of a room's screens. The prices on the wall are
// only as fresh as the last refresh where both the prices and the feed status
// came back, so if either failed the wall counts as paused since that one,
// still credited to where those prices came from.
export function feedAfter(prev: FeedStatus | null, pricesOk: boolean, feed: FeedStatus | null): FeedStatus {
  if (pricesOk && feed) return feed;
  return { paused: true, lastTickAt: prev?.lastTickAt ?? null, credit: prev?.credit ?? null };
}

// "20:41" today, "Oct 9 20:41" before that, in the player's own time.
function sinceLabel(iso: string, now: number): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === new Date(now).toDateString() ? time : `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

// A stale wall says so: dimmed, and the foot says since when. The credit is
// the API's, so sample odds never carry Polymarket's name; without one, none.
function feedFoot(feed: FeedStatus | null, now: number): Pick<Board, "foot" | "dim"> {
  const credit = feed?.credit ?? null;
  if (feed && !feed.paused) return credit ? { foot: credit } : {};
  const since = feed?.lastTickAt ? `Paused since ${sinceLabel(feed.lastTickAt, now)}` : "Odds paused";
  return { foot: credit ? `${since} · ${credit}` : since, dim: true };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
// A price is a level, not a move: neutral, never green "up" or red "down".
const oddsRow = (m: MarketRow, now: number): BoardRow => ({
  left: clip(m.question, 52),
  right: `${m.price}% YES · ${until(m.freezesAt, now)}`,
  tone: "plain",
});
const open = (ms: readonly MarketRow[], now: number) => ms.filter((m) => Date.parse(m.freezesAt) > now).sort((a, b) => Date.parse(a.freezesAt) - Date.parse(b.freezesAt));

// The Tower's ground floor: real odds, read-only, soonest to close first, one per category up top.
export function oddsBoard(markets: readonly MarketRow[], now: number, feed: FeedStatus | null): Board {
  const live = open(markets, now);
  const firsts = live.filter((m, i) => live.findIndex((o) => o.category === m.category) === i); // soonest per category
  const rows = [...firsts, ...live.filter((m) => !firsts.includes(m))].slice(0, ROWS).map((m) => oddsRow(m, now));
  const empty = feed && !feed.paused ? "No open markets right now." : "Odds paused. Back soon, ser.";
  return { title: "THE ODDS WALL", rows: rows.length ? rows : [{ left: empty, tone: "plain" }], ...feedFoot(feed, now) };
}

// The Watch Party Hall's big screen: tonight's matches, meaning those that
// start before the bell. With none tonight it shows what's coming up, and
// says so: a match next month is never "on tonight".
export function matchBoard(markets: readonly MarketRow[], now: number, feed: FeedStatus | null): Board {
  const sports = open(markets, now).filter((m) => m.category === "sports");
  const bell = nextBell(new Date(now)).getTime();
  const tonight = sports.filter((m) => Date.parse(m.freezesAt) <= bell);
  const shown = tonight.length ? tonight : sports;
  const title = tonight.length ? "WATCH PARTY · ON TONIGHT" : sports.length ? "WATCH PARTY · COMING UP" : "WATCH PARTY";
  const rows = shown.slice(0, ROWS).map((m) => oddsRow(m, now));
  return { title, rows: rows.length ? rows : [{ left: "No match on right now. Grab a beanbag.", tone: "plain" }], ...feedFoot(feed, now) };
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
