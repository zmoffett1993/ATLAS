# ATLAS routing handler v2 — keyless Cloud Run, not deployed

The private-key Edge Function draft has been superseded by the approved keyless
Cloud Run design. See [the current setup and review notes](../../../cloud-run/README.md).

`handler.mjs` remains here as shared source used by the Node service at
`cloud-run/atlas-routing-preview/server.mjs`. It uses Cloud Run metadata-issued
short-lived credentials and caller-scoped Supabase Auth/RLS reads. No Google
private key or Supabase service-role key is used. The old `index.ts` is a
closed entry point returning 503, so accidental Edge deployment cannot activate
routing. Do not deploy this folder or the repository's other functions.

## Request and result

POST JSON with `action: "optimizeTrip"`, `warehouse: "CA"`, RFC3339 `departure`
and `returnBy`, optional boolean `preserveOrder`, and `stops`. Each stop accepts
only `location: {latitude, longitude}`, integer `pallets`, optional integer
`serviceMinutes` (default 25), and optional `timeWindow: {start, end}`.
Times must include a timezone; trip limits use America/Los_Angeles including DST.
Stops are correlated by zero-based input index. No customer names, photos,
order numbers, SKUs, or payment notes go to Google.

One truck starts and finishes at the configured depot, carries at most 11
pallet spaces, departs no earlier than 06:30 and returns by 15:00 the same day.
At most 20 stops and 32 KiB of request JSON are accepted. Stop windows must
already be intersected with the trip window by the eventual client planner.
Manual order uses hard precedence rules. Travel estimates consider traffic.
Responses expose only stop indices/times, skipped indices, distance, durations,
route polyline and traffic-infeasibility status. Responses are `no-store`.

The response always states `wholeDayValidated: false`. It does not yet schedule
three sequential trips, reloads, Bubba's lunch, Achmad, or cargo-van loads.
These are required before enabling daily optimization. Driving estimates are
general road estimates, not truck-specific legal navigation.

## Verification

```powershell
node --test tests/atlas-routing-core.test.cjs tests/atlas-routing-edge.test.mjs tests/atlas-routing-server.test.mjs
node --check cloud-run/atlas-routing-preview/server.mjs
node --check supabase/functions/atlas-routing-preview/handler.mjs
git diff --check
```

The historical complete regression runners remain missing. See the Cloud Run
notes for runtime configuration, cost controls, security checks and deployment
limitations. No customer records or deployed Supabase functions were changed.
