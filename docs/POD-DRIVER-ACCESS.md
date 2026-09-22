# Driver access and administrator-only route editing

## Private activation — September 21, 2026

This update builds on the enabled private POD backend and successful Gmail connection test. Bubba and Ahmad already have enabled driver memberships (the account spells the name Ahmad; the route planner says Achmad). No login credentials or account roles were changed.

Delivery Routing opens **My Deliveries** for workers. It does not load the office saved-day document. The lighter driver interface has **Today**, **Stops** and **Documents** navigation: trip summaries, one selected stop at a time, and received PODs/device drafts. It shows vehicle, assigned driver, stops, pallets, sales order, address, recorded customer hours, check-on-delivery flags and notes. SKU/box details expand on demand. Open in Maps, Scan POD, Resume scan and received PDF controls reuse the existing capture/recovery workflow. Refresh preserves the selected stop for the same account/day. Account/date changes clear that navigation. No ETA or stop duration is added to the driver screen or trip sheet. POD counts describe saved documents, not independently confirmed deliveries.

Administrators use **Delivery Routing → PODs → Assign Drivers** to choose an active CA warehouse picker for a saved, sent-out trip. This includes Bubba, Ahmad and backup workers. The assignment grants only driver POD membership and links those trip stops. It does not grant office planning access, alter the worker's account role or change warehouse grants. An unassigned worker sees an empty driver screen. Already assigned trips show the driver's name; this update deliberately does not silently transfer immutable POD bindings to someone else.

Supervisors can view routing days and POD documents but cannot change routes, settings or allocations, assign drivers, upload PODs or send/retry email. The prepared SQL restricts the existing routing write helper to current trusted administrators and returns a read-only POD capability for supervisors. It preserves their existing authorized CA read access. CA/TX isolation and current-session checks remain on the server.

## Backend scope and source evidence

With explicit approval, `tools/delivery-pod/driver-access-draft.sql` was applied to shared project `dwrrbpiprcmajfyronlf` through MCP migration `20260922063453_activate_private_pod_driver_access_admin_edits`. The file remains the reviewed source, not a CLI-generated migration. It adds protected access/roster/assignment/list RPCs and replaces the relevant permission helpers, receipt guard and email-claim guard. No table, storage policy, Edge Function, workbook or customer record was changed by this activation.

The existing deployed POD access, receipt, email-claim and list function bodies were compared with local source by MD5 (accounting for CRLF); they matched. The deployed routing access helper was inspected read-only. No assumption of local/remote parity was used to broaden access.

Assignment checks current administrator membership/session, active CA worker eligibility, saved revision and immutable allocation. It locks the saved day and assigns all stops in one transaction. A repeated assignment to the same driver returns the existing links; a different driver or stale allocation is rejected. An incomplete split rolls back the full assignment, including newly granted membership. No automatic polling or email was added.

## Verification

- `node tools/run-regressions.cjs`: 372 passing tests, zero failures.
- `node tools/delivery-pod/check-recovery.cjs`: saved photo/Done/resume, offline recovery, uncertain receipt reconciliation, account isolation, email retry and visible storage-failure checks passed; all external requests intercepted.
- `node tools/delivery-pod/check-driver-screen.cjs`: worker screen at 390 px, supervisor read-only screen and administrator assignment at 1440 px passed. Driver opened with zero office saved-day requests; assignment made one RPC. No horizontal overflow.
- `git diff --check`: passed.
- Deployed metadata: the four public driver/list RPC wrappers are security invokers, authenticated-only, with anonymous execution denied. Advisors reported no new POD/Routing warning; existing inventory/COC public-definer and leaked-password-protection warnings remain outside scope.
- Signed-in private preview: refreshed CSS v18, POD JS v4 and routing JS v33 loaded; Zach retained administrator route controls and the protected Assign Drivers panel loaded successfully. No trip was assigned, no order saved and no email sent during this check. The driver layout was verified with synthetic role sessions locally; the signed-in administrator correctly retains the office workspace.

Browser checks use the existing runtime via `ATLAS_PLAYWRIGHT_PATH` and `ATLAS_BROWSER_PATH`; no package installation. `ATLAS_QA_OUTPUT` optionally saves screenshots. SQL tests run only in isolated PGlite, with synthetic identities, sessions and documents.

## Remaining limits

Database activation and private frontend deployment are complete. Cloud Run revision `atlas-routing-app-00008-h4l` serves v375 at https://atlas-routing-app-tbcotacnuq-uc.a.run.app/. Build `a95fd79d-c3c4-4cf6-87cb-e53f514b4b64` used the existing limited build account and verified all 104 Docker input files; only six changed files (470 KB compressed) were uploaded from this computer. Real Bubba/Ahmad login and physical iPhone/Android capture remain unverified. Historical COC 91–117/119 runners and fixtures remain missing; current tests do not replace that coverage.

The existing immutable binding rule requires a split order's complete sent-out allocation before its POD links can be created. Assigning a trip containing a partially dispatched split displays an explanation and makes no partial assignment. Supporting PODs for an earlier split departure needs a separate allocation lifecycle change; this is not a fully finished split-delivery pilot.

Backup driver assignment controls POD responsibility; it does not rewrite the optimizer's Bubba/Achmad shift model or recalculate estimated times for a new person's schedule. Existing assigned trips cannot yet be reassigned through this screen. Routine email remains disabled; this activation sends no email and makes no real trip assignments. Main ATLAS stays unchanged. No commit, push or merge.
