# Official COC Workbook Audit

## Master template

- Supplied file: `NEW COC 2.xlsx`
- Classification: Company-internal master template
- SHA-256: `d12f37c2b81152e88ee5f6f92c6573459511bae05026c2f9eed75554b2eeac4c`
- Repository rule: Do not commit the workbook to a public repository.
- Generation rule: Load the secure master, clone its bytes, populate the copy, and save a new workbook. Never overwrite the master.

## Workbook structure

- Worksheets: 1
- Sheet name: `Sheet1`
- Used/preformatted range: `A1:C748`
- Formula cells: 0
- Defined names: 0
- Hidden/helper sheets: 0
- Excel tables: 0
- Merged ranges: `A1:C1`, `A5:C5`, `C3:C4`

## Visible form layout

- `A1:C1`: Certificate of Compliance Information Form
- Customer Name field in row 2
- Invoice Number field in row 3
- IF Number field in row 4
- Column A: Model Number
- Column B: Lot Number, with pallet-number instruction
- Column C: Quantity
- Entry rows continue through row 748 with the official yellow/green company formatting and borders.

## Dimensions and print configuration

- Column A width: 35.625
- Column B width: 35.625
- Column C width: 15.625
- Default row height: 14.25
- Row 1 height: 45
- Row 2 height: 25.5
- Rows 3–4 height: 18.75
- Row 5 height: 15
- Row 6 height: 34.5
- Sheet zoom: 130%
- Orientation: Portrait
- Print scale: 95%
- Fit-to-height: 0
- Margins: left/right 0.7, top/bottom 0.75, header/footer 0.3
- A printer-settings binary is embedded and must be preserved when the template is copied.

## Mapping status

Exact cell mapping is intentionally **not finalized**. A completed company COC example is still required to confirm:

- customer and IF-number behavior,
- exact Invoice placement,
- model/lot/quantity row rules,
- pallet-number notation,
- repeated model behavior,
- multiple-lot and multiple-pallet separation,
- overflow/page behavior,
- final print behavior.

The runtime foundation in `atlas-coc-excel.js` blocks generation until a mapping explicitly declares itself `finalized`. This prevents ATLAS from inventing a compliance-document layout.
