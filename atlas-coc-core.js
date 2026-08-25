(function (global) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const MAX_ORDER_LENGTH = 80;
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
    if (!raw) return "";
    if (/^[A-Z0-9]+$/i.test(raw) && raw.length > 8)
      return raw.replace(/(.{4})/g, "$1 ").trim();
    return raw;
  };
  const integer = (value) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
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
    };
  }

  function createSession({ orderNumber = "", deviceId = "", employee = "" } = {}) {
    const createdAt = timestamp();
    const pallet = createPallet(1);
    return {
      schemaVersion: SCHEMA_VERSION,
      id: makeId("coc"),
      deviceId: cleanText(deviceId, 100),
      orderNumber: cleanText(orderNumber, MAX_ORDER_LENGTH),
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
      return {
        id,
        number: index + 1,
        status: source?.status === "locked" ? "locked" : "active",
        createdAt: cleanText(source?.createdAt, 40) || timestamp(),
        finishedAt: cleanText(source?.finishedAt, 40) || null,
        activeLotId: lotIds.has(source?.activeLotId)
          ? source.activeLotId
          : lots[0]?.id || null,
        lots,
        history,
      };
    });
    if (!pallets.length && raw.status !== "report") pallets.push(createPallet(1));
    const status = raw.status === "report" ? "report" : "active";
    let activePalletId = cleanText(raw.activePalletId, 140);
    if (status === "active") {
      const active = pallets.find((pallet) => pallet.id === activePalletId) ||
        pallets.find((pallet) => pallet.status === "active") || pallets[pallets.length - 1];
      activePalletId = active?.id || null;
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
      orderNumber: cleanText(raw.orderNumber, MAX_ORDER_LENGTH),
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
    };
    pallet.lots.push(lot);
    pallet.activeLotId = lot.id;
    pallet.history.push({ kind: "case", lotId: lot.id, at });
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
    lot.cases += 1;
    pallet.history.push({ kind: "case", lotId: lot.id, at: timestamp() });
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
    const lot = pallet.lots.find((item) => item.id === entry.lotId);
    if (!lot || lot.cases < 1) throw new Error("NOTHING_TO_UNDO");
    lot.cases -= 1;
    if (lot.cases === 0) {
      pallet.lots = pallet.lots.filter((item) => item.id !== lot.id);
      pallet.activeLotId = pallet.lots[0]?.id || null;
    } else {
      pallet.activeLotId = lot.id;
    }
    return withActivity(session, "case_undone", {
      palletNumber: pallet.number,
      lot: lot.lot,
      cases: lot.cases,
    });
  }

  function finishPallet(source) {
    const session = sanitize(clone(source));
    const pallet = activePallet(session);
    if (!pallet) throw new Error("NO_ACTIVE_PALLET");
    const at = timestamp();
    pallet.status = "locked";
    pallet.finishedAt = at;
    pallet.activeLotId = null;
    const next = createPallet(session.pallets.length + 1);
    session.pallets.push(next);
    session.activePalletId = next.id;
    return withActivity(session, "pallet_finished", {
      palletNumber: pallet.number,
      totalCases: palletTotal(pallet),
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
      totalCases: sessionTotal(session),
    });
  }

  function validateTotals(session) {
    const safe = sanitize(clone(session));
    return {
      pallets: safe.pallets.length,
      totalCases: sessionTotal(safe),
      totals: safe.pallets.map((pallet) => palletTotal(pallet)),
    };
  }

  global.AtlasCocCore = Object.freeze({
    SCHEMA_VERSION,
    createSession,
    sanitize,
    activePallet,
    palletTotal,
    sessionTotal,
    canonicalLot,
    displayLot,
    addLot,
    selectLot,
    addCase,
    undoCase,
    finishPallet,
    completeSession,
    validateTotals,
  });
})(window);
