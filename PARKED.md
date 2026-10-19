# ⚠️ PARKED: needs your attention

## Polymarket (owner: you)

Built since this was first parked (8 October):

- [x] **Odds worker + price-tick store.** `packages/core/src/polymarket.ts` polls Gamma's busiest events per category (read-only, no keys) and every tick is kept. Not yet the plan's "~50 curated markets": there's no curation list or sensitive-topic denylist.
- [x] **BTC 15-minute windows** (19 October). The 15-minute warm-up has its own read-only feed of Polymarket's "Bitcoin Up or Down" windows, apart from the Tower's markets, settled by the same rules. Built and tested, behind `FEATURE_WARMUP`, which is off (README brick 44).
- [x] **Resolution and void ingestion** (12 October). Each poll also looks up the markets we still hold open or frozen among Gamma's closed markets. Closed and `resolved` at 1/0 settles YES or NO; a 50/50 final voids. Tested on recorded Gamma payloads, end to end through settlement.

Still yours:

- [ ] **Resolution policy.** UMA can settle hours or days late: real markets sit closed with a result only "proposed" for days. Today they stay frozen and wait, with no timeout (`closedOutcome` in `polymarket.ts` says so). Decide: carry the card to the next bell, or void it after some time.
- [ ] **Polymarket's written OK on free calls** built on their data (the plan flags this as needed).
- [ ] **Switch the warm-up on** (`FEATURE_WARMUP=on` on the API Worker) only once Polymarket's written OK on free calls against its odds and a legal check of the warm-up are both in: short up-or-down windows read like binary options, which EU regulators have barred from retail since 2018. It's built, tested and off.
- [ ] **Verified builder tier** application (the free tier allows 100 relayer actions a day).
- [ ] **Legal opinion** for real trades (Gate 2).

## Ideas from Lagos Life (owner: you)

Lagos Life, a browser life-sim set in Lagos, launched on 1 October 2026 and reports millions of sign-ups. On 17 October we copied the parts that fit Block Party and need no business call (see HANDOFF.md, "Ideas from Lagos Life"). These need yours:

- [ ] **Selling ad space to real brands.** This is most of their revenue: roadside billboards (about ₦5K a week), lagoon plots (about ₦18K), and artists paying about ₦50K to have their music played in clubs. Our lagoon already has chart billboards and "pending" Mempool Plots, labelled "CITY ART · NOT LIVE DATA". Selling them needs pricing, an ad policy (no gambling or crypto shilling next to free calls), a way to take payment, and the privacy policy.
- [ ] **Sponsored places and partner apps.** They opened a venue tied to a real services company and put a health-care partner in the phone menu. Same questions as above, plus whether a sponsor may run anything inside the Mini App.
- [ ] **Not copied on purpose.** They sell game money for real money (purchases final, never withdrawable), a ₦500 real-money stadium seat and a real-money IPO panel. Press coverage on 12 October questioned exactly this, along with who controls player data. Our real-money path stays behind the legal opinion, and GM can't be bought.
- [ ] **A games hub** (Chess, Ludo, Whot, Ayo, zero-stake tables between friends). It fits the rooms, but it's a large build. Decide whether it comes before the launch places' interiors.
