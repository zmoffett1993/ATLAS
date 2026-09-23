/* Daily sequencing for the private CA preview. No persistence or credentials. */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.atlasRoutingPlanner = api;
})(typeof window === "undefined" ? null : window, () => {
  "use strict";
  const MINUTE = 60000;
  const SHIFTS = { Bubba: { start: 360, departure: 390, end: 900 }, Achmad: { start: 480, departure: 510, end: 1020 } };
  function timestamp(day, minutes) {
    if (!/^\d{4}-\d\d-\d\d$/.test(day) || !Number.isFinite(minutes) || minutes < 0 || minutes >= 1440) throw new Error("Choose a valid planning date and time.");
    const noon = new Date(`${day}T12:00:00Z`);
    if (!Number.isFinite(+noon) || noon.toISOString().slice(0, 10) !== day) throw new Error("Choose a valid planning date.");
    const zone = new Intl.DateTimeFormat("en", { timeZone: "America/Los_Angeles", timeZoneName: "shortOffset" }).formatToParts(noon).find((part) => part.type === "timeZoneName").value;
    const offset = Number(zone.match(/^GMT([+-]\d+)$/)?.[1]);
    if (![-7, -8].includes(offset)) throw new Error("Pacific time unavailable.");
    return new Date(Date.parse(`${day}T00:00:00-${String(-offset).padStart(2, "0")}:00`) + minutes * MINUTE).toISOString();
  }
  function clock(value) {
    const match = String(value).trim().toUpperCase().replace(/\./g, "").match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);
    if (!match) throw new Error("Use a clear time, such as 8:00 AM or 14:00.");
    let hours = +match[1]; const minutes = +(match[2] || 0);
    if (minutes > 59 || hours > (match[3] ? 12 : 23) || (match[3] && hours < 1)) throw new Error("Check the delivery time.");
    if (!match[3] && !match[2]) throw new Error("Include AM/PM or use a 24-hour time.");
    if (match[3]) hours = hours % 12 + (match[3] === "PM" ? 12 : 0);
    return hours * 60 + minutes;
  }
  function timeWindow(text, day, departure, serviceMinutes) {
    text = String(text || "").trim();
    if (!text) return null;
    let start = 0, end = 1200;
    const before = text.match(/^(?:before|by)\s+(.+)$/i), after = text.match(/^(?:after|from)\s+(.+)$/i);
    if (before) end = clock(before[1]);
    else if (after) start = clock(after[1]);
    else {
      const pair = text.split(/\s*(?:–|—|-|\bto\b)\s*/i);
      if (pair.length !== 2) throw new Error("Use a time range (8:00 AM–2:00 PM), Before 11:00 AM, or leave the window blank.");
      start = clock(pair[0]); end = clock(pair[1]);
    }
    if (end <= start) throw new Error("The closing time must follow the opening time.");
    // Plan completion before closing, rather than arriving at closing time.
    const from = Math.max(Date.parse(timestamp(day, start)), Date.parse(departure));
    const to = Date.parse(timestamp(day, end)) - serviceMinutes * MINUTE;
    return to < from ? { expired: true } : { start: new Date(from).toISOString(), end: new Date(to).toISOString() };
  }
  function addWork(start, minutes, lunchStart, lunchDone) {
    let end = start + minutes * MINUTE, lunch = null;
    if (!lunchDone && end > lunchStart) {
      const actualStart = Math.max(start, lunchStart);
      lunch = { start: new Date(actualStart).toISOString(), end: new Date(actualStart + 60 * MINUTE).toISOString() };
      end += 60 * MINUTE;
    }
    return { end, lunch };
  }
  function confirmedGeocode(results) {
    if (!Array.isArray(results) || results.length !== 1) throw new Error("Address needs review: Google did not find one clear match.");
    const result = results[0], location = result.geometry?.location;
    if (result.partial_match || !["ROOFTOP", "RANGE_INTERPOLATED"].includes(result.geometry?.location_type) ||
        !result.address_components?.some((part) => part.types.includes("street_number")) ||
        !result.address_components?.some((part) => part.types.includes("country") && part.short_name === "US")) throw new Error("Address needs review: enter the complete street address and ZIP code.");
    const latitude = typeof location?.lat === "function" ? location.lat() : location?.lat;
    const longitude = typeof location?.lng === "function" ? location.lng() : location?.lng;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error("Address coordinates need review.");
    return { location: { latitude, longitude }, formattedAddress: String(result.formatted_address || "") };
  }
  async function planDay({ date, loads, orders, route, geocode, signal, preserveOrder = false, reloadMinutes = 40, lunchMinutes = 720, onProgress = () => {}, onUpdate = () => {}, now = Date.now(), departureNotBefore = null }) {
    const check = () => { if (signal?.aborted) throw new DOMException("Planning canceled", "AbortError"); };
    if (!loads.length || loads.length > 20) throw new Error("The testing preview supports 1–20 trips per calculation. No orders were removed.");
    if (!Number.isInteger(reloadMinutes) || reloadMinutes < 0 || reloadMinutes > 120 || !Number.isInteger(lunchMinutes) || lunchMinutes < 660 || lunchMinutes > 780) throw new Error("Review reload or lunch time.");
    const departureFor = name => Math.max(Date.parse(timestamp(date, SHIFTS[name].departure)), departureNotBefore == null ? 0 : Number(departureNotBefore));
    if (departureNotBefore != null && (!Number.isFinite(departureNotBefore) || departureNotBefore < now || departureNotBefore >= Date.parse(timestamp(date,1200)))) throw new Error("Review the new departure time.");
    const orderMap = new Map(orders.map((order) => [order.id, order]));
    for (const load of loads) {
      if (!SHIFTS[load.driver] || !["truck", "van"].includes(load.vehicle) || (load.driver === "Achmad" && load.vehicle !== "van")) throw new Error("Review the driver and vehicle assignment.");
      if (load.vehicleId && !(load.vehicle === "truck" ? ["truck"] : ["van1", "van2"]).includes(load.vehicleId)) throw new Error("Review the selected company vehicle.");
      if (departureFor(load.driver) <= now) throw new Error("Choose a future planning day; the default departure time has already passed.");
      if (load.shipments.length > 20) throw new Error("A trip exceeds the 20-stop testing limit. Review this load before routing.");
      for (const shipment of load.shipments) {
        const order = orderMap.get(shipment.orderId);
        if (!order || !Number.isInteger(order.serviceMinutes) || order.serviceMinutes < 1 || order.serviceMinutes > 480) throw new Error("Review each stop's service time.");
        // Validate every window before any paid address or routing calls.
        try { timeWindow(order.timeWindow, date, new Date(departureFor(load.driver)).toISOString(), order.serviceMinutes); }
        catch (error) { throw new Error(`${order.customer}: ${error.message}`); }
      }
    }
    const locations = new Map();
    for (const orderId of new Set(loads.flatMap((load) => load.shipments.map((item) => item.orderId)))) {
      check(); const order = orderMap.get(orderId);
      onProgress(`Checking address: ${order.customer}…`);
      try { locations.set(orderId, await geocode(order.address)); }
      catch (error) { check(); throw new Error(`${order.customer}: ${error.message}`); }
      check();
    }
    const drivers = Object.fromEntries(Object.entries(SHIFTS).map(([name, shift]) => [name, { ready: departureFor(name), trips: 0, lunchDone: false, lunch: null, workMinutes: 0, returnTime: null }]));
    const vehicleReady = { truck: 0, van1: 0, van2: 0 };
    const output = { trips: [], unscheduled: [], drivers, complete: false, distanceMeters: 0, driveSeconds: 0, warnings: [] };
    for (let index = 0; index < loads.length; index++) {
      check(); const load = loads[index], driver = drivers[load.driver];
      const vehicleId = load.vehicleId || (load.vehicle === "van" ? "van1" : "truck");
      // Bubba has no fixed lunch start. Reserve an hour within 11 AM–3 PM;
      // Google can place it between visits, or we use a vehicle-waiting gap.
      const flexibleLunch = load.driver === "Bubba";
      const lunchStart = Date.parse(timestamp(date, flexibleLunch ? 660 : lunchMinutes));
      const latestLunchStart = Date.parse(timestamp(date, flexibleLunch ? 840 : lunchMinutes));
      let depart = driver.ready;
      let lunchDone = driver.lunchDone, lunchPeriod = driver.lunch;
      const loadingMinutes = driver.trips ? reloadMinutes : 30;
      let waitingMinutes = 0;
      if (driver.trips || vehicleReady[vehicleId]) {
        const loadingStart = Math.max(driver.trips ? depart : depart - 30 * MINUTE, vehicleReady[vehicleId]);
        waitingMinutes = Math.max(0, (loadingStart - (driver.trips ? depart : depart - 30 * MINUTE)) / MINUTE);
        const waitingStart = driver.trips ? depart : depart - 30 * MINUTE;
        const waitingLunchStart = Math.max(waitingStart, lunchStart);
        if (!lunchDone && loadingStart >= waitingLunchStart + 60 * MINUTE) {
          lunchDone = true; waitingMinutes -= 60;
          lunchPeriod = { start: new Date(waitingLunchStart).toISOString(), end: new Date(waitingLunchStart + 60 * MINUTE).toISOString() };
        }
        const reload = addWork(loadingStart, loadingMinutes, latestLunchStart, lunchDone);
        depart = reload.end;
        if (reload.lunch) { lunchDone = true; lunchPeriod = reload.lunch; }
      } else if (depart >= latestLunchStart && !lunchDone) {
        lunchPeriod = { start: new Date(depart).toISOString(), end: new Date(depart + 60 * MINUTE).toISOString() };
        depart += 60 * MINUTE; lunchDone = true;
      }
      const stops = [], shipments = [];
      for (const shipment of load.shipments) {
        const order = orderMap.get(shipment.orderId);
        const window = timeWindow(order.timeWindow, date, new Date(depart).toISOString(), order.serviceMinutes);
        if (window?.expired || depart >= Date.parse(timestamp(date, 1200))) {
          output.unscheduled.push({ ...shipment, tripIndex: index, reason: window?.expired ? "Delivery window cannot be met at this departure" : "Beyond the preview's 8:00 PM planning horizon" });
          continue;
        }
        shipments.push(shipment);
        stops.push({ location: locations.get(order.id).location, pallets: shipment.palletSpaces, serviceMinutes: order.serviceMinutes, ...(window ? { timeWindow: window } : {}) });
      }
      if (!stops.length) { onUpdate(output); continue; }
      const lunch = !lunchDone && depart <= latestLunchStart ? {
        start: new Date(Math.max(depart, lunchStart)).toISOString(),
        end: new Date(Math.max(depart, lunchStart) + 60 * MINUTE).toISOString(),
        ...(flexibleLunch ? { latestStart: new Date(latestLunchStart).toISOString() } : {}),
      } : null;
      onProgress(`Calculating trip ${index + 1} of ${loads.length} with traffic…`);
      const result = await route({ action: "planTrip", warehouse: "CA", driver: load.driver, vehicle: load.vehicle, palletTarget: load.palletTarget,
        departure: new Date(depart).toISOString(), returnBy: timestamp(date, 1200), preserveOrder, stops, ...(lunch ? { lunch } : {}) }, { signal, onProgress });
      check();
      if (![result.distanceMeters, result.driveSeconds].every((value) => Number.isFinite(value) && value >= 0)) throw new Error("Google returned invalid travel estimates.");
      const seen = new Set();
      for (const visit of result.visits) {
        if (!Number.isInteger(visit.stopIndex) || !shipments[visit.stopIndex] || seen.has(visit.stopIndex) || !Number.isFinite(Date.parse(visit.arrival))) throw new Error("Google returned an incomplete trip. Recalculate after reviewing the stops.");
        seen.add(visit.stopIndex);
      }
      const skipped = new Set(result.skippedStopIndices);
      for (let i = 0; i < shipments.length; i++) if (!seen.has(i)) skipped.add(i);
      for (const i of skipped) {
        if (!shipments[i] || seen.has(i)) throw new Error("Google returned conflicting stop assignments.");
        output.unscheduled.push({ ...shipments[i], tripIndex: index, reason: "Google could not schedule this stop in its delivery window" });
      }
      if (!result.visits.length) { onUpdate(output); continue; }
      const returned = Date.parse(result.returnTime);
      if (!Number.isFinite(returned) || returned < depart || result.visits.some((visit) => Date.parse(visit.arrival) < depart || Date.parse(visit.arrival) > returned)) throw new Error("Google returned an invalid trip schedule.");
      let breakMinutes = 0;
      if (lunch) {
        const realBreak = result.breaks?.find((item) => {
          const start = Date.parse(item.start), end = start + item.durationSeconds * 1000;
          return start >= Date.parse(lunch.start) && start <= latestLunchStart && item.durationSeconds === 3600 && end <= returned &&
            !result.visits.some((visit) => {
              const arrival = Date.parse(visit.arrival);
              return start < arrival + stops[visit.stopIndex].serviceMinutes * MINUTE && end > arrival;
            });
        });
        if (realBreak) {
          lunchDone = true; breakMinutes = 60;
          lunchPeriod = { start: realBreak.start, end: new Date(Date.parse(realBreak.start) + 60 * MINUTE).toISOString() };
        } else if (returned > latestLunchStart) throw new Error("The trip crosses lunch without a confirmed break. Schedule review is needed.");
      }
      const trip = { ...load, tripIndex: index, ...result, shipments, locations: shipments.map((shipment) => locations.get(shipment.orderId)),
        overtime: returned > Date.parse(timestamp(date, SHIFTS[load.driver].end)), lunch: breakMinutes ? lunchPeriod : null };
      output.trips.push(trip);
      driver.lunchDone = lunchDone; driver.lunch = lunchPeriod;
      driver.workMinutes += loadingMinutes + waitingMinutes + (returned - depart) / MINUTE - breakMinutes;
      driver.ready = returned; driver.returnTime = result.returnTime; driver.trips++;
      vehicleReady[vehicleId] = returned;
      output.distanceMeters += result.distanceMeters; output.driveSeconds += result.driveSeconds;
      if (result.trafficInfeasible) output.warnings.push(`Trip ${index + 1}: traffic may prevent the delivery windows from being met.`);
      if (trip.overtime) output.warnings.push(`Trip ${index + 1}: ${load.driver} returns after the usual shift. Review the load or use relief help where it fits.`);
      onUpdate(output);
    }
    for (const [name, driver] of Object.entries(drivers)) {
      if (!driver.trips) continue;
      if (!driver.lunchDone) {
        const start = Math.max(driver.ready, Date.parse(timestamp(date, name === "Bubba" ? 660 : lunchMinutes)));
        driver.lunch = { start: new Date(start).toISOString(), end: new Date(start + 60 * MINUTE).toISOString() };
      }
      driver.utilizationPercent = Math.round(driver.workMinutes / 480 * 100);
      driver.shiftEnd = timestamp(date, SHIFTS[name].end);
    }
    output.complete = true; onUpdate(output); return output;
  }
  function reliefOptions({ date, plan, loads, orders, assessVan }) {
    if (!plan?.complete || !plan.trips.some((trip) => trip.driver === "Bubba" && trip.overtime) ||
        plan.trips.some((trip) => trip.driver === "Achmad" && trip.overtime)) return [];
    const options = [], orderMap = new Map(orders.map((order) => [order.id, order]));
    const earliestDeparture = timestamp(date, SHIFTS.Achmad.departure);
    for (const trip of plan.trips.filter((item) => item.driver === "Bubba").sort((a, b) => b.tripIndex - a.tripIndex)) {
      const load = loads[trip.tripIndex];
      if (!load?.shipments.length || assessVan(load.shipments).status !== "fits-estimate") continue;
      // This is a van-fit opportunity, not a second routing calculation. Do not
      // offer stops already closed before Achmad can leave the warehouse.
      const invalidWindow = load.shipments.some((shipment) => {
        const order = orderMap.get(shipment.orderId);
        if (!order) return true;
        try { return Boolean(timeWindow(order.timeWindow, date, earliestDeparture, order.serviceMinutes)?.expired); }
        catch { return true; }
      });
      if (invalidWindow) continue;
      // Prefer a van unused by other trips; otherwise use the one with the
      // earlier last return. The normal planner rechecks all vehicle overlaps.
      const vans = ["van1", "van2"].map((id) => ({ id, ready: Math.max(0, ...plan.trips.filter((other) => other.tripIndex !== trip.tripIndex &&
        other.vehicle === "van" && (other.vehicleId || "van1") === id).map((other) => Date.parse(other.returnTime))) }));
      vans.sort((a, b) => a.ready - b.ready);
      if (!Number.isFinite(vans[0].ready) || vans[0].ready >= Date.parse(timestamp(date, SHIFTS.Achmad.end))) continue;
      options.push({ tripIndex: trip.tripIndex, assignment: `Achmad:${vans[0].id}`, vehicleId: vans[0].id });
    }
    return options;
  }

  function tripSheet({ date, plan, tripIndex, orders, loads }) {
    timestamp(date, 720);
    if (!plan?.complete) throw new Error("Finish calculating the day before printing a trip.");
    const trip = plan.trips.find((item) => item.tripIndex === tripIndex);
    if (!trip?.visits?.length) throw new Error("This trip has no scheduled stops to print.");
    const orderMap = new Map(orders.map((order) => [order.id, order]));
    const stops = trip.visits.map((visit, index) => {
      const shipment = trip.shipments[visit.stopIndex];
      const order = orderMap.get(shipment?.orderId);
      if (!order) throw new Error("The order changed. Recalculate before printing.");
      // Number this customer's shipments by assigned load, not the trip's
      // overall number or Google's visit order. Keep skipped loads numbered.
      const orderLoads = loads.map((load, loadIndex) => load.shipments.some((item) => item.orderId === order.id) ? loadIndex : -1).filter((loadIndex) => loadIndex >= 0);
      const shipmentNumber = orderLoads.indexOf(tripIndex) + 1;
      if (!shipmentNumber) throw new Error("The load changed. Recalculate before printing.");
      const shipmentCount = orderLoads.length;
      const split = shipmentCount > 1;
      return {
        number: index + 1, customer: order.customer, address: order.address,
        arrival: visit.arrival, palletSpaces: shipment.palletSpaces,
        orderNumber: order.orderNumber, invoiceNumbers: [...(order.invoiceNumbers || [])],
        fulfillmentNumbers: [...(order.fulfillmentNumbers || [])], timeWindow: order.timeWindow || "",
        serviceMinutes: order.serviceMinutes, notes: order.notes || "", checkOnDelivery: Boolean(order.checkOnDelivery), split, shipmentNumber, shipmentCount,
        // Use this load's derived box allocation; never repeat the full order
        // on every split shipment when allocation details are unavailable.
        lines: shipment.boxAllocation ? shipment.boxAllocation.map((line) => ({ sku: line.sku, boxes: line.boxes })) :
          split ? [] : (order.lines || []).map((line) => ({ sku: line.sku, boxes: line.caseQty })),
      };
    });
    const warnings = [...plan.warnings];
    if (loads[tripIndex]?.needsWarehouseReview) warnings.push("Confirm the load arrangement with the warehouse: above the usual 11 pallets.");
    if (loads[tripIndex]?.needsScheduleReview) warnings.push("Additional trip: review the driver's schedule.");
    if (plan.unscheduled.length) warnings.push(`${plan.unscheduled.length} shipment(s) remain unscheduled for this day. They are not included on this trip sheet.`);
    return {
      date, number: tripIndex + 1, driver: trip.driver,
      vehicle: trip.vehicle === "truck" ? "Box Truck" : trip.vehicleId === "van2" ? "Van 2" : "Van 1",
      departure: trip.departure, returnTime: trip.returnTime, lunch: trip.lunch ? { ...trip.lunch } : null,
      distanceMeters: trip.distanceMeters, driveSeconds: trip.driveSeconds,
      palletSpaces: stops.reduce((sum, stop) => sum + stop.palletSpaces, 0), stops, warnings,
    };
  }
  return Object.freeze({ timestamp, clock, timeWindow, addWork, confirmedGeocode, planDay, reliefOptions, tripSheet });
});
