# Block Party backend

pnpm monorepo. Built brick by brick; each brick ships with tests against a real Postgres.

| Package | What it is |
| --- | --- |
| `packages/core` | Pure domain rules (no I/O), safe to run in Workers |
| `packages/db` | Drizzle schema, migrations, and the services that touch Postgres |

## Setup

Needs Node 20+, pnpm 10, and Postgres 15 on localhost.

```bash
pnpm install
cp .env.example .env
createdb blockparty
pnpm db:migrate
pnpm test
```

Tests drop and recreate `blockparty_test` on every run (the name must end in `_test`).

## Bricks

1. **GM ledger** (done). Double-entry, append-only, idempotent. GM is only created from `sys:mint` and only destroyed into `sys:burn`, so `supplyStats()` gives the created/destroyed ratio the plan tracks. The database itself refuses unbalanced transactions, balance edits outside the ledger, forged balance chains, negative resident balances, and any edit or delete of history.
2. **Accounts** (done). Guest on first tap behind the 18+ notice; Telegram Mini App sign-in (HMAC `initData`, checked against an independent implementation); Privy claim (ES256 JWT, algorithm pinned). Claiming keeps the guest's GM; signing into an existing resident leaves the guest behind and never merges GM. Opaque session tokens, stored only as SHA-256 hashes, rotated on every sign-in.
3. **Daily habit** (done). One UTC city clock (the bell at 00:00). `sayGm` pays the drip once per city day: 50 GM, or 100 under 100 GM net worth (furniture, decor and wardrobe bought in the last 7 days still count). `recordStreakDay` pays the streak bonus (+5 a day, capped at +25) and is fired by the calls brick on a resident's first call of the day. Hodl Days: 1 at move-in, hold up to 2, a free one every 7-day streak, extras for 150 GM burned; spent only when they save the streak. Streak cards at 7, 30, 100 and 365. Claiming an account now pays the 1,000 GM move-in gift. Tests replay the plan's weekly math (casual +50 bonus a week, active +175).
   - Also fixed a brick 1 guard bug: posting to one account twice in one transaction was wrongly refused (migration 0004).
4. **Create-a-Resident** (done). Claimed accounts move in once: @handle (unique ignoring case, fixed at MVP), name, mix-and-match look (46 parts plus palettes), 3 of 12 traits (free swap once a season), a goal and a kit style. The city deals the backstory and its starter item server-side; the client can't pick it, and the database refuses any later change. Names and handles block impersonation of the cast and staff (leetspeak, homoglyph and spacing tricks included) and crypto scam bait, without blocking real first names. Name cleanup strips invisible, direction-flipping and tag characters (ASCII smuggling) while keeping emoji, skin tones and flags.
5. **Crews** (done). Create a crew (3 to 50 members, one crew per resident), a lead plus up to 2 deputies, invites (a lead or deputy link joins straight away; a member's link becomes a join request; open crews join in one tap), Open tables, removal strictly downward, lead hand-over. The crew pot takes deposits and only ever loses GM by burning; dissolving burns it. The gm chain settles at each bell from roster history (members at that bell, active = gm in the last 7 days, holds at 60% with at least 3), any 3 members from that day can relight a miss until the next bell, and it stores counts only, never who missed. The database enforces the roster limits, one lead, one crew per resident and append-only history.

## Testing rules

- Real Postgres, never mocks.
- Race tests use a lock barrier (`race()` in `accounts.test.ts`) that waits until every racer is provably blocked in Postgres. Plain `Promise.all` races ran one after another on a warm pool and hid bugs.
- Each guard gets a mutation check: break it on purpose and confirm a test goes red.
- `api-contract.test.ts` calls every exported service with garbage and fails on any synchronous throw (this bug shipped twice).
- Never let randomness make a test pass by luck: seed it or pin it.
- Check database errors by SQLSTATE on `error.cause` (Drizzle wraps them), and never turn an unknown error into a friendly one.
- Lock order everywhere: resident, then request/invite, then crew, then ledger accounts.
- Shared helpers live in `packages/db/test/helpers.ts`. Test files share one database, so assertions must be scoped to their own rows.

See [PARKED.md](PARKED.md) for work waiting on the owner.
