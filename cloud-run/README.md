# ATLAS keyless routing preview

Current status (September 20, 2026): the separate private preview supports
daily trip sequencing and the Google map. See
[the daily-planner record](atlas-routing-preview/DAILY-PLANNER.md) for the
verified revision, behavior, test results and remaining limitations. The
original design/deployment notes below are historical and describe the initial
disabled single-trip setup.

This replaces the private-Google-key design. The existing dedicated Google
service account will be attached to a separate Cloud Run service. Cloud Run
supplies short-lived OAuth credentials; no downloaded Google private key,
Google credential JSON, Supabase service-role key, or new Supabase secret is
required. Google's key-creation restriction remains intact.

After explicit approval, the allowlisted source was built in Google Cloud Shell
and deployed to a separate, disabled, IAM-protected Cloud Run preview. Cloud Run
and Artifact Registry APIs were enabled. No Supabase data/secrets/policies,
live ATLAS assets or existing Edge Functions were changed. The prior frontend
draft is preserved. See `atlas-routing-preview/DEPLOYMENT.md` for the exact
image, configuration, checks and outstanding integration work.

## Request path and authorization

Future flow: ATLAS preview -> Cloud Run `/optimize-trip` -> Google Route
Optimization. Cloud Run first validates the ATLAS user's token with Supabase
Auth and makes GET-only profile/access checks using that SAME user's bearer
token plus a publishable key. RLS stays enabled; the runtime never bypasses it.

The inspected live policies allow own-profile SELECT, own warehouse-access
SELECT and authorized active-warehouse SELECT. These three tables have RLS
enabled. A successful real-user end-to-end request is still required before
claiming integration works; policy inspection and mocks do not prove that.
Existing unrelated grants/policies were not changed.

The user must be explicitly allowlisted in `ATLAS_ROUTING_TESTER_IDS`, have a
trusted app-metadata AND current profile admin/administrator/supervisor role,
and be authorized for active CA. TX is not enabled for this initial preview.
All checks run on every call, including when a Google token is cached.

The only accepted origins are `http://localhost:18766` and
`http://127.0.0.1:18766`. CORS is supplementary, not authorization. Google only
receives coordinates, anonymous stop indices, pallet counts and timing.
The user's Supabase token is never sent to Google APIs or metadata endpoints.

Before obtaining a Google token the handler checks the Cloud Run service name
and the metadata server's service-account email. Both must match
`atlas-routing-preview` in project `project-6a63ee65-40cb-4d53-b32`. Metadata URLs
are fixed, redirects are refused and only `Metadata-Flavor: Google` is sent.
Tokens remain in process memory, refresh before expiry and never enter output.

## Files and build boundary

- `atlas-routing-preview/server.mjs`: dependency-free Node HTTP entry point.
  Use `/health` on Cloud Run; `/healthz` remains a local compatibility alias.
  Google reserves some URL paths ending in `z` before requests reach the app.
- `atlas-routing-preview/Dockerfile`: Node 24 slim, non-root runtime; copies
  only the server and shared handler. It installs no packages.
- `atlas-routing-preview/Dockerfile.dockerignore`: Dockerfile-specific deny-by-
  default context filter, leaving other ATLAS workflows unaffected.
- `atlas-routing-preview/upload.ignore`: explicit Cloud Build upload allowlist.
- `atlas-routing-preview/cloudbuild.yaml`: builds/stores only this image; no
  deployment step. A unique `_REVIEW_TAG` must be supplied.
- `atlas-routing-preview/service.preview.yaml`: disabled, IAM-protected preview
  deployment template. The image placeholder must be replaced with the actual
  reviewed immutable image digest; it cannot be deployed as-is.
- `../supabase/functions/atlas-routing-preview/handler.mjs`: shared request and
  authorization logic retained at its draft path to avoid unnecessary moves.
- The earlier Supabase `index.ts` now always returns 503. It must NOT be
  deployed; Cloud Run has superseded that unshipped function proposal.

Before any build, inspect the actual upload list. The allowlist excludes .git,
workbooks, product catalogs, order photos, frontend files and credentials.
Cloud Build source staging, image storage and logs remain Google-hosted build
artifacts. Never upload the complete ATLAS repository or connect its live branch.
The base-image tag is Node 24's maintained slim channel; record its resolved
digest during the reviewed build and deploy the resulting immutable image digest.

## Runtime configuration

Set only these app configuration values outside the repository:

| Name | Value / purpose |
| --- | --- |
| `ATLAS_ROUTING_PREVIEW_ENABLED` | `false` initially; explicit enablement only after review |
| `ATLAS_ROUTING_TESTER_IDS` | Approved tester Supabase UUIDs, comma-separated; empty denies all |
| `ATLAS_ROUTING_SUPABASE_PUBLISHABLE_KEY` | Existing project `sb_publishable_...` key; never a secret/service-role key |
| `ATLAS_ROUTING_CA_DEPOT_JSON` | Verified `{latitude, longitude}` for 4320 N Harbor Blvd, Fullerton, CA 92835 |

`K_SERVICE` and `PORT` are supplied by Cloud Run. Do not configure credential
files or `GOOGLE_APPLICATION_CREDENTIALS`. No private key fallback exists.
The fixed Supabase URL is for the existing Warehouse SKU Finder project.
No key value or tester UUID has been retrieved or added to source by this update.

The initial manifest keeps Cloud Run IAM invocation checks enabled and grants
no `allUsers` access. An authorized operator can test through Google's authenticated
Cloud Run proxy. Before direct browser use, separately review public HTTPS
invocation: end users authenticate with Supabase, not Google IAM. Public network
reachability must never bypass the application's user/role/warehouse checks.

## Cost and permission controls

- Service `atlas-routing-preview`, region `us-central1`, separate from ATLAS.
- Dedicated runtime identity with only `roles/routeoptimization.editor`.
- Request-based billing; minimum 0 instances, maximum 1 at both service and
  revision levels; 1 vCPU, 256 MiB RAM, concurrency 4, request timeout 60 seconds.
- Existing Google OptimizeTours project quota remains 2 requests/minute.
  Local 30-second throttling is per instance and does not survive restarts.
- Existing $10 monthly alert covers all services on this billing account,
  including new Cloud Run/build/storage spend. It is NOT a spending cap.
- Small tests may fit Cloud Run's free allocation, but builds, artifact/source
  storage, logs, network and Maps billing are separate; zero cost is not promised.
- Maximum instances is a scaling control, not an absolute billing guarantee.
- Cloud Run and Artifact Registry were enabled after deployment approval.
  The first build used Cloud Shell's existing Docker installation and the
  authenticated operator's existing permissions. Cloud Build was not needed;
  no build service account or additional runtime role was created.
- The deployer needs Cloud Run deployment and service-account `actAs` access.
  A build identity needs image-push and build-log permissions. Review existing
  permissions first; never give the runtime Project Editor/Owner or reuse a
  broadly privileged build identity as the runtime identity.

The deployment approval covers this isolated preview only. It does not authorize
merging routing into ATLAS, connecting the live site, or altering existing
Supabase functions. Further IAM grants and enabling testers require review.

## Local tests and known gaps

```powershell
node --test tests/atlas-routing-core.test.cjs tests/atlas-routing-edge.test.mjs tests/atlas-routing-server.test.mjs
node --check cloud-run/atlas-routing-preview/server.mjs
node --check supabase/functions/atlas-routing-preview/handler.mjs
node --check supabase/functions/atlas-routing-preview/index.ts
git diff --check
```

Tests cover keyless token retrieval/renewal, wrong identity, RLS-scoped reads,
CA/TX/account rejection, disabled/missing configuration, sanitized failures,
capacity/time limits and real localhost HTTP behavior including oversized uploads.
External services are mocked. HTTP test servers bind only to 127.0.0.1 and close
after each test. No live credentials, billable requests or database writes occur.

The full historical regression suite is missing. Docker and gcloud remain absent
from the user's computer; Cloud Shell supplied the existing build/deploy tools.
No local tools/packages were installed. Container build and deployment are now
verified; see the deployment record for live HTTP/IAM checks. Real runtime
metadata-token retrieval, live RLS, vulnerability scanning, and end-to-end
Google requests remain unverified while the preview is disabled.

This remains a **single already-allocated truck-trip** adapter, not the finished
daily optimizer. It returns `wholeDayValidated: false`. Three-trip sequencing,
reloads, lunch, relief driver, cargo-van assignment, OCR, persistence and browser
map integration remain unfinished. The Optimize Routes button stays disabled.

Sources verified September 19, 2026:

- https://docs.cloud.google.com/run/docs/securing/service-identity
- https://docs.cloud.google.com/run/docs/configuring/services/service-identity
- https://docs.cloud.google.com/run/docs/authenticating/end-users
- https://docs.cloud.google.com/run/docs/configuring/billing-settings
- https://docs.cloud.google.com/run/docs/configuring/max-instances
- https://cloud.google.com/run/pricing
- https://docs.docker.com/build/concepts/context/
- https://docs.cloud.google.com/sdk/gcloud/reference/topic/gcloudignore
- https://docs.cloud.google.com/run/docs/known-issues#reserved-url-paths
