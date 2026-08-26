(function (global) {
  "use strict";

  const OFFICIAL_TEMPLATE = Object.freeze({
    fileName: "NEW COC 2.xlsx",
    sha256: "d12f37c2b81152e88ee5f6f92c6573459511bae05026c2f9eed75554b2eeac4c",
    visibility: "company_internal",
    repositoryPolicy: "do_not_commit_to_public_repository",
    sheetName: "Sheet1",
    usedRange: "A1:C748",
    entryColumns: Object.freeze(["MODEL NUMBER", "LOT NUMBER", "QUANTITY"]),
    merges: Object.freeze(["A1:C1", "A5:C5", "C3:C4"]),
    print: Object.freeze({ orientation: "portrait", scale: 95, fitToHeight: 0 }),
  });

  const PENDING_MAPPING = Object.freeze({
    status: "awaiting_completed_company_example",
    invoiceCell: null,
    customerCell: null,
    ifNumberCell: null,
    detailRows: null,
    palletNotation: null,
    overflowStrategy: null,
  });

  const safeText = (value, max = 140) => String(value ?? "").trim().slice(0, max);
  const safeCount = (value) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  };

  function buildExportModel(session, core = global.AtlasCocCore) {
    if (!session || !core) throw new Error("COC_EXPORT_STATE_REQUIRED");
    const safe = core.sanitize(JSON.parse(JSON.stringify(session)));
    if (safe.status !== "report") throw new Error("COC_FINAL_REVIEW_REQUIRED");
    const pallets = safe.pallets.map((pallet) => {
      const progress = core.palletProgress(pallet);
      if (!progress.verified) throw new Error(`PALLET_${pallet.number}_NOT_VERIFIED`);
      const lots = pallet.lots.map((lot) => ({
        cleanLot: safeText(lot.lot),
        quantity: safeCount(lot.cases),
        model: safeText(lot.model),
        rawBarcode: safeText(lot.rawBarcode),
        barcodeFormat: safeText(lot.barcodeFormat, 40),
        rawBatchText: safeText(lot.rawBatchText),
        sku: safeText(lot.sku || safe.sku),
        captureMethod: safeText(lot.captureMethod || lot.verification),
        validationMethod: safeText(lot.validationMethod),
      }));
      const total = lots.reduce((sum, lot) => sum + lot.quantity, 0);
      if (total !== progress.recorded || total !== progress.expected)
        throw new Error(`PALLET_${pallet.number}_TOTAL_MISMATCH`);
      return {
        palletNumber: pallet.number,
        expectedBoxes: progress.expected,
        recordedBoxes: progress.recorded,
        verified: true,
        lots,
      };
    });
    const totalBoxes = pallets.reduce((sum, pallet) => sum + pallet.recordedBoxes, 0);
    if (totalBoxes !== core.sessionTotal(safe)) throw new Error("COC_TOTAL_MISMATCH");
    return Object.freeze({
      sessionId: safeText(safe.id),
      invoiceNumber: safeText(safe.invoiceNumber || safe.orderNumber),
      sku: safeText(safe.sku),
      employee: safeText(safe.employee, 60),
      completedAt: safeText(safe.completedAt, 40),
      palletCount: pallets.length,
      totalBoxes,
      pallets,
    });
  }

  function mappingReadiness(mapping = global.atlasCocExcelMapping || PENDING_MAPPING) {
    const required = ["invoiceCell", "detailRows", "palletNotation", "overflowStrategy"];
    const missing = required.filter((key) => !mapping?.[key]);
    const ready = mapping?.status === "finalized" && missing.length === 0;
    return Object.freeze({
      ready,
      status: mapping?.status || "missing",
      missing,
      reason: ready
        ? "ready"
        : "A completed company COC example is required before exact Excel cell mapping is finalized.",
    });
  }

  async function bytesFrom(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (value?.arrayBuffer) return new Uint8Array(await value.arrayBuffer());
    throw new Error("COC_TEMPLATE_BYTES_REQUIRED");
  }

  async function sha256(bytes) {
    if (!global.crypto?.subtle) throw new Error("COC_TEMPLATE_HASH_UNAVAILABLE");
    const digest = await global.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  function outputFileName(invoiceNumber) {
    const safeInvoice = safeText(invoiceNumber, 80).replace(/[^A-Z0-9_-]+/gi, "_") || "UNASSIGNED";
    return `COC_${safeInvoice}.xlsx`;
  }

  async function generateCompanyCoc(session, adapters = {}) {
    const mapping = adapters.mapping || global.atlasCocExcelMapping || PENDING_MAPPING;
    const readiness = mappingReadiness(mapping);
    if (!readiness.ready) throw new Error("COC_EXCEL_MAPPING_PENDING");
    for (const name of ["loadMasterTemplate", "populateTemplateCopy", "saveGeneratedWorkbook"])
      if (typeof adapters[name] !== "function") throw new Error(`COC_EXCEL_ADAPTER_REQUIRED_${name}`);

    const data = buildExportModel(session, adapters.core || global.AtlasCocCore);
    const masterBytes = await bytesFrom(await adapters.loadMasterTemplate(OFFICIAL_TEMPLATE));
    const masterHash = await sha256(masterBytes);
    if (masterHash !== OFFICIAL_TEMPLATE.sha256) throw new Error("COC_TEMPLATE_SIGNATURE_MISMATCH");

    const workingCopy = masterBytes.slice();
    const populated = await adapters.populateTemplateCopy({
      templateBytes: workingCopy,
      mapping,
      data,
      template: OFFICIAL_TEMPLATE,
    });
    const outputBytes = await bytesFrom(populated);
    const fileName = outputFileName(data.invoiceNumber);
    await adapters.saveGeneratedWorkbook({ fileName, bytes: outputBytes, data });
    return Object.freeze({ fileName, data, templateHash: masterHash });
  }

  global.AtlasCocExcel = Object.freeze({
    OFFICIAL_TEMPLATE,
    PENDING_MAPPING,
    buildExportModel,
    mappingReadiness,
    outputFileName,
    generateCompanyCoc,
  });
})(window);
