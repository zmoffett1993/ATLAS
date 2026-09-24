/* Reviewed details only: no photos, OCR text, credentials, or Google responses. */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.atlasRoutingStorage = api;
})(typeof window === "undefined" ? null : window, () => {
  "use strict";
  const BASE = "https://dwrrbpiprcmajfyronlf.supabase.co";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const fail = (message, code = "INVALID_DOCUMENT") => { const error = new Error(message); error.code = code; throw error; };
  function date(value) {
    if (!/^20\d\d-\d\d-\d\d$/.test(value || "") || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) fail("Choose a valid planning day.");
    return value;
  }
  function text(value, maximum, required = false) {
    if (typeof value !== "string" || value.length > maximum || (required && !value.trim())) fail("Review the saved order fields and their lengths.");
    return value;
  }
  function integer(value, minimum, maximum) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("Review the order quantities and planning settings.");
    return value;
  }
  function boolean(value) { if (typeof value !== "boolean") fail("Invalid planning option."); return value; }
  const fields = ["model", "caseQty", "caseDimensions", "caseWeightLb", "boxesPerPallet", "palletDimensions"];
  function references(value = []) {
    if (!Array.isArray(value) || value.length > 20) fail("Use at most 20 document numbers per order.");
    return [...new Set(value.map((v) => text(v, 80, true).trim().toUpperCase()))];
  }
  function deliveredDate(value = null) { return value == null || value === "" ? null : date(value); }
  function deliveryDetails(order) {
    const result = { dispatchedOn: deliveredDate(order.dispatchedOn), deliveredOn: deliveredDate(order.deliveredOn), deliveryException: text(order.deliveryException ?? "", 500) };
    if (result.dispatchedOn && result.deliveredOn && result.deliveredOn < result.dispatchedOn) fail("Delivery cannot be before the sent-out date.");
    return result;
  }
  function deliveryStatus(order, now = new Date()) {
    const details = deliveryDetails(order);
    if (details.deliveryException.trim()) return { label: "Delivery issue", date: null };
    if (details.deliveredOn) return { label: "Confirmed delivered", date: details.deliveredOn };
    const today = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const hour = Number(now.toLocaleTimeString("en-GB", { timeZone: "America/Los_Angeles", hour: "2-digit", hourCycle: "h23" }));
    if (details.dispatchedOn && (details.dispatchedOn < today || (details.dispatchedOn === today && hour >= 17))) return { label: "Assumed delivered", date: details.dispatchedOn };
    return { label: details.dispatchedOn ? "Out for delivery" : "Scheduled", date: null };
  }
  function searchFilters(input = {}) {
    const result = { query: text(input.query ?? "", 80).trim(), from: input.from ? date(input.from) : null,
      to: input.to ? date(input.to) : null, dateField: input.dateField ?? "planned", offset: integer(input.offset ?? 0, 0, 100000) };
    if (!["planned", "delivered"].includes(result.dateField) || (result.from && result.to && result.from > result.to)) fail("Choose a valid date range.");
    return result;
  }
  // Explicitly project allowed fields; never serialize the application state wholesale.
  function document(input) {
    if (![1, 2, 3].includes(input?.schemaVersion) || !Array.isArray(input.orders) || input.orders.length > 200 || !Array.isArray(input.catalog) || input.catalog.length > 2000) fail("This saved day has an unsupported format or is too large.");
    const day = date(input.date), ids = new Set(), numbers = new Set();
    const orders = input.orders.map((order) => {
      if (!UUID.test(order.id || "") || ids.has(order.id.toLowerCase())) fail("Every order needs a unique ID.");
      ids.add(order.id.toLowerCase());
      const orderNumber = text(order.orderNumber, 80, true).trim();
      if (numbers.has(orderNumber.toUpperCase())) fail("This order number is already on the day.");
      numbers.add(orderNumber.toUpperCase());
      if (!Array.isArray(order.lines) || !order.lines.length || order.lines.length > 200) fail("Each order needs between 1 and 200 SKU lines.");
      return { id: order.id, orderNumber, ...(input.schemaVersion >= 2 ? { invoiceNumbers: references(order.invoiceNumbers), fulfillmentNumbers: references(order.fulfillmentNumbers), ...deliveryDetails(order) } : {}), customer: text(order.customer, 160, true), address: text(order.address, 300, true), city: text(order.city, 100, true),
        timeWindow: text(order.timeWindow, 100), notes: text(order.notes, 1000), serviceMinutes: integer(order.serviceMinutes, 1, 480), checkOnDelivery: boolean(order.checkOnDelivery),
        lines: order.lines.map((line) => ({ sku: text(line.sku, 100, true), caseQty: integer(line.caseQty, 1, 1000000),
          itemQty: line.itemQty == null || line.itemQty === "" ? null : integer(Number(line.itemQty), 1, 1000000000) })) };
    });
    const catalog = input.catalog.map((row) => ({ ...Object.fromEntries(fields.map((key) => [key, text(row[key], 200, key === "model")])), sourceRow: integer(row.sourceRow, 1, 1000000) }));
    const s = input.settings || {};
    if (!/^(11|12|13):[0-5]\d$/.test(s.lunch || "") || s.lunch > "13:00") fail("Lunch must start between 11 AM and 1 PM.");
    const settings = { truckPalletTarget: integer(s.truckPalletTarget, 1, 100), dailyTripTarget: integer(s.dailyTripTarget, 1, 100), reloadMinutes: integer(s.reloadMinutes, 0, 120), lunch: s.lunch, preserveOrder: boolean(s.preserveOrder) };
    const assignments = {}, vanConfirmed = {};
    for (const [key, value] of Object.entries(input.assignments || {})) {
      if (!/^(0|[1-9]\d{0,3})$/.test(key) || !/^(Bubba:(truck|van1|van2)|Achmad:van[12])$/.test(value)) fail("Review driver and vehicle assignments.");
      assignments[key] = value;
    }
    for (const [key, value] of Object.entries(input.vanConfirmed || {})) {
      if (!/^(0|[1-9]\d{0,3})$/.test(key)) fail("Invalid van review.");
      vanConfirmed[key] = boolean(value);
    }
    const result = { schemaVersion: input.schemaVersion, date: day, orders, catalog, settings, assignments, vanConfirmed };
    if (input.schemaVersion === 3) {
      if (!Array.isArray(input.lockedTrips) || input.lockedTrips.length > 200) fail("Review the saved sent-out trips.");
      const packed = new Map(), completed = new Set();
      result.lockedTrips = input.lockedTrips.map((trip) => {
        if (!Array.isArray(trip.shipments) || !trip.shipments.length || trip.shipments.length > 200 || !Array.isArray(trip.completedOrderIds)) fail("Review the saved sent-out trip.");
        const shipments = trip.shipments.map((shipment) => {
          const order = orders.find((item) => item.id.toLowerCase() === String(shipment.orderId).toLowerCase());
          if (!order || !Array.isArray(shipment.boxAllocation) || !shipment.boxAllocation.length || shipment.boxAllocation.length > 200) fail("Review sent-out order and box allocations.");
          const boxAllocation = shipment.boxAllocation.map((line) => {
            const sku = text(line.sku, 100, true), boxes = integer(line.boxes, 1, 1000000);
            if (!order.lines.some((item) => item.sku === sku)) fail("Sent-out SKU does not belong to this order.");
            const key = `${order.id.toLowerCase()}\u0000${sku}`;
            packed.set(key, (packed.get(key) || 0) + boxes);
            if (packed.get(key) > order.lines.filter((item) => item.sku === sku).reduce((sum, item) => sum + item.caseQty, 0)) fail("Sent-out boxes exceed the saved order.");
            return { sku, boxes };
          });
          return { orderId: order.id, palletSpaces: integer(shipment.palletSpaces, 1, 100), boxAllocation };
        });
        const palletSpaces = integer(trip.palletSpaces, 1, 100);
        if (shipments.reduce((sum, shipment) => sum + shipment.palletSpaces, 0) !== palletSpaces) fail("Sent-out pallet counts do not match this trip.");
        const completedOrderIds = trip.completedOrderIds.map((id) => {
          const match = shipments.find((shipment) => shipment.orderId.toLowerCase() === String(id).toLowerCase());
          if (!match || completed.has(match.orderId.toLowerCase())) fail("Review completed orders on sent-out trips.");
          completed.add(match.orderId.toLowerCase()); return match.orderId;
        });
        return { shipments, palletSpaces, assignment: text(trip.assignment, 20, true), vanConfirmed: boolean(trip.vanConfirmed), sentOn: date(trip.sentOn), completedOrderIds };
      });
      result.lockedTrips.forEach((trip, index) => {
        if (!/^(Bubba:(truck|van1|van2)|Achmad:van[12])$/.test(trip.assignment) || assignments[index] !== trip.assignment || (vanConfirmed[index] || false) !== trip.vanConfirmed) fail("Sent-out assignment changed.");
        if (trip.completedOrderIds.some((id) => !orders.find((order) => order.id === id)?.dispatchedOn)) fail("Completed sent-out order has no dispatch date.");
      });
      for (const id of completed) {
        const order = orders.find((item) => item.id.toLowerCase() === id);
        for (const line of order.lines) {
          const key = `${id}\u0000${line.sku}`;
          if (packed.get(key) !== order.lines.filter((item) => item.sku === line.sku).reduce((sum, item) => sum + item.caseQty, 0)) fail("Completed order boxes are not all sent out.");
        }
      }
    }
    if (Object.hasOwn(input, "nextLoadPriority")) {
      if (input.schemaVersion !== 3 || !Array.isArray(input.nextLoadPriority) || input.nextLoadPriority.length > 200) fail("Review next-load priorities.");
      const seen = new Set(), locked = new Set((result.lockedTrips || []).flatMap(t => t.shipments.map(s => s.orderId.toLowerCase())));
      result.nextLoadPriority = input.nextLoadPriority.map(id => {
        const order = orders.find(o => o.id === id);
        if (!order || seen.has(id) || locked.has(id.toLowerCase()) || order.dispatchedOn || order.deliveredOn) fail("Only unsent orders on this day can be prioritized.");
        seen.add(id); return id;
      });
    }
    if (new TextEncoder().encode(JSON.stringify(result)).length > 900000) fail("This day is too large to save. Contact the ATLAS administrator.");
    return result;
  }
  function createClient({ enabled = false, key, getSession, getValidSession, fetchImpl = fetch }) {
    let epoch = 0;
    const controllers = new Set();
    const reset = () => { epoch++; controllers.forEach((controller) => controller.abort()); controllers.clear(); };
    async function request(action, day, revision, input) {
      if (!enabled) fail("Shared saving is awaiting database approval and connection.", "DISABLED");
      const filters = action === "search" ? searchFilters(input) : null;
      if (!filters) date(day);
      const currentEpoch = epoch, owner = getSession()?.user?.id;
      const current = () => epoch === currentEpoch && owner && getSession()?.user?.id === owner;
      if (!UUID.test(owner || "")) fail("Sign into ATLAS again.", "SESSION_CHANGED");
      const session = await getValidSession();
      if (!current() || session?.user?.id !== owner || !session.access_token) fail("The ATLAS account changed. Reopen routing.", "SESSION_CHANGED");
      const payload = filters ? { p_warehouse: "CA", p_query: filters.query, p_from: filters.from, p_to: filters.to, p_date_field: filters.dateField, p_offset: filters.offset } : { p_warehouse: "CA", p_day: day };
      if (action === "scanner_upload") { const seed=document(input.seed); const normalized=document({...seed,orders:[input.order]}).orders[0]; payload.p_order=normalized; payload.p_seed=seed; payload.p_metadata=input.metadata; }
      if (action === "save") { payload.p_expected_revision = integer(revision, 0, 2147483646); payload.p_document = document(input); if (payload.p_document.date !== day) fail("The planning day changed."); }
      const controller = new AbortController(); controllers.add(controller);
      try {
        const response = await fetchImpl(`${BASE}/rest/v1/rpc/atlas_routing_${action.startsWith("scanner_") ? action : "preview_"+action}`, { method: "POST", cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
          headers: { apikey: key, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if (!current()) fail("The ATLAS account changed. Reopen routing.", "SESSION_CHANGED");
        const reader = response.body?.getReader(); let size = 0; const chunks = [];
        if (!reader) fail("The saved-day response is unavailable.", "UNAVAILABLE");
        try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 1200000) { await reader.cancel(); fail("The saved-day response is too large.", "UNAVAILABLE"); } chunks.push(value); } }
        finally { reader.releaseLock(); }
        let result;
        try { const bytes = new Uint8Array(size); let offset = 0; chunks.forEach((chunk) => { bytes.set(chunk, offset); offset += chunk.length; }); result = JSON.parse(new TextDecoder().decode(bytes)); }
        catch { fail("The saved-day response could not be read.", "UNAVAILABLE"); }
        if (!current()) fail("The ATLAS account changed. Reopen routing.", "SESSION_CHANGED");
        if (!response.ok) {
          if (result.code === "40001") fail("Someone saved this day after you opened it. Your changes are still here. Review the saved version before replacing anything.", "CONFLICT");
          if (response.status === 401 || result.code === "42501") fail("This account does not currently have permission to save or open this CA preview day.", "ACCESS_DENIED");
          if (result.code === "PGRST202") fail("Shared saving is not connected yet.", "DISABLED");
          if (result.code === "0A000") fail("This saved day needs the newer routing version. Refresh before editing it.", "UNAVAILABLE");
          fail("The day could not be saved or opened. Your changes remain here; no automatic retry was made.", "UNAVAILABLE");
        }
        if (action === "scanner_retry") { if(typeof result!=="boolean") fail("Unexpected scanner response.","UNAVAILABLE"); return result; }
        if (action === "scanner_status") { if(typeof result.enabled!=="boolean") fail("Unexpected scanner response.","UNAVAILABLE"); return result; }
        if (filters) {
          if (result.warehouse !== "CA" || !Array.isArray(result.matches) || result.matches.length > 50 || typeof result.hasMore !== "boolean") fail("Unexpected search response.", "UNAVAILABLE");
          const matches = result.matches.map((row) => {
            if (!UUID.test(row.orderId || "")) fail("Invalid search result.", "UNAVAILABLE");
            return { date: date(row.date), orderId: row.orderId, orderNumber: text(row.orderNumber, 80, true),
              customer: text(row.customer, 160, true), city: text(row.city, 100, true), invoiceNumbers: references(row.invoiceNumbers),
              fulfillmentNumbers: references(row.fulfillmentNumbers), ...deliveryDetails(row) };
          });
          return { warehouse: "CA", matches, hasMore: result.hasMore };
        }
        if (result.warehouse !== "CA" || result.date !== day || !Number.isSafeInteger(result.revision) || result.revision < 0 || typeof result.canEdit !== "boolean") fail("Unexpected saved-day response.", "UNAVAILABLE");
        if ((result.revision === 0) !== (result.document === null)) fail("Unexpected saved-day version.", "UNAVAILABLE");
        if (action === "save" && result.revision !== revision + 1) fail("Unexpected saved-day version.", "UNAVAILABLE");
        const saved = result.document === null ? null : document(result.document);
        if (saved && saved.date !== day) fail("Unexpected saved-day date.", "UNAVAILABLE");
        return { ...result, document: saved };
      } catch (error) {
        if (!current()) fail("The ATLAS account changed. Reopen routing.", "SESSION_CHANGED");
        if (error.code && ["CONFLICT", "ACCESS_DENIED", "DISABLED", "UNAVAILABLE", "INVALID_DOCUMENT"].includes(error.code)) throw error;
        fail(action === "save" ? "The save could not be confirmed. Keep this tab open and check the saved version before retrying." : "The saved day could not be reached. Your changes remain here.", "UNAVAILABLE");
      } finally { controllers.delete(controller); }
    }
    return Object.freeze({ enabled, reset, scannerRetry: day => request("scanner_retry",day), scannerStatus: day => request("scanner_status",day), upload: (day,order,metadata,seed) => request("scanner_upload",day,null,{order,metadata,seed}), load: (day) => request("load", day), save: (day, revision, value) => request("save", day, revision, value), search: (filters) => request("search", null, null, filters) });
  }
  return Object.freeze({ document, date, references, deliveredDate, deliveryDetails, deliveryStatus, searchFilters, createClient });
});
