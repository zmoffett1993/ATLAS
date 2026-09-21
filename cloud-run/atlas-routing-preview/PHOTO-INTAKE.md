# Private photo intake preview

Status: connected to the private preview on 2026-09-20 with explicit user approval.
Live ATLAS is unchanged. The photo reader passed a synthetic Google Vision test
and a real check against the user-provided order photograph.

## Workflow

Take Photo requests the rear camera where the browser supports capture. Choose
Photos accepts multiple images. Up to 20 images, each below 15 MiB, stay together
in a single order draft. The user explicitly selects Read Photos, reviews the
suggested fields beside links to the originals, selects Fill empty fields, and
saves the order. Existing edits and existing SKU rows are never overwritten.

The browser re-encodes each image to JPEG, at most 2400 pixels on the longest
side and 2,800,000 base64 characters. Re-encoding removes EXIF/GPS metadata;
the original file is untouched. Unsupported images offer a manual-entry fallback.
One request runs at a time, with at least 6.1 seconds between request starts. Closing the
draft, changing its photos, leaving routing, or changing account cancels/invalidates
the result. Cancellation cannot undo a Google request already accepted for billing.

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

Run all available routing tests:

```powershell
node --test tests/atlas-routing-core.test.cjs tests/atlas-routing-edge.test.mjs tests/atlas-routing-server.test.mjs tests/atlas-routing-preview.test.mjs tests/atlas-routing-planner.test.cjs tests/atlas-routing-cloud-planner.test.mjs tests/atlas-routing-intake.test.cjs tests/atlas-routing-photo.test.mjs
git diff --check
```

The historical full ATLAS regression runners specified in AGENTS.md are still
missing. These routing checks do not substitute for workbook, receiver, full
application or offline/service-worker regression verification.

## Deployment evidence

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
