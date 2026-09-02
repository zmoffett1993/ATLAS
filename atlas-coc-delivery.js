(function (global) {
  "use strict";

  const DEFAULT_WAREHOUSE_CODE = "CA";
  const WAREHOUSE_SELECTION_KEY = "atlas-selected-warehouse-v1";
  const PROJECT_REF = "dwrrbpiprcmajfyronlf";
  const AUTH_STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;
  const RECEIVER_SETTING_PREFIX = "office-coc-receiver-credentials";
  const MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  const clean = (value, maximum = 240) => String(value ?? "").trim().slice(0, maximum);
  let cachedWarehouseContext = null;

  function requestedWarehouseCode() {
    const user = currentUser();
    const roles = userRoles(user);
    const metadata = user?.app_metadata || {};
    const home = clean(metadata.home_warehouse_code || metadata.warehouse_code || DEFAULT_WAREHOUSE_CODE, 8).toUpperCase();
    if (!["admin", "administrator"].some((role) => roles.has(role))) return home;
    return clean(global.localStorage?.getItem(WAREHOUSE_SELECTION_KEY) || home, 8).toUpperCase();
  }

  async function warehouseContext({ force = false, warehouseCode = "" } = {}) {
    const requested = clean(warehouseCode || requestedWarehouseCode(), 8).toUpperCase();
    if (!force && cachedWarehouseContext?.selectedWarehouse?.code === requested) return cachedWarehouseContext;
    const result = await edgeRequest("coc-receiver", { action: "warehouse-context", warehouseCode: requested });
    cachedWarehouseContext = result;
    return result;
  }

  function activeStationKey() {
    const requested = requestedWarehouseCode();
    return cachedWarehouseContext?.selectedWarehouse?.code === requested
      ? cachedWarehouseContext.station?.key
      : stationKeyForWarehouse(requested);
  }

  function activeStationName() {
    const requested = requestedWarehouseCode();
    return cachedWarehouseContext?.selectedWarehouse?.code === requested
      ? cachedWarehouseContext.station?.displayName
      : stationNameForWarehouse(requested);
  }

  function stationKeyForWarehouse(code) {
    return clean(code, 8).toUpperCase() === "TX" ? "OFFICE_COC_TX" : "OFFICE_COC_01";
  }

  function stationNameForWarehouse(code) {
    return clean(code, 8).toUpperCase() === "TX" ? "Texas Office COC Receiver" : "California Office COC Receiver";
  }

  const receiverSettingKey = (stationKey = activeStationKey()) => `${RECEIVER_SETTING_PREFIX}:${clean(stationKey, 80)}`;

  function config() {
    const value = global.atlasSupabaseConfig;
    if (!value?.url || !value?.key) throw new Error("SUPABASE_CONFIG_MISSING");
    return value;
  }

  function parseStoredSession(raw) {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      const session = parsed?.currentSession || parsed?.session || parsed;
      if (!session?.access_token || !session?.user?.id) return null;
      if (session.expires_at && Number(session.expires_at) * 1000 <= Date.now() + 10000) return null;
      return session;
    } catch {
      return null;
    }
  }

  function getAuthSession() {
    const shared = global.AtlasAuth?.getSession?.();
    if (shared) return shared;
    const direct = parseStoredSession(global.localStorage?.getItem(AUTH_STORAGE_KEY));
    if (direct) return direct;
    for (let index = 0; index < (global.localStorage?.length || 0); index += 1) {
      const key = global.localStorage.key(index);
      if (!key?.startsWith("sb-") || !key.endsWith("-auth-token")) continue;
      const session = parseStoredSession(global.localStorage.getItem(key));
      if (session) return session;
    }
    return null;
  }

  function requireSession() {
    const session = getAuthSession();
    if (!session) throw new Error("ATLAS_AUTH_REQUIRED");
    return session;
  }

  async function requireValidSession({ forceRefresh = false } = {}) {
    const session = await global.AtlasAuth?.getValidSession?.({ forceRefresh });
    return session || requireSession();
  }

  function currentUser() {
    return getAuthSession()?.user || null;
  }

  function userRoles(user = currentUser()) {
    const metadata = user?.app_metadata || {};
    const values = [metadata.role, metadata.atlas_role, ...(Array.isArray(metadata.roles) ? metadata.roles : [])];
    return new Set(values.map((value) => clean(value, 80).toLowerCase()).filter(Boolean));
  }

  function isSupervisor(user = currentUser()) {
    const roles = userRoles(user);
    return ["supervisor", "admin", "administrator"].some((role) => roles.has(role));
  }

  function isOfficeUser(user = currentUser()) {
    const roles = userRoles(user);
    return ["office", "office_receiver", "supervisor", "admin", "administrator"]
      .some((role) => roles.has(role));
  }

  async function edgeRequest(functionName, body, { receiverCredentials = null, responseType = "json" } = {}) {
    let session = await requireValidSession();
    const { url, key } = config();
    const send = (accessToken) => {
      const headers = {
        apikey: key,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      };
      if (receiverCredentials?.devicePublicId) headers["X-Atlas-Receiver-Id"] = receiverCredentials.devicePublicId;
      if (receiverCredentials?.deviceSecret) headers["X-Atlas-Receiver-Secret"] = receiverCredentials.deviceSecret;
      return fetch(`${url}/functions/v1/${functionName}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body || {}),
      });
    };
    let response = await send(session.access_token);
    if (response.status === 401 && global.AtlasAuth?.getValidSession) {
      const failedToken = session.access_token;
      session = await requireValidSession({ forceRefresh: true });
      if (session.access_token !== failedToken) response = await send(session.access_token);
    }
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      const error = new Error(clean(failure?.error || failure?.message || `COC_REQUEST_FAILED_${response.status}`, 300));
      error.status = response.status;
      throw error;
    }
    if (responseType === "arrayBuffer") return response.arrayBuffer();
    return response.json();
  }

  function bytesToBase64(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function loadOfficialTemplate() {
    const result = await edgeRequest("coc-receiver", { action: "official-template" });
    if (!result?.workbookBase64) throw new Error("COC_TEMPLATE_UNAVAILABLE");
    return base64ToBytes(result.workbookBase64);
  }

  async function stationStatus(warehouseCode = "") {
    const context = await warehouseContext({ warehouseCode });
    return edgeRequest("coc-receiver", { action: "station-status", warehouseCode: context.selectedWarehouse.code });
  }

  async function submitCoc({ cocId, idempotencyKey, snapshot, workbookBytes, workbookFileName, forceResend = false }) {
    const submissionWarehouse = clean(snapshot?.warehouseCode || DEFAULT_WAREHOUSE_CODE, 8).toUpperCase();
    const context = await warehouseContext({ warehouseCode: submissionWarehouse });
    const result = await edgeRequest("submit-coc-to-office", {
      cocId,
      idempotencyKey,
      warehouseCode: context.selectedWarehouse.code,
      reportSnapshot: { ...snapshot, warehouseCode: context.selectedWarehouse.code, warehouseName: context.selectedWarehouse.display_name },
      workbookFileName,
      workbookBase64: bytesToBase64(workbookBytes),
      workbookMimeType: MIME_XLSX,
      forceResend: Boolean(forceResend),
    });
    if (!result?.deliveryId || result?.status !== "SENT") throw new Error("COC_SEND_NOT_CONFIRMED");
    return result;
  }

  async function deliveryStatuses(deliveryIds) {
    const ids = [...new Set((deliveryIds || []).map((value) => clean(value, 140)).filter(Boolean))].slice(0, 100);
    if (!ids.length) return [];
    const result = await edgeRequest("coc-receiver", { action: "delivery-statuses", deliveryIds: ids, warehouseCode: requestedWarehouseCode() });
    return Array.isArray(result?.deliveries) ? result.deliveries : [];
  }

  async function createPairing() {
    const context = await warehouseContext();
    const devicePublicId = global.crypto?.randomUUID?.() || `receiver-${Date.now().toString(36)}`;
    const secretBytes = new Uint8Array(32);
    global.crypto.getRandomValues(secretBytes);
    const deviceSecret = [...secretBytes].map((value) => value.toString(16).padStart(2, "0")).join("");
    const result = await edgeRequest("coc-receiver", {
      action: "create-pairing",
      warehouseCode: context.selectedWarehouse.code,
      devicePublicId,
      deviceSecret,
      deviceDescription: `${navigator.platform || "Computer"} · ${navigator.userAgent.includes("Edg/") ? "Microsoft Edge" : "Browser"}`,
    });
    global.sessionStorage?.setItem("atlas-coc-pairing-pending", JSON.stringify({
      pairingSessionId: result.pairingSessionId,
      stationKey: result.stationKey || context.station.key,
      warehouseCode: context.selectedWarehouse.code,
      devicePublicId,
      deviceSecret,
    }));
    return { ...result, devicePublicId };
  }

  async function pairingStatus(pairingSessionId) {
    const pending = JSON.parse(global.sessionStorage?.getItem("atlas-coc-pairing-pending") || "null");
    if (!pending || pending.pairingSessionId !== pairingSessionId) throw new Error("PAIRING_SESSION_MISSING");
    const result = await edgeRequest("coc-receiver", {
      action: "pairing-status",
      pairingSessionId,
      devicePublicId: pending.devicePublicId,
    });
    if (result?.status === "PAIRED") {
      const credentials = {
        stationKey: pending.stationKey || result.stationKey || activeStationKey(),
        warehouseCode: pending.warehouseCode || requestedWarehouseCode(),
        stationId: result.stationId,
        deviceId: result.deviceId,
        devicePublicId: pending.devicePublicId,
        deviceSecret: pending.deviceSecret,
        pairedAt: result.pairedAt,
      };
      await global.AtlasCocStorage?.setSetting(receiverSettingKey(credentials.stationKey), credentials);
      global.sessionStorage?.removeItem("atlas-coc-pairing-pending");
      return { ...result, credentials };
    }
    return result;
  }

  async function approvePairing({ pairingCode = "", qrToken = "", replaceExisting = false } = {}) {
    if (!isSupervisor()) throw new Error("SUPERVISOR_REQUIRED");
    const context = await warehouseContext();
    return edgeRequest("coc-receiver", {
      action: "approve-pairing",
      warehouseCode: context.selectedWarehouse.code,
      pairingCode: clean(pairingCode, 20).replace(/\D/g, ""),
      qrToken: clean(qrToken, 500),
      replaceExisting: Boolean(replaceExisting),
    });
  }

  async function receiverCredentials() {
    const context = await warehouseContext();
    const key = receiverSettingKey(context.station.key);
    let stored = await global.AtlasCocStorage?.getSetting(key);
    if (!stored?.value && context.selectedWarehouse.code === "CA") {
      const legacy = await global.AtlasCocStorage?.getSetting(RECEIVER_SETTING_PREFIX);
      if (legacy?.value) {
        const migrated = { ...legacy.value, stationKey: context.station.key, warehouseCode: "CA" };
        await global.AtlasCocStorage?.setSetting(key, migrated);
        stored = { value: migrated };
      }
    }
    return stored?.value || null;
  }

  async function verifyReceiver() {
    const credentials = await receiverCredentials();
    if (!credentials) return { paired: false };
    try {
      const result = await edgeRequest("coc-receiver", {
        action: "verify-receiver",
        stationKey: credentials.stationKey,
      }, { receiverCredentials: credentials });
      return { ...result, paired: true, credentials };
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        await global.AtlasCocStorage?.deleteSetting(receiverSettingKey(credentials.stationKey));
        return { paired: false, revoked: true };
      }
      throw error;
    }
  }

  async function heartbeat(credentials) {
    return edgeRequest("coc-receiver", { action: "heartbeat", stationKey: credentials.stationKey }, { receiverCredentials: credentials });
  }

  async function receiverInbox(credentials, options = {}) {
    const result = await edgeRequest("coc-receiver", {
      action: "receiver-inbox",
      stationKey: credentials.stationKey,
      section: clean(options.section || "", 20),
      page: Number(options.page || 1),
      pageSize: Number(options.pageSize || 8),
      search: clean(options.search || "", 120),
      sort: clean(options.sort || "newest", 30),
      dayStart: clean(options.dayStart || "", 40),
    }, { receiverCredentials: credentials });
    return options.withMeta ? result : Array.isArray(result?.deliveries) ? result.deliveries : [];
  }

  async function archiveOfficeCompleted(deliveryIds, credentials, { all = false } = {}) {
    return edgeRequest("coc-receiver", {
      action: "archive-completed",
      stationKey: credentials.stationKey,
      deliveryIds: Array.isArray(deliveryIds) ? deliveryIds.slice(0, 100) : [],
      archiveAll: Boolean(all),
    }, { receiverCredentials: credentials });
  }

  async function restoreOfficeArchived(deliveryIds, credentials) {
    return edgeRequest("coc-receiver", {
      action: "restore-archived",
      stationKey: credentials.stationKey,
      deliveryIds: Array.isArray(deliveryIds) ? deliveryIds.slice(0, 100) : [],
    }, { receiverCredentials: credentials });
  }

  async function downloadOfficeWorkbook(deliveryId, credentials) {
    const result = await edgeRequest("coc-receiver", { action: "download-workbook", deliveryId }, { receiverCredentials: credentials });
    if (!result?.downloadUrl) throw new Error("COC_WORKBOOK_NOT_AVAILABLE");
    const response = await fetch(result.downloadUrl);
    if (!response.ok) throw new Error("COC_WORKBOOK_DOWNLOAD_FAILED");
    return { fileName: clean(result.fileName || "Company_COC.xlsx", 160), blob: await response.blob() };
  }

  async function acknowledgeDelivery(deliveryId, credentials) {
    return edgeRequest("coc-receiver", { action: "acknowledge", deliveryId }, { receiverCredentials: credentials });
  }

  async function markOfficeCompleted(deliveryId, credentials) {
    return edgeRequest("coc-receiver", { action: "mark-completed", deliveryId }, { receiverCredentials: credentials });
  }

  function subscribeToDeliveries({ filter = "", onChange = () => {}, onState = () => {} } = {}) {
    const session = getAuthSession();
    if (!session) return { close() {} };
    const { url, key } = config();
    const websocketUrl = `${url.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${encodeURIComponent(key)}&vsn=1.0.0`;
    let socket = null;
    let reconnectTimer = null;
    let heartbeatTimer = null;
    let closed = false;
    let reference = 1;
    const topic = `realtime:coc-deliveries-${Math.random().toString(36).slice(2)}`;

    const send = (event, payload = {}) => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ topic, event, payload, ref: String(reference++) }));
    };
    const connect = () => {
      if (closed) return;
      onState("reconnecting");
      socket = new WebSocket(websocketUrl);
      socket.onopen = () => {
        send("phx_join", {
          config: {
            broadcast: { self: false, ack: false },
            presence: { key: "" },
            postgres_changes: [{ event: "*", schema: "public", table: "coc_deliveries", ...(filter ? { filter } : {}) }],
            private: true,
          },
          access_token: session.access_token,
        });
        heartbeatTimer = global.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(reference++) }));
          }
        }, 25000);
      };
      socket.onmessage = (event) => {
        let message = null;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.event === "phx_reply" && message.payload?.status === "ok") onState("connected");
        if (["postgres_changes", "broadcast"].includes(message.event)) onChange(message.payload?.data || message.payload);
      };
      socket.onerror = () => onState("reconnecting");
      socket.onclose = () => {
        global.clearInterval(heartbeatTimer);
        onState("offline");
        if (!closed) reconnectTimer = global.setTimeout(connect, 2500);
      };
    };
    connect();
    return {
      close() {
        closed = true;
        global.clearTimeout(reconnectTimer);
        global.clearInterval(heartbeatTimer);
        try { send("phx_leave", {}); } catch {}
        socket?.close();
      },
    };
  }

  global.AtlasCocDelivery = Object.freeze({
    DEFAULT_WAREHOUSE_CODE,
    WAREHOUSE_SELECTION_KEY,
    MIME_XLSX,
    getAuthSession,
    currentUser,
    userRoles,
    isSupervisor,
    isOfficeUser,
    warehouseContext,
    requestedWarehouseCode,
    activeStationKey,
    activeStationName,
    stationKeyForWarehouse,
    stationNameForWarehouse,
    loadOfficialTemplate,
    stationStatus,
    submitCoc,
    deliveryStatuses,
    createPairing,
    pairingStatus,
    approvePairing,
    receiverCredentials,
    verifyReceiver,
    heartbeat,
    receiverInbox,
    archiveOfficeCompleted,
    restoreOfficeArchived,
    downloadOfficeWorkbook,
    acknowledgeDelivery,
    markOfficeCompleted,
    subscribeToDeliveries,
  });
})(window);
