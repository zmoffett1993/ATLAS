(() => {
  "use strict";

  const API_URL = "https://dwrrbpiprcmajfyronlf.supabase.co";
  const PUBLIC_KEY = "sb_publishable_akr0opK3RV0Mg5CQpF2woQ_hBFyRIJa";
  const SESSION_KEY = "atlas-dashboard-session-v1";
  const WAREHOUSE_SELECTION_KEY = "atlas-selected-warehouse-v1";
  const COC_PAGE_SIZE = 8;
  const PRODUCT_MAP_URL = "./product-images.json?v=20260831-thick-wall-supabase-gallery-v106";
  const ACTION_COLORS = Object.freeze({
    move: "#0f5ccb",
    location: "#7251c7",
    create: "#168447",
    edit: "#b87525",
    pick: "#f4d56b",
    delete: "#e10600",
    audit: "#708297",
  });
  const state = {
    mounted: false,
    open: false,
    loading: false,
    range: "today",
    customStart: "",
    customEnd: "",
    filter: "operational",
    search: "",
    skus: [],
    locations: [],
    profiles: [],
    activities: [],
    history: [],
    undoSnapshots: [],
    deleteRequests: [],
    productImages: null,
    productImagesLoading: null,
    notificationsOpen: false,
    refreshTimer: null,
    drawer: null,
    normalized: [],
    view: "operations",
    currentProfile: null,
    warehouses: [],
    selectedWarehouse: null,
    adminUsers: [],
    adminUsersLoaded: false,
    adminLoading: false,
    adminError: "",
    adminNotice: "",
    accountDeleteError: "",
    accountWarehouseFilter: "all",
    accountRoleFilter: "all",
    accountStatusFilter: "active",
    accountSearch: "",
    accountSort: "name",
    accountModal: null,
    cocSection: "all",
    cocSearch: "",
    cocSort: "newest",
    cocPage: 1,
    cocTotal: 0,
    cocRecords: [],
    cocMetrics: { total: 0, awaiting: 0, receivedToday: 0, completedToday: 0 },
    cocPerformanceRange: "30",
    cocPerformance: {
      completionSamples: 0,
      averageActiveDurationMs: 0,
      medianActiveDurationMs: 0,
      scanAttempts: 0,
      scanSuccesses: 0,
      scanCanceled: 0,
      distinctLots: 0,
      manualLots: 0,
      scannerReviewedLots: 0,
      scannerExactLots: 0,
      scannerCorrectedLots: 0,
      scannerEditDistanceTotal: 0,
      scannerComparedCharacters: 0,
      scannerOneOrTwoCharacterCorrections: 0,
    },
    cocLoading: false,
    cocLoaded: false,
    cocError: "",
    cocNotice: "",
    cocSelected: null,
    cocPreview: { status: "idle", html: "", error: "", id: "" },
    cocDelete: null,
    cocWorkspace: "operations",
    scannerView: "performance",
    scannerRange: "30d",
    scannerEmployee: "",
    scannerCaptureMethod: "",
    scannerVersion: "",
    scannerReviewStatus: "",
    scannerCorrectionSize: "",
    scannerPage: 1,
    scannerTotal: 0,
    scannerCorrections: [],
    scannerSelected: null,
    scannerData: null,
    scannerLoading: false,
    scannerLoaded: false,
    scannerError: "",
    scannerNotice: "",
    lastSync: null,
    session: null,
    accessRequired: false,
    error: "",
  };
  const cocWorkbookCache = new Map();
  let cocSearchTimer = null;
  let dashboardRequestSequence = 0;
  let cocRequestSequence = 0;
  let scannerRequestSequence = 0;

  const escapeHtml = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
          character
        ],
    );

  const passwordField = ({ name = "password", autocomplete, minlength = 0 }) => `
    <div class="atlas-password-field">
      <input type="password" name="${escapeHtml(name)}" autocomplete="${escapeHtml(autocomplete)}" ${minlength ? `minlength="${minlength}"` : ""} required>
      <button type="button" class="atlas-password-toggle" data-password-toggle aria-label="Show password" aria-pressed="false">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path>
          <circle cx="12" cy="12" r="2.6"></circle>
          <path class="atlas-password-eye-slash" d="m4 4 16 16"></path>
        </svg>
      </button>
    </div>`;

  const safeJson = (value) => {
    if (!value) return {};
    if (typeof value === "object") return value;
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  };

  const bool = (value) => value === true || String(value).toLowerCase() === "true";

  const parseDate = (value) => {
    if (!value) return null;
    const normalized = String(value).includes("T")
      ? String(value)
      : String(value).replace(" ", "T");
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const locationCode = (aisle, section) => {
    const aisleNumber = Number(aisle);
    const sectionName = String(section || "").toUpperCase();
    if (!aisleNumber || !sectionName) return "—";
    if (aisleNumber === 22) {
      return `Overflow · ${
        { A: "Left", B: "Middle", C: "Right" }[sectionName] || sectionName
      }`;
    }
    if (aisleNumber === 23) return `Samples Rack · Section ${sectionName}`;
    return `${aisleNumber}${sectionName}`;
  };

  const initials = (name) =>
    String(name || "System")
      .trim()
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "SY";

  const formatDateTime = (date, compact = false) => {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "Unknown time";
    const sameDay = date.toDateString() === new Date().toDateString();
    if (compact && sameDay) {
      return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const pacificDateKey = (date) => {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: state.selectedWarehouse?.time_zone || "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
  };

  const formatPacificTime = (date) => {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "Unknown time";
    return date.toLocaleTimeString([], {
      timeZone: state.selectedWarehouse?.time_zone || "America/Los_Angeles",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const actionMeta = (rawAction, oldRecord = {}, newRecord = {}, reason = "") => {
    const action = String(rawAction || "").toUpperCase();
    const reasonText = String(reason || "").toLowerCase();
    const aisleChanged =
      oldRecord.aisle != null &&
      newRecord.aisle != null &&
      (Number(oldRecord.aisle) !== Number(newRecord.aisle) ||
        String(oldRecord.section) !== String(newRecord.section));
    const activeChanged =
      oldRecord.is_active != null &&
      newRecord.is_active != null &&
      bool(oldRecord.is_active) !== bool(newRecord.is_active);
    const pickChanged =
      oldRecord.pick_first != null &&
      newRecord.pick_first != null &&
      bool(oldRecord.pick_first) !== bool(newRecord.pick_first);

    if (action === "CREATE_SKU" || action === "SKU_CREATED")
      return { key: "create", label: "Created new SKU", color: ACTION_COLORS.create, operational: true };
    if (reasonText.includes("undo inventory move"))
      return { key: "undo", label: "Undid inventory move", color: ACTION_COLORS.move, operational: true };
    if (action === "RESTORE_LOCATION" && reasonText.includes("replenish"))
      return { key: "location", label: "Replenished inventory", color: ACTION_COLORS.create, operational: true };
    if (action === "ADD_LOCATION")
      return { key: "move", label: "Added inventory location", color: ACTION_COLORS.move, operational: true };
    if (action === "MOVE_LOCATION" || action === "CORRECT_LOCATION" || action === "CONSOLIDATE_LOCATION" || aisleChanged || reasonText.includes("move all product"))
      return { key: "move", label: "Moved inventory", color: ACTION_COLORS.move, operational: true };
    if (action.includes("SKU_EDIT"))
      return { key: "edit", label: "Edited SKU", color: ACTION_COLORS.edit, operational: true };
    if (action === "SKU_DELETE_REQUESTED")
      return { key: "delete-request", label: "Deletion pending approval", color: ACTION_COLORS.edit, operational: false };
    if (action === "SKU_DELETE_REJECTED")
      return { key: "delete-request", label: "Deletion request rejected", color: ACTION_COLORS.edit, operational: false };
    if (action === "SKU_DELETE_APPROVED")
      return { key: "delete", label: "Deleted SKU", color: ACTION_COLORS.delete, operational: true };
    if (action === "UNDO_ACTION")
      return { key: "undo", label: "Reversed recorded action", color: ACTION_COLORS.move, operational: true };
    if (action.includes("SKU_DELETE"))
      return { key: "delete", label: "Removed SKU", color: ACTION_COLORS.delete, operational: true };
    if (action.includes("PICK_FIRST") || pickChanged)
      return {
        key: "pick",
        label: bool(newRecord.pick_first) ? "Enabled Pick First" : "Disabled Pick First",
        color: ACTION_COLORS.pick,
        operational: action.includes("PICK_FIRST"),
      };
    if (action === "CLEAR_LOCATION" || action.includes("LOCATION_CLEAR") || (activeChanged && !bool(newRecord.is_active)))
      return { key: "location", label: "Cleared location", color: ACTION_COLORS.location, operational: action === "CLEAR_LOCATION" || action.includes("LOCATION_CLEAR") };
    if (action === "RESTORE_LOCATION" || action.includes("LOCATION_RESTORE") || (activeChanged && bool(newRecord.is_active)))
      return { key: "location", label: "Activated inventory location", color: ACTION_COLORS.create, operational: action === "RESTORE_LOCATION" || action.includes("LOCATION_RESTORE") };
    if (action.includes("CORRECT") || reasonText.includes("different location"))
      return { key: "location", label: "Corrected location", color: ACTION_COLORS.edit, operational: true };
    if (action === "USER_CREATED")
      return { key: "access", label: "Created ATLAS account", color: ACTION_COLORS.create, operational: true };
    if (action === "USER_UPDATED")
      return { key: "access", label: "Updated account access", color: ACTION_COLORS.move, operational: true };
    if (action === "USER_PASSWORD_CHANGED")
      return { key: "access", label: "Changed account password", color: ACTION_COLORS.pick, operational: true };
    if (action === "USER_DEACTIVATED")
      return { key: "access", label: "Blocked account sign-in (legacy)", color: ACTION_COLORS.delete, operational: true };
    if (action === "USER_REACTIVATED")
      return { key: "access", label: "Reactivated ATLAS account", color: ACTION_COLORS.create, operational: true };
    if (action === "USER_DELETED")
      return { key: "access", label: "Deleted ATLAS account", color: ACTION_COLORS.delete, operational: true };
    if (action === "INSERT")
      return { key: "audit", label: "Imported location", color: ACTION_COLORS.audit, operational: false };
    if (action === "DELETE")
      return { key: "audit", label: "Deleted location record", color: ACTION_COLORS.delete, operational: false };
    return { key: "audit", label: "Updated database record", color: ACTION_COLORS.audit, operational: false };
  };

  const normalizeActivity = (row, source, skuById, profileById) => {
    const oldRecord = safeJson(row.old_record);
    const newRecord = safeJson(row.new_record);
    const details = safeJson(row.details);
    const rawAction = row.event_type || row.action || row.activity_type || row.type || "UPDATE";
    const meta = actionMeta(rawAction, oldRecord, newRecord, row.reason);
    const date =
      parseDate(row.created_at) ||
      parseDate(row.changed_at) ||
      parseDate(row.moved_at) ||
      parseDate(row.updated_at);
    const sku =
      details.sku ||
      newRecord.sku ||
      oldRecord.sku ||
      row.sku ||
      skuById.get(row.sku_id)?.sku ||
      newRecord.email ||
      oldRecord.email ||
      "Unknown SKU";
    const employee =
      row.employee_name ||
      newRecord.employee ||
      oldRecord.employee ||
      profileById.get(row.changed_by)?.display_name ||
      (meta.key === "audit" ? "System / Import" : "Unknown employee");
    const previousAisle = row.previous_aisle || oldRecord.aisle;
    const previousSection = row.previous_section || oldRecord.section;
    const newAisle = row.new_aisle || newRecord.aisle;
    const newSection = row.new_section || newRecord.section;
    const from = locationCode(previousAisle, previousSection);
    const to = locationCode(newAisle, newSection);
    const location = from !== "—" && to !== "—" ? `${from} → ${to}` : to !== "—" ? to : from;
    const reason = row.reason || details.reason || "";
    let detail = reason || meta.label;
    if (meta.key === "edit" && oldRecord.sku && newRecord.sku && oldRecord.sku !== newRecord.sku) {
      detail = `${oldRecord.sku} → ${newRecord.sku}`;
    }
    if (meta.key === "delete") detail = details.deleted_sku ? `Permanently deleted · ${details.deleted_sku}` : "Permanently deleted; history retained";
    if (meta.key === "pick") detail = location !== "—" ? `Location ${location}` : meta.label;
    if (meta.key === "access") {
      const role = newRecord.role || oldRecord.role;
      detail = row.reason || (role ? `Role: ${role}` : meta.label);
    }

    return {
      id: `${source}-${row.id}`,
      source,
      raw: row,
      rawAction: String(rawAction || "UPDATE"),
      ...meta,
      date,
      timestamp: date?.getTime() || 0,
      sku,
      employee,
      location,
      from,
      to,
      detail,
      snapshotId: null,
    };
  };

  const getSession = () => {
    const shared = window.AtlasAuth?.getSession?.();
    if (shared) return shared;
    try {
      const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
      if (!saved?.access_token) return null;
      const expiresAt = Number(saved.expires_at || 0) * 1000;
      if (expiresAt && expiresAt <= Date.now() + 15000) return null;
      return saved;
    } catch {
      return null;
    }
  };

  const api = async (path, { token = state.session?.access_token, method = "GET", body } = {}) => {
    let activeToken = token;
    if (activeToken && window.AtlasAuth?.getValidSession) {
      const validSession = await window.AtlasAuth.getValidSession();
      if (validSession?.access_token) {
        state.session = validSession;
        activeToken = validSession.access_token;
      }
    }
    const send = async (requestToken) => {
      const response = await fetch(`${API_URL}${path}`, {
        method,
        cache: "no-store",
        headers: {
          apikey: PUBLIC_KEY,
          Authorization: `Bearer ${requestToken || PUBLIC_KEY}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { response, payload: await response.json().catch(() => null) };
    };
    let { response, payload } = await send(activeToken);
    const failureText = String(payload?.message || payload?.error_description || payload?.error || "");
    if (
      activeToken
      && (response.status === 401 || /invalid jwt|jwt expired/i.test(failureText))
      && window.AtlasAuth?.getValidSession
    ) {
      const refreshedSession = await window.AtlasAuth.getValidSession({ forceRefresh: true });
      if (refreshedSession?.access_token && refreshedSession.access_token !== activeToken) {
        state.session = refreshedSession;
        activeToken = refreshedSession.access_token;
        ({ response, payload } = await send(activeToken));
      }
    }
    if (!response.ok) {
      const error = new Error(payload?.message || payload?.error_description || payload?.error || payload?.hint || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  };

  const readTable = async (name, token, { warehouse = false, warehouseId = state.selectedWarehouse?.id } = {}) => {
    const warehouseFilter = warehouse && warehouseId
      ? `&warehouse_id=eq.${encodeURIComponent(warehouseId)}`
      : "";
    return api(`/rest/v1/${name}?select=*&limit=5000${warehouseFilter}`, { token });
  };

  const loadProductImages = () => {
    if (state.productImages) return Promise.resolve(state.productImages);
    if (state.productImagesLoading) return state.productImagesLoading;
    state.productImagesLoading = fetch(PRODUCT_MAP_URL, { cache: "no-cache" })
      .then((response) => {
        if (!response.ok) throw new Error("Product image map unavailable");
        return response.json();
      })
      .then((payload) => {
        state.productImages = payload?.products || {};
        return state.productImages;
      })
      .catch(() => {
        state.productImages = {};
        return state.productImages;
      })
      .finally(() => {
        state.productImagesLoading = null;
        if (state.open && state.drawer) render();
      });
    return state.productImagesLoading;
  };

  const productImageForSku = (sku) => {
    const key = String(sku || "").trim();
    if (!key || key === "Unknown SKU") return null;
    const normalizedKey = key.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const product =
      state.productImages?.[key] ||
      state.productImages?.[key.toUpperCase()] ||
      Object.entries(state.productImages || {}).find(([productKey, candidate]) =>
        [productKey, candidate?.official_sku, candidate?.atlas_sku]
          .filter(Boolean)
          .some(
            (value) =>
              String(value).toUpperCase().replace(/[^A-Z0-9]/g, "") ===
              normalizedKey,
          ),
      )?.[1];
    const imageUrl = product?.image_url || product?.image || "";
    return imageUrl ? { src: imageUrl, label: product?.picker_name || product?.title || key } : null;
  };

  const adminApi = (action, payload = {}) =>
    api("/functions/v1/atlas-user-admin", {
      method: "POST",
      body: { action, ...payload },
    });

  const cocApi = (action, payload = {}, warehouseCode = state.selectedWarehouse?.code || "CA") =>
    api("/functions/v1/coc-dashboard", {
      method: "POST",
      body: { action, warehouseCode, ...payload },
    });

  const scannerApi = (action, payload = {}, warehouseCode = state.selectedWarehouse?.code || "CA") =>
    api("/functions/v1/scanner-intelligence", {
      method: "POST",
      body: { action, warehouseCode, ...payload },
    });

  const scannerGlobalFilters = () => ({
    range: state.scannerRange,
    captureMethod: state.scannerCaptureMethod,
    scannerVersion: state.scannerVersion,
  });

  const scannerCorrectionFilters = () => ({
    ...scannerGlobalFilters(),
    employeeId: state.scannerEmployee,
    reviewStatus: state.scannerReviewStatus,
    correctionSize: state.scannerCorrectionSize,
  });

  const cocSnapshot = (record) => record?.report_snapshot || {};
  const cocTotals = (record) => {
    const pallets = cocSnapshot(record).pallets || [];
    return {
      pallets: pallets.length,
      boxes: pallets.reduce((sum, pallet) => sum + (pallet.lots || []).reduce((count, lot) => count + Number(lot.cases || 0), 0), 0),
    };
  };
  const cocRecordPerformance = (record) => {
    const snapshot = cocSnapshot(record);
    const analytics = snapshot.analytics || {};
    const lots = (snapshot.pallets || []).flatMap((pallet) => pallet.lots || []);
    const manualMethods = new Set(["manual", "manual_review", "manual_edit", "manual_entry"]);
    const scanAttempts = Number(analytics.scanAttempts || 0);
    const scanSuccesses = Number(analytics.scanSuccesses || 0);
    const trackedLots = lots.filter((lot) => lot.scannerReviewTracked);
    const trackedExactLots = trackedLots.filter((lot) => !lot.scannerTextCorrected);
    const trackedCorrectedLots = trackedLots.filter((lot) => lot.scannerTextCorrected);
    const hasScannerAnalytics = Object.prototype.hasOwnProperty.call(analytics, "scannerReviewedLots");
    return {
      activeDurationMs: Number(analytics.activeDurationMs || 0),
      scanAttempts,
      scanSuccesses,
      distinctLots: lots.length,
      manualLots: lots.filter((lot) => manualMethods.has(String(lot.captureMethod || "").toLowerCase())).length,
      scannerReviewedLots: hasScannerAnalytics
        ? Number(analytics.scannerReviewedLots || 0) : trackedLots.length,
      scannerExactLots: hasScannerAnalytics
        ? Number(analytics.scannerExactLots || 0) : trackedExactLots.length,
      scannerCorrectedLots: hasScannerAnalytics
        ? Number(analytics.scannerCorrectedLots || 0) : trackedCorrectedLots.length,
      scannerEditDistanceTotal: hasScannerAnalytics
        ? Number(analytics.scannerEditDistanceTotal || 0)
        : trackedCorrectedLots.reduce((sum, lot) => sum + Number(lot.scannerEditDistance || 0), 0),
      scannerComparedCharacters: hasScannerAnalytics
        ? Number(analytics.scannerComparedCharacters || 0)
        : trackedLots.reduce((sum, lot) => sum + Number(lot.scannerComparedCharacters || 0), 0),
      scannerOneOrTwoCharacterCorrections: hasScannerAnalytics
        ? Number(analytics.scannerOneOrTwoCharacterCorrections || 0)
        : trackedCorrectedLots.filter((lot) => Number(lot.scannerEditDistance || 0) <= 2).length,
    };
  };
  const cocPlural = (count, word) => `${Number(count || 0).toLocaleString()} ${word}${Number(count) === 1 ? "" : word === "box" ? "es" : "s"}`;
  const cocStatus = (record) => record?.receiver_archived_at ? "Archived" : ({ SENT: "Sent", RECEIVED: "Received", OFFICE_COMPLETED: "Completed" })[record?.status] || "Warehouse complete";
  const cocRecordDate = (record) => record?.office_completed_at || record?.received_at || record?.sent_at || record?.created_at;
  const cocCanDelete = (record) => record?.status === "OFFICE_COMPLETED";
  const cocMetricIcon = (kind) => {
    const paths = {
      all: '<path d="M9 5h6M9 9h6M9 13h4"/><path d="M9 3h6v3H9z"/><rect x="5" y="4" width="14" height="17" rx="2"/>',
      awaiting: '<path d="M9 5h6M9 9h6M9 13h4"/><path d="M9 3h6v3H9z"/><rect x="5" y="4" width="14" height="17" rx="2"/>',
      received: '<path d="M4 14h4l2 3h4l2-3h4"/><path d="M6 4h12l2 10v6H4v-6z"/>',
      completed: '<path d="m6 12 4 4 8-9"/><circle cx="12" cy="12" r="9"/>',
      time: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      scan: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><path d="M7 12h10"/>',
      manual: '<path d="M7 3h8l3 3v15H7z"/><path d="M15 3v4h4M10 12h5M10 16h5"/>',
    };
    return `<i class="atlas-dashboard-coc-metric-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${paths[kind] || paths.all}</svg></i>`;
  };
  const cocMetricCard = (kind, label, value, note = "") => `<article class="is-${kind}">${cocMetricIcon(kind)}<div><span>${label}</span><strong>${Number(value || 0).toLocaleString()}</strong>${note ? `<small>${note}</small>` : ""}</div></article>`;
  const formatCocDuration = (milliseconds) => {
    const totalSeconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
    if (!totalSeconds) return "—";
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours) return `${hours}h ${minutes}m`;
    if (minutes) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  };
  const cocPercentage = (numerator, denominator) => denominator
    ? `${((Number(numerator || 0) / Number(denominator)) * 100).toFixed(1)}%`
    : "—";
  const cocPerformanceCard = (kind, label, value, note) => `<article class="is-${kind}">${cocMetricIcon(kind)}<div><span>${label}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div></article>`;

  const renderPreservingScroll = () => {
    const top = window.scrollY || document.documentElement.scrollTop || 0;
    render();
    window.requestAnimationFrame?.(() => window.scrollTo({ top, left: 0, behavior: "auto" }));
  };

  const loadCocData = async ({ background = false, warehouseCode = state.selectedWarehouse?.code || "CA" } = {}) => {
    if (!state.session?.access_token || !["supervisor", "admin"].includes(state.currentProfile?.role)) return;
    const requestedWarehouseCode = String(warehouseCode || "CA").toUpperCase();
    const requestId = ++cocRequestSequence;
    state.cocLoading = true;
    state.cocError = "";
    if (!background) render();
    try {
      const [list, metrics] = await Promise.all([
        cocApi("list", {
          section: state.cocSection,
          page: state.cocPage,
          pageSize: COC_PAGE_SIZE,
          search: state.cocSearch,
          sort: state.cocSort,
        }, requestedWarehouseCode),
        cocApi("metrics", {
          dayStart: new Date(new Date().setHours(0, 0, 0, 0)).toISOString(),
          performanceRange: state.cocPerformanceRange,
        }, requestedWarehouseCode),
      ]);
      if (requestId !== cocRequestSequence || state.selectedWarehouse?.code !== requestedWarehouseCode) return;
      state.cocRecords = Array.isArray(list.deliveries) ? list.deliveries : [];
      state.cocTotal = Number(list.total || 0);
      state.cocMetrics = {
        total: Number(metrics.total || 0),
        awaiting: Number(metrics.awaiting || 0),
        receivedToday: Number(metrics.receivedToday || 0),
        completedToday: Number(metrics.completedToday || 0),
      };
      const performance = metrics.performance || {};
      state.cocPerformance = {
        completionSamples: Number(performance.completionSamples || 0),
        averageActiveDurationMs: Number(performance.averageActiveDurationMs || 0),
        medianActiveDurationMs: Number(performance.medianActiveDurationMs || 0),
        scanAttempts: Number(performance.scanAttempts || 0),
        scanSuccesses: Number(performance.scanSuccesses || 0),
        scanCanceled: Number(performance.scanCanceled || 0),
        distinctLots: Number(performance.distinctLots || 0),
        manualLots: Number(performance.manualLots || 0),
        scannerReviewedLots: Number(performance.scannerReviewedLots || 0),
        scannerExactLots: Number(performance.scannerExactLots || 0),
        scannerCorrectedLots: Number(performance.scannerCorrectedLots || 0),
        scannerEditDistanceTotal: Number(performance.scannerEditDistanceTotal || 0),
        scannerComparedCharacters: Number(performance.scannerComparedCharacters || 0),
        scannerOneOrTwoCharacterCorrections: Number(
          performance.scannerOneOrTwoCharacterCorrections || 0,
        ),
      };
      state.cocLoaded = true;
      state.lastSync = new Date();
      if (state.cocSelected) {
        const refreshed = state.cocRecords.find((record) => record.id === state.cocSelected.id);
        if (refreshed) state.cocSelected = refreshed;
      }
    } catch (error) {
      if (requestId !== cocRequestSequence || state.selectedWarehouse?.code !== requestedWarehouseCode) return;
      state.cocError = error instanceof Error ? error.message : "COC records could not be loaded.";
    } finally {
      if (requestId !== cocRequestSequence || state.selectedWarehouse?.code !== requestedWarehouseCode) return;
      state.cocLoading = false;
      const previewLocked = state.cocSelected && state.cocPreview.status === "ready";
      if (!background || !previewLocked) background ? renderPreservingScroll() : render();
    }
  };

  const loadScannerData = async ({ background = false, warehouseCode = state.selectedWarehouse?.code || "CA" } = {}) => {
    if (!state.session?.access_token || !["supervisor", "admin"].includes(state.currentProfile?.role)) return;
    const requestedWarehouseCode = String(warehouseCode || "CA").toUpperCase();
    const requestId = ++scannerRequestSequence;
    state.scannerLoading = true;
    state.scannerError = "";
    if (!background) render();
    try {
      const [metrics, corrections] = await Promise.all([
        scannerApi("metrics", scannerGlobalFilters(), requestedWarehouseCode),
        scannerApi("list-corrections", {
          ...scannerCorrectionFilters(),
          page: state.scannerPage,
          pageSize: 12,
        }, requestedWarehouseCode),
      ]);
      if (requestId !== scannerRequestSequence || state.selectedWarehouse?.code !== requestedWarehouseCode) return;
      state.scannerData = metrics;
      state.scannerCorrections = Array.isArray(corrections.items) ? corrections.items : [];
      state.scannerTotal = Number(corrections.total || 0);
      state.scannerLoaded = true;
      if (state.scannerSelected) {
        const refreshed = state.scannerCorrections.find((item) => item.id === state.scannerSelected.id);
        if (refreshed) state.scannerSelected = { ...state.scannerSelected, ...refreshed };
      }
    } catch (error) {
      if (requestId !== scannerRequestSequence || state.selectedWarehouse?.code !== requestedWarehouseCode) return;
      state.scannerError = error instanceof Error ? error.message : "Scanner intelligence could not be loaded.";
    } finally {
      if (requestId !== scannerRequestSequence || state.selectedWarehouse?.code !== requestedWarehouseCode) return;
      state.scannerLoading = false;
      background ? renderPreservingScroll() : render();
    }
  };

  const loadScannerCorrection = async (attemptId) => {
    state.scannerSelected = state.scannerCorrections.find((item) => item.id === attemptId) || { id: attemptId };
    state.scannerLoading = true;
    render();
    try {
      const result = await scannerApi("correction-detail", { attemptId });
      if (state.scannerSelected?.id === attemptId) state.scannerSelected = result.item;
    } catch (error) {
      state.scannerError = error instanceof Error ? error.message : "Correction detail could not be loaded.";
    } finally {
      state.scannerLoading = false;
      render();
    }
  };

  const loadCocWorkbook = async (id) => {
    if (cocWorkbookCache.has(id)) return cocWorkbookCache.get(id);
    const result = await cocApi("download-workbook", { deliveryId: id });
    const response = await fetch(result.downloadUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("The Official COC workbook could not be opened.");
    const record = state.cocSelected?.id === id
      ? state.cocSelected
      : state.cocRecords.find((item) => item.id === id);
    const snapshot = record?.report_snapshot || {};
    const fileName = window.AtlasCocExcel?.outputFileName?.(
      snapshot.customerName,
      snapshot.invoiceNumber,
      snapshot.ifNumber,
    ) || result.fileName || "Official COC.xlsx";
    const workbook = { blob: await response.blob(), fileName };
    cocWorkbookCache.set(id, workbook);
    return workbook;
  };

  const openDashboardCocPreview = async (id) => {
    if (!id) return;
    state.cocPreview = { status: "loading", html: "", error: "", id };
    render();
    try {
      const workbook = await loadCocWorkbook(id);
      const html = await window.AtlasCocExcel.renderOfficialWorkbookPreview(workbook.blob);
      if (state.cocSelected?.id !== id) return;
      state.cocPreview = { status: "ready", html, error: "", id };
    } catch (error) {
      state.cocPreview = { status: "error", html: "", error: error instanceof Error ? error.message : "The Official COC could not be opened.", id };
    }
    render();
  };

  const downloadDashboardCoc = async (id) => {
    try {
      const workbook = await loadCocWorkbook(id);
      const url = URL.createObjectURL(workbook.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = workbook.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      state.cocError = error instanceof Error ? error.message : "The Official COC could not be downloaded.";
      render();
    }
  };

  const mount = () => {
    if (state.mounted) return;
    const dashboard = document.createElement("section");
    dashboard.id = "atlasOperationsDashboard";
    dashboard.className = "atlas-dashboard";
    dashboard.hidden = true;
    dashboard.setAttribute("aria-label", "ATLAS Operations Dashboard");
    dashboard.innerHTML = `
      <div class="atlas-dashboard-shell">
        <div class="atlas-dashboard-mobile-bar">
          <button type="button" data-mobile-menu aria-label="Open ATLAS menu">☰</button>
          <div class="atlas-dashboard-mobile-brand"><strong>ATLAS</strong><small>OPERATIONS DASHBOARD</small></div>
          <button type="button" data-mobile-refresh aria-label="Refresh dashboard">↻</button>
        </div>
        <div data-dashboard-content></div>
      </div>`;
    document.body.appendChild(dashboard);
    dashboard.addEventListener("click", handleClick);
    dashboard.addEventListener("input", handleInput);
    dashboard.addEventListener("change", handleChange);
    dashboard.addEventListener("keydown", handleKeydown);
    dashboard.addEventListener("submit", handleSubmit);
    state.mounted = true;
  };

  const showMenu = () => {
    const backdrop = document.querySelector(".atlas-menu-backdrop");
    if (!backdrop) return;
    syncMenuState();
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("atlas-menu-open");
  };

  const closeMenu = () => {
    const backdrop = document.querySelector(".atlas-menu-backdrop");
    backdrop?.classList.remove("open");
    backdrop?.setAttribute("aria-hidden", "true");
    document.documentElement.classList.remove("atlas-menu-open");
  };

  const stopDashboardRefresh = () => {
    if (state.refreshTimer) window.clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  };

  const startDashboardRefresh = () => {
    stopDashboardRefresh();
    const refreshDelay = state.view === "cocs" ? 15000 : 60000;
    state.refreshTimer = window.setInterval(() => {
      if (!state.open || document.visibilityState !== "visible" || state.loading) return;
      if (state.view === "cocs") {
        void loadCocData({ background: true });
        if (state.cocWorkspace === "scanner") void loadScannerData({ background: true });
        return;
      }
      const feed = document.querySelector(".atlas-dashboard-feed");
      const feedScrollTop = feed?.scrollTop || 0;
      void loadData().then(() => {
        const refreshedFeed = document.querySelector(".atlas-dashboard-feed");
        if (refreshedFeed) refreshedFeed.scrollTop = feedScrollTop;
      });
    }, refreshDelay);
  };

  const openDashboard = async () => {
    mount();
    state.open = true;
    closeMenu();
    document.getElementById("atlasOperationsDashboard").hidden = false;
    document.documentElement.classList.add("atlas-dashboard-open");
    syncMenuState();
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    state.session = getSession();
    void loadProductImages();
    render();
    await loadData();
    startDashboardRefresh();
  };

  const closeDashboard = () => {
    if (!state.open) return;
    state.open = false;
    stopDashboardRefresh();
    state.notificationsOpen = false;
    document.documentElement.classList.remove("atlas-dashboard-open");
    const dashboard = document.getElementById("atlasOperationsDashboard");
    if (dashboard) dashboard.hidden = true;
    syncMenuState();
  };

  const syncMenuState = () => {
    document.querySelectorAll(".premium-drawer-link").forEach((link) => {
      const dashboardLink = link.dataset.action === "dashboard";
      const isActive = state.open && dashboardLink;
      if (state.open) link.classList.toggle("is-active", isActive);
      else if (dashboardLink) link.classList.remove("is-active");
      if (isActive) link.setAttribute("aria-current", "page");
      else if (dashboardLink) link.removeAttribute("aria-current");
    });
  };

  const loadData = async ({ force = false, warehouseCode = state.selectedWarehouse?.code || "", warehouseContext: suppliedWarehouseContext = null } = {}) => {
    if (state.loading && !force) return;
    const requestId = ++dashboardRequestSequence;
    const requestedWarehouseCode = String(warehouseCode || "").toUpperCase();
    state.loading = true;
    state.error = "";
    state.accessRequired = false;
    render();
    const token = state.session?.access_token;
    try {
      const warehouseContext = suppliedWarehouseContext || await window.AtlasCocDelivery?.warehouseContext?.({
        force: true,
        ...(requestedWarehouseCode ? { warehouseCode: requestedWarehouseCode } : {}),
      });
      if (requestId !== dashboardRequestSequence) return;
      state.warehouses = warehouseContext?.accessibleWarehouses || [];
      state.selectedWarehouse = state.warehouses.find((warehouse) => warehouse.code === requestedWarehouseCode)
        || warehouseContext?.selectedWarehouse
        || state.warehouses[0]
        || { code: "CA", display_name: "California Warehouse" };
      const warehouseId = state.selectedWarehouse?.id;
      const [
        skusResult,
        locationsResult,
        activitiesResult,
        historyResult,
        profilesResult,
        undoSnapshotsResult,
        deleteRequestsResult,
      ] = await Promise.allSettled([
        readTable("skus", token),
        readTable("locations", token, { warehouse: true, warehouseId }),
        readTable("inventory_activity", token, { warehouse: true, warehouseId }),
        readTable("location_history", token, { warehouse: true, warehouseId }),
        token ? readTable("profiles", token) : Promise.resolve([]),
        token ? readTable("atlas_undo_snapshots", token, { warehouse: true, warehouseId }) : Promise.resolve([]),
        token ? readTable("sku_delete_requests", token, { warehouse: true, warehouseId }) : Promise.resolve([]),
      ]);
      if (requestId !== dashboardRequestSequence) return;
      if (skusResult.status !== "fulfilled") throw skusResult.reason;
      if (locationsResult.status !== "fulfilled") throw locationsResult.reason;
      state.skus = skusResult.value || [];
      state.locations = locationsResult.value || [];
      state.activities = activitiesResult.status === "fulfilled" ? activitiesResult.value : [];
      state.history = historyResult.status === "fulfilled" ? historyResult.value : [];
      state.profiles = profilesResult.status === "fulfilled" ? profilesResult.value : [];
      state.undoSnapshots = undoSnapshotsResult.status === "fulfilled" ? undoSnapshotsResult.value : [];
      state.deleteRequests = deleteRequestsResult.status === "fulfilled" ? deleteRequestsResult.value : [];
      state.currentProfile =
        state.profiles.find((profile) => profile.user_id === state.session?.user?.id)
        || (state.session?.user?.id ? {
          user_id: state.session.user.id,
          display_name: state.session.user.user_metadata?.display_name || state.session.user.app_metadata?.login_name || "ATLAS user",
          role: state.session.user.app_metadata?.atlas_role || state.session.user.app_metadata?.role || "picker",
          warehouse_id: state.selectedWarehouse?.id,
        } : null);
      if (state.currentProfile && !["supervisor", "admin"].includes(state.currentProfile.role)) {
        state.accessRequired = true;
      }
      if (state.currentProfile?.role !== "admin" && state.view === "access") {
        state.view = "operations";
      }

      const protectedErrors = [activitiesResult, historyResult]
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (!state.activities.length && !state.history.length && protectedErrors.length) {
        if (!token && protectedErrors.some((error) => [401, 403].includes(error.status))) {
          state.accessRequired = true;
        } else {
          throw protectedErrors[0];
        }
      }

      const skuById = new Map(state.skus.map((sku) => [sku.id, sku]));
      const profileById = new Map(state.profiles.map((profile) => [profile.user_id, profile]));
      const operational = state.activities.map((row) =>
        normalizeActivity(row, "activity", skuById, profileById),
      );
      let history = state.history.map((row) =>
        normalizeActivity(row, "history", skuById, profileById),
      );
      history = history.filter(
        (historyRow) =>
          !operational.some(
            (activityRow) =>
              activityRow.key === historyRow.key &&
              activityRow.raw?.sku_id === historyRow.raw?.sku_id &&
              Math.abs(activityRow.timestamp - historyRow.timestamp) < 1500,
          ),
      );
      state.normalized = [...operational, ...history].sort((left, right) => right.timestamp - left.timestamp);
      const snapshotBySource = new Map(state.undoSnapshots.map((snapshot) => [`${snapshot.source_table === "inventory_activity" ? "activity" : "history"}-${snapshot.source_event_id}`, snapshot]));
      state.normalized.forEach((row) => { row.snapshotId = snapshotBySource.get(row.id)?.id || null; });
      state.lastSync = new Date();
    } catch (error) {
      if (requestId !== dashboardRequestSequence) return;
      const errorText = String(error?.message || error || "");
      const sessionRole = state.currentProfile?.role
        || state.session?.user?.app_metadata?.atlas_role
        || state.session?.user?.app_metadata?.role
        || "";
      const authRequired = [401, 403].includes(Number(error?.status || 0))
        || /(?:ATLAS_)?AUTH_REQUIRED|not authenticated|invalid jwt/i.test(errorText);
      if (authRequired || (token && sessionRole && !["supervisor", "admin"].includes(sessionRole))) {
        if (token && !state.currentProfile) {
          state.currentProfile = {
            user_id: state.session?.user?.id,
            display_name: state.session?.user?.user_metadata?.display_name || state.session?.user?.app_metadata?.login_name || "ATLAS user",
            role: sessionRole || "picker",
            warehouse_id: state.selectedWarehouse?.id,
          };
        }
        state.accessRequired = true;
        state.error = "";
      } else state.error = error instanceof Error ? error.message : "The dashboard data could not be loaded.";
    } finally {
      if (requestId !== dashboardRequestSequence) return;
      state.loading = false;
      render();
    }
  };

  const loadAdminUsers = async ({ preserveNotice = false } = {}) => {
    if (state.adminLoading || state.currentProfile?.role !== "admin") return;
    state.adminLoading = true;
    state.adminError = "";
    if (!preserveNotice) state.adminNotice = "";
    render();
    try {
      const result = await adminApi("list");
      state.adminUsers = (result.users || []).sort((left, right) =>
        String(left.display_name || left.login_name).localeCompare(String(right.display_name || right.login_name)),
      );
      state.adminUsersLoaded = true;
    } catch (error) {
      state.adminError = error instanceof Error ? error.message : "ATLAS accounts could not be loaded.";
    } finally {
      state.adminLoading = false;
      render();
    }
  };

  const rowsInRange = () => {
    const now = new Date();
    let start = null, end = null;
    if (state.range === "today") start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    else if (state.range === "week") { start = new Date(now.getFullYear(), now.getMonth(), now.getDate()); start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); }
    else if (state.range === "7" || state.range === "30") { start = new Date(now); start.setDate(start.getDate() - Number(state.range) + 1); start.setHours(0, 0, 0, 0); }
    else if (state.range === "custom") { start = state.customStart ? new Date(`${state.customStart}T00:00:00`) : null; end = state.customEnd ? new Date(`${state.customEnd}T23:59:59`) : null; }
    return state.normalized.filter((row) => (!start || row.timestamp >= start.getTime()) && (!end || row.timestamp <= end.getTime()));
  };

  const visibleRows = () => {
    const search = state.search.trim().toLowerCase();
    return rowsInRange().filter((row) => {
      if (state.filter === "operational" && !row.operational) return false;
      if (state.filter !== "operational" && state.filter !== "all" && row.key !== state.filter) return false;
      if (!search) return true;
      return [row.sku, row.employee, row.label, row.detail, row.location, row.rawAction]
        .join(" ")
        .toLowerCase()
        .includes(search);
    });
  };

  const isNotificationAction = (row) => row.operational || row.key === "delete-request";

  const todayNotifications = () => {
    const today = pacificDateKey(new Date());
    return state.normalized.filter(
      (row) => isNotificationAction(row) && pacificDateKey(row.date) === today,
    );
  };

  const renderAccess = () => {
    const sessionRole = state.currentProfile?.role
      || state.session?.user?.app_metadata?.atlas_role
      || state.session?.user?.app_metadata?.role
      || "picker";
    const signedInName = window.AtlasAuth?.displayName?.(state.session)
      || state.currentProfile?.display_name
      || "ATLAS employee";
    return state.session && !["supervisor", "admin"].includes(sessionRole) ? `
    <div class="atlas-dashboard-access">
      <img class="atlas-dashboard-access-logo" src="./atlas-brand-landscape-light.svg?v=131" alt="ATLAS Warehouse Management">
      <p class="atlas-dashboard-eyebrow">WAREHOUSE ACCESS</p>
      <h2>Dashboard access is restricted</h2>
      <p><strong>${escapeHtml(signedInName)}</strong> is signed in as a ${escapeHtml(roleLabel(sessionRole))}. Your account can use SKU search, inventory tools, and COC workflows. Operational oversight is reserved for supervisors and administrators.</p>
      <div class="atlas-dashboard-access-identity"><span>${escapeHtml(roleLabel(sessionRole))}</span><strong>${escapeHtml(signedInName)}</strong></div>
      <div class="atlas-dashboard-access-actions"><button class="atlas-dashboard-button atlas-dashboard-button--primary" type="button" data-dashboard-close>Return to ATLAS</button><button class="atlas-dashboard-button" type="button" data-sign-out>Switch Account</button></div>
    </div>` : `
    <div class="atlas-dashboard-access">
      <img class="atlas-dashboard-access-logo" src="./atlas-brand-landscape-light.svg?v=131" alt="ATLAS Warehouse Management">
      <p class="atlas-dashboard-eyebrow">ATLAS CONTROL CENTER</p>
      <h2>Sign in to the dashboard</h2>
      <p>Use a supervisor or administrator account to open operational history, COC oversight, and account controls. This device will remain signed in until you sign out.</p>
      <form class="atlas-dashboard-access-form" data-sign-in>
        <label><span>Employee name</span><input type="text" name="login_name" autocomplete="username" autocapitalize="words" required></label>
        <label><span>Password</span>${passwordField({ autocomplete: "current-password" })}</label>
        <p class="atlas-dashboard-access-message" data-access-message></p>
        <button class="atlas-dashboard-button atlas-dashboard-button--primary" type="submit">Sign In &amp; Open Dashboard</button>
      </form>
    </div>`;
  };

  const renderLoading = () => `
    <div class="atlas-dashboard-loading">
      <span class="atlas-dashboard-spinner" aria-hidden="true"></span>
      <strong>Loading warehouse activity</strong>
      <p>ATLAS is organizing inventory, SKU, location, and employee records.</p>
    </div>`;

  const renderSummaryCard = (label, value, note, icon, color) => `
    <article class="atlas-dashboard-card" style="--card-color:${color}">
      <span class="atlas-dashboard-card-icon" aria-hidden="true">${icon}</span>
      <span class="atlas-dashboard-card-copy"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></span>
    </article>`;

  const activityPresentation = (key) => ({
    move: { icon: "⇄", category: "Move" },
    location: { icon: "−", category: "Location" },
    create: { icon: "+", category: "New SKU" },
    edit: { icon: "✎", category: "Edit" },
    pick: { icon: "★", category: "Pick First" },
    delete: { icon: "!", category: "Delete" },
    "delete-request": { icon: "!", category: "Review" },
    undo: { icon: "↶", category: "Undo" },
    access: { icon: "✓", category: "Access" },
    audit: { icon: "•", category: "Audit" },
  }[key] || { icon: "•", category: "Activity" });

  const activityContext = (row) => {
    const hasLocation = row.to !== "—" || row.from !== "—";
    const hasRoute = row.from !== "—" && row.to !== "—" && row.from !== row.to;
    const location = row.to !== "—" ? row.to : row.from;
    const snapshot = row.snapshotId ? state.undoSnapshots.find((item) => item.id === row.snapshotId) : null;
    let detail = {
      move: hasRoute ? "Inventory transfer" : "Inventory placement",
      location: row.label,
      create: "New location active",
      edit: "SKU record updated",
      pick: "Pick First updated",
      delete: "History retained",
      "delete-request": "Supervisor review",
      undo: "Reversal recorded",
      access: "Account activity",
      audit: "Audit record",
    }[row.key] || "Recorded activity";

    if (snapshot?.undone_at) detail = "Action reversed";
    else if (snapshot) detail = "Undo available";

    return {
      value: hasRoute ? `${row.from} → ${row.to}` : hasLocation ? location : "System",
      detail,
    };
  };

  const renderFeed = (rows) => {
    if (!rows.length) {
      return `<div class="atlas-dashboard-empty"><strong>No matching activity</strong><p>Try a broader date range, a different action filter, or clear the search.</p></div>`;
    }
    return rows.slice(0, 250).map((row) => {
      const presentation = activityPresentation(row.key);
      const context = activityContext(row);
      const isPickFirst = row.key === "pick";
      return `
      <button type="button" class="atlas-dashboard-feed-row" data-activity-id="${escapeHtml(row.id)}" style="--activity-color:${row.color};--activity-icon-ink:${isPickFirst ? "#694600" : "#fff"};--activity-tag-ink:${isPickFirst ? "#694600" : row.color}">
        <span class="atlas-dashboard-activity-icon" aria-hidden="true">${presentation.icon}</span>
        <span class="atlas-dashboard-feed-primary"><strong>${escapeHtml(row.employee)}</strong><small>${escapeHtml(formatDateTime(row.date, true))}</small></span>
        <span class="atlas-dashboard-feed-detail"><span class="atlas-dashboard-feed-action-line"><strong class="atlas-dashboard-feed-action">${escapeHtml(row.label)}</strong><span class="atlas-dashboard-activity-kind">${escapeHtml(presentation.category)}</span></span><small>${escapeHtml(row.sku)}${row.detail && row.detail !== row.label ? ` · ${escapeHtml(row.detail)}` : ""}</small></span>
        <span class="atlas-dashboard-feed-context"><strong>${escapeHtml(context.value)}</strong><small>${escapeHtml(context.detail)}</small></span>
      </button>`;
    }).join("");
  };

  const renderTodaySummary = (rows, rangeLabel) => {
    const definitions = [
      ["move", "Inventory Moves", ACTION_COLORS.move], ["location", "Locations Marked Empty", ACTION_COLORS.location],
      ["create", "New SKUs", ACTION_COLORS.create], ["edit", "SKU Edits", ACTION_COLORS.edit],
      ["pick", "Pick First Changes", ACTION_COLORS.pick], ["delete", "Deleted SKUs", ACTION_COLORS.delete],
    ];
    const summaryTitle = rangeLabel === "Today" ? "Today's Summary" : `${rangeLabel} Summary`;
    return `<article class="atlas-dashboard-panel atlas-dashboard-today-summary"><header class="atlas-dashboard-panel-head"><div><h2>${escapeHtml(summaryTitle)}</h2><p>Completed warehouse actions</p></div></header><div class="atlas-dashboard-today-total"><strong>${rows.length}</strong><span>total changes</span></div><div class="atlas-dashboard-summary-breakdown">${definitions.map(([key, label, color]) => `<span><i style="--summary-color:${color}"></i><b>${rows.filter((row) => row.key === key).length}</b>${escapeHtml(label)}</span>`).join("")}</div></article>`;
  };

  const renderNotificationCenter = (rows) => {
    const pendingReview = state.deleteRequests.some((request) => request.status === "pending");
    if (!state.notificationsOpen) return "";
    const content = rows.length
      ? rows.slice(0, 24).map((row) => {
          const presentation = activityPresentation(row.key);
          const context = activityContext(row);
          const isPickFirst = row.key === "pick";
          return `<button type="button" class="atlas-dashboard-notification-row" data-notification-id="${escapeHtml(row.id)}" style="--notification-color:${row.color};--notification-icon-ink:${isPickFirst ? "#694600" : "#fff"}">
            <span class="atlas-dashboard-notification-icon" aria-hidden="true">${presentation.icon}</span>
            <span class="atlas-dashboard-notification-copy"><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.employee)} · ${escapeHtml(row.sku)}</small></span>
            <span class="atlas-dashboard-notification-meta"><strong>${escapeHtml(context.value)}</strong><small>${escapeHtml(formatPacificTime(row.date))}</small></span>
          </button>`;
        }).join("")
      : `<div class="atlas-dashboard-notification-empty"><strong>No warehouse actions yet today</strong><p>New activity will appear here as ATLAS records it.</p></div>`;
    return `<div class="atlas-dashboard-notification-scrim" data-notifications-close></div>
      <section class="atlas-dashboard-notification-panel" role="dialog" aria-label="Today's warehouse activity">
        <header><div><p class="atlas-dashboard-eyebrow">NOTIFICATIONS</p><h2>Today's Warehouse Activity</h2><span>${rows.length} recorded ${rows.length === 1 ? "action" : "actions"} · ${escapeHtml(state.selectedWarehouse?.code || "CA")} local time</span></div><button type="button" class="atlas-dashboard-notification-close" data-notifications-close aria-label="Close notifications">×</button></header>
        ${pendingReview ? `<div class="atlas-dashboard-notification-attention"><span aria-hidden="true">!</span><strong>Deletion review pending</strong><small>Open Warehouse Status to review the request.</small></div>` : ""}
        <div class="atlas-dashboard-notification-list">${content}</div>
      </section>`;
  };

  const renderNotificationBell = (rows) => {
    const count = rows.length;
    const hasActions = count > 0;
    const hasCompletedDeletion = rows.some((row) => row.key === "delete");
    const pendingReview = state.deleteRequests.some((request) => request.status === "pending");
    const badge = count > 99 ? "99+" : String(count);
    return `<div class="atlas-dashboard-notification-center">
      <button type="button" class="atlas-dashboard-notification-bell ${state.notificationsOpen ? "is-open" : ""}" data-notifications-toggle aria-label="${count} warehouse actions recorded today" aria-expanded="${state.notificationsOpen ? "true" : "false"}">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18.1 10.4c0-3.5-2.2-6.2-6.1-6.2s-6.1 2.7-6.1 6.2c0 4.1-1.8 5.5-2.3 6.4h16.8c-.5-.9-2.3-2.3-2.3-6.4Z"></path><path d="M9.4 20c.5.6 1.4 1 2.6 1s2.1-.4 2.6-1"></path></svg>
        <span class="atlas-dashboard-notification-badge ${hasCompletedDeletion ? "is-delete-alert" : hasActions ? "" : "is-empty"}">${badge}</span>${pendingReview ? `<i class="atlas-dashboard-notification-attention-dot" aria-label="Deletion review pending"></i>` : ""}
      </button>
    </div>`;
  };

  const renderWarehouseStatus = () => {
    const pending = state.deleteRequests.filter((request) => request.status === "pending");
    return `<article class="atlas-dashboard-panel atlas-dashboard-status-panel"><header class="atlas-dashboard-panel-head"><div><h2>Warehouse Status</h2><p>Supervisor attention</p></div></header>${pending.length ? `<div class="atlas-dashboard-status-attention"><strong>${pending.length} SKU deletion ${pending.length === 1 ? "request requires" : "requests require"} approval</strong><p>Pending requests do not change inventory until a supervisor approves them.</p><button type="button" class="atlas-dashboard-button atlas-dashboard-button--primary" data-review-pending>Review requests</button></div>` : `<div class="atlas-dashboard-status-ok"><strong>All systems normal</strong><p>No items requiring attention</p></div>`}</article>`;
  };

  const renderDrawerProductImage = (productImage, sku) => {
    if (!productImage) return "";
    return `<figure class="atlas-dashboard-drawer-product">
      <div class="atlas-dashboard-drawer-product-media"><img src="${escapeHtml(productImage.src)}" alt="${escapeHtml(productImage.label)} product image" decoding="async" onerror="this.closest('.atlas-dashboard-drawer-product').remove()"></div>
      <figcaption><span>PRODUCT REFERENCE</span><strong>${escapeHtml(sku)}</strong></figcaption>
    </figure>`;
  };

  const renderActivityDrawer = () => {
    const target = state.drawer?.kind === "request" ? state.deleteRequests.find((request) => request.id === state.drawer.id) : state.normalized.find((row) => row.id === state.drawer?.id);
    if (!target) return "";
    if (state.drawer?.kind === "request") {
      const sku = safeJson(target.sku_snapshot).sku || "SKU";
      const productImage = productImageForSku(sku);
      const reviewer = state.currentProfile?.role === "supervisor" || state.currentProfile?.role === "admin";
      return `<div class="atlas-dashboard-drawer-backdrop" data-drawer-close><aside class="atlas-dashboard-drawer" role="dialog" aria-modal="true"><button type="button" class="atlas-account-modal-close" data-drawer-close aria-label="Close">×</button><p class="atlas-dashboard-eyebrow">SUPERVISOR REVIEW</p><h2>Delete ${escapeHtml(sku)}?</h2>${renderDrawerProductImage(productImage, sku)}<p><strong>${escapeHtml(target.requested_by_name)}</strong> requested permanent deletion. The SKU and its active locations remain unchanged until approval.</p><dl><div><dt>Requested</dt><dd>${escapeHtml(formatDateTime(parseDate(target.requested_at)))}</dd></div><div><dt>SKU</dt><dd>${escapeHtml(sku)}</dd></div></dl>${reviewer && target.status === "pending" ? `<div class="atlas-dashboard-drawer-actions"><button type="button" class="atlas-dashboard-button" data-reject-request data-request-id="${escapeHtml(target.id)}">Reject</button><button type="button" class="atlas-dashboard-button atlas-dashboard-button--danger" data-approve-request data-request-id="${escapeHtml(target.id)}">Approve & Delete</button></div>` : `<p class="atlas-dashboard-drawer-note">Status: ${escapeHtml(target.status)}</p>`}</aside></div>`;
    }
    const snapshot = state.undoSnapshots.find((item) => item.id === target.snapshotId);
    const reviewer = state.currentProfile?.role === "supervisor" || state.currentProfile?.role === "admin";
    const productImage = productImageForSku(target.sku);
    const locationRows = target.from !== "—" && target.to !== "—"
      ? `<div><dt>From</dt><dd>${escapeHtml(target.from)}</dd></div><div><dt>To</dt><dd>${escapeHtml(target.to)}</dd></div>`
      : `<div><dt>Location</dt><dd>${escapeHtml(target.location)}</dd></div>`;
    return `<div class="atlas-dashboard-drawer-backdrop" data-drawer-close><aside class="atlas-dashboard-drawer" role="dialog" aria-modal="true"><button type="button" class="atlas-account-modal-close" data-drawer-close aria-label="Close">×</button><p class="atlas-dashboard-eyebrow">ACTIVITY DETAIL</p><h2>${escapeHtml(target.label)}</h2>${renderDrawerProductImage(productImage, target.sku)}<dl><div><dt>SKU</dt><dd>${escapeHtml(target.sku)}</dd></div><div><dt>Employee</dt><dd>${escapeHtml(target.employee)}</dd></div>${locationRows}<div><dt>Recorded</dt><dd>${escapeHtml(formatDateTime(target.date))}</dd></div><div><dt>Reason</dt><dd>${escapeHtml(target.detail)}</dd></div></dl>${snapshot ? (snapshot.undone_at ? `<p class="atlas-dashboard-drawer-note">This action was already reversed by ${escapeHtml(snapshot.undone_by_name || "a supervisor")}.</p>` : reviewer ? `<div class="atlas-dashboard-drawer-actions"><button type="button" class="atlas-dashboard-button atlas-dashboard-button--primary" data-undo-activity data-snapshot-id="${escapeHtml(snapshot.id)}">Undo Action</button></div>` : "") : `<p class="atlas-dashboard-drawer-note">Undo unavailable — this action was recorded before ATLAS reversible audit snapshots were enabled.</p>`}</aside></div>`;
  };

  const renderBars = (rows) => {
    const definitions = [
      ["move", "Moves", ACTION_COLORS.move],
      ["create", "New SKUs", ACTION_COLORS.create],
      ["edit", "SKU edits", ACTION_COLORS.edit],
      ["pick", "Pick First", ACTION_COLORS.pick],
      ["location", "Location", ACTION_COLORS.location],
      ["access", "Accounts", "#0b8a9f"],
    ];
    const counts = Object.fromEntries(definitions.map(([key]) => [key, rows.filter((row) => row.key === key).length]));
    const max = Math.max(1, ...Object.values(counts));
    return definitions.map(([key, label, color]) => `
      <div class="atlas-dashboard-bar-row"><span>${label}</span><div class="atlas-dashboard-bar-track"><div class="atlas-dashboard-bar-fill" style="--bar-width:${(counts[key] / max) * 100}%;--bar-color:${color}"></div></div><strong>${counts[key]}</strong></div>`).join("");
  };

  const renderPeople = (rows) => {
    const counts = new Map();
    rows.filter((row) => row.operational).forEach((row) => counts.set(row.employee, (counts.get(row.employee) || 0) + 1));
    const people = [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 6);
    if (!people.length) return `<div class="atlas-dashboard-empty" style="min-height:160px"><p>No employee activity in this range.</p></div>`;
    return people.map(([name, count]) => `
      <div class="atlas-dashboard-person"><span class="atlas-dashboard-avatar">${escapeHtml(initials(name))}</span><span><strong>${escapeHtml(name)}</strong><small>Recorded activity</small></span><span>${count}</span></div>`).join("");
  };

  const accountDate = (value) => {
    const date = parseDate(value);
    if (!date) return "Never";
    return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  };

  const roleLabel = (role) =>
    ({ admin: "Administrator", supervisor: "Supervisor", office_receiver: "Office Receiver", picker: "Picker" })[role] || "Picker";

  const renderPremiumSelect = ({ name = "", value, options, ariaLabel, dataAttribute = "", className = "" }) => {
    const selected = options.find((option) => option.value === value) || options[0];
    const selectId = `atlas-select-${Math.random().toString(36).slice(2, 9)}`;
    const checkIcon = `<svg class="atlas-premium-select-check" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10.5 3.1 3.1L15.5 6.4"></path></svg>`;
    const chevron = `<svg class="atlas-premium-select-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 7.5 4.5 4.5 4.5-4.5"></path></svg>`;
    return `<div class="atlas-premium-select ${escapeHtml(className)}" data-atlas-select>
      <select class="atlas-premium-select-native" ${name ? `name="${escapeHtml(name)}"` : ""} ${dataAttribute} tabindex="-1" aria-hidden="true">
        ${options.map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === selected.value ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}
      </select>
      <button type="button" class="atlas-premium-select-trigger" data-atlas-select-trigger aria-haspopup="listbox" aria-expanded="false" aria-controls="${selectId}" aria-label="${escapeHtml(ariaLabel)}">
        <span class="atlas-premium-select-trigger-copy">${selected.badge ? `<b data-atlas-select-badge>${escapeHtml(selected.badge)}</b>` : ""}<span data-atlas-select-value>${escapeHtml(selected.label)}</span></span>${chevron}
      </button>
      <div class="atlas-premium-select-menu" id="${selectId}" data-atlas-select-menu role="listbox" aria-label="${escapeHtml(ariaLabel)}" hidden>
        ${options.map((option) => `<button type="button" class="atlas-premium-select-option" data-atlas-select-option data-value="${escapeHtml(option.value)}" data-label="${escapeHtml(option.label)}" data-badge="${escapeHtml(option.badge || "")}" role="option" aria-selected="${option.value === selected.value}">
          ${option.badge ? `<span class="atlas-premium-select-option-badge is-${escapeHtml(String(option.value).replaceAll("_", "-"))}">${escapeHtml(option.badge)}</span>` : ""}
          <span class="atlas-premium-select-option-copy"><strong>${escapeHtml(option.label)}</strong>${option.meta ? `<small>${escapeHtml(option.meta)}</small>` : ""}</span>${checkIcon}
        </button>`).join("")}
      </div>
    </div>`;
  };

  const warehouseSelectOptions = () => [...new Map((state.warehouses.length
    ? state.warehouses
    : [{ code: "CA", display_name: "California Warehouse" }, { code: "TX", display_name: "Texas Warehouse" }])
    .map((warehouse) => [warehouse.code, warehouse])).values()].map((warehouse) => ({
      value: warehouse.code,
      label: `${warehouse.code} · ${warehouse.display_name}`,
      badge: warehouse.code,
      meta: warehouse.code === "CA" ? "California operations" : warehouse.code === "TX" ? "Texas operations" : "Warehouse operations",
    }));

  const roleSelectOptions = () => [
    { value: "picker", label: "Picker", badge: "P", meta: "Warehouse inventory access" },
    { value: "office_receiver", label: "Office Receiver", badge: "OR", meta: "Dedicated COC receiving station" },
    { value: "supervisor", label: "Supervisor", badge: "S", meta: "Warehouse oversight and approvals" },
    { value: "admin", label: "Administrator", badge: "A", meta: "CA + TX control center access" },
  ];

  const renderAccountModal = () => {
    if (!state.accountModal) return "";
    const mode = state.accountModal.mode;
    const user = state.adminUsers.find((item) => item.id === state.accountModal.userId);
    if (mode !== "create" && !user) return "";
    if (mode === "confirm-delete") {
      return `
        <div class="atlas-account-modal-backdrop" data-account-modal-backdrop>
          <section class="atlas-account-modal atlas-account-confirm" role="dialog" aria-modal="true" aria-labelledby="atlasAccountConfirmTitle">
            <button type="button" class="atlas-account-modal-close" data-account-close aria-label="Close">×</button>
            <span class="atlas-account-modal-icon is-danger" aria-hidden="true">!</span>
            <h2 id="atlasAccountConfirmTitle">Delete this account permanently?</h2>
            <p><strong>${escapeHtml(user.display_name || user.login_name)}</strong> will no longer be able to sign in. This action cannot be undone. Historical warehouse activity will remain intact.</p>
            ${state.accountDeleteError ? `<div class="atlas-account-notice is-error" role="alert">${escapeHtml(state.accountDeleteError)}</div>` : ""}
            <div class="atlas-account-modal-actions">
              <button type="button" class="atlas-dashboard-button" data-account-close ${state.adminLoading ? "disabled" : ""}>Cancel</button>
              <button type="button" class="atlas-dashboard-button atlas-dashboard-button--danger" data-account-delete data-user-id="${escapeHtml(user.id)}" ${state.adminLoading ? "disabled" : ""}>${state.adminLoading ? "Deleting…" : "Delete Account"}</button>
            </div>
          </section>
        </div>`;
    }
    const isCreate = mode === "create";
    const selectedWarehouseCode = isCreate ? (state.selectedWarehouse?.code || "CA") : (user.warehouse_code || "CA");
    return `
      <div class="atlas-account-modal-backdrop" data-account-modal-backdrop>
        <section class="atlas-account-modal" role="dialog" aria-modal="true" aria-labelledby="atlasAccountModalTitle">
          <button type="button" class="atlas-account-modal-close" data-account-close aria-label="Close">×</button>
          <p class="atlas-dashboard-eyebrow">ADMINISTRATOR CONTROL</p>
          <h2 id="atlasAccountModalTitle">${isCreate ? "Add ATLAS Account" : "Manage Account"}</h2>
          <p>${isCreate ? "Create a simple employee name-and-password sign-in and choose exactly what this employee can access." : `Update ${escapeHtml(user.display_name || user.login_name)} without opening Supabase.`}</p>
          <form class="atlas-account-form" data-${isCreate ? "account-create" : "account-update"}>
            ${isCreate ? "" : `<input type="hidden" name="user_id" value="${escapeHtml(user.id)}">`}
            <div class="atlas-account-form-grid">
              <label><span>Display name</span><input type="text" name="display_name" value="${escapeHtml(isCreate ? "" : user.display_name)}" autocomplete="off" required><small>The name shown on ATLAS records and activity.</small></label>
              <label><span>Sign-in name</span><input type="text" name="login_name" value="${escapeHtml(isCreate ? "" : user.login_name)}" autocomplete="off" placeholder="Example: Zach" required><small>The simple name this employee enters with their password.</small></label>
              <div class="atlas-account-field atlas-account-field--role"><span>ATLAS role</span>${renderPremiumSelect({ name: "role", value: isCreate ? "picker" : user.role, options: roleSelectOptions(), ariaLabel: "Select ATLAS role", className: "atlas-premium-select--role" })}<small>Choose the employee’s ATLAS permissions.</small></div>
              <div class="atlas-account-field atlas-account-field--warehouse"><span>Home warehouse</span>${renderPremiumSelect({ name: "warehouse_code", value: selectedWarehouseCode, options: warehouseSelectOptions(), ariaLabel: "Select home warehouse", className: "atlas-premium-select--warehouse" })}<small>Employees and supervisors are locked to this warehouse. Administrators can view both.</small></div>
              ${isCreate ? `<label><span>Password</span>${passwordField({ autocomplete: "new-password", minlength: 10 })}<small>At least 10 characters</small></label>` : ""}
            </div>
            <p class="atlas-account-form-message" data-account-message></p>
            <div class="atlas-account-modal-actions">
              <button type="button" class="atlas-dashboard-button" data-account-close>Cancel</button>
              <button type="submit" class="atlas-dashboard-button atlas-dashboard-button--primary">${isCreate ? "Create Account" : "Save Changes"}</button>
            </div>
          </form>
          ${isCreate ? "" : `
            <div class="atlas-account-security">
              <div><h3>Change Password</h3><p>Set a new sign-in password for this account.</p></div>
              <form data-account-password>
                <input type="hidden" name="user_id" value="${escapeHtml(user.id)}">
                <label><span>New password</span>${passwordField({ autocomplete: "new-password", minlength: 10 })}</label>
                <button type="submit" class="atlas-dashboard-button">Change Password</button>
              </form>
              <button type="button" class="atlas-dashboard-button atlas-dashboard-button--danger-ghost" data-account-confirm-delete data-user-id="${escapeHtml(user.id)}" ${user.is_current ? "disabled title=\"You cannot delete your own account\"" : ""}>Delete Account</button>
            </div>`}
        </section>
      </div>`;
  };

  const renderAccessManagement = () => {
    const active = state.adminUsers.filter((user) => user.active).length;
    const supervisors = state.adminUsers.filter((user) => user.active && user.role === "supervisor").length;
    const admins = state.adminUsers.filter((user) => user.active && user.role === "admin").length;
    const search = state.accountSearch.trim().toLowerCase();
    const filteredUsers = state.adminUsers.filter((user) => {
      if (state.accountWarehouseFilter !== "all" && (user.warehouse_code || "CA") !== state.accountWarehouseFilter) return false;
      if (state.accountRoleFilter !== "all" && user.role !== state.accountRoleFilter) return false;
      if (state.accountStatusFilter === "active" && !user.active) return false;
      if (state.accountStatusFilter === "inactive" && user.active) return false;
      if (search && !`${user.display_name || ""} ${user.login_name || ""}`.toLowerCase().includes(search)) return false;
      return true;
    }).sort((left, right) => {
      if (state.accountSort === "role") return roleLabel(left.role).localeCompare(roleLabel(right.role)) || String(left.display_name || left.login_name).localeCompare(String(right.display_name || right.login_name));
      if (state.accountSort === "warehouse") return String(left.warehouse_code || "CA").localeCompare(String(right.warehouse_code || "CA")) || String(left.display_name || left.login_name).localeCompare(String(right.display_name || right.login_name));
      if (state.accountSort === "recent") return (parseDate(right.last_sign_in_at)?.getTime() || 0) - (parseDate(left.last_sign_in_at)?.getTime() || 0);
      return String(left.display_name || left.login_name).localeCompare(String(right.display_name || right.login_name));
    });
    const rows = filteredUsers.map((user) => `
      <article class="atlas-account-row ${user.active ? "" : "is-disabled"}">
        <span class="atlas-dashboard-avatar">${escapeHtml(initials(user.display_name || user.login_name))}</span>
        <span class="atlas-account-identity"><strong>${escapeHtml(user.display_name || "Unnamed account")}${user.is_current ? " <small>(You)</small>" : ""}</strong><span>${escapeHtml(roleLabel(user.role))} account</span></span>
        <span class="atlas-account-role is-${escapeHtml(user.role)}">${escapeHtml(roleLabel(user.role))}</span>
        <span class="atlas-account-warehouse" title="Home warehouse: ${escapeHtml(user.warehouse_code || "CA")}">${escapeHtml(user.role === "admin" && Array.isArray(user.warehouse_access) && user.warehouse_access.length > 1 ? user.warehouse_access.join(" + ") : user.warehouse_code || "CA")}</span>
        <span class="atlas-account-status"><i class="${user.active ? "is-active" : ""}"></i>${user.active ? "Active" : "Inactive (legacy)"}</span>
        <span class="atlas-account-last"><small>Last sign-in</small><strong>${escapeHtml(accountDate(user.last_sign_in_at))}</strong></span>
        <button type="button" class="atlas-dashboard-button" data-account-edit data-user-id="${escapeHtml(user.id)}">Manage</button>
      </article>`).join("");
    return `
      <section class="atlas-access-management" aria-label="ATLAS access management">
        ${state.adminNotice ? `<div class="atlas-account-notice is-success">${escapeHtml(state.adminNotice)}</div>` : ""}
        ${state.adminError ? `<div class="atlas-account-notice is-error">${escapeHtml(state.adminError)}</div>` : ""}
        <div class="atlas-access-summary">
          <article><span>Active Accounts</span><strong>${active}</strong></article>
          <article><span>Supervisors</span><strong>${supervisors}</strong></article>
          <article><span>Administrators</span><strong>${admins}</strong></article>
        </div>
        <article class="atlas-dashboard-panel atlas-account-panel">
          <header class="atlas-dashboard-panel-head"><div><h2>ATLAS Accounts</h2><p>Roles, sign-in status, and employee identity</p></div><span class="atlas-account-secure">ADMIN ONLY</span></header>
          <div class="atlas-account-filters">
            <nav class="atlas-account-warehouse-tabs" aria-label="Filter accounts by home warehouse">
              ${[{ code: "all", display_name: "All Accounts" }, ...state.warehouses].map((warehouse) => `<button type="button" data-account-warehouse-filter="${escapeHtml(warehouse.code)}" class="${state.accountWarehouseFilter === warehouse.code ? "is-active" : ""}">${escapeHtml(warehouse.code === "all" ? warehouse.display_name : warehouse.code)}</button>`).join("")}
            </nav>
            <div class="atlas-account-filter-controls">
              <label class="atlas-account-search"><span class="sr-only">Search employees</span><input type="search" data-account-search value="${escapeHtml(state.accountSearch)}" placeholder="Search employee" aria-label="Search employees"></label>
              ${renderPremiumSelect({ value: state.accountRoleFilter, options: [{ value: "all", label: "All roles", badge: "ALL", meta: "Every ATLAS role" }, ...roleSelectOptions()], ariaLabel: "Filter accounts by role", dataAttribute: "data-account-role-filter", className: "atlas-premium-select--filter" })}
              ${renderPremiumSelect({ value: state.accountStatusFilter, options: [{ value: "all", label: "All statuses", badge: "ALL" }, { value: "active", label: "Active", badge: "ON" }, { value: "inactive", label: "Inactive", badge: "OFF" }], ariaLabel: "Filter accounts by status", dataAttribute: "data-account-status-filter", className: "atlas-premium-select--filter" })}
              ${renderPremiumSelect({ value: state.accountSort, options: [{ value: "name", label: "Name A–Z", badge: "AZ" }, { value: "role", label: "Role", badge: "R" }, { value: "warehouse", label: "Warehouse", badge: "WH" }, { value: "recent", label: "Last sign-in", badge: "↻" }], ariaLabel: "Sort accounts", dataAttribute: "data-account-sort", className: "atlas-premium-select--filter atlas-premium-select--sort" })}
            </div>
            <p class="atlas-account-filter-result">Showing ${filteredUsers.length.toLocaleString()} of ${state.adminUsers.length.toLocaleString()} accounts</p>
          </div>
          <div class="atlas-account-list">
            ${state.adminLoading && !state.adminUsersLoaded ? renderLoading() : rows || `<div class="atlas-dashboard-empty"><strong>No accounts match these filters</strong><p>Adjust the warehouse, role, status, or employee search.</p></div>`}
          </div>
        </article>
      </section>
      ${renderAccountModal()}`;
  };

  const renderCocDeleteModal = () => {
    const record = state.cocDelete;
    if (!record) return "";
    const snap = cocSnapshot(record);
    return `<div class="atlas-dashboard-coc-modal-backdrop" data-coc-delete-close>
      <form class="atlas-dashboard-coc-modal" data-coc-delete-form role="dialog" aria-modal="true" aria-labelledby="atlasCocDeleteTitle">
        <p class="atlas-dashboard-eyebrow">PERMANENT COC DELETION</p>
        <h2 id="atlasCocDeleteTitle">Delete ${escapeHtml(snap.invoiceNumber || "this COC")}?</h2>
        <p>This permanently removes the central COC record and saved workbook. ATLAS will retain a deletion audit showing who removed it and why.</p>
        <label><span>Reason for deletion</span><textarea name="reason" minlength="4" maxlength="300" placeholder="Example: Duplicate test COC" required></textarea></label>
        <label><span>Type the invoice number to confirm</span><input name="confirmation" autocomplete="off" placeholder="${escapeHtml(snap.invoiceNumber || "Invoice number")}" required></label>
        <p class="atlas-dashboard-coc-form-error" data-coc-delete-error role="alert"></p>
        <div><button type="button" class="atlas-dashboard-button" data-coc-delete-close>Cancel</button><button type="submit" class="atlas-dashboard-button atlas-dashboard-button--danger">Permanently Delete COC</button></div>
      </form>
    </div>`;
  };

  const scannerCorrectionAudit = (lot) => lot?.scannerReviewTracked && lot?.scannerTextCorrected
    ? `<small class="atlas-dashboard-coc-scan-correction">SCANNER PROPOSED <b>${escapeHtml(lot.scannerOriginalLot || "—")}</b> · ${cocPlural(lot.scannerEditDistance, "character")} corrected</small>`
    : "";

  const renderCocPallets = (record) => (cocSnapshot(record).pallets || []).map((pallet) => `
    <section class="atlas-dashboard-coc-pallet"><header><h3>PALLET ${escapeHtml(pallet.number)}</h3><strong>${cocPlural((pallet.lots || []).reduce((sum, lot) => sum + Number(lot.cases || 0), 0), "box")}</strong></header>
      ${(pallet.lots || []).map((lot) => `<div class="atlas-dashboard-coc-lot"><span><strong>${escapeHtml(lot.model || "—")}</strong><small>LOT <b>${escapeHtml(lot.lot || "—")}</b></small>${scannerCorrectionAudit(lot)}</span><b>${cocPlural(lot.cases, "box")} · ${(Number(lot.cases || 0) * Number(lot.caseQuantity || 0)).toLocaleString()} units</b></div>`).join("")}
    </section>`).join("");

  const renderCocPreview = (record) => {
    const snap = cocSnapshot(record);
    const body = state.cocPreview.status === "ready" && state.cocPreview.id === record.id
      ? state.cocPreview.html
      : state.cocPreview.status === "error"
        ? `<div class="atlas-dashboard-coc-preview-status is-error"><strong>Preview unavailable</strong><p>${escapeHtml(state.cocPreview.error)}</p><button class="atlas-dashboard-button atlas-dashboard-button--primary" data-coc-official="${escapeHtml(record.id)}">Try Again</button></div>`
        : `<div class="atlas-dashboard-coc-preview-status"><span class="atlas-dashboard-spinner"></span><strong>Opening the saved Official COC…</strong><p>ATLAS is reading the actual XLSX workbook.</p></div>`;
    return `<section class="atlas-dashboard-coc-detail">
      <button class="atlas-dashboard-coc-back" type="button" data-coc-preview-back>‹ COC Operations</button>
      <header class="atlas-dashboard-coc-detail-head"><p class="atlas-dashboard-eyebrow">ACTUAL WORKBOOK · READ ONLY</p><h2>Official COC</h2><span>${escapeHtml(snap.customerName || "—")} · ${escapeHtml(snap.invoiceNumber || "—")}</span></header>
      ${body}
      <div class="atlas-dashboard-coc-detail-actions"><button class="atlas-dashboard-button atlas-dashboard-button--primary" data-coc-download="${escapeHtml(record.id)}">Download Official COC</button></div>
    </section>`;
  };

  const renderCocDetail = (record) => {
    if (state.cocPreview.status !== "idle") return renderCocPreview(record);
    const snap = cocSnapshot(record), totals = cocTotals(record), performance = cocRecordPerformance(record);
    return `<section class="atlas-dashboard-coc-detail">
      <button class="atlas-dashboard-coc-back" type="button" data-coc-detail-back>‹ All COCs</button>
      <header class="atlas-dashboard-coc-detail-head"><p class="atlas-dashboard-eyebrow">${escapeHtml(cocStatus(record).toUpperCase())}</p><h2>${escapeHtml(snap.customerName || "—")}</h2><span>${escapeHtml(snap.invoiceNumber || "—")}</span></header>
      <dl class="atlas-dashboard-coc-fields"><div><dt>Invoice</dt><dd>${escapeHtml(snap.invoiceNumber || "—")}</dd></div><div><dt>IF Number</dt><dd>${escapeHtml(snap.ifNumber || "—")}</dd></div><div><dt>Sent By</dt><dd>${escapeHtml(record.submitted_by_display_name || snap.employeeDisplayName || snap.employee || "—")}</dd></div><div><dt>Recorded</dt><dd>${escapeHtml(formatDateTime(parseDate(cocRecordDate(record))))}</dd></div><div><dt>Pallets</dt><dd>${totals.pallets}</dd></div><div><dt>Boxes</dt><dd>${totals.boxes}</dd></div><div><dt>Active COC Time</dt><dd>${escapeHtml(formatCocDuration(performance.activeDurationMs))}</dd></div><div><dt>Exact Scanner Accuracy</dt><dd>${escapeHtml(cocPercentage(performance.scanSuccesses, performance.scanAttempts))}</dd></div><div><dt>Exact Scanner Reads</dt><dd>${escapeHtml(cocPercentage(performance.scannerExactLots, performance.scannerReviewedLots))} · ${performance.scannerExactLots}/${performance.scannerReviewedLots}</dd></div><div><dt>Text-Corrected Scans</dt><dd>${performance.scannerCorrectedLots} lots · ${performance.scannerEditDistanceTotal} characters</dd></div><div><dt>1–2 Character Fixes</dt><dd>${performance.scannerOneOrTwoCharacterCorrections}</dd></div><div><dt>Manual Lots</dt><dd>${performance.manualLots} / ${performance.distinctLots}</dd></div></dl>
      <div class="atlas-dashboard-coc-pallets">${renderCocPallets(record)}</div>
      <div class="atlas-dashboard-coc-detail-actions"><button class="atlas-dashboard-button atlas-dashboard-button--primary" data-coc-official="${escapeHtml(record.id)}">View Official COC</button><button class="atlas-dashboard-button atlas-dashboard-button--primary" data-coc-download="${escapeHtml(record.id)}">Download Official COC</button>${cocCanDelete(record) ? `<button class="atlas-dashboard-button atlas-dashboard-button--danger" data-coc-delete="${escapeHtml(record.id)}">Delete COC</button>` : ""}</div>
    </section>`;
  };

  const renderCocRows = () => {
    if (state.cocLoading && !state.cocLoaded) return `<tr><td colspan="7"><div class="atlas-dashboard-coc-empty">Loading COCs…</div></td></tr>`;
    if (!state.cocRecords.length) return `<tr><td colspan="7"><div class="atlas-dashboard-coc-empty">${state.cocSearch ? "No COCs match this search." : "No COCs are available in this section."}</div></td></tr>`;
    return state.cocRecords.map((record) => {
      const snap = cocSnapshot(record), totals = cocTotals(record);
      return `<tr><td><span class="atlas-dashboard-coc-status is-${escapeHtml(cocStatus(record).toLowerCase().replaceAll(" ", "-"))}">${escapeHtml(cocStatus(record))}</span></td><td>${escapeHtml(formatDateTime(parseDate(cocRecordDate(record))))}</td><td><strong>${escapeHtml(snap.customerName || "—")}</strong></td><td>${escapeHtml(snap.ifNumber || "—")}</td><td>${escapeHtml(snap.invoiceNumber || "—")}</td><td>${cocPlural(totals.pallets, "pallet")} · ${cocPlural(totals.boxes, "box")}</td><td><div class="atlas-dashboard-coc-row-actions"><button data-coc-open="${escapeHtml(record.id)}">View</button><button data-coc-official-row="${escapeHtml(record.id)}">Official COC</button>${cocCanDelete(record) ? `<button class="is-delete" data-coc-delete="${escapeHtml(record.id)}">Delete</button>` : ""}</div></td></tr>`;
    }).join("");
  };

  const scannerPercent = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)}%` : "—";
  const scannerVersionLabel = (value) => {
    const version = String(value || "").trim();
    return /^v?\d+\.\d+(?:\.\d+)?$/i.test(version)
      ? `Scanner ${version.replace(/^v/i, "")}`
      : version;
  };
  const scannerFilterOptions = (values, selected, emptyLabel, map = (value) => [value, value]) =>
    `<option value="">${escapeHtml(emptyLabel)}</option>${(values || []).map((value) => {
      const [key, label] = map(value);
      return `<option value="${escapeHtml(key)}" ${String(selected) === String(key) ? "selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("")}`;

  const renderScannerTrend = () => {
    const rows = state.scannerData?.trends || [];
    if (rows.length < 2) return `<div class="atlas-scanner-empty-chart">Trend lines appear after two days of scanner activity.</div>`;
    const points = (key) => rows.map((row, index) => {
      const x = rows.length === 1 ? 0 : index / (rows.length - 1) * 100;
      const y = 37 - Math.max(0, Math.min(100, Number(row[key] || 0))) * .34;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return `<div class="atlas-scanner-chart"><svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="Scanner accuracy trend"><path d="M0 37H100"/><path d="M0 20H100"/><polyline class="is-character" points="${points("characterAccuracy")}"/><polyline class="is-exact" points="${points("exactRate")}"/></svg><div><span><i class="is-exact"></i>Exact scan rate</span><span><i class="is-character"></i>Character accuracy</span></div></div>`;
  };

  const renderScannerMetric = (label, value, note, tone = "blue") => `<article class="atlas-scanner-metric is-${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`;

  const renderScannerFilters = () => {
    const filters = state.scannerData?.filters || {};
    return `<div class="atlas-scanner-filters">
      <label><span>Period</span><select data-scanner-filter="range"><option value="7d" ${state.scannerRange === "7d" ? "selected" : ""}>Last 7 days</option><option value="30d" ${state.scannerRange === "30d" ? "selected" : ""}>Last 30 days</option><option value="90d" ${state.scannerRange === "90d" ? "selected" : ""}>Last 90 days</option></select></label>
      <label><span>Capture Method</span><select data-scanner-filter="capture">${scannerFilterOptions(filters.captureMethods, state.scannerCaptureMethod, "All methods")}</select></label>
      <label><span>Scanner Version</span><select data-scanner-filter="version">${scannerFilterOptions(filters.versions, state.scannerVersion, "All versions", (version) => [version, scannerVersionLabel(version)])}</select></label>
      <button type="button" class="atlas-scanner-clear" data-scanner-clear-filters ${state.scannerRange === "30d" && !state.scannerCaptureMethod && !state.scannerVersion ? "disabled" : ""}>Clear filters</button>
    </div>`;
  };

  const renderCocRecordsPanel = () => {
    const pages = Math.max(1, Math.ceil(state.cocTotal / COC_PAGE_SIZE));
    return `<article class="atlas-dashboard-coc-panel"><header><div><p class="atlas-dashboard-eyebrow">DAILY COC OPERATIONS</p><h2>COC Receiver Activity</h2><span>Monitor incoming work and review completed or archived COCs for this warehouse.</span></div><span class="atlas-dashboard-coc-live">● LIVE · 15 SEC</span></header>
      <nav class="atlas-dashboard-coc-sections" aria-label="COC record sections">${[["all","All COCs"],["active","Incoming"],["completed","Completed"],["archive","Archive"]].map(([value, label]) => `<button type="button" data-coc-section="${value}" class="${state.cocSection === value ? "is-active" : ""}">${label}</button>`).join("")}</nav>
      <div class="atlas-dashboard-coc-toolbar"><input type="search" data-coc-search value="${escapeHtml(state.cocSearch)}" placeholder="Search customer, invoice, or IF number" aria-label="Search COCs"><select data-coc-sort aria-label="Sort COCs"><option value="newest" ${state.cocSort === "newest" ? "selected" : ""}>Newest first</option><option value="oldest" ${state.cocSort === "oldest" ? "selected" : ""}>Oldest first</option><option value="customer-asc" ${state.cocSort === "customer-asc" ? "selected" : ""}>Customer A–Z</option></select><button class="atlas-dashboard-button" type="button" data-coc-refresh>Refresh</button></div>
      <div class="atlas-dashboard-coc-table-wrap"><table><thead><tr><th>Status</th><th>Recorded</th><th>Customer</th><th>IF Number</th><th>Invoice</th><th>Pallets / Boxes</th><th>Actions</th></tr></thead><tbody>${renderCocRows()}</tbody></table></div>
      <footer><span>Showing ${state.cocTotal ? ((state.cocPage - 1) * COC_PAGE_SIZE) + 1 : 0}–${Math.min(state.cocPage * COC_PAGE_SIZE, state.cocTotal)} of ${state.cocTotal.toLocaleString()} COCs</span><div><button type="button" data-coc-page="${state.cocPage - 1}" ${state.cocPage <= 1 ? "disabled" : ""}>‹</button><strong>${state.cocPage} / ${pages}</strong><button type="button" data-coc-page="${state.cocPage + 1}" ${state.cocPage >= pages ? "disabled" : ""}>›</button></div></footer>
    </article>`;
  };

  const renderScannerCorrectionRows = () => {
    if (state.scannerLoading && !state.scannerLoaded) return `<div class="atlas-scanner-empty-chart">Loading correction evidence…</div>`;
    if (!state.scannerCorrections.length) return `<div class="atlas-scanner-empty-chart">No corrected scans match these filters.</div>`;
    return state.scannerCorrections.map((item) => `<button type="button" class="atlas-scanner-correction-row" data-scanner-correction="${escapeHtml(item.id)}">
      <span class="atlas-scanner-thumb">${item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" alt="Corrected lot label">` : "NO IMAGE"}</span>
      <span><small>${escapeHtml(item.sku || "UNKNOWN SKU")}</small><strong>${escapeHtml(item.scanner_original_lot || "—")} <b>→</b> ${escapeHtml(item.confirmed_lot || "—")}</strong><em>${escapeHtml(item.employee_name || "Employee")} · ${escapeHtml(formatDateTime(parseDate(item.recorded_at)))}</em></span>
      <mark class="is-${escapeHtml(item.review_status)}">${escapeHtml(String(item.review_status || "unreviewed").replaceAll("_", " "))}</mark><i>›</i>
    </button>`).join("");
  };

  const renderScannerCorrectionDetail = () => {
    const item = state.scannerSelected;
    if (!item) return "";
    if (!item.scanner_original_lot && state.scannerLoading) return `<div class="atlas-scanner-empty-chart">Loading secure correction evidence…</div>`;
    return `<article class="atlas-scanner-detail">
      <button type="button" class="atlas-dashboard-coc-back" data-scanner-detail-back>‹ Correction Review</button>
      <div class="atlas-scanner-detail-grid">
        <figure>${item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" alt="Private cropped lot label evidence">` : `<span>Correction image was unavailable for this attempt.</span>`}<figcaption>Private correction evidence · signed access expires automatically</figcaption></figure>
        <section><p class="atlas-dashboard-eyebrow">${escapeHtml(item.sku || "SCANNER CORRECTION")}</p><h2>${escapeHtml(item.scanner_original_lot || "—")} <b>→</b> ${escapeHtml(item.confirmed_lot || "—")}</h2>
          <dl><div><dt>Characters edited</dt><dd>${Number(item.edit_distance || 0)}</dd></div><div><dt>Employee</dt><dd>${escapeHtml(item.employee_name || "—")}</dd></div><div><dt>Capture method</dt><dd>${escapeHtml(item.capture_method || "—")}</dd></div><div><dt>Confidence</dt><dd>${item.confidence == null ? "—" : scannerPercent(Number(item.confidence) <= 1 ? Number(item.confidence) * 100 : Number(item.confidence))}</dd></div><div><dt>Scanner version</dt><dd>${escapeHtml(scannerVersionLabel(item.scanner_version) || "—")}</dd></div><div><dt>Recorded</dt><dd>${escapeHtml(formatDateTime(parseDate(item.recorded_at)))}</dd></div></dl>
          ${item.invoice_number ? `<button type="button" class="atlas-dashboard-button" data-scanner-open-coc="${escapeHtml(item.invoice_number)}">Open Associated COC</button>` : ""}
        </section>
      </div>
      <form class="atlas-scanner-review-form" data-scanner-review><input type="hidden" name="attempt_id" value="${escapeHtml(item.id)}"><fieldset><legend>Classify this correction</legend>${[["scanner_misread","Scanner misread"],["damaged_label","Damaged label"],["unusual_format","Unusual format"],["employee_correction_error","Employee correction error"]].map(([value,label]) => `<label><input type="radio" name="classification" value="${value}" ${item.review_classification === value ? "checked" : ""} required><span>${label}</span></label>`).join("")}</fieldset>
        <label class="atlas-scanner-training"><input type="checkbox" name="retain_training" ${item.retain_for_training ? "checked" : ""}><span><strong>Approve for scanner improvement</strong><small>Retain this reviewed evidence for a future, controlled scanner training dataset.</small></span></label>
        <p data-scanner-review-error role="alert"></p><div><button type="submit" class="atlas-dashboard-button atlas-dashboard-button--primary">Save Review</button><button type="button" class="atlas-dashboard-button atlas-dashboard-button--danger-ghost" data-scanner-exclude>Exclude Evidence</button></div>
      </form>
    </article>`;
  };

  const renderScannerIntelligence = () => {
    const data = state.scannerData || {}, summary = data.summary || {};
    if (state.scannerSelected) return renderScannerCorrectionDetail();
    const scannerPages = Math.max(1, Math.ceil(state.scannerTotal / 12));
    const workflow = state.cocPerformance;
    const rangeLabel = `Last ${String(state.scannerRange || "30d").replace("d", "")} days`;
    const performance = `<div class="atlas-scanner-performance">
      <div class="atlas-scanner-metrics">${renderScannerMetric("Exact Lot Scan", scannerPercent(summary.exactRate), `${Number(summary.exactScans || 0).toLocaleString()} exact of ${Number(summary.attempts || 0).toLocaleString()} attempts`)}${renderScannerMetric("Character Accuracy", scannerPercent(summary.characterAccuracy), "Every corrected character included", "green")}${renderScannerMetric("Corrected Scans", Number(summary.correctedScans || 0).toLocaleString(), `${Number(summary.oneTwoCharacterCorrections || 0).toLocaleString()} required only 1–2 edits`, "amber")}${renderScannerMetric("Fallback / Failure", scannerPercent(summary.manualFallbackRate), `${Number(summary.failures || 0).toLocaleString()} failed scan attempts`, "slate")}</div>
      <article class="atlas-scanner-panel"><header><div><p class="atlas-dashboard-eyebrow">ACCURACY TREND</p><h2>Scanner Performance</h2><span>Exact confirmation and character-level accuracy over time</span></div></header>${renderScannerTrend()}</article>
      <article class="atlas-scanner-panel atlas-scanner-workflow-context"><header><div><p class="atlas-dashboard-eyebrow">WORKFLOW CONTEXT</p><h2>COC Processing Time</h2><span>Operational timing for ${escapeHtml(rangeLabel.toLowerCase())}</span></div></header><div class="atlas-scanner-context-metrics">${renderScannerMetric("Average COC Time", formatCocDuration(workflow.averageActiveDurationMs), workflow.completionSamples ? `${cocPlural(workflow.completionSamples, "COC")} measured` : "Timing begins after a completed COC", "blue")}${renderScannerMetric("Median COC Time", formatCocDuration(workflow.medianActiveDurationMs), "Typical active processing time", "green")}${renderScannerMetric("Completed Sample", Number(workflow.completionSamples || 0).toLocaleString(), "Completed COCs included in timing", "slate")}</div></article>
      <div class="atlas-scanner-split"><article class="atlas-scanner-panel"><header><div><h2>Capture Method</h2><span>Performance by the way the lot was captured</span></div></header><div class="atlas-scanner-table">${(data.byCaptureMethod || []).map((item) => `<div><strong>${escapeHtml(item.name)}</strong><span>${item.attempts.toLocaleString()} attempts</span><b>${scannerPercent(item.exactRate)}</b><small>${scannerPercent(item.characterAccuracy)} characters</small></div>`).join("") || `<div>No capture activity yet.</div>`}</div></article>
      <article class="atlas-scanner-panel"><header><div><h2>Recent Corrections</h2><span>${Number(summary.unreviewed || 0)} awaiting supervisor review</span></div><button type="button" data-scanner-view="review">Review Queue</button></header><div class="atlas-scanner-mini-list">${(data.recentCorrections || []).map((item) => `<button type="button" data-scanner-correction="${escapeHtml(item.id)}"><span>${escapeHtml(item.sku || "SKU")}</span><strong>${escapeHtml(item.scanner_original_lot || "—")} → ${escapeHtml(item.confirmed_lot || "—")}</strong><small>${Number(item.edit_distance || 0)} character edit${Number(item.edit_distance) === 1 ? "" : "s"}</small></button>`).join("") || `<p>No corrected scans in this period.</p>`}</div></article></div>
    </div>`;
    const review = `<div class="atlas-scanner-review-layout"><article class="atlas-scanner-panel"><header><div><p class="atlas-dashboard-eyebrow">PRIVATE EVIDENCE QUEUE</p><h2>Correction Review</h2><span>Only scans changed by an employee preserve a cropped label image. Employee detail is limited to this review workspace.</span></div></header><div class="atlas-scanner-review-extra"><label>Employee<select data-scanner-filter="employee">${scannerFilterOptions(data.filters?.employees, state.scannerEmployee, "All employees", (item) => [item.id, item.name])}</select></label><label>Review status<select data-scanner-filter="review"><option value="" ${!state.scannerReviewStatus ? "selected" : ""}>All statuses</option><option value="unreviewed" ${state.scannerReviewStatus === "unreviewed" ? "selected" : ""}>Unreviewed</option><option value="reviewed" ${state.scannerReviewStatus === "reviewed" ? "selected" : ""}>Reviewed</option><option value="excluded" ${state.scannerReviewStatus === "excluded" ? "selected" : ""}>Excluded</option></select></label><label>Correction size<select data-scanner-filter="size"><option value="">All sizes</option><option value="1-2" ${state.scannerCorrectionSize === "1-2" ? "selected" : ""}>1–2 characters</option><option value="3+" ${state.scannerCorrectionSize === "3+" ? "selected" : ""}>3+ characters</option></select></label></div><div class="atlas-scanner-correction-list">${renderScannerCorrectionRows()}</div><footer><button type="button" data-scanner-page="${state.scannerPage - 1}" ${state.scannerPage <= 1 ? "disabled" : ""}>‹</button><strong>${state.scannerPage} / ${scannerPages}</strong><button type="button" data-scanner-page="${state.scannerPage + 1}" ${state.scannerPage >= scannerPages ? "disabled" : ""}>›</button></footer></article></div>`;
    const patterns = `<div class="atlas-scanner-split"><article class="atlas-scanner-panel"><header><div><p class="atlas-dashboard-eyebrow">RECOGNITION PATTERNS</p><h2>Most Common Character Changes</h2></div></header><div class="atlas-scanner-patterns">${(data.characterChanges || []).map((item, index) => `<div><b>${index + 1}</b><strong>${escapeHtml(item.from)} <i>→</i> ${escapeHtml(item.to)}</strong><span>${item.count.toLocaleString()} times</span></div>`).join("") || `<p>No corrections in this period.</p>`}</div></article><article class="atlas-scanner-panel"><header><div><p class="atlas-dashboard-eyebrow">SKU QUALITY</p><h2>Products Needing Attention</h2></div></header><div class="atlas-scanner-table">${(data.bySku || []).filter((item) => item.corrected || item.failures).slice(0, 12).map((item) => `<div><strong>${escapeHtml(item.name)}</strong><span>${item.corrected} corrected · ${item.failures} failed</span><b>${scannerPercent(item.exactRate)}</b><small>${scannerPercent(item.characterAccuracy)} characters</small></div>`).join("") || `<div>No problematic SKUs found.</div>`}</div></article></div>`;
    const versions = `<article class="atlas-scanner-panel"><header><div><p class="atlas-dashboard-eyebrow">CONTROLLED RELEASE ANALYSIS</p><h2>Scanner Version Comparison</h2><span>Compare accuracy before approving a recognition update.</span></div></header><div class="atlas-scanner-version-grid">${(data.byVersion || []).map((item) => `<article><span>${escapeHtml(scannerVersionLabel(item.name))}</span><strong>${scannerPercent(item.exactRate)}</strong><small>Exact scan rate</small><dl><div><dt>Character accuracy</dt><dd>${scannerPercent(item.characterAccuracy)}</dd></div><div><dt>Attempts</dt><dd>${item.attempts.toLocaleString()}</dd></div><div><dt>Corrected</dt><dd>${item.corrected.toLocaleString()}</dd></div><div><dt>Failures</dt><dd>${item.failures.toLocaleString()}</dd></div></dl></article>`).join("") || `<div class="atlas-scanner-empty-chart">Scanner 1.0.0 results appear after the first scan synchronizes.</div>`}</div></article>`;
    return `<section class="atlas-scanner-intelligence">${state.scannerNotice ? `<div class="atlas-dashboard-coc-notice">${escapeHtml(state.scannerNotice)}</div>` : ""}${state.scannerError ? `<div class="atlas-dashboard-coc-error">${escapeHtml(state.scannerError)}</div>` : ""}
      <header class="atlas-scanner-heading"><div><p class="atlas-dashboard-eyebrow">ATLAS QUALITY SYSTEM</p><h2>Scanner Intelligence</h2><span>Measure recognition quality, review corrections, and approve controlled scanner improvements.</span></div><span class="atlas-scanner-private"><b>PRIVATE · WAREHOUSE SCOPED</b><small>Scanner 1.0.0 · Live analytics</small></span></header>
      <nav class="atlas-scanner-tabs" aria-label="Scanner intelligence sections">${[["performance","Performance"],["review","Correction Review"],["patterns","Problem Patterns"],["versions","Scanner Versions"]].map(([value,label]) => `<button type="button" data-scanner-view="${value}" class="${state.scannerView === value ? "is-active" : ""}">${label}${value === "review" && summary.unreviewed ? `<b>${summary.unreviewed}</b>` : ""}</button>`).join("")}</nav>
      ${renderScannerFilters()}${state.scannerLoading && !state.scannerLoaded ? `<div class="atlas-scanner-empty-chart">Loading scanner intelligence…</div>` : state.scannerView === "review" ? review : state.scannerView === "patterns" ? patterns : state.scannerView === "versions" ? versions : performance}
    </section>`;
  };

  const renderCocOperations = () => `<div class="atlas-coc-operations">
    <div class="atlas-dashboard-coc-metrics">${cocMetricCard("all", "ALL COCs", state.cocMetrics.total)}${cocMetricCard("awaiting", "AWAITING", state.cocMetrics.awaiting, "Requires office review")}${cocMetricCard("received", "RECEIVED TODAY", state.cocMetrics.receivedToday)}${cocMetricCard("completed", "COMPLETED TODAY", state.cocMetrics.completedToday)}</div>
    ${renderCocRecordsPanel()}
  </div>`;

  const renderCocOversight = () => {
    if (state.cocSelected) return `${renderCocDetail(state.cocSelected)}${renderCocDeleteModal()}`;
    return `<section class="atlas-dashboard-coc-center">
      ${state.cocNotice ? `<div class="atlas-dashboard-coc-notice">${escapeHtml(state.cocNotice)}</div>` : ""}${state.cocError ? `<div class="atlas-dashboard-coc-error">${escapeHtml(state.cocError)}</div>` : ""}
      <nav class="atlas-coc-workspace-tabs" aria-label="COC oversight workspaces">${[["operations","COC Operations"],["scanner","Scanner Intelligence"]].map(([value,label]) => `<button type="button" data-coc-workspace="${value}" class="${state.cocWorkspace === value ? "is-active" : ""}">${label}</button>`).join("")}</nav>
      ${state.cocWorkspace === "scanner" ? renderScannerIntelligence() : renderCocOperations()}
      ${renderCocDeleteModal()}
    </section>`;
  };

  const renderDashboard = () => {
    const rows = visibleRows();
    const operationalRows = rowsInRange().filter((row) => row.operational);
    const visibleOperationalRows = rows.filter((row) => row.operational);
    const activeSkus = state.skus.filter((sku) => sku.active == null || bool(sku.active)).length;
    const moves = operationalRows.filter((row) => row.key === "move").length;
    const created = operationalRows.filter((row) => row.key === "create").length;
    const cleared = operationalRows.filter((row) => row.label === "Cleared location").length;
    const rangeLabel = ({ today: "Today", week: "This Week", "7": "Last 7 Days", "30": "Last 30 Days", custom: "Custom Range" })[state.range] || "Selected range";
    const sessionName = window.AtlasAuth?.displayName?.(state.session) || state.session?.user?.user_metadata?.display_name || "Supervisor";
    const isAdmin = state.currentProfile?.role === "admin";
    const canViewNotifications = ["supervisor", "admin"].includes(state.currentProfile?.role);
    const notifications = todayNotifications();
    const accessView = state.view === "access" && isAdmin;
    const cocView = state.view === "cocs" && canViewNotifications;
    const title = accessView ? "Access Management" : cocView ? "COC Oversight" : "Operations Dashboard";
    const subtitle = accessView
      ? "Manage employee identities, passwords, roles, and dashboard permissions securely from ATLAS."
      : cocView
        ? "Monitor the live COC Receiver, review saved workbooks, and manage completed COCs from one protected view."
        : "Warehouse activity, inventory changes, and SKU oversight in one clear operational view.";
    const header = `
      <header class="atlas-dashboard-header">
        <div><p class="atlas-dashboard-eyebrow">ATLAS CONTROL CENTER</p><h1>${title}</h1><p class="atlas-dashboard-subtitle ${accessView || cocView ? "" : "atlas-dashboard-mobile-only"}">${subtitle}</p></div>
        <div class="atlas-dashboard-header-actions">
          ${state.warehouses.length > 1 && isAdmin ? `<div class="atlas-dashboard-warehouse-switch"><span>Warehouse</span>${renderPremiumSelect({ value: state.selectedWarehouse?.code || "CA", options: warehouseSelectOptions(), ariaLabel: "Select warehouse", dataAttribute: "data-warehouse-selector", className: "atlas-premium-select--header" })}</div>` : `<span class="atlas-dashboard-warehouse-badge">${escapeHtml(state.selectedWarehouse?.code || "CA")} · ${escapeHtml(state.selectedWarehouse?.display_name || "California Warehouse")}</span>`}
          ${accessView ? `<button class="atlas-dashboard-button" type="button" data-account-refresh>Refresh Accounts</button><button class="atlas-dashboard-button atlas-dashboard-button--primary" type="button" data-account-add>+ Add Account</button>` : cocView ? `<button class="atlas-dashboard-button" type="button" data-coc-refresh>Refresh COCs</button>` : `${canViewNotifications ? renderNotificationBell(notifications) : ""}<div class="atlas-dashboard-date-control"><select class="atlas-dashboard-range" data-range aria-label="Dashboard date range">
            <option value="today" ${state.range === "today" ? "selected" : ""}>Today</option>
            <option value="week" ${state.range === "week" ? "selected" : ""}>This Week</option>
            <option value="7" ${state.range === "7" ? "selected" : ""}>Last 7 Days</option>
            <option value="30" ${state.range === "30" ? "selected" : ""}>Last 30 Days</option>
            <option value="custom" ${state.range === "custom" ? "selected" : ""}>Custom Range</option>
          </select>${state.range === "custom" ? `<span class="atlas-dashboard-custom-range"><input data-custom-start type="date" value="${escapeHtml(state.customStart)}" aria-label="Start date"><input data-custom-end type="date" value="${escapeHtml(state.customEnd)}" aria-label="End date"></span>` : ""}</div>`}
          ${state.session ? `<button class="atlas-dashboard-button" type="button" data-sign-out title="${escapeHtml(sessionName)}">Sign out</button>` : ""}
        </div>
      </header>
      ${canViewNotifications ? `<nav class="atlas-dashboard-tabs" aria-label="Dashboard sections"><button type="button" data-dashboard-view="operations" class="${!accessView && !cocView ? "is-active" : ""}">Operations</button><button type="button" data-dashboard-view="cocs" class="${cocView ? "is-active" : ""}">COC Oversight</button>${isAdmin ? `<button type="button" data-dashboard-view="access" class="${accessView ? "is-active" : ""}">Access Management</button>` : ""}</nav>` : ""}
      <div class="atlas-dashboard-statusline"><span class="atlas-dashboard-status-dot is-live"></span><span>${accessView ? "Protected administrator controls" : cocView ? state.cocLoading && !state.cocLoaded ? `Loading ${escapeHtml(state.selectedWarehouse?.code || "CA")} COC data…` : `Live COC data · ${escapeHtml(state.lastSync ? "Updated just now" : "Ready")}` : `Live data · ${escapeHtml(state.lastSync ? "Updated just now" : "Ready")}`}</span></div>`;
    if (accessView) return `${header}${renderAccessManagement()}`;
    if (cocView) return `${header}${renderCocOversight()}`;
    return `${header}
      <section class="atlas-dashboard-summary" aria-label="Operational summary">
        ${renderSummaryCard("Active SKUs", activeSkus, "Current picker inventory", "□", ACTION_COLORS.move)}
        ${renderSummaryCard("Inventory Moves", moves, rangeLabel, "⇄", ACTION_COLORS.move)}
        ${renderSummaryCard("New SKUs", created, rangeLabel, "+", ACTION_COLORS.create)}
        ${renderSummaryCard("Locations Cleared", cleared, rangeLabel, "−", ACTION_COLORS.location)}
      </section>
      <section class="atlas-dashboard-main-grid">
        <article class="atlas-dashboard-panel">
          <header class="atlas-dashboard-panel-head"><div><h2>Recent Warehouse Activity</h2><p>${(state.filter === "all" ? rows.length : visibleOperationalRows.length).toLocaleString()} matching records</p></div><div class="atlas-dashboard-tools"><label class="atlas-dashboard-search"><input type="search" data-search value="${escapeHtml(state.search)}" placeholder="Search SKU or employee" aria-label="Search activity"></label><select class="atlas-dashboard-filter" data-filter aria-label="Activity type"><option value="operational" ${state.filter === "operational" ? "selected" : ""}>Operational</option><option value="move" ${state.filter === "move" ? "selected" : ""}>Moves</option><option value="create" ${state.filter === "create" ? "selected" : ""}>New SKUs</option><option value="edit" ${state.filter === "edit" ? "selected" : ""}>SKU edits</option><option value="pick" ${state.filter === "pick" ? "selected" : ""}>Pick First</option><option value="location" ${state.filter === "location" ? "selected" : ""}>Locations</option><option value="all" ${state.filter === "all" ? "selected" : ""}>Full audit</option></select></div></header>
          <div class="atlas-dashboard-feed">${renderFeed(rows)}</div>
        </article>
        <aside class="atlas-dashboard-side">
          ${renderTodaySummary(operationalRows, rangeLabel)}
          ${renderWarehouseStatus()}
        </aside>
      </section>${canViewNotifications ? renderNotificationCenter(notifications) : ""}${renderActivityDrawer()}`;
  };

  const render = () => {
    if (!state.mounted || !state.open) return;
    const content = document.querySelector("[data-dashboard-content]");
    if (!content) return;
    if (state.loading && !state.skus.length && state.view !== "cocs") content.innerHTML = renderLoading();
    else if (state.accessRequired) content.innerHTML = renderAccess();
    else if (state.error) {
      content.innerHTML = `<div class="atlas-dashboard-error"><strong>Dashboard data could not load</strong><p>${escapeHtml(state.error)}</p><button class="atlas-dashboard-button atlas-dashboard-button--primary" type="button" data-retry>Try Again</button></div>`;
    } else content.innerHTML = renderDashboard();
    window.requestAnimationFrame?.(() => window.AtlasCocExcel?.fitOfficialWorkbookPreviews?.(content));
  };

  const exportCsv = () => {
    const rows = visibleRows();
    const columns = ["Date", "Employee", "Action", "SKU", "Location", "Reason", "Source"];
    const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [columns, ...rows.map((row) => [
      row.date?.toISOString() || "",
      row.employee,
      row.label,
      row.sku,
      row.location,
      row.detail,
      row.source,
    ])].map((row) => row.map(quote).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `ATLAS-dashboard-activity-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  const handleClick = (event) => {
    if (event.target.matches?.("[data-coc-delete-close]")) {
      state.cocDelete = null;
      render();
      return;
    }
    if (event.target.matches?.("[data-drawer-close]")) {
      state.drawer = null;
      render();
      return;
    }
    if (event.target.matches?.("[data-account-modal-backdrop]")) {
      state.accountModal = null;
      state.accountDeleteError = "";
      render();
      return;
    }
    if (event.target.matches?.("[data-notifications-close]")) {
      state.notificationsOpen = false;
      render();
      return;
    }
    const selectRoot = event.target.closest?.("[data-atlas-select]");
    if (!selectRoot) closePremiumSelects();
    const button = event.target.closest("button");
    if (!button) return;
    if (button.matches("[data-atlas-select-trigger]")) {
      event.preventDefault();
      const root = button.closest("[data-atlas-select]");
      const menu = root?.querySelector("[data-atlas-select-menu]");
      if (!root || !menu) return;
      const willOpen = menu.hidden;
      closePremiumSelects(root);
      menu.hidden = !willOpen;
      button.setAttribute("aria-expanded", String(willOpen));
      root.classList.toggle("is-open", willOpen);
      if (willOpen) window.requestAnimationFrame(() => menu.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true }));
      return;
    }
    if (button.matches("[data-atlas-select-option]")) {
      event.preventDefault();
      const root = button.closest("[data-atlas-select]");
      const native = root?.querySelector("select");
      const trigger = root?.querySelector("[data-atlas-select-trigger]");
      const valueLabel = trigger?.querySelector("[data-atlas-select-value]");
      const badge = trigger?.querySelector("[data-atlas-select-badge]");
      if (!root || !native || !trigger || !valueLabel) return;
      native.value = button.dataset.value || "";
      valueLabel.textContent = button.dataset.label || button.textContent.trim();
      if (badge) badge.textContent = button.dataset.badge || "";
      root.querySelectorAll("[data-atlas-select-option]").forEach((option) => option.setAttribute("aria-selected", String(option === button)));
      closePremiumSelects();
      trigger.focus({ preventScroll: true });
      native.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (button.matches("[data-password-toggle]")) {
      const input = button.closest(".atlas-password-field")?.querySelector("input");
      if (!input) return;
      const showPassword = input.type === "password";
      input.type = showPassword ? "text" : "password";
      button.setAttribute("aria-pressed", String(showPassword));
      button.setAttribute("aria-label", showPassword ? "Hide password" : "Show password");
      input.focus({ preventScroll: true });
    } else if (button.matches("[data-mobile-menu]")) showMenu();
    else if (button.matches("[data-notifications-toggle]")) {
      state.notificationsOpen = !state.notificationsOpen;
      render();
    } else if (button.matches("[data-notification-id]")) {
      state.notificationsOpen = false;
      state.drawer = { kind: "activity", id: button.dataset.notificationId };
      render();
    }
    else if (button.matches("[data-dashboard-close]")) closeDashboard();
    else if (button.matches("[data-mobile-refresh], [data-retry]")) loadData();
    else if (button.matches("[data-export]")) exportCsv();
    else if (button.matches("[data-sign-out]")) signOut();
    else if (button.matches("[data-dashboard-view]")) {
      const view = button.dataset.dashboardView;
      if (view === "access" && state.currentProfile?.role !== "admin") return;
      if (view === "cocs" && !["supervisor", "admin"].includes(state.currentProfile?.role)) return;
      state.view = ["access", "cocs"].includes(view) ? view : "operations";
      state.accountModal = null;
      state.cocSelected = null;
      state.cocPreview = { status: "idle", html: "", error: "", id: "" };
      state.cocDelete = null;
      render();
      if (state.view === "access" && !state.adminUsersLoaded) loadAdminUsers();
      if (state.view === "cocs") {
        if (!state.cocLoaded) loadCocData();
        if (state.cocWorkspace === "scanner" && !state.scannerLoaded) loadScannerData();
      }
      startDashboardRefresh();
    } else if (button.matches("[data-coc-workspace]")) {
      state.cocWorkspace = button.dataset.cocWorkspace || "operations";
      state.cocSelected = null;
      state.scannerSelected = null;
      render();
      if (!state.cocLoaded) loadCocData();
      if (state.cocWorkspace === "scanner" && !state.scannerLoaded) loadScannerData();
    } else if (button.matches("[data-scanner-clear-filters]")) {
      state.scannerRange = "30d";
      state.cocPerformanceRange = "30";
      state.scannerCaptureMethod = "";
      state.scannerVersion = "";
      state.scannerPage = 1;
      void Promise.all([loadScannerData(), loadCocData()]);
    } else if (button.matches("[data-scanner-view]")) {
      state.scannerView = button.dataset.scannerView || "performance";
      state.scannerSelected = null;
      render();
    } else if (button.matches("[data-scanner-correction]")) {
      state.scannerView = "review";
      void loadScannerCorrection(button.dataset.scannerCorrection);
    } else if (button.matches("[data-scanner-detail-back]")) {
      state.scannerSelected = null;
      state.scannerNotice = "";
      render();
    } else if (button.matches("[data-scanner-page]")) {
      const page = Number(button.dataset.scannerPage);
      if (Number.isInteger(page) && page > 0) {
        state.scannerPage = page;
        loadScannerData();
      }
    } else if (button.matches("[data-scanner-open-coc]")) {
      state.scannerSelected = null;
      state.cocWorkspace = "operations";
      state.cocSearch = button.dataset.scannerOpenCoc || "";
      state.cocPage = 1;
      loadCocData();
    } else if (button.matches("[data-scanner-exclude]")) {
      const form = button.closest("[data-scanner-review]");
      if (!form?.reportValidity()) return;
      void saveScannerReview(form, { exclude: true });
    } else if (button.matches("[data-coc-section]")) {
      state.cocSection = button.dataset.cocSection;
      state.cocPage = 1;
      state.cocSelected = null;
      state.cocNotice = "";
      loadCocData();
    } else if (button.matches("[data-coc-refresh]")) {
      loadCocData();
    } else if (button.matches("[data-coc-page]")) {
      const page = Number(button.dataset.cocPage);
      if (Number.isInteger(page) && page > 0) {
        state.cocPage = page;
        loadCocData();
      }
    } else if (button.matches("[data-coc-open]")) {
      state.cocSelected = state.cocRecords.find((record) => record.id === button.dataset.cocOpen) || null;
      state.cocPreview = { status: "idle", html: "", error: "", id: "" };
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      render();
    } else if (button.matches("[data-coc-official-row]")) {
      const record = state.cocRecords.find((item) => item.id === button.dataset.cocOfficialRow);
      if (record) {
        state.cocSelected = record;
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
        void openDashboardCocPreview(record.id);
      }
    } else if (button.matches("[data-coc-official]")) {
      void openDashboardCocPreview(button.dataset.cocOfficial);
    } else if (button.matches("[data-coc-preview-back]")) {
      state.cocPreview = { status: "idle", html: "", error: "", id: "" };
      render();
    } else if (button.matches("[data-coc-detail-back]")) {
      state.cocSelected = null;
      state.cocPreview = { status: "idle", html: "", error: "", id: "" };
      state.cocDelete = null;
      render();
    } else if (button.matches("[data-coc-download]")) {
      void downloadDashboardCoc(button.dataset.cocDownload);
    } else if (button.matches("[data-coc-delete]")) {
      const id = button.dataset.cocDelete;
      const record = state.cocRecords.find((item) => item.id === id) || (state.cocSelected?.id === id ? state.cocSelected : null);
      if (record && cocCanDelete(record)) {
        state.cocDelete = record;
        render();
      }
    } else if (button.matches("[data-account-add]")) {
      state.accountModal = { mode: "create" };
      state.adminError = "";
      render();
    } else if (button.matches("[data-account-edit]")) {
      state.accountModal = { mode: "edit", userId: button.dataset.userId };
      state.adminError = "";
      render();
    } else if (button.matches("[data-account-close]")) {
      state.accountModal = null;
      state.accountDeleteError = "";
      render();
    } else if (button.matches("[data-account-confirm-delete]")) {
      state.accountModal = { mode: "confirm-delete", userId: button.dataset.userId };
      state.accountDeleteError = "";
      render();
    } else if (button.matches("[data-account-delete]")) {
      void deleteAdminAccount(button.dataset.userId);
    } else if (button.matches("[data-account-refresh]")) {
      loadAdminUsers();
    } else if (button.matches("[data-account-warehouse-filter]")) {
      state.accountWarehouseFilter = button.dataset.accountWarehouseFilter || "all";
      render();
    } else if (button.matches("[data-activity-id]")) {
      state.drawer = { kind: "activity", id: button.dataset.activityId };
      render();
    } else if (button.matches("[data-review-pending]")) {
      const request = state.deleteRequests.find((item) => item.status === "pending");
      if (request) { state.drawer = { kind: "request", id: request.id }; render(); }
    } else if (button.matches("[data-undo-activity]")) {
      if (!window.confirm("Undo this completed action? ATLAS will record the reversal.")) return;
      runProtectedAction("undo_inventory_activity", { snapshot_id: button.dataset.snapshotId });
    } else if (button.matches("[data-reject-request]")) {
      if (!window.confirm("Reject this SKU deletion request? No inventory will be changed.")) return;
      runProtectedAction("review_sku_delete_request", { request_id: button.dataset.requestId, decision: "reject" });
    } else if (button.matches("[data-approve-request]")) {
      if (!window.confirm("Delete this SKU permanently? This action cannot be undone without a recorded supervisor Undo.")) return;
      runProtectedAction("review_sku_delete_request", { request_id: button.dataset.requestId, decision: "approve" });
    }
  };

  const handleInput = (event) => {
    if (event.target.matches("[data-coc-search]")) {
      state.cocSearch = event.target.value;
      state.cocPage = 1;
      window.clearTimeout(cocSearchTimer);
      cocSearchTimer = window.setTimeout(() => loadCocData(), 280);
      return;
    }
    if (event.target.matches("[data-account-search]")) {
      state.accountSearch = event.target.value;
      render();
      const input = document.querySelector("[data-account-search]");
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(state.accountSearch.length, state.accountSearch.length);
      return;
    }
    if (!event.target.matches("[data-search]")) return;
    state.search = event.target.value;
    render();
    const input = document.querySelector("[data-search]");
    input?.focus();
    input?.setSelectionRange(state.search.length, state.search.length);
  };

  const handleChange = (event) => {
    if (event.target.matches("[data-warehouse-selector]")) {
      const code = String(event.target.value || "").toUpperCase();
      localStorage.setItem(WAREHOUSE_SELECTION_KEY, code);
      state.selectedWarehouse = state.warehouses.find((warehouse) => warehouse.code === code) || state.selectedWarehouse;
      cocRequestSequence += 1;
      scannerRequestSequence += 1;
      state.skus = [];
      state.locations = [];
      state.activities = [];
      state.history = [];
      state.normalized = [];
      state.cocRecords = [];
      state.cocTotal = 0;
      state.cocMetrics = { total: 0, awaiting: 0, receivedToday: 0, completedToday: 0 };
      state.cocPerformance = {
        completionSamples: 0,
        averageActiveDurationMs: 0,
        medianActiveDurationMs: 0,
        scanAttempts: 0,
        scanSuccesses: 0,
        scanCanceled: 0,
        distinctLots: 0,
        manualLots: 0,
        scannerReviewedLots: 0,
        scannerExactLots: 0,
        scannerCorrectedLots: 0,
        scannerEditDistanceTotal: 0,
        scannerComparedCharacters: 0,
        scannerOneOrTwoCharacterCorrections: 0,
      };
      state.cocLoading = state.view === "cocs";
      state.cocLoaded = false;
      state.cocError = "";
      state.cocNotice = "";
      state.cocSelected = null;
      state.cocPreview = { status: "idle", html: "", error: "", id: "" };
      state.cocDelete = null;
      state.cocPage = 1;
      state.scannerData = null;
      state.scannerCorrections = [];
      state.scannerTotal = 0;
      state.scannerPage = 1;
      state.scannerSelected = null;
      state.scannerLoaded = false;
      state.scannerLoading = state.view === "cocs";
      state.scannerError = "";
      state.scannerNotice = "";
      state.lastSync = null;
      cocWorkbookCache.clear();
      render();
      if (state.view === "cocs") {
        void loadCocData({ warehouseCode: code });
        if (state.cocWorkspace === "scanner") void loadScannerData({ warehouseCode: code });
      }
      void loadData({ force: true, warehouseCode: code });
      return;
    }
    if (event.target.matches("[data-range]")) state.range = event.target.value;
    else if (event.target.matches("[data-custom-start]")) state.customStart = event.target.value;
    else if (event.target.matches("[data-custom-end]")) state.customEnd = event.target.value;
    else if (event.target.matches("[data-filter]")) state.filter = event.target.value;
    else if (event.target.matches("[data-account-role-filter]")) state.accountRoleFilter = event.target.value;
    else if (event.target.matches("[data-account-status-filter]")) state.accountStatusFilter = event.target.value;
    else if (event.target.matches("[data-account-sort]")) state.accountSort = event.target.value;
    else if (event.target.matches("[data-coc-performance-range]")) {
      state.cocPerformanceRange = event.target.value;
      loadCocData();
      return;
    }
    else if (event.target.matches("[data-coc-sort]")) {
      state.cocSort = event.target.value;
      state.cocPage = 1;
      loadCocData();
      return;
    }
    else if (event.target.matches("[data-scanner-filter]")) {
      const key = event.target.dataset.scannerFilter;
      const value = event.target.value;
      if (key === "range") {
        state.scannerRange = value;
        state.cocPerformanceRange = value.replace("d", "");
      }
      if (key === "employee") state.scannerEmployee = value;
      if (key === "capture") state.scannerCaptureMethod = value;
      if (key === "version") state.scannerVersion = value;
      if (key === "review") state.scannerReviewStatus = value;
      if (key === "size") state.scannerCorrectionSize = value;
      state.scannerPage = 1;
      if (key === "range") void Promise.all([loadScannerData(), loadCocData()]);
      else loadScannerData();
      return;
    }
    else return;
    render();
  };

  const closePremiumSelects = (except = null) => {
    document.querySelectorAll("#atlasOperationsDashboard [data-atlas-select]").forEach((root) => {
      if (root === except) return;
      const menu = root.querySelector("[data-atlas-select-menu]");
      const trigger = root.querySelector("[data-atlas-select-trigger]");
      if (menu) menu.hidden = true;
      if (trigger) trigger.setAttribute("aria-expanded", "false");
      root.classList.remove("is-open");
    });
  };

  const handleKeydown = (event) => {
    const root = event.target.closest?.("[data-atlas-select]");
    if (!root) {
      if (event.key === "Escape") closePremiumSelects();
      return;
    }
    const trigger = root.querySelector("[data-atlas-select-trigger]");
    const menu = root.querySelector("[data-atlas-select-menu]");
    const options = [...root.querySelectorAll("[data-atlas-select-option]")];
    if (event.target === trigger && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      closePremiumSelects(root);
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      root.classList.add("is-open");
      const selectedIndex = Math.max(0, options.findIndex((option) => option.getAttribute("aria-selected") === "true"));
      options[event.key === "ArrowUp" ? Math.max(0, selectedIndex - 1) : selectedIndex]?.focus({ preventScroll: true });
      return;
    }
    const optionIndex = options.indexOf(event.target);
    if (optionIndex >= 0 && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : event.key === "ArrowDown" ? Math.min(options.length - 1, optionIndex + 1) : Math.max(0, optionIndex - 1);
      options[nextIndex]?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closePremiumSelects();
      trigger?.focus({ preventScroll: true });
    }
  };

  const signIn = async (form) => {
    const message = form.querySelector("[data-access-message]");
    const submit = form.querySelector('button[type="submit"]');
    message.textContent = "";
    submit.disabled = true;
    submit.textContent = "Signing in…";
    try {
      const payload = window.AtlasAuth
        ? await window.AtlasAuth.signIn(form.elements.login_name.value, form.elements.password.value)
        : await api("/auth/v1/token?grant_type=password", {
          token: null,
          method: "POST",
          body: { email: form.elements.login_name.value.trim(), password: form.elements.password.value },
        });
      state.session = payload;
      state.accessRequired = false;
      state.skus = [];
      await loadData();
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : "Sign in failed.";
      submit.disabled = false;
      submit.textContent = "Sign In & Open Dashboard";
    }
  };

  const signOut = async () => {
    const token = state.session?.access_token;
    if (window.AtlasAuth) await window.AtlasAuth.signOut();
    else sessionStorage.removeItem(SESSION_KEY);
    state.session = null;
    state.skus = [];
    state.locations = [];
    state.activities = [];
    state.history = [];
    state.normalized = [];
      state.currentProfile = null;
    state.warehouses = [];
    state.selectedWarehouse = null;
    state.view = "operations";
    state.adminUsers = [];
    state.adminUsersLoaded = false;
    state.accountModal = null;
    state.accountDeleteError = "";
    state.cocRecords = [];
    state.cocLoaded = false;
    state.cocSelected = null;
    state.cocDelete = null;
    state.cocPreview = { status: "idle", html: "", error: "", id: "" };
    state.cocWorkspace = "operations";
    state.scannerData = null;
    state.scannerCorrections = [];
    state.scannerSelected = null;
    state.scannerLoaded = false;
    state.scannerError = "";
    cocWorkbookCache.clear();
    if (token && !window.AtlasAuth) api("/auth/v1/logout", { token, method: "POST" }).catch(() => {});
    await loadData();
  };

  const runAdminAction = async (action, payload, form = null) => {
    if (state.adminLoading) return;
    const message = form?.querySelector("[data-account-message]");
    const submit = form?.querySelector('button[type="submit"]');
    if (message) message.textContent = "";
    if (submit) {
      submit.disabled = true;
      submit.dataset.originalText = submit.textContent;
      submit.textContent = "Saving…";
    }
    state.adminLoading = true;
    state.adminError = "";
    try {
      const result = await adminApi(action, payload);
      state.adminNotice = result.message || "The ATLAS account was updated.";
      state.accountModal = null;
      state.adminLoading = false;
      await loadAdminUsers({ preserveNotice: true });
      await loadData();
    } catch (error) {
      const text = error instanceof Error ? error.message : "The account change could not be completed.";
      state.adminError = text;
      if (message) message.textContent = text;
      if (submit) {
        submit.disabled = false;
        submit.textContent = submit.dataset.originalText || "Save";
      }
      state.adminLoading = false;
      render();
    }
  };

  const deleteAdminAccount = async (userId) => {
    if (state.adminLoading || !userId) return;
    const target = state.adminUsers.find((user) => user.id === userId);
    state.adminLoading = true;
    state.adminError = "";
    state.accountDeleteError = "";
    render();
    try {
      const result = await adminApi("delete", { user_id: userId, preserve_history: true });
      state.adminUsers = state.adminUsers.filter((user) => user.id !== userId);
      state.adminUsersLoaded = true;
      state.accountModal = null;
      state.adminLoading = false;
      state.adminNotice = result.message || `${target?.display_name || "The account"} was deleted.`;
      render();
      await loadAdminUsers({ preserveNotice: true });
      await loadData({ force: true });
    } catch (error) {
      const raw = error instanceof Error ? error.message : "The account could not be deleted.";
      state.adminLoading = false;
      state.accountDeleteError = /database error deleting user|foreign key|still referenced|violates/i.test(raw)
        ? "This account is linked to protected ATLAS history. The account-deletion server update must be deployed before it can be removed safely."
        : raw;
      render();
    }
  };

  const runProtectedAction = async (action, payload) => {
    try {
      const result = await adminApi(action, payload);
      state.drawer = null;
      state.adminNotice = result.message || "ATLAS recorded the update.";
      await loadData();
    } catch (error) {
      state.error = error instanceof Error ? error.message : "The protected action could not be completed.";
      render();
    }
  };

  const saveScannerReview = async (form, { exclude = false } = {}) => {
    const submit = form.querySelector('button[type="submit"]');
    const message = form.querySelector("[data-scanner-review-error]");
    const data = new FormData(form);
    if (submit) { submit.disabled = true; submit.textContent = "Saving…"; }
    if (message) message.textContent = "";
    try {
      const result = await scannerApi("review-correction", {
        attemptId: data.get("attempt_id"),
        classification: data.get("classification"),
        retainForTraining: data.get("retain_training") === "on",
        exclude,
      });
      state.scannerSelected = result.item || null;
      state.scannerNotice = exclude
        ? "Correction evidence was excluded from scanner improvement."
        : "Correction review and training decision were saved.";
      await loadScannerData({ background: true });
      state.scannerSelected = null;
      render();
    } catch (error) {
      if (message) message.textContent = error instanceof Error ? error.message : "The review could not be saved.";
      if (submit) { submit.disabled = false; submit.textContent = "Save Review"; }
    }
  };

  const handleSubmit = (event) => {
    const form = event.target;
    if (form.matches("[data-scanner-review]")) {
      event.preventDefault();
      void saveScannerReview(form);
    } else if (form.matches("[data-coc-delete-form]")) {
      event.preventDefault();
      const record = state.cocDelete;
      const message = form.querySelector("[data-coc-delete-error]");
      const submit = form.querySelector('button[type="submit"]');
      const reason = form.elements.reason.value.trim();
      const confirmation = form.elements.confirmation.value.trim();
      const invoice = String(cocSnapshot(record).invoiceNumber || "").trim();
      if (!record || !cocCanDelete(record)) {
        message.textContent = "Only completed COCs can be deleted.";
        return;
      }
      if (reason.length < 4) {
        message.textContent = "Enter a short reason for this deletion.";
        return;
      }
      if (!invoice || confirmation.toLowerCase() !== invoice.toLowerCase()) {
        message.textContent = "The invoice number does not match.";
        return;
      }
      submit.disabled = true;
      submit.textContent = "Deleting…";
      cocApi("delete-coc", { deliveryId: record.id, reason }).then(async () => {
        cocWorkbookCache.delete(record.id);
        state.cocDelete = null;
        state.cocSelected = null;
        state.cocPreview = { status: "idle", html: "", error: "", id: "" };
        state.cocNotice = `COC ${invoice} was permanently deleted. Its audit record was retained.`;
        await loadCocData();
      }).catch((error) => {
        message.textContent = error instanceof Error ? error.message : "The COC could not be deleted.";
        submit.disabled = false;
        submit.textContent = "Permanently Delete COC";
      });
    } else if (form.matches("[data-sign-in]")) {
      event.preventDefault();
      signIn(form);
    } else if (form.matches("[data-account-create]")) {
      event.preventDefault();
      runAdminAction("create", {
        display_name: form.elements.display_name.value,
        login_name: form.elements.login_name.value,
        role: form.elements.role.value,
        warehouse_code: form.elements.warehouse_code.value,
        password: form.elements.password.value,
      }, form);
    } else if (form.matches("[data-account-update]")) {
      event.preventDefault();
      runAdminAction("update", {
        user_id: form.elements.user_id.value,
        display_name: form.elements.display_name.value,
        login_name: form.elements.login_name.value,
        role: form.elements.role.value,
        warehouse_code: form.elements.warehouse_code.value,
      }, form);
    } else if (form.matches("[data-account-password]")) {
      event.preventDefault();
      runAdminAction("password", {
        user_id: form.elements.user_id.value,
        password: form.elements.password.value,
      }, form);
    }
  };

  const connectMenu = () => {
    const link = document.querySelector('[data-action="dashboard"]');
    if (link && link.dataset.dashboardBound !== "true") {
      link.dataset.dashboardBound = "true";
      link.addEventListener("click", (event) => {
        event.preventDefault();
        openDashboard();
      });
    }
  };

  document.addEventListener(
    "click",
    (event) => {
      const navigation = event.target.closest?.(".premium-drawer-link");
      if (!navigation || !state.open) return;
      if (navigation.dataset.action === "dashboard") return;
      if (navigation.dataset.nav) closeDashboard();
    },
    true,
  );

  const observer = new MutationObserver(connectMenu);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("DOMContentLoaded", () => {
    state.session = getSession();
    mount();
    connectMenu();
  });
  window.addEventListener("atlas-auth-changed", (event) => {
    state.session = event.detail?.session || null;
    state.skus = [];
    state.locations = [];
    if (state.open) loadData();
  });
  window.atlasOpenDashboard = openDashboard;
})();
