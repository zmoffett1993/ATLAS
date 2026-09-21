# Private Cloud Shell routing connection preview

Temporary operator-only testing, not production hosting. The Cloud Run routing
service remains protected by IAM. No public invocation, new IAM role, private
Google key, database migration or Supabase deployment is needed.

Google Cloud Shell Web Preview restricts HTTPS access to the signed-in Google
account that owns that shell. `bridge.mjs` binds only to 127.0.0.1:18766. It serves
an explicit static-file allowlist and one fixed `/api/optimize-trip` destination.
It does not serve the repository, configuration files, directory listings or logs.

The browser uses the existing, unchanged ATLAS sign-in module. Passwords go
directly to Supabase, not through the bridge. The browser sends the ATLAS access
token to the same-origin bridge in `X-Atlas-Authorization`, because Cloud Shell's
Google gateway intercepts the standard `Authorization` header. The bridge sends
that token as the backend's `Authorization` bearer and adds a separate,
short-lived Google operator token in `X-Serverless-Authorization`.
Cloud Run checks Google IAM; the existing handler separately verifies the ATLAS
user, tester allowlist, trusted role and active CA warehouse access under user RLS.

The exact Cloud Shell origin is validated before proxying; no CORS access is
granted. The bridge sends the handler's existing localhost origin only after
validating the browser's origin. It never forwards browser cookies, user-supplied
Google headers or arbitrary destination URLs. Tokens remain in memory; no request
logging, response-header forwarding, automatic retry or credential printing occurs.

The bridge has a 30-second interval and five-attempt limit per process. These are
test-session controls, not durable billing caps. Existing Google quotas still apply.
Do not run this bridge on a public host: it uses the operator's Google session.
Cloud Shell termination closes the preview. Do not treat its URL as permanent.

The optional connection check compares unauthenticated requests and synthetic
bearers in standard/app headers. Its body is always `null`, which the bridge
rejects before acquiring Google credentials or calling the backend. It never
uses the signed-in ATLAS session. In Cloud Shell, the expected results are 401,
browser connection failure, and 400 respectively; the last result confirms that
the app header reaches the bridge, not that a real user is authorized.

## Configuration and launch

Keep the runtime JSON OUTSIDE this repository and restrict it to the shell user.
Cloud Run receives only the four environment names in `cloud-run/README.md`.
The bridge additionally uses `ATLAS_PREVIEW_BROWSER_ANON_KEY`, the existing
legacy anon key, to preserve compatibility with the unchanged ATLAS sign-in
module's bearer header. The Cloud Run handler uses the modern publishable key.
Neither key is a secret/service-role key; no new key is created.
Never print or commit the runtime JSON. After explicit connection-test approval,
configure Cloud Run with that file without changing its image or IAM policy:

```sh
gcloud run services update atlas-routing-preview \
  --project=project-6a63ee65-40cb-4d53-b32 --region=us-central1 \
  --env-vars-file=/absolute/private/runtime.json --quiet
ATLAS_PREVIEW_CONFIG=/absolute/private/runtime.json node tools/routing-preview/bridge.mjs
```

`WEB_HOST` is supplied by Cloud Shell. Open its Web Preview on port 18766.
The public configuration endpoint exposes only the existing browser-intended anon
key and the existing project URL to this Google-authenticated preview; it never
returns tester IDs, Google credentials or backend environment variables.

## Verified locations and sample

Google Maps was inspected September 19, 2026:

- Depot: 4320 N Harbor Blvd, Fullerton, CA 92835; latitude 33.9229391,
  longitude -117.931362. This is the building location, not a surveyed loading dock.
- Public sample stop: Fullerton City Hall, 303 W Commonwealth Ave, Fullerton,
  CA 92832; latitude 33.8707996, longitude -117.9294156.

The sample uses tomorrow at 06:30 Pacific, returns by 15:00, and has one pallet
and 25 minutes at the stop. It ignores City Hall opening hours because this is
a synthetic connection test, not an actual delivery. It schedules nothing and
does not save orders. It sends no customer names, invoices, SKUs or photographs.

The normal planning screen remains available for review, with its unfinished
full-day Optimize Routes button disabled. The connection test does not integrate
all customer orders, live map rendering, OCR, daily sequencing or shared storage.

## Checks

```powershell
node --test tests/atlas-routing-core.test.cjs tests/atlas-routing-edge.test.mjs tests/atlas-routing-server.test.mjs tests/atlas-routing-preview.test.mjs
node --check tools/routing-preview/bridge.mjs
node --check tools/routing-preview/preview.mjs
git diff --check
```

The historical full ATLAS regression runners are still absent. Mocked routing
tests cannot prove live Google or Supabase integration; verify a real signed-in
sample through the preview before reporting success.

## Source references

- https://docs.cloud.google.com/shell/docs/using-web-preview
- https://docs.cloud.google.com/run/docs/authenticating/service-to-service
- https://docs.cloud.google.com/run/docs/authenticating/end-users
- https://supabase.com/docs/reference/javascript/auth-getuser

Do not loosen IAM protections to bypass preview or authentication failures.
