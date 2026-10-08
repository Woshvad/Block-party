import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  primaryKey,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// --- Accounts -------------------------------------------------------------

// Guest on first tap; claimed once a Telegram or Privy identity is linked.
export const userStatus = pgEnum("user_status", ["guest", "claimed"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: userStatus("status").notNull().default("guest"),
    // The plan's one-tap 18+ notice; nobody gets an account without it.
    ageAckAt: timestamp("age_ack_at", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("users_claimed_consistent", sql`(${t.status} = 'claimed') = (${t.claimedAt} IS NOT NULL)`)],
);

export const identityProvider = pgEnum("identity_provider", ["telegram", "privy"]);

export const identities = pgTable(
  "identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    provider: identityProvider("provider").notNull(),
    // Telegram user id or Privy DID.
    subject: text("subject").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("identities_provider_subject").on(t.provider, t.subject),
    unique("identities_user_provider").on(t.userId, t.provider),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

// --- GM ledger ------------------------------------------------------------

export const gmAccountKind = pgEnum("gm_account_kind", ["user", "system", "escrow"]);

export const gmAccounts = pgTable(
  "gm_accounts",
  {
    id: text("id").primaryKey(),
    kind: gmAccountKind("kind").notNull(),
    userId: uuid("user_id").references(() => users.id),
    allowNegative: boolean("allow_negative").notNull().default(false),
    balance: bigint("balance", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("gm_accounts_balance_floor", sql`${t.allowNegative} OR ${t.balance} >= 0`),
    check("gm_accounts_user_kind", sql`(${t.kind} = 'user') = (${t.userId} IS NOT NULL)`),
    index("gm_accounts_user_idx").on(t.userId),
  ],
);

export const gmTransactions = pgTable("gm_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  kind: text("kind").notNull(),
  payloadHash: text("payload_hash").notNull(),
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gmEntries = pgTable(
  "gm_entries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    txId: uuid("tx_id")
      .notNull()
      .references(() => gmTransactions.id),
    accountId: text("account_id")
      .notNull()
      .references(() => gmAccounts.id),
    amount: bigint("amount", { mode: "number" }).notNull(),
    balanceAfter: bigint("balance_after", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("gm_entries_nonzero", sql`${t.amount} <> 0`),
    index("gm_entries_tx_idx").on(t.txId),
    index("gm_entries_account_idx").on(t.accountId, t.id),
  ],
);

// --- Daily habit: gm, drip, streak, Hodl Days -----------------------------

// One gm per resident per city day; the drip is paid with it.
export const dailyGm = pgTable(
  "daily_gm",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    cityDay: date("city_day", { mode: "string" }).notNull(),
    drip: integer("drip").notNull(),
    brokeFloor: boolean("broke_floor").notNull(),
    netWorth: bigint("net_worth", { mode: "number" }).notNull(),
    txId: uuid("tx_id")
      .notNull()
      .references(() => gmTransactions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.cityDay] }), check("daily_gm_drip_positive", sql`${t.drip} > 0`)],
);

export const streaks = pgTable(
  "streaks",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id),
    current: integer("current").notNull().default(0),
    longest: integer("longest").notNull().default(0),
    lastDay: date("last_day", { mode: "string" }),
    hodlDays: integer("hodl_days").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("streaks_hodl_range", sql`${t.hodlDays} BETWEEN 0 AND 2`),
    check("streaks_current_range", sql`${t.current} >= 0 AND ${t.longest} >= ${t.current}`),
    check("streaks_last_day_set", sql`(${t.current} = 0) = (${t.lastDay} IS NULL)`),
  ],
);

export const streakDayKind = pgEnum("streak_day_kind", ["played", "hodl"]);

// The streak calendar: every day that counted, and how.
export const streakDays = pgTable(
  "streak_days",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    cityDay: date("city_day", { mode: "string" }).notNull(),
    kind: streakDayKind("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.cityDay] })],
);

// Earned, account-bound collectibles (streak cards now; Bell Stamps etc. later).
export const badges = pgTable(
  "badges",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    badge: text("badge").notNull(),
    earnedOn: date("earned_on", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.badge] })],
);

// --- Residents (Create-a-Resident) ----------------------------------------

export const goal = pgEnum("resident_goal", ["oracle", "crew_captain", "mayor", "homebody"]);
export const backstory = pgEnum("resident_backstory", ["airdrop_baby", "exit_liquidity", "og_kid", "bear_market_survivor"]);
export const kitStyle = pgEnum("kit_style", ["neon", "cozy", "minimal"]);

export const residents = pgTable(
  "residents",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id),
    // Shown as @handle. Fixed at MVP; unique ignoring case.
    handle: text("handle").notNull(),
    name: text("name").notNull(),
    look: jsonb("look").$type<Record<string, unknown>>().notNull(),
    traits: text("traits").array().notNull(),
    // Season of the last free trait swap; null until the first swap.
    traitsSwappedSeason: integer("traits_swapped_season"),
    goal: goal("goal").notNull(),
    // Dealt once by the city, never changed.
    backstory: backstory("backstory").notNull(),
    starterItem: text("starter_item").notNull(),
    kitStyle: kitStyle("kit_style").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("residents_handle_lower").on(sql`lower(${t.handle})`),
    check("residents_handle_format", sql`${t.handle} ~ '^[A-Za-z0-9_]{3,15}$'`),
    check("residents_name_length", sql`char_length(${t.name}) BETWEEN 1 AND 200`),
    check("residents_look_object", sql`jsonb_typeof(${t.look}) = 'object'`),
  ],
);

// --- Crews ----------------------------------------------------------------

export const crewRole = pgEnum("crew_role", ["lead", "deputy", "member"]);
export const joinPolicy = pgEnum("crew_join_policy", ["approval", "open"]);
export const leftReason = pgEnum("crew_left_reason", ["left", "removed", "dissolved"]);
export const joinRequestStatus = pgEnum("crew_join_request_status", ["pending", "approved", "declined", "cancelled"]);

export const crews = pgTable(
  "crews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Case/space/accent-folded name; unique among live crews.
    nameKey: text("name_key").notNull(),
    joinPolicy: joinPolicy("join_policy").notNull().default("approval"),
    banner: jsonb("banner").$type<string[]>().notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dissolvedAt: timestamp("dissolved_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("crews_name_key_live").on(t.nameKey).where(sql`${t.dissolvedAt} IS NULL`)],
);

// Membership history: a row per stint. The live roster is left_at IS NULL.
export const crewMembers = pgTable(
  "crew_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    crewId: uuid("crew_id")
      .notNull()
      .references(() => crews.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: crewRole("role").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    leftReason: leftReason("left_reason"),
  },
  (t) => [
    uniqueIndex("crew_members_one_crew").on(t.userId).where(sql`${t.leftAt} IS NULL`),
    uniqueIndex("crew_members_one_lead").on(t.crewId).where(sql`${t.leftAt} IS NULL AND ${t.role} = 'lead'`),
    index("crew_members_roster").on(t.crewId).where(sql`${t.leftAt} IS NULL`),
    check("crew_members_left_consistent", sql`(${t.leftAt} IS NULL) = (${t.leftReason} IS NULL)`),
  ],
);

export const crewInvites = pgTable(
  "crew_invites",
  {
    code: text("code").primaryKey(),
    crewId: uuid("crew_id")
      .notNull()
      .references(() => crews.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    preApproved: boolean("pre_approved").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    uses: integer("uses").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("crew_invites_crew").on(t.crewId)],
);

export const crewJoinRequests = pgTable(
  "crew_join_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    crewId: uuid("crew_id")
      .notNull()
      .references(() => crews.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    invitedBy: uuid("invited_by").references(() => users.id),
    status: joinRequestStatus("status").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("crew_join_requests_one_pending").on(t.crewId, t.userId).where(sql`${t.status} = 'pending'`)],
);

// --- Crew gm chain --------------------------------------------------------

// One row per crew per settled city day. Counts only: the chain never names
// who missed.
export const crewChainDays = pgTable(
  "crew_chain_days",
  {
    crewId: uuid("crew_id")
      .notNull()
      .references(() => crews.id),
    cityDay: date("city_day", { mode: "string" }).notNull(),
    members: integer("members").notNull(),
    active: integer("active").notNull(),
    gms: integer("gms").notNull(),
    held: boolean("held").notNull(),
    relit: boolean("relit").notNull().default(false),
    settledAt: timestamp("settled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.crewId, t.cityDay] }),
    check("crew_chain_days_counts", sql`${t.gms} >= 0 AND ${t.gms} <= ${t.members} AND ${t.active} <= ${t.members} AND ${t.gms} <= ${t.active}`),
    check("crew_chain_days_relit", sql`NOT (${t.held} AND ${t.relit})`),
  ],
);

export const crewChainRelights = pgTable(
  "crew_chain_relights",
  {
    crewId: uuid("crew_id")
      .notNull()
      .references(() => crews.id),
    cityDay: date("city_day", { mode: "string" }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.crewId, t.cityDay, t.userId] })],
);
