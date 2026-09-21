# Full ATLAS testing host

The existing atlas-routing-app Cloud Run service can serve the consolidated
ATLAS frontend at its current permanent URL. Production main/GitHub Pages and
the separate atlas-routing-preview API service are unchanged by this source.

The static-files.json allowlist contains frontend assets only. Workbook files,
database scripts, credentials, Git history and server sources are not public
routes and are excluded from the container upload allowlist. The official COC
workbook continues to use its existing authenticated private-template flow.
Dockerfile and both upload filters must include every allowlisted file.

The private host transforms HTML in memory: scripts receive the response CSP
nonce, titles/installed-app names indicate Testing, and both ATLAS and Receiver
register the existing root-scope module reminder worker. That worker imports
the main session-isolated cache worker with root-relative shell URLs and adds
the full-site bootstrap to precaching. Runtime configuration and API requests
are excluded from the cache. Source index.html, receiver HTML and production
service-worker.js remain unchanged by this host integration.

Full-site CSP permits existing inline styles and the application's current
Maps, product-image, font and optional OCR origins. Inline executable scripts
still need the nonce; unsafe-eval is not enabled. The main and Receiver icons,
existing menu tabs, sidebar colors and authorization modules are preserved.

full-site-client.mjs uses the shared connectRouting adapter, current ATLAS Auth
and existing navigation. It does not load another login UI or replace the
dashboard opener. If connection setup fails, routing asks for a refresh and
does not silently fall back to a different saved-day store. Other ATLAS views
remain available. Notification activation still requires the existing explicit
runtime flag; this integration does not enable sending or enrollment.

## Data boundaries

This is a testing frontend, not an isolated database clone. Existing inventory,
account and COC screens retain their authorized production data connections.
Actual edits made through those screens can affect live warehouse data. The
routing APIs continue to require the approved tester, current role/CA access,
same-origin requests and keyless workload identity. Saved routing days retain
their existing private schema and revision/account protections.

## Verification

Run node tools/run-regressions.cjs with Node.js 24 and git diff --check. The
full-site tests cover public-route allowlisting, container completeness, script
nonces, navigation/worker injection, hidden private files, notification defaults
and cross-origin restrictions. Browser QA also checks desktop/mobile navigation,
saved-day reads using synthetic fixtures, and real module-worker installation,
cache upgrade and separate offline ATLAS/Receiver fallbacks.

Deployment must change only the existing web service image and preserve its
environment, service identity, IAM policy, scaling and resource settings. Verify
the immutable image digest, traffic revision and public asset hashes after
rollout. No database/Edge Function change or main-branch publication is required.
Historical full COC, physical-device and end-to-end production regression gaps
remain documented in tests/README.md; local passing tests do not close them.
