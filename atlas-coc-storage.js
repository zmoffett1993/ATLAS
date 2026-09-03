(function (global) {
  "use strict";

  const DB_NAME = "atlas-coc-device-v2";
  const DB_VERSION = 2;
  const COMPLETED = "completedCocs";
  const PENDING = "pendingCocSends";
  const SETTINGS = "receiverSettings";
  const SCANNER_EVENTS = "scannerEvents";

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("INDEXEDDB_REQUEST_FAILED"));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("INDEXEDDB_TRANSACTION_FAILED"));
      transaction.onabort = () => reject(transaction.error || new Error("INDEXEDDB_TRANSACTION_ABORTED"));
    });
  }

  function openDatabase() {
    if (!global.indexedDB) return Promise.reject(new Error("INDEXEDDB_UNAVAILABLE"));
    return new Promise((resolve, reject) => {
      const request = global.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(COMPLETED)) {
          const store = database.createObjectStore(COMPLETED, { keyPath: "cocId" });
          store.createIndex("user_completed", ["userId", "completedAt"], { unique: false });
          store.createIndex("delivery_id", "officeTransferId", { unique: false });
        }
        if (!database.objectStoreNames.contains(PENDING)) {
          const store = database.createObjectStore(PENDING, { keyPath: "cocId" });
          store.createIndex("user_updated", ["userId", "updatedAt"], { unique: false });
        }
        if (!database.objectStoreNames.contains(SETTINGS)) {
          database.createObjectStore(SETTINGS, { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains(SCANNER_EVENTS)) {
          const store = database.createObjectStore(SCANNER_EVENTS, { keyPath: "eventId" });
          store.createIndex("user_updated", ["userId", "updatedAt"], { unique: false });
          store.createIndex("retry_at", "nextRetryAt", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("INDEXEDDB_OPEN_FAILED"));
      request.onblocked = () => reject(new Error("INDEXEDDB_UPGRADE_BLOCKED"));
    });
  }

  async function withStore(storeName, mode, operation) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const result = await operation(store, transaction);
      await transactionDone(transaction);
      return result;
    } finally {
      database.close();
    }
  }

  function text(value, maximum = 200) {
    return String(value ?? "").trim().slice(0, maximum);
  }

  function completedRecord(record) {
    const workbookBlob = record?.workbookBlob instanceof Blob
      ? record.workbookBlob
      : new Blob([record?.workbookBlob || new Uint8Array()], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
    const normalized = {
      cocId: text(record?.cocId, 140),
      userId: text(record?.userId, 140),
      customerName: text(record?.customerName, 160).toUpperCase(),
      invoiceNumber: text(record?.invoiceNumber, 80),
      ifNumber: text(record?.ifNumber, 80),
      completedAt: text(record?.completedAt, 40),
      palletCount: Math.max(0, Number(record?.palletCount) || 0),
      totalConfirmedBoxes: Math.max(0, Number(record?.totalConfirmedBoxes) || 0),
      modelCount: Math.max(0, Number(record?.modelCount) || 0),
      reportSnapshot: structuredClone(record?.reportSnapshot || {}),
      workbookFileName: text(record?.workbookFileName, 160),
      workbookBlob,
      officeTransferStatus: text(record?.officeTransferStatus || "WAREHOUSE_COMPLETE", 40).toUpperCase(),
      officeTransferId: text(record?.officeTransferId || record?.receiptId, 140) || null,
      sentAt: text(record?.sentAt, 40) || null,
      receivedAt: text(record?.receivedAt, 40) || null,
      officeCompletedAt: text(record?.officeCompletedAt, 40) || null,
      updatedAt: new Date().toISOString(),
    };
    if (!normalized.cocId || !normalized.userId || !normalized.completedAt || !normalized.workbookFileName)
      throw new Error("COMPLETED_COC_RECORD_INVALID");
    return normalized;
  }

  async function upsertCompleted(record) {
    const normalized = completedRecord(record);
    return withStore(COMPLETED, "readwrite", async (store) => {
      const prior = await requestResult(store.get(normalized.cocId));
      if (prior?.userId && prior.userId !== normalized.userId)
        throw new Error("COMPLETED_COC_OWNER_MISMATCH");
      const merged = { ...prior, ...normalized };
      await requestResult(store.put(merged));
      return merged;
    });
  }

  async function listCompleted(userId) {
    const owner = text(userId, 140);
    if (!owner) return [];
    return withStore(COMPLETED, "readonly", async (store) => {
      const records = await requestResult(store.getAll());
      return records
        .filter((record) => record?.userId === owner)
        .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)));
    });
  }

  async function getCompleted(cocId, userId) {
    return withStore(COMPLETED, "readonly", async (store) => {
      const record = await requestResult(store.get(text(cocId, 140)));
      return record?.userId === text(userId, 140) ? record : null;
    });
  }

  async function clearCompletedForUser(userId) {
    const owner = text(userId, 140);
    if (!owner) throw new Error("COMPLETED_COC_OWNER_REQUIRED");
    return withStore(COMPLETED, "readwrite", async (store) => {
      const records = await requestResult(store.getAll());
      const owned = records.filter((record) => record?.userId === owner);
      await Promise.all(owned.map((record) => requestResult(store.delete(record.cocId))));
      return owned.length;
    });
  }

  async function updateDeliveryStatus(cocId, userId, status = {}) {
    return withStore(COMPLETED, "readwrite", async (store) => {
      const record = await requestResult(store.get(text(cocId, 140)));
      if (!record || record.userId !== text(userId, 140)) return null;
      const next = {
        ...record,
        officeTransferStatus: text(status.officeTransferStatus || status.status, 40).toUpperCase() || record.officeTransferStatus,
        sentAt: text(status.sentAt || status.sent_at, 40) || record.sentAt || null,
        receivedAt: text(status.receivedAt || status.received_at, 40) || record.receivedAt || null,
        officeCompletedAt: text(status.officeCompletedAt || status.office_completed_at, 40) || record.officeCompletedAt || null,
        updatedAt: new Date().toISOString(),
      };
      await requestResult(store.put(next));
      return next;
    });
  }

  async function putPending(record) {
    const normalized = {
      ...structuredClone({ ...record, workbookBlob: undefined }),
      cocId: text(record?.cocId, 140),
      userId: text(record?.userId, 140),
      workbookBlob: record?.workbookBlob instanceof Blob
        ? record.workbookBlob
        : new Blob([record?.workbookBlob || new Uint8Array()], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      updatedAt: new Date().toISOString(),
    };
    if (!normalized.cocId || !normalized.userId) throw new Error("PENDING_COC_RECORD_INVALID");
    await withStore(PENDING, "readwrite", (store) => requestResult(store.put(normalized)));
    return normalized;
  }

  async function getPending(cocId, userId) {
    return withStore(PENDING, "readonly", async (store) => {
      const record = await requestResult(store.get(text(cocId, 140)));
      return record?.userId === text(userId, 140) ? record : null;
    });
  }

  async function deletePending(cocId) {
    await withStore(PENDING, "readwrite", (store) => requestResult(store.delete(text(cocId, 140))));
  }

  async function getSetting(key) {
    return withStore(SETTINGS, "readonly", (store) => requestResult(store.get(text(key, 120))));
  }

  async function setSetting(key, value) {
    const record = { key: text(key, 120), value: structuredClone(value), updatedAt: new Date().toISOString() };
    await withStore(SETTINGS, "readwrite", (store) => requestResult(store.put(record)));
    return record.value;
  }

  async function deleteSetting(key) {
    await withStore(SETTINGS, "readwrite", (store) => requestResult(store.delete(text(key, 120))));
  }

  function scannerEventRecord(event) {
    const normalized = {
      eventId: text(event?.eventId, 140),
      userId: text(event?.userId, 140),
      warehouseCode: text(event?.warehouseCode || "CA", 8).toUpperCase(),
      payload: structuredClone(event?.payload || {}),
      attempts: Math.max(0, Number(event?.attempts) || 0),
      nextRetryAt: text(event?.nextRetryAt || new Date().toISOString(), 40),
      lastError: text(event?.lastError, 300) || null,
      createdAt: text(event?.createdAt || new Date().toISOString(), 40),
      updatedAt: new Date().toISOString(),
    };
    if (!normalized.eventId || !normalized.userId) throw new Error("SCANNER_EVENT_INVALID");
    return normalized;
  }

  async function putScannerEvent(event) {
    const normalized = scannerEventRecord(event);
    await withStore(SCANNER_EVENTS, "readwrite", (store) => requestResult(store.put(normalized)));
    return normalized;
  }

  async function listScannerEvents(userId) {
    const owner = text(userId, 140);
    if (!owner) return [];
    return withStore(SCANNER_EVENTS, "readonly", async (store) => {
      const records = await requestResult(store.getAll());
      return records
        .filter((record) => record?.userId === owner)
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    });
  }

  async function deleteScannerEvent(eventId) {
    await withStore(SCANNER_EVENTS, "readwrite", (store) => requestResult(store.delete(text(eventId, 140))));
  }

  function downloadBlob(blob, fileName) {
    if (!(blob instanceof Blob)) throw new Error("WORKBOOK_BLOB_MISSING");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = text(fileName, 160) || "Company_COC.xlsx";
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    global.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  global.AtlasCocStorage = Object.freeze({
    DB_NAME,
    upsertCompleted,
    listCompleted,
    getCompleted,
    clearCompletedForUser,
    updateDeliveryStatus,
    putPending,
    getPending,
    deletePending,
    getSetting,
    setSetting,
    deleteSetting,
    putScannerEvent,
    listScannerEvents,
    deleteScannerEvent,
    downloadBlob,
  });
})(window);
