/* POD rules only. Presentation validation does not grant document access. */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.atlasRoutingPodCore = api;
})(typeof window === "undefined" ? null : window, () => {
  "use strict";
  const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const qualityCodes = Object.freeze(["blur", "glare", "dark", "small_document", "clipped", "low_resolution"]);

  function salesOrderNumber(value) {
    if (typeof value !== "string" || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) {
      fail("INVALID_SALES_ORDER", "This delivery is missing a valid Sales Order. Contact a supervisor before submitting the POD.");
    }
    const match = /^(?:SO(?:[- ]US)?[- ])?([0-9]{1,20})$/.exec(value.trim().toUpperCase().replace(/ +/g, " "));
    if (!match) fail("INVALID_SALES_ORDER", "This delivery is missing a valid Sales Order. Contact a supervisor before submitting the POD.");
    return match[1]; // Preserve leading zeroes; never coerce a document number to Number.
  }

  function naming(salesOrder, shipmentNumber = 1, shipmentTotal = 1, isTest = false) {
    if (!Number.isSafeInteger(shipmentNumber) || !Number.isSafeInteger(shipmentTotal) ||
        shipmentNumber < 1 || shipmentTotal < shipmentNumber) {
      fail("INVALID_SHIPMENT", "The shipment allocation needs supervisor review before submitting the POD.");
    }
    const number = isTest === true && /^SO-TEST-[0-9]{1,20}$/.test(salesOrder) ? salesOrder.slice(3) : salesOrderNumber(salesOrder);
    const basename = `POD-SO-${number}${shipmentTotal > 1 ? `-SHIPMENT-${shipmentNumber}-OF-${shipmentTotal}` : ""}`;
    return Object.freeze({ salesOrderNumber: number, basename, filename: `${basename}.pdf`, subject: basename,
      shipmentLabel: `Shipment ${shipmentNumber} of ${shipmentTotal}` });
  }

  function submissionId(value) {
    if (typeof value !== "string" || !UUID.test(value)) fail("INVALID_SUBMISSION_ID", "The saved POD submission identifier is invalid.");
    return value.toLowerCase();
  }

  function qualityReview(codes, overridden = false) {
    if (!Array.isArray(codes) || codes.some(code => !qualityCodes.includes(code)) || typeof overridden !== "boolean") {
      fail("INVALID_QUALITY_REVIEW", "Review the document quality warnings.");
    }
    const warnings = [...new Set(codes)];
    return Object.freeze({ warnings: Object.freeze(warnings), overrideUsed: warnings.length > 0 && overridden,
      needsReview: warnings.length > 0 && !overridden });
  }

  // Only call with server-confirmed receipt/email fields. A queued client request is not receipt.
  function status({ delivery = "en_route", queue = "none", serverReceived = false, email = "none", exceptionApproved = false } = {}) {
    if (!["scheduled", "en_route", "assumed", "delivered"].includes(delivery) ||
        !["none", "draft", "queued_offline", "uploading", "requires_attention"].includes(queue) ||
        !["none", "queued", "accepted", "delivered", "bounced", "failed"].includes(email) ||
        typeof serverReceived !== "boolean" || typeof exceptionApproved !== "boolean") fail("INVALID_STATUS", "Unknown POD status.");
    if (!serverReceived && email !== "none") fail("INVALID_STATUS", "Email status requires a server-received POD.");
    const emailLabel = { none: "Not sent", queued: "Pending", accepted: "Sent", delivered: "Delivered", bounced: "Bounced", failed: "Not sent" }[email];
    let label, tone = "neutral";
    if (serverReceived) {
      label = email === "failed" || email === "bounced" ? "POD SAVED — EMAIL NOT SENT"
        : delivery === "delivered" ? "DELIVERY COMPLETE — POD RECEIVED ✓" : "POD RECEIVED ✓";
      tone = email === "failed" || email === "bounced" ? "warning" : "success";
    } else if (queue === "queued_offline") { label = "POD SAVED — WAITING FOR CONNECTION"; tone = "warning"; }
    else if (queue === "uploading") { label = "POD UPLOADING"; tone = "info"; }
    else if (queue === "requires_attention") { label = "SAVED POD NEEDS ATTENTION"; tone = "warning"; }
    else if (exceptionApproved) { label = "POD EXCEPTION APPROVED"; tone = "warning"; }
    else if (delivery === "delivered") { label = "DELIVERED — POD PENDING"; tone = "warning"; }
    else if (delivery === "assumed") { label = "ASSUMED DELIVERED — POD PENDING"; tone = "warning"; }
    else label = delivery === "scheduled" ? "SCHEDULED" : "EN ROUTE";
    return Object.freeze({ label, tone, emailLabel, documentationComplete: serverReceived || exceptionApproved,
      fullyClosed: delivery === "delivered" && (serverReceived || exceptionApproved) });
  }

  function retryDelay(attempt, random = Math.random) {
    if (!Number.isSafeInteger(attempt) || attempt < 0) fail("INVALID_RETRY", "Invalid retry attempt.");
    const jitter = random();
    if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1) fail("INVALID_RETRY", "Invalid retry jitter.");
    return Math.round(Math.min(300000, 2000 * 2 ** Math.min(attempt, 8)) * (0.75 + jitter * 0.25));
  }
  return Object.freeze({ salesOrderNumber, naming, submissionId, qualityCodes, qualityReview, status, retryDelay });
});
