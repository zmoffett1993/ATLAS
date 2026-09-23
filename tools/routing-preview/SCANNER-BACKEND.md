# Mobile scanner backend — local preparation

Status: **prepared for approved deployment; activation results will be recorded below**.

`scanner-backend-draft.sql` is review source, not an executable deployment plan.
It depends on the existing v3 saved-day validator/save function and the
administrator-only routing access helpers introduced by the POD driver work.
The deployed access, save and validator definitions were inspected on September 22, 2026 and match the expected repository contracts. The actual scalar helper definitions were also inspected.

## Prepared contract

- `atlas_routing_scanner_upload`: authenticated CA administrators append one
  reviewed, undispatched order to a saved day. Warehouse access, trusted role,
  account/session validity, and the existing document validator remain enforced.
  Supervisors retain read-only access. TX is not implicitly enabled.
- A warehouse/day lock serializes initial uploads. Sales-order retries return
  the existing order without overwriting it or scheduling duplicate work.
- Extraction diagnostics live in a private sidecar. Only bounded, explicitly
  named field candidates/corrections, confidence, parser version, PO and packing
  slip number are accepted. Photos and full raw OCR responses are not stored.
- Day saving and queue insertion are one database transaction. Existing days
  retain their catalog, settings, assignments and locked trips. The first-day
  seed must have no orders, assignments or dispatched trips.
- Every subsequent saved-day revision invalidates the draft. Five-second
  debounce, a 15-minute lease, generation checks and revision checks prevent
  overlapping workers or stale draft publication. Interrupted leases can be
  reclaimed. A newer upload schedules a follow-up rather than being lost.
- `atlas_routing_scanner_status` is available to authorized readers. Errors
  preserve the last valid draft and all orders. An administrator can explicitly
  retry attention-state work with `atlas_routing_scanner_retry`.
- Claim/finish RPCs are service-only. Tables have RLS and no browser grants.
  The feature defaults to disabled, including its queue trigger. Disabling it
  stops new uploads, claims and completions without deleting saved data.

`scanner-planning-worker.mjs` is a transport-independent worker, not a running
service. It uses the existing catalog, pallet grouping, configurable truck
targets and split-box allocation logic. It subtracts already-dispatched box
allocations and excludes completed deliveries. Its output is a separate draft;
it cannot change orders, assign drivers, dispatch loads or replace locked trips.

## Integrated frontend and runtime

The manager mobile entry opens the four-screen scanner only when the protected
status RPC reports enabled. Driver/POD and desktop navigation are preserved.
The authenticated upload client waits for durable success, preserves review on
failure, and handles duplicate retries. Desktop checks for new revisions every
30 seconds while visible; it never replaces dirty local work. Matching traffic
estimates are displayed without changing driver assignments or sent-out trips.

The private Cloud Run job uses workload OAuth for Google geocoding and the
existing traffic planner. Database credentials stay in Secret Manager. It claims
one queued day per run, serializes workers, spaces route calls by 31 seconds,
and never emits credentials or customer data in logs. Missing/ambiguous addresses
produce attention status, preserving the last valid plan. Already-dispatched
loads and explicit van assignments require desktop timing review. Same-day background planning starts no earlier than 30 minutes from calculation, preserving loading time and avoiding past departures. Orders outside the planning horizon remain saved for review. Background requests are limited to 100 address lookups and 100 route calls per Pacific day across restarts; route calls are also spaced by 31 seconds.

Rollout uses a disabled database flag until the worker, scheduled invocation,
and frontend are ready. Rollback disables that flag and pauses the new schedule;
orders and existing application data remain intact. Source upload allowlists
exclude workbooks, documents, Git history and credentials.

## Verification

`node --test tests/atlas-routing-scanner-backend.test.mjs` executes the draft SQL
inside isolated PGlite PostgreSQL with synthetic users/orders. It covers atomic
save and rollback, duplicates, admin/TX isolation, browser denial of worker
access, debounce/leases, stale-result rejection, failure preservation/retry and
worker conservation of remaining split boxes. There are no network/database
writes outside the in-memory test database and no Google API usage.

The original scalar helpers were inspected on the deployed database; the harness supplies their equivalent definitions and it loads the real repository v3 validator, save function and latest
administrator access source. This is not a verification of deployed drift,
PostgREST/JWT verification, multiple PostgreSQL connections under load, a running
scheduler or physical-phone operation. Historical COC regression coverage also
remains limited by missing original runners/fixtures.
