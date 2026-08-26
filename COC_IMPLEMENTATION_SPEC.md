# ATLAS COC WORKFLOW

## Authoritative Implementation Specification

---

# CRITICAL IMPLEMENTATION DIRECTIVE

This document defines the approved behavior for the new **ATLAS Certificate of Compliance (COC) workflow**.

It must be treated as the **single source of truth** for implementation.

Before changing application code:

1. Create the following file in the ATLAS repository:

   `docs/COC_IMPLEMENTATION_SPEC.md`
2. Save this complete specification into that file.
3. Commit the specification to the repository.
4. Implement the COC feature according to this document.
5. Do not materially change any business rule, scanning rule, workflow step, validation rule, or user interaction described here without explicit approval.

If an implementation detail is technically incompatible with the existing ATLAS architecture, preserve the intent of this specification and document the required deviation before changing the behavior.

---

# 1. PURPOSE

ATLAS is adding a warehouse **Certificate of Compliance (COC)** workflow.

The company packages regulated ingredients, and certain customers require a COC containing the batch/lot numbers associated with each pallet shipped.

The current process is manual:

- employee pulls the order,
- employee works pallet by pallet,
- employee reads the printed batch/lot number on the boxes,
- employee writes the lengthy lot number on paper,
- employee creates tally marks for cases belonging to that lot,
- when another lot appears, employee writes another lot and starts another tally,
- when the pallet is finished, the employee resets and repeats the process,
- after all pallets are finished, the handwritten information must be entered into the company's official COC Excel spreadsheet.

The purpose of this ATLAS feature is to eliminate as much handwriting, transcription, duplicate entry, and counting risk as possible.

The COC system must be:

1. **Extremely accurate**
2. **Faster than pen and paper**
3. **Extremely simple**
4. **Easy for a new warehouse employee to understand**
5. **Resilient to interruptions**
6. **Designed for real warehouse use on mobile phones**

The success standard is not:

> "ATLAS can technically perform the procedure."

The success standard is:

> "A warehouse employee would rather use ATLAS than a pen and clipboard."

---

# 2. CORE DESIGN PHILOSOPHY

Do not overengineer this workflow.

The employee should make as few decisions as possible.

For routine counting:

### Same active lot

**One tap: + ADD CASE**

### Different lot already recorded on pallet

**Tap lot → + ADD CASE**

### New lot

**NEW LOT → Scan → Confirm**

### Finished pallet

**FINISH PALLET**

### Interrupted

Navigate elsewhere in ATLAS and later tap the persistent COC bar.

### Finished COC

Generate the official company Excel COC and send it to the office workstation.

Every feature must be evaluated against:

> Does this improve speed, accuracy, or usability?

If not, leave it out.

---

# 3. MAIN NAVIGATION — WORKFLOWS

Add a new primary ATLAS navigation destination:

# Workflows

Do not place COC inside Inventory.

COC is an operational procedure, not an inventory modification.

The conceptual ATLAS navigation becomes:

1. Home / Search SKU
2. Inventory
3. Workflows
4. Dashboard
5. About

Preserve the established mobile/desktop ATLAS navigation behavior.

IMPORTANT:

The existing requirement regarding **About** remains unchanged:

- About must remain available on desktop.
- About must not appear in the mobile main menu.
- Do not delete or globally disable the About page.

---

# 4. WORKFLOWS PAGE

The initial Workflows screen should remain extremely clean.

Display:

## COC

### Certificate of Compliance

Supporting description:

> Record pallet lot numbers and case quantities.

Primary action:

**Start COC**

If a COC is already active:

**Resume COC**

Do not populate this screen with fake future workflow cards.

The architecture may support future workflows, but only COC needs to be visible now.

---

# 5. COC IDENTIFIER

Use:

# Invoice

Do NOT use:

- Order
- Order / Job
- Job Number

The COC should be associated with an:

**Invoice Number**

This terminology must be consistent throughout the COC workflow and final spreadsheet process.

---

# 6. START COC

When the employee selects:

**Start COC**

request only the minimal information needed.

Required initial field:

### Invoice Number

Do not require unnecessary customer information, email addresses, SKU information, or administrative data unless needed later for the official Excel template.

After the Invoice Number is entered:

**Start COC**

Then begin the pallet workflow.

---

# 7. ONLY ONE ACTIVE COC INITIALLY

For the first production version, do not support multiple simultaneous active COCs for one employee/session/device.

If an employee already has a COC active and attempts to start another:

## COC Already In Progress

Show:

- Invoice
- Current pallet
- Current case count

Actions:

**Resume Current COC**

or

**Discard & Start New**

Discarding must require explicit confirmation.

---

# 8. ACTIVE WORKFLOW BAR

Once a COC is started, create a persistent **Active Workflow Bar** near the top of ATLAS.

This is a major UX requirement.

The design concept is similar to the persistent indicator presented by mobile operating systems when a phone call is active.

Example:

**● COC · Invoice 45892 · Pallet 3 · 31 Cases ›**

Compact mobile version may be:

**● COC · P3 · 31 Cases ›**

The bar must:

- remain visible while a COC is active,
- remain visible when navigating to normal ATLAS screens,
- integrate cleanly beneath or within the established ATLAS header,
- remain thin and unobtrusive,
- not consume excessive workspace,
- clearly indicate active work,
- be tappable across the full bar.

Tap behavior:

**Tap anywhere → immediately return to exact active COC state.**

---

# 9. DO NOT USE A LARGE REDUNDANT ACTIVE COC HOME CARD

Do not add a large "COC in progress" card on the Home screen if the persistent top Active Workflow Bar is visible.

The top bar provides the required resume functionality and keeps the application cleaner.

Avoid redundant representations of the same active workflow.

The Active Workflow Bar is the primary resume mechanism.

---

# 10. NAVIGATING AWAY MUST NOT END OR RESET THE COC

An employee may be interrupted while counting.

Examples:

- needs to search for a SKU,
- needs to use Inventory,
- needs to check another ATLAS screen,
- locks the phone,
- switches applications,
- refreshes ATLAS,
- temporarily loses connection.

Leaving the COC screen must NEVER:

- cancel the COC,
- reset the pallet,
- reset lot quantities,
- reset the active lot,
- finish the pallet,
- lose data.

The workflow simply remains active.

The top COC bar remains visible.

When tapped, the employee must return to the exact state they left.

---

# 11. COC PERSISTENCE REQUIREMENTS

Active COC state must not exist solely in temporary UI state.

Persist state frequently.

Save after meaningful events including:

- COC creation,
- Invoice entry,
- pallet creation,
- expected pallet box count entry,
- new lot confirmation,
-

* Add Case,

1. Undo Last Case,
2. active lot switch where appropriate,
3. pallet completion,
4. new pallet creation,
5. COC completion.

The workflow should survive:

- navigation,
- browser refresh,
- PWA refresh,
- phone locking,
- app backgrounding,
- closing/reopening the application,
- temporary connectivity interruptions where practical.

Do not silently lose warehouse counts.

---

# 12. PALLET EXPECTED BOX COUNT — REQUIRED

Before an employee begins recording lot numbers for each pallet, ATLAS must require a **physical box count verification**.

This is a key accuracy safeguard.

When starting Pallet 1:

# Pallet 1

Ask:

### How many boxes are physically on this pallet?

Employee enters:

Example:

**48**

Then:

**Confirm Box Count**

ATLAS stores:

**Expected Cases: 48**

Only then does the lot-counting screen begin.

Repeat this before every new pallet.

Example:

Pallet 2 begins:

### Verify Pallet 2 Box Count

Employee enters:

**40**

That becomes the expected total.

---

# 13. WHY EXPECTED BOX COUNT EXISTS

The total lot tally at the end of the pallet must equal the original physical case count.

Example:

Expected:

**48 Cases**

Recorded through lots:

Lot A — 20
Lot B — 18
Lot C — 9

Total:

**47**

ATLAS must NOT allow normal pallet completion.

Show:

# BOX COUNT MISMATCH

**Expected:** 48
**Recorded:** 47
**Difference:** -1

Supporting text:

> The recorded lot quantities do not match the verified physical pallet count.

Primary action:

**Review Counts**

Do not allow an employee to casually bypass the mismatch.

For the initial version, no supervisor approval mechanism is required.

Do not build supervisor approval yet.

The employee should correct the count.

---

# 14. MATCHED PALLET

If:

**Expected:** 48
**Recorded:** 48

Display:

### ✓ Box Count Verified

Then allow:

**Finish Pallet**

This is one of the strongest protections against missed or duplicate case taps.

---

# 15. PALLET WORKING SCREEN

Once expected box count is established:

Example:

# COC · Pallet 3

**Expected: 48 Cases**

**31 Recorded**

### ACTIVE LOT

**EPHE2550-2**

# 12 CASES

Primary button:

# + ADD CASE

Secondary controls:

**+ New Lot**

**Undo Last Case**

Then:

## LOTS ON THIS PALLET

Example:

**EPHE2550-2** — 12 cases
**EPIE2550-2** — 8 cases
**FPAC2603180001** — 6 cases
**FPST2607220001** — 5 cases

The selected Active Lot must be extremely visually obvious.

Use established ATLAS cobalt-blue visual treatment.

---

# 16. COUNTING BEHAVIOR

Do NOT scan every physical case.

That would defeat the purpose of the workflow.

Only scan when encountering a lot that has not already been added to the current pallet.

Once a lot exists:

### Same lot

Tap:

**+ ADD CASE**

### Different existing lot

Tap that lot row.

Then:

**+ ADD CASE**

---

# 17. CONFIRMED NEW LOT STARTS AT CASE 1

When an employee scans a physical box to create a new lot and confirms the lot:

The scanned physical box itself must count as:

# 1 CASE

Do not make the employee:

scan → confirm → then separately press + Add Case

for the box already being scanned.

That creates unnecessary off-by-one risk.

Correct behavior:

**New Lot → Scan → Confirm**

Result:

**Lot created with 1 case**

Then additional matching boxes use:

**+ ADD CASE**

---

# 18. + ADD CASE

This is the most frequently used button in the workflow.

It must be:

- large,
- easy to reach,
- highly visible,
- easy to operate one-handed,
- visually distinct from destructive controls.

When tapped:

Example:

12 → 13

Immediately update:

- active lot case quantity,
- pallet recorded total,
- remaining expected quantity,
- persisted COC state.

Recommended feedback:

- subtle vibration when supported,
- quick visual count animation,
- short confirmation feedback.

Do not show a modal after each case.

---

# 19. REMAINING CASE INDICATOR

Because expected physical box count is known, show useful progress.

Example:

**31 / 48 Recorded**

or:

**17 Cases Remaining**

This should help employees notice counting problems while they work rather than only at the end.

Do not make this visually distracting.

---

# 20. UNDO LAST CASE

Always keep:

**Undo Last Case**

accessible.

Do not bury it in a menu.

Undo must be transaction-aware.

It must know which lot received the most recent increment.

Example:

Lot A currently 19.

Accidental tap:

19 → 20

Tap:

**Undo Last Case**

Result:

20 → 19

Pallet total must also decrease.

Provide short feedback:

**Last case removed — EPHE2550-2 now 19 cases**

Do not require a modal confirmation.

---

# 21. FAST LOT SWITCHING

Pallets may contain many different lot numbers.

Switching must take one tap.

Each lot row must be a large touch target.

Behavior:

Tap existing lot row.

Immediately:

- that lot becomes active,
- its count appears in the Active Lot area,
- no case is added.

Important:

**Selecting a lot must never automatically increment a case.**

Counting remains a separate deliberate action.

---

# 22. LOT LIST — MANY LOTS

Test the interface with at least:

8–10 lots on one pallet.

The UI must remain usable.

The active lot must remain obvious.

The + Add Case button must remain readily accessible even when the lot list is long.

Do not create a tiny dropdown.

Do not require repeated modal navigation.

A scrollable lot list is acceptable if necessary.

---

# 23. NEW LOT CAPTURE — OVERVIEW

Employee taps:

# + NEW LOT

Open one scanner experience.

ATLAS should automatically determine the safest capture method.

There are two major physical label categories:

1. Current / modern boxes with barcodes
2. Legacy / older boxes without usable barcodes

The employee should not have to manually choose "modern" or "legacy" in normal use.

ATLAS should determine the method automatically when possible.

---

# 24. MODERN BOXES — BARCODE FIRST

Current boxes frequently contain a barcode associated with the batch/lot information.

For modern boxes:

### Barcode decoding is the primary capture method.

Do not use OCR as the first source when a valid lot barcode is available.

The barcode should provide higher accuracy and faster recognition.

However:

Do NOT blindly accept the first barcode visible in the camera.

There may be multiple barcodes on the box.

---

# 25. MULTIPLE BARCODE PROBLEM

Example boxes may contain:

- lot/batch barcode,
- product barcode,
- GTIN/carton barcode,
- 2D product code,
- unrelated warehouse/product code.

ATLAS must identify which barcode represents the COC batch information.

Example of an unrelated carton barcode seen on actual boxes:

**10810490030091**

This is not the COC lot.

ATLAS must not save it as a lot simply because it is a barcode.

Scanner behavior should conceptually be:

Camera sees multiple codes.

ATLAS evaluates candidates.

Reject:

- unrelated case/product GTIN,
- unrelated product code,
- unrelated Data Matrix where appropriate.

Accept:

- valid COC batch/lot barcode.

The employee should not normally have to manually select from multiple barcodes.

---

# 26. MODERN BARCODE — PRODUCT PREFIX PARSING

Some modern labels encode both product information and batch information in the barcode.

Actual example:

Model:

**CGUB1-30MLV3-BK**

Printed Batch No.:

**EPHE2550-2**

Human-readable barcode content:

**30MLV3BKEPHE2550-2**

The barcode therefore includes:

`30MLV3BK`

followed by:

`EPHE2550-2`

The actual COC lot is:

# EPHE2550-2

ATLAS must remove the known product/model prefix where applicable.

Do not save:

`30MLV3BKEPHE2550-2`

as the COC lot.

Save:

`EPHE2550-2`

---

# 27. MODERN BARCODE — DIRECT LOT VALUES

Some labels appear to have barcodes where the value itself is already the complete batch/lot.

Examples observed:

**FPAC2603180001**

**FPST2607220001**

In these cases:

No product prefix should be removed.

Save the complete value.

---

# 28. BARCODE + PRINTED BATCH CROSS-CHECK

For maximum accuracy, use the barcode and printed Batch No. together where practical.

Example:

Barcode-derived lot:

**EPHE2550-2**

OCR of printed:

**BATCH NO.: EPHE2550-2**

Agreement:

# ✓ Barcode + Print Match

Employee sees:

**EPHE2550-2**

Then:

**Confirm Lot**

This provides two independent validation sources.

---

# 29. MODERN LABEL MISMATCH

If barcode decoding produces:

**EPHE2550-2**

but printed Batch No. OCR produces:

**EPIE2550-2**

do not guess.

Do not automatically prefer the barcode.

Do not automatically prefer OCR.

Show:

# LOT DOES NOT MATCH

Supporting text:

> The barcode and printed batch number did not agree.

Action:

**Rescan**

Manual verified fallback may be offered only after repeated failures.

---

# 30. EMPLOYEE CONFIRMATION REMAINS REQUIRED

Even when:

- barcode is high confidence,
- OCR is high confidence,
- barcode and printed text agree,

employee visual confirmation should remain required when a new lot is first created.

The confirmation screen should be simple.

Example:

# LOT VERIFIED

### EPHE2550-2

**Barcode + printed batch match**

Primary:

**Confirm Lot**

Secondary:

**Rescan**

---

# 31. LEGACY BOXES — NO BARCODE

Older boxes do not have the modern usable lot barcode.

They show fields including:

- MODEL NO.
- BATCH NO.
- CGIPO

Legacy extraction follows a special business rule.

The raw printed Batch No. contains product/color information followed by the actual COC lot.

The company only records the portion of the batch number **after the product/color section**.

---

# 32. LEGACY EXAMPLE 1 — LOCKED RULE

Actual model:

**CGAC1-2OZ-OBK-OBK**

Actual printed batch:

**AT2OZOBKOBKADD20210824-2**

The product color suffix is:

**OBK-OBK**

Normalized for matching:

**OBKOBK**

Locate the end of that normalized product/color sequence inside:

**AT2OZOBKOBKADD20210824-2**

Everything after the color boundary becomes the COC lot.

Result:

# ADD20210824-2

This is the correct COC value.

---

# 33. LEGACY EXAMPLE 2 — LOCKED RULE

Actual model:

**CGAC1-2OZ-TBK-OBK**

Actual printed batch:

**AT2OZTBKOBKABA20210513-2**

Color suffix:

**TBK-OBK**

Normalized:

**TBKOBK**

Locate it inside:

**AT2OZTBKOBKABA20210513-2**

Everything after that boundary becomes:

# ABA20210513-2

This is the correct COC value.

---

# 34. LEGACY EXTRACTION MUST USE SKU KNOWLEDGE

Do not ask OCR or AI to guess where the product description ends.

ATLAS already has SKU/model information.

Use the recognized Model No. and existing ATLAS SKU knowledge to determine the product/color suffix.

Conceptually:

Recognized Model:

`CGAC1-2OZ-TBK-OBK`

Known color ending:

`TBK-OBK`

Normalize for matching only:

`TBKOBK`

Raw Batch:

`AT2OZTBKOBKABA20210513-2`

Find:

`TBKOBK`

Extract everything after it:

`ABA20210513-2`

---

# 35. NORMALIZATION RULE

Normalization must only be used internally to identify the product/color boundary.

Do not alter the final stored lot unnecessarily.

Example:

Model color:

`TBK-OBK`

Matching form:

`TBKOBK`

This does NOT mean the system should globally remove hyphens from batch values.

The final extracted COC lot must preserve the real lot formatting.

---

# 36. LEGACY OCR CAPTURE

Legacy scan should attempt to recognize:

### MODEL NO.

and

### BATCH NO.

Do not rely on reading the entire label as unstructured text.

Prefer targeted regions/field detection.

The employee should ultimately see:

## Legacy Lot Detected

**Model:**
CGAC1-2OZ-TBK-OBK

**Printed Batch:**
AT2OZTBKOBKABA20210513-2

**COC Lot:**

### ABA20210513-2

Primary:

**Confirm Lot**

Secondary:

**Rescan**

---

# 37. LEGACY FAILURE CONDITION

If ATLAS cannot confidently identify:

- Model No.,
- Batch No.,
- matching SKU,
- expected color suffix,
- color suffix inside the raw batch,

do not guess.

Show:

# LOT NOT VERIFIED

**Please rescan the label.**

After repeated failure, offer:

**Manual Verified Entry**

Manual entry is the fallback, not the default workflow.

---

# 38. MANUAL ENTRY FALLBACK

Manual entry must remain available because warehouse labels can be:

- damaged,
- dirty,
- partially covered by stretch wrap,
- faded,
- old,
- misprinted.

Manual entry should require deliberate verification.

Employee enters the COC lot.

Then ATLAS shows:

# Confirm Manual Lot

**ABA20210513-2**

Require confirmation before saving.

Record that capture method was:

**Manual**

---

# 39. LOW CONFIDENCE RULE

ATLAS must never silently guess a compliance lot number.

If scanner confidence is below the required threshold:

# LOT NOT VERIFIED

**Rescan**

Do not save a "best guess."

Accuracy takes priority over saving one or two seconds when confidence is poor.

---

# 40. AMBIGUOUS CHARACTER PROTECTION

Pay particular attention to OCR confusion involving:

- O / 0
- I / 1 / L
- S / 5
- B / 8
- Z / 2

If one of these characters is uncertain, force re-verification rather than guessing.

---

# 41. DUPLICATE LOT DETECTION

Before creating a lot on the current pallet, compare against existing lots.

If exact match exists:

# LOT ALREADY ON PALLET

Example:

**EPHE2550-2**

**8 cases currently recorded**

Actions:

**Use Existing Lot**

**Rescan**

Do not create a duplicate row.

Use Existing Lot:

- activates existing lot,
- does not increment automatically.

---

# 42. NEAR-DUPLICATE / SIMILAR LOT WARNING

Actual lots may differ by only one or two characters.

Example:

Existing:

**EPHE2550-2**

New:

**EPIE2550-2**

These are visually very similar.

If a new lot has very small edit distance / similarity to an existing lot, warn the employee:

# SIMILAR LOT DETECTED

**New:** EPIE2550-2
**Existing:** EPHE2550-2

> These are different lot numbers. Verify before continuing.

Actions:

**Confirm New Lot**

**Rescan**

Use this warning selectively.

Do not show it for obviously different values.

---

# 43. LOT TRACEABILITY METADATA

For every stored lot, retain enough metadata to reconstruct how ATLAS derived the value.

Recommended fields:

### Clean COC lot

Example:

`EPHE2550-2`

### Raw barcode

Example:

`30MLV3BKEPHE2550-2`

### Raw printed batch

When OCR is used.

### Model / SKU

Example:

`CGUB1-30MLV3-BK`

### Capture method

Examples:

- barcode
- barcode + OCR verified
- legacy OCR
- manual

### Timestamp

### Employee / user identity

Reuse ATLAS existing authentication/profile information where appropriate.

The warehouse employee does not need to see all metadata during normal counting.

---

# 44. FINISH PALLET

When employee taps:

# Finish Pallet

ATLAS must compare:

### Expected Case Count

against:

### Sum of Lot Case Counts

If equal:

Show:

## Pallet 3 Review

**Expected:** 48
**Recorded:** 48

### ✓ COUNT MATCH

Then list:

EPHE2550-2 — 12
EPIE2550-2 — 8
FPAC2603180001 — 16
FPST2607220001 — 12

Primary:

**Confirm & Finish Pallet**

Secondary:

**Go Back**

---

# 45. PALLET COUNT MISMATCH

If expected and recorded totals differ:

Do not allow normal completion.

Example:

# BOX COUNT MISMATCH

**Expected:** 48
**Recorded:** 47
**Difference:** 1 case missing

Show the lot list.

Primary:

**Review Counts**

Provide easy access to correct the tally.

No supervisor approval workflow is required in this version.

Do not add one yet.

---

# 46. COMPLETED PALLET

After confirmation:

- mark pallet complete,
- lock it against accidental edits,
- persist all lot/count information,
- create the next pallet.

Transition clearly.

Example:

# Pallet 3 Complete ✓

**48 Cases · 4 Lots**

Then:

# Pallet 4

### Verify Physical Box Count

The next pallet must begin completely clean.

Do not carry lot counts or expected count from prior pallet.

---

# 47. EDIT COMPLETED PALLET

Completed pallets should not be casually editable.

If editing is required:

Provide explicit:

**Reopen Pallet**

Then warning:

> You are reopening a completed pallet. Verify all quantities again before completing it.

Do not implement supervisor approval at this time.

Reuse existing ATLAS user/activity attribution where practical.

---

# 48. COC PROGRESS

Provide a compact overview:

**Pallet 1 ✓** — 48 Cases · 3 Lots
**Pallet 2 ✓** — 40 Cases · 2 Lots
**Pallet 3** — 31 / 48 Cases
**Pallet 4** — Not Started

Do not make this overview consume excessive space while counting.

The active tally screen remains the primary focus.

---

# 49. COMPLETE COC

After all physical pallets are finished:

Provide:

# Complete COC

Final review should show every pallet.

Example:

## Invoice 45892

### Pallet 1

48 Cases

EPHE2550-2 — 24
EPIE2550-2 — 24

### Pallet 2

40 Cases

FPAC2603180001 — 40

### Pallet 3

36 Cases

FPST2607220001 — 20
ADD20210824-2 — 16

### TOTAL

124 Cases
3 Pallets

This screen is the final human verification before spreadsheet generation.

---

# 50. OFFICIAL COMPANY EXCEL TEMPLATE

The final COC output must use the company's existing official Excel workbook.

The current blank template supplied is:

**NEW COC 2.xlsx**

Do not recreate a generic spreadsheet from scratch if it can be avoided.

Preferred process:

1. Load/copy the official master template.
2. Preserve existing formatting.
3. Populate only intended cells/rows.
4. Preserve:
   - company layout,
   - fonts,
   - borders,
   - row heights,
   - column widths,
   - merged cells,
   - formulas,
   - headers,
   - print layout,
   - hidden/helper sheets where applicable.
5. Save a new completed `.xlsx`.

The master template must remain unchanged.

---

# 51. FILLED COC EXAMPLE STILL REQUIRED FOR FINAL CELL MAPPING

The blank template is available.

A completed example will be supplied later.

Do not invent the final cell mapping before reviewing a real completed COC.

The completed example must be used to determine:

- exact pallet representation,
- exact placement of Model Number,
- Lot Number,
- Quantity,
- Invoice Number,
- customer fields,
- IF number if used,
- how multiple lots are written,
- how multiple pallets are separated,
- whether repeated models are duplicated,
- how overflow rows/pages are handled,
- workbook print behavior.

Build the Excel generator so mapping can be updated cleanly after the completed example is supplied.

---

# 52. COMPANY SPREADSHEET DATA PRINCIPLE

The lot value entered into Excel must be the exact **clean COC lot** stored by ATLAS.

Examples:

Modern barcode label:

Raw barcode:

`30MLV3BKEPHE2550-2`

Excel lot:

# EPHE2550-2

Legacy label:

Raw Batch:

`AT2OZTBKOBKABA20210513-2`

Excel lot:

# ABA20210513-2

Do not put raw scanner values into the official spreadsheet when the business rule requires extraction.

---

# 53. FINAL REPORT / SPREADSHEET GENERATION

Once final review is approved:

Primary action:

# Generate Company COC

Status:

**Generating spreadsheet…**

Then:

# Company COC Ready ✓

Show:

- Invoice
- pallet count
- total case count
- generated filename

Example:

`COC_45892.xlsx`

Do not require the employee to manually retype the final ATLAS report into Excel.

That duplicate entry is specifically what this workflow is intended to eliminate.

---

# 54. SEND TO OFFICE

After spreadsheet generation:

Provide one clear primary action:

# SEND TO OFFICE

The warehouse employee should not need to:

- email the file,
- download it manually,
- find a shared folder,
- locate the office employee,
- physically carry paper,
- re-enter data.

ATLAS handles transfer.

---

# 55. OFFICE COC RECEIVER

Create an ATLAS office-side receiver interface.

Concept:

# COC RECEIVER

Status:

**● Connected · Ready**

Incoming COCs:

### NEW

**Invoice 45892**

3 Pallets · 124 Cases

**Open COC**

The office computer receives the generated company Excel file.

---

# 56. USE BACKEND TRANSPORT — NOT FRAGILE LOCAL-IP TRANSFER

Although phones and the office computer may use the same warehouse Wi-Fi, do not make the primary implementation depend on:

- direct private IP addresses,
- Windows network shares,
- phone-to-PC HTTP requests,
- manual LAN configuration.

ATLAS already uses Supabase.

Prefer the existing backend/cloud architecture as the transport layer.

Concept:

Warehouse phone
→ ATLAS / Supabase
→ designated Office COC Station

This should make the transfer more reliable and avoid browser local-network restrictions.

---

# 57. OFFICE STATION PAIRING

Provide a simple setup method for the designated office computer.

Example:

# Pair This Computer

Station:

**Office COC Station**

Use a pairing token/code or another secure association compatible with existing ATLAS authentication.

After pairing:

Completed COCs sent from warehouse devices should target that station.

Do not require warehouse employees to select a computer every time.

---

# 58. COC DELIVERY STATES

Track transfer state explicitly.

Recommended lifecycle:

### COC Complete

Warehouse workflow finished.

### Spreadsheet Generated

Official Excel file successfully produced.

### Sent to Office

Warehouse device/backend successfully submitted it.

### Received by Office

Office station has acknowledged receipt.

### Entered / Handled

Office employee has completed their next step.

Display simple statuses.

Warehouse employee should ultimately see:

# ✓ RECEIVED BY OFFICE

This removes ambiguity.

---

# 59. OFFICE ACKNOWLEDGEMENT

When the office station receives a COC:

Acknowledge receipt back through ATLAS.

Warehouse side should display something similar to:

### COC RECEIVED ✓

**Office COC Station**

`COC_45892.xlsx`

Received at 2:47 PM

Do not mark as received merely because a send request was initiated.

---

# 60. OFFICE "MARK ENTERED"

Office COC Receiver may provide:

**Mark Entered**

This indicates that office personnel completed the next step in their existing system.

Keep this very lightweight.

Do not build a replacement for the company's existing office workflow.

---

# 61. COC CLOSE BEHAVIOR

A COC should not disappear immediately after spreadsheet generation.

Keep it available until the appropriate completion/send state is reached.

Once COC is fully closed:

- clear active COC state,
- remove Active Workflow Bar,
- return ATLAS to normal behavior.

Do not accidentally discard completed data.

---

# 62. DISCARD COC

Discard must be deliberate.

Do not place Discard beside + Add Case.

Use an overflow/settings area or other lower-risk location.

Confirmation:

# Discard COC?

> This will remove the active pallet and lot-counting session.

Primary safe action:

**Keep COC**

Destructive:

**Discard COC**

---

# 63. DATA MODEL — RECOMMENDED

Adapt to existing ATLAS/Supabase architecture.

Do not duplicate systems unnecessarily.

Recommended logical entities:

## coc\_sessions

Suggested fields:

- id
- invoice\_number
- status
- created\_by
- created\_at
- completed\_at
- current\_pallet\_id
- active\_lot\_id
- office\_delivery\_status
- generated\_file reference where appropriate

Statuses may include:

- active
- completed
- generated
- sent
- received
- closed
- discarded

---

# 64. COC PALLETS

Suggested:

## coc\_pallets

Fields:

- id
- coc\_id
- pallet\_number
- expected\_case\_count
- recorded\_case\_count
- status
- created\_at
- completed\_at

Recorded case total should be derived or validated against lot quantities.

---

# 65. COC LOTS

Suggested:

## coc\_lots

Fields:

- id
- coc\_id
- pallet\_id
- lot\_number
- case\_count
- sku/model reference
- raw\_barcode
- raw\_batch\_text
- capture\_method
- validation\_method
- created\_at
- created\_by

Do not require every field if the capture method does not provide it.

---

# 66. COC ACTIVITY / AUDIT

Where practical, integrate with existing ATLAS user/activity architecture.

Useful COC activity events may include:

- COC\_STARTED
- PALLET\_STARTED
- EXPECTED\_COUNT\_SET
- LOT\_ADDED
- CASE\_ADDED
- CASE\_UNDONE
- ACTIVE\_LOT\_CHANGED
- PALLET\_REOPENED
- PALLET\_COMPLETED
- COC\_COMPLETED
- COC\_GENERATED
- COC\_SENT
- COC\_RECEIVED
- COC\_CLOSED
- COC\_DISCARDED

Do not overload the existing inventory activity system if COC activity is logically separate.

---

# 67. STATE INTEGRITY RULES

Enforce:

1. Lot count cannot be negative.
2. Pallet recorded count cannot be negative.
3. Pallet recorded count must equal sum of lot counts.
4. Pallet cannot complete unless recorded total equals expected physical count.
5. Switching active lot must never add a case.
6. New confirmed lot begins with exactly 1 case.
7. Exact duplicate lot cannot create a second row on the same pallet.
8. Undo must affect the actual last case action.
9. Navigation cannot reset state.
10. Refresh cannot reset state.
11. Low-confidence scanner output cannot auto-save.
12. Barcode/text disagreement cannot auto-save.
13. Legacy extraction must not guess its boundary.
14. Clean lot value must be stored exactly as employee confirmed.
15. Completed pallet cannot be accidentally modified.
16. Final COC cannot complete with an unfinished pallet.
17. Excel generation must use verified clean lot values.
18. Spreadsheet send must not report "received" until office acknowledgement exists.

---

# 68. PERFORMANCE

Warehouse counting must feel instantaneous.

Actions requiring immediate response:

-

* Add Case

1. Undo Last Case
2. switch active lot

Do not visibly block each tap waiting for a database round trip if safe optimistic/local persistence can be used.

The employee must always know whether the count registered.

Use reliable persistence in the background.

---

# 69. OFFLINE / CONNECTION INTERRUPTION

If connection is temporarily unavailable but local durable persistence is supported:

Show:

**Saved on Device · Sync Pending**

Continue safely only if there is confidence that the data will not be lost.

If persistence cannot be guaranteed:

Do not pretend the count was safely recorded.

Present a clear error state.

Compliance data must never silently disappear.

---

# 70. CAMERA THROUGH SHRINK WRAP

Most pallets will be shrink wrapped.

Scanner implementation must be tested against:

- reflections,
- glare,
- stretched plastic,
- wrinkles,
- angled labels,
- partially obstructed barcodes.

Barcode scanning should be tolerant of ordinary shrink-wrap conditions.

Provide a simple camera framing guide.

Avoid requiring employees to perfectly crop the label manually.

---

# 71. BARCODE SCAN TARGETING

Because multiple barcodes can be visible:

Use barcode position, content pattern, SKU context, and known label rules to rank likely batch codes.

Do not save arbitrary UPC/GTIN values.

Where confidence in code classification is low:

Show:

**Lot barcode not confidently identified — reposition camera**

instead of guessing.

---

# 72. SKU CONTEXT

Where useful, ATLAS should use existing SKU information to improve scan reliability.

Potential uses:

- recognize Model No.,
- validate that scanned label belongs to expected product,
- determine modern barcode product prefix,
- determine legacy color suffix.

Do not force unnecessary SKU-selection steps if the required context can be inferred safely.

---

# 73. LEGACY RULES SHOULD BE CONFIGURABLE

Do not bury all legacy extraction assumptions in one hard-coded function.

Create clean parsing helpers/configuration so future legacy label families can be added.

Example rule structure conceptually:

- identify SKU/model,
- determine normalized suffix,
- locate suffix in batch,
- extract trailing characters,
- validate result.

This should make future exceptions maintainable.

---

# 74. BARCODE RULES SHOULD BE CONFIGURABLE

Likewise, barcode parsing should support:

- direct lot payloads,
- known SKU prefix + lot payload,
- irrelevant GTIN/product barcodes,
- future label formats.

Avoid assumptions that every barcode has identical structure.

---

# 75. USER EXPERIENCE — WAREHOUSE FIRST

Mobile UI must account for:

- one-handed use,
- gloves,
- movement,
- quick glances,
- bright warehouse lighting,
- interruptions,
- employees unfamiliar with COC procedures.

Use:

- large controls,
- strong hierarchy,
- minimal text,
- high contrast,
- obvious active lot,
- obvious recorded count.

Do not create a dense administrative interface.

---

# 76. DESKTOP

Desktop should support:

- viewing COC progress,
- reviewing completed data,
- office receiver,
- spreadsheet access.

Do not simply enlarge the mobile interface without thought.

However, preserve ATLAS brand consistency.

---

# 77. VISUAL DESIGN

Maintain established ATLAS design language:

- cobalt blue,
- clean white surfaces,
- rounded cards,
- premium warehouse-professional appearance,
- consistent typography,
- established icon style,
- minimal unnecessary animation.

The COC system should feel native to ATLAS.

---

# 78. NO EXCESSIVE ANIMATION

Counting is operational work.

Do not use flashy transitions that slow repeated actions.

Feedback should be quick and subtle.

Examples:

- short count pulse,
- small checkmark,
- haptic feedback.

---

# 79. SECURITY / PERMISSIONS

Reuse existing ATLAS authentication where possible.

Do not build a separate COC login system.

No supervisor approval process is required at this stage.

Keep permission architecture extensible so supervisor approval can be added later if testing reveals the need.

---

# 80. DO NOT IMPLEMENT THESE FEATURES YET

Do not add unless separately approved:

- supervisor approval for every pallet,
- customer emailing directly from warehouse phone,
- customer database,
- automatic customer portal,
- signatures,
- complicated document approval,
- scanning every individual box,
- multiple simultaneous active COCs per employee,
- arbitrary direct LAN file sharing,
- replacement for existing office business software.

---

# 81. IMPLEMENTATION PHASE 1 — SPEC + NAVIGATION

First:

1. Commit this specification.
2. Add Workflows to navigation.
3. Add Workflows page.
4. Add COC card.
5. Add Start COC.
6. Add Invoice field.
7. Add basic COC session creation.
8. Add persistent Active Workflow Bar.

Test navigation before deeper functionality.

---

# 82. IMPLEMENTATION PHASE 2 — PALLET ENGINE

Build:

- expected physical box count,
- pallet start,
- active lot state,
- manual temporary lot entry for development,
-

* Add Case,

1. Undo Last Case,
2. lot list,
3. one-tap lot switching,
4. expected vs recorded progress,
5. count mismatch logic.

Do not add camera complexity until tally logic is proven.

---

# 83. IMPLEMENTATION PHASE 3 — PERSISTENCE

Persist:

- active COC,
- Invoice,
- current pallet,
- expected count,
- lots,
- case quantities,
- active lot,
- completed pallets.

Test:

- navigation,
- refresh,
- close/reopen,
- app background,
- device lock.

Do not proceed until data survives interruptions reliably.

---

# 84. IMPLEMENTATION PHASE 4 — MODERN BARCODE SCANNER

Add:

- camera access,
- barcode detection,
- multiple-code classification,
- irrelevant-code rejection,
- direct-lot parsing,
- known product-prefix removal,
- printed batch OCR cross-check,
- confirmation,
- mismatch/rescan behavior.

Test using supplied real label photos.

---

# 85. IMPLEMENTATION PHASE 5 — LEGACY OCR

Add:

- Model No. OCR,
- Batch No. OCR,
- SKU lookup,
- color suffix extraction,
- normalized boundary matching,
- trailing lot extraction,
- confirmation,
- failure/rescan behavior,
- controlled manual fallback.

Use the two supplied legacy examples as mandatory regression tests.

---

# 86. IMPLEMENTATION PHASE 6 — PALLET COMPLETION

Add:

- expected vs recorded validation,
- mismatch error,
- review,
- pallet lock,
- next pallet creation,
- pallet progress overview.

---

# 87. IMPLEMENTATION PHASE 7 — COC COMPLETION

Add:

- complete COC review,
- all pallets,
- all lots,
- pallet totals,
- total cases.

Do not generate Excel until final review is correct.

---

# 88. IMPLEMENTATION PHASE 8 — EXCEL GENERATION

Use:

**NEW COC 2.xlsx**

as the master company template.

Implement the workbook-generation layer so cell mapping can be finalized after reviewing a filled-out example.

Do not alter the blank master.

---

# 89. IMPLEMENTATION PHASE 9 — OFFICE RECEIVER

Build:

- Office COC Station pairing,
- Send to Office,
- transfer state,
- office inbox/receiver,
- file open/download,
- received acknowledgement,
- optional Mark Entered.

Prefer Supabase/back-end transport.

---

# 90. IMPLEMENTATION PHASE 10 — POLISH

Only after functionality is stable:

- refine spacing,
- haptics,
- scanner framing,
- mobile responsiveness,
- transitions,
- desktop receiver layout.

Do not sacrifice stability for visual polish.

---

# 91. REQUIRED TEST — START COC

Enter Invoice.

Start COC.

Expected:

- active COC created,
- persistent top COC bar appears,
- Pallet 1 requests expected physical box count.

---

# 92. REQUIRED TEST — EXPECTED COUNT

Enter:

48

Expected:

- Pallet 1 records Expected = 48.
- Counting begins at 0 Recorded.
- Progress visible.

---

# 93. REQUIRED TEST — FIRST NEW LOT

Scan new lot.

Confirm.

Expected:

- lot added,
- lot count = 1,
- pallet recorded = 1.

---

# 94. REQUIRED TEST — + ADD CASE

Tap five times.

Expected:

- lot increases by 5,
- pallet increases by 5,
- immediate feedback,
- no modal.

---

# 95. REQUIRED TEST — UNDO

Tap Undo.

Expected:

- exact most recent case is removed,
- correct lot decreases,
- pallet decreases.

---

# 96. REQUIRED TEST — SECOND LOT

Add new lot.

Confirm.

Expected:

- new lot starts at 1,
- original remains unchanged,
- new lot becomes active.

---

# 97. REQUIRED TEST — SWITCH LOT

Tap original lot.

Expected:

- original becomes active,
- no count change.

Tap + Add Case.

Expected:

- only original lot increments.

---

# 98. REQUIRED TEST — DUPLICATE LOT

Attempt to scan an exact existing lot.

Expected:

- no duplicate created,
- "Lot Already on Pallet",
- Use Existing Lot available.

---

# 99. REQUIRED TEST — SIMILAR LOT

Existing:

EPHE2550-2

Add:

EPIE2550-2

Expected:

- similar-lot warning,
- explicit verification.

---

# 100. REQUIRED TEST — MODERN PREFIX BARCODE

Input label:

Model:

CGUB1-30MLV3-BK

Barcode:

30MLV3BKEPHE2550-2

Printed Batch:

EPHE2550-2

Expected final COC lot:

# EPHE2550-2

---

# 101. REQUIRED TEST — DIRECT MODERN LOT

Barcode:

FPAC2603180001

Expected:

# FPAC2603180001

No incorrect prefix removal.

---

# 102. REQUIRED TEST — IRRELEVANT CARTON BARCODE

Visible code:

10810490030091

Expected:

ATLAS must not treat this as the COC lot.

---

# 103. REQUIRED TEST — LEGACY OBK

Model:

CGAC1-2OZ-OBK-OBK

Raw Batch:

AT2OZOBKOBKADD20210824-2

Expected:

# ADD20210824-2

---

# 104. REQUIRED TEST — LEGACY TBK

Model:

CGAC1-2OZ-TBK-OBK

Raw Batch:

AT2OZTBKOBKABA20210513-2

Expected:

# ABA20210513-2

---

# 105. REQUIRED TEST — LOW CONFIDENCE

Provide unreadable/obstructed label.

Expected:

- no lot saved,
- rescan requested,
- no guessed value.

---

# 106. REQUIRED TEST — BARCODE/OCR MISMATCH

Barcode:

EPHE2550-2

OCR:

EPIE2550-2

Expected:

- mismatch,
- no auto-save,
- rescan.

---

# 107. REQUIRED TEST — MANY LOTS

Add at least 10 lots.

Expected:

- readable,
- fast switching,
-

* Add Case remains accessible,

1. active lot obvious.

---

# 108. REQUIRED TEST — INTERRUPTION

During Pallet 3:

Navigate to Search SKU.

Expected:

- COC bar remains visible.

Tap bar.

Expected:

- exact Pallet 3 state restored.

---

# 109. REQUIRED TEST — REFRESH

During active COC:

Refresh.

Expected:

- Invoice restored,
- pallet restored,
- expected total restored,
- lots restored,
- quantities restored,
- active lot restored,
- top bar restored.

---

# 110. REQUIRED TEST — BOX COUNT MATCH

Expected:

48

Recorded:

48

Expected:

- Finish Pallet enabled,
- successful verification.

---

# 111. REQUIRED TEST — BOX COUNT MISMATCH

Expected:

48

Recorded:

47

Expected:

- error shown,
- pallet cannot normally complete,
- Review Counts provided.

---

# 112. REQUIRED TEST — CLEAN NEW PALLET

Finish Pallet 1.

Expected:

Pallet 2:

- Expected not yet set,
- Recorded = 0,
- no lot rows,
- no previous counts.

---

# 113. REQUIRED TEST — FINAL COC MATH

Verify:

Sum of lot counts = each pallet total.

Sum of pallet totals = complete COC total.

Any mismatch = failure.

---

# 114. REQUIRED TEST — EXCEL

After cell mapping is finalized:

Generate official workbook.

Verify:

- exact COC lots,
- exact quantities,
- correct pallets,
- Invoice,
- existing formatting preserved,
- formulas preserved,
- print layout preserved.

---

# 115. REQUIRED TEST — OFFICE SEND

Generate workbook.

Tap:

Send to Office.

Expected:

- backend transfer created,
- office receiver gets the correct file,
- warehouse status changes to Sent.

---

# 116. REQUIRED TEST — OFFICE ACKNOWLEDGEMENT

Office receiver acknowledges.

Expected warehouse state:

# Received by Office ✓

Do not show this before actual acknowledgement.

---

# 117. REGRESSION AUDIT

COC implementation must not break existing ATLAS functionality.

Test:

- Home
- Search SKU
- Browse Inventory
- Inventory navigation
- Move Inventory
- Keep Both
- Move All
- Mark Location Empty
- Pick First
- Dashboard
- Workflows navigation
- warehouse map
- mobile main menu
- desktop main menu
- authentication
- Supabase integration
- existing notifications
- existing activity logging

No release if core ATLAS behavior regresses.

---

# 118. CODE ORGANIZATION

Keep COC modular.

Prefer dedicated areas such as:

- COC components
- COC services
- COC state/store
- scanning/parsing utilities
- Excel generation service
- office delivery service

Do not place large blocks of COC-specific logic directly into unrelated inventory components.

---

# 119. SCANNER PARSER TESTS

Parsing logic must have automated unit tests.

Especially test:

- barcode product prefix removal,
- direct lot barcode preservation,
- irrelevant barcode rejection,
- legacy suffix extraction,
- exact duplicates,
- similar lot detection,
- malformed/low-confidence values.

Do not rely solely on UI testing for COC parsing.

---

# 120. FINAL IMPLEMENTATION STANDARD

The completed warehouse experience should feel like:

**Workflows**

→ **COC**

→ Enter **Invoice**

→ **Start**

→ **Pallet 1: Verify Box Count**

→ **New Lot**

→ point camera

→ ATLAS identifies valid batch

→ employee confirms

→ **1 Case**

→ **+ Add Case**

→ **+ Add Case**

→ existing different lot:

**Tap Lot → + Add Case**

→ brand-new lot:

**New Lot → Scan → Confirm**

→ **Finish Pallet**

→ counts must match expected physical quantity

→ next pallet

If interrupted:

navigate anywhere in ATLAS

persistent bar remains:

**● COC · P3 · 31 Cases ›**

tap

immediately resume

When all pallets are finished:

→ **Complete COC**

→ review

→ **Generate Company COC**

→ official company Excel spreadsheet is populated

→ **Send to Office**

→ office computer receives workbook

→ warehouse sees:

# ✓ RECEIVED BY OFFICE

This is the target experience.

---

# FINAL PRODUCT REQUIREMENT

Do not judge success by how sophisticated the technology is.

Judge success by:

### Is it faster than paper?

### Is it harder to make a mistake?

### Can a new employee understand it immediately?

### Does it eliminate manual transcription?

### Can an interrupted employee resume instantly?

### Can the office receive a completed official COC without the warehouse retyping anything?

If all six are true, the COC update has achieved its purpose.

If a proposed feature adds complexity without improving one of those outcomes, do not add it.

