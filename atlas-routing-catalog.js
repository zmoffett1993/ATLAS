/* Read-only importer for the supplied product-specification workbook.
   Imported values stay in the routing session; the workbook is never changed. */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.atlasRoutingCatalog = api;
})(typeof window === "undefined" ? null : window, () => {
  "use strict";
  const normalizeHeader = (value) => String(value || "").trim().replace(/\s+/g, " ").toUpperCase();

  function fromRows(rows) {
    const headerIndex = rows.findIndex((row) => normalizeHeader(row[0]) === "MODEL NO.");
    if (headerIndex < 0) throw new Error("This workbook has no MODEL NO. header.");
    const headers = rows[headerIndex].map(normalizeHeader);
    const fields = { model: "MODEL NO.", caseQty: "CASE QTY", caseDimensions: "CASE DIMENSIONS", caseWeightLb: "WEIGHT", boxesPerPallet: "PER PALLET", palletDimensions: "PALLET DIMENSIONS" };
    const columns = Object.fromEntries(Object.entries(fields).map(([key, label]) => {
      const index = headers.indexOf(label);
      if (index < 0) throw new Error(`The workbook is missing ${label}.`);
      return [key, index];
    }));
    const catalog = [];
    rows.slice(headerIndex + 1).forEach((row, index) => {
      // Section headings have only a model-column value. Keep TBA product rows.
      if (!row[columns.model] || !Object.values(columns).some((column) => column !== columns.model && String(row[column] ?? "").trim())) return;
      catalog.push({
        ...Object.fromEntries(Object.entries(columns).map(([key, column]) => [key, String(row[column] ?? "").trim()])),
        sourceRow: headerIndex + index + 2,
      });
    });
    if (!catalog.length) throw new Error("No product specifications were found.");
    return catalog;
  }

  async function readWorkbook(file) {
    if (!window.JSZip) throw new Error("The workbook reader is unavailable. Refresh ATLAS and try again.");
    if (file.size > 10 * 1024 * 1024) throw new Error("Select a product workbook smaller than 10 MB.");
    const archive = await window.JSZip.loadAsync(await file.arrayBuffer());
    const parse = (text, name) => {
      const xml = new DOMParser().parseFromString(text.replace(/^\uFEFF/, ""), "application/xml");
      if (xml.getElementsByTagName("parsererror").length) throw new Error(`The workbook contains invalid XML in ${name}.`);
      return xml;
    };
    const read = async (name, optional = false) => {
      const entry = archive.file(name);
      if (!entry) {
        if (optional) return null;
        throw new Error(`The workbook is missing ${name}.`);
      }
      const text = await entry.async("string");
      if (text.length > 12_000_000) throw new Error("This workbook is too large to import in the browser.");
      return parse(text, name);
    };
    const [workbook, relationships, strings] = await Promise.all([
      read("xl/workbook.xml"), read("xl/_rels/workbook.xml.rels"), read("xl/sharedStrings.xml", true),
    ]);
    const sheets = [...workbook.getElementsByTagNameNS("*", "sheet")];
    const sheet = sheets.find((item) => item.getAttribute("name") === "Product Specifications") || (sheets.length === 1 ? sheets[0] : null);
    if (!sheet) throw new Error("Choose a workbook with a Product Specifications sheet.");
    const relationId = sheet.getAttribute("r:id") || sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const relation = [...relationships.getElementsByTagNameNS("*", "Relationship")].find((item) => item.getAttribute("Id") === relationId);
    if (!relation || relation.getAttribute("TargetMode") === "External") throw new Error("The worksheet reference is not local to the workbook.");
    const target = relation.getAttribute("Target") || "";
    const sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    if (sheetPath.includes("..") || !sheetPath.startsWith("xl/")) throw new Error("Unsupported worksheet path.");
    const sheetXml = await read(sheetPath);
    const shared = strings ? [...strings.getElementsByTagNameNS("*", "si")].map((item) => [...item.getElementsByTagNameNS("*", "t")].map((text) => text.textContent).join("")) : [];
    const rows = [...sheetXml.getElementsByTagNameNS("*", "row")].map((row) => {
      const values = [];
      for (const cell of row.getElementsByTagNameNS("*", "c")) {
        const letters = (cell.getAttribute("r") || "").match(/^[A-Z]+/)?.[0];
        if (!letters) continue;
        const column = [...letters].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) - 1;
        if (column > 100) continue;
        const value = cell.getElementsByTagNameNS("*", "v")[0]?.textContent || "";
        const type = cell.getAttribute("t");
        values[column] = type === "s" ? shared[Number(value)] || "" : type === "inlineStr" ? [...cell.getElementsByTagNameNS("*", "t")].map((text) => text.textContent).join("") : value;
      }
      return values;
    });
    return fromRows(rows);
  }
  return Object.freeze({ fromRows, readWorkbook });
});
