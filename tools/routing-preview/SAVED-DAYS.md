# Private saved delivery days

The isolated preview database migration was approved, applied, and verified on
September 20, 2026. Save Day is enabled only in the private Cloud Shell routing
preview. This development branch remains uncommitted and unpublished to live ATLAS.
No Edge Function was changed and no photos are stored. The code default for
`ATLAS_ROUTING_STORAGE_ENABLED` remains false; the external private-preview
configuration explicitly enables it.

The approved history extension was activated on September 20, 2026 as
`add_routing_history_search_and_delivery_status`. Saved Routes now searches Sales
Order, Invoice and Item Fulfillment numbers with date filters. Version 2 documents
store those references, sent-out dates, confirmed delivery dates and exceptions;
version 1 days remain readable. Older clients cannot overwrite a day saved in
a newer document version.
Refresh old preview tabs before editing an upgraded day. Push notifications are
not activated by this update; see NOTIFICATIONS.md for the pending setup.

## What Save Day retains

- Reviewed order number, Ship To/customer/city, SKU, Case Qty (boxes), optional Item
  Qty (units), delivery hours, stop duration, notes and CHECK ON DELIVERY.
- The day's imported specification rows, including NEW/TBA values and source rows.
- Stop order, driver/vehicle assignments, van review confirmations, pallet/trip
  targets, reload time, lunch preference and the manual-stop-order setting.
- In version 3, each sent-out trip's pallet count, assigned vehicle, order and
  SKU box allocation, sent-out day, and fully dispatched order references.
- Invoice and Item Fulfillment numbers, sent-out date, confirmed delivery date,
  and delivery exceptions. Assumed delivered is derived after 5 PM Pacific only
  for sent-out orders without an exception; it is not proof of delivery.

Photos, files, OCR output, account/session credentials, Google geometry, traffic
responses and calculated travel times are not saved. Photos remain temporary.
Opening a saved day restores planning inputs; Optimize Routes recalculates timing.
Save Template remains unavailable and is separate from saving a dated delivery day.

## Consecutive order entry

Add & Next Order adds the reviewed order to the current day's list and keeps
the intake dialog open with a fresh form. It resets customer/reference fields,
SKU quantities, notes, check collection and temporary photo selection for the
next order; stop duration starts at the existing 25-minute default. Photos for
the added order remain attached to that order in this tab until normal cleanup.
Editing an existing order retains Update This Order and does not offer Add & Next.
Required fields and duplicate-order checks apply to both add actions.

Adding orders normally changes only the in-memory day; Save Day stores
reviewed details and does not retain photos. The noon-cutoff handoff described
below saves a dirty source day before opening the next day. No new database
fields were introduced. An isolated browser check exercised two consecutive
orders, duplicate rejection, a failed save, a successful save and reopening the
day with document references, quantities and CHECK ON DELIVERY intact. Storage
was mocked; this check did not write to the private or production database.

## Noon Pacific cutoff

New orders added at or after 12:00 PM America/Los_Angeles go to the next
Monday-Friday delivery day. Friday afternoon and weekends go to Monday.
An already selected later weekday is retained. The rule uses the device's
current clock converted to Pacific time and is checked when the order is added,
including forms opened before noon. It does not use the date printed on the order.
No holiday calendar is configured.

Existing orders can be edited without changing their delivery date. An explicit
same-day exception checkbox is available only when entering a new order on the
current weekday after noon. It does not automatically assign Achmad or authorize
an extra Bubba trip; the operator must select the appropriate driver and vehicle.

When the cutoff sends a new order to another day, the app first saves any dirty
source day using its existing revision, then loads the destination before adding
the new order. The previous orders and assignments are preserved in the saved
source day. An empty destination inherits the source product catalog and planning
settings, with empty orders/assignments; an existing destination retains its own.
The newly added order still needs Save Day on the destination. A failed source
save, conflicting duplicate, failed destination load, or read-only destination
keeps the draft available and does not silently replace either day's orders.
Without shared saving, cross-day entry is blocked to protect the current day.
Account changes and closed drafts reject stale asynchronous results. Temporary
photos on the new draft survive the handoff; older day photos are cleared under
the existing day-switch policy and are never persisted.

Verified locally with cutoff tests for exact noon, winter/summer offsets,
weekends, daylight-saving transitions, future days and explicit exceptions;
isolated browser tests covered the cross-day save/load flow and failure recovery.

## Planned load capacity

Today's Deliveries shows the latest planned truck load, its pallet target and
remaining planned spaces. Add & Next Order includes load feedback without an
extra confirmation step. A 5-pallet order followed by a 4-pallet order leaves
2 spaces at the usual 11-pallet target. A third 3-pallet order stays together
on Trip 2, with a message explaining the 1-pallet overflow. Raising the target
to 12 in Route Setup recalculates the plan and retains the warehouse-fit warning.

Orders larger than the target retain the existing split-shipment allocation and
are flagged in the capacity panel. Unknown quantities remain unscheduled; their
presence suppresses the available-space indicator. Van assignments are excluded
from the truck capacity indicator and keep their own van-fit checks.

This remains planning feedback, not a warehouse fit or departure confirmation.
Reopening a saved day derives capacity from saved orders, catalog, targets and
sent-out trip snapshots. Manual split/next-trip choices remain future work.

## Sent-out trip snapshots (version 3, private preview)

Mark Trip Sent Out saves a fixed snapshot through the existing private Save Day
RPC. Later orders start a new trip, even if the sent trip had empty pallet space.
The load, driver/vehicle assignment, customer/SKU allocations and stop order of
the sent trip stay fixed after refresh. A split order is marked sent out only
after all its shipments leave; its first shipment alone does not imply delivery.
The latest sent trip can be reopened and saved again for corrections. Editing a
sent order still permits a delivery exception or confirmation, while protecting
the load details and sent-out date. Existing version 1 and 2 days remain readable.

The approved `atlas_routing_preview_trip_locks_v3` migration was applied to the
private database on September 20, 2026. Its source is
`tools/routing-preview/private-trip-locks.sql`. The validator accepts versions
1, 2 and 3, rejects malformed trip allocations, and the save function prevents
older clients from overwriting version 3 days. Read-only synthetic validation
queries passed. The approved UI release was deployed to the private Cloud Shell
preview on September 20, 2026, in `~/atlas-trip-lock-preview-20260920`. All 18
uploaded files matched the release hashes; 16 static responses matched their
source hashes and used `Cache-Control: no-store` (HTML adds a per-request nonce;
the server source is not publicly served). Existing credentials and feature flags
were reused in a separate private runtime file; no access grants were changed.

The signed-in preview created version 3 data for isolated test day `2000-01-03`.
A conditional fixture update added one synthetic five-pallet order and catalog.
Mark Trip 1 Sent Out then saved through the authenticated app. After a browser
refresh and reload, its five pallets and Bubba/truck assignment remained locked;
read-only database verification confirmed the stored snapshot. A second test
order correctly moved to Monday under the Sunday/noon cutoff, retaining the
destination's existing catalog and leaving the original trip snapshot intact.
The second order was never saved; the existing destination was restored from its
saved version. Same-day additions after dispatch remain covered by local browser
tests, since the live Sunday cutoff intentionally prevents that path.

The historical test day remains clearly labeled TEST ONLY with a delivery
exception to exclude it from reminders. No real deliveries were marked sent out,
and no map optimization, photo-reading call, or notification was sent by this QA.
The SQL changed only the existing private validator and save function, with no
new tables, Edge Functions, or access grants. Live ATLAS is unchanged.

## Access and concurrency

The store uses a new, unexposed `atlas_routing_preview_private` schema
with `members` and `days` tables. Both have RLS enabled/forced and no direct
anonymous/authenticated table grants or policies. Existing tables are not changed.

Three public SECURITY INVOKER RPC wrappers expose load/save/search. Their private SECURITY
DEFINER implementations are deliberately narrow: direct writes are prohibited so
every save must enforce its expected version. They have an empty search_path,
fully qualified references, no dynamic SQL, and explicit authorization checks.
PUBLIC and anon execute privileges are revoked. No service-role key is used.

Access requires a live, non-expired auth session, an existing non-anonymous,
non-banned user, current trusted app metadata and profile admin/supervisor roles,
an active CA warehouse grant, and an enabled preview membership. Only the existing
preview tester is initially enrolled. Viewer membership cannot save. Staff access
requires named approval; the code does not grant warehouse staff access by itself.
TX and any client-supplied warehouse other than CA are rejected on the server.

One record holds a complete dated plan to avoid partially saving its orders and
settings. First creation conflicts if the day already exists; later writes use an
atomic expected-revision UPDATE. There is no unconditional overwrite or delete
endpoint. A conflict leaves local work intact and opens a separate saved-version
review. Loading that version requires an explicit action and confirmation when
local changes exist. Revisions are conflict counters, not a historical archive.

Offline/failed saves remain unsaved in memory. A timeout may mean the server
accepted the save; the UI explicitly says it could not confirm it. There are no
automatic retries, offline browser caches, or background localStorage writes.
Account/warehouse changes abort requests and clear all in-memory routing state.

## Private-preview activation performed

1. The initial approved SQL was applied to the isolated preview schema. The local
   Supabase CLI/Postgres were absent; that initial activation had no local
   migration file. The later version 3 update is recorded in
   `tools/routing-preview/private-trip-locks.sql`.
2. Actual PostgreSQL permissions and RPC behavior were verified with isolated synthetic
   records in a rolled-back transaction: anonymous/unlisted/revoked/expired users,
   TX scope, invalid/photo-bearing documents, creation conflict and stale revision.
   Direct table writes, deletes and membership edits by app users were denied.
3. Database advisors and deployed definitions/grants were inspected. The new
   tables have intentional informational RLS-without-policy findings and two
   informational unindexed-foreign-key findings.
4. Only the changed private preview files were uploaded after approval. The external
   private config's `ATLAS_ROUTING_STORAGE_ENABLED` was set to true and its bridge restarted.
   No Google API, Google IAM, Cloud Run, Edge Function or Storage bucket change is
   required. No key/config values should enter source control or tool logs.
5. A synthetic saved day dated 2099-12-30 was saved through the authenticated
   browser, then loaded after refresh with its reviewed order details intact.
   This synthetic record remains in the private store. Live ATLAS is unchanged.

## Local verification

```powershell
node --test tests/atlas-routing-core.test.cjs tests/atlas-routing-edge.test.mjs tests/atlas-routing-server.test.mjs tests/atlas-routing-preview.test.mjs tests/atlas-routing-planner.test.cjs tests/atlas-routing-cloud-planner.test.mjs tests/atlas-routing-intake.test.cjs tests/atlas-routing-photo.test.mjs tests/atlas-routing-storage.test.cjs
node --check atlas-routing.js
node --check atlas-routing-storage.js
node --check tools/routing-preview/preview.mjs
node --check tools/routing-preview/bridge.mjs
git diff --check
```

Local storage tests use mocked transport. Earlier live database transaction tests
verified PostgreSQL access and conflict behavior, and earlier browser QA used the
private preview with actual Supabase RPCs. Version 3 has now passed authenticated
save, sent-trip autosave and refresh/reload checks as described above. The
historical full ATLAS suite, COC workbook/receiver and offline
service-worker regression runners remain absent. Full verification is incomplete.
