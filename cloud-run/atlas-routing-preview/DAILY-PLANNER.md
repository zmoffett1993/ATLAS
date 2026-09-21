# Private daily-planner connection — September 20, 2026

This is a development preview on `codex/delivery-routing`, separate from live
ATLAS. Nothing has been committed, pushed to GitHub, merged or published to
GitHub Pages. Supabase configuration, databases and Edge Function sources were
not changed in this step.

## Current connection

The existing private Cloud Run service now also accepts `/plan-trip`. The
original `/optimize-trip` sample endpoint and its source remain unchanged.
The new Cloud Run handler mirrors the original caller-scoped authorization:
approved tester, trusted app metadata, current profile role and active CA
warehouse access. Every request rechecks access with GET-only Supabase calls
using the caller's bearer token. Google receives anonymous stop indices,
coordinates, pallet counts and timing, not customer names, SKUs, documents or
the ATLAS access token.

The browser geocodes entered street addresses through the existing restricted
Maps JavaScript/Geocoding key. This browser-intended credential is supplied
from private runtime configuration, never from repository files. The user
approved adding only the exact Cloud Shell preview referrer; the two original
localhost referrers and API restrictions were preserved. The backend still
uses keyless Google service-account authentication.

Cloud Run revision: `atlas-routing-preview-00004-dtv`.
Image: `us-central1-docker.pkg.dev/project-6a63ee65-40cb-4d53-b32/atlas-routing-preview/preview@sha256:c1f92d09d8df25c4adb65a831874bc16fbbeb32394ca3d5cd7eff9038887e36a`.
The existing identity, environment, resource limits, concurrency 4, timeout 60s
and maximum one instance were verified unchanged. No public invokers are
granted; anonymous backend health requests still return 403. Only this private
preview was deployed. Old images, revisions and source backups were retained.

## Planning behavior

- Use the current order-list sequence to allocate loads. Google optimizes
  stops within each assigned load; this is not a global fleet optimizer.
- Truck pallet and typical trip counts remain adjustable planning targets.
  Loads above the usual 11 spaces and extra trips remain visible for review.
- One box truck and **two matching Nissan NV vans** are available. Drivers can
  use separate vans concurrently. A driver or individual van cannot overlap
  trips. The same supplied cargo dimensions/80% target apply to both vans.
- Bubba defaults to 6:30 AM departure after 30 minutes of loading; Achmad's
  first van departure is estimated at 8:30 AM after 30 minutes of loading.
- Reload time defaults to 40 minutes. Lunch is one hour, initially 12–1 PM,
  with its start adjustable between 11 AM and 1 PM. Reloads pause for lunch;
  waiting for a vehicle can accommodate lunch without counting it twice.
- Google considers road traffic and customer windows. Window end times allow
  the stop's service duration before closing. Blank windows impose no customer
  window; ambiguous text requires correction rather than silent omission.
- Normal shifts end at 3 PM/5 PM. Later returns are shown for review rather
  than silently dropping orders. Stops outside a customer window or the
  preview's 8 PM horizon remain explicitly unscheduled, with pallet counts.
- Utilization includes loading, driving, service, waiting and reloads against
  eight working hours; lunch is excluded. Overtime can exceed 100%.
- Dragging/reordering selects manual stop-order preservation. Any order,
  date, target or schedule edit clears the prior routing result and map paths.
- Van assignments require an estimated fit or explicit warehouse confirmation
  for uncertain fit. Known volume/dimension failures and split shipments without
  separate box allocations still need load review.
- Plans, geocodes, catalogs and photos remain in the current tab only. Leaving
  routing or changing account/warehouse clears its workspace. No saving/OCR
  implementation is included in this step.

## Cost bounds and preview limits

Google quotas remain unchanged. Requests are serialized with at least 31s
between route starts; failures are not retried automatically. The temporary
bridge allows five legacy connection tests plus 20 planner requests per
process. It has a shared 30s throttle across both endpoints. The Google
2/minute quota remains the project-wide backstop. These are not spending caps.
The browser supports up to 20 trips per calculation and 20 stops per trip;
exceeding a preview limit keeps the load list and asks for review. The backend
has a 100-pallet input-abuse bound, not a physical truck-capacity assertion.

## Verification

All 75 available routing tests passed:

```powershell
node --test tests/atlas-routing-core.test.cjs tests/atlas-routing-edge.test.mjs tests/atlas-routing-server.test.mjs tests/atlas-routing-preview.test.mjs tests/atlas-routing-planner.test.cjs tests/atlas-routing-cloud-planner.test.mjs
```

`node --check` passed for `atlas-routing.js`, `atlas-routing-planner.js`,
`cloud-run/atlas-routing-preview/{server,planner-handler,trip-model}.mjs`,
and `tools/routing-preview/{bridge,preview,maps}.mjs`. `git diff --check` passed;
Git's existing LF/CRLF conversion notices remain.

Two real Google planner requests passed in the signed-in private browser with
one synthetic 24-pallet order split into two 12-pallet loads, using the public
Fullerton City Hall address. The specification workbook was read in browser
memory only (122 rows), not uploaded to Cloud Run or modified. Results:

- Trip 1: 6:30–7:15 AM; approximately 20 minutes driving.
- Trip 2: 7:55–8:43 AM, following a 40-minute reload; 23 minutes driving.
- Total: 43 minutes driving, 16.7 miles, 24 pallets, 34% Bubba utilization.
- Both routes and depot/stop markers rendered on Google Maps with traffic.
- Load edits cleared the old schedule. Selecting the oversized load for Van 2
  produced review guidance without another routing call.
- Mobile width check showed no horizontal page overflow. Synthetic order and
  catalog state were cleared afterward. Existing user tabs were preserved.

The historical complete ATLAS regression runners are absent. COC/workbook,
receiver and full offline regression coverage therefore remains incomplete;
these routing tests are not a substitute. Real multi-customer day validation,
real mid-route lunch scenarios and real relief-driver days remain to be tested.
Google's legacy Marker API currently emits a deprecation warning, not a runtime
failure. No packages were installed and no credentials were committed or logged.

## References checked

- [Shipment and break model](https://developers.google.com/maps/documentation/route-optimization/reference/rest/v1/ShipmentModel)
- [Maps geocoding](https://developers.google.com/maps/documentation/javascript/geocoding)
- [Maps CSP guidance](https://developers.google.com/maps/documentation/javascript/content-security-policy)
- [Supabase server-validated user lookup](https://supabase.com/docs/reference/javascript/auth-getuser)

The preview uses nonces and explicit Google resource domains without adding
`unsafe-inline` or `unsafe-eval`. Cloud Shell is temporary and owner-protected;
the URL only works while that session and its bridge remain active.
