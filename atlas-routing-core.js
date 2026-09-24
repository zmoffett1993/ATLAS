/* Delivery planning calculations. Catalog rows are supplied by an authorized
   private source; this file does not contain the product specification catalog. */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.atlasRoutingCore = api;
})(typeof window === "undefined" ? null : window, () => {
  "use strict";

  const BOX_TRUCK_PALLET_SPACES = 12;
  const PALLET_JACK_SPACES = 1;
  const USABLE_TRUCK_SPACES = BOX_TRUCK_PALLET_SPACES - PALLET_JACK_SPACES;
  const VAN = Object.freeze({
    lengthIn: 120,
    heightIn: 76.9,
    widthIn: 70.2,
    wheelWellWidthIn: 54.3,
    volumeFt3: 323.1,
    planningFraction: 0.8,
  });
  const DRIVERS = Object.freeze({
    Bubba: Object.freeze({ shiftStartMinutes: 6 * 60, shiftEndMinutes: 15 * 60, lunchMinutes: 60 }),
    Achmad: Object.freeze({ shiftStartMinutes: 8 * 60, shiftEndMinutes: 17 * 60, lunchMinutes: 60 }),
  });
  const hasCheckOnDelivery = (text) => /\bCHECK\s+ON\s+DELIVERY\b/i.test(String(text || ""));

  function intakeDeliveryDay(selectedDay, now = new Date(), sameDayException = false) {
    const selected = new Date(`${selectedDay}T12:00:00Z`);
    if (!/^20\d\d-\d\d-\d\d$/.test(selectedDay || "") || !Number.isFinite(selected.getTime()) || selected.toISOString().slice(0, 10) !== selectedDay || !Number.isFinite(now.getTime())) {
      throw new Error("Choose a valid delivery day.");
    }
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now).map(part => [part.type, part.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const first = new Date(`${today}T12:00:00Z`);
    const cutoffReached = Number(parts.hour) >= 12;
    const exceptionAllowed = selectedDay === today && cutoffReached && first.getUTCDay() > 0 && first.getUTCDay() < 6;
    if (cutoffReached && !(sameDayException && exceptionAllowed)) first.setUTCDate(first.getUTCDate() + 1);
    const result = selected > first ? selected : first;
    while (result.getUTCDay() === 0 || result.getUTCDay() === 6) result.setUTCDate(result.getUTCDate() + 1);
    return { date: result.toISOString().slice(0, 10), today, cutoffReached, exceptionAllowed };
  }

  const cleanModel = (value) => String(value || "")
    .replace(/\s*\((?:NEW|NEW\s+[^)]*)\)\s*$/i, "")
    .trim()
    .toUpperCase();
  const isNew = (value) => /\(NEW(?:\s+[^)]*)?\)\s*$/i.test(String(value || ""));
  const availableNumber = (value) => {
    if (value == null || String(value).trim().toUpperCase() === "TBA") return null;
    const number = Number(String(value).replace(/,/g, "").replace(/\s*(?:LB|LBS)$/i, ""));
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  const caseDimensions = (value) => {
    const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)$/i);
    const dimensions = match ? match.slice(1).map(Number) : null;
    return dimensions?.every((size) => size > 0) ? dimensions : null;
  };
  const specFields = ["caseQty", "caseDimensions", "caseWeightLb", "boxesPerPallet", "palletDimensions"];

  function selectSpecification(rows, sku) {
    const requested = cleanModel(sku);
    const exact = rows.filter((row) => cleanModel(row.model) === requested);
    // A four-digit suffix or the documented BK color is ignored only when the un-suffixed
    // shape-and-size model exists in the catalog. Exact models always win.
    const base = requested.replace(/-(?:\d{4}|BK)$/, "");
    const candidates = exact.length ? exact :
      (base !== requested ? rows.filter((row) => cleanModel(row.model) === base) : []);
    if (!candidates.length) return { status: "missing", model: requested };
    const newRows = candidates.filter((row) => isNew(row.model));
    const selected = newRows.length ? newRows : candidates;
    const merged = { ...selected[0] };
    for (const field of specFields) {
      const values = selected.map((row) => field.includes("Dimensions") ? caseDimensions(row[field])?.join("X") : availableNumber(row[field])).filter((value) => value != null);
      if (new Set(values).size > 1) return { status: "conflict", model: cleanModel(selected[0].model) };
      merged[field] = values[0] ?? null;
    }
    return {
      status: "found",
      model: cleanModel(selected[0].model),
      row: merged,
      colorSuffixIgnored: !exact.length,
      newVersion: Boolean(newRows.length),
    };
  }

  function analyzeOrder(order, catalog) {
    const lines = [];
    const issues = [];
    const palletGroups = new Map();
    let palletsComplete = true;
    let boxVolumeIn3 = 0;
    let volumeComplete = true;
    if (!order.lines?.length) {
      issues.push("Add at least one SKU and case quantity");
      palletsComplete = volumeComplete = false;
    }
    for (const input of order.lines || []) {
      const boxes = availableNumber(input.caseQty);
      const itemQty = availableNumber(input.itemQty);
      const match = selectSpecification(catalog, input.sku);
      const line = { sku: String(input.sku || ""), boxes, match };
      const validBoxes = Number.isSafeInteger(boxes) && boxes > 0;
      if (!validBoxes) {
        issues.push(`${line.sku}: case quantity needs review`);
        palletsComplete = volumeComplete = false;
      }
      if (match.status !== "found") {
        issues.push(`${line.sku}: specification ${match.status}`);
        palletsComplete = volumeComplete = false;
      } else {
        const unitsPerCase = availableNumber(match.row.caseQty);
        const boxesPerPallet = availableNumber(match.row.boxesPerPallet);
        const dimensions = caseDimensions(match.row.caseDimensions);
        if (validBoxes && itemQty && unitsPerCase && boxes * unitsPerCase !== itemQty) {
          issues.push(`${line.sku}: item quantity does not match case quantity`);
        }
        if (validBoxes && Number.isSafeInteger(boxesPerPallet)) {
          const group = palletGroups.get(match.model) || { boxes: 0, boxesPerPallet };
          group.boxes += boxes;
          palletGroups.set(match.model, group);
        } else {
          palletsComplete = false;
          issues.push(`${line.sku}: pallet count needs warehouse review`);
        }
        const palletDimensions = caseDimensions(match.row.palletDimensions);
        const inconsistentVolume = dimensions && palletDimensions && boxesPerPallet &&
          dimensions.reduce((a, b) => a * b, 1) * boxesPerPallet > palletDimensions.reduce((a, b) => a * b, 1);
        if (validBoxes && dimensions && !inconsistentVolume) {
          line.caseDimensionsIn = dimensions;
          boxVolumeIn3 += boxes * dimensions[0] * dimensions[1] * dimensions[2];
        } else {
          volumeComplete = false;
          issues.push(`${line.sku}: ${inconsistentVolume ? "case dimensions conflict with the pallet dimensions" : "van fit needs warehouse review"}`);
        }
      }
      lines.push(line);
    }
    return {
      id: order.id,
      customer: String(order.customer || ""),
      lines,
      // Combine repeated lines of the same model within this order, then round
      // each model separately. No partial pallet is shared with another order.
      palletSpaces: palletsComplete ? [...palletGroups.values()].reduce((total, group) => total + Math.ceil(group.boxes / group.boxesPerPallet), 0) : null,
      boxVolumeIn3: volumeComplete ? boxVolumeIn3 : null,
      issues,
    };
  }

  function assessVanLoad(orders) {
    if (!orders.length) return { status: "empty", percent: null, reason: "No orders selected" };
    const missingDimensions = orders.some((order) => order.boxVolumeIn3 == null);
    const vanDimensions = [VAN.lengthIn, VAN.widthIn, VAN.heightIn].sort((a, b) => a - b);
    const oversizedCase = orders.some((order) => order.lines?.some((line) => {
      if (!line.caseDimensionsIn) return false;
      const dimensions = [...line.caseDimensionsIn].sort((a, b) => a - b);
      return dimensions.some((size, index) => size > vanDimensions[index]);
    }));
    if (oversizedCase) {
      return { status: "does-not-fit", percent: null, reason: "A case exceeds the van interior" };
    }
    const volumeIn3 = orders.reduce((sum, order) => sum + (order.boxVolumeIn3 ??
      (order.lines || []).reduce((known, line) => known + (line.caseDimensionsIn && Number.isSafeInteger(line.boxes) ? line.boxes * line.caseDimensionsIn.reduce((a, b) => a * b, 1) : 0), 0)), 0);
    const percent = Math.ceil(volumeIn3 / (VAN.volumeFt3 * 1728) * 100);
    if (missingDimensions) {
      if (percent > 100) return { status: "does-not-fit", percent: null, reason: "Known boxes already exceed published cargo volume" };
      return { status: "warehouse-check", percent: null, reason: "Missing case dimensions" };
    }
    if (percent > 100) return { status: "does-not-fit", percent, reason: "Exceeds published cargo volume" };
    if (percent > VAN.planningFraction * 100) {
      return { status: "warehouse-check", percent, reason: "Above 80% planning target" };
    }
    const packing = packVanColumns(orders);
    return packing
      ? { status: "fits-estimate", percent: null, reason: "Upright box stacks fit the conservative space between the wheel wells" }
      : { status: "warehouse-check", percent: null, reason: "A conservative box arrangement could not be confirmed" };
  }

  function assessVanShipments(shipments, catalog) {
    const incomplete = { status: "warehouse-check", percent: null, reason: "Confirm the boxes assigned to each shipment", allocationComplete: false };
    if (!shipments?.length) return incomplete;
    const allocated = [];
    for (const shipment of shipments) {
      if (!Array.isArray(shipment.boxAllocation) || !shipment.boxAllocation.length || shipment.boxAllocation.some((line) =>
        typeof line.sku !== "string" || !line.sku.trim() || !Number.isSafeInteger(line.boxes) || line.boxes < 1)) return incomplete;
      const order = analyzeOrder({ id: shipment.orderId, lines: shipment.boxAllocation.map((line) => ({ sku: line.sku, caseQty: line.boxes })) }, catalog);
      if (order.palletSpaces == null || order.palletSpaces !== shipment.palletSpaces) return incomplete;
      allocated.push(order);
    }
    return { ...assessVanLoad(allocated), allocationComplete: true };
  }

  function resolveVanAssignment(assignment, shipments, catalog) {
    if (!/^(Bubba|Achmad):van[12]$/.test(assignment)) return { assignment, switched: false, fit: null };
    const fit = assessVanShipments(shipments, catalog);
    return { assignment: fit.status === "does-not-fit" ? "Bubba:truck" : assignment, switched: fit.status === "does-not-fit", fit };
  }

  function packVanColumns(orders) {
    const columns = [];
    for (const order of orders) {
      if (!order.lines?.length) return false;
      for (const line of order.lines) {
        if (!line.caseDimensionsIn || !Number.isSafeInteger(line.boxes) || line.boxes <= 0) return false;
        const [length, width, height] = line.caseDimensionsIn;
        const stack = Math.floor(VAN.heightIn / height);
        if (!stack) return false;
        const count = Math.ceil(line.boxes / stack);
        if (columns.length + count > 2000) return false;
        for (let index = 0; index < count; index++) columns.push({ length, width });
      }
    }
    // Keep cases upright. Each column contains one SKU, so a short box never
    // supports a floating layer. The wheel-well width is used at every height;
    // unused side space can only improve the actual result.
    columns.sort((a, b) => b.length * b.width - a.length * a.width || Math.max(b.length, b.width) - Math.max(a.length, a.width));
    let free = [{ x: 0, y: 0, width: VAN.lengthIn, height: VAN.wheelWellWidthIn }];
    for (const column of columns) {
      let best = null;
      for (const rectangle of free) {
        for (const [width, height] of [[column.length, column.width], [column.width, column.length]]) {
          if (width > rectangle.width || height > rectangle.height) continue;
          const waste = rectangle.width * rectangle.height - width * height;
          if (!best || waste < best.waste) best = { x: rectangle.x, y: rectangle.y, width, height, waste };
        }
      }
      if (!best) return false;
      const split = [];
      for (const rectangle of free) {
        const right = rectangle.x + rectangle.width;
        const bottom = rectangle.y + rectangle.height;
        const placedRight = best.x + best.width;
        const placedBottom = best.y + best.height;
        if (best.x >= right || placedRight <= rectangle.x || best.y >= bottom || placedBottom <= rectangle.y) { split.push(rectangle); continue; }
        if (best.x > rectangle.x) split.push({ ...rectangle, width: best.x - rectangle.x });
        if (placedRight < right) split.push({ ...rectangle, x: placedRight, width: right - placedRight });
        if (best.y > rectangle.y) split.push({ ...rectangle, height: best.y - rectangle.y });
        if (placedBottom < bottom) split.push({ ...rectangle, y: placedBottom, height: bottom - placedBottom });
      }
      if (split.length > 5000) return false;
      free = split.filter((rectangle, index) => !split.some((other, otherIndex) => otherIndex !== index &&
        rectangle.x >= other.x && rectangle.y >= other.y && rectangle.x + rectangle.width <= other.x + other.width && rectangle.y + rectangle.height <= other.y + other.height &&
        (rectangle.x !== other.x || rectangle.y !== other.y || rectangle.width !== other.width || rectangle.height !== other.height || otherIndex < index)));
    }
    return true;
  }

  function allocateShipmentBoxes(order, firstPallet, palletSpaces) {
    if (!Number.isSafeInteger(firstPallet) || firstPallet < 0 || !Number.isSafeInteger(palletSpaces) || palletSpaces < 1 ||
        !Number.isSafeInteger(order.palletSpaces) || firstPallet + palletSpaces > order.palletSpaces || !order.lines?.length) return null;
    const groups = new Map();
    for (const line of order.lines) {
      const capacity = availableNumber(line.match?.row?.boxesPerPallet);
      if (line.match?.status !== "found" || !line.match.model || !line.sku || !Number.isSafeInteger(line.boxes) || line.boxes < 1 || !Number.isSafeInteger(capacity)) return null;
      let group = groups.get(line.match.model);
      if (!group) { group = { capacity, boxes: 0, lines: [] }; groups.set(line.match.model, group); }
      if (group.capacity !== capacity || !Number.isSafeInteger(group.boxes + line.boxes)) return null;
      group.lines.push({ sku: line.sku, boxes: line.boxes }); group.boxes += line.boxes;
    }
    const totalPallets = [...groups.values()].reduce((sum, group) => sum + Math.ceil(group.boxes / group.capacity), 0);
    if (totalPallets !== order.palletSpaces) return null;
    const result = [];
    let palletOffset = 0;
    for (const group of groups.values()) {
      const groupPallets = Math.ceil(group.boxes / group.capacity);
      const start = Math.max(0, firstPallet - palletOffset);
      const end = Math.min(groupPallets, firstPallet + palletSpaces - palletOffset);
      if (end > start) {
        const firstBox = Math.min(group.boxes, start * group.capacity);
        const lastBox = Math.min(group.boxes, end * group.capacity);
        let boxOffset = 0;
        for (const line of group.lines) {
          const boxes = Math.max(0, Math.min(lastBox, boxOffset + line.boxes) - Math.max(firstBox, boxOffset));
          if (boxes) result.push({ sku: line.sku, boxes });
          boxOffset += line.boxes;
        }
      }
      palletOffset += groupPallets;
    }
    // Pallets stay grouped by model within this order. Preserve the original
    // color SKUs and line order when filling each model's pallet slots.
    return result.length ? result : null;
  }

  function countTruckTrips(orders, { truckPalletTarget = USABLE_TRUCK_SPACES, dailyTripTarget = 3, lockedTrips = [], nextLoadPriority = [] } = {}) {
    if (![truckPalletTarget, dailyTripTarget].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new Error("Planning targets must be positive whole numbers");
    }
    const byId = new Map(orders.map((order) => [order.id, order]));
    const lockedSpaces = new Map();
    const loads = lockedTrips.map((trip) => {
      if (!trip.shipments?.length || trip.shipments.reduce((sum, shipment) => sum + shipment.palletSpaces, 0) !== trip.palletSpaces) throw new Error("Review the saved sent-out trip.");
      const shipments = trip.shipments.map((shipment) => {
        const order = byId.get(shipment.orderId);
        if (!order) throw new Error("A sent-out trip references an order that is missing from this day.");
        lockedSpaces.set(order.id, (lockedSpaces.get(order.id) || 0) + shipment.palletSpaces);
        return { ...shipment, customer: order.customer };
      });
      return { shipments, palletSpaces: trip.palletSpaces, locked: true, sentOn: trip.sentOn };
    });
    const unscheduled = [];
    const rollovers = [];
    // A rendering safeguard for malformed/huge imports, not a daily trip limit.
    const maxPreviewTrips = 200;
    // Explicit priorities are stable across source-row sorting and optimization.
    const priorityIds = new Set(nextLoadPriority);
    if (priorityIds.size !== nextLoadPriority.length || nextLoadPriority.some(id => !byId.has(id) || lockedSpaces.has(id))) throw new Error("Review next-load priorities.");
    const packingOrder = [...nextLoadPriority.map(id => byId.get(id)), ...orders.filter(order => !priorityIds.has(order.id))];
    for (const order of packingOrder) {
      if (!Number.isSafeInteger(order.palletSpaces) || order.palletSpaces <= 0 || (lockedSpaces.get(order.id) || 0) > order.palletSpaces) {
        unscheduled.push({ orderId: order.id, customer: order.customer, palletSpaces: order.palletSpaces, reason: "Pallet count needs review" });
        continue;
      }
      // Splitting an oversized order keeps all shipments associated with the
      // same customer. It never combines different customers on one pallet.
      let remaining = order.palletSpaces - (lockedSpaces.get(order.id) || 0);
      while (remaining > 0) {
        let load = loads.at(-1);
        if (load?.locked) load = null;
        const room = load ? truckPalletTarget - load.palletSpaces : 0;
        // Ordinary orders stay together. Only an order larger than a truck
        // is split across shipments; manual stop order remains unchanged.
        const needsNextTrip = room > 0 && order.palletSpaces <= truckPalletTarget && remaining > room;
        if (!room || needsNextTrip) load = null;
        if (!load) {
          if (loads.length === maxPreviewTrips) {
            unscheduled.push({ orderId: order.id, customer: order.customer, palletSpaces: remaining, reason: "Preview display limit reached; review quantities or split this planning day" });
            break;
          }
          if (needsNextTrip) rollovers.push({ orderId: order.id, customer: order.customer,
            fromTrip: loads.length, toTrip: loads.length + 1, availablePallets: room,
            requiredPallets: remaining, excessPallets: remaining - room });
          load = { shipments: [], palletSpaces: 0 };
          loads.push(load);
        }
        const spaces = Math.min(remaining, truckPalletTarget - load.palletSpaces);
        load.shipments.push({ orderId: order.id, customer: order.customer, palletSpaces: spaces,
          boxAllocation: allocateShipmentBoxes(order, order.palletSpaces - remaining, spaces) });
        load.palletSpaces += spaces;
        remaining -= spaces;
      }
    }
    const warnings = [];
    loads.forEach((load, index) => {
      load.needsWarehouseReview = load.palletSpaces > USABLE_TRUCK_SPACES;
      load.needsScheduleReview = index >= dailyTripTarget;
    });
    if (loads.some((load) => load.needsWarehouseReview)) warnings.push("Above the usual 11 pallets: confirm the load arrangement with the warehouse.");
    if (loads.length > dailyTripTarget) warnings.push(`Above the usual ${dailyTripTarget} trips: review travel time, reloads, lunch and the driver's shift.`);
    return { trips: loads, unscheduled, rollovers, warnings, targets: { truckPalletTarget, dailyTripTarget } };
  }

  // Moves are represented by the existing saved order priority, not a second
  // load store. Always return the actual repacked plan for review.
  function previewPriorityMove(orders, options, orderId, tripIndex, displacedIds = []) {
    const before = countTruckTrips(orders, options);
    const target = before.trips[tripIndex];
    const locked = new Set((options.lockedTrips || []).flatMap((trip) => trip.shipments.map((item) => item.orderId)));
    const source = orders.find((order) => order.id === orderId);
    if (!source || locked.has(orderId) || source.dispatchedOn || source.deliveredOn || !target || target.locked) throw new Error("Only orders and trips that have not been sent out can move.");
    if (!Number.isSafeInteger(source.palletSpaces) || source.palletSpaces < 1) throw new Error("Review this order's pallet count before moving it.");
    const targetIds = [...new Set(target.shipments.map((item) => item.orderId))];
    const displaced = new Set(displacedIds);
    if (displaced.has(orderId) || [...displaced].some((id) => !targetIds.includes(id) || locked.has(id) || orders.find((o) => o.id === id)?.dispatchedOn || orders.find((o) => o.id === id)?.deliveredOn)) throw new Error("Review the orders selected to return to the queue.");
    // Never move just one part of an order by accidentally changing all parts.
    if ([...displaced].some((id) => before.trips.filter((t) => t.shipments.some((s) => s.orderId === id)).length !== 1)) throw new Error("Split shipments need their complete allocation reviewed before moving.");
    const first = orders.findIndex((o) => targetIds.includes(o.id));
    const moved = new Set([orderId, ...targetIds]);
    const prefix = orders.slice(0, first).filter((o) => !moved.has(o.id));
    const keep = orders.filter((o) => targetIds.includes(o.id) && o.id !== orderId && !displaced.has(o.id));
    const suffix = orders.slice(first).filter((o) => !moved.has(o.id));
    const reordered = [...prefix, source, ...keep, ...orders.filter((o) => displaced.has(o.id)), ...suffix];
    if (reordered.length !== orders.length || new Set(reordered.map((o) => o.id)).size !== orders.length) throw new Error("The move could not preserve every order.");
    const after = countTruckTrips(reordered, options);
    const actualTrip = after.trips.findIndex((t) => !t.locked && t.shipments.some((s) => s.orderId === orderId));
    return { orders: reordered, before, after, actualTrip, requestedTrip: tripIndex,
      displaced: targetIds.filter((id) => id !== orderId && !after.trips[tripIndex]?.shipments.some((s) => s.orderId === id)) };
  }

  function estimateDriverWork(driverName, trips, options = {}) {
    const driver = DRIVERS[driverName];
    if (!driver) throw new Error("Unknown driver");
    const stopMinutes = options.stopMinutes ?? 25;
    const firstLoadMinutes = options.firstLoadMinutes ?? (driverName === "Bubba" ? 30 : 0);
    const reloadMinutes = options.reloadMinutes ?? 40;
    if (![stopMinutes, firstLoadMinutes, reloadMinutes].every((value) => Number.isFinite(value) && value >= 0)) {
      throw new Error("Planning durations must be nonnegative minutes");
    }
    const routeMinutes = trips.reduce((total, trip) => {
      const drive = trip.driveMinutes == null ? NaN : Number(trip.driveMinutes);
      const stops = Number(trip.stopCount);
      if (!Number.isFinite(drive) || drive < 0 || !Number.isInteger(stops) || stops < 0) {
        throw new Error("Each trip needs a nonnegative drive estimate and stop count");
      }
      return total + drive + stops * stopMinutes;
    }, 0);
    const workMinutes = trips.length
      ? firstLoadMinutes + routeMinutes + Math.max(0, trips.length - 1) * reloadMinutes
      : 0;
    const availableMinutes = driver.shiftEndMinutes - driver.shiftStartMinutes - driver.lunchMinutes;
    return {
      workMinutes,
      availableMinutes,
      utilizationPercent: Math.round(workMinutes / availableMinutes * 100),
      withinShift: workMinutes <= availableMinutes,
      // A lunch must still be placed around customer windows and trip timing;
      // work duration alone is not an exact arrival or return schedule.
      lunchMinutes: driver.lunchMinutes,
    };
  }

  return Object.freeze({
    BOX_TRUCK_PALLET_SPACES, PALLET_JACK_SPACES, USABLE_TRUCK_SPACES, VAN, DRIVERS,
    cleanModel, selectSpecification, analyzeOrder, assessVanLoad, assessVanShipments, resolveVanAssignment, allocateShipmentBoxes, countTruckTrips,
    estimateDriverWork, hasCheckOnDelivery, intakeDeliveryDay, previewPriorityMove,
  });
});
