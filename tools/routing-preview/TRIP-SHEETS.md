# Driver trip sheets

Implemented locally on `codex/delivery-routing`. Not deployed or merged into
live ATLAS. No backend, database, Edge Function, workbook or notification change.

After Optimize Routes finishes, each calculated trip has a Print Trip button.
It opens a review sheet with Print / Save PDF, using the browser print dialog.
The sheet follows the calculated visit order and shows:

- Chubby Gorilla logo with Trip Sheet beneath it; driver, vehicle and planning date.
- The blue departure/estimated-return/driving summary is omitted from the printout.
- Start/finish location and return-to-Chubby-Gorilla footer are omitted.
- Customer address and any entered receiving hours; the estimated arrival/service-duration line is omitted.
- Shipment pallet count and Sales Order beneath the customer name, above the address.
- Invoice and Item Fulfillment references are omitted from the trip sheet only;
  saved orders and history search retain them.
- Per-shipment SKU/box quantities and explicit CHECK ON DELIVERY.
- Notes, lunch during the trip, and relevant day/load review warnings.

For a split order, the sheet uses the approved SPLIT SHIPMENT — SHIPMENT N OF M
instruction and prints only this shipment's pallet count and allocated boxes.
Boxes for this trip are also available in expandable load cards before routing.
Allocations group models using the existing pallet calculation, preserve exact
color SKUs, and fill each model's pallet slots in order-line sequence. Partial
model pallets and different customers' orders are kept separate. Missing or
inconsistent pallet specifications require warehouse review instead of invented
box quantities. Known box/pallet data remains usable when dimensions are TBA.

Allocations are derived from the reviewed order, saved catalog and planning
target; no new database fields or migrations are needed. Reopening a saved day
rebuilds the same allocations from its inputs. Warehouse loading confirmation
remains necessary; the calculation does not identify physically staged pallets.
Van checks now assess only each trip's allocated boxes, including split orders,
using the existing 80% target and conservative upright packing estimate. Selected
van load cards show the result before routing. Near-full loads display their
percentage and need warehouse confirmation; known dimension/volume failures
cannot be overridden. Incomplete allocations must be corrected first. Missing
dimensions allow review but cannot hide known boxes already exceeding capacity.
These are loose-box estimates; palletized or mixed-pallet loading is not modeled.
Changing the driver/vehicle clears the prior van-fit confirmation.
If an assigned van load is known not to fit, it automatically moves to Bubba and
the box truck, with the reason shown on the load card and calculated plan.
Achmad is never assigned the box truck. The existing truck-target splits and box
allocations are retained. Above-80% loads and TBA dimensions remain warehouse
review cases; they do not automatically switch vehicles. Adjusted saved-day
assignments require Save Day to persist and are not silently written back.
Skipped stops are excluded from trip totals;
any unscheduled shipments remain flagged. An incomplete/failed calculation
cannot be printed as a completed trip sheet.

When a completed calculation puts Bubba past 3 PM, eligible loose-box loads
offer a Try Achmad button. Loads needing a warehouse-fit check are not suggested,
nor are stops already closed before Achmad's first departure. An unused van is
preferred; otherwise the earlier-returning van is proposed. One click changes
that load's assignment and recalculates the day through the existing connection
and quota controls. Customer windows, shared vehicles, lunch and driver hours
are checked again by the planner. These are options to try, not a guarantee of
an on-time day. No suggestion appears while the calculation is incomplete or
when Achmad is already scheduled past his shift. Save Day persists the change.

Printing does not save a day, mark orders sent out, confirm delivery, upload
photos, or send notifications. Sheet data stays in the current page and is
cleared when closed, invalidated, or reset on account/warehouse/navigation changes.
Order text is escaped. Print styles apply only while a trip sheet is open;
the existing main-app and COC print flows are not intentionally altered.

## Verification

```powershell
$routingTests = @(Get-ChildItem tests/atlas-routing-*.test.* -File | ForEach-Object { $_.FullName })
node --test @routingTests
node --check atlas-routing.js
node --check atlas-routing-core.js
node --check atlas-routing-planner.js
git diff --check
```

169 routing tests passed. The combined focused runner is now
`node tools/run-regressions.cjs`: 179 tests, all passed. The existing session-aware
cache fix from origin/main was reconciled; see `tests/README.md` for scope.
Isolated browser QA with synthetic orders exercised
actual UI/model code, optimized visit order, split shipments, paperwork references,
escaped markup, the print action, long-sheet pagination, a 390px mobile viewport,
close/account cleanup, edit invalidation and disabled printing after a failed
later trip. The revised sheet was checked in desktop, mobile and print CSS views:
sales order placement, removed invoice/fulfillment/start/finish fields, retained
box allocations and CHECK ON DELIVERY. No paid API calls or real
customer records were used.

Historical auth and offline-cache checks have been restored; full
ATLAS/COC/workbook/receiver coverage remains incomplete. Physical printers,
iPhone/Android print dialogs, live Google routing and
the deployed private app were not tested for this change. The existing planner
still optimizes within assigned loads, not globally across all trips and drivers.
Saved days retain reviewed planning inputs; routes must be recalculated to print
current estimates. Full application verification remains incomplete.
