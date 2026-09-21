const test = require("node:test");
const assert = require("node:assert/strict");
const routing = require("../atlas-routing-core.js");
const importer = require("../atlas-routing-catalog.js");

test("noon Pacific is an inclusive intake cutoff in summer and winter", () => {
  for (const [day, before, at] of [
    ["2026-09-22", "2026-09-22T18:59:59Z", "2026-09-22T19:00:00Z"],
    ["2026-01-20", "2026-01-20T19:59:59Z", "2026-01-20T20:00:00Z"],
  ]) {
    assert.equal(routing.intakeDeliveryDay(day, new Date(before)).date, day);
    assert.notEqual(routing.intakeDeliveryDay(day, new Date(at)).date, day);
    assert.equal(routing.intakeDeliveryDay(day, new Date(at)).cutoffReached, true);
  }
});

test("Friday afternoon and weekends route new orders to Monday, including DST weekends", () => {
  for (const [selected, now, expected] of [
    ["2026-09-25", "2026-09-25T19:00:00Z", "2026-09-28"],
    ["2026-09-26", "2026-09-26T16:00:00Z", "2026-09-28"],
    ["2026-09-27", "2026-09-27T23:00:00Z", "2026-09-28"],
    ["2026-03-06", "2026-03-06T20:00:00Z", "2026-03-09"],
    ["2026-10-30", "2026-10-30T19:00:00Z", "2026-11-02"],
  ]) assert.equal(routing.intakeDeliveryDay(selected, new Date(now)).date, expected);
});

test("intake retains later weekdays, never backdates, and needs an explicit same-day exception", () => {
  const now = new Date("2026-09-25T20:00:00Z");
  assert.equal(routing.intakeDeliveryDay("2026-09-30", now).date, "2026-09-30");
  assert.equal(routing.intakeDeliveryDay("2026-09-24", now).date, "2026-09-28");
  assert.equal(routing.intakeDeliveryDay("2026-09-25", now, true).date, "2026-09-25");
  assert.equal(routing.intakeDeliveryDay("2026-09-26", new Date("2026-09-26T20:00:00Z"), true).date, "2026-09-28");
  assert.throws(() => routing.intakeDeliveryDay("2026-02-30", now), /valid delivery day/);
  assert.throws(() => routing.intakeDeliveryDay("2026-09-25", new Date("bad")), /valid delivery day/);
});

const catalog = [
  { model: "SAMPLE-8OZ", caseQty: 100, caseDimensions: "24X20X16", boxesPerPallet: 20 },
  { model: "SAMPLE-95MM", caseQty: 300, caseDimensions: "17X14X11", boxesPerPallet: 64 },
];

test("incoming orders report the overflow while keeping each customer's load together", () => {
  const orders = [5, 4, 3].map((palletSpaces, i) => ({ id: String(i), customer: `Customer ${i}`, palletSpaces }));
  const plan = routing.countTruckTrips(orders);
  assert.deepEqual(plan.trips.map((trip) => trip.palletSpaces), [9, 3]);
  assert.deepEqual(plan.rollovers, [{ orderId: "2", customer: "Customer 2", fromTrip: 1, toTrip: 2,
    availablePallets: 2, requiredPallets: 3, excessPallets: 1 }]);
  const adjusted = routing.countTruckTrips(orders, { truckPalletTarget: 12 });
  assert.deepEqual(adjusted.trips.map((trip) => trip.palletSpaces), [12]);
  assert.deepEqual(adjusted.rollovers, []);
  assert.equal(adjusted.trips[0].needsWarehouseReview, true);
});

test("a sent-out trip stays fixed while later orders start a new load", () => {
  const orders = [
    { id: "a", customer: "First", palletSpaces: 5 },
    { id: "b", customer: "Second", palletSpaces: 4 },
    { id: "c", customer: "Later", palletSpaces: 2 },
  ];
  const lockedTrips = [{ palletSpaces: 9, sentOn: "2026-09-22", shipments: [
    { orderId: "a", palletSpaces: 5, boxAllocation: [{ sku: "X", boxes: 5 }] },
    { orderId: "b", palletSpaces: 4, boxAllocation: [{ sku: "X", boxes: 4 }] },
  ] }];
  const plan = routing.countTruckTrips(orders, { lockedTrips });
  assert.equal(plan.trips[0].locked, true);
  assert.deepEqual(plan.trips.map((trip) => trip.palletSpaces), [9, 2]);
  assert.deepEqual(plan.trips[0].shipments.map((shipment) => shipment.customer), ["First", "Second"]);
  assert.deepEqual(plan.trips[1].shipments.map((shipment) => shipment.orderId), ["c"]);
  assert.deepEqual(routing.countTruckTrips(orders).trips.map((trip) => trip.palletSpaces), [11]);
});

test("remaining pallets of a split order follow its locked shipment", () => {
  const orders = [{ id: "split", customer: "Split", palletSpaces: 15 }, { id: "later", customer: "Later", palletSpaces: 8 }];
  const lockedTrips = [{ palletSpaces: 11, sentOn: "2026-09-22", shipments: [{ orderId: "split", palletSpaces: 11, boxAllocation: [{ sku: "X", boxes: 11 }] }] }];
  const plan = routing.countTruckTrips(orders, { lockedTrips });
  assert.deepEqual(plan.trips.map((trip) => trip.palletSpaces), [11, 4, 8]);
  assert.deepEqual(plan.trips.flatMap((trip) => trip.shipments.filter((shipment) => shipment.orderId === "split").map((shipment) => shipment.palletSpaces)), [11, 4]);
  assert.equal(routing.countTruckTrips([{ id: "split", palletSpaces: 10 }], { lockedTrips }).unscheduled[0].orderId, "split");
});

test("full loads and oversized splits are distinct from ordinary order overflow", () => {
  assert.deepEqual(routing.countTruckTrips([{ id: "a", palletSpaces: 11 }, { id: "b", palletSpaces: 2 }]).rollovers, []);
  const split = routing.countTruckTrips([{ id: "a", palletSpaces: 5 }, { id: "b", palletSpaces: 15 }]);
  assert.deepEqual(split.trips.map((trip) => trip.palletSpaces), [11, 9]);
  assert.deepEqual(split.rollovers, []);
  assert.equal(split.trips.filter((trip) => trip.shipments.some((shipment) => shipment.orderId === "b")).length, 2);
});

test("unknown pallet counts remain unscheduled and the display cap never reports a nonexistent trip", () => {
  const unknown = routing.countTruckTrips([{ id: "missing", palletSpaces: null }, { id: "known", palletSpaces: 9 }]);
  assert.equal(unknown.unscheduled[0].orderId, "missing");
  assert.deepEqual(unknown.rollovers, []);
  const capped = routing.countTruckTrips(Array.from({ length: 201 }, (_, i) => ({ id: String(i), palletSpaces: 6 })));
  assert.equal(capped.trips.length, 200);
  assert.equal(capped.unscheduled[0].orderId, "200");
  assert.equal(capped.rollovers.length, 199);
  assert.equal(capped.rollovers.at(-1).toTrip, 200);
});

test("case quantity means boxes, and a partial pallet uses a full space", () => {
  const full = routing.analyzeOrder({ customer: "A", lines: [{ sku: "SAMPLE-8OZ", caseQty: 100, itemQty: 10000 }] }, catalog);
  const partial = routing.analyzeOrder({ customer: "B", lines: [{ sku: "SAMPLE-8OZ", caseQty: 50, itemQty: 5000 }] }, catalog);
  assert.equal(full.palletSpaces, 5);
  assert.equal(partial.palletSpaces, 3);
  const result = routing.countTruckTrips([{ id: "a", ...full }, { id: "b", ...partial }]);
  assert.equal(result.trips.length, 1);
  assert.equal(result.trips[0].palletSpaces, 8);
  assert.deepEqual(result.trips[0].shipments.map((shipment) => shipment.customer), ["A", "B"]);
  assert.equal(routing.USABLE_TRUCK_SPACES, 11);
});

test("exact SKU wins; a known base model accepts a four-digit color suffix", () => {
  const result = routing.analyzeOrder({
    customer: "A",
    lines: [{ sku: "SAMPLE-95MM-0401", caseQty: 100, itemQty: 30000 }],
  }, catalog);
  assert.equal(result.lines[0].match.model, "SAMPLE-95MM");
  assert.equal(result.lines[0].match.colorSuffixIgnored, true);
  assert.equal(result.palletSpaces, 2);
  assert.deepEqual(result.issues, []);
  assert.equal(routing.selectSpecification(catalog, "SAMPLE-95MMXL-0401").status, "missing");
});

test("a NEW row overrides an old row; conflicting NEW rows require review", () => {
  const rows = [
    { model: "MODEL-A", caseQty: 10, caseDimensions: "10X10X10", boxesPerPallet: 20 },
    { model: "MODEL-A (NEW)", caseQty: 12, caseDimensions: "11X10X10", boxesPerPallet: 18 },
  ];
  assert.equal(routing.selectSpecification(rows, "MODEL-A").row.caseQty, 12);
  const conflict = [...rows, { model: "MODEL-A (NEW NOV 2025)", caseQty: 14, caseDimensions: "12X10X10", boxesPerPallet: 16 }];
  assert.equal(routing.selectSpecification(conflict, "MODEL-A").status, "conflict");
});

test("missing spec fields preserve known information and flag warehouse review", () => {
  const result = routing.analyzeOrder({
    customer: "A",
    lines: [{ sku: "MODEL-B", caseQty: 5, itemQty: 500 }],
  }, [{ model: "MODEL-B", caseQty: 100, caseDimensions: "TBA", boxesPerPallet: 10 }]);
  assert.equal(result.palletSpaces, 1);
  assert.equal(result.boxVolumeIn3, null);
  assert.equal(routing.assessVanLoad([result]).status, "warehouse-check");
});

test("van volume over 80% shows percentage; above capacity cannot fit", () => {
  const at85 = { lines: [], boxVolumeIn3: 0.85 * routing.VAN.volumeFt3 * 1728 };
  const over = { lines: [], boxVolumeIn3: 1.01 * routing.VAN.volumeFt3 * 1728 };
  assert.deepEqual(routing.assessVanLoad([at85]), {
    status: "warehouse-check", percent: 85, reason: "Above 80% planning target",
  });
  assert.equal(routing.assessVanLoad([over]).status, "does-not-fit");
});

test("orders beyond the typical three trips remain planned with a schedule review", () => {
  const orders = Array.from({ length: 4 }, (_, index) => ({
    id: `order-${index}`, customer: `Customer ${index}`, palletSpaces: 11,
  }));
  const result = routing.countTruckTrips(orders);
  assert.equal(result.trips.length, 4);
  assert.equal(result.unscheduled.length, 0);
  assert.equal(result.trips[3].shipments[0].orderId, "order-3");
  assert.equal(result.trips[2].needsScheduleReview, false);
  assert.equal(result.trips[3].needsScheduleReview, true);
  assert.match(result.warnings[0], /usual 3 trips/);
});

test("an adjustable pallet target allows 12 pallets with warehouse review instead of blocking", () => {
  const orders = [{ id: "a", customer: "A", palletSpaces: 12 }];
  assert.deepEqual(routing.countTruckTrips(orders).trips.map((trip) => trip.palletSpaces), [11, 1]);
  const result = routing.countTruckTrips(orders, { truckPalletTarget: 12 });
  assert.equal(result.trips.length, 1);
  assert.equal(result.trips[0].palletSpaces, 12);
  assert.equal(result.trips[0].needsWarehouseReview, true);
  assert.match(result.warnings[0], /confirm the load arrangement/);
  assert.equal(result.unscheduled.length, 0);
});

test("custom targets preserve order boundaries and flag only trips above usual values", () => {
  const result = routing.countTruckTrips([
    { id: "a", customer: "A", palletSpaces: 8 },
    { id: "b", customer: "B", palletSpaces: 6 },
    { id: "c", customer: "C", palletSpaces: 6 },
  ], { truckPalletTarget: 12, dailyTripTarget: 1 });
  assert.deepEqual(result.trips.map((trip) => trip.palletSpaces), [8, 12]);
  assert.deepEqual(result.trips[1].shipments.map((shipment) => shipment.orderId), ["b", "c"]);
  assert.equal(result.trips[0].needsWarehouseReview, false);
  assert.equal(result.trips[1].needsWarehouseReview, true);
  assert.equal(result.trips[1].needsScheduleReview, true);
  assert.equal(result.warnings.length, 2);
});

test("a higher daily target changes review guidance without changing loads", () => {
  const orders = Array.from({ length: 4 }, (_, i) => ({ id: String(i), palletSpaces: 11 }));
  const result = routing.countTruckTrips(orders, { dailyTripTarget: 4 });
  assert.equal(result.trips.length, 4);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.trips.some((trip) => trip.needsScheduleReview), false);
});

test("invalid targets fail promptly, and very large imports preserve overflow for review", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, "12"]) {
    assert.throws(() => routing.countTruckTrips([], { truckPalletTarget: value }), /positive whole/);
    assert.throws(() => routing.countTruckTrips([], { dailyTripTarget: value }), /positive whole/);
  }
  const result = routing.countTruckTrips([{ id: "large", palletSpaces: 1000000 }]);
  assert.equal(result.trips.length, 200);
  assert.match(result.unscheduled[0].reason, /Preview display limit/);
  assert.equal(result.trips.reduce((n, trip) => n + trip.palletSpaces, 0) + result.unscheduled[0].palletSpaces, 1000000);
});

test("driver utilization counts work, reloads, and stops against an eight-hour day", () => {
  const bubba = routing.estimateDriverWork("Bubba", [
    { driveMinutes: 95, stopCount: 2 },
    { driveMinutes: 80, stopCount: 1 },
  ]);
  assert.equal(bubba.workMinutes, 30 + 95 + 50 + 40 + 80 + 25);
  assert.equal(bubba.availableMinutes, 480);
  assert.equal(bubba.utilizationPercent, 67);
  assert.equal(bubba.lunchMinutes, 60);
  assert.equal(routing.estimateDriverWork("Achmad", []).utilizationPercent, 0);
  assert.equal(routing.estimateDriverWork("Bubba", [{ driveMinutes: 460, stopCount: 1 }]).withinShift, false);
});

test("repeated color variants of the same model share the order's pallet calculation", () => {
  const result = routing.analyzeOrder({ lines: [
    { sku: "SAMPLE-8OZ-0001", caseQty: 10 },
    { sku: "SAMPLE-8OZ-0002", caseQty: 10 },
  ] }, catalog);
  assert.equal(result.palletSpaces, 1);
});

test("a normal customer order stays together when the current truck is nearly full", () => {
  const plan = routing.countTruckTrips([
    { id: "a", customer: "A", palletSpaces: 8 },
    { id: "b", customer: "B", palletSpaces: 6 },
    { id: "c", customer: "C", palletSpaces: 3 },
  ]);
  assert.deepEqual(plan.trips.map((trip) => trip.palletSpaces), [8, 9]);
  assert.equal(plan.trips[1].shipments[0].palletSpaces, 6);
  assert.equal(plan.unscheduled.length, 0);
});

test("empty orders and missing drive estimates cannot produce a healthy plan", () => {
  assert.equal(routing.analyzeOrder({ lines: [] }, catalog).palletSpaces, null);
  assert.throws(() => routing.estimateDriverWork("Bubba", [{ driveMinutes: null, stopCount: 2 }]));
  assert.equal(routing.analyzeOrder({ lines: [{ sku: "SAMPLE-8OZ", caseQty: 1.5 }] }, catalog).boxVolumeIn3, null);
});

test("TBA duplicates fill known fields without overriding a NEW version", () => {
  const rows = [
    { model: "MODEL-X", caseQty: "TBA", caseDimensions: "TBA", boxesPerPallet: "TBA" },
    { model: "MODEL-X", caseQty: 100, caseDimensions: "10X10X10", boxesPerPallet: 20 },
  ];
  assert.equal(routing.selectSpecification(rows, "MODEL-X").row.boxesPerPallet, 20);
  const selected = routing.selectSpecification([...rows, { model: "MODEL-X (NEW)", caseQty: 80, caseDimensions: "TBA", boxesPerPallet: 15 }], "MODEL-X");
  assert.equal(selected.row.caseQty, 80);
  assert.equal(selected.row.caseDimensions, null);
});

test("impossible pallet volume flags case dimensions while retaining pallet count", () => {
  const result = routing.analyzeOrder({ lines: [{ sku: "MODEL-X", caseQty: 40 }] }, [
    { model: "MODEL-X", caseQty: 100, caseDimensions: "20X40X80", boxesPerPallet: 20, palletDimensions: "50X40X80" },
  ]);
  assert.equal(result.palletSpaces, 2);
  assert.equal(result.boxVolumeIn3, null);
  assert.match(result.issues.join(" "), /case dimensions conflict/);
});

test("only explicit CHECK ON DELIVERY marks a check collection", () => {
  assert.equal(routing.hasCheckOnDelivery("Terms: COD"), false);
  assert.equal(routing.hasCheckOnDelivery("Collect payment on delivery"), false);
  assert.equal(routing.hasCheckOnDelivery("CHECK\nON DELIVERY"), true);
});

test("workbook headers distinguish units per case from boxes per pallet", () => {
  const rows = [
    ["MODEL NO.", "CASE QTY", "CASE DIMENSIONS", "WEIGHT", "PALLET DIMENSIONS", "QTY PER PALLET", "PER PALLET"],
    ["CONTAINER FAMILY"],
    ["MODEL-X", 100, "10X10X10", "20LB", "50X40X80", 2000, 20],
    ["MODEL-Y", "TBA", "TBA", "TBA", "TBA", "TBA", "TBA"],
  ];
  const result = importer.fromRows(rows);
  assert.equal(result.length, 2);
  assert.equal(result[0].caseQty, "100");
  assert.equal(result[0].boxesPerPallet, "20");
  assert.equal(result[1].caseDimensions, "TBA");
  assert.throws(() => importer.fromRows([["unrelated workbook"]]));
});

test("a van fit estimate requires a box arrangement, not volume alone", () => {
  const smallBoxes = routing.analyzeOrder({ lines: [{ sku: "SMALL", caseQty: 100 }] }, [
    { model: "SMALL", caseQty: 10, caseDimensions: "10X10X10", boxesPerPallet: 50 },
  ]);
  const awkwardBoxes = routing.analyzeOrder({ lines: [{ sku: "LONG", caseQty: 4 }] }, [
    { model: "LONG", caseQty: 10, caseDimensions: "70X40X30", boxesPerPallet: 1 },
  ]);
  assert.equal(routing.assessVanLoad([smallBoxes]).status, "fits-estimate");
  assert.equal(routing.assessVanLoad([smallBoxes]).percent, null);
  // Four long cases are below 80% of published volume, but their two upright
  // columns cannot both fit the conservative rectangular floor space.
  assert.equal(routing.assessVanLoad([awkwardBoxes]).status, "warehouse-check");
  assert.equal(routing.assessVanLoad([awkwardBoxes]).percent, null);
});

test("split shipments allocate exact boxes without repeating the full customer order", () => {
  const analyzed = routing.analyzeOrder({ id: 'A', lines: [{ sku: 'SAMPLE-8OZ-0401', caseQty: 250 }] }, catalog);
  const plan = routing.countTruckTrips([analyzed]);
  assert.deepEqual(plan.trips.map(trip => trip.palletSpaces), [11, 2]);
  assert.deepEqual(plan.trips.map(trip => trip.shipments[0].boxAllocation), [
    [{ sku: 'SAMPLE-8OZ-0401', boxes: 220 }], [{ sku: 'SAMPLE-8OZ-0401', boxes: 30 }],
  ]);
});

test("allocations preserve color SKUs, separate model partial pallets and customer boundaries", () => {
  const rows = [{ model: 'MODEL-A', boxesPerPallet: 20 }, { model: 'MODEL-B', boxesPerPallet: 10 }];
  const orders = [
    routing.analyzeOrder({ id: 'first', lines: [{ sku: 'MODEL-B', caseQty: 10 }] }, rows),
    routing.analyzeOrder({ id: 'split', lines: [{ sku: 'MODEL-A-0401', caseQty: 25 }, { sku: 'MODEL-B', caseQty: 15 }, { sku: 'MODEL-A-0002', caseQty: 20 }] }, rows),
    routing.analyzeOrder({ id: 'next', lines: [{ sku: 'MODEL-B', caseQty: 5 }] }, rows),
  ];
  const plan = routing.countTruckTrips(orders, { truckPalletTarget: 2 });
  const split = plan.trips.flatMap(trip => trip.shipments).filter(shipment => shipment.orderId === 'split');
  assert.deepEqual(split.map(shipment => shipment.boxAllocation), [
    [{ sku: 'MODEL-A-0401', boxes: 20 }],
    [{ sku: 'MODEL-A-0401', boxes: 5 }, { sku: 'MODEL-A-0002', boxes: 20 }],
    [{ sku: 'MODEL-B', boxes: 15 }],
  ]);
  assert.deepEqual(split.map(shipment => shipment.palletSpaces), [1,2,2]);
  assert.equal(plan.trips.at(-1).shipments[0].orderId, 'next');
  assert.deepEqual(plan.trips.at(-1).shipments[0].boxAllocation, [{ sku: 'MODEL-B', boxes: 5 }]);
});

test("NEW pallet quantities drive allocations, TBA dimensions do not discard known boxes", () => {
  const analyzed = routing.analyzeOrder({ id: 'A', lines: [{ sku: 'MODEL-X-0401', caseQty: 35 }] }, [
    { model: 'MODEL-X', boxesPerPallet: 20 }, { model: 'MODEL-X (NEW)', boxesPerPallet: 10, caseDimensions: 'TBA' },
  ]);
  const plan = routing.countTruckTrips([analyzed], { truckPalletTarget: 2 });
  assert.deepEqual(plan.trips.map(trip => trip.shipments[0].boxAllocation[0].boxes), [20,15]);
  assert.equal(analyzed.boxVolumeIn3, null);
  assert.equal(routing.allocateShipmentBoxes({ palletSpaces: 1, lines: [] }, 0, 1), null);
  assert.equal(routing.allocateShipmentBoxes({ ...analyzed, palletSpaces: 99 }, 0, 1), null);
  assert.equal(routing.allocateShipmentBoxes(analyzed, 4, 1), null);
  assert.equal(routing.allocateShipmentBoxes(analyzed, -1, 1), null);
});

test("box totals are conserved through varying truck targets and partial last pallets", () => {
  for (const boxes of [1,19,20,21,100,250,901]) {
    const analyzed = routing.analyzeOrder({ id: 'A', lines: [{ sku: 'SAMPLE-8OZ', caseQty: boxes }] }, catalog);
    for (const target of [1,3,11,12]) {
      const plan = routing.countTruckTrips([analyzed], { truckPalletTarget: target });
      const shipments = plan.trips.flatMap(trip => trip.shipments);
      assert.equal(shipments.reduce((sum, shipment) => sum + shipment.boxAllocation.reduce((n, line) => n + line.boxes, 0), 0), boxes);
      assert.equal(shipments.reduce((sum, shipment) => sum + shipment.palletSpaces, 0), analyzed.palletSpaces);
      for (const shipment of shipments) assert.equal(Math.ceil(shipment.boxAllocation[0].boxes / 20), shipment.palletSpaces);
    }
  }
});

test("van checks use the split shipment's boxes, not the whole order", () => {
  const rows = [{ model: 'VAN-BOX', boxesPerPallet: 20, caseDimensions: '10X10X10' }];
  const order = routing.analyzeOrder({ id: 'A', lines: [{ sku: 'VAN-BOX-0401', caseQty: 600 }] }, rows);
  assert.equal(routing.assessVanLoad([order]).status, 'does-not-fit');
  const loads = routing.countTruckTrips([order]).trips;
  assert.deepEqual(loads.map(load => load.shipments[0].boxAllocation[0].boxes), [220,220,160]);
  for (const load of loads) {
    const fit = routing.assessVanShipments(load.shipments, rows);
    assert.equal(fit.status, 'fits-estimate'); assert.equal(fit.allocationComplete, true);
    assert.equal(fit.percent, null);
  }
});

test("combined van shipments retain the 80 percent review threshold and full-volume limit", () => {
  const rows = [{ model: 'BOX', boxesPerPallet: 50, caseDimensions: '10X10X10' }];
  const shipment = (boxes, id) => ({ orderId: id, palletSpaces: Math.ceil(boxes / 50), boxAllocation: [{ sku: 'BOX', boxes }] });
  const review = routing.assessVanShipments([shipment(240,'A'),shipment(240,'B')], rows);
  assert.equal(review.status, 'warehouse-check'); assert.equal(review.percent, 86);
  assert.equal(review.allocationComplete, true);
  const over = routing.assessVanShipments([shipment(300,'A'),shipment(300,'B')], rows);
  assert.equal(over.status, 'does-not-fit'); assert.equal(over.percent, 108);
});

test("unknown dimensions allow warehouse review but cannot hide known van-fit failures", () => {
  const rows = [
    { model: 'KNOWN', boxesPerPallet: 50, caseDimensions: '10X10X10' },
    { model: 'UNKNOWN', boxesPerPallet: 10, caseDimensions: 'TBA' },
    { model: 'GIANT', boxesPerPallet: 1, caseDimensions: '200X100X100' },
  ];
  const shipment = (lines, pallets) => ({ orderId: 'A', palletSpaces: pallets, boxAllocation: lines.map(([sku, boxes]) => ({ sku, boxes })) });
  const missing = routing.assessVanShipments([shipment([['KNOWN',50],['UNKNOWN',10]],2)], rows);
  assert.equal(missing.status, 'warehouse-check'); assert.equal(missing.allocationComplete, true);
  assert.equal(missing.percent, null);
  const knownOver = routing.assessVanShipments([shipment([['KNOWN',600],['UNKNOWN',10]],13)], rows);
  assert.equal(knownOver.status, 'does-not-fit'); assert.equal(knownOver.percent, null);
  assert.match(knownOver.reason,/Known boxes/);
  assert.equal(routing.assessVanShipments([shipment([['GIANT',1],['UNKNOWN',10]],2)], rows).status, 'does-not-fit');
});

test("missing, invalid or stale box allocations cannot be cleared by a van-fit confirmation", () => {
  const rows = [{ model: 'BOX', boxesPerPallet: 20, caseDimensions: '10X10X10' }];
  for (const shipment of [
    { palletSpaces: 1 }, { palletSpaces: 1, boxAllocation: [] },
    { palletSpaces: 1, boxAllocation: [{ sku: 'BOX', boxes: 21 }] },
    { palletSpaces: 1, boxAllocation: [{ sku: 'BOX', boxes: -1 }] },
    { palletSpaces: 1, boxAllocation: [{ sku: 'MISSING', boxes: 10 }] },
  ]) {
    const fit = routing.assessVanShipments([shipment], rows);
    assert.equal(fit.status, 'warehouse-check'); assert.equal(fit.allocationComplete, false);
  }
});

test("a known non-fitting van load defaults to Bubba and the box truck for either van or driver", () => {
  const rows = [{ model: 'BOX', boxesPerPallet: 50, caseDimensions: '10X10X10' }];
  const shipments = [{ orderId: 'A', palletSpaces: 12, boxAllocation: [{ sku: 'BOX', boxes: 600 }] }];
  const before = JSON.stringify(shipments);
  for (const assignment of ['Bubba:van1','Bubba:van2','Achmad:van1','Achmad:van2']) {
    const result = routing.resolveVanAssignment(assignment, shipments, rows);
    assert.equal(result.assignment, 'Bubba:truck'); assert.equal(result.switched, true);
    assert.equal(result.fit.percent, 108);
  }
  assert.equal(JSON.stringify(shipments), before);
  const truck = routing.resolveVanAssignment('Bubba:truck', shipments, rows);
  assert.equal(truck.switched, false); assert.equal(truck.assignment, 'Bubba:truck');
});

test("van fits and uncertain 80-percent/TBA loads retain their assignment for warehouse review", () => {
  for (const [boxes, dimensions, expected] of [[100,'10X10X10','fits-estimate'],[480,'10X10X10','warehouse-check'],[10,'TBA','warehouse-check']]) {
    const result = routing.resolveVanAssignment('Achmad:van2', [{ orderId: 'A', palletSpaces: Math.ceil(boxes / 50), boxAllocation: [{ sku: 'BOX', boxes }] }],
      [{ model: 'BOX', boxesPerPallet: 50, caseDimensions: dimensions }]);
    assert.equal(result.assignment, 'Achmad:van2'); assert.equal(result.switched, false);
    assert.equal(result.fit.status, expected);
  }
  assert.equal(routing.resolveVanAssignment('Achmad:van1', [{ orderId: 'A', palletSpaces: 1 }], []).switched, false);
});
