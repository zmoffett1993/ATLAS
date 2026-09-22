# Local regression checks

Run from the repository root with Node.js 24:

```powershell
node tools/run-regressions.cjs
```

The runner discovers all top-level tests/*.test.cjs and tests/*.test.mjs files,
runs them with Node's test runner, and returns a failing exit code if any test
fails. Fixtures use synthetic data and mocked services. No packages, production
credentials, database writes or deployments are required.

The consolidated testing branch includes current main-branch account, login,
COC isolation, scanner-access and cache tests, together with routing, photo
intake, saved-day, trip-lock, notification and private-host tests. The scanner
harness accepts Windows CRLF and LF files. Cache checks verify the combined
entry points and service-worker version. A preview test checks that current
authentication's login helper is served and packaged.

Staging/network runners are excluded intentionally: they require separate
authorization and an isolated environment. Historical reports record earlier
executions, not verification of this checkout. Do not run staging SQL against
production or treat archived database experiments as deployable migrations.

This executable suite is not full coverage of COC_IMPLEMENTATION_SPEC.md
sections 91-117 and 119. The historical complete suite is still unavailable;
full workbook fidelity, inventory/scanner/printing workflows, physical devices
and end-to-end backend integration are not fully verified by these tests.
