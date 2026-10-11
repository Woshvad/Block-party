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

## 11 October — reference-inspired showcase apartment

- [x] Added `/apartment-preview`: furnished cutaway apartment with parquet, sage kitchenette, island and stools, sectional lounge, media console, bedroom/wardrobe, bathroom, windows, plants and brass details.
- [x] Day/evening lighting, orbit/zoom controls, reset, optional room labels and responsive camera framing.
- [x] Combined static furniture/architecture into one vertex-coloured mesh with a separate ground mesh. Browser meter snapshot: 2 draw calls, 8.8k triangles; not a device performance guarantee.
- [x] Typecheck and production build passed during implementation; final presentation edits typechecked. Day/evening visually reviewed in the actual 319 × 847 browser pane. Desktop viewport override did not take effect, so desktop visual sign-off remains open.
- [ ] Convert approved architecture into editable room definitions and furniture catalogue entries with collision and navigation rules.
- [ ] Integrate resident movement, persistent layout saves and interactive TV/trophy surfaces into this apartment layout.
- This is a development-only visual prototype, not a replacement for existing resident homes. Screenshot: `screenshots/showcase-apartment.png`.

## 11 October — interactive apartment build plan

Plan recorded before implementation; completion status:
- [x] Make the bed, lounge seating, coffee table, TV, lamp and plants selectable and movable on a quarter-unit grid, with rotation, undo and reset.
- [x] Reject placements outside the apartment or intersecting fixtures/furniture; protect access between room entrances.
- [x] Add a resident who follows collision-aware floor paths, plus accessible destination controls.
- [x] Save this preview's layout locally with validation and explicit save feedback; preserve the separate production-home contract.
- [x] Open simulated TV and receipt displays from apartment objects and keyboard-accessible controls.
- [x] Verify layout/pathfinding with automated tests, typecheck/build and browser walkthrough; record the new rendering cost.

Still required for a full resident apartment: a versioned apartment definition in the shared catalogue, server-authoritative placement/navigation validation, migration of existing home layouts, authenticated saving, multiplayer movement/visitor sync, real account-backed media, and deployed two-resident/phone acceptance. Local preview persistence does not complete these integrations.


Interactive pass validation: all 135 city tests, TypeScript and production build passed. Six new layout tests cover initial room reachability, obstruction/out-of-bounds rejection, blocked destinations, rotated footprints, doorway protection and validated compact saves. Browser verified movement completion, selection, successful edits, rejected bed rotation, undo, save/reload, TV/receipt dialogs and Escape focus restoration. Both 319 × 847 and 1280 × 720 layouts were visually inspected. Browser meter snapshots: 14 draw calls in Explore / 15 in Arrange, 9.1k triangles, locally 120 fps in day/evening; no real-phone performance claim. The editor covers eight standalone furniture pieces; built-in fixtures and architecture stay fixed. Production apartment integration and multiplayer remain open as listed above.

## 11 October — social-city reference review (proposed, not implemented)

Reviewed nine user-supplied LagosLife screenshots against this roadmap and current room/life code. Screenshots establish visible interface patterns only; displayed player/visit counts and working multiplayer cannot be independently verified from them.

Our visual direction: keep the Sunday Apartment's warm materials, consistent palette, furniture detail and soft lighting. Strengthen visible social activity and reasons to visit existing places before adding more districts.

Recommended order:
1. **Live-room interaction panel.** Consolidate place name, real room headcount, connection state, chat and emotes into a compact, collapsible panel. Add keyboard-accessible contextual destination/action chips for existing places (Diner booth/counter, Roof ledge, watch-party front row). Existing chat, emotes, room counts and PLACE_ADVERTS provide foundations; explicit action handlers and navigation must be checked for each chip. Do not imply that every advertised object already has a player-triggered action.
2. **Clean view and legible names.** Hide optional overlays with an always-reachable restore control. Prioritize nearby/selected residents' labels and hide overlapping map labels by zoom; retain connection/error information and access to moderation. Add map category filters using existing destinations, with unknown/unavailable headcounts clearly distinguished from zero.
3. **Finish the shared home experience.** Integrate the new apartment definition, authoritative placement, account saves and visiting friends. Existing visitor furniture and display APIs are foundations; the showcase still needs its own production integration. Make sitting, resting and watching TV readable through poses and object feedback. Prioritize this over new map territory.
4. **Surface existing daily activity.** A compact Today card can show actual daily GM state, the resident's Slate progress and next bell. Build from authoritative data, without new streak penalties or a parallel rewards economy. Event teasers should use the existing big-night schedule and only advertise available experiences.
5. **Give current venues distinct identities.** Extend architectural polish from homes/diner to Roof and Watch Party through props, lighting and small ambient motion, then remeasure phone performance. Contextual chips should describe activities actually supported there.

Defer: additional cities, airports/vehicles/property expansion, cash gem hunts, hunger/hygiene maintenance bars and global popularity counters without a defined reliable source. These are new systems beyond the current social/calls/home completion work. Rested/Cozy mood presentation can use existing mechanics instead of adding survival meters.

Acceptance for the next social-room pass: desktop/mobile and keyboard walkthrough, collapse/restore, no overlapping essential controls, accurate live/stale/error states, reconnect-safe chat, two-resident presence/actions verification and an updated performance snapshot. Proposed priority does not mark these features complete or replace the production checklist above.

## 11 October — social-room panel implemented

- [x] Shared compact room panel wired into LiveRoom: actual room headcounts, chat, people/profile access, reactions and contextual actions.
- [x] Diner booth/counter, Roof front/back benches and Watch Party sofa/beanbag shortcuts select unoccupied seats from the actual scene plan. Existing server seat-taken handling remains authoritative for races.
- [x] Available TV, trophy and nap actions consolidated into the panel in live homes.
- [x] Clean view hides panel and optional name/NPC overlays, expands the scene and retains City/restore controls, connection warnings and error feedback.
- [x] Reconnecting/stopped rooms do not present stale headcounts as live. Sending, reactions and seating are disabled; drafts remain editable and survive collapse/restore. Existing delivery acknowledgement/timeout handling is retained.
- [x] Keyboard-accessible people list, labelled reaction buttons, Escape to close expanded sections, focus restoration on minimize and reactions.
- [x] Added development-only `/room-social-preview` using the same panel and interiors, with clearly simulated chat/seating/profile/reaction feedback and connection fixtures. No live socket or account writes from the preview.
- [x] 138 frontend tests, TypeScript and production build passed during this pass. Three new action tests cover real seat groups, occupied/full groups and unsupported venues.
- [x] Browser: conversation send/history, seating, people list, Escape, reconnect disabling, draft retention and clean-view restore verified at 1280 × 720. Diner preview snapshot: 24 draw calls, 12.4k triangles, locally 120 fps with four sample residents.
- [ ] Mobile visual sign-off: responsive styles implemented, but browser viewport override did not take effect in this run.
- [ ] Deployed two-resident walkthrough, seat contention/reconnect and actual-device performance verification remain required. This pass does not establish those results.

Remaining reference proposals: map label decluttering/filters, existing daily activity card polish, richer venue visuals and the production shared-apartment integration.
