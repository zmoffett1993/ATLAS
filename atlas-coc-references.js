(function (global) {
  "use strict";

  const KIND = Object.freeze({
    invoice: Object.freeze({ prefix: "INV-US", tokens: ["INVOICE", "INV"], regional: true }),
    if: Object.freeze({ prefix: "IF", tokens: ["IF"], regional: false }),
    salesOrder: Object.freeze({ prefix: "SO-US", tokens: ["SALES ORDER", "SALESORDER", "SO"], regional: true }),
  });
  const SEPARATOR = "[\\s._:#/\\-]";
  const normalizeDashes = (value) => String(value ?? "").replace(/[‐‑‒–—−]/g, "-");
  const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s*");

  function removeLeadingToken(value, token) {
    const tokenPattern = escapePattern(token);
    const optionalLabel = `(?:${SEPARATOR}+(?:NO|NUMBER))?`;
    const boundary = `(?:${SEPARATOR}+|(?=\\d)|$)`;
    return value.replace(new RegExp(`^${tokenPattern}${optionalLabel}${boundary}`, "i"), "");
  }

  function referenceBody(kind, value) {
    const config = KIND[kind];
    if (!config) return normalizeDashes(value).trim().toUpperCase();
    let result = normalizeDashes(value).trim().toUpperCase();
    for (let pass = 0; pass < 10 && result; pass += 1) {
      const before = result;
      for (const token of config.tokens) result = removeLeadingToken(result, token);
      if (config.regional) result = removeLeadingToken(result, "US");
      result = result.replace(new RegExp(`^${SEPARATOR}+`), "");
      if (result === before) break;
    }
    return result
      .replace(new RegExp(`${SEPARATOR}+`, "g"), "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 100);
  }

  function normalize(kind, value) {
    const config = KIND[kind];
    const body = referenceBody(kind, value);
    if (!body) return "";
    return config ? `${config.prefix}-${body}`.slice(0, 100) : body;
  }

  function normalizeSnapshot(snapshot) {
    const source = snapshot && typeof snapshot === "object" ? snapshot : {};
    return {
      ...source,
      invoiceNumber: normalize("invoice", source.invoiceNumber || source.orderNumber),
      ifNumber: normalize("if", source.ifNumber),
      salesOrderNumber: normalize("salesOrder", source.salesOrderNumber),
    };
  }

  global.AtlasCocReferences = Object.freeze({
    normalize,
    referenceBody,
    normalizeInvoice: (value) => normalize("invoice", value),
    normalizeIf: (value) => normalize("if", value),
    normalizeSalesOrder: (value) => normalize("salesOrder", value),
    normalizeSnapshot,
  });
})(window);
