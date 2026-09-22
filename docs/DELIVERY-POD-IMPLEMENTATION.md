# Delivery POD implementation and routing UI refinement

## Current driver-access work

The private POD backend and Gmail test have since been activated; the user confirmed receipt (in spam). The older preparation notes below are historical. See [POD-GMAIL-PILOT.md](POD-GMAIL-PILOT.md) for deployed state and [POD-DRIVER-ACCESS.md](POD-DRIVER-ACCESS.md) for the activated driver screen, administrator-only editing and backup-driver assignment. The v375 driver update is deployed only to the private preview; main ATLAS is unchanged.

## Gmail pilot local preparation — September 21

The Gmail pilot now extends the existing POD function, local schema drafts and management status/retry controls. Sending remains disabled, with no Supabase changes or real emails. See [POD-GMAIL-PILOT.md](POD-GMAIL-PILOT.md) for exact setup, reauthorization, verification, rollback and outstanding activation work. This supersedes the older statements below that email provider code has not been prepared. Local shell marker: v374-pod-gmail-pilot; the deployed testing host still runs the previous v373 release.

## Current integration status — September 21

The real routing application now contains the compact desktop dashboard, mobile view tabs, waiting-load list, next-load capacity card, collapsed trip details, existing saved-route search and settings/map dialogs. These views use existing saved-day data. Priority moves display their actual repacked trips, preserve sent-out allocations, clear stale timing and persist through the existing Save Day contract. Capacity-based displacement suggestions are implemented; traffic-based comparison of candidate swaps is still pending. Moves do not create hard per-trip reservations: the existing load allocator repacks order priority and the review shows the resulting trip assignments.

POD capture/review/rotation, multipart submission, immutable object handling, JPEG-to-PDF assembly and authenticated download have local source and synthetic integration coverage. They are **disabled by default**. The new `delivery-pod` Edge Function was not deployed. `tools/delivery-pod/schema-draft.sql` was not applied and is deliberately not represented as a generated or verified migration. The user approved local test-tool installation. PGlite 0.3.16 is installed as a pinned, development-only dependency under tools/delivery-pod; its PostgreSQL 17.5 engine executed this draft successfully against synthetic prerequisites. The connected database reported PostgreSQL 17.6. Supabase CLI and Deno are still absent; hosted integration and concurrent-session testing remain outstanding. The connected database was queried read-only to verify existing source schema and authorization helpers.

The user explicitly approved local POD backend preparation. That approval does not authorize applying the schema, provisioning driver/office memberships, enabling the endpoint or sending emails. The existing routing schema, auth functions, COC functions and storage policies are untouched.

Current POD gaps before activation: hosted Auth/Storage/Edge integration and concurrent-session tests; immutable split allocation approval before partially dispatched orders can bind (draft currently requires fully dispatched order allocation); driver account provisioning and dedicated driver entry; crop/perspective correction and broader quality checks; replacement/history UI and versioned NetSuite handoff; email outbox/provider integration. Existing draft submissions reserve an immutable ID/content manifest; the UI prevents editing a submitted retry. Unfinished scans and reviewed submission IDs now persist atomically in IndexedDB, partitioned by account and warehouse. Done retains the draft; reopening restores pages. Only explicitly submitted scans retry while ATLAS is open. Before upload, the authorized shipment list reconciles an existing receipt, avoiding another image upload after a lost response. At most three attempts occur before manual retry; access/conflict errors stop automatic retries. There is no polling or closed-app background delivery. Local copies remain until the user explicitly removes a received copy. Browser storage eviction/site-data clearing and origin changes still limit recovery. None of these are claimed complete.

Shell marker: v373-pod-recovery. POD feature flags default off in the private host and Edge Function. Main ATLAS sidebar, workbook/COC generation, and production remain unchanged. In-memory photos reset on account changes and closing the routing workspace; persisted copies remain scoped to the original account and warehouse. Uncommitted/local-storage-failed pages keep a leave-page warning. Physical iPhone/Android and installed-app cache upgrade checks remain outstanding. The focused real-IndexedDB browser test is `node tools/delivery-pod/check-recovery.cjs` with existing Playwright/browser paths configured (see tools/delivery-pod/README.md). It covers closed-page recovery, offline submission, uncertain receipt reconciliation with one photo upload, account/warehouse separation and truthful storage-failure handling.

Local commands: `node --test tests/delivery-pod-sql.test.mjs` (17 passing: parent plus 16 SQL scenarios), `node tools/run-regressions.cjs` (350 passing), `git diff --check`, plus the isolated `pod-routing-polish-qa.cjs` browser harness at 1600, 1440 and 390 px. Browser coverage includes queue move preview, save/reopen priority, taps/hold-to-drag/cancellation, unchanged sidebar, no overflow, and synthetic POD image -> real local handler -> PDF receipt with mocked authorization/storage. Local SQL tests now also execute the draft and test role grants, assignment/warehouse isolation, session revocation, stale links and idempotent receipts. They use simulated claim helpers and prerequisite tables, not hosted Supabase services; this is not evidence of deployed database security or a production-ready POD workflow. See tools/delivery-pod/README.md for installation and limitations. Historical COC section 91–117/119 runners/fixtures are still missing.

The following sections preserve the earlier audit/design record; this current-status section supersedes earlier statements that POD helpers are not loaded or UI changes are styling only.


## Scope and current state

Requested September 21, 2026 from ATLAS_POD_Document_Scanning_Implementation_Specification_v1.md and the nine-slide management mockup. Later clarification: polish Delivery Routing and POD screens only; preserve the existing ATLAS sidebar and other application screens. Typical POD: one page. There is no approved sender/email service yet. Email must remain disabled.

Base: clean `codex/atlas-testing`, commit `47af2fcb0ada6722692694fd17137a69a2d4ca9c`. Work branch: `codex/delivery-pod`. Original shell v369; this local UI update prepares v371. Plain JavaScript modules/global IIFEs, HTML/CSS, Node 24 tests, existing keyless Cloud Run services. No package manager/build system applies to the main frontend.

This is an implementation-in-progress record, not a completed or deployed POD feature. Pure rules are implemented; camera/PDF/queue, document backend and office workflow still require implementation and verification. The new core module is intentionally not loaded by the application until its authorized backend/UI integration is ready.

## Audit evidence and architectural gaps

Source reviewed: root AGENTS.md, routing UI/core/planner/storage/intake, permanent host, preview access checks, private-trip-locks.sql, saved-day notes, auth events and service worker. No nested AGENTS.md was found in tracked source. The current executable baseline passes all 312 tests; historical complete COC coverage remains unavailable.

Read-only Supabase metadata and function inspection confirmed:

- `atlas_routing_preview_private.days` is keyed by `(warehouse_id, planning_day)`, with integer revision and a JSONB document. There is no separate canonical route/trip/physical-delivery table to reference.
- Order UUIDs are stable within a saved day. Version 3 locked trips hold order references, SKU/box allocation, assignment, sent-on date and completed order references. Trip identity is currently an array position. Split numbering is derived from the load plan for trip sheets, not persisted as an immutable shipment identity.
- Driver assignments are labels (`Bubba:truck`, `Bubba:van1`, `Achmad:van2`, etc.), not Auth user IDs. Existing profile roles are picker/supervisor/admin. Private routing membership has viewer/editor permissions and current server checks restrict access to approved CA supervisors/admins with an active session. Drivers must not be granted management privileges merely to scan a POD.
- Existing trusted authorization uses profiles, profile_warehouse_access, warehouses, current server-side app metadata and session validation. User-editable metadata is not a permission source.
- Existing buckets are product-images, coc-reports, coc-templates and coc-scan-corrections. None is an appropriate POD bucket. Do not reuse COC storage or change its policies.
- No generated Supabase type file exists in this plain-JavaScript checkout. Do not invent or regenerate unrelated types.
- Existing routing-private tables expose no table RLS policies; access is through restricted RPCs and private definer helpers. Reuse their authorization checks, not broad grants. New POD tables/buckets require their own restrictive policies and access tests.

The newer connected-host source supersedes dated Cloud Shell wording in SAVED-DAYS.md. Runtime source was not redeployed or modified for this audit. No production rows, account permissions or storage objects were changed.

## Required adaptation before the backend can be built

The supplied specification assumes authenticated assigned drivers and durable deliveries already exist. They do not yet exist in routing. Proposed adaptation, requiring explicit approval before migration/Edge Function preparation:

1. Add immutable shipment bindings derived server-side from a saved, sent-out trip: existing warehouse/day key, order UUID, allocation fingerprint, source revision, driver-account assignment and approved split number/total. This is a link to the existing saved-day domain, not a second planner or duplicated order-entry system. Never link by customer name, filename, or mutable trip index alone.
2. Add driver-account bindings/capabilities scoped to warehouse. Link existing ATLAS accounts only after the owner identifies the correct accounts. No automatic role upgrades or permission grants. Office actions require explicit capabilities plus existing warehouse access.
3. Preserve the existing reopen-trip control. If a trip is reopened or its allocation changes after a binding/POD exists, freeze the old binding and document history; require an office reconciliation of the new allocation before it can receive a POD. Never silently move an old POD to a recalculated shipment. Finalization verifies the binding against the current authorized snapshot/revision. Unsaved or changed plans cannot finalize documents.
4. Persist shipment numbering before first finalization. Subsequent allocation changes must not rename an issued PDF or its history. A basename collision returns a conflict requiring office correction. Orders whose total shipments cannot yet be established must wait for approved allocation, rather than guessing.
5. Keep today's existing assumed/confirmed delivery indicators separate from POD evidence. The 5 PM rule never creates a signature, server receipt, email acceptance or closed documentation state. No retroactive requirement is applied to old saved days; activation starts explicitly for designated deliveries.
6. Driver-specific APIs return only assigned stop context, not the whole routing day/customer list. New driver access must not broaden the existing Google planner/photo-reader tester gates or management account permissions.

## Proposed backend contract (not installed)

Private POD namespace, named consistently after implementation approval:

- Shipment binding and driver capability records as above.
- Logical document: warehouse, shipment binding, type POD, current version and status. Unique active POD per binding/type and active basename per warehouse.
- Immutable version: submission UUID, version number, validated filename, PDF object identifier/hash/bytes, page count, actor/time, replacement link/reason. Submission UUID unique across retries.
- Pages: original/processed object identifiers, hashes, dimensions, ordering, crop/rotation and warning/override metadata. Unique version/page number.
- Email outbox/attempts: initial or explicit resend, durable idempotency key, provider status/ID, bounded retry schedule and sanitized failure category. Email failure never rolls back a finalized document. Sender/provider remain configurable and disabled by default; production recipient/body are locked server-side.
- Append-only audit events plus version-specific NetSuite handoff markers. Download-start does not claim actual NetSuite upload. Replacement resets the new version's handoff status and retains old history.

Two private buckets: POD originals and POD documents. Immutable object paths scoped by authorized warehouse/binding/document/version. No upsert or public access; originals require stronger office permission. Use authorized streams or short-lived signed downloads; exclude responses and signed URLs from the general service-worker cache.

Operations: assigned-stop list, complete delivery, initiate/reconcile submission UUID, upload pages, finalize, current document/detail/search, authorized download/originals, resend, replace, mark NetSuite uploaded, approve missing-POD exception. Server validates current Auth session, trusted role/capability, warehouse, assignment, source binding and every object/version ID for every operation. Serialize finalization/replacement per logical document; stale replacement fails without moving the current version. Freeze upload records before PDF verification to prevent overwrites during finalization.

Email outbox needs a server-side worker and provider idempotency/ambiguous-send reconciliation. Never assume exactly-once email from a browser retry. No emails or test messages may be sent to the company inbox before explicit activation. Provider acceptance maps to Sent; provider delivery webhooks are optional and must be approved/configured before displaying Delivered.

## Scanner and offline plan

Default to a one-page workflow with Add Page available. Proposed initial safety limit is 10 pages, pending the owner's expected maximum and real-device testing. This is provisional, not a production-validated performance claim.

Preserve originals, process a separate copy, review before submit. Include retake, rotation, crop, reordering, page deletion confirmation and quality-warning override. Preserve stamps, signatures and faint text; never force destructive black/white thresholding. The image-processing/PDF dependency and exact versions still need a device spike and package approval; none was installed or selected as verified in this change.

IndexedDB queue is namespaced by authenticated user/warehouse, with a stable submission UUID and atomic page persistence. Show Saved only after the entire transaction commits. Retry on launch/resume/online/auth restoration, reconcile server state before retry after uncertainty, and stop automatic retries on permanent authorization/validation errors. Never rely on background sync. A logout warns about unsent pages and prevents another account from seeing them. Queued documents survive service-worker updates; safe local cleanup occurs only after confirmed finalization and an explicit cleanup policy.

Unsent originals must not silently migrate between ATLAS origins. Testing-host queues remain on the testing host; production activation needs an explicit drain/export strategy. Browser storage eviction still requires a clear device-storage warning and genuine iPhone/Android recovery testing; IndexedDB alone is not a guarantee against OS/browser deletion.

## UI refinement in this branch

Retain the original mockup's setup/deliveries/plan left column and map/summary right column where the available content width permits. Refine typography, spacing, controls, color, table borders, trip cards, dialogs and mobile delivery rows. Keep Add Orders, Save Day and Optimize Routes visible. Move occasional day actions and explanatory text into keyboard-accessible disclosures. Keep the driver's approved trip sheet and all existing planning calculations intact.

POD screens will follow the supplied navy-header/blue-action mobile design and clean document inbox/detail layouts. No generic scanner detached from its assigned delivery. Existing sidebar styling stays; a Delivery Documents entry can be added only as the new authorized view is integrated. Do not copy mockup-only customer data or John Davis into real records.

## Exact current file impact

- Add `atlas-routing-pod-core.js`: isolated naming, status, quality-review, submission-ID and bounded retry rules.
- Add `tests/atlas-routing-pod-core.test.cjs`: naming/validation, split values, truthful statuses and retry coverage.
- Add this document: `docs/DELIVERY-POD-IMPLEMENTATION.md`.
- Edit `atlas-routing.js`: UI grouping/copy only; existing actions, saved-day and planning behavior remain.
- Edit `atlas-routing.css`: screen-only refinement; host sidebar and driver print layout remain outside scope.
- Edit `index.html`: routing CSS/JS and service-worker URL versions only.
- Edit `service-worker.js`: synchronize changed asset URLs and shell version.
- Edit `coc-receiver/index.html`: shared service-worker URL version only; no Receiver behavior/icon changes.
- Edit `cloud-run/atlas-routing-app/full-site.mjs`: synchronize testing-host cache transform.
- Edit `tests/account-frontend.test.cjs` and `tests/atlas-full-site.test.mjs`: expected cache versions.

## Proposed later files, pending backend design approval

New POD modules: `atlas-routing-pod-capture.js`, `atlas-routing-pod-processing.js`, `atlas-routing-pod-queue.js`, `atlas-routing-pod-client.js`, `atlas-routing-pod.js`, `atlas-routing-pod.css` and corresponding top-level regression tests.

Backend: a migration generated through the established CLI after its tooling/environment is verified; exact timestamped filename determined by that tool. Proposed new `supabase/functions/delivery-pod/index.ts`, `handler.mjs`, `email.mjs` and a documented outbox worker. Reuse established auth/warehouse helpers only where their actual behavior fits; do not modify existing COC/account functions. A Cloud Run implementation may be preferable for processing limits, but that hosting choice is not silently substituted for the requested architecture.

Focused wiring later: routing stop/action hooks, minimal sidebar registration in atlas-dashboard.js and asset references in index.html/service-worker.js; testing host static-files.json, Dockerfile and build/upload allowlists; auth logout guard and warehouse-switch queue cleanup hook only after those semantics are tested. No changes to atlas-coc-core.js, atlas-coc-excel.js or NEW COC 2.xlsx.

## Verification and activation gates

Commands: `node tools/run-regressions.cjs`, `git diff --check`, isolated browser layout/workflow checks. Initial baseline: 312 passed. POD helper addition: nine tests; total 321 passed before final visual QA. No standalone lint/build command exists for the main static frontend.

Final local verification: all 321 tests passed after the visual refinements; `git diff --check` passed. Headless Edge checks at 1600, 1440 and 390 pixels preserved sidebar geometry/colors, found no page overflow or JavaScript errors, and exercised photo-entry Done, manual entry, saved-route search, day actions, planning settings and a mocked Save Day. Screenshots were visually reviewed. All order data and backend responses were synthetic; no live Google or Supabase calls were made by the browser harness. Service workers were blocked in that harness, so actual installed-app cache upgrade/offline behavior and physical iPhone/Android camera testing remain unverified. The historical COC runners/fixtures remain unavailable.

Acceptance matrix: specification 19.1 items 1–3 and naming portions of 4–5/8–9 are covered by pure-helper tests; selected status, warning-model and retry primitives have unit coverage only. No end-to-end POD acceptance item is marked complete. Items 10–72 involving capture, PDF quality, durable queues, authorization, storage, actual email, office handoff and physical devices remain pending full implementation/integration testing. Existing 312 tests are regression evidence, not a replacement for that matrix.

Before backend changes: approve shipment/account binding adaptation, the POD-only migration/functions scope and a safe isolated backend test target. The current preview shares the production Supabase project; never assume it is disposable. Before package installation: approve the exact pinned dependencies after the compatibility spike. Before email activation: sender, provider/domain verification, test inbox, attachment limit and recipient authorization. Before driver activation: identify their accounts and approve explicit capabilities. Before release: test actual iPhone/Android camera/PWA/offline recovery plus the full security/acceptance matrix. No migration, deployment, commit, push or email is authorized merely by this file.

Official references inspected: [Supabase changelog](https://supabase.com/changelog), [private Storage buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals), [authorized downloads](https://supabase.com/docs/guides/storage/serving/downloads). The markdown changelog endpoint was unavailable; the HTML changelog was read. Recent relevant notices include Node 20 support ending and management logs API migration; this repository uses Node 24 and this feature will not depend on the deprecated management logs endpoint. No dependency upgrade was needed for the pure helpers/UI.

## Mobile order placement follow-up

Unsent orders support a one-second press-and-hold on the order row, a finger-following lifted card, drop-target highlighting and a transient green “✓ Moved” confirmation. Quick taps still open the editor; movement before the hold threshold cancels dragging and allows scrolling. Pointer cancellation, page hiding, navigation and workspace reset clean up the gesture. Reordering checks the current account, saved-day edit access and sent-out locks. Placement feedback does not mean the day has been saved; the existing Save Day workflow remains unchanged. Desktop handles and up/down controls remain available.

Simulated touch in isolated Edge verifies quick tap, pre-hold swipe, short-hold threshold, successful reorder/checkmark and cancellation. Physical iPhone/Android behavior still requires testing. The separate compact dashboard/queue/POD concept also supports hold-to-drag and the same confirmation, but its suggested swaps remain illustrative. It is not a deployed routing or POD implementation.
