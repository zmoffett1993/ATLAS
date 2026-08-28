(function (global) {
  "use strict";

  const OFFICIAL_TEMPLATE = Object.freeze({
    fileName: "NEW COC 2.xlsx",
    url: "./NEW COC 2.xlsx?v=20260827",
    sha256: "d12f37c2b81152e88ee5f6f92c6573459511bae05026c2f9eed75554b2eeac4c",
    visibility: "company_internal",
    sheetName: "Sheet1",
    usedRange: "A1:C748",
    entryColumns: Object.freeze(["MODEL NUMBER", "LOT NUMBER", "QUANTITY"]),
    merges: Object.freeze(["A1:C1", "A5:C5", "C3:C4"]),
    blankFillStyles: Object.freeze({ A6: 7, C2: 5, C3: 17, C4: 17 }),
    print: Object.freeze({ orientation: "portrait", scale: 95, fitToHeight: 0 }),
  });

  const FINAL_MAPPING = Object.freeze({
    status: "finalized",
    customerCell: "B2",
    invoiceCell: "B3",
    ifNumberCell: "B4",
    detailRows: Object.freeze({ first: 7, last: 748, columns: "A:C" }),
    palletNotation: "PALLET {number}",
    overflowStrategy: "block_generation_when_rows_exceed_748",
  });

  const safeText = (value, max = 160) => String(value ?? "").trim().slice(0, max);
  const safeCount = (value) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  };
  const positiveInteger = (value) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  };
  const canonicalModel = (value) => safeText(value).toUpperCase().replace(/[^A-Z0-9]/g, "");

  function buildExportModel(session, core = global.AtlasCocCore) {
    if (!session || !core) throw new Error("COC_EXPORT_STATE_REQUIRED");
    const safe = core.sanitize(JSON.parse(JSON.stringify(session)));
    if (safe.status !== "report") throw new Error("COC_FINAL_REVIEW_REQUIRED");
    if (!safe.customerName) throw new Error("COC_CUSTOMER_REQUIRED");
    if (!safe.invoiceNumber) throw new Error("COC_INVOICE_REQUIRED");
    if (!safe.ifNumber) throw new Error("COC_IF_NUMBER_REQUIRED");

    const pallets = safe.pallets.map((pallet) => {
      const progress = core.palletProgress(pallet);
      if (!progress.verified) throw new Error(`PALLET_${pallet.number}_NOT_VERIFIED`);
      const lots = pallet.lots.map((lot) => {
        const caseQuantity = positiveInteger(lot.caseQuantity) ||
          positiveInteger(core.modelRecord?.(safe, lot.model)?.caseQuantity);
        if (!lot.model || !caseQuantity)
          throw new Error(`MODEL_CASE_QUANTITY_REQUIRED_${safeText(lot.model) || "UNKNOWN"}`);
        const boxes = safeCount(lot.cases);
        return {
          cleanLot: safeText(lot.lot),
          boxes,
          quantity: boxes * caseQuantity,
          model: safeText(lot.model),
          caseQuantity,
          detectedModel: safeText(lot.detectedModel),
          rawBarcode: safeText(lot.rawBarcode),
          barcodeFormat: safeText(lot.barcodeFormat, 40),
          rawBatchText: safeText(lot.rawBatchText),
          sku: safeText(lot.sku || lot.model || safe.sku),
          captureMethod: safeText(lot.captureMethod || lot.verification),
          validationMethod: safeText(lot.validationMethod),
        };
      });
      const totalBoxes = lots.reduce((sum, lot) => sum + lot.boxes, 0);
      const totalQuantity = lots.reduce((sum, lot) => sum + lot.quantity, 0);
      if (totalBoxes !== progress.recorded || totalBoxes !== progress.expected)
        throw new Error(`PALLET_${pallet.number}_TOTAL_MISMATCH`);
      const modelNames = new Map();
      lots.forEach((lot) => {
        const key = canonicalModel(lot.model);
        if (key && !modelNames.has(key)) modelNames.set(key, lot.model);
      });
      const modelBlocks = [...modelNames.entries()].map(([key, modelNumber]) => {
        const modelLots = lots.filter((lot) => canonicalModel(lot.model) === key);
        const caseQuantities = new Set(modelLots.map((lot) => lot.caseQuantity));
        if (caseQuantities.size !== 1)
          throw new Error(`INCONSISTENT_CASE_QUANTITY_${modelNumber}`);
        return {
          modelNumber,
          caseQuantity: modelLots[0]?.caseQuantity,
          totalBoxes: modelLots.reduce((sum, lot) => sum + lot.boxes, 0),
          totalQuantity: modelLots.reduce((sum, lot) => sum + lot.quantity, 0),
          lots: modelLots,
        };
      });
      return {
        palletNumber: pallet.number,
        expectedBoxes: progress.expected,
        recordedBoxes: progress.recorded,
        totalQuantity,
        verified: true,
        lots,
        modelBlocks,
      };
    });

    const totalBoxes = pallets.reduce((sum, pallet) => sum + pallet.recordedBoxes, 0);
    const totalQuantity = pallets.reduce((sum, pallet) => sum + pallet.totalQuantity, 0);
    if (totalBoxes !== core.sessionTotal(safe)) throw new Error("COC_TOTAL_MISMATCH");

    const usedByKey = new Map();
    pallets.forEach((pallet) => pallet.lots.forEach((lot) => {
      const key = canonicalModel(lot.model);
      if (!usedByKey.has(key)) usedByKey.set(key, lot.model);
    }));
    const modelOrder = [...usedByKey.keys()];

    const models = modelOrder.map((key) => {
      const modelNumber = usedByKey.get(key);
      const blocks = pallets.map((pallet) => {
        const lots = pallet.lots.filter((lot) => canonicalModel(lot.model) === key);
        if (!lots.length) return null;
        const caseQuantities = new Set(lots.map((lot) => lot.caseQuantity));
        if (caseQuantities.size !== 1) throw new Error(`INCONSISTENT_CASE_QUANTITY_${modelNumber}`);
        return {
          palletNumber: pallet.palletNumber,
          caseQuantity: lots[0].caseQuantity,
          totalBoxes: lots.reduce((sum, lot) => sum + lot.boxes, 0),
          totalQuantity: lots.reduce((sum, lot) => sum + lot.quantity, 0),
          lots,
        };
      }).filter(Boolean);
      return {
        modelNumber,
        caseQuantity: blocks[0]?.caseQuantity,
        blocks,
        totalBoxes: blocks.reduce((sum, block) => sum + block.totalBoxes, 0),
        totalQuantity: blocks.reduce((sum, block) => sum + block.totalQuantity, 0),
      };
    });

    return Object.freeze({
      sessionId: safeText(safe.id),
      customerName: safeText(safe.customerName),
      invoiceNumber: safeText(safe.invoiceNumber || safe.orderNumber),
      ifNumber: safeText(safe.ifNumber),
      employee: safeText(safe.employee, 60),
      completedAt: safeText(safe.completedAt, 40),
      palletCount: pallets.length,
      totalBoxes,
      totalQuantity,
      pallets,
      models,
    });
  }

  function buildDetailRows(data, mapping = FINAL_MAPPING) {
    let rowNumber = mapping.detailRows.first;
    const rows = [];
    data.pallets.forEach((pallet) => {
      pallet.modelBlocks.forEach((block) => {
        rows.push({
          rowNumber: rowNumber++,
          type: "pallet",
          modelNumber: block.modelNumber,
          palletNumber: pallet.palletNumber,
          a: block.modelNumber,
          b: `PALLET ${pallet.palletNumber}`,
          c: null,
        });
        const firstQuantityRow = rowNumber;
        block.lots.forEach((lot) => {
          rows.push({
            rowNumber: rowNumber++,
            type: "lot",
            modelNumber: block.modelNumber,
            palletNumber: pallet.palletNumber,
            cleanLot: lot.cleanLot,
            boxes: lot.boxes,
            caseQuantity: lot.caseQuantity,
            a: "",
            b: lot.cleanLot,
            c: lot.quantity,
          });
        });
        const lastQuantityRow = rowNumber - 1;
        rows.push({
          rowNumber: rowNumber++,
          type: "total",
          modelNumber: block.modelNumber,
          palletNumber: pallet.palletNumber,
          a: "",
          b: "TOTAL QTY",
          c: block.totalQuantity,
          formula: `SUM(C${firstQuantityRow}:C${lastQuantityRow})`,
        });
        rows.push({ rowNumber: rowNumber++, type: "separator", a: "", b: "", c: null });
      });
    });
    if (rows.at(-1)?.type === "separator") rows.pop();
    const contentRows = rows.filter((row) => row.type !== "separator");
    const lastContentRow = contentRows.length
      ? contentRows[contentRows.length - 1].rowNumber
      : mapping.detailRows.first;
    if (lastContentRow > mapping.detailRows.last) throw new Error("COC_TEMPLATE_ROW_CAPACITY_EXCEEDED");
    return Object.freeze({ rows, lastContentRow });
  }

  function mappingReadiness(mapping = global.atlasCocExcelMapping || FINAL_MAPPING) {
    const required = ["customerCell", "invoiceCell", "ifNumberCell", "detailRows", "palletNotation", "overflowStrategy"];
    const missing = required.filter((key) => !mapping?.[key]);
    const ready = mapping?.status === "finalized" && missing.length === 0;
    return Object.freeze({
      ready,
      status: mapping?.status || "missing",
      missing,
      reason: ready ? "ready" : "The official COC mapping is incomplete.",
    });
  }

  async function bytesFrom(value) {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value))
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
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

  function escapeXml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }

  function locateCell(xml, reference) {
    const openingPattern = new RegExp(`<c(?=[^>]*\\br="${reference}")[^>]*>`);
    const openingMatch = openingPattern.exec(xml);
    if (!openingMatch) return null;

    const start = openingMatch.index;
    const opening = openingMatch[0];
    if (opening.endsWith("/>")) {
      return { start, end: start + opening.length, xml: opening };
    }

    const closing = "</c>";
    const closingIndex = xml.indexOf(closing, start + opening.length);
    if (closingIndex < 0) throw new Error(`COC_TEMPLATE_CELL_INVALID_${reference}`);
    const end = closingIndex + closing.length;
    return { start, end, xml: xml.slice(start, end) };
  }

  function replaceLocatedXml(xml, located, replacement) {
    return `${xml.slice(0, located.start)}${replacement}${xml.slice(located.end)}`;
  }

  function writeCell(xml, reference, value, { formula = "" } = {}) {
    const located = locateCell(xml, reference);
    if (!located) throw new Error(`COC_TEMPLATE_CELL_MISSING_${reference}`);
    const match = located.xml;
    const attributes = match.match(/^<c([^>]*?)(?:\/>|>)/)?.[1]
      ?.replace(/\s+t="[^"]*"/g, "") || ` r="${reference}"`;
    let replacement = `<c${attributes}/>`;
    if (formula) {
      replacement = `<c${attributes}><f>${escapeXml(formula)}</f><v>${Number(value)}</v></c>`;
    } else if (typeof value === "number") {
      replacement = `<c${attributes}><v>${value}</v></c>`;
    } else if (value !== null && value !== undefined && value !== "") {
      replacement = `<c${attributes} t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
    }
    return replaceLocatedXml(xml, located, replacement);
  }

  function ensureStyledBlankCell(xml, reference, styleId) {
    const located = locateCell(xml, reference);
    if (located) {
      const existing = located.xml;
      const styled = /\s+s="[^"]*"/.test(existing)
        ? existing.replace(/\s+s="[^"]*"/, ` s="${styleId}"`)
        : existing.replace(/^<c/, `<c s="${styleId}"`);
      return replaceLocatedXml(xml, located, styled);
    }

    const rowNumber = reference.match(/\d+$/)?.[0];
    const targetColumn = reference.match(/^[A-Z]+/)?.[0] || "";
    if (!rowNumber || !targetColumn) throw new Error(`COC_TEMPLATE_CELL_INVALID_${reference}`);
    const rowPattern = new RegExp(`(<row(?=[^>]*\\br="${rowNumber}")[^>]*>)([\\s\\S]*?)(<\\/row>)`);
    if (!rowPattern.test(xml)) throw new Error(`COC_TEMPLATE_ROW_MISSING_${rowNumber}`);
    return xml.replace(rowPattern, (_, opening, body, closing) => {
      const cell = `<c r="${reference}" s="${styleId}"/>`;
      const cells = [...body.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)];
      const nextCell = cells.find((match) => match[1].localeCompare(targetColumn, undefined, { numeric: true }) > 0);
      if (!nextCell || nextCell.index === undefined) return `${opening}${body}${cell}${closing}`;
      return `${opening}${body.slice(0, nextCell.index)}${cell}${body.slice(nextCell.index)}${closing}`;
    });
  }

  async function populateOfficialTemplate({ templateBytes, data, mapping = FINAL_MAPPING }) {
    if (!global.JSZip) throw new Error("COC_EXCEL_ENGINE_UNAVAILABLE");
    const zip = await global.JSZip.loadAsync(templateBytes);
    const sheetPath = "xl/worksheets/sheet1.xml";
    const workbookPath = "xl/workbook.xml";
    const sheetFile = zip.file(sheetPath);
    const workbookFile = zip.file(workbookPath);
    const sheetXml = sheetFile ? await sheetFile.async("string") : "";
    const workbookXml = workbookFile ? await workbookFile.async("string") : "";
    if (!sheetXml || !workbookXml) throw new Error("COC_TEMPLATE_STRUCTURE_MISSING");

    let populatedSheetXml = sheetXml;
    populatedSheetXml = writeCell(populatedSheetXml, mapping.customerCell, data.customerName);
    populatedSheetXml = writeCell(populatedSheetXml, mapping.invoiceCell, data.invoiceNumber);
    populatedSheetXml = writeCell(populatedSheetXml, mapping.ifNumberCell, data.ifNumber);
    for (let row = mapping.detailRows.first; row <= mapping.detailRows.last; row += 1) {
      populatedSheetXml = writeCell(populatedSheetXml, `A${row}`, "");
      populatedSheetXml = writeCell(populatedSheetXml, `B${row}`, "");
      populatedSheetXml = writeCell(populatedSheetXml, `C${row}`, null);
    }
    const details = buildDetailRows(data, mapping);
    details.rows.forEach((row) => {
      populatedSheetXml = writeCell(populatedSheetXml, `A${row.rowNumber}`, row.a);
      populatedSheetXml = writeCell(populatedSheetXml, `B${row.rowNumber}`, row.b);
      populatedSheetXml = writeCell(populatedSheetXml, `C${row.rowNumber}`, row.c, { formula: row.formula });
    });
    Object.entries(OFFICIAL_TEMPLATE.blankFillStyles).forEach(([reference, styleId]) => {
      populatedSheetXml = ensureStyledBlankCell(populatedSheetXml, reference, styleId);
    });
    zip.file(sheetPath, populatedSheetXml);

    const populatedWorkbookXml = workbookXml.replace(/<calcPr\b([^>]*)\/?>(?:<\/calcPr>)?/, (_, attributes) => {
      const cleaned = String(attributes)
        .replace(/\s+calcMode="[^"]*"/g, "")
        .replace(/\s+fullCalcOnLoad="[^"]*"/g, "")
        .replace(/\s+forceFullCalc="[^"]*"/g, "")
        .replace(/\/\s*$/, "");
      return `<calcPr${cleaned} calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>`;
    });
    zip.file(workbookPath, populatedWorkbookXml);
    return zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
  }

  async function loadMasterTemplate(template = OFFICIAL_TEMPLATE) {
    const response = await fetch(template.url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`COC_TEMPLATE_LOAD_FAILED_${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async function saveGeneratedWorkbook({ fileName, bytes }) {
    const blob = new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    global.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function generateCompanyCoc(session, adapters = {}) {
    const mapping = adapters.mapping || global.atlasCocExcelMapping || FINAL_MAPPING;
    const readiness = mappingReadiness(mapping);
    if (!readiness.ready) throw new Error("COC_EXCEL_MAPPING_PENDING");
    const data = buildExportModel(session, adapters.core || global.AtlasCocCore);
    const loader = adapters.loadMasterTemplate || loadMasterTemplate;
    const populator = adapters.populateTemplateCopy || populateOfficialTemplate;
    const saver = adapters.saveGeneratedWorkbook || saveGeneratedWorkbook;
    const masterBytes = await bytesFrom(await loader(OFFICIAL_TEMPLATE));
    const masterHash = await sha256(masterBytes);
    if (masterHash !== OFFICIAL_TEMPLATE.sha256) throw new Error("COC_TEMPLATE_SIGNATURE_MISMATCH");
    const outputBytes = await bytesFrom(await populator({
      templateBytes: masterBytes.slice(),
      mapping,
      data,
      template: OFFICIAL_TEMPLATE,
    }));
    const fileName = outputFileName(data.invoiceNumber);
    await saver({ fileName, bytes: outputBytes, data });
    return Object.freeze({ fileName, data, templateHash: masterHash, bytes: outputBytes });
  }

  global.AtlasCocExcel = Object.freeze({
    OFFICIAL_TEMPLATE,
    FINAL_MAPPING,
    PENDING_MAPPING: FINAL_MAPPING,
    buildExportModel,
    buildDetailRows,
    mappingReadiness,
    outputFileName,
    populateOfficialTemplate,
    generateCompanyCoc,
  });
})(window);
