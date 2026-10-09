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
    // Set by the Proof of Neighbour brick (phone or crypto-native proof).
    proofOfNeighbourAt: timestamp("proof_of_neighbour_at", { withTimezone: true }),
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
    // The exact moment of the gm (the away shift needs "in the last 24 hours").
    saidAt: timestamp("said_at", { withTimezone: true }).notNull().defaultNow(),
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
    // The candle's colour can be hidden; the mood always shows.
    hideCandleColor: boolean("hide_candle_color").notNull().default(false),
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

// --- Homes and Build mode -------------------------------------------------

export const homeTier = pgEnum("home_tier", ["tenement"]);
export const itemSource = pgEnum("item_source", ["kit", "starter", "purchase", "earned"]);
export const proposalStatus = pgEnum("crew_piece_proposal_status", ["pending", "bought", "cancelled"]);

export const homes = pgTable("homes", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  tier: homeTier("tier").notNull().default("tenement"),
  wallFinish: text("wall_finish").notNull().default("plaster"),
  floorFinish: text("floor_finish").notNull().default("boards"),
  doorOpen: boolean("door_open").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const crewHouses = pgTable("crew_houses", {
  crewId: uuid("crew_id")
    .primaryKey()
    .references(() => crews.id),
  wallFinish: text("wall_finish").notNull().default("plaster"),
  floorFinish: text("floor_finish").notNull().default("boards"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Every piece anyone owns. Owned by a resident or by a crew, never both, and
// never handed on: no resale, no gifting.
export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pieceId: text("piece_id").notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    ownerCrewId: uuid("owner_crew_id").references(() => crews.id),
    source: itemSource("source").notNull(),
    pricePaid: integer("price_paid"),
    txId: uuid("tx_id").references(() => gmTransactions.id),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("items_one_owner", sql`(${t.ownerUserId} IS NULL) <> (${t.ownerCrewId} IS NULL)`),
    check("items_paid_consistent", sql`(${t.source} = 'purchase') = (${t.pricePaid} IS NOT NULL AND ${t.txId} IS NOT NULL)`),
    index("items_owner_user").on(t.ownerUserId),
    index("items_owner_crew").on(t.ownerCrewId),
    uniqueIndex("items_tx_once").on(t.txId),
    // Kit, starter and earned pieces come once per owner.
    uniqueIndex("items_free_once_user").on(t.ownerUserId, t.pieceId).where(sql`${t.source} <> 'purchase'`),
    // Working pieces: one of each per home.
    uniqueIndex("items_working_once_user")
      .on(t.ownerUserId, t.pieceId)
      .where(sql`${t.pieceId} IN ('guestbook','trophy_wall','slate_board','tv')`),
    uniqueIndex("items_working_once_crew")
      .on(t.ownerCrewId, t.pieceId)
      .where(sql`${t.pieceId} IN ('guestbook','trophy_wall','slate_board','tv')`),
  ],
);

// Where a piece sits. No row means it's in storage (free).
export const placements = pgTable(
  "placements",
  {
    itemId: uuid("item_id")
      .primaryKey()
      .references(() => items.id),
    room: text("room").notNull(),
    layer: text("layer").notNull(),
    spot: jsonb("spot").$type<Record<string, unknown>>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("placements_layer", sql`${t.layer} IN ('floor','rug','wall')`)],
);

export const crewPieceProposals = pgTable(
  "crew_piece_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    crewId: uuid("crew_id")
      .notNull()
      .references(() => crews.id),
    pieceId: text("piece_id").notNull(),
    proposedBy: uuid("proposed_by")
      .notNull()
      .references(() => users.id),
    status: proposalStatus("status").notNull().default("pending"),
    itemId: uuid("item_id").references(() => items.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    index("crew_piece_proposals_crew").on(t.crewId),
    check("crew_piece_proposals_bought", sql`(${t.status} = 'bought') = (${t.itemId} IS NOT NULL)`),
  ],
);

export const crewPieceApprovals = pgTable(
  "crew_piece_approvals",
  {
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => crewPieceProposals.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.userId] })],
);

// --- Rent and jobs --------------------------------------------------------

export const rentStatus = pgEnum("rent_status", ["paid", "couch", "sublet"]);

// One row per resident per Saturday: paid, couch-surfed (couldn't pay, no
// debt) or sublet (away 7+ days).
export const rentCharges = pgTable(
  "rent_charges",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    saturday: date("saturday", { mode: "string" }).notNull(),
    status: rentStatus("status").notNull(),
    amount: integer("amount").notNull().default(0),
    txId: uuid("tx_id").references(() => gmTransactions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.saturday] }),
    check("rent_charges_paid", sql`(${t.status} = 'paid') = (${t.txId} IS NOT NULL AND ${t.amount} > 0)`),
    check("rent_charges_unpaid_zero", sql`${t.status} = 'paid' OR ${t.amount} = 0`),
  ],
);

export const shiftKind = pgEnum("shift_kind", ["active", "away"]);

export const shifts = pgTable(
  "shifts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    cityDay: date("city_day", { mode: "string" }).notNull(),
    // 1 or 2: the daily cap, enforced by the unique index below.
    slot: integer("slot").notNull(),
    kind: shiftKind("kind").notNull(),
    seed: integer("seed"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    score: integer("score"),
    pay: integer("pay"),
    collectedTx: uuid("collected_tx").references(() => gmTransactions.id),
  },
  (t) => [
    uniqueIndex("shifts_daily_cap").on(t.userId, t.cityDay, t.slot),
    uniqueIndex("shifts_one_away_a_day").on(t.userId, t.cityDay).where(sql`${t.kind} = 'away'`),
    check("shifts_slot", sql`${t.slot} BETWEEN 1 AND 2`),
    check("shifts_score", sql`${t.score} IS NULL OR ${t.score} BETWEEN 0 AND 10`),
    check("shifts_pay", sql`${t.pay} IS NULL OR ${t.pay} BETWEEN 5 AND 12`),
    check("shifts_collected_paid", sql`${t.collectedTx} IS NULL OR ${t.pay} IS NOT NULL`),
    check("shifts_active_seed", sql`(${t.kind} = 'active') = (${t.seed} IS NOT NULL)`),
  ],
);

// --- The bell -------------------------------------------------------------

// Each step of each nightly bell, recorded once it finishes. A crashed run
// leaves its step unrecorded, so the next run picks it up.
export const bellSteps = pgTable(
  "bell_steps",
  {
    bellDay: date("bell_day", { mode: "string" }).notNull(), // the city day the bell closed
    step: text("step").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),
    doneAt: timestamp("done_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.bellDay, t.step] })],
);

// One row per account the Halving touched, per season.
export const halvings = pgTable(
  "halvings",
  {
    season: integer("season").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => gmAccounts.id),
    balanceBefore: bigint("balance_before", { mode: "number" }).notNull(),
    burned: bigint("burned", { mode: "number" }).notNull(),
    txId: uuid("tx_id")
      .notNull()
      .references(() => gmTransactions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.season, t.accountId] }),
    check("halvings_math", sql`${t.balanceBefore} > 2000 AND ${t.burned} = (${t.balanceBefore} - 2000) / 2 AND ${t.burned} > 0`),
  ],
);

// --- Rate limits ----------------------------------------------------------

// Fixed-window counters. One row per bucket per window; old windows are
// swept by the bell job.
export const rateLimits = pgTable(
  "rate_limits",
  {
    bucket: text("bucket").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.windowStart] }), check("rate_limits_count", sql`${t.count} > 0`)],
);

// --- Moods ----------------------------------------------------------------

// Continuous play, split by an hour away. Drives Rested and Chart-brain.
export const playSessions = pgTable(
  "play_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("play_sessions_latest").on(t.userId, t.lastSeenAt),
    check("play_sessions_order", sql`${t.lastSeenAt} >= ${t.startedAt}`),
  ],
);

export const moodKind = pgEnum("mood_kind", ["called_it", "rekt", "tilted", "cozy", "rested", "chart_brain"]);

// Event moods (Called It, REKT, Tilted, Cozy, a nap's Rested). Rested and
// Chart-brain from the play clock are worked out, not stored.
export const moods = pgTable(
  "moods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    mood: moodKind("mood").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }), // null: until something clears it
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    clearedBy: text("cleared_by"),
    source: jsonb("source").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index("moods_user").on(t.userId, t.startedAt),
    // At most one open row per mood per resident; granting again refreshes it.
    uniqueIndex("moods_one_open").on(t.userId, t.mood).where(sql`${t.clearedAt} IS NULL`),
    check("moods_cleared_consistent", sql`(${t.clearedAt} IS NULL) = (${t.clearedBy} IS NULL)`),
    check("moods_ends_after_start", sql`${t.endsAt} IS NULL OR ${t.endsAt} > ${t.startedAt}`),
  ],
);

// Free Copium earned from REKTs. Never bought, never transferred.
export const copiumCredits = pgTable(
  "copium_credits",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id),
    free: integer("free").notNull().default(0),
  },
  (t) => [check("copium_credits_free", sql`${t.free} >= 0`)],
);

// Each Copium use, keyed by the caller's idempotency key, so a retry returns
// the first result instead of spending a second Copium.
export const copiumUses = pgTable("copium_uses", {
  key: text("key").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  paid: boolean("paid").notNull(),
  price: integer("price").notNull().default(0),
  cleared: text("cleared").array().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- City Hall: the weekly Mayor -------------------------------------------

export const electionStatus = pgEnum("election_status", ["open", "finalized"]);

// One election per week (keyed by the Monday it runs), electing the Mayor
// for the following week.
export const elections = pgTable("elections", {
  week: date("week", { mode: "string" }).primaryKey(),
  status: electionStatus("status").notNull().default("open"),
  winnerUserId: uuid("winner_user_id").references(() => users.id),
  turnout: integer("turnout"),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
});

export const candidates = pgTable(
  "candidates",
  {
    week: date("week", { mode: "string" })
      .notNull()
      .references(() => elections.week),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    pitch: text("pitch").notNull(),
    declaredAt: timestamp("declared_at", { withTimezone: true }).notNull(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    // Secret ballot: a counter, never a row per ballot, so nothing can line
    // up who voted with what they voted for.
    votes: integer("votes").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.week, t.userId] }), check("candidates_votes", sql`${t.votes} >= 0`)],
);

// Who voted (one vote each), never what.
export const electionVoters = pgTable(
  "election_voters",
  {
    week: date("week", { mode: "string" })
      .notNull()
      .references(() => elections.week),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
  },
  (t) => [primaryKey({ columns: [t.week, t.userId] })],
);

// A Mayor's term, keyed by the Monday it starts.
export const mayorTerms = pgTable("mayor_terms", {
  week: date("week", { mode: "string" }).primaryKey(),
  mayorUserId: uuid("mayor_user_id")
    .notNull()
    .references(() => users.id),
  lawId: text("law_id"),
  lawChosenAt: timestamp("law_chosen_at", { withTimezone: true }),
});

// --- Moderation and safety ------------------------------------------------

export const blocks = pgTable(
  "blocks",
  {
    blockerId: uuid("blocker_id")
      .notNull()
      .references(() => users.id),
    blockedId: uuid("blocked_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] }), check("blocks_not_self", sql`${t.blockerId} <> ${t.blockedId}`), index("blocks_blocked").on(t.blockedId)],
);

export const mutes = pgTable(
  "mutes",
  {
    muterId: uuid("muter_id")
      .notNull()
      .references(() => users.id),
    mutedId: uuid("muted_id")
      .notNull()
      .references(() => users.id),
    until: timestamp("until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.muterId, t.mutedId] }), check("mutes_not_self", sql`${t.muterId} <> ${t.mutedId}`)],
);

export const reportReason = pgEnum("report_reason", ["impersonation", "scam", "unwanted_romance", "under_18", "harassment", "spam", "other"]);
export const reportStatus = pgEnum("report_status", ["open", "actioned", "dismissed"]);

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reporterId: uuid("reporter_id")
      .notNull()
      .references(() => users.id),
    targetUserId: uuid("target_user_id")
      .notNull()
      .references(() => users.id),
    reason: reportReason("reason").notNull(),
    place: text("place"),
    note: text("note"),
    // Snapshotted by the server (the last messages), never sent by the client.
    evidence: jsonb("evidence").$type<Array<{ at: string; authorId: string; text: string }>>().notNull().default([]),
    priority: boolean("priority").notNull().default(false),
    status: reportStatus("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolution: text("resolution"),
  },
  (t) => [
    index("reports_open_due").on(t.dueAt).where(sql`${t.status} = 'open'`),
    uniqueIndex("reports_one_open").on(t.reporterId, t.targetUserId, t.reason).where(sql`${t.status} = 'open'`),
    check("reports_not_self", sql`${t.reporterId} <> ${t.targetUserId}`),
    check("reports_resolved", sql`(${t.status} = 'open') = (${t.resolvedAt} IS NULL)`),
    check("reports_resolution_text", sql`${t.status} = 'open' OR char_length(${t.resolution}) >= 10`),
  ],
);

export const staffRole = pgEnum("staff_role", ["moderator", "admin"]);

// Granted in the database only; no route grants a staff role.
export const staff = pgTable("staff", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  role: staffRole("role").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const restrictionKind = pgEnum("restriction_kind", ["chat_mute", "suspended"]);

// Every restriction carries a written reason the player can read (the EU
// statement of reasons).
export const restrictions = pgTable(
  "restrictions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: restrictionKind("kind").notNull(),
    reason: text("reason").notNull(),
    reportId: uuid("report_id").references(() => reports.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
    liftedBy: uuid("lifted_by").references(() => users.id),
  },
  (t) => [
    index("restrictions_user").on(t.userId),
    check("restrictions_reason", sql`char_length(${t.reason}) >= 20`),
    check("restrictions_window", sql`${t.endsAt} IS NULL OR ${t.endsAt} > ${t.startsAt}`),
  ],
);

export const appealStatus = pgEnum("appeal_status", ["open", "upheld", "overturned"]);

export const appeals = pgTable(
  "appeals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    restrictionId: uuid("restriction_id")
      .notNull()
      .unique()
      .references(() => restrictions.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    text: text("text").notNull(),
    status: appealStatus("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
  },
  (t) => [check("appeals_decided", sql`(${t.status} = 'open') = (${t.decidedAt} IS NULL)`)],
);

export const moderationStatus = pgEnum("moderation_status", ["pending", "clean", "flagged", "error"]);

// Text waiting for (or past) the AI moderation check, run in batches.
export const moderationItems = pgTable(
  "moderation_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(), // chat, pitch, resident_name, crew_name, ...
    ref: text("ref").notNull(),
    authorId: uuid("author_id").references(() => users.id),
    text: text("text").notNull(),
    status: moderationStatus("status").notNull().default("pending"),
    categories: jsonb("categories").$type<string[]>().notNull().default([]),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
  },
  (t) => [index("moderation_items_pending").on(t.createdAt).where(sql`${t.status} = 'pending'`)],
);

// --- Frens and persistent chat ----------------------------------------------

// A fren tap, made while sharing a room. Two taps make frens.
export const frenTaps = pgTable(
  "fren_taps",
  {
    fromId: uuid("from_id")
      .notNull()
      .references(() => users.id),
    toId: uuid("to_id")
      .notNull()
      .references(() => users.id),
    place: text("place").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.fromId, t.toId] }), check("fren_taps_not_self", sql`${t.fromId} <> ${t.toId}`)],
);

// Frens, stored once per pair with a < b.
export const frens = pgTable(
  "frens",
  {
    a: uuid("a")
      .notNull()
      .references(() => users.id),
    b: uuid("b")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.a, t.b] }), check("frens_ordered", sql`${t.a} < ${t.b}`), index("frens_b").on(t.b)],
);

export const chatKind = pgEnum("chat_kind", ["board", "crew", "dm"]);

// Board posts, crew chat and DMs share one table, told apart by kind and
// channel (a place, a crew id or a DM thread id).
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: chatKind("kind").notNull(),
    channel: text("channel").notNull(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    text: text("text").notNull(),
    hidden: boolean("hidden").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("messages_channel").on(t.kind, t.channel, t.createdAt),
    check("messages_text", sql`char_length(${t.text}) BETWEEN 1 AND 4000`),
  ],
);

export const boardFollows = pgTable(
  "board_follows",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    place: text("place").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.place] })],
);

export const dmThreads = pgTable(
  "dm_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    a: uuid("a")
      .notNull()
      .references(() => users.id),
    b: uuid("b")
      .notNull()
      .references(() => users.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("dm_threads_pair").on(t.a, t.b), check("dm_threads_ordered", sql`${t.a} < ${t.b}`)],
);

// --- Getting around ---------------------------------------------------------

export const rideMode = pgEnum("ride_mode", ["walk", "rollup", "priority"]);

// A Rollup bus run: fills up to 8 riders, leaves when full or 10 seconds after
// the first boards.
export const buses = pgTable(
  "buses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toArea: text("to_area").notNull(),
    departsAt: timestamp("departs_at", { withTimezone: true }).notNull(),
    riders: integer("riders").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("buses_boarding").on(t.toArea, t.departsAt), check("buses_seats", sql`${t.riders} BETWEEN 0 AND 8`)],
);

export const rides = pgTable(
  "rides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    idempotencyKey: text("idempotency_key").notNull(),
    fromArea: text("from_area").notNull(),
    toArea: text("to_area").notNull(),
    mode: rideMode("mode").notNull(),
    fare: integer("fare").notNull(),
    txId: uuid("tx_id").references(() => gmTransactions.id),
    busId: uuid("bus_id").references(() => buses.id),
    departedAt: timestamp("departed_at", { withTimezone: true }).notNull(),
    arriveAt: timestamp("arrive_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("rides_latest").on(t.userId, t.departedAt),
    uniqueIndex("rides_idempotency").on(t.userId, t.idempotencyKey),
    check("rides_paid", sql`(${t.fare} = 0) = (${t.txId} IS NULL)`),
    check("rides_bus", sql`(${t.mode} = 'rollup') = (${t.busId} IS NOT NULL)`),
    check("rides_order", sql`${t.arriveAt} >= ${t.departedAt}`),
  ],
);
