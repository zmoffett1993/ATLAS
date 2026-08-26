(function (global) {
  "use strict";

  const SCHEMA_VERSION = 3;
  const MAX_INVOICE_LENGTH = 80;
  const MAX_LOT_LENGTH = 120;

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const timestamp = () => new Date().toISOString();
  const makeId = (prefix) => {
    const id = global.crypto?.randomUUID?.() ||
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    return `${prefix}-${id}`;
  };
  const cleanText = (value, max) => String(value || "").trim().slice(0, max);
  const cleanLot = (value) => cleanText(value, MAX_LOT_LENGTH);
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

  function createPallet(number) {
    return {
      id: makeId("pallet"),
      number,
      status: "active",
      createdAt: timestamp(),
      finishedAt: null,
      activeLotId: null,
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
    };
  }

  function createSession({ invoiceNumber = "", orderNumber = "", deviceId = "", employee = "" } = {}) {
    const createdAt = timestamp();
    const pallet = createPallet(1);
    const invoice = cleanText(invoiceNumber || orderNumber, MAX_INVOICE_LENGTH);
    if (!invoice) throw new Error("INVOICE_REQUIRED");
    return {
      schemaVersion: SCHEMA_VERSION,
      id: makeId("coc"),
      deviceId: cleanText(deviceId, 100),
      invoiceNumber: invoice,
      employee: cleanText(employee, 60),
      status: "active",
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
      activePalletId: pallet.id,
      pallets: [pallet],
      activity: [{ type: "session_started", at: createdAt }],
    };
  }

  function sanitize(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.pallets))
      throw new Error("INVALID_COC_STATE");
    const seenPallets = new Set();
    const pallets = raw.pallets.slice(0, 500).map((source, index) => {
      const id = cleanText(source?.id, 140) || makeId("pallet");
      if (seenPallets.has(id)) throw new Error("DUPLICATE_PALLET_ID");
      seenPallets.add(id);
      const seenLots = new Set();
      const lots = (Array.isArray(source?.lots) ? source.lots : [])
        .slice(0, 500)
        .map((lot) => {
          const rawLot = cleanLot(lot?.lot);
          const canonical = canonicalLot(rawLot);
          if (!canonical) throw new Error("INVALID_LOT");
          if (seenLots.has(canonical)) throw new Error("DUPLICATE_LOT");
          seenLots.add(canonical);
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
            rawBatchText: cleanText(lot?.rawBatchText, MAX_LOT_LENGTH),
            model: cleanText(lot?.model, MAX_LOT_LENGTH).toUpperCase(),
            captureMethod: cleanText(
              lot?.captureMethod || lot?.verification || "manual",
              40,
            ),
            validationMethod: cleanText(lot?.validationMethod, 80),
            captureConfidence: Number.isFinite(Number(lot?.captureConfidence ?? lot?.ocrConfidence))
              ? Math.max(0, Math.min(100, Number(lot.captureConfidence ?? lot.ocrConfidence)))
              : null,
            confirmedBy: cleanText(lot?.confirmedBy, 60),
          };
        });
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
      return {
        id,
        number: index + 1,
        status: isLocked ? "locked" : "active",
        createdAt: cleanText(source?.createdAt, 40) || timestamp(),
        finishedAt: cleanText(source?.finishedAt, 40) || null,
        activeLotId: lotIds.has(source?.activeLotId)
          ? source.activeLotId
          : lots[0]?.id || null,
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
      };
    });
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
    return {
      schemaVersion: SCHEMA_VERSION,
      id: cleanText(raw.id, 140) || makeId("coc"),
      deviceId: cleanText(raw.deviceId, 100),
      invoiceNumber: cleanText(raw.invoiceNumber || raw.orderNumber, MAX_INVOICE_LENGTH),
      employee: cleanText(raw.employee, 60),
      status,
      createdAt: cleanText(raw.createdAt, 40) || timestamp(),
      updatedAt: cleanText(raw.updatedAt, 40) || timestamp(),
      completedAt: cleanText(raw.completedAt, 40) || null,
      activePalletId,
      pallets,
      activity: (Array.isArray(raw.activity) ? raw.activity : []).slice(-2000),
    };
  }

  const activePallet = (session) =>
    session?.pallets?.find((pallet) => pallet.id === session.activePalletId) || null;
  const palletTotal = (pallet) =>
    (pallet?.lots || []).reduce((total, lot) => total + integer(lot.cases), 0);
  const sessionTotal = (session) =>
    (session?.pallets || []).reduce((total, pallet) => total + palletTotal(pallet), 0);
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

  function withActivity(session, type, detail = {}) {
    session.updatedAt = timestamp();
    session.activity = [...(session.activity || []), { type, at: session.updatedAt, ...detail }]
      .slice(-2000);
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
    const duplicate = pallet.lots.find((lot) => lot.canonical === canonical);
    if (duplicate) return { session, duplicate };
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
      rawBatchText: cleanText(options.rawBatchText, MAX_LOT_LENGTH),
      model: cleanText(options.model, MAX_LOT_LENGTH).toUpperCase(),
      captureMethod: cleanText(options.captureMethod || options.verification || "manual", 40),
      validationMethod: cleanText(options.validationMethod, 80),
      captureConfidence: Number.isFinite(Number(options.confidence))
        ? Math.max(0, Math.min(100, Number(options.confidence)))
        : null,
      confirmedBy: cleanText(options.confirmedBy || session.employee, 60),
    };
    pallet.lots.push(lot);
    pallet.activeLotId = lot.id;
    pallet.history.push({ kind: "case", lotId: lot.id, at });
    pallet.verificationState = "in_progress";
    pallet.verificationAttemptedAt = null;
    pallet.verifiedAt = null;
    withActivity(session, "lot_added", { palletNumber: pallet.number, lot: lot.lot });
    return { session, lot, duplicate: null };
  }

  function selectLot(source, lotId) {
    const session = sanitize(clone(source));
    const pallet = activePallet(session);
    if (!pallet || !pallet.lots.some((lot) => lot.id === lotId))
      throw new Error("LOT_NOT_FOUND");
    pallet.activeLotId = lotId;
    return withActivity(session, "lot_selected", { palletNumber: pallet.number, lotId });
  }

  function addCase(source) {
    const session = sanitize(clone(source));
    const pallet = activePallet(session);
    const lot = pallet?.lots.find((item) => item.id === pallet.activeLotId);
    if (!pallet || !lot) throw new Error("NO_ACTIVE_LOT");
    if (!positiveInteger(pallet.expectedBoxes)) throw new Error("EXPECTED_BOX_COUNT_REQUIRED");
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

  function undoCase(source) {
    const session = sanitize(clone(source));
    const pallet = activePallet(session);
    const entry = pallet?.history.pop();
    if (!pallet || !entry) throw new Error("NOTHING_TO_UNDO");
    if (!positiveInteger(pallet.expectedBoxes)) throw new Error("EXPECTED_BOX_COUNT_REQUIRED");
    const lot = pallet.lots.find((item) => item.id === entry.lotId);
    if (!lot || lot.cases < 1) throw new Error("NOTHING_TO_UNDO");
    lot.cases -= 1;
    if (lot.cases === 0) {
      pallet.lots = pallet.lots.filter((item) => item.id !== lot.id);
      pallet.activeLotId = pallet.lots[0]?.id || null;
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
    pallet.activeLotId = null;
    const next = createPallet(session.pallets.length + 1);
    session.pallets.push(next);
    session.activePalletId = next.id;
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
    target.activeLotId = target.lots[0]?.id || null;
    session.activePalletId = target.id;
    session.pallets.forEach((pallet) => {
      if (pallet.id !== target.id) {
        pallet.status = "locked";
        pallet.activeLotId = null;
      }
    });
    return withActivity(session, "pallet_reopened", {
      palletNumber: target.number,
      expectedBoxes: target.expectedBoxes,
      recordedBoxes: palletTotal(target),
    });
  }

  function completeSession(source) {
    const session = sanitize(clone(source));
    const pallet = activePallet(session);
    if (pallet && palletTotal(pallet) > 0) throw new Error("FINISH_ACTIVE_PALLET_FIRST");
    const completed = session.pallets.filter(
      (item) => item.status === "locked" && (item.lots.length || palletTotal(item) > 0),
    );
    if (!completed.length) throw new Error("NO_COMPLETED_PALLETS");
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
    palletProgress,
    canonicalLot,
    displayLot,
    addLot,
    selectLot,
    addCase,
    undoCase,
    setExpectedBoxCount,
    verifyPallet,
    finishPallet,
    reopenPallet,
    completeSession,
    validateTotals,
  });
})(window);
