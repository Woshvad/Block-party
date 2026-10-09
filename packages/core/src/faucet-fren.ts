import { AWAY } from "./away";
import { CREW } from "./crew";
import { GM } from "./daily";
import { HALVING_LINE, RENT, SHIFT } from "./economy";
import { NAP } from "./life";
import { MOOD } from "./moods";
import { NOTIFY } from "./notifications";
import { PON } from "./pon";
import { RIDES } from "./rides";

// Faucet Fren answers questions from a script (AI chat comes at Launch).
// Every number comes from the game's own constants, so a tuned value never
// leaves the helper saying something stale. Like every NPC, it talks GM only:
// never real trades, wallets, deposits or dollar amounts, and never tells
// anyone what to call.

export type Faq = { id: string; keywords: readonly string[]; answer: string };

export const FAQ: readonly Faq[] = [
  {
    id: "gm",
    keywords: ["gm", "drip", "daily", "free gm", "earn", "claim"],
    answer: `Say gm once a city day and the drip pays ${GM.drip} GM (${GM.brokeFloorDrip} if you're under ${GM.brokeFloorBelow} GM). The day turns over at the bell, 00:00 UTC.`,
  },
  {
    id: "streak",
    keywords: ["streak", "hodl day", "hodl days", "lose streak", "broke streak", "miss a day"],
    answer: `Your streak grows with your first call each day: +${GM.streakBonusPerDay} GM a day, up to +${GM.streakBonusCap}. Hodl Days save it when you miss: you hold up to ${GM.hodlDayMax}, get a free one every ${GM.hodlDayFreeEvery}-day streak, or burn ${GM.hodlDayPrice} GM for one.`,
  },
  {
    id: "rent",
    keywords: ["rent", "saturday", "couch", "evicted", "can't pay", "sublet"],
    answer: `Rent is ${RENT.tenement} GM at the Saturday bell. Can't pay? A week on your crew's couch, never debt. Away ${RENT.subletAfterDaysAway}+ days and your place is sublet, so you're not charged.`,
  },
  {
    id: "shift",
    keywords: ["job", "jobs", "shift", "shifts", "mod shift", "away shift"],
    answer: `The Mod Shift: a 30-second mini-game, then ${SHIFT.minutes} real minutes on its own. ${SHIFT.perDay} shifts a day across every job. Proof of Neighbour residents get one away shift a day at half pay (${SHIFT.awayPay} GM) if they said gm in the last 24 hours.`,
  },
  {
    id: "rides",
    keywords: ["ride", "walk", "bus", "rollup", "priority", "travel", "get around", "teleport"],
    answer: `Walking is free (about ${RIDES.walk.seconds} s). The Rollup is ${RIDES.rollup.fare} GM and leaves when it's full; priority is ${RIDES.priority.fare} GM and about ${RIDES.priority.seconds} s. Fares burn. No teleporting, ser.`,
  },
  {
    id: "moods",
    keywords: ["mood", "candle", "rekt", "tilted", "cozy", "rested", "chart-brain", "chart brain"],
    answer: `Your candle shows your newest mood. An hour of Cozy with your crew clears REKT and Tilted. Rested comes from ${MOOD.restedAfterOfflineHours}+ hours away or a nap in your own bed; Chart-brain shows up after ${MOOD.chartBrainAfterMinutes} minutes straight and only time away clears it. Moods never pay GM.`,
  },
  {
    id: "copium",
    keywords: ["copium"],
    answer: `Copium clears REKT and Tilted. Every REKT comes with a free one; otherwise it's ${MOOD.copiumPrice} GM, burned. It's never spent when there's nothing to clear.`,
  },
  {
    id: "nap",
    keywords: ["nap", "sleep", "bed", "hammock"],
    answer: `Nap on any bed or hammock at home: ${NAP.minutes} real minutes, and you wake up Rested. The cheapest bed works exactly like the fanciest.`,
  },
  {
    id: "crews",
    keywords: ["crew", "join crew", "invite", "lead", "deputy", "crew house"],
    answer: `Crews run ${CREW.minMembers} to ${CREW.maxMembers} residents, with a lead and up to ${CREW.maxDeputies} deputies. A lead's or deputy's invite joins you straight away; open crews join in one tap. Light the gm chain together every night.`,
  },
  {
    id: "mayor",
    keywords: ["mayor", "vote", "election", "law", "city hall", "ballot"],
    answer: "Run for Mayor Monday to Thursday; the booth opens Friday and closes Sunday 23:00 UTC, and you vote in person at City Hall. One neighbour, one vote, secret. The Mayor picks one Law of the Week.",
  },
  {
    id: "pon",
    keywords: ["proof of neighbour", "proof of neighbor", "pon", "verify", "verified", "phone"],
    answer: `Proof of Neighbour: an account ${PON.minAccountDays}+ days old, a phone check (or a crypto-native proof), and time in a room with ${PON.neighboursNeeded}+ residents. It unlocks voting, running for Mayor and the away shift.`,
  },
  {
    id: "halving",
    keywords: ["halving", "season", "season end"],
    answer: `At each season's last bell the Halving burns half of whatever a resident or crew pot holds above ${HALVING_LINE.toLocaleString("en")} GM. Spend it on your place before then, ser.`,
  },
  {
    id: "away",
    keywords: ["away", "offline", "while you were away", "recap", "logged off"],
    answer: `Offline, your resident keeps wandering by its traits for up to ${AWAY.livesForDays} days and you get a "while you were away" recap. Away residents never chat, call, vote or spend for you.`,
  },
  {
    id: "pings",
    keywords: ["notification", "notifications", "push", "ping", "pings", "quiet hours", "too many"],
    answer: `${NOTIFY.dailyCap} pings a day at most, never in your quiet hours (23:00 to 08:00 by default). Alerts are opt-in, and you can switch pings off any time in settings.`,
  },
  {
    id: "frens",
    keywords: ["fren", "frens", "best fren", "rival", "rivals", "friend"],
    answer: "Tap Fren on someone in the same room; when they tap back, you're frens. Pick up to 3 best frens (it only shows when it's mutual), and frens can agree to be rivals for bragging rights.",
  },
  {
    id: "safety",
    keywords: ["seed phrase", "scam", "private key", "recovery phrase", "support dm", "admin dm"],
    answer: "Nobody from Block Party will ever ask for your seed phrase or your funds. Not the Mayor. Not your crew. Not me. Block and report anyone who does.",
  },
  {
    id: "block",
    keywords: ["block", "report", "mute", "harass", "harassing", "harassed", "harassment", "bully", "bullying"],
    answer: "Tap a resident to mute, block or report them. A block works both ways and ends any frenship or rivalry. Reports are read within 24 hours.",
  },
];

export const FAUCET_FREN_FALLBACK = "No idea, ser. Ask me about gm, rent, shifts, rides, moods, crews, the Mayor or staying safe.";

// The answer for a question: the entry whose keywords match the most (whole
// words and phrases), or the fallback.
export function faucetFrenAnswer(question: unknown): { id: string | null; answer: string } {
  if (typeof question !== "string") return { id: null, answer: FAUCET_FREN_FALLBACK };
  const clean = question.toLowerCase().normalize("NFKC").replace(/[^a-z0-9'\- ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  // "gm fren", "hey ser": a greeting isn't a question about gm or frens.
  const q = ` ${clean.replace(/^((hey|hi|hello|yo|gm|gn|sup|ok|so)( (faucet fren|fren|ser|anon|frens))? )+/, "")} `;
  let best: Faq | null = null;
  let top = 0;
  for (const f of FAQ) {
    const score = f.keywords.reduce((n, k) => n + (q.includes(` ${k} `) ? k.split(" ").length : 0), 0);
    if (score > top) {
      top = score;
      best = f;
    }
  }
  return best ? { id: best.id, answer: best.answer } : { id: null, answer: FAUCET_FREN_FALLBACK };
}
