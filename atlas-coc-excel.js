(function (global) {
  "use strict";

  const OFFICIAL_TEMPLATE = Object.freeze({
    fileName: "NEW COC 2.xlsx",
    url: "private://coc-templates/NEW COC 2.xlsx",
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
      customerName: safeText(safe.customerName).toUpperCase(),
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
    [...data.pallets]
      .sort((left, right) => left.palletNumber - right.palletNumber)
      .forEach((pallet) => pallet.modelBlocks.forEach((block) => {
        rows.push({
          rowNumber: rowNumber++,
          type: "pallet",
          modelNumber: block.modelNumber,
          palletNumber: pallet.palletNumber,
          a: block.modelNumber,
          b: `PALLET ${pallet.palletNumber}`,
          c: null,
        });
        const firstLotRow = rowNumber;
        block.lots.forEach((lot) => {
          rows.push({
            rowNumber: rowNumber++,
            type: "lot",
            modelNumber: lot.model,
            palletNumber: pallet.palletNumber,
            cleanLot: lot.cleanLot,
            boxes: lot.boxes,
            caseQuantity: lot.caseQuantity,
            a: "",
            b: lot.cleanLot,
            c: lot.quantity,
          });
        });
        const lastLotRow = rowNumber - 1;
        rows.push({
          rowNumber: rowNumber++,
          type: "total",
          modelNumber: block.modelNumber,
          palletNumber: pallet.palletNumber,
          a: "",
          b: "TOTAL QTY",
          c: block.totalQuantity,
          formula: `SUM(C${firstLotRow}:C${lastLotRow})`,
        });
        rows.push({
          rowNumber: rowNumber++,
          type: "spacer",
          modelNumber: block.modelNumber,
          palletNumber: pallet.palletNumber,
          a: "",
          b: "",
          c: null,
        });
      }));
    const lastContentRow = rows.length
      ? rows[rows.length - 1].rowNumber
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

    // Totals include cached numeric values, so the workbook remains correct even
    // before Excel performs its normal formula recalculation.
    zip.file(workbookPath, workbookXml);
    return zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
  }

  function previewEscape(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function previewChildren(node, localName) {
    return Array.from(node?.children || []).filter((child) => child.localName === localName);
  }

  function previewDescendants(node, localName) {
    return Array.from(node?.getElementsByTagNameNS?.("*", localName) || []);
  }

  function previewCellPosition(reference) {
    const match = String(reference || "").match(/^([A-Z]+)(\d+)$/i);
    if (!match) return null;
    let column = 0;
    for (const character of match[1].toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
    return { column, row: Number(match[2]) };
  }

  function previewColumnName(number) {
    let value = Number(number), result = "";
    while (value > 0) { value -= 1; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
    return result;
  }

  function previewTint(hex, tint) {
    const clean = String(hex || "000000").replace(/^#/, "").slice(-6).padStart(6, "0");
    const amount = Number(tint || 0);
    const values = [0, 2, 4].map((offset) => Number.parseInt(clean.slice(offset, offset + 2), 16));
    const adjusted = values.map((channel) => Math.round(amount < 0 ? channel * (1 + amount) : channel + (255 - channel) * amount));
    return `#${adjusted.map((channel) => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, "0")).join("")}`;
  }

  function previewThemeColors(themeDocument) {
    const scheme = previewDescendants(themeDocument, "clrScheme")[0];
    const byName = {};
    Array.from(scheme?.children || []).forEach((entry) => {
      const color = Array.from(entry.children || [])[0];
      const raw = color?.getAttribute("val") || "000000";
      byName[entry.localName] = raw === "window" ? "FFFFFF" : raw === "windowText" ? "000000" : raw;
    });
    return [byName.lt1, byName.dk1, byName.lt2, byName.dk2, byName.accent1, byName.accent2, byName.accent3, byName.accent4, byName.accent5, byName.accent6, byName.hlink, byName.folHlink].map((value) => value || "000000");
  }

  function previewColor(node, themeColors, fallback = "000000") {
    if (!node) return `#${fallback}`;
    const rgb = node.getAttribute("rgb");
    if (rgb) return `#${rgb.slice(-6)}`;
    const theme = Number(node.getAttribute("theme"));
    const base = Number.isInteger(theme) ? themeColors[theme] : fallback;
    return previewTint(base, node.getAttribute("tint"));
  }

  function previewStyles(stylesDocument, themeColors) {
    const fonts = previewChildren(previewDescendants(stylesDocument, "fonts")[0], "font").map((font) => ({
      size: Number(previewDescendants(font, "sz")[0]?.getAttribute("val") || 11),
      bold: Boolean(previewDescendants(font, "b").length),
      italic: Boolean(previewDescendants(font, "i").length),
      color: previewColor(previewDescendants(font, "color")[0], themeColors),
      family: previewDescendants(font, "name")[0]?.getAttribute("val") || "Calibri",
    }));
    const fills = previewChildren(previewDescendants(stylesDocument, "fills")[0], "fill").map((fill) => {
      const pattern = previewDescendants(fill, "patternFill")[0];
      if (!pattern || pattern.getAttribute("patternType") !== "solid") return "transparent";
      return previewColor(previewDescendants(pattern, "fgColor")[0], themeColors, "FFFFFF");
    });
    const borders = previewChildren(previewDescendants(stylesDocument, "borders")[0], "border").map((border) => {
      const hasLine = ["left", "right", "top", "bottom"].some((side) => previewDescendants(border, side)[0]?.getAttribute("style"));
      return hasLine ? "1px solid #858585" : "0";
    });
    return previewChildren(previewDescendants(stylesDocument, "cellXfs")[0], "xf").map((xf) => {
      const font = fonts[Number(xf.getAttribute("fontId") || 0)] || fonts[0] || {};
      const alignment = previewDescendants(xf, "alignment")[0];
      return {
        fontSize: Number(font.size || 11), fontWeight: font.bold ? 700 : 400,
        fontStyle: font.italic ? "italic" : "normal", color: font.color || "#000000",
        fontFamily: font.family || "Calibri", background: fills[Number(xf.getAttribute("fillId") || 0)] || "transparent",
        border: borders[Number(xf.getAttribute("borderId") || 0)] || "0",
        align: alignment?.getAttribute("horizontal") || "left",
        vertical: alignment?.getAttribute("vertical") === "center" ? "middle" : alignment?.getAttribute("vertical") || "middle",
        wrap: alignment?.getAttribute("wrapText") === "1",
        numFmtId: Number(xf.getAttribute("numFmtId") || 0),
      };
    });
  }

  function previewStyleAttribute(style) {
    const pixels = Number(style.fontSize || 11) * 96 / 72;
    return [
      `font-family:${previewEscape(style.fontFamily)},Calibri,Arial,sans-serif`,
      `font-size:${pixels.toFixed(2)}px`,
      `font-weight:${style.fontWeight}`, `font-style:${style.fontStyle}`, `color:${style.color}`,
      `background:${style.background}`, `border:${style.border}`, `text-align:${style.align}`,
      `vertical-align:${style.vertical}`, `white-space:${style.wrap ? "pre-wrap" : "nowrap"}`,
    ].join(";");
  }

  const previewColumnPixels = (width) => Math.max(1, Math.floor(Number(width || 10) * 7 + 5));
  let workbookPreviewObserver = null;

  function sizeOfficialWorkbookPreview(frame) {
    const canvas = frame?.querySelector?.(".atlas-workbook-preview-canvas");
    const sheetWidth = Number(frame?.dataset?.sheetWidth || 0);
    const sheetHeight = Number(frame?.dataset?.sheetHeight || 0);
    if (!canvas || !sheetWidth || !sheetHeight) return;
    frame.style.maxWidth = `${sheetWidth + 2}px`;
    const availableWidth = Math.max(1, frame.clientWidth - 2);
    const scale = Math.min(1, availableWidth / sheetWidth);
    canvas.style.width = `${sheetWidth}px`;
    canvas.style.height = `${sheetHeight}px`;
    canvas.style.transform = `scale(${scale})`;
    frame.style.height = `${Math.ceil(sheetHeight * scale) + 2}px`;
    frame.style.setProperty("--atlas-workbook-scale", String(scale));
  }

  function fitOfficialWorkbookPreviews(root = global.document) {
    const frames = root?.querySelectorAll?.(".atlas-workbook-preview-frame[data-sheet-width]") || [];
    if (global.ResizeObserver && !workbookPreviewObserver) {
      workbookPreviewObserver = new global.ResizeObserver((entries) => entries.forEach((entry) => sizeOfficialWorkbookPreview(entry.target)));
    }
    frames.forEach((frame) => {
      sizeOfficialWorkbookPreview(frame);
      if (workbookPreviewObserver && frame.dataset.previewObserved !== "true") {
        frame.dataset.previewObserved = "true";
        workbookPreviewObserver.observe(frame);
      }
    });
  }

  /** Render the actual populated XLSX bytes as a fit-to-width, read-only sheet. */
  async function renderOfficialWorkbookPreview(workbook) {
    if (!global.JSZip || !global.DOMParser) throw new Error("COC_WORKBOOK_PREVIEW_UNAVAILABLE");
    const bytes = await bytesFrom(workbook);
    const zip = await global.JSZip.loadAsync(bytes);
    const paths = ["xl/worksheets/sheet1.xml", "xl/styles.xml", "xl/sharedStrings.xml", "xl/theme/theme1.xml"];
    const [sheetXml, stylesXml, sharedXml, themeXml] = await Promise.all(paths.map(async (path) => {
      const file = zip.file(path); return file ? file.async("string") : "";
    }));
    if (!sheetXml || !stylesXml) throw new Error("COC_WORKBOOK_PREVIEW_STRUCTURE_MISSING");
    const parser = new global.DOMParser();
    const sheet = parser.parseFromString(sheetXml, "application/xml");
    const stylesDocument = parser.parseFromString(stylesXml, "application/xml");
    const sharedDocument = parser.parseFromString(sharedXml || "<sst/>", "application/xml");
    const themeDocument = parser.parseFromString(themeXml || "<theme/>", "application/xml");
    const parseErrors = [sheet, stylesDocument, sharedDocument, themeDocument].flatMap((document) => previewDescendants(document, "parsererror"));
    if (parseErrors.length) throw new Error("COC_WORKBOOK_PREVIEW_XML_INVALID");

    const sharedStrings = previewDescendants(sharedDocument, "si").map((item) => previewDescendants(item, "t").map((text) => text.textContent || "").join(""));
    const styleList = previewStyles(stylesDocument, previewThemeColors(themeDocument));
    const cells = new Map();
    let lastValueRow = 6;
    previewDescendants(sheet, "c").forEach((cell) => {
      const reference = cell.getAttribute("r"), position = previewCellPosition(reference);
      if (!position) return;
      const type = cell.getAttribute("t") || "";
      const valueNode = previewDescendants(cell, "v")[0];
      let value = "";
      if (type === "s") value = sharedStrings[Number(valueNode?.textContent || 0)] || "";
      else if (type === "inlineStr") value = previewDescendants(cell, "t").map((text) => text.textContent || "").join("");
      else value = valueNode?.textContent || "";
      const styleIndex = Number(cell.getAttribute("s") || 0), style = styleList[styleIndex] || styleList[0] || {};
      if (value && !Number.isNaN(Number(value)) && [3, 4, 37, 38, 39, 40].includes(style.numFmtId)) value = Number(value).toLocaleString("en-US");
      if (String(value).trim()) lastValueRow = Math.max(lastValueRow, position.row);
      cells.set(reference, { value, style });
    });

    const mergeStarts = new Map(), covered = new Set();
    previewDescendants(sheet, "mergeCell").forEach((node) => {
      const [startRef, endRef] = String(node.getAttribute("ref") || "").split(":"), start = previewCellPosition(startRef), end = previewCellPosition(endRef || startRef);
      if (!start || !end) return;
      mergeStarts.set(startRef, { colSpan: end.column - start.column + 1, rowSpan: end.row - start.row + 1 });
      for (let row = start.row; row <= end.row; row += 1) for (let column = start.column; column <= end.column; column += 1) if (row !== start.row || column !== start.column) covered.add(`${previewColumnName(column)}${row}`);
    });
    const columns = [];
    previewDescendants(sheet, "col").forEach((column) => {
      const first = Number(column.getAttribute("min") || 1), last = Number(column.getAttribute("max") || first), width = Number(column.getAttribute("width") || 10);
      for (let index = first; index <= last; index += 1) columns[index - 1] = width;
    });
    const columnCount = Math.max(3, columns.length), widths = Array.from({ length: columnCount }, (_, index) => Number(columns[index] || 10));
    const pixelWidths = widths.map(previewColumnPixels), sheetWidth = pixelWidths.reduce((sum, value) => sum + value, 0);
    const defaultRowHeight = Number(previewDescendants(sheet, "sheetFormatPr")[0]?.getAttribute("defaultRowHeight") || 14.25);
    const rowHeights = new Map(previewDescendants(sheet, "row").map((row) => [Number(row.getAttribute("r")), Number(row.getAttribute("ht") || defaultRowHeight)]));
    const finalRow = Math.min(lastValueRow + 1, FINAL_MAPPING.detailRows.last);
    let body = "", sheetHeight = 0;
    for (let row = 1; row <= finalRow; row += 1) {
      const rowPixels = Number(rowHeights.get(row) || defaultRowHeight) * 96 / 72;
      sheetHeight += rowPixels;
      let rowMarkup = "";
      for (let column = 1; column <= columnCount; column += 1) {
        const reference = `${previewColumnName(column)}${row}`;
        if (covered.has(reference)) continue;
        const cell = cells.get(reference) || { value: "", style: styleList[0] || {} }, merge = mergeStarts.get(reference);
        const spans = `${merge?.colSpan > 1 ? ` colspan="${merge.colSpan}"` : ""}${merge?.rowSpan > 1 ? ` rowspan="${merge.rowSpan}"` : ""}`;
        rowMarkup += `<td${spans} style="${previewStyleAttribute(cell.style)}">${previewEscape(cell.value)}</td>`;
      }
      body += `<tr style="height:${rowPixels.toFixed(2)}px">${rowMarkup}</tr>`;
    }
    const columnsMarkup = pixelWidths.map((width) => `<col style="width:${width}px">`).join("");
    return `<section class="atlas-workbook-preview" aria-label="Read-only preview of the generated Official COC workbook"><div class="atlas-workbook-preview-badge">ACTUAL XLSX · READ ONLY</div><div class="atlas-workbook-preview-frame" data-sheet-width="${sheetWidth}" data-sheet-height="${sheetHeight.toFixed(2)}"><div class="atlas-workbook-preview-canvas"><table style="width:${sheetWidth}px"><colgroup>${columnsMarkup}</colgroup><tbody>${body}</tbody></table></div></div><p class="atlas-workbook-preview-zoom-note">Pinch to zoom for a closer look</p></section>`;
  }

  async function loadMasterTemplate(template = OFFICIAL_TEMPLATE) {
    if (!global.AtlasCocDelivery?.loadOfficialTemplate)
      throw new Error("COC_PRIVATE_TEMPLATE_SERVICE_REQUIRED");
    return global.AtlasCocDelivery.loadOfficialTemplate(template);
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
    renderOfficialWorkbookPreview,
    fitOfficialWorkbookPreviews,
    generateCompanyCoc,
  });
})(window);
