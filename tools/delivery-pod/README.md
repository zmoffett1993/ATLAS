# Isolated POD database validation

Install the pinned development-only dependency (package installation was approved September 21, 2026):

```powershell
npm.cmd ci --prefix tools/delivery-pod --ignore-scripts --no-audit --no-fund
```

Run from the repository root:

```powershell
node --test tests/delivery-pod-sql.test.mjs
node tools/run-regressions.cjs
git diff --check
```

PGlite 0.3.16 runs PostgreSQL 17.5 in memory. The connected ATLAS database reported PostgreSQL 17.6 during read-only inspection. The engine major version matches; this is not an exact replica of Supabase. No server, credential, database URL, Docker installation or production connection is used by these tests. The test code cannot be redirected to a remote database. `node_modules` is ignored, and these tools are excluded from the application's static allowlist.

`test-prerequisites.sql` creates synthetic prerequisite table shapes and claim helpers, plus the existing routing access helper verified read-only. `schema-draft.sql` then executes unchanged in the local engine. Each scenario uses a rolled-back transaction with synthetic accounts and shipments. Authenticated operations run under the PostgreSQL `authenticated` role, not the owner. Receipt writes run under `service_role` and still verify the actor's permissions and current session.

Covered: private bucket prerequisites; private-table RLS and grants; office/driver separation; other-driver and TX denial; immutable split numbering; stale revision/allocation; disabled membership; expired/revoked sessions; banned/anonymous users; trusted versus user-editable role data; idempotent receipt finalization; changed retry rejection; and authorization revocation during upload.

Not covered: actual Supabase Auth token validation, PostgREST, Storage service/object policies, network retries, multi-connection concurrency, hosted Edge runtime, real-device capture/offline recovery or production schema drift beyond the inspected shapes. PGlite uses a single connection. Existing production storage policies must be checked separately before activation. Passing these tests does not authorize deployment or applying the draft.

The SQL sources are not CLI-generated migration files. The approved versions have now been applied through the connected Supabase migration tool; see the migration IDs and activation status in `docs/POD-GMAIL-PILOT.md`. Private buckets are created through Storage, then validated by the schema; the local test supplies synthetic bucket metadata.


## Focused browser recovery check

Use an already installed Playwright package and Chromium/Edge executable:

```powershell
$env:ATLAS_PLAYWRIGHT_PATH='<absolute path to existing Playwright package>'
$env:ATLAS_BROWSER_PATH='<absolute path to existing Chromium or Edge executable>'
node tools/delivery-pod/check-recovery.cjs
```

This check uses real IndexedDB and synthetic JPEGs, intercepts all remote requests, and exercises the real local POD handler with mocked storage. It closes/reopens the page, queues offline, drops a receipt response and verifies reconciliation without reupload, checks account/warehouse isolation, and simulates storage failure. It does not verify an installed phone PWA can launch offline or protect against OS storage eviction.


## Gmail pilot extension

`email-schema-draft.sql` runs after the base draft in the same isolated SQL suite. It adds no secrets or message bodies. The focused email tests mock both Google endpoints. The existing recovery browser check also verifies saved-POD email failure, office retry without another photo upload, sent status and private download. Setup and remaining activation requirements are in [POD-GMAIL-PILOT.md](../../docs/POD-GMAIL-PILOT.md). No email is sent by these checks.
