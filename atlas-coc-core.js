(function (global) {
  "use strict";

  const SCHEMA_VERSION = 8;
  const MAX_INVOICE_LENGTH = 80;
  const MAX_LOT_LENGTH = 120;
  const MAX_CUSTOMER_LENGTH = 160;

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const timestamp = () => new Date().toISOString();
  const makeId = (prefix) => {
    const id = global.crypto?.randomUUID?.() ||
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    return `${prefix}-${id}`;
  };
  const cleanText = (value, max) => String(value || "").trim().slice(0, max);
  const cleanLot = (value) => cleanText(value, MAX_LOT_LENGTH);
  const cleanModel = (value) => cleanText(value, MAX_LOT_LENGTH).toUpperCase();
  const canonicalModel = (value) => cleanModel(value).replace(/[^A-Z0-9]/g, "");
  const canonicalLot = (value) => cleanLot(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const displayLot = (value) => {
    const raw = cleanLot(value);
    return raw;
  };
  const integer = (value) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  };
  const positiveInteger = (value) => {
    if (!["number", "string"].includes(typeof value)) return null;
    if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  };
  const metricInteger = (value, maximum = 1000000000) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0
      ? Math.min(number, maximum)
      : 0;
  };

  function normalizeAnalytics(source = {}) {
    const successes = metricInteger(source?.scanSuccesses, 1000000);
    const failures = metricInteger(source?.scanFailures, 1000000);
    const suppliedAttempts = metricInteger(source?.scanAttempts, 1000000);
    const attempts = Math.max(suppliedAttempts, successes + failures);
    return {
      activeDurationMs: metricInteger(source?.activeDurationMs, 2592000000),
      scanAttempts: attempts,
      scanSuccesses: Math.min(successes, attempts),
      scanFailures: Math.min(failures, attempts),
      scanCanceled: metricInteger(source?.scanCanceled, 1000000),
    };
  }

  function normalizeModelRecord(source, fallbackAddedAt = timestamp()) {
    const modelNumber = cleanModel(typeof source === "string" ? source : source?.modelNumber);
    if (!modelNumber) return null;
    return {
      modelNumber,
      catalogModel: cleanModel(source?.catalogModel || modelNumber),
      caseQuantity: positiveInteger(source?.caseQuantity),
      sourceRevision: cleanText(source?.sourceRevision, 80),
      addedAt: cleanText(source?.addedAt, 40) || fallbackAddedAt,
    };
  }

  function normalizeModels(values, fallbackAddedAt = timestamp()) {
    const seen = new Set();
    return (Array.isArray(values) ? values : [])
      .map((value) => normalizeModelRecord(value, fallbackAddedAt))
      .filter((record) => {
        if (!record) return false;
        const key = canonicalModel(record.modelNumber);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 100);
  }

  function createPallet(number) {
    return {
      id: makeId("pallet"),
      number,
      status: "active",
      createdAt: timestamp(),
      finishedAt: null,
      activeLotId: null,
      activeModel: "",
      models: [],
      modelNumbers: [],
      lots: [],
      history: [],
      expectedBoxes: null,
      expectedBoxesConfirmedAt: null,
      expectedBoxesUpdatedAt: null,
      expectedBoxHistory: [],
      verificationState: "awaiting_count",
      verificationAttemptedAt: null,
      verifiedAt: null,
      expectedBoxesInferred: false,
      reopenedForEdit: false,
    };
  }

  function createSession({
    customerName = "", ifNumber = "", invoiceNumber = "", orderNumber = "",
    deviceId = "", employee = "", employeeDisplayName = "", warehouseCode = "", warehouseName = "", sku = "", models = [], modelNumbers = [],
  } = {}) {
    const createdAt = timestamp();
    const pallet = createPallet(1);
    const invoice = cleanText(invoiceNumber || orderNumber, MAX_INVOICE_LENGTH);
    const customer = cleanText(customerName, MAX_CUSTOMER_LENGTH).toUpperCase();
    const ifValue = cleanText(ifNumber, MAX_INVOICE_LENGTH);
    const selectedModels = normalizeModels(
      models.length ? models : modelNumbers.length ? modelNumbers : sku ? [sku] : [],
      createdAt,
    );
    if (!invoice) throw new Error("INVOICE_REQUIRED");
    if (!customer) throw new Error("CUSTOMER_REQUIRED");
    if (!ifValue) throw new Error("IF_NUMBER_REQUIRED");
    if (selectedModels.some((model) => !model.caseQuantity))
      throw new Error("MODEL_CASE_QUANTITY_REQUIRED");
    const activeModel = "";
    return {
      schemaVersion: SCHEMA_VERSION,
      id: makeId("coc"),
      deviceId: cleanText(deviceId, 100),
      customerName: customer,
      invoiceNumber: invoice,
      ifNumber: ifValue,
      models: selectedModels,
      modelNumbers: selectedModels.map((model) => model.modelNumber),
      activeModel,
      sku: activeModel,
      employee: cleanText(employee, 60),
      employeeDisplayName: cleanText(employeeDisplayName || employee, 100),
      warehouseCode: cleanText(warehouseCode || "CA", 8).toUpperCase(),
      warehouseName: cleanText(warehouseName || (String(warehouseCode).toUpperCase() === "TX" ? "Texas Warehouse" : "California Warehouse"), 100),
      status: "active",
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
      activePalletId: pallet.id,
      pallets: [pallet],
      analytics: normalizeAnalytics(),
      activity: [{ type: "session_started", at: createdAt, models: 0 }],
    };
  }

  function sanitize(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.pallets))
      throw new Error("INVALID_COC_STATE");
    const createdAt = cleanText(raw.createdAt, 40) || timestamp();
    const suppliedModels = Array.isArray(raw.models)
      ? raw.models
      : Array.isArray(raw.modelNumbers)
        ? raw.modelNumbers
        : raw.sku
          ? [raw.sku]
          : [];
    let models = normalizeModels(suppliedModels, createdAt);
    const modelRecordFor = (value) => {
      const key = canonicalModel(value);
      return models.find((model) => canonicalModel(model.modelNumber) === key) || null;
    };
    const seenPallets = new Set();
    const pallets = raw.pallets.slice(0, 500).map((source, index) => {
      const id = cleanText(source?.id, 140) || makeId("pallet");
      if (seenPallets.has(id)) throw new Error("DUPLICATE_PALLET_ID");
      seenPallets.add(id);
      const suppliedPalletModels = Array.isArray(source?.models)
        ? source.models
        : Array.isArray(source?.modelNumbers)
          ? source.modelNumbers
          : [];
      let palletModels = normalizeModels(suppliedPalletModels, createdAt);
      if (!palletModels.length && source?.status === "active" && (raw.activeModel || raw.sku)) {
        const legacyActive = modelRecordFor(raw.activeModel || raw.sku);
        if (legacyActive) palletModels = [legacyActive];
      }
      const palletModelRecordFor = (value) => {
        const key = canonicalModel(value);
        return palletModels.find((model) => canonicalModel(model.modelNumber) === key) ||
          modelRecordFor(value);
      };
      const seenLots = new Set();
      const lots = (Array.isArray(source?.lots) ? source.lots : [])
        .slice(0, 500)
        .map((lot) => {
          const rawLot = cleanLot(lot?.lot);
          const canonical = canonicalLot(rawLot);
          if (!canonical) throw new Error("INVALID_LOT");
          const model = cleanModel(lot?.model || lot?.expectedModel || raw?.activeModel || raw?.sku);
          const duplicateKey = `${canonicalModel(model)}:${canonical}`;
          if (seenLots.has(duplicateKey)) throw new Error("DUPLICATE_LOT");
          seenLots.add(duplicateKey);
          const linkedModel = palletModelRecordFor(model);
          return {
            id: cleanText(lot?.id, 140) || makeId("lot"),
            lot: rawLot,
            canonical,
            cases: integer(lot?.cases),
            createdAt: cleanText(lot?.createdAt, 40) || timestamp(),
            verifiedAt: cleanText(lot?.verifiedAt, 40) || null,
            verification: ["ocr", "manual"].includes(lot?.verification)
              ? lot.verification
              : "manual",
            ocrConfidence: Number.isFinite(Number(lot?.ocrConfidence))
              ? Math.max(0, Math.min(100, Number(lot.ocrConfidence)))
              : null,
            rawBarcode: cleanText(lot?.rawBarcode, MAX_LOT_LENGTH),
            barcodeFormat: cleanText(lot?.barcodeFormat, 40),
            rawBatchText: cleanText(lot?.rawBatchText, MAX_LOT_LENGTH),
            sku: cleanModel(lot?.sku || model || raw?.sku),
            model,
            detectedModel: cleanModel(lot?.detectedModel),
            caseQuantity: positiveInteger(lot?.caseQuantity) || linkedModel?.caseQuantity || null,
            captureMethod: cleanText(
              lot?.captureMethod || lot?.verification || "manual",
              40,
            ),
            validationMethod: cleanText(lot?.validationMethod, 80),
            labelClass: ["model_batch", "direct_lot"].includes(lot?.labelClass)
              ? lot.labelClass
              : "",
            confidenceState: ["verified", "recognized", "needs_verification"].includes(lot?.confidenceState)
              ? lot.confidenceState
              : "",
            expectedModel: cleanModel(lot?.expectedModel || model || raw?.sku),
            modelMatchMethod: cleanText(lot?.modelMatchMethod, 40),
            captureConfidence: Number.isFinite(Number(lot?.captureConfidence ?? lot?.ocrConfidence))
              ? Math.max(0, Math.min(100, Number(lot.captureConfidence ?? lot.ocrConfidence)))
              : null,
            confirmedBy: cleanText(lot?.confirmedBy, 60),
          };
        });
      palletModels = normalizeModels([
        ...palletModels,
        ...lots.map((lot) => ({
          modelNumber: lot.model,
          catalogModel: lot.model,
          caseQuantity: lot.caseQuantity,
          addedAt: lot.createdAt,
        })),
      ], createdAt);
      const lotIds = new Set(lots.map((lot) => lot.id));
      const history = (Array.isArray(source?.history) ? source.history : [])
        .filter((entry) => entry?.kind === "case" && lotIds.has(entry.lotId))
        .slice(-10000)
        .map((entry) => ({
          kind: "case",
          lotId: entry.lotId,
          at: cleanText(entry.at, 40) || timestamp(),
        }));
      const recordedBoxes = lots.reduce((total, lot) => total + integer(lot.cases), 0);
      const isLocked = source?.status === "locked" || raw.status === "report";
      const suppliedExpected = positiveInteger(source?.expectedBoxes);
      const inferredExpected = !suppliedExpected && isLocked && recordedBoxes > 0
        ? recordedBoxes
        : null;
      const expectedBoxes = suppliedExpected || inferredExpected;
      const allowedVerificationStates = new Set([
        "awaiting_count", "in_progress", "count_mismatch", "verified", "completed",
      ]);
      let verificationState = allowedVerificationStates.has(source?.verificationState)
        ? source.verificationState
        : expectedBoxes
          ? (isLocked ? "completed" : "in_progress")
          : "awaiting_count";
      if (isLocked && expectedBoxes && recordedBoxes === expectedBoxes)
        verificationState = "completed";
      if (!isLocked && !expectedBoxes) verificationState = "awaiting_count";
      const expectedBoxHistory = (Array.isArray(source?.expectedBoxHistory)
        ? source.expectedBoxHistory
        : [])
        .slice(-1000)
        .map((entry) => ({
          previous: positiveInteger(entry?.previous),
          next: positiveInteger(entry?.next),
          at: cleanText(entry?.at, 40) || timestamp(),
        }))
        .filter((entry) => entry.next);
      let activeModel = cleanModel(source?.activeModel);
      if (!palletModels.some((model) => canonicalModel(model.modelNumber) === canonicalModel(activeModel))) {
        activeModel = lots.find((lot) => lot.id === source?.activeLotId)?.model ||
          palletModels[0]?.modelNumber || "";
      }
      return {
        id,
        number: index + 1,
        status: isLocked ? "locked" : "active",
        createdAt: cleanText(source?.createdAt, 40) || timestamp(),
        finishedAt: cleanText(source?.finishedAt, 40) || null,
        activeLotId: lotIds.has(source?.activeLotId)
          ? source.activeLotId
          : Object.prototype.hasOwnProperty.call(source || {}, "activeLotId")
            ? null
            : lots[0]?.id || null,
        activeModel,
        models: palletModels,
        modelNumbers: palletModels.map((model) => model.modelNumber),
        lots,
        history,
        expectedBoxes,
        expectedBoxesConfirmedAt: cleanText(source?.expectedBoxesConfirmedAt, 40) ||
          (expectedBoxes ? cleanText(source?.createdAt, 40) || timestamp() : null),
        expectedBoxesUpdatedAt: cleanText(source?.expectedBoxesUpdatedAt, 40) || null,
        expectedBoxHistory,
        verificationState,
        verificationAttemptedAt: cleanText(source?.verificationAttemptedAt, 40) || null,
        verifiedAt: cleanText(source?.verifiedAt, 40) ||
          (isLocked && expectedBoxes === recordedBoxes ? cleanText(source?.finishedAt, 40) || null : null),
        expectedBoxesInferred: Boolean(source?.expectedBoxesInferred || inferredExpected),
        reopenedForEdit: Boolean(source?.reopenedForEdit),
      };
    });
    const inferredModels = pallets.flatMap((pallet) => [
      ...(pallet.models || []),
      ...pallet.lots.map((lot) => ({
        modelNumber: lot.model,
        catalogModel: lot.model,
        caseQuantity: lot.caseQuantity,
        addedAt: lot.createdAt,
      })),
    ]);
    models = normalizeModels([...models, ...inferredModels], createdAt);
    if (!pallets.length && raw.status !== "report") pallets.push(createPallet(1));
    const status = raw.status === "report" ? "report" : "active";
    let activePalletId = cleanText(raw.activePalletId, 140);
    if (status === "active") {
      let active = pallets.find(
        (pallet) => pallet.id === activePalletId && pallet.status === "active",
      ) || pallets.find((pallet) => pallet.status === "active");
      if (!active) {
        active = createPallet(pallets.length + 1);
        pallets.push(active);
      }
      activePalletId = active.id;
      pallets.forEach((pallet) => {
        pallet.status = pallet.id === activePalletId ? "active" : "locked";
      });
    } else {
      activePalletId = null;
      pallets.forEach((pallet) => { pallet.status = "locked"; });
    }
    const activePalletRecord = pallets.find((pallet) => pallet.id === activePalletId) || null;
    let activeModel = cleanModel(activePalletRecord?.activeModel);
    if (!activePalletRecord?.models?.some(
      (model) => canonicalModel(model.modelNumber) === canonicalModel(activeModel),
    )) activeModel = activePalletRecord?.models?.[0]?.modelNumber || "";
    if (activePalletRecord) activePalletRecord.activeModel = activeModel;
    return {
      schemaVersion: SCHEMA_VERSION,
      id: cleanText(raw.id, 140) || makeId("coc"),
      deviceId: cleanText(raw.deviceId, 100),
      customerName: cleanText(raw.customerName, MAX_CUSTOMER_LENGTH).toUpperCase(),
      invoiceNumber: cleanText(raw.invoiceNumber || raw.orderNumber, MAX_INVOICE_LENGTH),
      ifNumber: cleanText(raw.ifNumber, MAX_INVOICE_LENGTH),
      models,
      modelNumbers: models.map((model) => model.modelNumber),
      activeModel,
      sku: activeModel || cleanModel(raw.sku),
      employee: cleanText(raw.employee, 60),
      employeeDisplayName: cleanText(raw.employeeDisplayName || raw.employee, 100),
      warehouseCode: cleanText(raw.warehouseCode || "CA", 8).toUpperCase(),
      warehouseName: cleanText(raw.warehouseName || (String(raw.warehouseCode).toUpperCase() === "TX" ? "Texas Warehouse" : "California Warehouse"), 100),
      status,
      createdAt,
      updatedAt: cleanText(raw.updatedAt, 40) || timestamp(),
      completedAt: cleanText(raw.completedAt, 40) || null,
      activePalletId,
      pallets,
      analytics: normalizeAnalytics(raw.analytics),
      activity: (Array.isArray(raw.activity) ? raw.activity : []).slice(-2000),
    };
  }

  const activePallet = (session) =>
    session?.pallets?.find((pallet) => pallet.id === session.activePalletId) || null;
  const palletTotal = (pallet) =>
    (pallet?.lots || []).reduce((total, lot) => total + integer(lot.cases), 0);
  const sessionTotal = (session) =>
    (session?.pallets || []).reduce((total, pallet) => total + palletTotal(pallet), 0);
  const lotUnitQuantity = (lot) => integer(lot?.cases) * (positiveInteger(lot?.caseQuantity) || 0);
  const sessionUnitTotal = (session) => (session?.pallets || []).reduce(
    (sessionUnits, pallet) => sessionUnits + (pallet?.lots || []).reduce(
      (palletUnits, lot) => palletUnits + lotUnitQuantity(lot), 0,
    ), 0,
  );
  const modelRecord = (session, value) => {
    const key = canonicalModel(value);
    const pallet = activePallet(session);
    return pallet?.models?.find((model) => canonicalModel(model.modelNumber) === key) ||
      session?.models?.find((model) => canonicalModel(model.modelNumber) === key) || null;
  };
  const palletModels = (session, pallet = activePallet(session)) =>
    Array.isArray(pallet?.models) ? pallet.models : [];
  const palletProgress = (pallet) => {
    const expected = positiveInteger(pallet?.expectedBoxes);
    const recorded = palletTotal(pallet);
    return {
      expected,
      recorded,
      difference: expected === null ? null : recorded - expected,
      state: pallet?.verificationState || (expected ? "in_progress" : "awaiting_count"),
      verified: Boolean(expected && recorded === expected &&
        ["verified", "completed"].includes(pallet?.verificationState)),
    };
  };

  const boxLimitMessage = (pallet) => {
    const number = integer(pallet?.number) || 1;
    const count = positiveInteger(pallet?.expectedBoxes) || 0;
    return `Approved box count reached. Pallet ${number} is limited to ${count} boxes. Finish the pallet or correct the approved count before adding another box.`;
  };

  function assertBoxCapacity(pallet, increment = 1) {
    const expected = positiveInteger(pallet?.expectedBoxes);
    if (!expected) throw new Error("EXPECTED_BOX_COUNT_REQUIRED");
    if (palletTotal(pallet) + integer(increment) > expected) {
      const error = new Error(boxLimitMessage(pallet));
      error.code = "APPROVED_BOX_COUNT_REACHED";
      error.palletNumber = pallet.number;
      error.expectedBoxes = expected;
      error.recordedBoxes = palletTotal(pallet);
      throw error;
    }
  }

  function withActivity(session, type, detail = {}) {
    session.updatedAt = timestamp();
    session.activity = [...(session.activity || []), { type, at: session.updatedAt, ...detail }]
      .slice(-2000);
    return session;
  }

  function addActiveDuration(source, milliseconds) {
    const session = sanitize(clone(source));
    if (session.status !== "active") return session;
    // The UI commits visible time every 30 seconds. Capping one segment at two
    // minutes prevents a suspended/backgrounded browser from inflating a COC.
    const delta = metricInteger(Math.round(Number(milliseconds) || 0), 120000);
    if (!delta) return session;
    session.analytics.activeDurationMs = metricInteger(
      session.analytics.activeDurationMs + delta,
      2592000000,
    );
    session.updatedAt = timestamp();
    return session;
  }

  function recordScanOutcome(source, outcome) {
    const session = sanitize(clone(source));
    if (session.status !== "active") return session;
    const result = String(outcome || "").toLowerCase();
    if (result === "canceled") {
      session.analytics.scanCanceled += 1;
    } else if (result === "success") {
      session.analytics.scanAttempts += 1;
      session.analytics.scanSuccesses += 1;
    } else if (result === "failure") {
      session.analytics.scanAttempts += 1;
      session.analytics.scanFailures += 1;
    } else {
      throw new Error("SCAN_OUTCOME_INVALID");
    }
    session.updatedAt = timestamp();
    return session;
  }

  function addLot(source, lotValue, options = {}) {
    const session = sanitize(clone(source));
    const pallet = activePallet(session);
    if (!pallet || session.status !== "active") throw new Error("NO_ACTIVE_PALLET");
    if (!positiveInteger(pallet.expectedBoxes)) throw new Error("EXPECTED_BOX_COUNT_REQUIRED");
    const lotText = cleanLot(lotValue);
    const canonical = canonicalLot(lotText);
    if (!canonical) throw new Error("LOT_REQUIRED");
    const selectedModel = cleanModel(options.model || session.activeModel || session.sku);
    const selectedModelRecord = pallet.models?.find(
      (model) => canonicalModel(model.modelNumber) === canonicalModel(selectedModel),
    );
    if (!selectedModelRecord?.caseQuantity) throw new Error("MODEL_CASE_QUANTITY_REQUIRED");
    const duplicate = pallet.lots.find((lot) =>
      lot.canonical === canonical && canonicalModel(lot.model) === canonicalModel(selectedModel));
    if (duplicate) return { session, duplicate };
    assertBoxCapacity(pallet);
    const at = timestamp();
    const lot = {
      id: makeId("lot"),
      lot: lotText,
      canonical,
      cases: 1,
      createdAt: at,
      verifiedAt: at,
      verification: options.verification === "ocr" ? "ocr" : "manual",
      ocrConfidence: Number.isFinite(Number(options.confidence))
        ? Math.max(0, Math.min(100, Number(options.confidence)))
        : null,
      rawBarcode: cleanText(options.rawBarcode, MAX_LOT_LENGTH),
      barcodeFormat: cleanText(options.barcodeFormat, 40),
      rawBatchText: cleanText(options.rawBatchText, MAX_LOT_LENGTH),
      sku: cleanModel(options.sku || selectedModel),
      model: selectedModel,
      detectedModel: cleanModel(options.detectedModel),
      caseQuantity: selectedModelRecord.caseQuantity,
      captureMethod: cleanText(options.captureMethod || options.verification || "manual", 40),
      validationMethod: cleanText(options.validationMethod, 80),
      labelClass: ["model_batch", "direct_lot"].includes(options.labelClass)
        ? options.labelClass
        : "",
      confidenceState: ["verified", "recognized", "needs_verification"].includes(options.confidenceState)
        ? options.confidenceState
        : "",
      expectedModel: cleanModel(options.expectedModel || selectedModel),
      modelMatchMethod: cleanText(options.modelMatchMethod, 40),
      captureConfidence: Number.isFinite(Number(options.confidence))
        ? Math.max(0, Math.min(100, Number(options.confidence)))
        : null,
      confirmedBy: cleanText(options.confirmedBy || session.employee, 60),
    };
    pallet.lots.push(lot);
    pallet.activeLotId = lot.id;
    pallet.activeModel = selectedModel;
    session.activeModel = selectedModel;
    session.sku = selectedModel;
    pallet.history.push({ kind: "case", lotId: lot.id, at });
    pallet.verificationState = "in_progress";
    pallet.verificationAttemptedAt = null;
    pallet.verifiedAt = null;
    withActivity(session, "lot_added", {
      palletNumber: pallet.number,
      lot: lot.lot,
      model: selectedModel,
      caseQuantity: selectedModelRecord.caseQuantity,
    });
    return { session, lot, duplicate: null };
  }

  function selectLot(source, lotId) {
    const session = sanitize(clone(source));
    const pallet = activePallet(session);
    const selected = pallet?.lots.find((lot) => lot.id === lotId);
    if (!pallet || !selected)
      throw new Error("LOT_NOT_FOUND");
    pallet.activeLotId = lotId;
    pallet.activeModel = selected.model || pallet.activeModel;
    session.activeModel = selected.model || session.activeModel;
    session.sku = session.activeModel || session.sku;
    return withActivity(session, "lot_selected", { palletNumber: pallet.number, lotId });
  }

  function updateLot(source, lotId, updates = {}) {
    const session = sanitize(clone(source));
    const pallet = activePallet(session);
    const lot = pallet?.lots.find((item) => item.id === lotId);
    if (!pallet || session.status !== "active") throw new Error("NO_ACTIVE_PALLET");
    if (!lot) throw new Error("LOT_NOT_FOUND");

    const nextLotText = cleanLot(updates.lot);
    const nextCanonical = canonicalLot(nextLotText);
    const nextModel = cleanModel(updates.model);
    const nextCases = Number(updates.cases);
    if (!nextCanonical) throw new Error("LOT_REQUIRED");
    if (!Number.isInteger(nextCases) || nextCases < 0) throw new Error("INVALID_BOX_COUNT");
    const model = pallet.models.find(
      (item) => canonicalModel(item.modelNumber) === canonicalModel(nextModel),
    );
    if (!model?.caseQuantity) throw new Error("MODEL_NOT_FOUND");
    const duplicate = pallet.lots.find((item) => item.id !== lot.id &&
      item.canonical === nextCanonical &&
      canonicalModel(item.model) === canonicalModel(model.modelNumber));
    if (duplicate) {
      const error = new Error("DUPLICATE_LOT");
      error.code = "DUPLICATE_LOT";
      throw error;
    }
    const nextTotal = palletTotal(pallet) - integer(lot.cases) + nextCases;
    if (nextTotal > positiveInteger(pallet.expectedBoxes)) {
      const error = new Error("The corrected box quantity exceeds the confirmed pallet total.");
      error.code = "APPROVED_BOX_COUNT_EXCEEDED";
      throw error;
    }

    const before = { lot: lot.lot, model: lot.model, cases: integer(lot.cases) };
    const at = timestamp();
    pallet.history = pallet.history.filter((entry) => entry.lotId !== lot.id);
    if (nextCases === 0) {
      pallet.lots = pallet.lots.filter((item) => item.id !== lot.id);
      const replacement = pallet.lots[0] || null;
      pallet.activeLotId = replacement?.id || null;
      pallet.activeModel = replacement?.model || pallet.models[0]?.modelNumber || "";
      session.activeModel = pallet.activeModel;
      session.sku = pallet.activeModel;
    } else {
      lot.lot = nextLotText;
      lot.canonical = nextCanonical;
      lot.model = model.modelNumber;
      lot.sku = model.modelNumber;
      lot.expectedModel = model.modelNumber;
      lot.caseQuantity = model.caseQuantity;
      lot.cases = nextCases;
      lot.verifiedAt = at;
      lot.verification = "manual";
      lot.captureMethod = "manual_edit";
      lot.validationMethod = "employee_correction";
      lot.confirmedBy = cleanText(session.employee, 60);
      pallet.history.push(...Array.from({ length: nextCases }, () => ({
        kind: "case", lotId: lot.id, at,
      })));
      pallet.activeLotId = lot.id;
      pallet.activeModel = model.modelNumber;
      session.activeModel = model.modelNumber;
      session.sku = model.modelNumber;
    }
    pallet.verificationState = "in_progress";
    pallet.verificationAttemptedAt = null;
    pallet.verifiedAt = null;
    return withActivity(session, nextCases === 0 ? "lot_removed" : "lot_corrected", {
      palletNumber: pallet.number,
      before,
      after: nextCases === 0 ? null : {
        lot: nextLotText, model: model.modelNumber, cases: nextCases,
      },
    });
  }

  function updateModelCaseQuantity(source, modelValue, quantity) {
    const session = sanitize(clone(source));
    if (session.status !== "active") throw new Error("COC_NOT_EDITABLE");
    const key = canonicalModel(modelValue);
    const next = positiveInteger(quantity);
    if (!key) throw new Error("MODEL_NOT_FOUND");
    if (!next) throw new Error("INVALID_CASE_QUANTITY");

    const matchingModels = [
      ...(session.models || []),
      ...session.pallets.flatMap((pallet) => pallet.models || []),
    ].filter((model) => canonicalModel(model.modelNumber) === key);
    const matchingLots = session.pallets.flatMap((pallet) => pallet.lots || [])
      .filter((lot) => canonicalModel(lot.model) === key);
    if (!matchingModels.length && !matchingLots.length) throw new Error("MODEL_NOT_FOUND");
    const previous = [...new Set([
      ...matchingModels.map((model) => positiveInteger(model.caseQuantity)),
      ...matchingLots.map((lot) => positiveInteger(lot.caseQuantity)),
    ].filter(Boolean))];

    matchingModels.forEach((model) => {
      model.caseQuantity = next;
      model.sourceRevision = "EMPLOYEE CORRECTED FOR THIS COC";
    });
    matchingLots.forEach((lot) => {
      lot.caseQuantity = next;
      lot.validationMethod = "employee_quantity_correction";
      lot.confirmedBy = cleanText(session.employee, 60);
    });
    const active = activePallet(session);
    if (active?.lots.some((lot) => canonicalModel(lot.model) === key)) {
      active.verificationState = "in_progress";
      active.verificationAttemptedAt = null;
      active.verifiedAt = null;
    }
    return withActivity(session, "case_quantity_corrected", {
      model: matchingModels[0]?.modelNumber || matchingLots[0]?.model || cleanModel(modelValue),
      previousCaseQuantities: previous,
      caseQuantity: next,
      scope: "current_coc",
    });
  }

  function updateModel(source, originalValue, replacement) {
    const session = sanitize(clone(source));
    const pallet = activePallet(session);
    if (!pallet || session.status !== "active") throw new Error("NO_ACTIVE_PALLET");
    const originalKey = canonicalModel(originalValue);
    const original = pallet.models.find(
      (model) => canonicalModel(model.modelNumber) === originalKey,
    );
    const normalized = normalizeModelRecord(replacement);
    if (!original) throw new Error("MODEL_NOT_FOUND");
    if (!normalized?.caseQuantity) throw new Error("MODEL_CASE_QUANTITY_REQUIRED");
    const replacementKey = canonicalModel(normalized.modelNumber);
    if (replacementKey === originalKey) throw new Error("MODEL_UNCHANGED");
    if (pallet.models.some((model) => canonicalModel(model.modelNumber) === replacementKey)) {
      const error = new Error("MODEL_ALREADY_ON_PALLET");
      error.code = "MODEL_ALREADY_ON_PALLET";
      throw error;
    }

    const sessionReplacement = session.models.find(
      (model) => canonicalModel(model.modelNumber) === replacementKey,
    );
    const selected = sessionReplacement || {
      ...normalized,
      sourceRevision: normalized.sourceRevision || "EMPLOYEE CORRECTED FOR THIS COC",
      addedAt: normalized.addedAt || timestamp(),
    };
    if (!sessionReplacement) session.models.push(selected);
    pallet.models = pallet.models.map((model) =>
      canonicalModel(model.modelNumber) === originalKey ? selected : model);
    pallet.modelNumbers = pallet.models.map((model) => model.modelNumber);
    const changedLots = pallet.lots.filter((lot) => canonicalModel(lot.model) === originalKey);
    changedLots.forEach((lot) => {
      lot.model = selected.modelNumber;
      lot.sku = selected.modelNumber;
      lot.expectedModel = selected.modelNumber;
      lot.caseQuantity = selected.caseQuantity;
      lot.validationMethod = "employee_sku_correction";
      lot.confirmedBy = cleanText(session.employee, 60);
    });
    pallet.activeModel = canonicalModel(pallet.activeModel) === originalKey
      ? selected.modelNumber : pallet.activeModel;
    session.activeModel = canonicalModel(session.activeModel) === originalKey
      ? selected.modelNumber : session.activeModel;
    session.sku = canonicalModel(session.sku) === originalKey
      ? selected.modelNumber : session.sku;

    const originalStillUsed = session.pallets.some((item) =>
      item.models.some((model) => canonicalModel(model.modelNumber) === originalKey) ||
      item.lots.some((lot) => canonicalModel(lot.model) === originalKey));
    if (!originalStillUsed) {
      session.models = session.models.filter(
        (model) => canonicalModel(model.modelNumber) !== originalKey,
      );
    }
    session.modelNumbers = session.models.map((model) => model.modelNumber);
    if (changedLots.length) {
      pallet.verificationState = "in_progress";
      pallet.verificationAttemptedAt = null;
      pallet.verifiedAt = null;
    }
    return withActivity(session, "model_corrected", {
      palletNumber: pallet.number,
      previousModel: original.modelNumber,
      model: selected.modelNumber,
      caseQuantity: selected.caseQuantity,
      affectedLots: changedLots.length,
      scope: "current_pallet",
    });
  }

  function addModel(source, record) {
    const session = sanitize(clone(source));
    const normalized = normalizeModelRecord(record);
    if (!normalized?.caseQuantity) throw new Error("MODEL_CASE_QUANTITY_REQUIRED");
    const pallet = activePallet(session);
    if (!pallet || session.status !== "active") throw new Error("NO_ACTIVE_PALLET");
    const existingOnPallet = pallet.models?.find(
      (model) => canonicalModel(model.modelNumber) === canonicalModel(normalized.modelNumber),
    );
    const existing = session.models?.find(
      (model) => canonicalModel(model.modelNumber) === canonicalModel(normalized.modelNumber),
    );
    const selected = existingOnPallet || existing || normalized;
    if (!existing) session.models.push(normalized);
    session.modelNumbers = session.models.map((model) => model.modelNumber);
    if (!existingOnPallet) pallet.models.push(selected);
    pallet.modelNumbers = pallet.models.map((model) => model.modelNumber);
    pallet.activeModel = selected.modelNumber;
    session.activeModel = selected.modelNumber;
    session.sku = session.activeModel;
    pallet.activeLotId = pallet.lots.find(
      (lot) => canonicalModel(lot.model) === canonicalModel(session.activeModel),
    )?.id || null;
    return withActivity(session, existingOnPallet ? "model_selected" : "model_added", {
      palletNumber: pallet.number,
      model: session.activeModel,
      caseQuantity: selected.caseQuantity,
    });
  }

  function selectModel(source, value) {
    const session = sanitize(clone(source));
    const pallet = activePallet(session);
    const selected = pallet?.models?.find(
      (model) => canonicalModel(model.modelNumber) === canonicalModel(value),
    );
    if (!selected?.caseQuantity) throw new Error("MODEL_NOT_FOUND");
    pallet.activeModel = selected.modelNumber;
    session.activeModel = selected.modelNumber;
    session.sku = selected.modelNumber;
    pallet.activeLotId = [...pallet.lots].reverse().find(
      (lot) => canonicalModel(lot.model) === canonicalModel(selected.modelNumber),
    )?.id || null;
    return withActivity(session, "model_selected", {
      palletNumber: pallet?.number,
      model: selected.modelNumber,
    });
  }

  // A model may be removed from the active pallet only while it has no
  // recorded lots. This prevents a correction from silently re-labeling
  // compliance evidence that has already been counted.
  function removeModel(source, value) {
    const session = sanitize(clone(source));
    const pallet = activePallet(session);
    const selected = pallet?.models?.find(
      (model) => canonicalModel(model.modelNumber) === canonicalModel(value),
    );
    if (!pallet || !selected) throw new Error("MODEL_NOT_FOUND");
    if (pallet.models.length <= 1) throw new Error("LAST_MODEL_REQUIRED");
    if (pallet.lots.some((lot) => canonicalModel(lot.model) === canonicalModel(selected.modelNumber))) {
      const error = new Error("MODEL_HAS_RECORDED_LOTS");
      error.code = "MODEL_HAS_RECORDED_LOTS";
      throw error;
    }
    pallet.models = pallet.models.filter(
      (model) => canonicalModel(model.modelNumber) !== canonicalModel(selected.modelNumber),
    );
    pallet.modelNumbers = pallet.models.map((model) => model.modelNumber);
    if (canonicalModel(pallet.activeModel) === canonicalModel(selected.modelNumber)) {
      pallet.activeModel = pallet.models[0].modelNumber;
      session.activeModel = pallet.activeModel;
      session.sku = pallet.activeModel;
      pallet.activeLotId = null;
    }
    return withActivity(session, "model_removed", {
      palletNumber: pallet.number,
      model: selected.modelNumber,
    });
  }

  function addCase(source) {
    const session = sanitize(clone(source));
    const pallet = activePallet(session);
    const lot = pallet?.lots.find((item) => item.id === pallet.activeLotId);
    if (!pallet || !lot) throw new Error("NO_ACTIVE_LOT");
    assertBoxCapacity(pallet);
    lot.cases += 1;
    pallet.history.push({ kind: "case", lotId: lot.id, at: timestamp() });
    pallet.verificationState = "in_progress";
    pallet.verificationAttemptedAt = null;
    pallet.verifiedAt = null;
    return withActivity(session, "case_added", {
      palletNumber: pallet.number,
      lot: lot.lot,
      cases: lot.cases,
    });
  }

  function undoCase(source, targetLotId = null) {
    const session = sanitize(clone(source));
    const pallet = activePallet(session);
    if (!pallet) throw new Error("NOTHING_TO_UNDO");
    const entryIndex = targetLotId
      ? pallet.history.map((entry) => entry.lotId).lastIndexOf(targetLotId)
      : pallet.history.length - 1;
    if (entryIndex < 0) throw new Error("NOTHING_TO_UNDO");
    const [entry] = pallet.history.splice(entryIndex, 1);
    if (!positiveInteger(pallet.expectedBoxes)) throw new Error("EXPECTED_BOX_COUNT_REQUIRED");
    const lot = pallet.lots.find((item) => item.id === entry.lotId);
    if (!lot || lot.cases < 1) throw new Error("NOTHING_TO_UNDO");
    lot.cases -= 1;
    if (lot.cases === 0) {
      pallet.lots = pallet.lots.filter((item) => item.id !== lot.id);
      const replacement = [...pallet.lots].reverse().find(
        (item) => canonicalModel(item.model) === canonicalModel(session.activeModel),
      ) || pallet.lots[0];
      pallet.activeLotId = replacement?.id || null;
      if (replacement?.model) {
        pallet.activeModel = replacement.model;
        session.activeModel = replacement.model;
        session.sku = replacement.model;
      }
    } else {
      pallet.activeLotId = lot.id;
    }
    pallet.verificationState = "in_progress";
    pallet.verificationAttemptedAt = null;
    pallet.verifiedAt = null;
    return withActivity(session, "case_undone", {
      palletNumber: pallet.number,
      lot: lot.lot,
      cases: lot.cases,
    });
  }

  function setExpectedBoxCount(source, value) {
    const session = sanitize(clone(source));
    const pallet = activePallet(session);
    if (!pallet || session.status !== "active") throw new Error("NO_ACTIVE_PALLET");
    const next = positiveInteger(value);
    if (!next) throw new Error("INVALID_EXPECTED_BOX_COUNT");
    if (next < palletTotal(pallet)) {
      const error = new Error("The approved box count cannot be lower than the boxes already recorded.");
      error.code = "EXPECTED_BOX_COUNT_BELOW_RECORDED";
      throw error;
    }
    const previous = positiveInteger(pallet.expectedBoxes);
    const at = timestamp();
    if (previous && previous !== next) {
      pallet.expectedBoxHistory = [...(pallet.expectedBoxHistory || []), { previous, next, at }]
        .slice(-1000);
      pallet.expectedBoxesUpdatedAt = at;
    }
    pallet.expectedBoxes = next;
    pallet.expectedBoxesConfirmedAt = pallet.expectedBoxesConfirmedAt || at;
    pallet.expectedBoxesInferred = false;
    pallet.verificationState = "in_progress";
    pallet.verificationAttemptedAt = null;
    pallet.verifiedAt = null;
    return withActivity(session, previous && previous !== next
      ? "expected_boxes_changed"
      : "expected_boxes_confirmed", {
      palletNumber: pallet.number,
      previousExpectedBoxes: previous,
      expectedBoxes: next,
    });
  }

  function verifyPallet(source) {
    const session = sanitize(clone(source));
    const pallet = activePallet(session);
    if (!pallet || session.status !== "active") throw new Error("NO_ACTIVE_PALLET");
    const progress = palletProgress(pallet);
    if (!progress.expected) throw new Error("EXPECTED_BOX_COUNT_REQUIRED");
    const at = timestamp();
    pallet.verificationAttemptedAt = at;
    pallet.verificationState = progress.recorded === progress.expected
      ? "verified"
      : "count_mismatch";
    pallet.verifiedAt = progress.recorded === progress.expected ? at : null;
    withActivity(session, progress.recorded === progress.expected
      ? "pallet_boxes_verified"
      : "pallet_box_mismatch", {
      palletNumber: pallet.number,
      expectedBoxes: progress.expected,
      recordedBoxes: progress.recorded,
      difference: progress.difference,
    });
    return {
      session,
      verified: progress.recorded === progress.expected,
      expected: progress.expected,
      recorded: progress.recorded,
      difference: progress.difference,
    };
  }

  function finishPallet(source) {
    const session = sanitize(clone(source));
    const pallet = activePallet(session);
    if (!pallet) throw new Error("NO_ACTIVE_PALLET");
    const progress = palletProgress(pallet);
    if (!progress.expected) throw new Error("EXPECTED_BOX_COUNT_REQUIRED");
    if (progress.recorded !== progress.expected) throw new Error("BOX_COUNT_MISMATCH");
    if (pallet.verificationState !== "verified") throw new Error("PALLET_NOT_VERIFIED");
    const at = timestamp();
    pallet.status = "locked";
    pallet.finishedAt = at;
    pallet.verificationState = "completed";
    pallet.reopenedForEdit = false;
    pallet.activeLotId = null;
    const next = createPallet(session.pallets.length + 1);
    session.pallets.push(next);
    session.activePalletId = next.id;
    session.activeModel = "";
    session.sku = "";
    return withActivity(session, "pallet_finished", {
      palletNumber: pallet.number,
      expectedBoxes: progress.expected,
      recordedBoxes: progress.recorded,
    });
  }

  function reopenPallet(source, palletId) {
    const session = sanitize(clone(source));
    const target = session.pallets.find(
      (pallet) => pallet.id === palletId && pallet.status === "locked",
    );
    if (!target) throw new Error("LOCKED_PALLET_NOT_FOUND");
    if (session.status === "active") {
      const current = activePallet(session);
      if (current && (palletTotal(current) > 0 || current.expectedBoxes))
        throw new Error("ACTIVE_PALLET_IN_PROGRESS");
      session.pallets = session.pallets.filter((pallet) => pallet.id !== current?.id);
    } else {
      session.status = "active";
      session.completedAt = null;
    }
    target.status = "active";
    target.finishedAt = null;
    target.verificationState = "in_progress";
    target.verificationAttemptedAt = null;
    target.verifiedAt = null;
    target.reopenedForEdit = true;
    target.activeLotId = target.lots[0]?.id || null;
    target.activeModel = target.lots[0]?.model || target.models?.[0]?.modelNumber || "";
    session.activeModel = target.activeModel;
    session.sku = target.activeModel;
    session.activePalletId = target.id;
    session.pallets.forEach((pallet) => {
      if (pallet.id !== target.id) {
        pallet.status = "locked";
        pallet.activeLotId = null;
        pallet.reopenedForEdit = false;
      }
    });
    return withActivity(session, "pallet_reopened", {
      palletNumber: target.number,
      expectedBoxes: target.expectedBoxes,
      recordedBoxes: palletTotal(target),
    });
  }

  function returnToVerifiedPallet(source) {
    const session = sanitize(clone(source));
    if (session.status !== "report") throw new Error("COMPLETED_COC_REQUIRED");
    const target = [...session.pallets].reverse().find((pallet) =>
      pallet.status === "locked" && palletTotal(pallet) > 0,
    );
    if (!target) throw new Error("COMPLETED_PALLET_NOT_FOUND");
    const progress = palletProgress(target);
    if (!progress.expected || progress.recorded !== progress.expected)
      throw new Error("BOX_COUNT_MISMATCH");

    session.status = "active";
    session.completedAt = null;
    session.activePalletId = target.id;
    target.status = "active";
    target.finishedAt = null;
    target.verificationState = "verified";
    target.verificationAttemptedAt = target.verificationAttemptedAt || target.verifiedAt || timestamp();
    target.verifiedAt = target.verifiedAt || target.verificationAttemptedAt;
    target.reopenedForEdit = false;
    const selectedLot = [...target.lots].reverse().find((lot) => lot.cases > 0) || target.lots[0];
    target.activeLotId = selectedLot?.id || null;
    target.activeModel = selectedLot?.model || target.models?.[0]?.modelNumber || "";
    session.activeModel = target.activeModel;
    session.sku = target.activeModel;
    session.pallets.forEach((pallet) => {
      if (pallet.id === target.id) return;
      pallet.status = "locked";
      pallet.activeLotId = null;
      pallet.reopenedForEdit = false;
    });
    return withActivity(session, "session_returned_to_verified_pallet", {
      palletNumber: target.number,
      expectedBoxes: progress.expected,
      recordedBoxes: progress.recorded,
    });
  }

  function completeSession(source) {
    const session = sanitize(clone(source));
    const pallet = activePallet(session);
    const activeRecorded = pallet ? palletTotal(pallet) : 0;
    const activeHasWork = Boolean(pallet && (
      activeRecorded > 0 || positiveInteger(pallet.expectedBoxes)
    ));
    if (activeHasWork) {
      const progress = palletProgress(pallet);
      if (!progress.expected) throw new Error("EXPECTED_BOX_COUNT_REQUIRED");
      if (progress.recorded !== progress.expected) throw new Error("BOX_COUNT_MISMATCH");
      if (!progress.verified) throw new Error("PALLET_NOT_VERIFIED");
      const at = timestamp();
      pallet.status = "locked";
      pallet.finishedAt = pallet.finishedAt || at;
      pallet.verificationState = "completed";
      pallet.reopenedForEdit = false;
      pallet.activeLotId = null;
      withActivity(session, "pallet_finished", {
        palletNumber: pallet.number,
        expectedBoxes: progress.expected,
        recordedBoxes: progress.recorded,
        finalPallet: true,
      });
    }
    const completed = session.pallets.filter(
      (item) => item.status === "locked" && (item.lots.length || palletTotal(item) > 0),
    );
    if (!completed.length) throw new Error("NO_COMPLETED_PALLETS");
    if (completed.some((item) => palletTotal(item) > positiveInteger(item.expectedBoxes)))
      throw new Error("APPROVED_BOX_COUNT_EXCEEDED");
    if (completed.some((item) => item.lots.some((lot) =>
      !lot.model || !positiveInteger(lot.caseQuantity))))
      throw new Error("MODEL_CASE_QUANTITY_REQUIRED");
    session.pallets = completed.map((item, index) => ({
      ...item,
      number: index + 1,
      status: "locked",
      activeLotId: null,
    }));
    session.activePalletId = null;
    session.status = "report";
    session.completedAt = timestamp();
    return withActivity(session, "session_completed", {
      pallets: session.pallets.length,
      totalBoxes: sessionTotal(session),
    });
  }

  function validateTotals(session) {
    const safe = sanitize(clone(session));
    return {
      pallets: safe.pallets.length,
      totalCases: sessionTotal(safe),
      totalUnits: sessionUnitTotal(safe),
      totals: safe.pallets.map((pallet) => palletTotal(pallet)),
      boxVerification: safe.pallets.map((pallet) => ({
        palletNumber: pallet.number,
        ...palletProgress(pallet),
      })),
    };
  }

  global.AtlasCocCore = Object.freeze({
    SCHEMA_VERSION,
    createSession,
    sanitize,
    activePallet,
    palletTotal,
    sessionTotal,
    sessionUnitTotal,
    lotUnitQuantity,
    modelRecord,
    palletModels,
    palletProgress,
    boxLimitMessage,
    assertBoxCapacity,
    canonicalLot,
    displayLot,
    addLot,
    addModel,
    selectModel,
    removeModel,
    selectLot,
    updateLot,
    updateModelCaseQuantity,
    updateModel,
    addActiveDuration,
    recordScanOutcome,
    addCase,
    undoCase,
    setExpectedBoxCount,
    verifyPallet,
    finishPallet,
    reopenPallet,
    returnToVerifiedPallet,
    completeSession,
    validateTotals,
  });
})(window);
