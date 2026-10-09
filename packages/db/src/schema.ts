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

// --- Proof of Neighbour -------------------------------------------------------

// Live room visits, reported by the rooms Worker. Away residents are never
// in a room, so they never appear here.
export const roomVisits = pgTable(
  "room_visits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    room: text("room").notNull(), // place#copy
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
    leftAt: timestamp("left_at", { withTimezone: true }),
  },
  (t) => [index("room_visits_room").on(t.room, t.joinedAt), index("room_visits_user").on(t.userId, t.joinedAt), check("room_visits_order", sql`${t.leftAt} IS NULL OR ${t.leftAt} >= ${t.joinedAt}`)],
);

export const proofKind = pgEnum("proof_kind", ["phone", "wallet_history", "coinbase", "world_id"]);

// One verified identity per kind per account, and each phone, wallet or
// World ID backs one account only. Subjects are stored as keyed hashes.
export const verifiedIdentities = pgTable(
  "verified_identities",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: proofKind("kind").notNull(),
    subjectHash: text("subject_hash").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] }), uniqueIndex("verified_identities_subject").on(t.kind, t.subjectHash)],
);

export const phoneChecks = pgTable(
  "phone_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    phoneHash: text("phone_hash").notNull(),
    providerRef: text("provider_ref").notNull(),
    attempts: integer("attempts").notNull().default(0),
    status: text("status").notNull().default("pending"), // pending | verified | failed
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("phone_checks_user").on(t.userId, t.createdAt), check("phone_checks_status", sql`${t.status} IN ('pending','verified','failed')`)],
);

// --- Notifications ------------------------------------------------------------------

export const notificationPrefs = pgTable(
  "notification_prefs",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id),
    timeZone: text("time_zone").notNull().default("UTC"),
    quietStart: integer("quiet_start").notNull().default(23),
    quietEnd: integer("quiet_end").notNull().default(8),
    alerts: text("alerts").array().notNull().default(sql`'{}'::text[]`),
    bell2h: boolean("bell_2h").notNull().default(false),
    pushOff: boolean("push_off").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("notification_prefs_hours", sql`${t.quietStart} BETWEEN 0 AND 23 AND ${t.quietEnd} BETWEEN 0 AND 23`)],
);

export const notificationStatus = pgEnum("notification_status", ["queued", "sent", "suppressed", "failed"]);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind").notNull(),
    values: jsonb("values").$type<Record<string, string | number>>().notNull().default({}),
    status: notificationStatus("status").notNull().default("queued"),
    reason: text("reason"),
    template: text("template"),
    text: text("text"),
    localDay: text("local_day"),
    attempts: integer("attempts").notNull().default(0),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
  },
  (t) => [
    index("notifications_due").on(t.scheduledFor).where(sql`${t.status} = 'queued'`),
    index("notifications_user").on(t.userId, t.createdAt),
    check("notifications_sent", sql`(${t.status} = 'sent') = (${t.sentAt} IS NOT NULL)`),
  ],
);

// The Telegram bot in a crew group: at most 3 posts a city day; leads mute types.
export const crewBotPosts = pgTable(
  "crew_bot_posts",
  {
    crewId: uuid("crew_id")
      .notNull()
      .references(() => crews.id),
    cityDay: date("city_day", { mode: "string" }).notNull(),
    kind: text("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.crewId, t.cityDay, t.kind] })],
);

export const crewBotMutes = pgTable(
  "crew_bot_mutes",
  {
    crewId: uuid("crew_id")
      .notNull()
      .references(() => crews.id),
    kind: text("kind").notNull(),
  },
  (t) => [primaryKey({ columns: [t.crewId, t.kind] })],
);

// Long actions (a nap now; more later): they run for real minutes on their
// own, then finish once, by the cron or whenever the resident looks.
export const longActionStatus = pgEnum("long_action_status", ["running", "done", "cancelled"]);

export const longActions = pgTable(
  "long_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind").notNull(),
    itemId: uuid("item_id").references(() => items.id),
    status: longActionStatus("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    // One at a time.
    uniqueIndex("long_actions_one_running").on(t.userId).where(sql`${t.status} = 'running'`),
    index("long_actions_due").on(t.endsAt).where(sql`${t.status} = 'running'`),
    check("long_actions_order", sql`${t.endsAt} > ${t.startedAt}`),
    check("long_actions_finished", sql`(${t.status} = 'running') = (${t.finishedAt} IS NULL)`),
  ],
);

// Best frens: up to 3 picks from your frens. A pick is private; the badge
// shows only when it's mutual.
export const bestFrens = pgTable(
  "best_frens",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    frenId: uuid("fren_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.frenId] }), check("best_frens_not_self", sql`${t.userId} <> ${t.frenId}`), index("best_frens_fren").on(t.frenId)],
);

// Friendly rivals: both agree, either ends it. Bragging rights only.
export const rivalryStatus = pgEnum("rivalry_status", ["pending", "active"]);
export const rivalries = pgTable(
  "rivalries",
  {
    a: uuid("a")
      .notNull()
      .references(() => users.id),
    b: uuid("b")
      .notNull()
      .references(() => users.id),
    proposedBy: uuid("proposed_by")
      .notNull()
      .references(() => users.id),
    status: rivalryStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.a, t.b] }),
    check("rivalries_ordered", sql`${t.a} < ${t.b}`),
    check("rivalries_proposer", sql`${t.proposedBy} IN (${t.a}, ${t.b})`),
    check("rivalries_accepted", sql`(${t.status} = 'active') = (${t.acceptedAt} IS NOT NULL)`),
    index("rivalries_b").on(t.b),
  ],
);

// --- The Prediction Tower --------------------------------------------------------

export const marketCategory = pgEnum("market_category", ["crypto", "sports", "politics", "culture", "other"]);
export const marketStatus = pgEnum("market_status", ["open", "frozen", "resolved", "void"]);

// Mirror markets from the odds feed (Polymarket; a mock in development).
export const markets = pgTable(
  "markets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    question: text("question").notNull(),
    category: marketCategory("category").notNull(),
    ladder: text("ladder"),
    // Real politicians stay on the Odds Wall: information only, no calls.
    infoOnly: boolean("info_only").notNull().default(false),
    freezesAt: timestamp("freezes_at", { withTimezone: true }).notNull(),
    settlesBy: timestamp("settles_by", { withTimezone: true }).notNull(),
    status: marketStatus("status").notNull().default("open"),
    outcome: boolean("outcome"),
    price: integer("price").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("markets_source_external").on(t.source, t.externalId),
    check("markets_price", sql`${t.price} BETWEEN 1 AND 99`),
    check("markets_resolved", sql`(${t.status} = 'resolved') = (${t.outcome} IS NOT NULL)`),
    check("markets_order", sql`${t.settlesBy} >= ${t.freezesAt}`),
  ],
);

// Every tick is kept: Aura scores against the tick a call locked on.
export const marketTicks = pgTable(
  "market_ticks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    marketId: uuid("market_id")
      .notNull()
      .references(() => markets.id),
    price: integer("price").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [index("market_ticks_market").on(t.marketId, t.at), check("market_ticks_price", sql`${t.price} BETWEEN 1 AND 99`)],
);

// One row per poll of the feed, for "odds paused at 20:41".
export const feedPolls = pgTable("feed_polls", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  source: text("source").notNull(),
  ok: boolean("ok").notNull(),
  markets: integer("markets").notNull().default(0),
  error: text("error"),
  at: timestamp("at", { withTimezone: true }).notNull(),
});

export const callStatus = pgEnum("call_status", ["pending", "locked", "price_moved", "expired"]);
export const callSide = pgEnum("call_side", ["yes", "no"]);

// Free calls. One per resident per market (pending or locked), no edits.
export const calls = pgTable(
  "calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    marketId: uuid("market_id")
      .notNull()
      .references(() => markets.id),
    side: callSide("side").notNull(),
    chance: integer("chance").notNull(),
    seenPrice: integer("seen_price").notNull(),
    status: callStatus("status").notNull().default("pending"),
    tickId: bigint("tick_id", { mode: "number" }).references(() => marketTicks.id),
    lockedPrice: integer("locked_price"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    onSlate: boolean("on_slate").notNull().default(false),
    half: boolean("half").notNull().default(false),
    ticket: boolean("ticket").notNull().default(false),
    // A Tail copies a fren's side and earns no Aura; a Fade takes the other side.
    via: text("via"),
    viaUserId: uuid("via_user_id").references(() => users.id),
    auraCenti: integer("aura_centi"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("calls_one_per_market").on(t.userId, t.marketId).where(sql`${t.status} IN ('pending', 'locked')`),
    index("calls_pending").on(t.marketId).where(sql`${t.status} = 'pending'`),
    index("calls_market").on(t.marketId, t.status),
    check("calls_chance", sql`${t.chance} BETWEEN 1 AND 99 AND ${t.seenPrice} BETWEEN 1 AND 99`),
    check("calls_locked", sql`(${t.status} = 'locked') = (${t.lockedPrice} IS NOT NULL AND ${t.tickId} IS NOT NULL AND ${t.lockedAt} IS NOT NULL)`),
    check("calls_via", sql`(${t.via} IS NULL) = (${t.viaUserId} IS NULL) AND (${t.via} IS NULL OR ${t.via} IN ('tail', 'fade'))`),
    // A call's side matches its chance (the slider only moves on your side).
    check("calls_side", sql`(${t.side} = 'yes' AND ${t.chance} > ${t.seenPrice}) OR (${t.side} = 'no' AND ${t.chance} < ${t.seenPrice})`),
  ],
);

// Off-slate tickets: 3 a day, stacking up to 9, never sold.
export const tickets = pgTable(
  "tickets",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id),
    balance: integer("balance").notNull(),
    asOf: date("as_of", { mode: "string" }).notNull(),
  },
  (t) => [check("tickets_range", sql`${t.balance} BETWEEN 0 AND 9`)],
);

// The Daily Slate: published once per city day, never changed after.
export const slates = pgTable("slates", {
  cityDay: date("city_day", { mode: "string" }).primaryKey(),
  modifier: text("modifier").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
});

export const slateCards = pgTable(
  "slate_cards",
  {
    cityDay: date("city_day", { mode: "string" })
      .notNull()
      .references(() => slates.cityDay),
    slot: integer("slot").notNull(),
    tier: text("tier").notNull(),
    marketId: uuid("market_id")
      .notNull()
      .references(() => markets.id),
  },
  (t) => [
    primaryKey({ columns: [t.cityDay, t.slot] }),
    unique("slate_cards_market_once").on(t.cityDay, t.marketId),
    index("slate_cards_market").on(t.marketId),
    check("slate_cards_slot", sql`${t.slot} BETWEEN 0 AND 5`),
  ],
);

// Bell Stamps: one a city day, for calling that day.
export const bellStamps = pgTable(
  "bell_stamps",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    cityDay: date("city_day", { mode: "string" }).notNull(),
    gm: integer("gm").notNull(),
    txId: uuid("tx_id")
      .notNull()
      .references(() => gmTransactions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.cityDay] })],
);

// Each crew's Bell Score at a bell (scores never touch GM or Aura).
export const crewBellScores = pgTable(
  "crew_bell_scores",
  {
    bellDay: date("bell_day", { mode: "string" }).notNull(),
    crewId: uuid("crew_id")
      .notNull()
      .references(() => crews.id),
    chips: integer("chips").notNull(),
    longShots: integer("long_shots").notNull(),
    chainDays: integer("chain_days").notNull(),
    scoreMilli: integer("score_milli").notNull(),
  },
  (t) => [primaryKey({ columns: [t.bellDay, t.crewId] }), index("crew_bell_scores_rank").on(t.bellDay, t.scoreMilli)],
);

// The cast: labelled AI characters. Each has a user row (so its calls and
// lines have an author) but no resident and no GM account, ever.
export const npcs = pgTable("npcs", {
  key: text("key").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  name: text("name").notNull(),
  home: text("home").notNull(),
});

// The Daily Close: the city paper, printed once per bell.
export const dailyCloses = pgTable("daily_closes", {
  bellDay: date("bell_day", { mode: "string" }).primaryKey(),
  pages: jsonb("pages").$type<Record<string, Array<{ key: string; values: Record<string, string | number> }>>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

// Fade Duels: opt-in, with a decline-all switch (off by default).
export const duelPrefs = pgTable("duel_prefs", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  duelsOn: boolean("duels_on").notNull().default(false),
  // Duel cards and the reel name you only if you allow it.
  allowNaming: boolean("allow_naming").notNull().default(false),
});

export const duelStatus = pgEnum("duel_status", ["offered", "active", "declined", "cancelled", "expired", "retreated", "settled", "void"]);

export const duels = pgTable(
  "duels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    marketId: uuid("market_id")
      .notNull()
      .references(() => markets.id),
    challengerId: uuid("challenger_id")
      .notNull()
      .references(() => users.id),
    opponentId: uuid("opponent_id")
      .notNull()
      .references(() => users.id),
    challengerSide: callSide("challenger_side").notNull(),
    status: duelStatus("status").notNull().default("offered"),
    stakeChallenger: integer("stake_challenger").notNull(),
    stakeOpponent: integer("stake_opponent").notNull().default(0),
    snapChallenger: boolean("snap_challenger").notNull().default(false),
    snapOpponent: boolean("snap_opponent").notNull().default(false),
    lastCall: boolean("last_call").notNull().default(false),
    retreatedBy: uuid("retreated_by"),
    winnerId: uuid("winner_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("duels_challenger").on(t.challengerId, t.status),
    index("duels_opponent").on(t.opponentId, t.status),
    index("duels_market").on(t.marketId, t.status),
    check("duels_two_people", sql`${t.challengerId} <> ${t.opponentId}`),
    check("duels_stakes", sql`${t.stakeChallenger} BETWEEN 0 AND 80 AND ${t.stakeOpponent} BETWEEN 0 AND 80`),
    check("duels_winner", sql`${t.winnerId} IS NULL OR ${t.winnerId} IN (${t.challengerId}, ${t.opponentId})`),
    check("duels_retreat", sql`${t.retreatedBy} IS NULL OR ${t.retreatedBy} IN (${t.challengerId}, ${t.opponentId})`),
    check("duels_settled", sql`(${t.status} = 'settled') = (${t.winnerId} IS NOT NULL)`),
  ],
);

// Who first invited a resident into the city (a crew invite they redeemed).
export const inviters = pgTable("inviters", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  inviterId: uuid("inviter_id")
    .notNull()
    .references(() => users.id),
  invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
});

export const grudgeStatus = pgEnum("grudge_status", ["offered", "active", "declined", "cancelled", "expired", "settled", "tied"]);

// The Grudge Match: newcomer vs the friend who invited them, once per pair.
export const grudgeMatches = pgTable(
  "grudge_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cityDay: date("city_day", { mode: "string" }).notNull(), // the Slate they play
    newcomerId: uuid("newcomer_id")
      .notNull()
      .references(() => users.id),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => users.id),
    status: grudgeStatus("status").notNull().default("offered"),
    winnerId: uuid("winner_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("grudge_once_per_pair").on(sql`LEAST(${t.newcomerId}, ${t.inviterId})`, sql`GREATEST(${t.newcomerId}, ${t.inviterId})`),
    index("grudge_day").on(t.cityDay, t.status),
    check("grudge_two_people", sql`${t.newcomerId} <> ${t.inviterId}`),
    check("grudge_winner", sql`(${t.status} = 'settled') = (${t.winnerId} IS NOT NULL) AND (${t.winnerId} IS NULL OR ${t.winnerId} IN (${t.newcomerId}, ${t.inviterId}))`),
  ],
);

// City markets: staff-written, settled from game data, GM only.
export const cityMarketKind = pgEnum("city_market_kind", ["headcount", "manual"]);
export const cityMarketStatus = pgEnum("city_market_status", ["open", "resolved", "void", "settled", "refunded"]);

export const cityMarkets = pgTable(
  "city_markets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    question: text("question").notNull(),
    kind: cityMarketKind("kind").notNull(),
    place: text("place"),
    threshold: integer("threshold"),
    measureAt: timestamp("measure_at", { withTimezone: true }),
    bellDay: date("bell_day", { mode: "string" }).notNull(), // settles at this day's bell
    locksAt: timestamp("locks_at", { withTimezone: true }).notNull(),
    status: cityMarketStatus("status").notNull().default("open"),
    outcome: boolean("outcome"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("city_markets_bell").on(t.bellDay, t.status),
    check("city_markets_headcount", sql`${t.kind} <> 'headcount' OR (${t.place} IS NOT NULL AND ${t.threshold} > 0 AND ${t.measureAt} IS NOT NULL)`),
    check("city_markets_outcome", sql`(${t.status} IN ('resolved', 'settled')) = (${t.outcome} IS NOT NULL)`),
  ],
);

export const cityPositions = pgTable(
  "city_positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    marketId: uuid("market_id")
      .notNull()
      .references(() => cityMarkets.id),
    // A resident's own stake, or a crew's syndicate stake from its pot.
    userId: uuid("user_id").references(() => users.id),
    crewId: uuid("crew_id").references(() => crews.id),
    side: callSide("side").notNull(),
    stake: integer("stake").notNull(),
    payout: integer("payout"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("city_positions_one").on(t.marketId, t.userId),
    uniqueIndex("city_positions_one_crew").on(t.marketId, t.crewId),
    index("city_positions_user").on(t.userId),
    check("city_positions_owner", sql`(${t.userId} IS NULL) <> (${t.crewId} IS NULL)`),
    check("city_positions_stake", sql`${t.stake} >= 1 AND (${t.crewId} IS NOT NULL OR ${t.stake} <= 800) AND (${t.payout} IS NULL OR ${t.payout} >= 0)`),
  ],
);

// Syndicate calls: proposed by a member, live once enough of the crew shakes.
export const syndicateStatus = pgEnum("syndicate_status", ["proposed", "live", "expired"]);

export const syndicates = pgTable(
  "syndicates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    crewId: uuid("crew_id")
      .notNull()
      .references(() => crews.id),
    proposerId: uuid("proposer_id")
      .notNull()
      .references(() => users.id),
    marketId: uuid("market_id").references(() => markets.id), // a Tower market: a coordinated call
    cityMarketId: uuid("city_market_id").references(() => cityMarkets.id), // a City market: a pot stake
    side: callSide("side").notNull(),
    perShake: integer("per_shake"), // City only: GM from the pot per member who shook
    needed: integer("needed").notNull(),
    status: syndicateStatus("status").notNull().default("proposed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    liveAt: timestamp("live_at", { withTimezone: true }),
  },
  (t) => [
    check("syndicates_target", sql`(${t.marketId} IS NULL) <> (${t.cityMarketId} IS NULL)`),
    check("syndicates_per_shake", sql`(${t.cityMarketId} IS NULL) = (${t.perShake} IS NULL) AND (${t.perShake} IS NULL OR ${t.perShake} BETWEEN 1 AND 50)`),
    uniqueIndex("syndicates_one_open_tower").on(t.crewId, t.marketId).where(sql`${t.status} IN ('proposed', 'live') AND ${t.marketId} IS NOT NULL`),
    uniqueIndex("syndicates_one_open_city").on(t.crewId, t.cityMarketId).where(sql`${t.status} IN ('proposed', 'live') AND ${t.cityMarketId} IS NOT NULL`),
  ],
);

export const syndicateShakes = pgTable(
  "syndicate_shakes",
  {
    syndicateId: uuid("syndicate_id")
      .notNull()
      .references(() => syndicates.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.syndicateId, t.userId] })],
);

// The Crew League ladder: each crew's place in its size group (division = place / 10).
export const crewLeague = pgTable(
  "crew_league",
  {
    crewId: uuid("crew_id")
      .primaryKey()
      .references(() => crews.id),
    sizeGroup: text("size_group").notNull(),
    place: integer("place").notNull(),
  },
  (t) => [uniqueIndex("crew_league_place").on(t.sizeGroup, t.place)],
);

// Each week's table, kept for league cards and the banner.
export const leagueWeeks = pgTable(
  "league_weeks",
  {
    week: date("week", { mode: "string" }).notNull(), // its Monday
    crewId: uuid("crew_id")
      .notNull()
      .references(() => crews.id),
    sizeGroup: text("size_group").notNull(),
    division: integer("division").notNull(),
    rank: integer("rank").notNull(), // within the division, before moves
    score: integer("score_milli"), // null: fewer than 5 callers
    moved: text("moved").notNull(), // up, down or stayed
    champion: boolean("champion").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.week, t.crewId] })],
);
