import { CAST, type CityDay, HASH_BROWN_ALPHA, NPC, NPC_IDS, type NpcKey, addDays, cityDay, contrarianCall, nothingCall, npcLine } from "@bp/core";
import { and, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { calls, markets, messages, slateCards } from "./schema";

const dayStart = (d: CityDay) => new Date(`${d}T00:00:00Z`);
const isUnique = (e: unknown) => ((e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code) === "23505";

// One NPC call: straight into the queue (no ticket, no resident, no GM). It
// locks at the next tick like anyone's.
async function npcCall(db: Db, npc: NpcKey, marketId: string, price: number, call: { side: "yes" | "no"; chance: number } | null, now: Date) {
  if (!call) return false;
  try {
    await db.insert(calls).values({ userId: CAST[npc].id, marketId, side: call.side, chance: call.chance, seenPrice: price, onSlate: true, ticket: false, createdAt: now });
    return true;
  } catch (e) {
    if (isUnique(e)) return false; // already called this one
    throw e;
  }
}

// The cast plays today's Slate: NOTHING-9000 says NO to every card as soon as
// it's out; the Contrarian waits until 12:00 UTC to see where the city leans.
// Safe to run every minute.
export async function npcCalls(db: Db, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const day = cityDay(now);
  const cards = await db
    .select({ marketId: markets.id, price: markets.price, status: markets.status, freezesAt: markets.freezesAt })
    .from(slateCards)
    .innerJoin(markets, eq(markets.id, slateCards.marketId))
    .where(eq(slateCards.cityDay, day));
  const open = cards.filter((c) => c.status === "open" && now < c.freezesAt);
  let made = 0;
  for (const c of open) if (await npcCall(db, "nothing_9000", c.marketId, c.price, nothingCall(c.price), now)) made++;
  if (now.getTime() - dayStart(day).getTime() >= NPC.contrarianCallsAtHour * 3_600_000 && open.length) {
    const sides = await db
      .select({ marketId: calls.marketId, side: calls.side, n: sql<number>`count(*)::int` })
      .from(calls)
      .where(and(inArray(calls.marketId, open.map((c) => c.marketId)), eq(calls.status, "locked"), notInArray(calls.userId, [...NPC_IDS])))
      .groupBy(calls.marketId, calls.side);
    for (const c of open) {
      const yes = sides.find((s) => s.marketId === c.marketId && s.side === "yes")?.n ?? 0;
      const no = sides.find((s) => s.marketId === c.marketId && s.side === "no")?.n ?? 0;
      if (await npcCall(db, "contrarian", c.marketId, c.price, contrarianCall(c.price, yes, no), now)) made++;
    }
  }
  return { made };
}

// After the bell, one line per NPC on its home Board (at most 3 NPC lines a
// Board a day). Run once per bell (runBell records it).
export async function npcBoardLines(db: Db, bellDay: CityDay, now: Date) {
  const cards = await db
    .select({ marketId: slateCards.marketId, outcome: markets.outcome })
    .from(slateCards)
    .innerJoin(markets, eq(markets.id, slateCards.marketId))
    .where(eq(slateCards.cityDay, bellDay));
  const settled = cards.filter((c) => c.outcome !== null);
  const yes = settled.filter((c) => c.outcome).length;

  const lines: Array<{ npc: NpcKey; text: string }> = [];
  lines.push({ npc: "nothing_9000", text: npcLine("nothing_9000", !cards.length ? "no_slate" : yes * 2 > settled.length ? "mostly_yes" : "mostly_no") });

  if (!cards.length) lines.push({ npc: "contrarian", text: npcLine("contrarian", "no_slate") });
  else {
    // Where the city leaned on the Slate, and whether going against it paid.
    const leanRows = await db
      .select({ side: calls.side, n: sql<number>`count(*)::int` })
      .from(calls)
      .where(and(inArray(calls.marketId, cards.map((c) => c.marketId)), eq(calls.status, "locked"), notInArray(calls.userId, [...NPC_IDS])))
      .groupBy(calls.side);
    const cityYes = leanRows.find((r) => r.side === "yes")?.n ?? 0;
    const cityNo = leanRows.find((r) => r.side === "no")?.n ?? 0;
    const cityLean = cityYes >= cityNo ? "YES" : "NO";
    const cityRight = (cityLean === "YES") === yes * 2 > settled.length;
    lines.push({ npc: "contrarian", text: npcLine("contrarian", cityRight ? "lost" : "beat", { cityLean }) });
  }

  // Faucet Fren's streak: it says gm every day, and is far too proud of it.
  const epoch = Date.parse("2026-10-05T00:00:00Z");
  const streak = Math.max(1, Math.floor((dayStart(bellDay).getTime() - epoch) / 86_400_000) + 1);
  lines.push({ npc: "faucet_fren", text: npcLine("faucet_fren", "streak", { streak }) });
  const pick = Math.abs(dayStart(bellDay).getTime() / 86_400_000) % HASH_BROWN_ALPHA.length;
  lines.push({ npc: "hash_brown", text: npcLine("hash_brown", "alpha", { alpha: HASH_BROWN_ALPHA[pick]! }) });

  let posted = 0;
  const from = dayStart(addDays(bellDay, 1));
  for (const l of lines) {
    const home = CAST[l.npc].home;
    const [n] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.kind, "board"), eq(messages.channel, home), inArray(messages.authorId, [...NPC_IDS]), gte(messages.createdAt, from), lt(messages.createdAt, dayStart(addDays(bellDay, 2)))));
    if (n!.n >= NPC.linesPerBoardPerDay) continue;
    await db.insert(messages).values({ kind: "board", channel: home, authorId: CAST[l.npc].id, text: l.text, createdAt: now });
    posted++;
  }
  return { posted };
}
