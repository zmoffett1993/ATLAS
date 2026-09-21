const test = require('node:test');
const assert = require('node:assert/strict');
const { timestamp, timeWindow, confirmedGeocode, addWork, planDay } = require('../atlas-routing-planner.js');
const day = '2026-09-21', now = Date.parse('2026-09-20T12:00:00Z');
const order = (id = 'A', extra = {}) => ({ id, customer: id, address: 'Synthetic public test address', serviceMinutes: 25, timeWindow: '', ...extra });
const load = (id = 'A', extra = {}) => ({ driver: 'Bubba', vehicle: 'truck', palletTarget: 12, palletSpaces: 12, shipments: [{ orderId: id, customer: id, palletSpaces: 12 }], ...extra });
const response = (payload, end) => ({ visits: payload.stops.map((_, stopIndex) => ({ stopIndex, arrival: payload.lunch?.start === payload.departure ? payload.lunch.end : payload.departure })), skippedStopIndices: [],
  departure: payload.departure, returnTime: end, driveSeconds: 1200, distanceMeters: 10000, polyline: '', trafficInfeasible: false,
  breaks: payload.lunch ? [{ start: payload.lunch.start, durationSeconds: 3600 }] : [] });
const defaults = { date: day, loads: [load()], orders: [order()], now, geocode: async () => ({ location: { latitude: 34, longitude: -118 }, formattedAddress: 'Synthetic test address' }) };

test('Pacific departure handles daylight saving and invalid calendar dates', () => {
  assert.equal(timestamp('2026-03-08', 390), '2026-03-08T13:30:00.000Z');
  assert.equal(timestamp('2026-11-01', 390), '2026-11-01T14:30:00.000Z');
  assert.throws(() => timestamp('2026-02-30', 390));
});
test('blank, before, after and closing-time windows; ambiguous text is not silently ignored', () => {
  const departure = timestamp(day, 390);
  assert.equal(timeWindow('', day, departure, 25), null);
  assert.equal(timeWindow('Before 11:00 AM', day, departure, 25).end, timestamp(day, 635));
  assert.deepEqual(timeWindow('8:00 AM–2:00 PM', day, departure, 25), { start: timestamp(day, 480), end: timestamp(day, 815) });
  assert.equal(timeWindow('after 9:00 AM', day, departure, 25).start, timestamp(day, 540));
  assert.equal(timeWindow('Before 7:00 AM', day, timestamp(day, 420), 25).expired, true);
  for (const text of ['8-5', 'call customer', '3 PM-8 AM', '25:00-26:00']) assert.throws(() => timeWindow(text, day, departure, 25));
});
test('reload work cannot consume the one-hour lunch', () => {
  const lunch = Date.parse(timestamp(day, 720));
  const result = addWork(Date.parse(timestamp(day, 710)), 40, lunch, false);
  assert.equal(new Date(result.end).toISOString(), timestamp(day, 810));
  assert.deepEqual(result.lunch, { start: timestamp(day, 720), end: timestamp(day, 780) });
});
test('uncertain, missing and city-only geocodes require address review', () => {
  const result = { formatted_address: 'Synthetic', geometry: { location_type: 'ROOFTOP', location: { lat: 34, lng: -118 } },
    address_components: [{ types: ['street_number'] }, { types: ['country'], short_name: 'US' }] };
  assert.deepEqual(confirmedGeocode([result]).location, { latitude: 34, longitude: -118 });
  for (const rows of [[], [result, result], [{ ...result, partial_match: true }], [{ ...result, address_components: [] }]]) assert.throws(() => confirmedGeocode(rows));
});
test('four trips remain sequential with reloads, a single lunch, and accurate utilization', async () => {
  const calls = [], ends = [510, 650, 850, 980];
  const result = await planDay({ ...defaults, loads: ['A','B','C','D'].map((id) => load(id)), orders: ['A','B','C','D'].map((id) => order(id)),
    route: async (payload) => { calls.push(payload); return response(payload, timestamp(day, ends[calls.length - 1])); } });
  assert.deepEqual(calls.map((call) => call.departure), [390, 550, 690, 890].map((minutes) => timestamp(day, minutes)));
  assert.equal(calls[3].lunch, undefined);
  assert.equal(result.trips.length, 4); assert.equal(result.trips[3].overtime, true);
  assert.equal(result.drivers.Bubba.workMinutes, 560); assert.equal(result.drivers.Bubba.utilizationPercent, 117);
  assert.equal(result.complete, true);
});
test('Achmad uses a separate shift timeline and only the cargo van', async () => {
  const calls = [];
  const result = await planDay({ ...defaults, loads: [load(), load('B', { driver: 'Achmad', vehicle: 'van' })], orders: [order(), order('B')],
    route: async (payload) => { calls.push(payload); return response(payload, timestamp(day, payload.driver === 'Bubba' ? 600 : 650)); } });
  assert.equal(calls[1].departure, timestamp(day, 510)); assert.equal(result.drivers.Achmad.trips, 1);
  await assert.rejects(planDay({ ...defaults, loads: [load('A', { driver: 'Achmad' })] }), /assignment/);
});

test('Bubba can cross noon without a fixed break and take lunch later between stops', async () => {
  const calls = [];
  const result = await planDay({ ...defaults, loads: [load(), load('B')], orders: [order(), order('B')], lunchMinutes: 780,
    route: async (payload) => {
      calls.push(payload);
      return { ...response(payload, timestamp(day, calls.length === 1 ? 735 : 890)),
        visits: [{ stopIndex: 0, arrival: payload.departure }],
        breaks: calls.length === 1 ? [] : [{ start: timestamp(day, 805), durationSeconds: 3600 }] };
    } });
  assert.equal(calls[0].lunch.start, timestamp(day, 660));
  assert.equal(calls[0].lunch.latestStart, timestamp(day, 840));
  assert.equal(calls[1].departure, timestamp(day, 775));
  assert.equal(result.drivers.Bubba.lunch.start, timestamp(day, 805));
  assert.equal(result.drivers.Bubba.workMinutes, 470);
  assert.equal(result.trips[1].overtime, false);
});

test('flexible lunch cannot overlap service, be too short, or start outside its window', async () => {
  for (const entry of [{ start: timestamp(day, 420), durationSeconds: 3600 },
    { start: timestamp(day, 750), durationSeconds: 1800 }, { start: timestamp(day, 850), durationSeconds: 3600 }]) {
    await assert.rejects(planDay({ ...defaults, route: async (payload) => ({ ...response(payload, timestamp(day, 920)), breaks: [entry] }) }), /lunch/);
  }
  await assert.rejects(planDay({ ...defaults, route: async (payload) => ({ ...response(payload, timestamp(day, 920)),
    visits: [{ stopIndex: 0, arrival: timestamp(day, 670) }] }) }), /lunch/);
});

test('unused flexible lunch remains reserved after the final trip and Achmad keeps his separate setting', async () => {
  const calls = [];
  const result = await planDay({ ...defaults, loads: [load(), load('B', { driver: 'Achmad', vehicle: 'van' })], orders: [order(), order('B')], lunchMinutes: 750,
    route: async (payload) => { calls.push(payload); return { ...response(payload, timestamp(day, 730)), breaks: [] }; } });
  assert.equal(result.drivers.Bubba.lunch.start, timestamp(day, 730));
  assert.equal(calls[1].lunch.start, timestamp(day, 750));
  assert.equal(calls[1].lunch.latestStart, undefined);
});
test('expired stops and upstream skipped stops retain their exact pallet counts', async () => {
  const result = await planDay({ ...defaults, loads: [load('A'), load('B'), load('C')], orders: [order('A', { timeWindow: 'Before 6:00 AM' }), order('B'), order('C')],
    route: async (payload) => ({ ...response(payload, timestamp(day, 600)), visits: [], skippedStopIndices: [0] }) });
  assert.equal(result.trips.length, 0); assert.equal(result.unscheduled.length, 3);
  assert.equal(result.unscheduled.reduce((sum, item) => sum + item.palletSpaces, 0), 36);
});
test('bad windows fail before paid calls; canceled geocoding cannot start routing', async () => {
  let calls = 0;
  await assert.rejects(planDay({ ...defaults, orders: [order('A', { timeWindow: 'when open' })], geocode: async () => { calls++; } }), /time range/);
  assert.equal(calls, 0);
  const controller = new AbortController();
  await assert.rejects(planDay({ ...defaults, signal: controller.signal, geocode: async () => { controller.abort(); return {}; }, route: async () => { calls++; } }), { name: 'AbortError' });
  assert.equal(calls, 0);
});
test('a failed later request leaves prior results explicitly incomplete and never retries', async () => {
  let calls = 0, partial;
  await assert.rejects(planDay({ ...defaults, loads: [load(), load('B')], orders: [order(), order('B')], onUpdate: (value) => { partial = value; },
    route: async (payload) => { if (++calls === 2) throw new Error('Quota reached'); return response(payload, timestamp(day, 500)); } }), /Quota/);
  assert.equal(calls, 2); assert.equal(partial.trips.length, 1); assert.equal(partial.complete, false);
});
test('routes extending past the flexible lunch window require a confirmed break, and malformed visits cannot pass', async () => {
  await assert.rejects(planDay({ ...defaults, route: async (payload) => ({ ...response(payload, timestamp(day, 850)), breaks: [] }) }), /lunch/);
  await assert.rejects(planDay({ ...defaults, route: async (payload) => ({ ...response(payload, timestamp(day, 500)), visits: [{ stopIndex: 9, arrival: payload.departure }] }) }), /incomplete trip/);
});
test('the shared cargo van cannot be assigned to Bubba and Achmad at the same time', async () => {
  const calls = [];
  const result = await planDay({ ...defaults, loads: [load('A', { vehicle: 'van' }), load('B', { vehicle: 'van', driver: 'Achmad' })], orders: [order(), order('B')],
    route: async (payload) => { calls.push(payload); return response(payload, timestamp(day, calls.length === 1 ? 600 : 700)); } });
  assert.equal(calls[1].departure, timestamp(day, 630));
  assert.equal(result.drivers.Achmad.workMinutes, 220);
});
test('lunch during vehicle waiting is counted once and excluded from working time', async () => {
  const calls = [];
  const result = await planDay({ ...defaults, loads: [load('A', { vehicle: 'van' }), load('B', { vehicle: 'van', driver: 'Achmad' })], orders: [order(), order('B')],
    route: async (payload) => { calls.push(payload); return response(payload, timestamp(day, calls.length === 1 ? 810 : 900)); } });
  assert.equal(calls[1].departure, timestamp(day, 840));
  assert.equal(calls[1].lunch, undefined);
  assert.equal(result.drivers.Achmad.lunch.start, timestamp(day, 720));
  assert.equal(result.drivers.Achmad.workMinutes, 360);
});
test('an entirely skipped trip cannot consume lunch or reload time for a later successful trip', async () => {
  const calls = [];
  const result = await planDay({ ...defaults, loads: ['A','B','C'].map((id) => load(id)), orders: ['A','B','C'].map((id) => order(id)),
    route: async (payload) => {
      calls.push(payload);
      if (calls.length === 2) return { ...response(payload, timestamp(day, 810)), visits: [], skippedStopIndices: [0] };
      return response(payload, timestamp(day, calls.length === 1 ? 710 : 850));
    } });
  assert.equal(calls[1].departure, timestamp(day, 750));
  assert.equal(calls[2].departure, timestamp(day, 750));
  assert.equal(result.drivers.Bubba.lunch.start, timestamp(day, 750));
  assert.equal(result.unscheduled.length, 1);
});
test('two separate vans can run concurrently with different drivers, but one driver cannot overlap trips', async () => {
  const calls = [];
  const result = await planDay({ ...defaults, loads: [load('A', { vehicle: 'van', vehicleId: 'van1' }), load('B', { vehicle: 'van', vehicleId: 'van2', driver: 'Achmad' }), load('C', { vehicle: 'van', vehicleId: 'van2' })], orders: [order(), order('B'), order('C')],
    route: async (payload) => { calls.push(payload); return response(payload, timestamp(day, [600,650,800][calls.length - 1])); } });
  assert.equal(calls[1].departure, timestamp(day, 510));
  assert.equal(calls[2].departure, timestamp(day, 690));
  assert.equal(result.trips.length, 3);
});

test('trip sheets use optimized visit order, shipment pallets, and reviewed paperwork only', () => {
  const { tripSheet } = require('../atlas-routing-planner.js');
  const orders = [order('A', { orderNumber: 'SO-A', invoiceNumbers: ['INV-A'], fulfillmentNumbers: ['IF-A'], checkOnDelivery: true,
    lines: [{ sku: 'MODEL-A-0401', caseQty: 100, itemQty: 10000 }], photos: ['private-photo'], rawOcr: 'not for printing' }), order('B', { orderNumber: 'SO-B', lines: [{ sku: 'MODEL-B', caseQty: 5 }] })];
  const shipments = [{ orderId: 'A', palletSpaces: 5 }, { orderId: 'B', palletSpaces: 1 }];
  const trip = { ...response({ stops: [], departure: timestamp(day, 390) }, timestamp(day, 600)), tripIndex: 0, driver: 'Bubba', vehicle: 'truck', shipments,
    visits: [{ stopIndex: 1, arrival: timestamp(day, 420) }, { stopIndex: 0, arrival: timestamp(day, 480) }] };
  const sheet = tripSheet({ date: day, plan: { complete: true, trips: [trip], warnings: [], unscheduled: [] }, tripIndex: 0, orders, loads: [{ shipments }] });
  assert.deepEqual(sheet.stops.map(stop => stop.orderNumber), ['SO-B', 'SO-A']);
  assert.equal(sheet.palletSpaces, 6);
  assert.deepEqual(sheet.stops[1].lines, [{ sku: 'MODEL-A-0401', boxes: 100 }]);
  assert.equal(sheet.stops[1].checkOnDelivery, true);
  assert.deepEqual(sheet.stops[1].invoiceNumbers, ['INV-A']);
  assert.deepEqual(sheet.stops[1].fulfillmentNumbers, ['IF-A']);
  assert.doesNotMatch(JSON.stringify(sheet), /private-photo|rawOcr|itemQty|not for printing/);
  sheet.stops[1].invoiceNumbers.push('changed copy');
  assert.deepEqual(orders[0].invoiceNumbers, ['INV-A']);
});

test('split trip sheets omit unallocated boxes and exclude skipped shipments from the load total', () => {
  const { tripSheet } = require('../atlas-routing-planner.js');
  const shipments = [{ orderId: 'A', palletSpaces: 11 }, { orderId: 'B', palletSpaces: 1 }];
  const trip = { ...response({ stops: [], departure: timestamp(day, 390) }, timestamp(day, 600)), tripIndex: 0, driver: 'Achmad', vehicle: 'van', vehicleId: 'van2', shipments,
    visits: [{ stopIndex: 0, arrival: timestamp(day, 420) }] };
  const sheet = tripSheet({ date: day, plan: { complete: true, trips: [trip], warnings: ['Review traffic'], unscheduled: [{ orderId: 'B' }] }, tripIndex: 0,
    orders: [order('A', { lines: [{ sku: 'MODEL-A', caseQty: 240 }] }), order('B')],
    loads: [{ shipments, needsWarehouseReview: true, needsScheduleReview: true }, { shipments: [{ orderId: 'A', palletSpaces: 1 }] }] });
  assert.equal(sheet.vehicle, 'Van 2'); assert.equal(sheet.palletSpaces, 11);
  assert.equal(sheet.stops.length, 1); assert.equal(sheet.stops[0].split, true);
  assert.deepEqual(sheet.stops[0].lines, []);
  assert.match(sheet.warnings.join(' '), /unscheduled/);
  assert.match(sheet.warnings.join(' '), /load arrangement/);
  assert.match(sheet.warnings.join(' '), /driver's schedule/);
});

test('incomplete, absent, and stale trips cannot produce a driver sheet', () => {
  const { tripSheet } = require('../atlas-routing-planner.js');
  const input = { date: day, tripIndex: 0, orders: [], loads: [] };
  assert.throws(() => tripSheet({ ...input, plan: { complete: false } }), /Finish calculating/);
  assert.throws(() => tripSheet({ ...input, plan: { complete: true, trips: [] } }), /no scheduled/);
  assert.throws(() => tripSheet({ ...input, plan: { complete: true, trips: [{ tripIndex: 0, shipments: [{ orderId: 'gone' }], visits: [{ stopIndex: 0 }] }] } }), /order changed/);
});

test('shipment numbering is per order, including skipped loads and splits across more than two trips', () => {
  const { tripSheet } = require('../atlas-routing-planner.js');
  const loads = [load('B'), load('A'), load('B'), load('A'), load('A')];
  const orders = [order('A', { customer: 'Same customer name' }), order('B', { customer: 'Same customer name' })];
  for (const [tripIndex, expectedNumber] of [[1, 1], [3, 2], [4, 3]]) {
    const trip = { ...response({ stops: [], departure: timestamp(day, 390) }, timestamp(day, 600)),
      tripIndex, driver: 'Bubba', vehicle: 'truck', shipments: loads[tripIndex].shipments,
      visits: [{ stopIndex: 0, arrival: timestamp(day, 420) }] };
    const plan = { complete: true, trips: [trip], warnings: [], unscheduled: [{ orderId: 'A', tripIndex: tripIndex === 1 ? 3 : 1 }] };
    const stop = tripSheet({ date: day, plan, tripIndex, orders, loads }).stops[0];
    assert.equal(stop.shipmentNumber, expectedNumber);
    assert.equal(stop.shipmentCount, 3);
    assert.equal(stop.split, true);
    assert.deepEqual(stop.lines, []);
    assert.throws(() => tripSheet({ date: day, plan, tripIndex, orders, loads: loads.map(() => load('B')) }), /load changed/);
  }
});

test('split trip sheets print only the allocated boxes and never mutate the load plan', () => {
  const { tripSheet } = require('../atlas-routing-planner.js');
  const core = require('../atlas-routing-core.js');
  const original = order('A', { lines: [{ sku: 'MODEL-X-0401', caseQty: 250 }] });
  const loads = core.countTruckTrips([core.analyzeOrder(original, [{ model: 'MODEL-X', boxesPerPallet: 20 }])]).trips;
  const trip = { ...response({ stops: [], departure: timestamp(day, 390) }, timestamp(day, 600)), tripIndex: 1, driver: 'Bubba', vehicle: 'truck',
    shipments: loads[1].shipments, visits: [{ stopIndex: 0, arrival: timestamp(day, 420) }] };
  const sheet = tripSheet({ date: day, plan: { complete: true, trips: [trip], warnings: [], unscheduled: [] }, tripIndex: 1, orders: [original], loads });
  assert.deepEqual(sheet.stops[0].lines, [{ sku: 'MODEL-X-0401', boxes: 30 }]);
  assert.equal(sheet.stops[0].shipmentNumber, 2);
  sheet.stops[0].lines[0].boxes = 99;
  assert.equal(loads[1].shipments[0].boxAllocation[0].boxes, 30);
  assert.equal(original.lines[0].caseQty, 250);
});

test('relief options appear only for a completed late Bubba day, and never overload an already-late Achmad day', () => {
  const { reliefOptions } = require('../atlas-routing-planner.js');
  const late = { tripIndex: 0, driver: 'Bubba', overtime: true, vehicle: 'truck', returnTime: timestamp(day, 930) };
  const input = { date: day, loads: [load()], orders: [order()], assessVan: () => ({ status: 'fits-estimate' }) };
  assert.deepEqual(reliefOptions({ ...input, plan: { complete: true, trips: [late] } }), [{ tripIndex: 0, assignment: 'Achmad:van1', vehicleId: 'van1' }]);
  assert.deepEqual(reliefOptions({ ...input, plan: { complete: false, trips: [late] } }), []);
  assert.deepEqual(reliefOptions({ ...input, plan: { complete: true, trips: [{ ...late, overtime: false }] } }), []);
  assert.deepEqual(reliefOptions({ ...input, plan: { complete: true, trips: [late, { driver: 'Achmad', overtime: true }] } }), []);
  assert.deepEqual(reliefOptions({ ...input, assessVan: () => ({ status: 'warehouse-check' }), plan: { complete: true, trips: [late] } }), []);
  assert.deepEqual(reliefOptions({ ...input, assessVan: () => ({ status: 'does-not-fit' }), plan: { complete: true, trips: [late] } }), []);
});

test('relief suggestions preserve customer hours and prefer a van not occupied by another trip', () => {
  const { reliefOptions } = require('../atlas-routing-planner.js');
  const trips = [
    { tripIndex: 0, driver: 'Bubba', overtime: false, vehicle: 'van', vehicleId: 'van1', returnTime: timestamp(day, 650) },
    { tripIndex: 1, driver: 'Bubba', overtime: true, vehicle: 'truck', returnTime: timestamp(day, 930) },
  ];
  const input = { date: day, loads: [load('A'),load('B')], orders: [order('A', { timeWindow: 'Before 8:00 AM' }), order('B')], assessVan: () => ({ status: 'fits-estimate' }), plan: { complete: true, trips } };
  assert.deepEqual(reliefOptions(input), [{ tripIndex: 1, assignment: 'Achmad:van2', vehicleId: 'van2' }]);
  assert.deepEqual(reliefOptions({ ...input, orders: [order('A', { timeWindow: 'Before 8:00 AM' }), order('B', { timeWindow: 'Call customer' })] }), []);
  assert.deepEqual(input.orders.map(item => item.id), ['A','B']);
});

test('an earlier fitting load can free Bubba for a later truck-only trip without changing assignments automatically', () => {
  const { reliefOptions } = require('../atlas-routing-planner.js');
  const plan = { complete: true, trips: [
    { tripIndex: 0, driver: 'Bubba', vehicle: 'truck', overtime: false, returnTime: timestamp(day, 600) },
    { tripIndex: 1, driver: 'Bubba', vehicle: 'truck', overtime: true, returnTime: timestamp(day, 940) },
  ] };
  const loads = [load('A'), load('B')], before = JSON.stringify({ plan, loads });
  const options = reliefOptions({ date: day, plan, loads, orders: [order('A'),order('B')], assessVan: shipments => ({ status: shipments[0].orderId === 'A' ? 'fits-estimate' : 'does-not-fit' }) });
  assert.deepEqual(options.map(item => item.tripIndex), [0]);
  assert.equal(JSON.stringify({ plan, loads }), before);
});
