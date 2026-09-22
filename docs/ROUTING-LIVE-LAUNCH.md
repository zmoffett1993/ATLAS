# Routing at the normal ATLAS address

The application remains at `https://zmoffett1993.github.io/ATLAS/`.
Its existing ATLAS session is reused for saved days, driver assignments and PODs.
No redirect, iframe, second account or credential transfer between browser origins
is used. The private Cloud Run site remains available independently.

## Connection

- `tools/routing-preview/full-site-client.mjs` loads public runtime configuration
  from the existing fixed Cloud Run gateway on the live site. Keys are not copied
  into source. Private hosting continues to use its same-origin configuration.
- The browser sends its current ATLAS bearer in `X-Atlas-Authorization` to the
  fixed routing/photo gateway, without cookies or redirects.
- The gateway accepts live requests only when `ATLAS_ROUTING_LIVE_ENABLED=true`,
  only from `https://zmoffett1993.github.io`, and only for runtime configuration
  and the three existing API paths. Preflight does not authorize a paid call.
- Existing server authentication, approved tester restrictions, current role and
  CA warehouse checks, Google quotas and per-process request limits remain intact.
  This launch does not expand Google routing/photo access to other accounts.
- Saved-day and POD permissions remain enforced by the existing database/function:
  administrators edit and assign; supervisors read; drivers access assigned loads.
- The root module worker composes the existing offline shell and reminder worker
  under `/ATLAS/`. The Receiver uses that same registration. Reminder eligibility
  remains restricted to the existing recipient; no notification permission is
  requested automatically. Existing private-origin subscriptions are separate.

## Required activation, in order

1. Add `https://zmoffett1993.github.io/*` to the existing **ATLAS Routing Preview -
   Browser** Google Maps key's website restrictions, preserving the existing
   entries, Maps/Geocoding API restrictions and quotas. Browsers can send only the
   origin as the referrer on cross-origin requests; CORS also restricts origins,
   not paths. This does not allow other `github.io` accounts.
2. Append `https://zmoffett1993.github.io` to the existing `ATLAS_POD_ORIGINS`
   Supabase setting in project `dwrrbpiprcmajfyronlf`, preserving its existing
   origins and all other settings. No migration or Edge Function deployment is
   required. Keep routine email sending at its existing disabled setting.
3. Build the allowlisted Cloud Run app source, deploy the resulting immutable
   image to `atlas-routing-app`, and enable `ATLAS_ROUTING_LIVE_ENABLED=true`.
   Preserve its existing identity, authentication settings and environment.
4. Verify live-origin configuration and POD preflight, rejected unapproved
   origins, and unauthenticated rejection before publication. Do not log keys,
   bearer values or entire runtime configuration responses.
5. Commit and push the reviewed update branch, create/review its PR, and merge
   into `main` through the PR. Verify GitHub Pages deployment and the new worker
   and assets at the normal URL. Never push directly to `main`.

All external activation requires the applicable user approval. Changing origin
settings does not authorize changes to roles, tester lists, email sending or data.

## Verification

Run `node tools/run-regressions.cjs` for all current executable regressions.
Browser checks use the existing Playwright/Edge runtime, with
`ATLAS_PLAYWRIGHT_PATH` and `ATLAS_BROWSER_PATH` pointing to those installations:

```
node tools/delivery-pod/check-driver-screen.cjs
```

Repeat with `ATLAS_QA_LIVE=true` for the isolated normal-address fixture. It
intercepts every external request and checks driver/admin screens and permissions
without modifying any real records. Then run:

```
node tools/delivery-pod/check-live-worker.cjs
git diff --check
```

The worker check upgrades a synthetic legacy worker at `/ATLAS/`, opens main and
Receiver offline, and verifies that unrelated caches survive. It is not a
physical iPhone/Android camera or push-delivery test. Historical COC 91–117/119
runners/fixtures are still unavailable and are not represented by current counts.

Unsent POD photo drafts belong to the origin where they were captured. They are
not moved or deleted by this release; finish any private-preview drafts there.
Already saved server records use the same existing protected backend on both
hosts. A fresh routing connection still requires internet access.
