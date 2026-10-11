# Block Party — polish and completion roadmap

Updated: 10 October 2026. This is a working delivery checklist, not a claim that the app is production-ready. Implementation notes in README.md describe substantial existing backend functionality; deployed integrations and authenticated journeys still need verification.

## Completed visual passes

- [x] City and diner district detail, lighting, map labels and navigation.
- [x] Shared app navigation, Today dashboard, More menu, reusable loading/error/empty states.
- [x] Five-step onboarding: character, identity, traits, goal/room style, review and welcome.
- [x] Isolated development previews for the city, Today and onboarding.

These have local build/test and browser-preview coverage. Simulated previews do not establish that real account flows work end to end.

## Frontend polish queue

### 1. Social & Crew — current pass

- [x] Give social lists clear headings, counts and selected navigation states.
- [x] Improve fren rows, conversation entry points and discoverable place boards.
- [x] Add useful empty states and retry actions without inventing presence or unread counts.
- [x] Improve crew discovery, invite entry, roster, membership and pot hierarchy.
- [x] Provide clear clipboard success/failure feedback for invitations.
- [ ] Verify responsive layouts with isolated preview data and existing checks.
- [x] Profile sheet and conversation presentation: readable bubbles, composer, empty/loading states, native modal, Escape and focus restoration.
- [ ] Follow up: all crew management dialogs, complete keyboard audit and authenticated interaction coverage.

### 2. Home editor

- [ ] Furniture categories, search/filtering, storage and owned/available distinction.
- [ ] Clear selection, rotation, recolour and placement feedback.
- [ ] Save, failure, unsaved-change and exit states; comfortable mobile controls.

### 3. Tower & Results

- [ ] Market hierarchy, odds freshness, freeze times, pending/locked/expired calls.
- [ ] Clear result history, sealed receipts and empty/error states.
- [ ] Validate the entire free-call lifecycle against the real API.

### 4. Profile, settings and supporting screens

- [ ] Organize identity, progress, notification preferences and account controls.
- [ ] Apply the design system to City Hall, games, travel, help and moderation flows.
- [ ] Accessible dialogs, keyboard navigation, focus restoration, reduced motion and readable contrast.
- [ ] Extend architectural detail beyond the diner; check city performance before adding more geometry.

## What remains for a complete app

### Functional acceptance — verify existing implementations

- [ ] Walk a new resident through age notice, actual sign-in/claim, move-in, reload and returning session.
- [ ] Exercise daily GM, Slate publication, call submission/locking/settlement, bell and receipts with actual service data.
- [ ] Exercise two residents: fren requests, messages, boards, crews, invites, role permissions and blocking/reporting.
- [ ] Verify home buying/placement/save/reload, travel, live room admission and reconnect after lost connectivity.
- [ ] Verify stale sessions, failed requests, duplicate taps, empty accounts and permission-denied states.
- [ ] Run current full typecheck/test/build checks and API smoke tests with the required database; record failures honestly.

### Documented functional gaps to resolve or confirm

- [ ] Proof of Neighbour: configure phone/crypto verifier implementations and the keyed-hash pepper. API routes explicitly return 503 without them.
- [ ] Recheck README’s recorded wearable-equipping endpoint and visitor home-layout gaps against current code; implement any still missing before promising those experiences.
- [ ] Reconcile README’s later-brick notes for notification triggers, moderation scheduling, stakes/rent accounting and away-resident scaling. Some notes predate subsequent implementation and need a code audit.

### Integrations and release readiness — not established by visual previews

- [ ] Reconcile PARKED.md with the actual odds-provider code: confirm live curated markets, tick storage, stale-feed handling and resolution policy. Its early “not started” wording may be stale.
- [ ] Verify production account providers and Telegram launch flow using configured domain and credentials.
- [ ] Confirm hosting, database migrations, Worker bindings, secrets, CORS, scheduled bell/notification jobs and public health checks in the target environment.
- [ ] Validate notification delivery/preferences and moderation/report handling with the actual providers.
- [ ] Measure loading, frame rate, memory and battery behavior on mid-range phones and inside Telegram.
- [ ] Establish error monitoring, operational alerts, backups/restore verification and a rollback procedure.
- [ ] Review release copy, privacy/account lifecycle, support contact and launch eligibility requirements.
- [ ] Keep real-money functionality gated until its separate provider, reconciliation and launch prerequisites are verified; see PARKED.md and README.md. It is not required to validate the free social experience.

## Acceptance rule

Mark implementation and verification separately. A passing preview proves presentation and simulated interaction only. Mark a release item complete only with evidence from its intended environment. Do not replace unfinished integrations with production mock data.

## Session log

- 10 Oct: roadmap written before beginning the Social & Crew pass. Next: implement list/discovery hierarchy and invitation feedback, then verify mobile/desktop previews.

- 10 Oct: implemented the first Social & Crew pass: counted navigation, fren/conversation rows, board cards, discovery hero, crew overview, loading retries and invitation clipboard feedback. Added `/community-preview` with in-memory ready/empty/loading/error fixtures; unsupported writes fail without making API requests.
- Validation: city TypeScript and production build passed; 6 existing tests across messageFeed, chatDraft, banner and who passed. Browser validation was blocked by the in-app browser becoming unavailable; responsive styling is implemented but not yet visually signed off. Detailed profile/chat/management-dialog polish and authenticated end-to-end verification remain open.

- 10 Oct, continuation: browser connection restored. Checked social list and profile on desktop, social/conversation/crew overview at 390px, social/crew errors, and profile Escape with focus returning to the opening button. Fixed preview-toolbar overlap on phones. Added conversation fixture messages and saved `screenshots/community-chat-mobile.png`. Four targeted tests passed; TypeScript and production build passed. Boards, discovery, invite clipboard behavior and all management actions still need their full browser walkthrough; no real messages/accounts changed.


## 11 October — next-build priorities

### Built in this pass

- [x] Receipt Binder API route and trophy display, using the existing revealed-only query.
- [x] Placed trophy walls and TVs open readable displays in live homes; TV shows the existing last-bell Slate recap for the signed-in viewer.
- [x] Visitor furniture route and client loading, subject to open-door/block checks, without storage exposure.
- [x] Public-place aggregate headcounts from room directories to map pins, polled every 15 seconds. Failed values are omitted, not presented as zero. No private-home counts are exposed.
- [x] Billboard charts explicitly labelled “CITY ART · NOT LIVE DATA”; removed misleading percentage readouts.
- [x] Remeasured local city day/night and narrow-viewport performance; see PERFORMANCE_BASELINE.md.

### Verify next

- [ ] Authenticated two-resident walkthrough of decorated homes, placed-object display interactions and pin-count updates through the deployed API/rooms pair.
- [ ] Full receipt and TV empty/error/retry coverage on phones, plus a fuller TV presentation if more than the current Slate recap is wanted.
- [ ] Phone/Telegram profiling on real mid-range hardware. Desktop narrow view is not a phone benchmark.

### Production completion

- [ ] Complete service/provider configuration, operational monitoring and full resident lifecycle acceptance from the release checklist above.

Validation: workspace typecheck and city production build passed; new visitor access integration test passed on Postgres; all 21 rooms tests passed. Trophy and TV previews visually inspected. Added fail-closed handling for missing room-access records exposed by typechecking. Home displays currently open as panels from the placed objects; receipts are not rendered as textures on the 3D wall itself.
