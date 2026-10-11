# Block Party: handoff

Written 11 October 2026, when the frontend moved to a new developer. This file covers what is left: the state of the repo, what was built and what is still to do. For UI polish and release checks, see [FRONTEND_ROADMAP.md](FRONTEND_ROADMAP.md). The full history is in [README.md](README.md), and the work waiting on the owner is in [PARKED.md](PARKED.md). The product plan, which is the source of truth for every decision, lives outside the repo at `~/Downloads/Block-Party-Product-Plan.md`.

## Read this first: the state of the repo

- **Branch `feat/backend-bricks`, local only.** There is no git remote yet and nothing has been pushed. Choose a host (GitHub or another) and push before anyone else clones the repo.
- **A lot of work is uncommitted, and it belongs to two different people:**
  - **Backend room-access work** (another developer): `apps/api/src/app.ts`, `apps/api/test/api.test.ts`, `apps/rooms/src/worker.ts`, `apps/rooms/test/rooms.test.ts`, `packages/core/src/{room,ticket}.ts`, `packages/core/test/room.test.ts`, `packages/db/src/{accounts,chat,real-money}.ts` and their tests. It adds `roomAccess` and `POST /internal/rooms/access`, and the rooms Worker now refreshes safety permissions before joins and actions.
  - **Frontend polish pass** (the new frontend developer): the many modified and new files under `apps/city`, including the `*-preview` routes, `CityAtmosphere`, `CityWater`, `CityStreetGlow`, `RoomLighting`, `DinerQuarter` and `TodayView`.
  - Review and commit each set on its own. Don't sweep them into one commit.
- **`apps/api/src/app.ts` was rebuilt once.** On 10 October it was accidentally emptied while uncommitted, then rebuilt from the dev server's compiled cache. Its compiled output matches the lost version byte for byte, and it typechecks again. Any comments the room-access developer wrote in the room-ticket route and `/internal/rooms/access` were lost, so they should re-read both.
- **Local settings:** the shared `.env` (symlinked as `apps/api/.env`) has `ODDS_SOURCE=polymarket`, so the local API polls live Polymarket. Use `mock` to work offline.
- **Running it:** `.claude/launch.json` starts the city on :3100, the API on :8787 (set `LOCAL_CRON=1` for the minute cron) and rooms on :8788. To sign in, a dev button on the guest screen says "claim as a Telegram tester". `?perf` on the city shows draw calls, triangles and memory.

## What exists (one paragraph each)

- **Backend (bricks 1–40).** Accounts, gm and the drip, streaks, residents, crews and gm chains, homes and Build mode, rent and jobs, the bell, moods, City Hall, moderation, live rooms (Durable Objects) and chat, rides, away life, notifications, the Tower (calls, Aura, Slate, bell show, duels, City and Crew markets, Right List), syndicates, the Crew League, Bunkers, Ratio, Tower Lights, and real-money controls (off). It also has the **Receipt Binder** query (`receiptBinder` in `packages/db/src/tower.ts`).
- **Live odds.** `packages/core/src/polymarket.ts` is a read-only Polymarket Gamma feed with no keys. It takes the busiest events per category (crypto, sports, politics, culture) and keeps at most 3 rungs of each ladder, the ones nearest 50/50. If every request fails, the feed throws, so the Tower shows "odds paused". It is wired with `ODDS_SOURCE=polymarket` on Node and Workers. Every odds surface carries the credit "Odds via Polymarket · Not affiliated".
- **The city** (`apps/city`, Next.js 16 and React Three Fiber, for the Telegram Mini App and the phone browser):
  - **Map:** a 6×6 board laid out as the plan's map (`citygen.ts`). Four districts sit around Genesis Square on the Mempool Lagoon, and Block 5 is locked behind its mining bar. Roads are 3 wide and every block has a green setback.
  - **Buildings:** Kenney's City Kit models (CC0, licences in `public/assets/kenney/*`). Towers rise toward the Prediction Tower and step down further out.
  - **Life on the map:** traffic with signals (`traffic.ts`), and residents who walk as solid bodies (`steer.ts`) using A* paths (`plan.ts`).
  - **Launch places:** Club Liquidity, Touch Grass Park, the Blockspace Canvas, the Bot Café, Block 5 and the Rollup are built and show locked pins.
  - **Lagoon:** chart billboards and "pending" Mempool Plots.
  - **Labels:** district badges and named pins that change with the zoom.
  - **Rooms:** an interior for every public place (`interiors.ts`). The **live screens** are the Tower's Odds Wall and the Watch Party screen (both on real odds), City Hall's noticeboard, and Hash Brown's chalkboard in the Diner (`roomfeeds.ts`).
  - **Screens:** chibi residents, a character sheet, and screens for every area of the app.

## What's left

### 1. Build next (frontend and API)

Done since this file was first written. All are in the working tree and not yet committed:

- [x] **The trophy wall and TV.** `GET /v1/homes/:id/binder` (the Receipt Binder) and `api.binder()`, drawn by `HomeDisplay.tsx`, with a `/home-display-preview` route.
- [x] **Visitors see your furniture.** `GET /v1/homes/:id` returns placed furniture and finishes, never storage, when the door is open and nobody has blocked the other.
- [x] **Live headcounts on pins.** `api.headcounts()` feeds the city board.
- [x] **Lagoon billboards** are labelled "CITY ART · NOT LIVE DATA".
- [x] **Performance re-measured** with the new visual layers (see [PERFORMANCE_BASELINE.md](PERFORMANCE_BASELINE.md)). Desktop: 146 draw calls, 414k triangles. Phone-sized window: 123 draw calls. Both are inside the plan's 100–150 budget.

Still open:

- [ ] **Commit the work above.** It is still uncommitted in the working tree.
- [ ] **Performance on a real mid-range phone inside Telegram.** This hasn't been measured; PERFORMANCE_BASELINE.md says how to do it. Desktop is already near the top of the budget, so check before adding more geometry.
- [ ] **Not yet checked:** map labels at full zoom-in and at night, and the Watch Party and Diner screens in the browser.

### 2. From the plan, not started

- [ ] **The BTC 15-minute windows** in the odds feed. The plan's odds worker wants these alongside the curated markets.
- [ ] **Copium Pharmacy** opens first as a counter in the Gwei Diner (Launch). Hackerspace runs as "Builder Night" in the Bot Café (Launch), so it has no building of its own on purpose.
- [ ] **Launch places have no interiors yet:** Club Liquidity, Touch Grass Park, the Blockspace Canvas game and the Bot Café.
- [ ] **The Roof** has the bell but not the leaderboards. Watch Party City markets and in-play calls aren't on its screen yet.

### 3. Waiting on the owner (see PARKED.md)

- [ ] **Polymarket's written OK** for free calls built on their data. This is needed before launch, even though the feed is now built.
- [ ] **Resolution policy:** UMA can settle late. Decide whether the card carries to the next bell or is voided.
- [ ] **Verified builder tier** (needed for real trades) and the **legal opinion** (Gate 2). Real money stays off until both are done.
- [ ] **Telegram bot token and domain.** These are needed for the real Mini App launch and the frame-rate test inside Telegram.
- [ ] **Proof of Neighbour providers** (phone and crypto verifiers, `PON_PEPPER`). The routes return 503 until then.

Note: PARKED.md still says the odds worker is "not started". The odds worker and price-tick store now exist, so the remaining Polymarket items are the four above.

## Ground rules (they've kept the project honest)

- `pnpm typecheck`, then each package's `pnpm test`. The database tests need local Postgres 15 (`blockparty_test`). Run `pnpm build` in `apps/city`.
- Testable logic goes in `.ts` files, because vitest can't import `.tsx`. Every guard gets a mutation check: break it on purpose and watch a test fail. Use real Postgres, never mocks.
- Edit files that hold someone else's uncommitted work with a proper editor or diff tool. Never let a script rewrite them wholesale. That is how `app.ts` was lost.
- When a file has other people's changes in it, commit only your own lines.
- No invented numbers in the UI (headcounts, odds, votes). Real data shows only with its credit line.
- `screenshots/` holds local captures, and some are of the age gate rather than the city. To take a sharp 2× capture, use a browser at 1600×1100 with device scale 2. Get past the age gate and wait about 25 seconds for the kit buildings to stream in.
