# Private photo intake preview

Status: connected to the private preview on 2026-09-20 with explicit user approval.
Live ATLAS is unchanged. The photo reader passed a synthetic Google Vision test
and a real check against the user-provided order photograph.

## Document intake update — local, September 22, 2026

This frontend update is prepared locally; the historical activation details below
are evidence from earlier deployments, not a deployment of this update.

Add Orders opens **Add Delivery Order**, with Photograph Order and Choose from
Photos. There is no Enter Manually action on this screen at any breakpoint.
The separate order editor remains available from the desktop orders list and
for corrections. The mobile manager navigation is Home, Orders, Trips, More;
More keeps waiting loads, history, map, settings, documents and day actions.
The existing ATLAS sidebar and driver/POD navigation are unchanged.

The camera requests the rear-facing lens and releases the stream after capture,
back, cancellation or account reset. Ready appears only after camera playback.
Camera-denied users can select a photo. Reading starts on selection/capture and
always ends at Verify. No photo is automatically added or saved. Verify shows
editable operational fields with individual amber confirmation prompts. Add
another page appends paperwork for the same order; Retake replaces the selected
page only. Pages can be selected and removed to resolve mixed orders.

The field assessment uses Ship To geometry, printed order IDs, complete SKUs,
Case Qty, catalog matches, quantity relationships and repeated-page agreement.
Low confidence in unrelated notes or Bill To text does not block an order.
Missing critical values, uncertain critical words, unknown/incomplete SKUs,
conflicting addresses/counts and mixed sales orders still require review.
Complementary pages fill missing values; genuine conflicts remain blocking.
Case Qty is boxes; Item Qty is never substituted for an unreadable box count.

Add Order is an explicit confirmation and uses the existing order editor's
insertion, duplicate and date-rollover path. The first photo fixes the intended
delivery day using the Pacific noon/Monday–Friday cutoff. Order added offers
Add Another Order or Finish Adding Orders. Orders Ready lists the current day;
Optimize Route calls the existing planner. Route Ready displays returned trip
metrics and review notes; Save Route uses revision-checked saved-day persistence.
Save/network failures remain visible, preserve reviewed orders, and never claim
success. Maps/optimization are unavailable when the existing connection is off.

Photos are transient object URLs and bytes. Reading is aborted on cancellation,
retake, exit, sign-out or warehouse reset; late responses cannot populate another
account. URLs and photo bytes are released after explicit Add or abandoning intake.
Saved-day documents contain reviewed details only. No schema, Edge Function,
authorization, OCR endpoint or Google API configuration changes are required.

Images are re-encoded to JPEG, at most 2400 pixels on the longest side and
2,800,000 base64 characters, stripping EXIF/GPS metadata without changing the
original. Up to 20 photos per order, each below 15 MiB, are accepted. Reads remain
sequential through the existing throttled connection. Canceling cannot undo an
upstream Google request that has already been accepted.

The parser uses word positions to separate Ship To from Bill To and Case Qty
(boxes) from Item Qty (units). It retains the full SKU, including color suffixes,
for the existing catalog matcher. Hours are suggested only from Ship To. Only
the explicit phrase CHECK ON DELIVERY marks check collection; COD does not.

Identical SKU quantities repeated across documents are counted once. Conflicts
and repeated SKU lines within a page require manual quantities. Different known
sales-order numbers block merging. Missing order references, unfamiliar layouts,
tilted/blurred photos, handwriting, and conflicting fields need human review.
The parser does not claim complete or guaranteed extraction. Review is mandatory
in the workflow; saving confirms the entered order rather than OCR accuracy.

## Data flow and authorization

Browser -> same-origin private Cloud Shell bridge -> private Cloud Run
`/read-order-photo` -> fixed Google Cloud Vision `images:annotate` endpoint,
using only DOCUMENT_TEXT_DETECTION. There are no client-selected URLs, GCS
sources, storage buckets, database writes, private keys, or new packages.

Cloud Run reuses the planner's authorization through `preview-access.mjs`:
current Supabase user lookup, tester allowlist, trusted app_metadata role,
caller-scoped profile role and active CA warehouse membership. User-editable
metadata cannot authorize a request. Supabase receives only existing access
checks, never photos. The legacy Edge Function source is unchanged.

Google OAuth comes from the existing attached Cloud Run identity. ATLAS bearer
tokens are never forwarded to Vision. Google responses return only bounded OCR
text/word geometry; upstream errors and credentials are not echoed. Application
code does not log or persist images or extracted text. Google processes the
submitted image under its service terms; this is not an on-device OCR feature.

## Approved activation and deployment

Project: `project-6a63ee65-40cb-4d53-b32`.

The following actions were explicitly approved and completed on 2026-09-20.

1. Enable `vision.googleapis.com`.
2. Grant `roles/serviceusage.serviceUsageConsumer` to the existing runtime
   account `atlas-routing-preview@project-6a63ee65-40cb-4d53-b32.iam.gserviceaccount.com`.
   Its existing Route Optimization Editor role lacks `serviceusage.services.use`.
   Do not grant Editor, Owner, Storage access or create a service-account key.
3. Set the project document-text-detection quota to 10 requests per minute
   (effective limit verified). Maps/routing quotas were not changed.
4. Build the allowlisted source and update only the private Cloud Run preview.
   Set `ATLAS_ROUTING_PHOTO_ENABLED=true` in that service, retaining all existing
   env variables, caller checks, private IAM, resource limits and identity.
5. Update the private bridge/frontend files and add boolean
   `ATLAS_ROUTING_PHOTO_ENABLED: true` to its external runtime configuration.
   Do not place private configuration in the repository or upload archive.
6. Verify with synthetic image data first, then the user-approved order sample.
   Keep the unfinished routing feature off live ATLAS.

The backend additionally limits 100 photos per UTC day per running instance;
the bridge limits 100 photos per process lifetime. Both reset on restart and are
not durable project quotas or spending caps. The existing $10 budget alert is
an alert only. Google currently lists the first 1,000 document-text units/month
free and the next tier at $1.50/1,000 images, plus other Cloud resource charges:
https://cloud.google.com/vision/pricing

## Sidebar integration

Only the standalone private preview gets `atlas-routing-standalone` and the
mockup sidebar. In the main app, routing retains the existing ATLAS sidebar,
background, top bar and all menu items. Delivery Routing remains after Dashboard
and before About. Navigation to other items exits routing through the existing
handlers. This local integration has not been published to live ATLAS.

## Verification

Run the available regression suite and the focused intake checks:

```powershell
node tools/run-regressions.cjs
node --test tests/atlas-routing-intake.test.cjs tests/atlas-routing-photo.test.mjs tests/atlas-routing-planner.test.cjs tests/atlas-routing-storage.test.cjs tests/atlas-routing-preview.test.mjs tests/atlas-routing-server.test.mjs
git diff --check
```

The historical full ATLAS regression runners specified in AGENTS.md are still
missing. These routing checks do not substitute for workbook, receiver, full
application or offline/service-worker regression verification.

A local loopback HTTP server can serve `tests/routing-intake-browser.html`.
Run workflow checks uses actual frontend modules with synthetic auth, OCR,
planner and in-memory saves; it makes no external service calls. This fixture
is not part of the production static-file allowlist. Real camera permissions,
mobile background behavior and OCR quality still require physical-device checks.

## Historical deployment evidence

- Private ready revision: `atlas-routing-preview-00005-qqh`.
- Image digest: `sha256:ec955a40c5cf63b1efc611c6f038d0a330f0a717c4c157fa8971683165c7483a`.
- Existing runtime identity, original environment values, CPU/memory, concurrency and timeout retained.
- No public IAM invokers; anonymous backend health request returned HTTP 403.
- Four explicit OCR calls during verification: one synthetic image and three reads of the approved sample while correcting OCR token splits. No automatic retries.
- Final sample: full SKU `CGST1-95MM-0401`, Case Qty 100 boxes, Item Qty 30,000 units, correct Ship To and order number. Time Window remained blank and COD did not set CHECK ON DELIVERY.
- The original archive was verified with SHA-256 `05b76facd8f4b5e54e3fd2f7d1877643411a5fbec93b13ae00e1f4bc5a7cbcfe`.
- Frontend follow-up retains skewed four-digit SKU suffixes; final parser SHA-256 `404f6f3687da54dc0c48952c3964d7f1dc4c2ce10ed5a592efeb4e4c444b7a06`.
- Client pacing was adjusted to 6.1 seconds between image-request starts to match the new quota.
- No repository commit/push/merge, live-site release, Supabase modification, Edge Function edit, workbook change or package installation.
