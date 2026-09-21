// Daily-planner trip adapter. The older Supabase draft remains untouched.
import { summarizeResult } from "../../supabase/functions/atlas-routing-preview/handler.mjs";

const invalid = (code = "INVALID_REQUEST") => { const error = new Error(code); error.status = 400; error.code = code; throw error; };
const keys = (value, names) => { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !names.includes(key))) invalid(); };
const point = (value) => {
  keys(value, ["latitude", "longitude"]);
  if (!Number.isFinite(value.latitude) || !Number.isFinite(value.longitude) || Math.abs(value.latitude) > 90 || Math.abs(value.longitude) > 180) invalid("INVALID_COORDINATE");
  return { latitude: value.latitude, longitude: value.longitude };
};
function time(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) invalid("INVALID_TIME");
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) invalid("INVALID_TIME");
  return new Date(value).toISOString();
}
function local(value) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const get = (key) => p.find((part) => part.type === key).value;
  return { day: `${get("year")}-${get("month")}-${get("day")}`, minutes: +get("hour") * 60 + +get("minute") };
}

export function buildPlannerTrip(input, depot, now = Date.now()) {
  keys(input, ["action", "warehouse", "departure", "returnBy", "driver", "vehicle", "palletTarget", "stops", "preserveOrder", "lunch"]);
  if (input.action !== "planTrip" || input.warehouse !== "CA" || !["Bubba", "Achmad"].includes(input.driver) ||
      !["truck", "van"].includes(input.vehicle) || (input.driver === "Achmad" && input.vehicle !== "van") || typeof input.preserveOrder !== "boolean") invalid();
  // 100 is an input-abuse bound, not a truck's loading rating or planning advice.
  if (!Number.isSafeInteger(input.palletTarget) || input.palletTarget < 1 || input.palletTarget > 100) invalid("INVALID_PALLETS");
  const departure = time(input.departure), returnBy = time(input.returnBy);
  const start = Date.parse(departure), end = Date.parse(returnBy), startLocal = local(departure), endLocal = local(returnBy);
  if (start < now || start > now + 31 * 86400000 || end <= start || startLocal.day !== endLocal.day ||
      startLocal.minutes < (input.driver === "Bubba" ? 390 : 480) || endLocal.minutes > 1200) invalid("INVALID_TRIP_WINDOW");
  if (!Array.isArray(input.stops) || !input.stops.length || input.stops.length > 20) invalid("INVALID_STOPS");
  let totalPallets = 0;
  const shipments = input.stops.map((stop, index) => {
    keys(stop, ["location", "pallets", "serviceMinutes", "timeWindow"]);
    if (!Number.isSafeInteger(stop.pallets) || stop.pallets < 1 || stop.pallets > input.palletTarget) invalid("INVALID_PALLETS");
    totalPallets += stop.pallets;
    if (!Number.isInteger(stop.serviceMinutes) || stop.serviceMinutes < 1 || stop.serviceMinutes > 480) invalid("INVALID_STOP_DURATION");
    const visit = { arrivalLocation: point(stop.location), duration: `${stop.serviceMinutes * 60}s` };
    if (stop.timeWindow) {
      keys(stop.timeWindow, ["start", "end"]);
      const from = Date.parse(time(stop.timeWindow.start)), to = Date.parse(time(stop.timeWindow.end));
      if (to < from || from < start || to > end) invalid("INVALID_STOP_WINDOW");
      visit.timeWindows = [{ startTime: new Date(from).toISOString(), endTime: new Date(to).toISOString() }];
    }
    return { label: `stop-${index}`, deliveries: [visit], loadDemands: { pallets: { amount: String(stop.pallets) } }, penaltyCost: 100000 };
  });
  if (totalPallets > input.palletTarget) invalid("PLANNING_TARGET_EXCEEDED");
  const vehicle = { label: "planned-trip", travelMode: "DRIVING", startLocation: point(depot), endLocation: point(depot),
    startTimeWindows: [{ startTime: departure, endTime: departure }], endTimeWindows: [{ startTime: departure, endTime: returnBy }],
    loadLimits: { pallets: { maxLoad: String(input.palletTarget) } }, costPerHour: 100 };
  if (input.lunch) {
    keys(input.lunch, ["start", "end"]);
    const from = time(input.lunch.start), to = time(input.lunch.end);
    if (Date.parse(to) - Date.parse(from) !== 3600000 || Date.parse(from) < start || Date.parse(to) > end) invalid("INVALID_LUNCH");
    vehicle.breakRule = { breakRequests: [{ earliestStartTime: from, latestStartTime: from, minDuration: "3600s" }] };
  }
  const model = { globalStartTime: departure, globalEndTime: returnBy, shipments, vehicles: [vehicle] };
  if (input.preserveOrder) model.precedenceRules = shipments.slice(1).map((_, index) => ({ firstIndex: index, firstIsDelivery: true, secondIndex: index + 1, secondIsDelivery: true }));
  return { timeout: "20s", considerRoadTraffic: true, populatePolylines: true, model };
}

export function summarizePlannerTrip(result, count) {
  const summary = summarizeResult(result, count);
  const breaks = (result.routes?.[0]?.breaks || []).map((item) => ({ start: time(item.startTime), durationSeconds: Number(String(item.duration || "0s").replace(/s$/, "")) }));
  if (breaks.some((item) => !Number.isFinite(item.durationSeconds) || item.durationSeconds < 0 || item.durationSeconds > 86400)) invalid("INVALID_ROUTING_RESPONSE");
  return { ...summary, scope: "daily-planner-trip", breaks };
}
