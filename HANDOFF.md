# Block Party: handoff

Written 11 October 2026, when the frontend moved to a new developer. This file covers what is left: the state of the repo, what was built and what is still to do. For UI polish and release checks, see [FRONTEND_ROADMAP.md](FRONTEND_ROADMAP.md). The full history is in [README.md](README.md), and the work waiting on the owner is in [PARKED.md](PARKED.md). The product plan, which is the source of truth for every decision, lives outside the repo at `~/Downloads/Block-Party-Product-Plan.md`.

## Read this first: the state of the repo

- **Repo:** https://github.com/isaac-richie/Block-party, branch `feat/backend-bricks` (the default). The repo is **public**, so never commit `.env` or the product plan.
- **Everything since 11 October is on the fork** https://github.com/Woshvad/Block-party, whose default branch `main` holds all of it. It builds up in three branches, each on top of the last: `fix/review-findings` (the review), `feat/lagos-ideas` (ideas from Lagos Life) and `feat/backlog` (the backlog pass, 19 October). None has a pull request on the upstream repo yet.
- **Everything is committed.** The latest two commits are the room-access backend (`roomAccess`, `POST /internal/rooms/access`, visitor homes, binder and headcount routes) and the frontend polish pass (navigation, Today, onboarding, social and crew, the trophy wall and TV, the city atmosphere, water, the diner quarter, and the `*-preview` routes).
- **`apps/api/src/app.ts` was rebuilt once.** On 10 October it was accidentally emptied while uncommitted, then rebuilt from the dev server's compiled cache. Its compiled output matches the lost version byte for byte, and it typechecks again. Any comments the room-access developer wrote in the room-ticket route and `/internal/rooms/access` were lost, so they should re-read both.
- **Local settings:** the shared `.env` at the repo root (every script, the dev server and the test suites read it, after any `.env` in their own package; no symlinks needed) has `ODDS_SOURCE=polymarket`, so the local API polls live Polymarket. Use `mock` to work offline.
- **Running it:** `.claude/launch.json` starts the city on :3100, the API on :8787 (set `LOCAL_CRON=1` for the minute cron) and rooms on :8788. To sign in, a dev button on the guest screen says "claim as a Telegram tester". `?perf` on the city shows draw calls, triangles and memory.

## Review fixes (12 October 2026)

An outside review (a static read of the whole repo, then fixes with tests) ran on 11 and 12 October. The fixes are on the branch `fix/review-findings`, built on `feat/backend-bricks`, and pushed to the fork (above): open a pull request and let CI run before merging. On its last commit, typecheck, every package's suite and the city build passed on a Windows dev machine against Postgres 15: core 664, db 850, API 652, rooms 54 and city 263 tests (before the review: 562, 774, 608, 21 and 138). The API suite took 49 minutes there.

What it fixed:

- **CI never ran.** The workflow only triggered on `main`, which doesn't exist. It now runs on every push and PR, on Node 22 (vitest 5 needs it) and Postgres 15, and builds the city. The tests also run on Windows, and each checkout gets its own test databases.
- **Tower: live calls never settled.** The Polymarket feed now looks up the markets we hold among Gamma's closed ones: resolved YES or NO, a 50/50 final voids, and a result that's only "proposed" waits (the carry-or-void timeout is still the owner's call). Markets that leave the feed freeze and stop taking calls. An empty or unreadable poll counts as failed, every request has a timeout, and sample odds say "Sample odds · Not real", never "Odds via Polymarket".
- **Economy.** Rent counts GM held in open stakes and runs first on Saturdays. Each bell step records itself when it finishes, so a failure later in the bell doesn't replay it. A missed day's Grudge and Tower Lights escrow settles at the next bell. The odds poll no longer grants streak days inside its transaction (it could deadlock with gm). The ledger has a time index, so the reel and the economy report stop scanning all history.
- **Safety.** The minute cron runs the AI moderation check when `OPENAI_API_KEY` is set; flagged text comes down where it lives, and staff have a Flagged tab. `BLOCKED_WORDS` applies on every send path, in the API and the rooms. Lookalike letters (Cyrillic, Greek and more) are folded, more link tricks are caught, boards are limited to real places, and starting a phone check no longer says whether the number is taken.
- **Players.** Pushes carry an Open button once `CITY_URL` is set, and playing soon after a push counts as opening it, so active players aren't throttled to weekly pushes. Mod Shifts resume after leaving the screen. A retry after a lost reply reuses its idempotency key instead of paying twice.
- **Rooms.** Each socket is rate-limited before any I/O, access is cached for 15 seconds instead of fetched for every action, and block lists are out of tickets and socket attachments. Presence is reconciled, so a dropped socket can't vote in person for weeks. Room effects go through a stored outbox, and a suspension closes with its own code (4002).
- **API and deploy.** The API refuses to run with a missing or placeholder bot token or a secret under 32 characters, the rooms Worker refuses connections with a missing or weak secret, and both say why on `/health`. Failed cron jobs are logged by name. The app is built once per isolate. `wrangler.jsonc` and README "Deploying" list every var and secret, with `OWNER ITEM` placeholders for what doesn't exist yet. A production city build fails without an https `NEXT_PUBLIC_API_URL`.
- **City.** Error boundaries with a 2D fallback and Retry, so one failed model download no longer takes the app down. The Telegram BackButton, safe areas, start links (`i-<code>` for crew invites, `n-<id>` for pushes) and closing confirmation. Odds boards say when the feed is paused. Place names show at the phone's starting zoom, with headcounts in their own badge. Kit models share one texture per pack, the board stays mounted between tabs, and there's a low quality tier (`?quality=low|high`, or Graphics in Me).

Still open after it (engineering; the owner's items are in section 3 below):

- **Nothing has run inside Telegram or on a phone.** The BackButton, safe areas, start links and the low tier need a device check, and the frame-rate test is still to do. The `?perf` meter now counts every pass, shadows included, so its numbers are higher than the old 146 draw calls (main pass only).
- **Account deletion, export and retention.** Residents, crews and items can't be deleted by design (database triggers). This needs the owner's privacy policy first.
- ~~**A staff rename for flagged @handles.**~~ Done (README brick 45): Rename on flagged handles and names, on every report and by handle in Controls, a neutral handle unless staff type one, a notice on the resident's next open, the old handle rests 30 days, and the resident can appeal it once (other staff decide; overturning gives the handle back).
  - **Still open:** a resident in a live room when they're renamed keeps the old name tag there until they next join a room (the room ticket carries the handle). After the 30 days, old `p-<handle>` links open whoever takes the handle next; the notice only promises they won't find the resident. The rename UI is checked by unit tests only, not yet in a browser.
- **Promised but inert:** of the four alert toggles that had no producer, shift done, away shift ready and Bell in 2h now fire (19 October); warm-up settled is sent by the warm-up, behind its switch. The crew bot's three posts (syndicate call, Bell in 15, the crew card) still can't go out: no crew is linked to a Telegram group, because the API takes no bot updates (no webhook, no `/crew`). Contrarian Day and NOTHING Day have their rules now (README brick 44, with Blind Slate finished).
- **Pushes at launch scale.** The minute cron sends up to 600 pushes (kept under a Worker's 1,000 subrequests a run), so "Bell in 2h" reaches about 18,000 residents before it expires; a bigger city needs Telegram's paid broadcasts or a queue consumer. An event alert that fires more than once a day (a fade, a Snap, a nap) runs out of fresh lines within the week, and the extras are held back rather than repeat wording.
- **Bell Modifiers, still open:** the banner tile is a home piece until crew banners take earned tiles; the share line shows no gold borders; a syndicate proposed just before a Blind Slate went out still shows its side on the Crew Table; NOTHING Day is judged at the bell with a late card counting 0, so revisit it if the late-settlement policy carries cards to the next bell.
- ~~**The Tower's odds could be 5 minutes old.**~~ Gamma answers with `Cache-Control: public, max-age=300` and Cloudflare serves it from cache, and the odds poll asks the same address every minute (seen 19 October: a HIT 68 seconds old). Fixed the same day: both the warm-up's feed and the Tower's (`polymarket.ts`) put the poll's time in every address, so each poll gets a fresh answer.
- **An asset pipeline** (built 19 October, except compression). Unused models are gone and tangents stripped, so `public/assets` fell from 16.75 MB to 6.84 MB. The packs sit in content-hashed folders (`pnpm --filter @bp/city assets`), with immutable cache headers in `public/_headers` and `next.config.mjs` (README "Deploying"). A page opened before a deploy that changed a pack offers Reload on the map.
  - **Still open:** meshopt needs glTF-Transform, a new dev dependency (the owner's call; PERFORMANCE_BASELINE.md has the commands), and the chosen host must compress `.glb`.
  - **Still open:** that Reload is tested headless only. Try it in a browser: open the map, rename a pack folder and `/assets/kit-packs.json` to match, then retry.
- **A load test** on Workers and Hyperdrive: a Saturday bell, a 60-socket room, a reconnect storm after a deploy.
- **Profile the API suite** (done, 19 October). It took 48 minutes on the Windows dev machine, 47 of them the fuzzer: about 180,000 requests one after another, each mostly waiting on Postgres (a round trip to Postgres in Docker is about 1.2 ms there). Test files now run in parallel, each worker on its own copy of the database, and the fuzzer runs as three shards, 8 routes at a time, with every test and assertion kept. The API suite takes under 5 minutes, the db suite 1.5 (was 6), and CI allows 30 minutes for the whole job.
- **Still open from it:** a suite can hold about 75 of Postgres's 100 connections at its peak, so several checkouts testing on one Postgres should set `VITEST_MAX_WORKERS=2`.

## Backlog pass (19 October 2026)

The engineering items that needed no owner decision, built in parallel lanes. Two reviewers (correctness, and the plan's rules and security) checked each lane, and 39 of their findings were fixed with tests. The branch is `feat/backlog`, and its migrations are 0054 to 0057.

- **Faster tests.**
  - **Speeds:** the API suite went from 48 minutes to about 5, and the db suite from 6 minutes to under 2.
  - **How:** each vitest worker gets its own database copy, and the fuzzer runs in three shards. No test was removed or weakened.
  - **CI:** its timeout is now 30 minutes.
- **Every alert fires** (README brick 13's notes). Shift done, away shift ready and Bell in 2h now have producers, each once per event and dropped if it's stale. The daily ping mentions an open make-good or today's clue, still one ping a day.
- **The Bell Modifiers' rules** (brick 44): Contrarian Day's gold border, NOTHING Day's banner tile, Blind Slate finished. None touches Aura, GM or real trades.
- **Staff renames for flagged @handles** (brick 45), with a 30-day rest for the old handle and one appeal.
- **The Roof's leaderboards** (README Frontend): the Right List, the Season Stack and the crews, from `GET /v1/roof`. The Watch Party's screen shows the Hall's City markets.
- **Kit assets** (README Frontend): unused models removed, so `public/assets` is 6.84 MB instead of 16.75 MB, in content-hashed folders. Compression is the owner's call (PERFORMANCE_BASELINE.md).
- **The 15-minute Bitcoin warm-up** (brick 46): built and tested, but off behind `FEATURE_WARMUP` until Polymarket's written OK and a legal check (PARKED.md).
- **Fresh Tower odds:** every Gamma request carries the poll's time, so Gamma's 5-minute cache can't serve old prices.

Tests: on the merged branch, typecheck, every package's suite and the city build passed: core 751, db 1,035, API 759, rooms 61 and city 407. The API suite took 5.4 minutes.

**Checked in a browser** against the local API and rooms, at phone and desktop size:
- moving in a new resident
- the city board's neighbours line
- the clue hunt end to end (the riddle, walking to the Faucet, the search, the trophy and the count)
- Me's Share and Graphics choices
- List view, with no canvas at all
- the Tower with the warm-up off
- the Roof's three screens and their route

**Still open from this pass:**
- **Pushes at launch scale.** The cron sends up to 600 a run (see the line above).
- **Bell Modifiers' leftovers.**
- **The renamed handle in a live room:** it stays until that resident rejoins a room.
- **Meshopt compression,** which needs the owner's OK for a new tool.
- **The warm-up's "Welcome back" grant,** which belongs to the Launch phase.
- **Crew-bot posts.** They need a Telegram group link, and the API takes no bot updates yet.

## Ideas from Lagos Life (17 October 2026)

Lagos Life, a browser life-sim set in Lagos, launched on 1 October 2026 and grew fast. Its dated updates up to 15 October were reviewed, and the ideas that fit Block Party without a business decision were built. They're on the branch `feat/lagos-ideas`, built on `fix/review-findings`, and pushed to the fork. The migrations are 0050 to 0053. What needs the owner (selling ad space, sponsored places, a games hub) is in [PARKED.md](PARKED.md).

- **The Daily Clue Hunt** (brick 41).
  - **How it works:** each city day something is hidden at one public place, picked at random on the server. Today shows a riddle, and each resident gets one search a day, where they stand.
  - **The prize** is a trophy for the home: one on the first find, another at 7 finds. There's no GM, because the clues live in the public repo.
- **Make-goods** (brick 42).
  - **What:** staff can give every resident up to 200 GM after an outage, at most once a week, with a reason everyone reads.
  - **How:** residents collect it on Today within 14 days. Nothing loops over every resident. It's minted under its own ledger kind, paid once per resident, and the record can't be edited or deleted.
- **Watch Party big moments** (brick 43).
  - **What:** when a Tower sports market settles, or swings 15 points in 30 minutes, the Watch Party's big screen and a card show it, with quick reactions and "Make your call".
  - **How:** the API sends it through a new `/internal/moment` rooms route, at most once per result and once an hour per swing.
- **Pinned chats.** Pin up to 5 DMs to the top, synced across devices. The crew lead or a deputy can pin one crew message.
  - **Ship the API and the city together:** `GET /v1/crews/mine/chat` now answers `{ pinned, messages }`.
- **Sharing.**
  - **Links:** a Share button on locked calls (a signed receipt link, `r-...`) and on your profile (`p-<handle>`). It uses Telegram's share sheet inside Telegram, otherwise the phone's share sheet or the clipboard.
  - **Tilt:** no share buttons on calls while a resident is tilted, as the plan asks.
- **The home camera:** zoom buttons, a clean view with every button hidden, and a Photo button that shares or saves a PNG.
- **Install to home screen:** a web app manifest and icons, for the phone-browser version.
- **Neighbours online now:** the board shows "N neighbours in the city now" from the live headcounts. It shows nothing while they're unknown, never 0.
- **List view:** a choice under Me → Graphics that drops the 3D map for the places list, with no WebGL at all. A phone without WebGL gets it automatically.

Tests: on the merged branch, typecheck, every package's suite and the city build passed on the same Windows machine against Postgres 15: core 707, db 909, API 701, rooms 61 and city 327 (after the review fixes: 664, 850, 652, 54 and 263). The API suite took 53 minutes. Every new guard was broken on purpose to check that a test goes red.

Still open:

- **Nothing here has been tried inside Telegram or on a phone.** That includes the share sheets, the photo on iOS and Android, install from the browser, and the list view on a weak phone.
- **Sharing an image to a Telegram story** needs hosted image storage (R2 or similar).
- **No swings during a match.** Polymarket sports markets freeze at kickoff and the feed stops pricing them, so during a match the only moment is the result. Fixing that means changing how markets are ingested.
- **Moments are best effort.** If the rooms refuse one, it's recorded as sent and never retried.
- **Make-goods and the clue in pushes** (done 19 October, as wording): the daily ping mentions a make-good the resident can still collect, else today's clue. Its reasons don't change, so a resident with a broken streak and nothing riding gets no ping and hears about neither.
- **Make-good limits are written twice.** The database checks hardcode 200 GM and 80 characters, so changing `MAKE_GOOD` in core needs a migration too.
- **DMs with blocked people.** These threads still show in the list, as before, and can stay pinned. Hiding them would change existing behaviour.

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
  - **Rooms:** an interior for every public place (`interiors.ts`). The **live screens** are the Tower's Odds Wall and the Watch Party screen (both on real odds; the Watch Party's also carries the Hall's City markets), City Hall's noticeboard, Hash Brown's chalkboard in the Diner, and the Roof's three leaderboards (`roomfeeds.ts`).
  - **Screens:** chibi residents, a character sheet, and screens for every area of the app.

## What's left

### 1. Build next (frontend and API)

Done since this file was first written:

- [x] **The trophy wall and TV.** `GET /v1/homes/:id/binder` (the Receipt Binder) and `api.binder()`, drawn by `HomeDisplay.tsx`, with a `/home-display-preview` route.
- [x] **Visitors see your furniture.** `GET /v1/homes/:id` returns placed furniture and finishes, never storage, when the door is open and nobody has blocked the other.
- [x] **Live headcounts on pins.** `api.headcounts()` feeds the city board.
- [x] **Lagoon billboards** are labelled "CITY ART · NOT LIVE DATA".
- [x] **Performance re-measured** with the new visual layers (see [PERFORMANCE_BASELINE.md](PERFORMANCE_BASELINE.md)). Desktop: 146 draw calls, 414k triangles. Phone-sized window: 123 draw calls. Both are inside the plan's 100–150 budget.

Still open:

- [ ] **Performance on a real mid-range phone inside Telegram.** This hasn't been measured; PERFORMANCE_BASELINE.md says how to do it. Desktop is already near the top of the budget, so check before adding more geometry.
- [ ] **Not yet checked:** map labels at full zoom-in and at night, and the Watch Party, Diner and Roof screens in the browser (`/room-social-preview` has samples of the Roof's and the Watch Party's).

### 2. From the plan, not started

- [x] **The BTC 15-minute windows.** The 15-minute warm-up has its own feed of them, apart from the curated markets (README brick 44). Built and tested behind `FEATURE_WARMUP`, which stays off.
- [ ] **Welcome back (Launch):** after 14+ days away, a Hodl Day, a comeback tag, a warm-up and a crew ping. None of it is built; the warm-up's one-a-day rule would take a comeback day once the rest exists.
- [ ] **A free 10-minute City market** for the warm-up's fallback, as the plan has it. City markets are staff-written, take GM and a Tower ticket and settle at the bell, so for now the warm-up has no fallback: it says when the next window opens, or that the feed is quiet.
- [ ] **The warm-up before moving in, inside Telegram.** A guest in a browser meets the Contrarian on the guest panel, but a Telegram arrival goes straight to Create-a-Resident and meets him in the Tower after. The guest panel's line also needs its browser check: the map tools move up by an estimate of its height.
- [ ] **Copium Pharmacy** opens first as a counter in the Gwei Diner (Launch). Hackerspace runs as "Builder Night" in the Bot Café (Launch), so it has no building of its own on purpose.
- [ ] **Launch places have no interiors yet:** Club Liquidity, Touch Grass Park, the Blockspace Canvas game and the Bot Café.
- [x] **The Roof's leaderboards:** three screens (the Right List with NOTHING-9000's line, the Season Stack, the crews') from `GET /v1/roof`, and the Watch Party's screen shows the Hall's own City markets.
- [ ] **Free in-play calls in the Watch Party Hall** (MVP in the plan, on the big screen beside the room-only City markets). In the Hall, a free call on a match can be made after kickoff: it locks at the first tick at least 2 minutes after you confirm, for half the Aura. Backing for real still closes at kickoff. Not built: sports markets freeze at kickoff everywhere, so the Hall's screen shows only pre-kickoff odds and its City markets.
- [x] **The Season Stack ranks Proof of Neighbour residents only,** on the Roof and in Games, as the plan's risks table has it for every leaderboard and as the Right List already did.

### 3. Waiting on the owner (see PARKED.md)

- [ ] **Polymarket's written OK** for free calls built on their data. This is needed before launch, even though the feed is now built. It also gates the warm-up: `FEATURE_WARMUP` stays off until it and a legal check are in.
- [ ] **Resolution policy:** UMA can settle late. Decide whether the card carries to the next bell or is voided.
- [ ] **Verified builder tier** (needed for real trades) and the **legal opinion** (Gate 2). Real money stays off until both are done.
- [ ] **Telegram bot token and domain.** These are needed for the real Mini App launch and the frame-rate test inside Telegram.
- [ ] **Proof of Neighbour providers** (phone and crypto verifiers). `PON_PEPPER` is wired; the routes return 503 until a provider is built and configured.
- [ ] **Cloudflare account, Postgres, the Hyperdrive id, domains and the city's hosting.** `wrangler.jsonc` marks each as an `OWNER ITEM`; README "Deploying" lists the steps.
- [ ] **A privacy and retention policy**, before account deletion and export can be built.
- [ ] **The Lagos Life ideas that are business calls:** selling the lagoon billboards and Mempool Plots to real brands, sponsored places, and whether a games hub comes before the launch places' interiors (PARKED.md).

PARKED.md was brought up to date on 12 October: the odds worker, the tick store and resolution ingestion exist; the items above are what's left.

## Ground rules (they've kept the project honest)

- `pnpm typecheck`, then each package's `pnpm test`. The database tests need local Postgres 15 (`blockparty_test`). Run `pnpm build` in `apps/city`.
- Testable logic goes in `.ts` files, because vitest can't import `.tsx`. Every guard gets a mutation check: break it on purpose and watch a test fail. Use real Postgres, never mocks.
- Edit files that hold someone else's uncommitted work with a proper editor or diff tool. Never let a script rewrite them wholesale. That is how `app.ts` was lost.
- When a file has other people's changes in it, commit only your own lines.
- No invented numbers in the UI (headcounts, odds, votes). Real data shows only with its credit line.
- `screenshots/` holds local captures, and some are of the age gate rather than the city. To take a sharp 2× capture, use a browser at 1600×1100 with device scale 2. Get past the age gate and wait about 25 seconds for the kit buildings to stream in.
