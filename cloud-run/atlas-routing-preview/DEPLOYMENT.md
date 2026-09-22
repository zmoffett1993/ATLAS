# Isolated routing preview deployment

Deployed with explicit user approval on September 19, 2026 (America/Los_Angeles;
September 20 UTC). This is backend infrastructure only, not a live ATLAS release.

## Deployed resource

- Project: `project-6a63ee65-40cb-4d53-b32` (number `340839522237`).
- Region/service: `us-central1` / `atlas-routing-preview`.
- Ready revision: `atlas-routing-preview-00002-zpj`, 100% of preview traffic.
- Service URL: `https://atlas-routing-preview-340839522237.us-central1.run.app`.
  This is an IAM-protected backend, not a browser UI or public demo link.
- Image repository: `us-central1-docker.pkg.dev/project-6a63ee65-40cb-4d53-b32/atlas-routing-preview/preview`.
- Final image tag: `keyless-20260919-02`.
- Deployed immutable digest:
  `sha256:21ffd71e3b45badefeb84ed0bb0447b52c07605b7c550037fa0f3429975c04a9`.
- Node 24 bookworm-slim base resolved during the first build to
  `sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`.
- Runtime identity: `atlas-routing-preview@project-6a63ee65-40cb-4d53-b32.iam.gserviceaccount.com`.

## Source and build boundary

Only these six reviewed files were uploaded to authenticated Google Cloud Shell:

1. `cloud-run/atlas-routing-preview/server.mjs`
2. `cloud-run/atlas-routing-preview/Dockerfile`
3. `cloud-run/atlas-routing-preview/Dockerfile.dockerignore`
4. `cloud-run/atlas-routing-preview/cloudbuild.yaml`
5. `cloud-run/atlas-routing-preview/upload.ignore`
6. `supabase/functions/atlas-routing-preview/handler.mjs`

The original ZIP's SHA-256 was verified locally and after upload:
`d873c16ecbcf661acec440c95ffc304f30da657be17fcfe09605e82241a063b3`.
No workbook, catalog, customer document, credential or full repository was uploaded.
The Dockerfile copies only the server and handler into the non-root application.

Cloud Shell's existing Docker built the image; the already-authenticated operator
uploaded it to Artifact Registry using existing permissions. Cloud Build was not
needed. No additional build service account or runtime IAM grant was created.
Cloud Run and Artifact Registry APIs were enabled. No local package was installed.

The first revision, `atlas-routing-preview-00001-jmm`, correctly returned disabled
routing but its `/healthz` URL was intercepted by Google with an HTML 404.
[Cloud Run reserves some paths ending in z](https://docs.cloud.google.com/run/docs/known-issues#reserved-url-paths).
The corrected server adds `/health` while retaining `/healthz` for local
compatibility. That exact change was tested locally and applied to the six-file
Cloud Shell build directory. The LF-normalized server SHA-256 matched locally and
remotely: `ce32d1fb7f46dd6dbd58a6684b0ca4236d44b91de44a10b4ef2b96678496c60f`.
The second image was then built, pushed and deployed by digest. The first image
and revision were preserved, with no traffic assigned to the old revision.

## Verified restrictions

- Cloud Run invocation IAM checks enabled; service policy has no bindings.
- No `allUsers` or `allAuthenticatedUsers` project bindings.
- Dedicated runtime project role is only `roles/routeoptimization.editor`.
- No downloaded private key, credential file or Supabase service-role key.
- `ATLAS_ROUTING_PREVIEW_ENABLED=false`.
- Tester allowlist, Supabase publishable key and depot configuration are empty.
- Minimum instances 0 (Cloud Run omits default-zero annotations).
- Maximum instances 1 at both service and revision levels.
- Request-based CPU billing, 1 vCPU, 256 MiB RAM, concurrency 4, timeout 60 seconds.
- Existing $10 monthly all-services budget alert and previously approved Maps
  quotas were not changed. The alert and scaling limits are not a spending cap.
- Source archives, two images and logs remain stored; storage may incur charges.

## Verification

The following local command passed all 35 tests after the health-path correction:

```powershell
node --test tests/atlas-routing-core.test.cjs tests/atlas-routing-edge.test.mjs tests/atlas-routing-server.test.mjs
node --check cloud-run/atlas-routing-preview/server.mjs
node --check supabase/functions/atlas-routing-preview/handler.mjs
node --check supabase/functions/atlas-routing-preview/index.ts
git diff --check
```

All three syntax checks and `git diff --check` passed. Git reported only its
existing LF-to-CRLF conversion warnings for the four prior frontend draft files.

Live requests to the final revision were made from authenticated Cloud Shell.
The operator's temporary Google identity token stayed in memory and was not
printed or saved. Only an empty JSON object was sent to the routing endpoint.

| Request | Result |
| --- | --- |
| Anonymous `GET /health` | 403 |
| Anonymous `POST /optimize-trip` | 403 |
| Authenticated `GET /health` | 200, `{"status":"ok"}` |
| Authenticated `POST /optimize-trip` | 503, `{"error":"PREVIEW_DISABLED"}` |

Programmatic assertions also verified IAM, runtime identity, exact environment,
resource limits, scaling and disabled state. No route-optimization API request
or Supabase request is made by the disabled handler.

The complete historical ATLAS regression runners are still absent. The routing
tests do not replace COC/workbook/receiver/offline regression coverage. Real
runtime metadata-token retrieval, live user RLS checks, image vulnerability
scanning and end-to-end Google optimization remain unverified. A deployed
disabled backend does not establish a working ATLAS-to-Google connection.

## Files changed during this deployment step

- `cloud-run/atlas-routing-preview/server.mjs`: add Cloud Run-compatible health alias.
- `tests/atlas-routing-server.test.mjs`: verify both health paths and no-store responses.
- `cloud-run/README.md`: replace pending-deployment statements with current status.
- `cloud-run/atlas-routing-preview/DEPLOYMENT.md`: this deployment record.

All earlier uncommitted routing work on `codex/delivery-routing` was preserved.
No Git commit, Git push, merge, live-site deployment, Supabase modification,
Edge Function deployment, workbook change or data deletion occurred. The only
deployments were the two revisions of this isolated preview service.

## Remaining connection work

Configure the approved tester UUID, existing Supabase publishable key and verified
depot coordinates outside source control. Review the browser-to-private-service
connection before enabling it; do not remove IAM protection as a shortcut.
Then perform a controlled end-to-end test before claiming Google routing works.
The adapter still handles one allocated box-truck trip, not a complete daily plan.
Live ATLAS and the frontend Optimize Routes button remain unchanged.
