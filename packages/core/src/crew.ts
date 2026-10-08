import { addDays } from "./clock";
import { escrowAccountId } from "./ledger";
import { ResidentInputError, normalizeName } from "./resident";

export const CREW = {
  minMembers: 3, // below this a crew is "forming"
  maxMembers: 50,
  maxDeputies: 2,
  nameMinChars: 3,
  nameMaxChars: 24,
  inviteTtlHours: 24,
  inviteMaxTtlHours: 7 * 24,
  // gm chain
  chainShare: 0.6, // documented; chainThreshold uses the exact fraction 3/5
  chainMinGms: 3,
  chainActiveWindowDays: 7,
  relightVotes: 3,
} as const;

export type CrewRole = "lead" | "deputy" | "member";
export type JoinPolicy = "approval" | "open";

export class CrewInputError extends Error {
  constructor(
    readonly field: "name" | "banner" | "joinPolicy" | "ttl",
    readonly reason: string,
  ) {
    super(`${field}: ${reason}`);
    this.name = "CrewInputError";
  }
}

// Same impersonation and scam rules as resident names.
export function validateCrewName(input: unknown): string {
  let n: string;
  try {
    n = normalizeName(input);
  } catch (e) {
    if (e instanceof ResidentInputError) throw new CrewInputError("name", e.reason);
    throw e;
  }
  const len = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(n)].length;
  if (len < CREW.nameMinChars) throw new CrewInputError("name", `at least ${CREW.nameMinChars} characters`);
  if (len > CREW.nameMaxChars) throw new CrewInputError("name", `at most ${CREW.nameMaxChars} characters`);
  return n;
}

// Unique key for a crew name: case, spacing and accents don't make a new name.
export function crewNameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

// Pixel-art banner: 8 rows of 16 tiles, each a palette index 0-f.
export const BANNER_ROWS = 8;
export const BANNER_COLS = 16;
export const DEFAULT_BANNER: string[] = Array.from({ length: BANNER_ROWS }, () => "0".repeat(BANNER_COLS));

export function validateBanner(input: unknown): string[] {
  if (!Array.isArray(input) || input.length !== BANNER_ROWS) throw new CrewInputError("banner", `${BANNER_ROWS} rows`);
  for (const row of input) {
    if (typeof row !== "string" || !new RegExp(`^[0-9a-f]{${BANNER_COLS}}$`).test(row)) {
      throw new CrewInputError("banner", `each row is ${BANNER_COLS} tiles 0-f`);
    }
  }
  return [...input];
}

export function validateJoinPolicy(input: unknown): JoinPolicy {
  if (input !== "approval" && input !== "open") throw new CrewInputError("joinPolicy", "approval or open");
  return input;
}

// --- Who may do what ------------------------------------------------------

export type CrewAction =
  | "invite" // anyone; a member's invite becomes a join request
  | "approve_join"
  | "remove"
  | "set_deputy"
  | "transfer_lead"
  | "edit_crew"
  | "dissolve";

const rank: Record<CrewRole, number> = { member: 0, deputy: 1, lead: 2 };

export function can(actor: CrewRole, action: CrewAction, target?: CrewRole): boolean {
  switch (action) {
    case "invite":
      return true;
    case "approve_join":
    case "edit_crew":
      return actor !== "member";
    case "remove":
      // Deputies remove members; the lead removes anyone but themself.
      return target !== undefined && target !== "lead" && rank[actor] > rank[target];
    case "set_deputy":
    case "transfer_lead":
    case "dissolve":
      return actor === "lead";
  }
}

// An invite from the lead or a deputy is pre-approved.
export const invitePreApproved = (inviter: CrewRole) => inviter !== "member";

export function crewStatus(memberCount: number): "forming" | "active" {
  return memberCount >= CREW.minMembers ? "active" : "forming";
}

// --- gm chain -------------------------------------------------------------

// 60% rounded up, in integers: ceil(3a / 5) = floor((3a + 4) / 5).
export function chainThreshold(activeMembers: number): number {
  return Math.max(CREW.chainMinGms, Math.floor((activeMembers * 3 + 4) / 5));
}

export function chainHolds(activeMembers: number, gms: number): boolean {
  return gms >= chainThreshold(activeMembers);
}

export const crewPotAccountId = (crewId: string) => escrowAccountId("crew", crewId);

export type ChainDay = { day: string; held: boolean; relit: boolean };

// Chain length as of `today`, from settled days (any order). Held days count;
// relit days bridge without counting; a missed day breaks the chain once its
// relight window (until the next bell) has closed. Yesterday's miss is still
// open, so it shows as "needs relight" over the chain it would save.
export function chainLength(days: readonly ChainDay[], today: string): { length: number; needsRelight: string | null } {
  const sorted = [...days].sort((a, b) => (a.day < b.day ? 1 : -1));
  const yesterday = addDays(today, -1);
  let length = 0;
  let needsRelight: string | null = null;
  let expect = yesterday;
  for (const d of sorted) {
    if (d.day >= today) continue; // today hasn't been settled by the bell yet
    if (d.day !== expect) break; // a gap: the crew wasn't settled that day
    expect = addDays(d.day, -1);
    if (d.held) length++;
    else if (d.relit) continue;
    else if (d.day === yesterday) needsRelight = d.day;
    else break;
  }
  return { length, needsRelight };
}
