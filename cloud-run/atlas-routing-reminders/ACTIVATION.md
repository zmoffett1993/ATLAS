# Private routing and delivery reminders — activation review

Activation started 2026-09-20; **sending remains disabled**. This is separate from live ATLAS.
Recipient: **Zach only**, Monday–Friday at **17:00 America/Los_Angeles**.

Progress: pinned dependency and lockfile installed; npm audit reports zero known
vulnerabilities. All 150 routing tests and an actual Web Push encryption/VAPID
request-construction check passed without a send. The private Supabase schema
was applied disabled; a device-query alias ambiguity found during PostgreSQL
verification was corrected. Transactional access/enrollment checks passed and
rolled back, leaving zero devices and attempts. The dedicated Supabase secret
key was created after action-time approval. The user completed its hidden-input
transfer to Secret Manager. Version 1 of `atlas-routing-reminders-db` was verified
against the protected Supabase server RPC (HTTP 200, disabled response) and
connected to the private job by secret reference. Sending remains OFF.
Positive scheduled-claim/concurrency and physical-phone checks remain pending.

The permanent app is deployed at
https://atlas-routing-app-tbcotacnuq-uc.a.run.app with notifications OFF.
Its exact origin was added to the existing Maps browser key while preserving
existing referrers and API restrictions. The private reminder job is deployed
OFF with one task, no retries, 300-second timeout and the required 512 MiB memory.
The weekday schedule exists and is PAUSED. No device is enrolled, no real push
has been sent, and no existing live ATLAS files or Edge Functions were deployed.
Builds used the existing Cloud Shell Docker runtime and explicit Dockerfile
allowlists after Cloud Build's default account lacked source-bucket permission;
no additional build-account grants were added. Runtime service accounts use
workload identity. Secret transfer is complete; database enrollment configuration,
phone enrollment and positive reminder checks remain unfinished.

Push-signing secret `atlas-routing-reminders-vapid` version 2 is prepared for
the disabled job. The initial unused signing key was generated in a container
whose logging retained its output; it was replaced before enrollment/use, and
version 1 was disabled. The replacement was generated through a captured local
process pipe without container logging. No key values were printed in the chat
or committed. The old stopped container/log remains, holding only the disabled,
never-enrolled signing material; no cleanup/deletion was performed without approval.

## Exact resources proposed

- Existing Google project: `project-6a63ee65-40cb-4d53-b32`, region `us-central1`.
- New Cloud Run service `atlas-routing-app`, minimum instances 0, maximum 1.
  Static login/PWA assets are publicly reachable; orders still require ATLAS login
  and the existing database authorization. Routing/photo proxy requests are
  restricted to Zach's explicit tester ID and independently checked by the existing
  routing backend. No source directory browsing or customer documents are served.
- New workload account `atlas-routing-app`, granted Invoker on ONLY the existing
  `atlas-routing-preview` service. No Google account private key. Its short-lived
  Google identity comes from the fixed metadata endpoint.
- New private Cloud Run JOB `atlas-routing-reminders`, one task, parallelism 1,
  maximum retries 0, timeout 300 seconds; no public send URL.
- Separate `atlas-routing-reminders` service account, allowed to read ONLY its two Secret
  Manager secrets: VAPID private key and Supabase backend secret credential.
  The Supabase credential is inherently privileged at project level: isolate it
  to this job, never the web service/browser/source, even though the job only calls
  the two narrowly defined reminder RPC operations. Do not create service-account
  JSON keys. The public VAPID key may be supplied in environment/DB configuration.
- Separate `atlas-routing-scheduler` service account, Invoker on ONLY the reminder job.
  The shorter name satisfies Google's 30-character service-account ID limit.
- Cloud Scheduler job `atlas-delivery-review-weekdays`, `0 17 * * 1-5`, timezone
  `America/Los_Angeles`, OAuth-authenticated POST to the Cloud Run Jobs API:
  `https://run.googleapis.com/v2/projects/project-6a63ee65-40cb-4d53-b32/locations/us-central1/jobs/atlas-routing-reminders:run`.
  Scheduler retries 0. Start paused until negative-access and enrollment checks pass.
- Supabase project `dwrrbpiprcmajfyronlf`: new private notification schema with
  settings/devices/send-attempts tables; RLS, no direct application table grants,
  two public invoker RPC wrappers, explicit grants and private guarded functions.
  No routing/day/order tables are altered, no existing rows deleted, no Edge
  Functions changed. The exact SQL is a separate review artifact, not a migration
  already applied to the project.
- Only the exact returned permanent routing origin is added to the existing Maps
  browser-key referrer list; retain current API restrictions and test quotas.
  No wildcard Cloud Run/Cloud Shell referrer grants.

These services can incur Google Cloud charges. The existing $10 alert is not a
spending cap; preserve it and inspect its scope before activation.

## Private phone testing versus live ATLAS

The new service is a stable, separately installed **ATLAS Routing** PWA for private
testing. It does not update the existing live ATLAS Home Screen app. Existing live
sidebar, icons and receiver stay unchanged. If notifications later move to live
ATLAS's origin, phones must opt in again there; a subscription cannot move between
origins. Do not present a guessed service URL as a working link: use and verify the
URL returned by Cloud Run after deployment.

## Ordered activation steps after approval

1. Install pinned `web-push@3.6.7` only in `cloud-run/atlas-routing-reminders`, with
   scripts disabled, produce/review package-lock.json, and inspect dependencies and
   advisories. The Dockerfile intentionally requires this currently absent lockfile.
   Verify actual encryption/VAPID behavior with synthetic keys and no real sends.
2. Verify the exact approved Zach account against current trusted preview membership
   and account identity. Never infer a recipient from the first member or a name
   supplied in user_metadata. Keep the UUID in private deployment configuration.
3. Apply the reviewed SQL with sending disabled. Run transactional synthetic tests
   for CA/TX and other-account denial, anonymous/server-role grants, revoked sessions,
   register/revoke races, five-device limit, literal payload validation, atomic claims,
   concurrent jobs and sent-out orders saved on a different planning day. Roll back
   test data. Run Supabase security advisors; do not silently change unrelated findings.
4. Generate VAPID material without displaying or committing it. Create/store the
   backend secret in Secret Manager; grant only the job runtime access. Configure
   the sole recipient, public key and exact origin; leave both sending flags OFF.
5. Build using each exact `upload.ignore` allowlist and reviewed image tag. Verify
   upload contents before transmission; never upload a whole workspace or runtime
   config. Deploy the app and private job with scoped accounts. New IAM grants and
   public static hosting are part of this approval scope, not an implicit permission.
6. Verify the actual permanent URL, TLS, manifest, service-worker scope, authentication,
   Maps referrer restriction and no unauthenticated data/API access. Preserve the
   existing Cloud Shell preview and drafts. Do not copy its operator credentials.
7. Configure the DB and frontend notification feature for Zach. Zach installs/opens
   the private PWA on his phone and taps Enable on This Device; do not accept the
   device's permission on behalf of another person. Test persistence/revocation.
8. Enable job sending and resume the weekday schedule only after the checks pass.
   Verify a real reminder on Zach's device within the allowed 5 PM window. Android
   compatibility remains unverified on hardware until an authorized Android device
   is available; do not enroll someone else just to test.

No commits, pushes, merges, live-ATLAS releases, database deletions, existing Edge
Function changes or workbook changes are included in this activation.

## Configuration boundaries

Web service: `K_SERVICE=atlas-routing-app` (runtime), `ATLAS_ROUTING_APP_ORIGIN`,
`ATLAS_ROUTING_APP_TESTER_ID`, existing `ATLAS_ROUTING_SUPABASE_PUBLISHABLE_KEY`,
`ATLAS_PREVIEW_BROWSER_ANON_KEY` (existing browser compatibility), restricted
`ATLAS_PREVIEW_MAPS_BROWSER_KEY`, `ATLAS_ROUTING_PHOTO_ENABLED`,
`ATLAS_NOTIFICATIONS_ENABLED`. No privileged DB or VAPID private key in this service.

Job: `CLOUD_RUN_JOB=atlas-routing-reminders` (runtime),
`ATLAS_NOTIFICATIONS_ENABLED`, `ATLAS_NOTIFICATION_RECIPIENT_ID`,
`ATLAS_PUSH_PUBLIC_KEY`, `ATLAS_PUSH_SUBJECT` (verified permanent HTTPS app URL), and secret
references for `ATLAS_PUSH_PRIVATE_KEY` / `ATLAS_NOTIFICATION_DB_SECRET`.

DB settings start empty and disabled. Device bindings are one-time, expire after
10 minutes for registration, and are revoked on consumption/cancellation. Calls
check current profile role, trusted app_metadata role, live auth session, approved
preview membership, active CA warehouse and the one configured recipient.

Daily claims scan all saved planning days for orders dispatched on the review date.
Only dispatched, unconfirmed orders without reported exceptions trigger a reminder.
Claims persist even if the provider times out, avoiding automatic duplicate sends.
Provider acceptance is not proof of phone delivery or shipment delivery.

Browser binding state is origin-private IndexedDB, not an auth-token store. Sign-out,
account/warehouse changes and opt-out clear the binding and unsubscribe locally.
Server checks also stop revoked sessions; an offline sign-out cannot immediately
contact the server, so local suppression and the short push TTL are necessary.

## Original verification status before activation (historical)

Local unit/HTTP integration tests and a real browser IndexedDB persist/reload/clear
check pass. No real PostgreSQL execution of this proposed schema has occurred:
there is no local psql, Docker or Supabase CLI, and new database writes require
approval. No package installation, image build, remote deployment, permission grant,
secret creation or actual phone delivery has occurred. Missing historical complete
ATLAS/COC/offline runners remain an explicit verification limitation.

References: [Cloud Run scheduled jobs](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule),
[Supabase API key privileges](https://supabase.com/docs/guides/getting-started/api-keys),
[Web Push library source](https://github.com/web-push-libs/web-push).
