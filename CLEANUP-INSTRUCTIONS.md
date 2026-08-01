# ATLAS Production Polish Cleanup — Phase 2

This package is based on the exact current production `main` export.

## What changed

- Removed one confirmed broken CSS asset reference from `index.html`.
- Advanced the service-worker cache to `atlas-pwa-v37-production-polish-cleanup`.
- Preserved all approved SKU, camera, search, Create SKU, Samples Rack, inventory, branding, and product-image behavior.
- Excluded confirmed duplicate, empty, obsolete, and unlinked files from this clean production package.

## Important GitHub note

Uploading this package replaces matching files, but GitHub does not automatically delete old extra files. After uploading the package contents to the root of `main`, delete the files marked `REMOVE` in `ATLAS-POLISH-BEFORE-AFTER-MANIFEST.csv`. Do not delete anything marked KEEP or MODIFY.

Keep the `last-night-working` branch untouched as your rollback backup.
