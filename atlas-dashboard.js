(() => {
  "use strict";

  const API_URL = "https://dwrrbpiprcmajfyronlf.supabase.co";
  const PUBLIC_KEY = "sb_publishable_akr0opK3RV0Mg5CQpF2woQ_hBFyRIJa";
  const SESSION_KEY = "atlas-dashboard-session-v1";
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
    adminUsers: [],
    adminUsersLoaded: false,
    adminLoading: false,
    adminError: "",
    adminNotice: "",
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
    },
    cocLoading: false,
    cocLoaded: false,
    cocError: "",
    cocNotice: "",
    cocSelected: null,
    cocPreview: { status: "idle", html: "", error: "", id: "" },
    cocDelete: null,
    lastSync: null,
    session: null,
    accessRequired: false,
    error: "",
  };
  const cocWorkbookCache = new Map();
  let cocSearchTimer = null;
  let cocRequestSequence = 0;

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
      timeZone: "America/Los_Angeles",
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
      timeZone: "America/Los_Angeles",
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
    const response = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        apikey: PUBLIC_KEY,
        Authorization: `Bearer ${token || PUBLIC_KEY}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.message || payload?.error_description || payload?.hint || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  };

  const readTable = async (name, token) =>
    api(`/rest/v1/${name}?select=*&limit=5000`, { token });

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

  const cocApi = (action, payload = {}) =>
    api("/functions/v1/coc-dashboard", {
      method: "POST",
      body: { action, stationKey: "OFFICE_COC_01", ...payload },
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
    return {
      activeDurationMs: Number(analytics.activeDurationMs || 0),
      scanAttempts,
      scanSuccesses,
      distinctLots: lots.length,
      manualLots: lots.filter((lot) => manualMethods.has(String(lot.captureMethod || "").toLowerCase())).length,
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

  const loadCocData = async ({ background = false } = {}) => {
    if (!state.session?.access_token || !["supervisor", "admin"].includes(state.currentProfile?.role)) return;
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
        }),
        cocApi("metrics", {
          dayStart: new Date(new Date().setHours(0, 0, 0, 0)).toISOString(),
          performanceRange: state.cocPerformanceRange,
        }),
      ]);
      if (requestId !== cocRequestSequence) return;
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
      };
      state.cocLoaded = true;
      state.lastSync = new Date();
      if (state.cocSelected) {
        const refreshed = state.cocRecords.find((record) => record.id === state.cocSelected.id);
        if (refreshed) state.cocSelected = refreshed;
      }
    } catch (error) {
      if (requestId !== cocRequestSequence) return;
      state.cocError = error instanceof Error ? error.message : "COC records could not be loaded.";
    } finally {
      if (requestId !== cocRequestSequence) return;
      state.cocLoading = false;
      const previewLocked = state.cocSelected && state.cocPreview.status === "ready";
      if (!background || !previewLocked) background ? renderPreservingScroll() : render();
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

  const loadData = async () => {
    if (state.loading) return;
    state.loading = true;
    state.error = "";
    state.accessRequired = false;
    render();
    const token = state.session?.access_token;
    try {
      const [skusResult, locationsResult] = await Promise.allSettled([
        readTable("skus", token),
        readTable("locations", token),
      ]);
      if (skusResult.status !== "fulfilled") throw skusResult.reason;
      if (locationsResult.status !== "fulfilled") throw locationsResult.reason;
      state.skus = skusResult.value || [];
      state.locations = locationsResult.value || [];

      const protectedResults = await Promise.allSettled([
        readTable("inventory_activity", token),
        readTable("location_history", token),
        token ? readTable("profiles", token) : Promise.resolve([]),
        token ? readTable("atlas_undo_snapshots", token) : Promise.resolve([]),
        token ? readTable("sku_delete_requests", token) : Promise.resolve([]),
      ]);
      state.activities = protectedResults[0].status === "fulfilled" ? protectedResults[0].value : [];
      state.history = protectedResults[1].status === "fulfilled" ? protectedResults[1].value : [];
      state.profiles = protectedResults[2].status === "fulfilled" ? protectedResults[2].value : [];
      state.undoSnapshots = protectedResults[3].status === "fulfilled" ? protectedResults[3].value : [];
      state.deleteRequests = protectedResults[4].status === "fulfilled" ? protectedResults[4].value : [];
      state.currentProfile =
        state.profiles.find((profile) => profile.user_id === state.session?.user?.id)
        || (state.session?.user?.id ? {
          user_id: state.session.user.id,
          display_name: state.session.user.user_metadata?.display_name || state.session.user.app_metadata?.login_name || "ATLAS user",
          role: state.session.user.app_metadata?.atlas_role || state.session.user.app_metadata?.role || "picker",
        } : null);
      if (state.currentProfile && !["supervisor", "admin"].includes(state.currentProfile.role)) {
        state.accessRequired = true;
      }
      if (state.currentProfile?.role !== "admin" && state.view === "access") {
        state.view = "operations";
      }

      const protectedErrors = protectedResults
        .slice(0, 2)
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
      if ([401, 403].includes(error?.status) && !token) state.accessRequired = true;
      else state.error = error instanceof Error ? error.message : "The dashboard data could not be loaded.";
    } finally {
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

  const renderAccess = () => state.session && state.currentProfile && !["supervisor", "admin"].includes(state.currentProfile.role) ? `
    <div class="atlas-dashboard-access">
      <img class="atlas-dashboard-access-logo" src="./atlas-brand-landscape-light.svg?v=131" alt="ATLAS Warehouse Management">
      <p class="atlas-dashboard-eyebrow">PICKER ACCESS</p>
      <h2>Dashboard access is not included</h2>
      <p>Your account can use warehouse tools and COC workflows. Operational history and account controls are limited to supervisors and administrators.</p>
      <button class="atlas-dashboard-button atlas-dashboard-button--primary" type="button" data-sign-out>Sign Out</button>
    </div>` : `
    <div class="atlas-dashboard-access">
      <img class="atlas-dashboard-access-logo" src="./atlas-brand-landscape-light.svg?v=131" alt="ATLAS Warehouse Management">
      <p class="atlas-dashboard-eyebrow">AUTHORIZED ACCESS</p>
      <h2>Supervisor sign in</h2>
      <p>Operational history includes employee names and detailed inventory changes. Sign in once with an ATLAS supervisor or administrator account; this device will remain signed in until you sign out.</p>
      <form class="atlas-dashboard-access-form" data-sign-in>
        <label><span>Name</span><input type="text" name="login_name" autocomplete="username" required></label>
        <label><span>Password</span>${passwordField({ autocomplete: "current-password" })}</label>
        <p class="atlas-dashboard-access-message" data-access-message></p>
        <button class="atlas-dashboard-button atlas-dashboard-button--primary" type="submit">Open Dashboard</button>
      </form>
    </div>`;

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
        <header><div><p class="atlas-dashboard-eyebrow">NOTIFICATIONS</p><h2>Today's Warehouse Activity</h2><span>${rows.length} recorded ${rows.length === 1 ? "action" : "actions"} · Pacific time</span></div><button type="button" class="atlas-dashboard-notification-close" data-notifications-close aria-label="Close notifications">×</button></header>
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
            <div class="atlas-account-modal-actions">
              <button type="button" class="atlas-dashboard-button" data-account-close>Cancel</button>
              <button type="button" class="atlas-dashboard-button atlas-dashboard-button--danger" data-account-delete data-user-id="${escapeHtml(user.id)}">Delete Account</button>
            </div>
          </section>
        </div>`;
    }
    const isCreate = mode === "create";
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
              <label><span>ATLAS role</span><select name="role" required>
                ${["picker", "office_receiver", "supervisor", "admin"].map((role) => `<option value="${role}" ${!isCreate && user.role === role ? "selected" : ""}>${roleLabel(role)}</option>`).join("")}
              </select></label>
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
    const rows = state.adminUsers.map((user) => `
      <article class="atlas-account-row ${user.active ? "" : "is-disabled"}">
        <span class="atlas-dashboard-avatar">${escapeHtml(initials(user.display_name || user.login_name))}</span>
        <span class="atlas-account-identity"><strong>${escapeHtml(user.display_name || "Unnamed account")}${user.is_current ? " <small>(You)</small>" : ""}</strong><span>${escapeHtml(roleLabel(user.role))} account</span></span>
        <span class="atlas-account-role is-${escapeHtml(user.role)}">${escapeHtml(roleLabel(user.role))}</span>
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
          <div class="atlas-account-list">
            ${state.adminLoading && !state.adminUsersLoaded ? renderLoading() : rows || `<div class="atlas-dashboard-empty"><strong>No accounts found</strong><p>Add the first managed ATLAS account.</p></div>`}
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

  const renderCocPallets = (record) => (cocSnapshot(record).pallets || []).map((pallet) => `
    <section class="atlas-dashboard-coc-pallet"><header><h3>PALLET ${escapeHtml(pallet.number)}</h3><strong>${cocPlural((pallet.lots || []).reduce((sum, lot) => sum + Number(lot.cases || 0), 0), "box")}</strong></header>
      ${(pallet.lots || []).map((lot) => `<div class="atlas-dashboard-coc-lot"><span><strong>${escapeHtml(lot.model || "—")}</strong><small>LOT <b>${escapeHtml(lot.lot || "—")}</b></small></span><b>${cocPlural(lot.cases, "box")} · ${(Number(lot.cases || 0) * Number(lot.caseQuantity || 0)).toLocaleString()} units</b></div>`).join("")}
    </section>`).join("");

  const renderCocPreview = (record) => {
    const snap = cocSnapshot(record);
    const body = state.cocPreview.status === "ready" && state.cocPreview.id === record.id
      ? state.cocPreview.html
      : state.cocPreview.status === "error"
        ? `<div class="atlas-dashboard-coc-preview-status is-error"><strong>Preview unavailable</strong><p>${escapeHtml(state.cocPreview.error)}</p><button class="atlas-dashboard-button atlas-dashboard-button--primary" data-coc-official="${escapeHtml(record.id)}">Try Again</button></div>`
        : `<div class="atlas-dashboard-coc-preview-status"><span class="atlas-dashboard-spinner"></span><strong>Opening the saved Official COC…</strong><p>ATLAS is reading the actual XLSX workbook.</p></div>`;
    return `<section class="atlas-dashboard-coc-detail">
      <button class="atlas-dashboard-coc-back" type="button" data-coc-preview-back>‹ COC Overview</button>
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
      <dl class="atlas-dashboard-coc-fields"><div><dt>Invoice</dt><dd>${escapeHtml(snap.invoiceNumber || "—")}</dd></div><div><dt>IF Number</dt><dd>${escapeHtml(snap.ifNumber || "—")}</dd></div><div><dt>Sent By</dt><dd>${escapeHtml(record.submitted_by_display_name || snap.employeeDisplayName || snap.employee || "—")}</dd></div><div><dt>Recorded</dt><dd>${escapeHtml(formatDateTime(parseDate(cocRecordDate(record))))}</dd></div><div><dt>Pallets</dt><dd>${totals.pallets}</dd></div><div><dt>Boxes</dt><dd>${totals.boxes}</dd></div><div><dt>Active COC Time</dt><dd>${escapeHtml(formatCocDuration(performance.activeDurationMs))}</dd></div><div><dt>Scan Success</dt><dd>${escapeHtml(cocPercentage(performance.scanSuccesses, performance.scanAttempts))}</dd></div><div><dt>Manual Lots</dt><dd>${performance.manualLots} / ${performance.distinctLots}</dd></div></dl>
      <div class="atlas-dashboard-coc-pallets">${renderCocPallets(record)}</div>
      <div class="atlas-dashboard-coc-detail-actions"><button class="atlas-dashboard-button atlas-dashboard-button--primary" data-coc-official="${escapeHtml(record.id)}">View Official COC</button><button class="atlas-dashboard-button atlas-dashboard-button--primary" data-coc-download="${escapeHtml(record.id)}">Download Official COC</button>${cocCanDelete(record) ? `<button class="atlas-dashboard-button atlas-dashboard-button--danger" data-coc-delete="${escapeHtml(record.id)}">Delete COC</button>` : ""}</div>
    </section>`;
  };

  const renderCocRows = () => {
    if (state.cocLoading && !state.cocLoaded) return `<tr><td colspan="7"><div class="atlas-dashboard-coc-empty">Loading COCs…</div></td></tr>`;
    if (!state.cocRecords.length) return `<tr><td colspan="7"><div class="atlas-dashboard-coc-empty">${state.cocSearch ? "No COCs match this search." : "No COCs are available in this section."}</div></td></tr>`;
    return state.cocRecords.map((record) => {
      const snap = cocSnapshot(record), totals = cocTotals(record);
      return `<tr><td><span class="atlas-dashboard-coc-status is-${escapeHtml(cocStatus(record).toLowerCase().replaceAll(" ", "-"))}">${escapeHtml(cocStatus(record))}</span></td><td>${escapeHtml(formatDateTime(parseDate(cocRecordDate(record))))}</td><td><strong>${escapeHtml(snap.customerName || "—")}</strong></td><td>${escapeHtml(snap.invoiceNumber || "—")}</td><td>${escapeHtml(snap.ifNumber || "—")}</td><td>${cocPlural(totals.pallets, "pallet")} · ${cocPlural(totals.boxes, "box")}</td><td><div class="atlas-dashboard-coc-row-actions"><button data-coc-open="${escapeHtml(record.id)}">View</button><button data-coc-official-row="${escapeHtml(record.id)}">Official COC</button>${cocCanDelete(record) ? `<button class="is-delete" data-coc-delete="${escapeHtml(record.id)}">Delete</button>` : ""}</div></td></tr>`;
    }).join("");
  };

  const renderCocOversight = () => {
    if (state.cocSelected) return `${renderCocDetail(state.cocSelected)}${renderCocDeleteModal()}`;
    const pages = Math.max(1, Math.ceil(state.cocTotal / COC_PAGE_SIZE));
    const performance = state.cocPerformance;
    const rangeLabel = state.cocPerformanceRange === "all" ? "All time" : `Last ${state.cocPerformanceRange} days`;
    return `<section class="atlas-dashboard-coc-center">
      ${state.cocNotice ? `<div class="atlas-dashboard-coc-notice">${escapeHtml(state.cocNotice)}</div>` : ""}
      ${state.cocError ? `<div class="atlas-dashboard-coc-error">${escapeHtml(state.cocError)}</div>` : ""}
      <div class="atlas-dashboard-coc-metrics">${cocMetricCard("all", "ALL COCs", state.cocMetrics.total)}${cocMetricCard("awaiting", "AWAITING", state.cocMetrics.awaiting, "Requires office review")}${cocMetricCard("received", "RECEIVED TODAY", state.cocMetrics.receivedToday)}${cocMetricCard("completed", "COMPLETED TODAY", state.cocMetrics.completedToday)}</div>
      <article class="atlas-dashboard-coc-performance">
        <header><div><p class="atlas-dashboard-eyebrow">WAREHOUSE PERFORMANCE</p><h2>COC Workflow Metrics</h2><span>Active workflow time and lot-capture quality</span></div><label><span>Reporting period</span><select data-coc-performance-range aria-label="COC performance reporting period"><option value="7" ${state.cocPerformanceRange === "7" ? "selected" : ""}>Last 7 days</option><option value="30" ${state.cocPerformanceRange === "30" ? "selected" : ""}>Last 30 days</option><option value="all" ${state.cocPerformanceRange === "all" ? "selected" : ""}>All time</option></select></label></header>
        <div class="atlas-dashboard-coc-performance-grid">
          ${cocPerformanceCard("time", "AVG COC TIME", formatCocDuration(performance.averageActiveDurationMs), performance.completionSamples ? `Median ${formatCocDuration(performance.medianActiveDurationMs)} · ${cocPlural(performance.completionSamples, "COC")}` : "Timing begins with this update")}
          ${cocPerformanceCard("scan", "SCAN SUCCESS", cocPercentage(performance.scanSuccesses, performance.scanAttempts), performance.scanAttempts ? `${performance.scanSuccesses.toLocaleString()} of ${performance.scanAttempts.toLocaleString()} confirmed attempts` : "No completed scan attempts yet")}
          ${cocPerformanceCard("manual", "MANUAL ENTRY", cocPercentage(performance.manualLots, performance.distinctLots), performance.distinctLots ? `${performance.manualLots.toLocaleString()} of ${performance.distinctLots.toLocaleString()} distinct lots` : "No completed lot records yet")}
        </div>
        <footer><span>${escapeHtml(rangeLabel)}</span><small>Canceled scans are tracked separately and excluded from scan success.</small></footer>
      </article>
      <article class="atlas-dashboard-coc-panel"><header><div><p class="atlas-dashboard-eyebrow">LIVE COMPLIANCE OVERSIGHT</p><h2>COC Receiver Activity</h2><span>Review every office COC without pairing this dashboard as a Receiver.</span></div><span class="atlas-dashboard-coc-live">● LIVE · 15 SEC</span></header>
        <nav class="atlas-dashboard-coc-sections" aria-label="COC record sections">${[["all","All COCs"],["active","Incoming"],["completed","Completed"],["archive","Archive"]].map(([value, label]) => `<button type="button" data-coc-section="${value}" class="${state.cocSection === value ? "is-active" : ""}">${label}</button>`).join("")}</nav>
        <div class="atlas-dashboard-coc-toolbar"><input type="search" data-coc-search value="${escapeHtml(state.cocSearch)}" placeholder="Search customer, invoice, or IF number" aria-label="Search COCs"><select data-coc-sort aria-label="Sort COCs"><option value="newest" ${state.cocSort === "newest" ? "selected" : ""}>Newest first</option><option value="oldest" ${state.cocSort === "oldest" ? "selected" : ""}>Oldest first</option><option value="customer-asc" ${state.cocSort === "customer-asc" ? "selected" : ""}>Customer A–Z</option></select><button class="atlas-dashboard-button" type="button" data-coc-refresh>Refresh</button></div>
        <div class="atlas-dashboard-coc-table-wrap"><table><thead><tr><th>Status</th><th>Recorded</th><th>Customer</th><th>Invoice</th><th>IF Number</th><th>Pallets / Boxes</th><th>Actions</th></tr></thead><tbody>${renderCocRows()}</tbody></table></div>
        <footer><span>Showing ${state.cocTotal ? ((state.cocPage - 1) * COC_PAGE_SIZE) + 1 : 0}–${Math.min(state.cocPage * COC_PAGE_SIZE, state.cocTotal)} of ${state.cocTotal.toLocaleString()} COCs</span><div><button type="button" data-coc-page="${state.cocPage - 1}" ${state.cocPage <= 1 ? "disabled" : ""}>‹</button><strong>${state.cocPage} / ${pages}</strong><button type="button" data-coc-page="${state.cocPage + 1}" ${state.cocPage >= pages ? "disabled" : ""}>›</button></div></footer>
      </article>${renderCocDeleteModal()}
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
      <div class="atlas-dashboard-statusline"><span class="atlas-dashboard-status-dot is-live"></span><span>${accessView ? "Protected administrator controls" : cocView ? `Live COC data · ${escapeHtml(state.lastSync ? "Updated just now" : "Ready")}` : `Live data · ${escapeHtml(state.lastSync ? "Updated just now" : "Ready")}`}</span></div>`;
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
    if (state.loading && !state.skus.length) content.innerHTML = renderLoading();
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
      render();
      return;
    }
    if (event.target.matches?.("[data-notifications-close]")) {
      state.notificationsOpen = false;
      render();
      return;
    }
    const button = event.target.closest("button");
    if (!button) return;
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
      if (state.view === "cocs" && !state.cocLoaded) loadCocData();
      startDashboardRefresh();
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
      render();
    } else if (button.matches("[data-account-confirm-delete]")) {
      state.accountModal = { mode: "confirm-delete", userId: button.dataset.userId };
      render();
    } else if (button.matches("[data-account-delete]")) {
      button.disabled = true;
      button.textContent = "Deleting…";
      runAdminAction("delete", { user_id: button.dataset.userId });
    } else if (button.matches("[data-account-refresh]")) {
      loadAdminUsers();
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
    if (!event.target.matches("[data-search]")) return;
    state.search = event.target.value;
    render();
    const input = document.querySelector("[data-search]");
    input?.focus();
    input?.setSelectionRange(state.search.length, state.search.length);
  };

  const handleChange = (event) => {
    if (event.target.matches("[data-range]")) state.range = event.target.value;
    else if (event.target.matches("[data-custom-start]")) state.customStart = event.target.value;
    else if (event.target.matches("[data-custom-end]")) state.customEnd = event.target.value;
    else if (event.target.matches("[data-filter]")) state.filter = event.target.value;
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
    else return;
    render();
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
      submit.textContent = "Open Dashboard";
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
    state.view = "operations";
    state.adminUsers = [];
    state.adminUsersLoaded = false;
    state.accountModal = null;
    state.cocRecords = [];
    state.cocLoaded = false;
    state.cocSelected = null;
    state.cocDelete = null;
    state.cocPreview = { status: "idle", html: "", error: "", id: "" };
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

  const handleSubmit = (event) => {
    const form = event.target;
    if (form.matches("[data-coc-delete-form]")) {
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
        password: form.elements.password.value,
      }, form);
    } else if (form.matches("[data-account-update]")) {
      event.preventDefault();
      runAdminAction("update", {
        user_id: form.elements.user_id.value,
        display_name: form.elements.display_name.value,
        login_name: form.elements.login_name.value,
        role: form.elements.role.value,
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
