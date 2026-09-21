# Focused local regression checks

Run from the repository root with Node.js 24:

```powershell
node tools/run-regressions.cjs
```

This command discovers top-level `tests/*.test.cjs` and `tests/*.test.mjs`
files. It runs the routing tests and restored auth/service-worker checks.
It excludes staging runners. Current tests use synthetic fixtures and mocked
services; no production credentials or database writes are required.
The runner propagates failures with a nonzero exit code.

## Restored tests

`auth-signout.test.cjs` and `service-worker.test.cjs` came from commit
`53e3845` on `codex/restrict-scanner-intelligence`. The cache activation test
now derives the current cache version instead of hard-coding that branch's
version. Other account/COC/backend tests on that branch depend on application
changes absent from this routing checkout and were not copied or merged.

## Current result

179 tests executed: 179 passed, zero failures or skips. The seven previously
failing service-worker checks pass after bringing the existing `warehouseRead`
helper and fetch dispatch from locally available origin/main commit `234c599`
into this branch. Assertions were not weakened. The routing APP_SHELL was retained
and the cache version advanced to v361 to retire the old unscoped cache.

The checks cover account/session cache separation, request header variants,
credential-free cache keys, invalidation after 401/403 responses and cache quota
failures. A separate isolated Edge check exercised the actual worker's upgrade,
obsolete-cache removal, unrelated-cache preservation, routing asset precaching,
and separate main/receiver offline navigation fallbacks using synthetic pages.

This was a targeted cache reconciliation, not a merge of all newer main changes.
Other account/COC source differences still need review before publishing the
whole routing build. Live deployment state was not inspected.

This is a focused suite, not full coverage of COC_IMPLEMENTATION_SPEC.md
sections 91-117 and 119. Workbook fidelity, full inventory workflows, real-device
scanner/printing behavior and end-to-end backend integration remain outside it.
No packages were installed and no staging environment was changed.
