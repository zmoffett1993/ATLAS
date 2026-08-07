(() => {
  "use strict";

  const API_URL = "https://dwrrbpiprcmajfyronlf.supabase.co";
  const PUBLIC_KEY = "sb_publishable_akr0opK3RV0Mg5CQpF2woQ_hBFyRIJa";
  const SESSION_KEY = "atlas-dashboard-session-v1";
  const state = {
    mounted: false,
    open: false,
    loading: false,
    range: "30",
    filter: "operational",
    search: "",
    skus: [],
    locations: [],
    profiles: [],
    activities: [],
    history: [],
    normalized: [],
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
    if (action.includes("SKU_DELETE"))
      return { key: "delete", label: "Removed SKU", color: "#d33a3a", operational: true };
    if (action.includes("PICK_FIRST") || pickChanged)
      return {
        key: "pick",
        label: bool(newRecord.pick_first) ? "Enabled Pick First" : "Disabled Pick First",
        color: "#7957d5",
        operational: action.includes("PICK_FIRST"),
      };
    if (action.includes("LOCATION_CLEAR") || (activeChanged && !bool(newRecord.is_active)))
      return { key: "location", label: "Cleared location", color: "#d33a3a", operational: action.includes("LOCATION_CLEAR") };
    if (action.includes("LOCATION_RESTORE") || (activeChanged && bool(newRecord.is_active)))
      return { key: "location", label: "Restored location", color: "#168552", operational: action.includes("LOCATION_RESTORE") };
    if (action.includes("CORRECT") || reasonText.includes("different location"))
      return { key: "location", label: "Corrected location", color: "#d98900", operational: true };
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
    if (meta.key === "delete") detail = "Marked inactive; history retained";
    if (meta.key === "pick") detail = location !== "—" ? `Location ${location}` : meta.label;

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
      ]);
      state.activities = protectedResults[0].status === "fulfilled" ? protectedResults[0].value : [];
      state.history = protectedResults[1].status === "fulfilled" ? protectedResults[1].value : [];
      state.profiles = protectedResults[2].status === "fulfilled" ? protectedResults[2].value : [];

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
      state.lastSync = new Date();
    } catch (error) {
      if ([401, 403].includes(error?.status) && !token) state.accessRequired = true;
      else state.error = error instanceof Error ? error.message : "The dashboard data could not be loaded.";
    } finally {
      state.loading = false;
      render();
    }
  };

  const rowsInRange = () => {
    const now = Date.now();
    const days = Number(state.range);
    const cutoff = Number.isFinite(days) && days > 0 ? now - days * 86400000 : 0;
    return state.normalized.filter((row) => !cutoff || row.timestamp >= cutoff);
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
      <div class="atlas-dashboard-access-mark">A</div>
      <p class="atlas-dashboard-eyebrow">AUTHORIZED ACCESS</p>
      <h2>Supervisor sign in</h2>
      <p>Operational history includes employee names and detailed inventory changes. Sign in with an ATLAS supervisor or administrator account to continue.</p>
      <form class="atlas-dashboard-access-form" data-sign-in>
        <label><span>Email address</span><input type="email" name="email" autocomplete="username" required></label>
        <label><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
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
      <article class="atlas-dashboard-feed-row" style="--activity-color:${row.color}">
        <span class="atlas-dashboard-activity-dot" aria-hidden="true"></span>
        <span class="atlas-dashboard-feed-primary"><strong>${escapeHtml(row.employee)}</strong><small>${escapeHtml(formatDateTime(row.date, true))}</small></span>
        <span class="atlas-dashboard-feed-detail"><strong class="atlas-dashboard-feed-action">${escapeHtml(row.label)}</strong><small>${escapeHtml(row.sku)}${row.detail && row.detail !== row.label ? ` · ${escapeHtml(row.detail)}` : ""}</small></span>
        <span class="atlas-dashboard-feed-location"><strong>${escapeHtml(row.location)}</strong><small>${escapeHtml(row.rawAction.replaceAll("_", " "))}</small></span>
        <time class="atlas-dashboard-feed-time" datetime="${row.date?.toISOString() || ""}">${escapeHtml(formatDateTime(row.date))}</time>
      </article>`).join("");
  };

  const renderBars = (rows) => {
    const definitions = [
      ["move", "Moves", "#1467dd"],
      ["create", "New SKUs", "#168552"],
      ["edit", "SKU edits", "#d98900"],
      ["pick", "Pick First", "#7957d5"],
      ["location", "Location", "#d33a3a"],
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

  const renderDashboard = () => {
    const rows = visibleRows();
    const operationalRows = rowsInRange().filter((row) => row.operational);
    const visibleOperationalRows = rows.filter((row) => row.operational);
    const activeSkus = state.skus.filter((sku) => sku.active == null || bool(sku.active)).length;
    const today = new Date().toDateString();
    const changesToday = operationalRows.filter((row) => row.date?.toDateString() === today).length;
    const moves = operationalRows.filter((row) => row.key === "move").length;
    const created = operationalRows.filter((row) => row.key === "create").length;
    const rangeLabel = state.range === "all" ? "All recorded history" : `Last ${state.range} days`;
    const sessionName = state.session?.user?.email || "Supervisor";
    return `
      <header class="atlas-dashboard-header">
        <div><p class="atlas-dashboard-eyebrow">ATLAS CONTROL CENTER</p><h1>Operations Dashboard</h1><p class="atlas-dashboard-subtitle">Warehouse activity, inventory changes, and SKU oversight in one clear operational view.</p></div>
        <div class="atlas-dashboard-header-actions">
          <select class="atlas-dashboard-range" data-range aria-label="Dashboard date range">
            <option value="7" ${state.range === "7" ? "selected" : ""}>Last 7 days</option>
            <option value="30" ${state.range === "30" ? "selected" : ""}>Last 30 days</option>
            <option value="90" ${state.range === "90" ? "selected" : ""}>Last 90 days</option>
            <option value="all" ${state.range === "all" ? "selected" : ""}>All history</option>
          </select>
          <button class="atlas-dashboard-button" type="button" data-export>Export CSV</button>
          ${state.session ? `<button class="atlas-dashboard-button" type="button" data-sign-out title="${escapeHtml(sessionName)}">Sign out</button>` : ""}
        </div>
      </header>
      <div class="atlas-dashboard-statusline"><span class="atlas-dashboard-status-dot is-live"></span><span>Live Supabase data · ${escapeHtml(state.lastSync ? `Updated ${formatDateTime(state.lastSync, true)}` : "Ready")}</span></div>
      <section class="atlas-dashboard-summary" aria-label="Operational summary">
        ${renderSummaryCard("Active SKUs", activeSkus, "Current picker inventory", "□", "#1467dd", "#eaf3ff")}
        ${renderSummaryCard("Inventory Moves", moves, rangeLabel, "⇄", "#1467dd", "#eaf3ff")}
        ${renderSummaryCard("New SKUs", created, rangeLabel, "+", "#168552", "#e9f7f0")}
        ${renderSummaryCard("Changes Today", changesToday, "Employee-recorded activity", "✎", "#d98900", "#fff5df")}
      </section>
      <section class="atlas-dashboard-main-grid">
        <article class="atlas-dashboard-panel">
          <header class="atlas-dashboard-panel-head"><div><h2>Activity Timeline</h2><p>${(state.filter === "all" ? rows.length : visibleOperationalRows.length).toLocaleString()} matching records</p></div><div class="atlas-dashboard-tools"><label class="atlas-dashboard-search"><input type="search" data-search value="${escapeHtml(state.search)}" placeholder="Search SKU or employee" aria-label="Search activity"></label><select class="atlas-dashboard-filter" data-filter aria-label="Activity type"><option value="operational" ${state.filter === "operational" ? "selected" : ""}>Operational</option><option value="move" ${state.filter === "move" ? "selected" : ""}>Moves</option><option value="create" ${state.filter === "create" ? "selected" : ""}>New SKUs</option><option value="edit" ${state.filter === "edit" ? "selected" : ""}>SKU edits</option><option value="pick" ${state.filter === "pick" ? "selected" : ""}>Pick First</option><option value="location" ${state.filter === "location" ? "selected" : ""}>Locations</option><option value="all" ${state.filter === "all" ? "selected" : ""}>Full audit</option></select></div></header>
          <div class="atlas-dashboard-feed">${renderFeed(rows)}</div>
        </article>
        <aside class="atlas-dashboard-side">
          <article class="atlas-dashboard-panel"><header class="atlas-dashboard-panel-head"><div><h2>Changes by Type</h2><p>${escapeHtml(rangeLabel)}</p></div></header><div class="atlas-dashboard-bars">${renderBars(operationalRows)}</div></article>
          <article class="atlas-dashboard-panel"><header class="atlas-dashboard-panel-head"><div><h2>Employee Activity</h2><p>Actions recorded by ATLAS</p></div></header><div class="atlas-dashboard-people">${renderPeople(operationalRows)}</div></article>
        </aside>
      </section>`;
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
    const button = event.target.closest("button");
    if (!button) return;
    if (button.matches("[data-mobile-menu]")) showMenu();
    else if (button.matches("[data-mobile-refresh], [data-retry]")) loadData();
    else if (button.matches("[data-export]")) exportCsv();
    else if (button.matches("[data-sign-out]")) signOut();
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
    if (token) api("/auth/v1/logout", { token, method: "POST" }).catch(() => {});
    await loadData();
  };

  const handleSubmit = (event) => {
    if (!event.target.matches("[data-sign-in]")) return;
    event.preventDefault();
    signIn(event.target);
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
