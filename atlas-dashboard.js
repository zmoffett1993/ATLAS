(() => {
  "use strict";

  const API_URL = "https://dwrrbpiprcmajfyronlf.supabase.co";
  const PUBLIC_KEY = "sb_publishable_akr0opK3RV0Mg5CQpF2woQ_hBFyRIJa";
  const SESSION_KEY = "atlas-dashboard-session-v1";
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
    lastSync: null,
    session: null,
    accessRequired: false,
    error: "",
  };

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
      return `FLOOR ${
        { A: "LEFT", B: "MIDDLE", C: "RIGHT" }[sectionName] || sectionName
      }`;
    }
    if (aisleNumber === 23) return `SR ${sectionName}`;
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
      return { key: "create", label: "Created new SKU", color: "#168552", operational: true };
    if (action === "ADD_LOCATION")
      return { key: "move", label: "Added inventory location", color: "#1467dd", operational: true };
    if (action === "MOVE_LOCATION" || aisleChanged || reasonText.includes("move all product"))
      return { key: "move", label: "Moved inventory", color: "#1467dd", operational: true };
    if (action.includes("SKU_EDIT"))
      return { key: "edit", label: "Edited SKU", color: "#d98900", operational: true };
    if (action === "SKU_DELETE_REQUESTED")
      return { key: "delete-request", label: "Deletion pending approval", color: "#d98900", operational: false };
    if (action === "SKU_DELETE_REJECTED")
      return { key: "delete-request", label: "Deletion request rejected", color: "#d98900", operational: false };
    if (action === "SKU_DELETE_APPROVED")
      return { key: "delete", label: "Deleted SKU", color: "#d33a3a", operational: true };
    if (action === "UNDO_ACTION")
      return { key: "undo", label: "Reversed recorded action", color: "#1467dd", operational: true };
    if (action.includes("SKU_DELETE"))
      return { key: "delete", label: "Removed SKU", color: "#d33a3a", operational: true };
    if (action.includes("PICK_FIRST") || pickChanged)
      return {
        key: "pick",
        label: bool(newRecord.pick_first) ? "Enabled Pick First" : "Disabled Pick First",
        color: "#7957d5",
        operational: action.includes("PICK_FIRST"),
      };
    if (action === "CLEAR_LOCATION" || action.includes("LOCATION_CLEAR") || (activeChanged && !bool(newRecord.is_active)))
      return { key: "location", label: "Cleared location", color: "#0b9bad", operational: action === "CLEAR_LOCATION" || action.includes("LOCATION_CLEAR") };
    if (action === "RESTORE_LOCATION" || action.includes("LOCATION_RESTORE") || (activeChanged && bool(newRecord.is_active)))
      return { key: "location", label: "Restored location", color: "#168552", operational: action === "RESTORE_LOCATION" || action.includes("LOCATION_RESTORE") };
    if (action.includes("CORRECT") || reasonText.includes("different location"))
      return { key: "location", label: "Corrected location", color: "#d98900", operational: true };
    if (action === "USER_CREATED")
      return { key: "access", label: "Created ATLAS account", color: "#168552", operational: true };
    if (action === "USER_UPDATED")
      return { key: "access", label: "Updated account access", color: "#1467dd", operational: true };
    if (action === "USER_PASSWORD_CHANGED")
      return { key: "access", label: "Changed account password", color: "#7957d5", operational: true };
    if (action === "USER_DEACTIVATED")
      return { key: "access", label: "Blocked account sign-in (legacy)", color: "#d33a3a", operational: true };
    if (action === "USER_REACTIVATED")
      return { key: "access", label: "Reactivated ATLAS account", color: "#168552", operational: true };
    if (action === "USER_DELETED")
      return { key: "access", label: "Deleted ATLAS account", color: "#d33a3a", operational: true };
    if (action === "INSERT")
      return { key: "audit", label: "Imported location", color: "#8795a6", operational: false };
    if (action === "DELETE")
      return { key: "audit", label: "Deleted location record", color: "#d33a3a", operational: false };
    return { key: "audit", label: "Updated database record", color: "#8795a6", operational: false };
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

  const adminApi = (action, payload = {}) =>
    api("/functions/v1/atlas-user-admin", {
      method: "POST",
      body: { action, ...payload },
    });

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

  const openDashboard = async () => {
    mount();
    state.open = true;
    closeMenu();
    document.getElementById("atlasOperationsDashboard").hidden = false;
    document.documentElement.classList.add("atlas-dashboard-open");
    syncMenuState();
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    state.session = getSession();
    render();
    await loadData();
  };

  const closeDashboard = () => {
    if (!state.open) return;
    state.open = false;
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
        state.profiles.find((profile) => profile.user_id === state.session?.user?.id) || null;
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
        String(left.display_name || left.email).localeCompare(String(right.display_name || right.email)),
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

  const renderAccess = () => `
    <div class="atlas-dashboard-access">
      <img class="atlas-dashboard-access-logo" src="./atlas-brand-landscape-light.svg?v=131" alt="ATLAS Warehouse Management">
      <p class="atlas-dashboard-eyebrow">AUTHORIZED ACCESS</p>
      <h2>Supervisor sign in</h2>
      <p>Operational history includes employee names and detailed inventory changes. Sign in with an ATLAS supervisor or administrator account to continue.</p>
      <form class="atlas-dashboard-access-form" data-sign-in>
        <label><span>Email address</span><input type="email" name="email" autocomplete="username" required></label>
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

  const renderSummaryCard = (label, value, note, icon, color, background) => `
    <article class="atlas-dashboard-card" style="--card-color:${color};--card-bg:${background}">
      <span class="atlas-dashboard-card-icon" aria-hidden="true">${icon}</span>
      <span class="atlas-dashboard-card-copy"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></span>
    </article>`;

  const renderFeed = (rows) => {
    if (!rows.length) {
      return `<div class="atlas-dashboard-empty"><strong>No matching activity</strong><p>Try a broader date range, a different action filter, or clear the search.</p></div>`;
    }
    return rows.slice(0, 250).map((row) => `
      <button type="button" class="atlas-dashboard-feed-row" data-activity-id="${escapeHtml(row.id)}" style="--activity-color:${row.color}">
        <span class="atlas-dashboard-activity-dot" aria-hidden="true"></span>
        <span class="atlas-dashboard-feed-primary"><strong>${escapeHtml(row.employee)}</strong><small>${escapeHtml(formatDateTime(row.date, true))}</small></span>
        <span class="atlas-dashboard-feed-detail"><strong class="atlas-dashboard-feed-action">${escapeHtml(row.label)}</strong><small>${escapeHtml(row.sku)}${row.detail && row.detail !== row.label ? ` · ${escapeHtml(row.detail)}` : ""}</small></span>
        <span class="atlas-dashboard-feed-location"><strong>${escapeHtml(row.location)}</strong><small>${escapeHtml(row.rawAction.replaceAll("_", " "))}</small></span>
        <time class="atlas-dashboard-feed-time" datetime="${row.date?.toISOString() || ""}">${escapeHtml(formatDateTime(row.date))}</time>
      </button>`).join("");
  };

  const renderTodaySummary = (rows, rangeLabel) => {
    const definitions = [
      ["move", "Inventory Moves", "#1467dd"], ["location", "Locations Marked Empty", "#0b9bad"],
      ["create", "New SKUs", "#168552"], ["edit", "SKU Edits", "#d98900"],
      ["pick", "Pick First Changes", "#7957d5"], ["delete", "Deleted SKUs", "#d33a3a"],
    ];
    return `<article class="atlas-dashboard-panel atlas-dashboard-today-summary"><header class="atlas-dashboard-panel-head"><div><h2>${escapeHtml(rangeLabel)}’s Summary</h2><p>Completed warehouse actions</p></div></header><div class="atlas-dashboard-today-total"><strong>${rows.length}</strong><span>total changes</span></div><div class="atlas-dashboard-summary-breakdown">${definitions.map(([key, label, color]) => `<span><i style="--summary-color:${color}"></i><b>${rows.filter((row) => row.key === key).length}</b>${escapeHtml(label)}</span>`).join("")}</div></article>`;
  };

  const renderWarehouseStatus = () => {
    const pending = state.deleteRequests.filter((request) => request.status === "pending");
    return `<article class="atlas-dashboard-panel atlas-dashboard-status-panel"><header class="atlas-dashboard-panel-head"><div><h2>Warehouse Status</h2><p>Supervisor attention</p></div></header>${pending.length ? `<div class="atlas-dashboard-status-attention"><strong>${pending.length} SKU deletion ${pending.length === 1 ? "request requires" : "requests require"} approval</strong><p>Pending requests do not change inventory until a supervisor approves them.</p><button type="button" class="atlas-dashboard-button atlas-dashboard-button--primary" data-review-pending>Review requests</button></div>` : `<div class="atlas-dashboard-status-ok"><strong>All systems normal</strong><p>No items requiring attention</p></div>`}</article>`;
  };

  const renderActivityDrawer = () => {
    const target = state.drawer?.kind === "request" ? state.deleteRequests.find((request) => request.id === state.drawer.id) : state.normalized.find((row) => row.id === state.drawer?.id);
    if (!target) return "";
    if (state.drawer?.kind === "request") {
      const sku = safeJson(target.sku_snapshot).sku || "SKU";
      const reviewer = state.currentProfile?.role === "supervisor" || state.currentProfile?.role === "admin";
      return `<div class="atlas-dashboard-drawer-backdrop" data-drawer-close><aside class="atlas-dashboard-drawer" role="dialog" aria-modal="true"><button type="button" class="atlas-account-modal-close" data-drawer-close aria-label="Close">×</button><p class="atlas-dashboard-eyebrow">SUPERVISOR REVIEW</p><h2>Delete ${escapeHtml(sku)}?</h2><p><strong>${escapeHtml(target.requested_by_name)}</strong> requested permanent deletion. The SKU and its active locations remain unchanged until approval.</p><dl><div><dt>Requested</dt><dd>${escapeHtml(formatDateTime(parseDate(target.requested_at)))}</dd></div><div><dt>SKU</dt><dd>${escapeHtml(sku)}</dd></div></dl>${reviewer && target.status === "pending" ? `<div class="atlas-dashboard-drawer-actions"><button type="button" class="atlas-dashboard-button" data-reject-request data-request-id="${escapeHtml(target.id)}">Reject</button><button type="button" class="atlas-dashboard-button atlas-dashboard-button--danger" data-approve-request data-request-id="${escapeHtml(target.id)}">Approve & Delete</button></div>` : `<p class="atlas-dashboard-drawer-note">Status: ${escapeHtml(target.status)}</p>`}</aside></div>`;
    }
    const snapshot = state.undoSnapshots.find((item) => item.id === target.snapshotId);
    const reviewer = state.currentProfile?.role === "supervisor" || state.currentProfile?.role === "admin";
    return `<div class="atlas-dashboard-drawer-backdrop" data-drawer-close><aside class="atlas-dashboard-drawer" role="dialog" aria-modal="true"><button type="button" class="atlas-account-modal-close" data-drawer-close aria-label="Close">×</button><p class="atlas-dashboard-eyebrow">ACTIVITY DETAIL</p><h2>${escapeHtml(target.label)}</h2><dl><div><dt>SKU</dt><dd>${escapeHtml(target.sku)}</dd></div><div><dt>Employee</dt><dd>${escapeHtml(target.employee)}</dd></div><div><dt>Location</dt><dd>${escapeHtml(target.location)}</dd></div><div><dt>Recorded</dt><dd>${escapeHtml(formatDateTime(target.date))}</dd></div><div><dt>Reason</dt><dd>${escapeHtml(target.detail)}</dd></div></dl>${snapshot ? (snapshot.undone_at ? `<p class="atlas-dashboard-drawer-note">This action was already reversed by ${escapeHtml(snapshot.undone_by_name || "a supervisor")}.</p>` : reviewer ? `<div class="atlas-dashboard-drawer-actions"><button type="button" class="atlas-dashboard-button atlas-dashboard-button--primary" data-undo-activity data-snapshot-id="${escapeHtml(snapshot.id)}">Undo Action</button></div>` : "") : `<p class="atlas-dashboard-drawer-note">Undo unavailable — this action was recorded before ATLAS reversible audit snapshots were enabled.</p>`}</aside></div>`;
  };

  const renderBars = (rows) => {
    const definitions = [
      ["move", "Moves", "#1467dd"],
      ["create", "New SKUs", "#168552"],
      ["edit", "SKU edits", "#d98900"],
      ["pick", "Pick First", "#7957d5"],
      ["location", "Location", "#d33a3a"],
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
    ({ admin: "Administrator", supervisor: "Supervisor", picker: "Picker" })[role] || "Picker";

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
            <p><strong>${escapeHtml(user.display_name || user.email)}</strong> will no longer be able to sign in. This action cannot be undone. Historical warehouse activity will remain intact.</p>
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
          <p>${isCreate ? "Create a private sign-in and choose exactly what this employee can access." : `Update ${escapeHtml(user.display_name || user.email)} without opening Supabase.`}</p>
          <form class="atlas-account-form" data-${isCreate ? "account-create" : "account-update"}>
            ${isCreate ? "" : `<input type="hidden" name="user_id" value="${escapeHtml(user.id)}">`}
            <div class="atlas-account-form-grid">
              <label><span>Display name</span><input type="text" name="display_name" value="${escapeHtml(isCreate ? "" : user.display_name)}" autocomplete="off" required></label>
              <label><span>Login email</span><input type="email" name="email" value="${escapeHtml(isCreate ? "" : user.email)}" autocomplete="off" required></label>
              <label><span>ATLAS role</span><select name="role" required>
                ${["picker", "supervisor", "admin"].map((role) => `<option value="${role}" ${!isCreate && user.role === role ? "selected" : ""}>${roleLabel(role)}</option>`).join("")}
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
        <span class="atlas-dashboard-avatar">${escapeHtml(initials(user.display_name || user.email))}</span>
        <span class="atlas-account-identity"><strong>${escapeHtml(user.display_name || "Unnamed account")}${user.is_current ? " <small>(You)</small>" : ""}</strong><span>${escapeHtml(user.email)}</span></span>
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

  const renderDashboard = () => {
    const rows = visibleRows();
    const operationalRows = rowsInRange().filter((row) => row.operational);
    const visibleOperationalRows = rows.filter((row) => row.operational);
    const activeSkus = state.skus.filter((sku) => sku.active == null || bool(sku.active)).length;
    const changes = operationalRows.length;
    const moves = operationalRows.filter((row) => row.key === "move").length;
    const created = operationalRows.filter((row) => row.key === "create").length;
    const rangeLabel = ({ today: "Today", week: "This Week", "7": "Last 7 Days", "30": "Last 30 Days", custom: "Custom Range" })[state.range] || "Selected range";
    const sessionName = state.session?.user?.email || "Supervisor";
    const isAdmin = state.currentProfile?.role === "admin";
    const accessView = state.view === "access" && isAdmin;
    const header = `
      <header class="atlas-dashboard-header">
        <div><p class="atlas-dashboard-eyebrow">ATLAS CONTROL CENTER</p><h1>${accessView ? "Access Management" : "Operations Dashboard"}</h1>${accessView ? `<p class="atlas-dashboard-subtitle">Manage employee identities, passwords, roles, and dashboard permissions securely from ATLAS.</p>` : `<p class="atlas-dashboard-subtitle atlas-dashboard-mobile-only">Warehouse activity, inventory changes, and SKU oversight in one clear operational view.</p>`}</div>
        <div class="atlas-dashboard-header-actions">
          ${accessView ? `<button class="atlas-dashboard-button" type="button" data-account-refresh>Refresh Accounts</button><button class="atlas-dashboard-button atlas-dashboard-button--primary" type="button" data-account-add>+ Add Account</button>` : `<div class="atlas-dashboard-date-control"><select class="atlas-dashboard-range" data-range aria-label="Dashboard date range">
            <option value="today" ${state.range === "today" ? "selected" : ""}>Today</option>
            <option value="week" ${state.range === "week" ? "selected" : ""}>This Week</option>
            <option value="7" ${state.range === "7" ? "selected" : ""}>Last 7 Days</option>
            <option value="30" ${state.range === "30" ? "selected" : ""}>Last 30 Days</option>
            <option value="custom" ${state.range === "custom" ? "selected" : ""}>Custom Range</option>
          </select>${state.range === "custom" ? `<span class="atlas-dashboard-custom-range"><input data-custom-start type="date" value="${escapeHtml(state.customStart)}" aria-label="Start date"><input data-custom-end type="date" value="${escapeHtml(state.customEnd)}" aria-label="End date"></span>` : ""}</div>`}
          ${state.session ? `<button class="atlas-dashboard-button" type="button" data-sign-out title="${escapeHtml(sessionName)}">Sign out</button>` : ""}
        </div>
      </header>
      ${isAdmin ? `<nav class="atlas-dashboard-tabs" aria-label="Dashboard sections"><button type="button" data-dashboard-view="operations" class="${accessView ? "" : "is-active"}">Operations</button><button type="button" data-dashboard-view="access" class="${accessView ? "is-active" : ""}">Access Management</button></nav>` : ""}
      <div class="atlas-dashboard-statusline"><span class="atlas-dashboard-status-dot is-live"></span><span>${accessView ? "Protected administrator controls" : `Live data · ${escapeHtml(state.lastSync ? "Updated just now" : "Ready")}`}</span></div>`;
    if (accessView) return `${header}${renderAccessManagement()}`;
    return `${header}
      <section class="atlas-dashboard-summary" aria-label="Operational summary">
        ${renderSummaryCard("Active SKUs", activeSkus, "Current picker inventory", "□", "#1467dd", "#eaf3ff")}
        ${renderSummaryCard("Inventory Moves", moves, rangeLabel, "⇄", "#1467dd", "#eaf3ff")}
        ${renderSummaryCard("New SKUs", created, rangeLabel, "+", "#168552", "#e9f7f0")}
        ${renderSummaryCard("Total Changes", changes, rangeLabel, "↗", "#7957d5", "#f2edff")}
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
      </section>${renderActivityDrawer()}`;
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
    else if (button.matches("[data-mobile-refresh], [data-retry]")) loadData();
    else if (button.matches("[data-export]")) exportCsv();
    else if (button.matches("[data-sign-out]")) signOut();
    else if (button.matches("[data-dashboard-view]")) {
      const view = button.dataset.dashboardView;
      if (view === "access" && state.currentProfile?.role !== "admin") return;
      state.view = view === "access" ? "access" : "operations";
      state.accountModal = null;
      render();
      if (state.view === "access" && !state.adminUsersLoaded) loadAdminUsers();
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
      const payload = await api("/auth/v1/token?grant_type=password", {
        token: null,
        method: "POST",
        body: { email: form.elements.email.value.trim(), password: form.elements.password.value },
      });
      payload.expires_at = payload.expires_at || Math.floor(Date.now() / 1000) + Number(payload.expires_in || 3600);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload));
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
    sessionStorage.removeItem(SESSION_KEY);
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
    if (token) api("/auth/v1/logout", { token, method: "POST" }).catch(() => {});
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
    if (form.matches("[data-sign-in]")) {
      event.preventDefault();
      signIn(form);
    } else if (form.matches("[data-account-create]")) {
      event.preventDefault();
      runAdminAction("create", {
        display_name: form.elements.display_name.value,
        email: form.elements.email.value,
        role: form.elements.role.value,
        password: form.elements.password.value,
      }, form);
    } else if (form.matches("[data-account-update]")) {
      event.preventDefault();
      runAdminAction("update", {
        user_id: form.elements.user_id.value,
        display_name: form.elements.display_name.value,
        email: form.elements.email.value,
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
  window.atlasOpenDashboard = openDashboard;
})();
