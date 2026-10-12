# ⚠️ PARKED: needs your attention

## Polymarket (owner: you)

Built since this was first parked (8 October):

- [x] **Odds worker + price-tick store.** `packages/core/src/polymarket.ts` polls Gamma's busiest events per category (read-only, no keys) and every tick is kept. Not yet the plan's "~50 curated markets": there's no curation list or sensitive-topic denylist.
- [x] **Resolution and void ingestion** (12 October). Each poll also looks up the markets we still hold open or frozen among Gamma's closed markets. Closed and `resolved` at 1/0 settles YES or NO; a 50/50 final voids. Tested on recorded Gamma payloads, end to end through settlement.

Still yours:

- [ ] **Resolution policy.** UMA can settle hours or days late: real markets sit closed with a result only "proposed" for days. Today they stay frozen and wait, with no timeout (`closedOutcome` in `polymarket.ts` says so). Decide: carry the card to the next bell, or void it after some time.
- [ ] **BTC 15-minute windows.** Not built; the feed only lists curated categories.
- [ ] **Polymarket's written OK on free calls** built on their data (the plan flags this as needed).
- [ ] **Verified builder tier** application (the free tier allows 100 relayer actions a day).
- [ ] **Legal opinion** for real trades (Gate 2).
