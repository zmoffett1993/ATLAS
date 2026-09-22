# Routing UI review

The working Delivery Routing application is the source for UI reviews. Its office
dashboard, mobile tabs, order-entry dialogs, saved-route search, driver screens
and POD capture/review/receipt flow share the same ATLAS visual treatment.
The existing ATLAS sidebar and printed Trip Sheet remain unchanged.

## Review the implementation

Use the private routing host for interactive testing. Earlier standalone concept
HTML files in the local visualization folder are design history, not a statement
of implemented features. Do not use those concepts as the current application
preview, or add mock controls/data to the deployed app for presentation purposes.

`node tools/delivery-pod/check-driver-screen.cjs` loads the actual application
through its private-host entry point with intercepted synthetic API responses.
It covers desktop and phone widths, driver capture through confirmed receipt,
office Orders/Waiting loads/Trips, photo entry and saved-route search. It also
checks administrator assignments, supervisor read-only access and that drivers
do not fetch office saved days. Set `ATLAS_QA_OUTPUT` to save screenshots. These
are real UI renders with synthetic data; clearly label that distinction whenever
sharing them. They are not proof of real-device camera or cloud integration.

Use the existing `ATLAS_PLAYWRIGHT_PATH` and `ATLAS_BROWSER_PATH` settings described
in `tools/delivery-pod/README.md`. No dependency installation is needed.

Other applicable checks:

```powershell
node tools/run-regressions.cjs
node tools/delivery-pod/check-recovery.cjs
git diff --check
```

The receipt screen appears only after a confirmed server receipt. Queued scans,
failed saves and email status remain distinct. Capture uses the device's native
photo picker/camera; its appearance is controlled by iOS/Android/browser software.

Historical COC runners and physical iPhone/Android verification remain separate
limitations. Traffic-based swap suggestions, delivery-arrival checklists and
other illustrative concept features are not introduced by this visual update.
