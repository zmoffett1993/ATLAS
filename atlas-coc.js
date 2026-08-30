(function () {
  "use strict";

  const Core = window.AtlasCocCore;
  const Parser = window.AtlasCocParser;
  const Excel = window.AtlasCocExcel;
  const Catalog = window.AtlasCocCaseQuantities;
  const Scanner = window.AtlasCocScannerV3 || window.AtlasCocScannerV2;
  const Storage = window.AtlasCocStorage;
  const Delivery = window.AtlasCocDelivery;
  if (!Core || !Parser || !Excel || !Catalog || !Storage || !Delivery) {
    console.error("ATLAS COC modules did not load.");
    return;
  }

  const ACTIVE_KEY = "atlas-coc-active-v1";
  const DEVICE_KEY = "atlas-coc-device-id-v1";
  const SCANNER_STATES = Object.freeze({
    IDLE: "idle",
    STARTING: "starting",
    READY: "ready",
    PROCESSING: "processing",
    VERIFYING: "verifying",
    REVIEW: "review",
    CONFIRMED: "confirmed",
  });
  let session = null;
  let route = "home";
  let workflowView = "landing";
  let modal = null;
  let toastTimer = null;
  let cloudTimer = null;
  let scannerState = SCANNER_STATES.IDLE;
  let recognitionToken = 0;
  let activeOcrWorker = null;
  let accumulatedDetections = [];
  let recognitionTrace = null;
  let discardReturnModal = null;
  let discardReturnScannerState = SCANNER_STATES.IDLE;
  let storageFailure = false;
  let exportInProgress = false;
  let completedRecords = [];
  let selectedCompleted = null;
  let workbookPreview = { status: "idle", html: "", error: "", cocId: "" };
  let draftWorkbookPreview = { status: "idle", html: "", error: "", cocId: "" };
  let resendInProgress = false;
  let stationPresence = { online: false, reachable: false };
  let sendState = { phase: "ready", error: "", deliveryId: "", sentAt: "", receivedAt: "", officeCompletedAt: "" };
  let resumeRenderToken = 0;
  let cameraStream = null;
  const freshCapture = (failures = 0) => ({
    photo: "", text: "", confidence: null, fieldConfidence: null,
    status: "", progress: 0, failures,
    result: null, barcodes: [], barcodeDetections: [], ocrText: "", sku: "",
  });
  let capture = freshCapture();

  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const plural = (count, word) =>
    `${count} ${word}${count === 1 ? "" : word === "box" ? "es" : "s"}`;
  const positiveWhole = (value) => {
    const text = String(value ?? "").trim();
    if (!/^\d+$/.test(text)) return null;
    const number = Number(text);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  };
  const boxCountError = (value, palletNumber) => {
    const text = String(value ?? "").trim();
    if (!text) return `Enter the total number of boxes on Pallet ${palletNumber}.`;
    if (/^0+$/.test(text)) return "Box count must be greater than 0.";
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)))
      return "Enter a whole number of boxes.";
    return "";
  };
  const formatDate = (value) => {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? "" : date.toLocaleString([], {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    });
  };
  const getEmployee = () => String(localStorage.getItem("atlasEmployee") || "").trim();
  const getEmployeeDisplayName = () => {
    const authSession = window.AtlasAuth?.getSession?.() || Delivery.getAuthSession?.() || null;
    return String(
      window.AtlasAuth?.displayName?.(authSession) ||
      authSession?.user?.user_metadata?.display_name ||
      getEmployee(),
    ).trim();
  };
  const currentUserId = () => Delivery.currentUser()?.id || "";
  const currentSkuContext = () => String(
    document.querySelector(".result-card .sku-copy strong")?.textContent || "",
  ).trim().toUpperCase();
  const activeModelContext = () => String(
    activePallet()?.activeModel || session?.activeModel || session?.sku || currentSkuContext(),
  ).trim().toUpperCase();
  const formatQuantity = (value) => Number(value || 0).toLocaleString("en-US");
  const isWorkflowSection = () => route === "workflows";
  const isInsideCocWorkflow = () => route === "workflows" &&
    (workflowView === "setup" || workflowView === "session");
  const getDeviceId = () => {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = window.crypto?.randomUUID?.() ||
        `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  };

  function readSession() {
    try {
      const raw = localStorage.getItem(ACTIVE_KEY);
      session = raw ? Core.sanitize(JSON.parse(raw)) : null;
    } catch (error) {
      console.error("ATLAS protected an invalid COC draft.", error);
      const broken = localStorage.getItem(ACTIVE_KEY);
      if (broken) localStorage.setItem(`${ACTIVE_KEY}-recovery-${Date.now()}`, broken);
      localStorage.removeItem(ACTIVE_KEY);
      session = null;
    }
  }

  function persist({ cloud = true } = {}) {
    draftWorkbookPreview = { status: "idle", html: "", error: "", cocId: "" };
    if (session) {
      session = Core.sanitize(session);
      session.updatedAt = new Date().toISOString();
      try {
        localStorage.setItem(ACTIVE_KEY, JSON.stringify(session));
        storageFailure = false;
      } catch (error) {
        storageFailure = true;
        modal = "storage-error";
        console.error("ATLAS could not preserve the active COC on this device.", error);
        renderAll();
        return false;
      }
      if (cloud) scheduleCloudSync();
    } else {
      localStorage.removeItem(ACTIVE_KEY);
    }
    renderAll();
    return true;
  }

  function apiConfig() {
    const config = window.atlasSupabaseConfig;
    return config?.url && config?.key ? config : null;
  }

  async function cloudRpc(name, body, { keepalive = false } = {}) {
    const config = apiConfig();
    const accessToken = Delivery.getAuthSession()?.access_token;
    if (!config || !navigator.onLine || !accessToken) return null;
    const response = await fetch(`${config.url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      keepalive,
    });
    if (!response.ok) throw new Error(`COC sync unavailable (${response.status})`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  function scheduleCloudSync() {
    window.clearTimeout(cloudTimer);
    cloudTimer = window.setTimeout(async () => {
      if (!session) return;
      try {
        await cloudRpc("atlas_save_coc_snapshot", { p_session: session });
        document.documentElement.classList.remove("atlas-coc-sync-pending");
        renderAll();
      } catch (error) {
        document.documentElement.classList.add("atlas-coc-sync-pending");
        console.info("COC remains safely stored on this device.", error.message);
        renderAll();
      }
    }, 700);
  }

  async function restoreFromCloud() {
    if (session || !navigator.onLine) return;
    try {
      const remote = await cloudRpc("atlas_get_device_coc", { p_device_id: getDeviceId() });
      if (remote && typeof remote === "object") {
        session = Core.sanitize(remote);
        persist({ cloud: false });
      }
    } catch {
      // The database migration is optional to offline operation; local persistence remains authoritative.
    }
  }

  function showToast(message, tone = "success") {
    if (storageFailure && tone === "success") {
      message = "Count is not safely stored — stop and retry saving";
      tone = "warning";
    }
    if (tone !== "warning") return;
    let node = document.getElementById("atlas-coc-toast");
    if (!node) {
      node = document.createElement("div");
      node.id = "atlas-coc-toast";
      node.setAttribute("role", "status");
      node.setAttribute("aria-live", "polite");
      document.body.appendChild(node);
    }
    node.className = `atlas-coc-toast is-${tone}`;
    node.textContent = message;
    node.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => node.classList.remove("is-visible"), 1600);
  }

  function activePallet() { return session ? Core.activePallet(session) : null; }
  function activeLot() {
    const pallet = activePallet();
    return pallet?.lots.find((lot) => lot.id === pallet.activeLotId) || null;
  }

  const modelKey = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const modelBoxTotal = (pallet, modelNumber) => (pallet?.lots || [])
    .filter((lot) => modelKey(lot.model) === modelKey(modelNumber))
    .reduce((total, lot) => total + Number(lot.cases || 0), 0);
  const lotsForModel = (pallet, modelNumber) => (pallet?.lots || [])
    .filter((lot) => modelKey(lot.model) === modelKey(modelNumber));

  function scrollWorkflowToTop() {
    const reset = () => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      document.querySelector(".atlas-workflows-view")?.scrollTo?.({
        top: 0, left: 0, behavior: "auto",
      });
    };
    reset();
    // iOS can restore the removed modal button's former scroll position on
    // the next paint. Reassert the top after both the DOM and layout settle.
    window.requestAnimationFrame(() => {
      reset();
      window.requestAnimationFrame(reset);
    });
  }

  function navigateWorkflows({ resume = false } = {}) {
    if (resume) {
      cancelScanSession();
      capture = freshCapture();
      modal = null;
    }
    const button = [...document.querySelectorAll(".bottom-nav button, [data-nav]")]
      .find((item) => String(item.dataset?.nav || item.textContent || "").trim().toLowerCase().includes("workflows"));
    button?.click();
    workflowView = resume && session ? "session" : "landing";
    if (resume && session?.status === "report") refreshStationPresence();
    if (resume && session?.status === "active") {
      const pallet = activePallet();
      const progress = pallet ? Core.palletProgress(pallet) : null;
      if (progress?.state === "count_mismatch") modal = { type: "mismatch" };
      if (progress?.state === "verified") modal = { type: "verified" };
    }
    // Changing primary tabs causes React to replace the page subtree. On a
    // resume from Home, the COC render can otherwise happen just before the
    // new Workflows root is mounted, leaving a blank screen. Wait for the
    // actual destination node and render into the node that will remain.
    const token = ++resumeRenderToken;
    const renderWhenReady = (attempt = 0) => {
      if (token !== resumeRenderToken) return;
      if (document.getElementById("atlas-coc-workflows-root")) {
        renderAll();
        window.scrollTo({ top: 0, behavior: "auto" });
        return;
      }
      if (attempt < 30) {
        window.requestAnimationFrame(() => renderWhenReady(attempt + 1));
        return;
      }
      console.error("ATLAS could not mount the Workflows screen for COC resume.");
    };
    renderWhenReady();
  }

  function barMarkup() {
    if (!session || isWorkflowSection()) return "";
    if (session.status === "report") {
      return `<button type="button" class="atlas-coc-active-bar is-complete" data-coc-action="resume">
        <span class="atlas-coc-active-bar__signal" aria-hidden="true">✓</span>
        <span><strong>COC COMPLETE</strong><small>${session.invoiceNumber ? `Invoice ${escapeHtml(session.invoiceNumber)} · ` : ""}Review final report · ${plural(Core.sessionTotal(session), "box")}</small></span>
        <b>OPEN</b>
      </button>`;
    }
    const pallet = activePallet();
    const progress = Core.palletProgress(pallet);
    const countCopy = progress.expected
      ? `${progress.recorded.toLocaleString()} of ${plural(progress.expected, "box")} recorded`
      : "Box count not verified";
    return `<button type="button" class="atlas-coc-active-bar" data-coc-action="resume">
      <span class="atlas-coc-active-bar__signal" aria-hidden="true"></span>
      <span><strong>COC ACTIVE · PALLET ${pallet?.number || 1}</strong><small>${session.invoiceNumber ? `Invoice ${escapeHtml(session.invoiceNumber)} · ` : ""}${countCopy}</small></span>
      <b>RESUME</b>
    </button>`;
  }

  function landingMarkup() {
    const activeCopy = session?.status === "report" ? "Review Report" : "Resume COC";
    return `<div class="atlas-coc-page">
      <header class="atlas-coc-page-head"><span>WORKFLOWS</span><h1>Warehouse Workflows</h1><p>Focused tools for accurate warehouse work.</p></header>
      <section class="atlas-coc-launch-card">
        <div class="atlas-coc-launch-icon" aria-hidden="true">✓</div>
        <div class="atlas-coc-launch-copy"><span>CERTIFICATE OF COMPLIANCE</span><h2>COC</h2>
          <p>Record pallet lot numbers and verify box quantities.</p></div>
        <button type="button" class="atlas-coc-primary" data-coc-action="${session ? "resume" : "start-setup"}">${session ? activeCopy : "Start COC"}<span aria-hidden="true">›</span></button>
        ${session?.status === "active" ? `<small>Your unfinished COC is protected on this device.</small>` : ""}
      </section>
      <button type="button" class="atlas-coc-history-card" data-coc-action="show-completed">
        <span><strong>COMPLETED COCs</strong><small>Reports stored on this device</small></span>
        <span>View completed reports <b aria-hidden="true">›</b></span>
      </button>
      ${Delivery.isSupervisor() ? `<button type="button" class="atlas-coc-history-card" data-coc-action="receiver-setup"><span><strong>OFFICE COC RECEIVER</strong><small>Supervisor setup</small></span><span>Approve a station <b aria-hidden="true">›</b></span></button>` : ""}
    </div>`;
  }

  function historyDateLabel(value) {
    const date = new Date(value);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return "TODAY";
    return date.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" }).toUpperCase();
  }

  function completedListMarkup() {
    const groups = new Map();
    completedRecords.forEach((record) => {
      const label = historyDateLabel(record.completedAt);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(record);
    });
    return `<div class="atlas-coc-page atlas-coc-history"><button type="button" class="atlas-coc-back" data-coc-action="show-landing">‹ Back</button>
      <header class="atlas-coc-page-head"><span>STORED ON THIS DEVICE</span><h1>Completed COCs</h1><p>Read-only reports saved for the signed-in employee on this device.</p></header>
      ${groups.size ? [...groups].map(([label, records]) => `<section><h2>${escapeHtml(label)}</h2>${records.map((record) => `<button type="button" class="atlas-coc-history-row" data-coc-action="open-completed" data-coc-id="${escapeHtml(record.cocId)}"><span><strong>${escapeHtml(record.invoiceNumber)}</strong><b>${escapeHtml(record.customerName)}</b><small>${escapeHtml(record.ifNumber)} · ${plural(record.palletCount, "pallet")} · ${plural(record.totalConfirmedBoxes, "box")}</small><small>Completed ${new Date(record.completedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small></span><i aria-hidden="true">›</i></button>`).join("")}</section>`).join("") : `<div class="atlas-coc-empty-list">No completed COCs are stored for this user on this device.</div>`}
    </div>`;
  }

  function completedPalletSummaryMarkup(snapshot) {
    const pallets = snapshot.pallets || [];
    const multiple = pallets.length > 1;
    return pallets.map((pallet, index) => {
      const lots = Array.isArray(pallet.lots) ? pallet.lots : [];
      const totalBoxes = lots.reduce((sum, lot) => sum + Number(lot.cases || 0), 0);
      const groups = new Map();
      lots.forEach((lot) => {
        const model = String(lot.model || "UNKNOWN SKU");
        if (!groups.has(model)) groups.set(model, []);
        groups.get(model).push(lot);
      });
      const swipeHint = !multiple ? "" : index === 0
        ? "← SWIPE"
        : index === pallets.length - 1
          ? "SWIPE →"
          : "← SWIPE →";
      return `<article class="atlas-coc-pallet-slide" role="group" aria-label="Pallet ${pallet.number} of ${pallets.length}">${swipeHint ? `<div class="atlas-coc-swipe-hint" aria-hidden="true">${swipeHint}</div>` : ""}<section class="atlas-coc-completed-pallet"><header><h2>Pallet ${pallet.number}</h2><b>${plural(totalBoxes, "box")}</b></header>${[...groups].map(([model, modelLots]) => `<div class="atlas-coc-completed-model"><h3>${escapeHtml(model)}</h3>${modelLots.map((lot) => `<div class="atlas-coc-completed-lot"><span><small>LOT</small><strong>${escapeHtml(Core.displayLot(lot.lot))}</strong></span><b>${plural(Number(lot.cases || 0), "box")}</b></div>`).join("")}</div>`).join("")}</section></article>`;
    }).join("");
  }

  function completedOfficialPreviewMarkup() {
    const record = selectedCompleted;
    if (!record) return completedListMarkup();
    const body = workbookPreview.status === "ready" && workbookPreview.cocId === record.cocId
      ? workbookPreview.html
      : workbookPreview.status === "error"
        ? `<div class="atlas-coc-preview-status is-error"><strong>Preview unavailable</strong><p>${escapeHtml(workbookPreview.error)}</p><button type="button" data-coc-action="view-completed-official">Try Again</button></div>`
        : `<div class="atlas-coc-preview-status"><span class="atlas-coc-spinner" aria-hidden="true"></span><strong>Opening the saved Official COC…</strong><p>ATLAS is reading the actual XLSX workbook.</p></div>`;
    return `<div class="atlas-coc-page atlas-coc-history atlas-coc-official-page"><button type="button" class="atlas-coc-back" data-coc-action="close-completed-official">‹ Completed COC</button><header class="atlas-coc-page-head"><span>ACTUAL WORKBOOK</span><h1>Official COC</h1><p>This read-only view is rendered directly from the saved XLSX file.</p></header>${body}</div>`;
  }

  async function openCompletedWorkbookPreview() {
    const record = selectedCompleted;
    if (!record) return;
    const cocId = record.cocId;
    workbookPreview = { status: "loading", html: "", error: "", cocId };
    workflowView = "official-preview";
    renderAll();
    try {
      if (!record.workbookBlob?.size) throw new Error("The saved Official COC workbook is unavailable on this device.");
      const html = await Excel.renderOfficialWorkbookPreview(record.workbookBlob);
      if (selectedCompleted?.cocId !== cocId || workflowView !== "official-preview") return;
      workbookPreview = { status: "ready", html, error: "", cocId };
    } catch (error) {
      workbookPreview = { status: "error", html: "", error: error?.message || "The Official COC could not be opened.", cocId };
    }
    renderAll();
  }

  function draftOfficialPreviewMarkup() {
    const body = draftWorkbookPreview.status === "ready" && draftWorkbookPreview.cocId === session?.id
      ? draftWorkbookPreview.html
      : draftWorkbookPreview.status === "error"
        ? `<div class="atlas-coc-preview-status is-error"><strong>Preview unavailable</strong><p>${escapeHtml(draftWorkbookPreview.error)}</p><button type="button" data-coc-action="view-draft-official">Try Again</button></div>`
        : `<div class="atlas-coc-preview-status"><span class="atlas-coc-spinner" aria-hidden="true"></span><strong>Building the Official COC preview…</strong><p>ATLAS is populating the actual XLSX workbook without sending it.</p></div>`;
    return `<div class="atlas-coc-page atlas-coc-history atlas-coc-official-page"><button type="button" class="atlas-coc-back" data-coc-action="close-draft-official">‹ Final Review</button><header class="atlas-coc-page-head"><span>ACTUAL WORKBOOK · NOT SENT</span><h1>Official COC</h1><p>This read-only preview is rendered from the same XLSX file ATLAS will send to the office.</p></header>${body}</div>`;
  }

  async function openDraftWorkbookPreview() {
    if (!session) return;
    const cocId = session.id;
    draftWorkbookPreview = { status: "loading", html: "", error: "", cocId };
    modal = null;
    workflowView = "draft-official-preview";
    renderAll();
    try {
      const previewSession = session.status === "report"
        ? Core.sanitize(session)
        : Core.completeSession(session);
      const generated = await Excel.generateCompanyCoc(previewSession, {
        saveGeneratedWorkbook: async () => {},
      });
      const html = await Excel.renderOfficialWorkbookPreview(generated.bytes);
      if (session?.id !== cocId || workflowView !== "draft-official-preview") return;
      draftWorkbookPreview = { status: "ready", html, error: "", cocId };
    } catch (error) {
      draftWorkbookPreview = {
        status: "error",
        html: "",
        error: error?.message === "COC_TEMPLATE_SIGNATURE_MISMATCH"
          ? "The official workbook failed its integrity check. Nothing was changed or sent."
          : "The Official COC preview could not be built. Check the connection and try again.",
        cocId,
      };
    }
    renderAll();
  }

  function completedDetailMarkup() {
    const record = selectedCompleted;
    if (!record) return completedListMarkup();
    const snapshot = record.reportSnapshot || {};
    return `<div class="atlas-coc-page atlas-coc-history"><button type="button" class="atlas-coc-back" data-coc-action="show-completed">‹ Completed COCs</button>
      <header class="atlas-coc-page-head"><span>STORED ON THIS DEVICE</span><h1>Completed COC</h1></header>
      <section class="atlas-coc-completed-detail">
        <dl class="atlas-coc-completed-meta"><div class="is-wide"><dt>Customer</dt><dd>${escapeHtml(record.customerName)}</dd></div><div><dt>Invoice</dt><dd>${escapeHtml(record.invoiceNumber)}</dd></div><div><dt>IF Number</dt><dd>${escapeHtml(record.ifNumber)}</dd></div><div class="is-wide"><dt>Completed</dt><dd>${escapeHtml(formatDate(record.completedAt))}</dd></div><div><dt>Pallets</dt><dd>${record.palletCount}</dd></div><div><dt>Boxes</dt><dd>${record.totalConfirmedBoxes}</dd></div></dl>
        <div class="atlas-coc-readonly-pallets ${(snapshot.pallets || []).length > 1 ? "is-carousel" : ""}" ${(snapshot.pallets || []).length > 1 ? 'aria-label="Swipe through pallets"' : ""}>${completedPalletSummaryMarkup(snapshot)}</div>
        <div class="atlas-coc-completed-actions">
          <button type="button" class="atlas-coc-primary" data-coc-action="view-completed-official">View Official COC</button>
          <button type="button" data-coc-action="review-resend-completed" ${record.officeTransferStatus === "OFFICE_COMPLETED" ? "disabled" : ""}>${record.officeTransferStatus === "OFFICE_COMPLETED" ? "Completed by Office" : "Resend to Office"}</button>
        </div>
      </section></div>`;
  }

  function receiverSetupMarkup() {
    return `<div class="atlas-coc-page"><button type="button" class="atlas-coc-back" data-coc-action="show-landing">‹ Back</button><header class="atlas-coc-page-head"><span>SUPERVISOR SETUP</span><h1>Office COC Receiver</h1><p>Open <strong>/coc-receiver/</strong> on the office computer, then approve its six-digit pairing code here.</p></header><form id="atlas-coc-pairing-form" class="atlas-coc-form-card"><label><strong>Pairing Code</strong><input name="pairingCode" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label><p class="atlas-coc-form-error" aria-live="polite"></p><button class="atlas-coc-primary" type="submit">Approve Office COC Station</button></form></div>`;
  }

  function manualCaseQuantityMarkup() {
    return `<div class="atlas-coc-manual-quantity" data-coc-manual-quantity-wrap hidden>
      <label><strong>Units per Box</strong><small>ATLAS does not have a stored CASE QTY for this SKU. Enter the quantity printed on the case or packing information.</small>
        <input name="manualCaseQuantity" data-coc-manual-quantity type="text" inputmode="numeric" pattern="[0-9]*" maxlength="7" autocomplete="off" placeholder="Enter units per box" /></label>
    </div>`;
  }

  function modelFieldMarkup({ removable = false, compact = false } = {}) {
    return `<div class="atlas-coc-model-row">
      <label><strong>Model Number</strong>${compact ? "" : "<small>Colors do not change CASE QTY</small>"}
        <input name="modelNumber" class="atlas-coc-model-search" maxlength="120" autocomplete="off" autocapitalize="characters" placeholder="Start typing the SKU" role="combobox" aria-expanded="false" required /></label>
      <div class="atlas-coc-model-suggestions" role="listbox"></div>
      <p class="atlas-coc-model-result" aria-live="polite">Enter the complete model number on the shipment.</p>
      ${manualCaseQuantityMarkup()}
      ${removable ? `<button type="button" class="atlas-coc-remove-model" data-coc-action="remove-model-row">Remove Model</button>` : ""}
    </div>`;
  }

  function workflowModelRecord(value, manualQuantity = null, { allowManual = true } = {}) {
    const stored = Catalog.recordForSession(value) || Core.modelRecord(session, value);
    if (stored?.caseQuantity) return stored;
    const modelNumber = Catalog.normalize(value);
    const caseQuantity = allowManual ? positiveWhole(manualQuantity) : null;
    if (!modelNumber || !caseQuantity) return null;
    return {
      modelNumber,
      catalogModel: modelNumber,
      caseQuantity,
      sourceRevision: "EMPLOYEE ENTERED FOR THIS COC",
      addedAt: new Date().toISOString(),
    };
  }

  function exactSkuSuggestion(value) {
    const key = Catalog.normalize(value);
    if (!key || typeof Catalog.suggestionList !== "function") return false;
    return Catalog.suggestionList().some((item) => Catalog.normalize(item.modelNumber) === key);
  }

  function manualQuantityControls(input) {
    const scope = input?.closest?.(".atlas-coc-model-row, form");
    return {
      wrap: scope?.querySelector?.("[data-coc-manual-quantity-wrap]") || null,
      input: scope?.querySelector?.("[data-coc-manual-quantity]") || null,
    };
  }

  function revealManualQuantity(form, modelValue) {
    const modelInput = form?.elements?.modelNumber;
    const controls = manualQuantityControls(modelInput);
    if (controls.wrap) controls.wrap.hidden = false;
    const result = form?.querySelector?.(".atlas-coc-model-result");
    if (result) {
      result.classList.remove("is-valid", "is-invalid");
      result.classList.add("is-manual");
      result.textContent = `${Catalog.normalize(modelValue)} needs a case quantity.`;
    }
    controls.input?.focus?.();
  }

  function updateModelInputFeedback(input) {
    const result = input.closest(".atlas-coc-model-row, form")?.querySelector(".atlas-coc-model-result");
    if (!result) return;
    const value = input.value.trim();
    const resolved = Catalog.resolve(value) || Core.modelRecord(session, value);
    const controls = manualQuantityControls(input);
    const needsManual = Boolean(value && !resolved && exactSkuSuggestion(value));
    if (controls.wrap) {
      const modelKeyValue = Catalog.normalize(value);
      if (controls.wrap.dataset.model !== modelKeyValue) {
        if (controls.input) controls.input.value = "";
        controls.wrap.dataset.model = modelKeyValue;
      }
      controls.wrap.hidden = !needsManual;
    }
    result.classList.toggle("is-valid", Boolean(resolved));
    result.classList.toggle("is-manual", needsManual);
    result.classList.toggle("is-invalid", Boolean(value && !resolved && !needsManual));
    result.textContent = resolved
      ? `${resolved.catalogModel || resolved.modelNumber} · ${formatQuantity(resolved.caseQuantity)} units per case`
      : needsManual
        ? "Case quantity not stored — enter the units per box below."
      : value
        ? "Select the complete SKU from the list."
        : "Enter the complete model number on the shipment.";
  }

  function updatePalletSetupButton(form) {
    if (form?.id !== "atlas-coc-expected-form") return;
    const button = form.querySelector("[data-coc-box-confirm]");
    const count = positiveWhole(form.elements.expectedBoxes?.value);
    const modelInput = form.elements.modelNumber;
    const controls = manualQuantityControls(modelInput);
    const modelReady = Core.palletModels(session, activePallet()).length > 0 ||
      Boolean(modelInput && workflowModelRecord(
        modelInput.value,
        controls.input?.value,
        { allowManual: Boolean(controls.wrap && !controls.wrap.hidden) },
      ));
    if (!button) return;
    button.disabled = !count || !modelReady;
    button.textContent = count && modelReady
      ? `Start Pallet ${activePallet()?.number || 1} · ${plural(count, "box")}`
      : `Start Pallet ${activePallet()?.number || 1}`;
  }

  function setupMarkup() {
    return `<div class="atlas-coc-page atlas-coc-setup">
      <button type="button" class="atlas-coc-back" data-coc-action="coc-back">‹ Back</button>
      <header class="atlas-coc-page-head"><span>START COC</span><h1>COC Information</h1><p>Enter the three header fields for the official COC.</p></header>
      <form id="atlas-coc-start-form" class="atlas-coc-form-card atlas-coc-header-form">
        <label><strong>Customer Name</strong>
          <input name="customerName" maxlength="160" autocomplete="organization" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="Enter customer name" required /></label>
        <label><strong>Invoice Number</strong>
          <input name="invoiceNumber" maxlength="80" autocomplete="off" placeholder="Enter invoice number" required /></label>
        <label><strong>IF Number</strong>
          <input name="ifNumber" maxlength="80" autocomplete="off" placeholder="Enter IF number" required /></label>
        <p class="atlas-coc-form-error" aria-live="polite"></p>
        <button type="submit" class="atlas-coc-primary">Continue to Pallet 1</button>
      </form>
    </div>`;
  }

  function completedPallets() {
    return session.pallets.filter(
      (item) => item.status === "locked" && (item.lots.length || Core.palletTotal(item) > 0),
    );
  }

  function discardFooterMarkup() {
    if (!session) return "";
    return `<div class="atlas-coc-discard-zone">
      <button type="button" class="atlas-coc-discard-link" data-coc-action="review-discard">Discard COC</button>
    </div>`;
  }

  function sessionHeaderMarkup(pallet) {
    return `<div class="atlas-coc-session-meta">
      <p class="atlas-coc-session-kicker">CURRENT COC · PALLET ${pallet.number} SETUP</p>
      <span class="atlas-coc-session-customer"><small>CUSTOMER</small><strong>${escapeHtml(session.customerName || "—")}</strong></span>
      <span class="atlas-coc-session-reference"><small>INVOICE</small><strong>${escapeHtml(session.invoiceNumber || "—")}</strong></span>
      <span class="atlas-coc-session-reference"><small>IF NUMBER</small><strong>${escapeHtml(session.ifNumber || "—")}</strong></span>
    </div>`;
  }

  function activeModelMarkup(pallet) {
    const active = Core.modelRecord(session, activeModelContext());
    return `<section class="atlas-coc-model-switcher" aria-label="Active model">
      <div class="atlas-coc-model-summary"><span>ACTIVE MODEL</span>
        <strong>${escapeHtml(active?.modelNumber || "Choose a model")}</strong>
        <small>${active?.caseQuantity ? `${formatQuantity(active.caseQuantity)} units per case` : "Case quantity unavailable"}</small></div>
      <div class="atlas-coc-model-actions"><button type="button" data-coc-action="add-coc-model">+ Add SKU</button>
        <button type="button" data-coc-action="manage-coc-models">Edit / Remove</button></div>
    </section>`;
  }

  function countingModelMarkup(pallet) {
    const models = Core.palletModels(session, pallet);
    const activeModel = activeModelContext();
    return `<section class="atlas-coc-count-models" aria-label="SKUs on Pallet ${pallet.number}">
      <div class="atlas-coc-selector-title"><h2>SKUs ON PALLET</h2>
        <button type="button" class="atlas-coc-selector-add" data-coc-action="add-coc-model">+ SKU</button></div>
      <div class="atlas-coc-model-rail" role="list" aria-label="Select a SKU">${models.map((model) => {
        const selected = modelKey(model.modelNumber) === modelKey(activeModel);
        return `<button type="button" role="listitem" class="atlas-coc-model-chip ${selected ? "is-active" : ""}" data-coc-action="select-coc-model" data-model="${escapeHtml(model.modelNumber)}" aria-pressed="${selected}">
          <strong>${escapeHtml(model.modelNumber)}</strong><span>${plural(modelBoxTotal(pallet, model.modelNumber), "box")}</span></button>`;
      }).join("")}</div>
      <button type="button" class="atlas-coc-manage-models" data-coc-action="manage-coc-models">✎&nbsp; Edit / Remove</button>
    </section>`;
  }

  function countingLotsMarkup(pallet, atLimit) {
    const activeModel = activeModelContext();
    const modelLots = lotsForModel(pallet, activeModel);
    const activeId = pallet.activeLotId;
    let visibleLots = modelLots.slice(0, 7);
    if (activeId && !visibleLots.some((lot) => lot.id === activeId)) {
      const selected = modelLots.find((lot) => lot.id === activeId);
      if (selected) visibleLots = [...visibleLots.slice(0, 6), selected];
    }
    return `<section class="atlas-coc-count-lots" aria-label="Lots for ${escapeHtml(activeModel)}">
      <div class="atlas-coc-selector-title atlas-coc-lots-title"><h2>LOTS FOR ${escapeHtml(activeModel)}</h2></div>
      <div class="atlas-coc-lot-grid" role="list" aria-label="Select a lot">${visibleLots.map((item) => {
        const selected = item.id === activeId;
        return `<button type="button" role="listitem" class="atlas-coc-lot-chip ${selected ? "is-active" : ""}" data-coc-action="select-lot" data-lot-id="${escapeHtml(item.id)}" aria-pressed="${selected}">
          <strong>${escapeHtml(Core.displayLot(item.lot))}</strong><span>· ${item.cases}</span></button>`;
      }).join("")}
        <button type="button" class="atlas-coc-lot-chip atlas-coc-new-lot-chip" data-coc-action="new-lot" ${atLimit ? "disabled" : ""}>+ LOT</button>
      </div>
      ${modelLots.length > 4 ? `<button type="button" class="atlas-coc-view-all-lots" data-coc-action="show-all-lots"><span aria-hidden="true">▦</span> View All ${modelLots.length} Lots</button>` : ""}
    </section>`;
  }

  function countingStatusMarkup(pallet, lot, atLimit) {
    if (!lot) return `<section class="atlas-coc-count-status is-empty">
      <div class="atlas-coc-count-selection"><span>READY TO COUNT</span></div>
      <div class="atlas-coc-lot-count"><strong>0 BOXES</strong><small>0 units</small></div>
    </section>
    <button type="button" class="atlas-coc-add-case" data-coc-action="new-lot" ${atLimit ? "disabled" : ""}>SCAN FIRST LOT</button>`;
    const selectedLotHasHistory = pallet.history.some((entry) => entry.lotId === lot.id);
    return `<section class="atlas-coc-count-status">
      <div class="atlas-coc-count-selection"><span>ACTIVE LOT</span><b>${escapeHtml(Core.displayLot(lot.lot))}</b></div>
      <div class="atlas-coc-lot-count"><strong>${plural(lot.cases, "box").toUpperCase()}</strong><small>${formatQuantity(Core.lotUnitQuantity(lot))} units</small></div>
    </section>
    <button type="button" class="atlas-coc-add-case" data-coc-action="add-case" ${atLimit ? "disabled" : ""}><span aria-hidden="true">+</span> ADD BOX</button>
    <div class="atlas-coc-count-confirmation">
      <button type="button" data-coc-action="undo" ${selectedLotHasHistory ? "" : "disabled"}>− Remove Box</button>
      <button type="button" data-coc-action="edit-lot" data-lot-id="${escapeHtml(lot.id)}">Edit Lot Details</button>
    </div>`;
  }

  function expectedCountMarkup(pallet) {
    const locked = completedPallets().length;
    const recorded = Core.palletTotal(pallet);
    const palletModels = Core.palletModels(session, pallet);
    return `<div class="atlas-coc-page atlas-coc-expected">
      <button type="button" class="atlas-coc-back" data-coc-action="coc-back">‹ Back</button>
      <header class="atlas-coc-page-head"><span>PALLET ${pallet.number} · SETUP</span><h1>Set Up Pallet ${pallet.number}</h1>
        <p>Enter the box count and first model on this pallet.</p></header>
      <form id="atlas-coc-expected-form" class="atlas-coc-form-card atlas-coc-expected-card">
        ${sessionHeaderMarkup(pallet)}
        <label><strong>Total Boxes on Pallet ${pallet.number}</strong>
          <input name="expectedBoxes" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" required autofocus placeholder="Enter box count" aria-describedby="atlas-coc-box-count-error" /></label>
        ${palletModels.length ? activeModelMarkup(pallet) : `<fieldset class="atlas-coc-model-fields atlas-coc-first-model"><legend>First Model on Pallet ${pallet.number}</legend>${modelFieldMarkup({ compact: true })}</fieldset>`}
        ${recorded ? `<p class="atlas-coc-preserved-count"><strong>${plural(recorded, "box")} already recorded</strong><span>Your saved lots are preserved. Confirm the total box count to continue.</span></p>` : ""}
        <p id="atlas-coc-box-count-error" class="atlas-coc-form-error" aria-live="polite"></p>
        <button type="submit" class="atlas-coc-primary" data-coc-box-confirm disabled>Start Pallet ${pallet.number}</button>
      </form>
      ${locked ? `<div class="atlas-coc-finish-actions"><button type="button" class="atlas-coc-complete-link" data-coc-action="review-complete">Complete COC</button></div>` : ""}
      ${discardFooterMarkup()}
    </div>`;
  }

  function countingMarkup() {
    const pallet = activePallet();
    const lot = activeLot();
    if (!pallet) return landingMarkup();
    if (!pallet.expectedBoxes || !Core.palletModels(session, pallet).length) return expectedCountMarkup(pallet);
    const total = Core.palletTotal(pallet);
    const finished = completedPallets();
    const difference = total - pallet.expectedBoxes;
    const atLimit = total >= pallet.expectedBoxes;
    return `<div class="atlas-coc-page atlas-coc-counting">
      <button type="button" class="atlas-coc-back atlas-coc-count-back" data-coc-action="coc-back">‹ Back</button>
      ${pallet.reopenedForEdit ? `<section class="atlas-coc-editing-pallet"><span>EDITING PALLET ${pallet.number}</span><button type="button" data-coc-action="edit-expected">Correct Confirmed Box Count</button></section>` : ""}
      ${countingModelMarkup(pallet)}
      ${difference > 0 ? `<p class="atlas-coc-overage">${plural(difference, "box")} over the confirmed count. Undo a box or correct the count before finishing.</p>` : ""}
      ${countingLotsMarkup(pallet, atLimit)}
      ${countingStatusMarkup(pallet, lot, atLimit)}
      <div class="atlas-coc-finish-actions">
        <button type="button" class="atlas-coc-finish" data-coc-action="review-pallet" ${difference === 0 && total > 0 ? "" : "disabled"}>Verify &amp; Finish Pallet ${pallet.number}</button>
        ${finished.length ? `<button type="button" class="atlas-coc-complete-link" data-coc-action="review-complete">Complete COC</button>` : ""}
      </div>
      ${discardFooterMarkup()}
    </div>`;
  }

  function reportMarkup() {
    const total = Core.sessionTotal(session);
    return `<div class="atlas-coc-page atlas-coc-report">
      <button type="button" class="atlas-coc-back atlas-coc-report-back" data-coc-action="review-complete">‹ Back to Review</button>
      <header class="atlas-coc-transfer-head"><span>COC COMPLETE ✓</span><p>${plural(session.pallets.length, "pallet")} · ${plural(total, "box")}</p></header>
      <section class="atlas-coc-destination"><span>Destination</span><h2>🖥 Office COC Station</h2><p class="${stationPresence.online ? "is-online" : "is-offline"}">● ${stationPresence.online ? "Online" : "Offline"}</p>${stationPresence.online ? "" : `<p>The report will wait securely in the Office COC Inbox.</p>`}<div class="atlas-coc-report-recovery-actions"><button type="button" class="atlas-coc-primary" data-coc-action="send-to-office" ${exportInProgress ? "disabled" : ""}>${exportInProgress ? "PREPARING…" : "SEND TO OFFICE"}</button><button type="button" class="atlas-coc-start-over" data-coc-action="review-discard">Discard This COC &amp; Start Over</button></div></section>
    </div>`;
  }

  function sendStatusMarkup() {
    const phase = sendState.phase;
    if (phase === "preparing" || phase === "sending") return `<div class="atlas-coc-page atlas-coc-send-state"><div class="atlas-coc-spinner" aria-hidden="true"></div><h1>${phase === "preparing" ? "PREPARING REPORT" : "SENDING TO OFFICE"}</h1><p>Keep ATLAS open while the completed COC is securely transferred.</p></div>`;
    if (phase === "received" || phase === "office_completed") return `<div class="atlas-coc-page atlas-coc-send-state"><span class="atlas-coc-success-mark">✓</span><h1>${phase === "office_completed" ? "COMPLETED ✓" : "RECEIVED ✓"}</h1><p>${phase === "office_completed" ? "Office COC Station completed the report." : "Office COC Station received the report."}</p><section><strong>${escapeHtml(session?.invoiceNumber || sendState.invoiceNumber)}</strong><b>${escapeHtml(session?.customerName || sendState.customerName)}</b><small>${plural(session?.pallets?.length || sendState.palletCount, "pallet")} · ${plural(session ? Core.sessionTotal(session) : sendState.totalBoxes, "box")}</small></section><button type="button" class="atlas-coc-primary" data-coc-action="finish-transfer">Done</button></div>`;
    if (phase === "failed") return `<div class="atlas-coc-page atlas-coc-send-state"><h1>SEND NOT COMPLETED</h1><p>${escapeHtml(sendState.error || "The office transfer could not be confirmed. Your completed COC is still open and nothing was lost.")}</p><div class="atlas-coc-send-recovery-actions"><button type="button" class="atlas-coc-primary" data-coc-action="send-to-office">TRY AGAIN</button><button type="button" data-coc-action="return-to-report">Back to Report</button><button type="button" class="atlas-coc-start-over" data-coc-action="review-discard">Discard This COC &amp; Start Over</button></div></div>`;
    return `<div class="atlas-coc-page atlas-coc-send-state"><span class="atlas-coc-success-mark">✓</span><h1>SENT ✓</h1><p>The completed COC was sent to:</p><h2>Office COC Station</h2><p>Waiting for receipt…</p></div>`;
  }

  async function refreshCompletedHistory() {
    completedRecords = currentUserId() ? await Storage.listCompleted(currentUserId()) : [];
    if (workflowView === "history") renderAll();
  }

  async function refreshStationPresence() {
    try {
      const result = await Delivery.stationStatus();
      stationPresence = { online: Boolean(result?.online), reachable: true, ...result };
    } catch {
      stationPresence = { online: false, reachable: navigator.onLine };
    }
    if (session?.status === "report" && workflowView === "session") renderAll();
  }

  async function approvePairingFromLink() {
    const url = new URL(window.location.href);
    const qrToken = url.searchParams.get("cocPair");
    if (!qrToken) return;
    url.searchParams.delete("cocPair");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    if (!Delivery.isSupervisor()) { showToast("A signed-in supervisor must approve this receiver.", "warning"); return; }
    await requestPairingApproval({ qrToken });
  }

  const isReceiverReplacementConflict = (error) =>
    error?.status === 409 || error?.message === "STATION_ALREADY_HAS_ACTIVE_RECEIVER";

  function pairingFailureMessage(error) {
    if (error?.message === "PAIRING_CODE_INVALID_OR_EXPIRED")
      return "That pairing code is invalid or has expired. Create a new code on the office computer.";
    if (error?.message === "SUPERVISOR_REQUIRED")
      return "A signed-in supervisor or administrator must approve this receiver.";
    return error?.message || "The pairing code could not be approved.";
  }

  async function requestPairingApproval(approval, { replaceExisting = false, errorElement = null } = {}) {
    try {
      await Delivery.approvePairing({ ...approval, replaceExisting });
      modal = null;
      workflowView = "landing";
      renderAll();
      showToast(replaceExisting
        ? "Real office computer paired · previous receiver disconnected"
        : "Office COC Station approved");
      return true;
    } catch (error) {
      if (!replaceExisting && isReceiverReplacementConflict(error)) {
        modal = { type: "replace-receiver", approval: { ...approval } };
        renderAll();
        return false;
      }
      const message = pairingFailureMessage(error);
      if (errorElement) errorElement.textContent = message;
      else showToast(message, "warning");
      return false;
    }
  }

  async function pollReceipt(deliveryId, userId) {
    for (let attempt = 0; attempt < 60 && sendState.deliveryId === deliveryId; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 3000));
      try {
        const record = (await Delivery.deliveryStatuses([deliveryId]))[0];
        if (!record) continue;
        await Storage.updateDeliveryStatus(session?.id || sendState.cocId, userId, record);
        if (record.status === "OFFICE_COMPLETED") {
          sendState = { ...sendState, phase: "office_completed", officeCompletedAt: record.office_completed_at };
          renderAll(); return;
        }
        if (record.status === "RECEIVED") {
          sendState = { ...sendState, phase: "received", receivedAt: record.received_at };
          renderAll();
        }
      } catch {}
    }
  }

  async function sendCompletedCoc() {
    if (!session || session.status !== "report" || exportInProgress) return;
    const userId = currentUserId();
    if (!userId) {
      sendState = { phase: "failed", error: "Sign in to ATLAS before sending this compliance report." };
      workflowView = "send-status"; renderAll(); return;
    }
    exportInProgress = true;
    sendState = { phase: "preparing", cocId: session.id, invoiceNumber: session.invoiceNumber, customerName: session.customerName, palletCount: session.pallets.length, totalBoxes: Core.sessionTotal(session) };
    workflowView = "send-status"; renderAll();
    try {
      const generated = await Excel.generateCompanyCoc(session, { saveGeneratedWorkbook: async () => {} });
      const workbookBlob = new Blob([generated.bytes], { type: Delivery.MIME_XLSX });
      const idempotencyKey = `coc:${session.id}:office:${Delivery.STATION_KEY}`;
      await Storage.upsertCompleted({ cocId: session.id, userId, customerName: session.customerName, invoiceNumber: session.invoiceNumber, ifNumber: session.ifNumber, completedAt: session.completedAt, palletCount: session.pallets.length, totalConfirmedBoxes: Core.sessionTotal(session), modelCount: session.models.length, reportSnapshot: session, workbookFileName: generated.fileName, workbookBlob, officeTransferStatus: "WAREHOUSE_COMPLETE" });
      await Storage.putPending({ cocId: session.id, userId, idempotencyKey, reportSnapshot: session, workbookFileName: generated.fileName, workbookBlob });
      sendState = { ...sendState, phase: "sending" }; renderAll();
      const receipt = await Delivery.submitCoc({ cocId: session.id, idempotencyKey, snapshot: session, workbookBytes: generated.bytes, workbookFileName: generated.fileName });
      await Storage.upsertCompleted({ cocId: session.id, userId, customerName: session.customerName, invoiceNumber: session.invoiceNumber, ifNumber: session.ifNumber, completedAt: session.completedAt, palletCount: session.pallets.length, totalConfirmedBoxes: Core.sessionTotal(session), modelCount: session.models.length, reportSnapshot: session, workbookFileName: generated.fileName, workbookBlob, officeTransferStatus: "SENT", officeTransferId: receipt.deliveryId, sentAt: receipt.sentAt });
      await Storage.deletePending(session.id);
      sendState = { ...sendState, phase: "sent", deliveryId: receipt.deliveryId, sentAt: receipt.sentAt };
      localStorage.removeItem(ACTIVE_KEY);
      session = null;
      renderAll();
      pollReceipt(receipt.deliveryId, userId);
    } catch (error) {
      console.error("ATLAS COC office transfer failed.", error);
      sendState = { ...sendState, phase: "failed", error: error?.message === "COC_TEMPLATE_SIGNATURE_MISMATCH" ? "The official workbook failed its integrity check. Nothing was sent." : error?.message === "ATLAS_AUTH_REQUIRED" ? "Sign in to ATLAS before sending this compliance report." : "The office transfer was not accepted. Your completed COC remains open; try again when the phone can reach Supabase." };
      renderAll();
    } finally { exportInProgress = false; }
  }

  async function resendCompletedCoc() {
    const record = selectedCompleted;
    const userId = currentUserId();
    if (!record || resendInProgress) return;
    if (!userId) {
      showToast("Sign in to ATLAS before resending this COC.", "warning");
      return;
    }
    if (!(record.workbookBlob instanceof Blob) || !record.workbookBlob.size) {
      showToast("The saved official workbook is unavailable on this device.", "warning");
      return;
    }
    resendInProgress = true;
    renderAll();
    try {
      const workbookBytes = new Uint8Array(await record.workbookBlob.arrayBuffer());
      const idempotencyKey = `coc:${record.cocId}:office:${Delivery.STATION_KEY}`;
      const receipt = await Delivery.submitCoc({
        cocId: record.cocId,
        idempotencyKey,
        snapshot: record.reportSnapshot,
        workbookBytes,
        workbookFileName: record.workbookFileName,
        forceResend: true,
      });
      await Storage.upsertCompleted({
        ...record,
        officeTransferStatus: "SENT",
        officeTransferId: receipt.deliveryId,
        sentAt: receipt.sentAt,
        receivedAt: null,
        officeCompletedAt: null,
      });
      selectedCompleted = await Storage.getCompleted(record.cocId, userId);
      modal = null;
      showToast("COC resent to Office COC Station");
    } catch (error) {
      console.error("ATLAS COC resend failed.", error);
      const message = error?.message === "COC_ALREADY_COMPLETED_AT_OFFICE"
        ? "This COC is already completed at the office and cannot be resent."
        : error?.message === "ATLAS_AUTH_REQUIRED"
          ? "Sign in to ATLAS before resending this COC."
          : "The resend was not accepted. The saved COC is unchanged; check the connection and try again.";
      showToast(message, "warning");
    } finally {
      resendInProgress = false;
      renderAll();
    }
  }

  function workflowMarkup() {
    if (workflowView === "history") return completedListMarkup();
    if (workflowView === "history-detail") return completedDetailMarkup();
    if (workflowView === "official-preview") return completedOfficialPreviewMarkup();
    if (workflowView === "draft-official-preview") return draftOfficialPreviewMarkup();
    if (workflowView === "receiver-setup") return receiverSetupMarkup();
    if (workflowView === "send-status") return sendStatusMarkup();
    if (workflowView === "setup" && !session) return setupMarkup();
    if (workflowView === "session" && session)
      return session.status === "report" ? reportMarkup() : countingMarkup();
    return landingMarkup();
  }

  function modalShell(content, {
    label = "COC dialog", dismiss = true, className = "", showBack = true, showDiscard = true,
  } = {}) {
    return `<div class="atlas-coc-modal-backdrop ${className}" role="presentation">
      <section class="atlas-coc-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(label)}">
        ${showBack ? `<button type="button" class="atlas-coc-modal-back" data-coc-action="coc-back">‹ Back</button>` : ""}
        ${dismiss ? `<button type="button" class="atlas-coc-modal-x" data-coc-action="close-modal" aria-label="Close">×</button>` : ""}
        ${content}
        ${showDiscard ? discardFooterMarkup() : ""}
      </section></div>`;
  }

  function reviewPalletModal() {
    const pallet = activePallet();
    const progress = Core.palletProgress(pallet);
    return modalShell(`<span class="atlas-coc-eyebrow">REVIEW PALLET ${pallet.number}</span><h2>Verify Pallet ${pallet.number} Box Count</h2>
      <div class="atlas-coc-compare"><div><span>CONFIRMED</span><small>BOX COUNT</small><strong>${progress.expected}</strong></div><div><span>RECORDED</span><small>BOX COUNT</small><strong>${progress.recorded}</strong></div></div>
      <div class="atlas-coc-review-list">${pallet.lots.map((lot) => `<div><span>${escapeHtml(Core.displayLot(lot.lot))}</span><strong>${plural(lot.cases, "box")}</strong></div>`).join("") || `<p>No lots recorded.</p>`}</div>
      <p>The pallet can only be completed when the confirmed and recorded box counts match.</p>
      <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="close-modal">Keep Counting</button><button type="button" class="atlas-coc-primary" data-coc-action="verify-pallet">Verify &amp; Finish</button></div>`, { label: `Review pallet ${pallet.number}` });
  }

  function reviewCompleteModal() {
    const reportMode = session?.status === "report";
    const pallet = activePallet();
    const progress = pallet ? Core.palletProgress(pallet) : null;
    const activeRecorded = pallet ? Core.palletTotal(pallet) : 0;
    const activeHasWork = Boolean(pallet && (activeRecorded > 0 || progress?.expected));
    const activeReady = Boolean(activeHasWork && progress?.verified);
    const completed = session.pallets.filter(
      (item) => (item.status === "locked" || (item.id === pallet?.id && activeReady)) &&
        (item.lots.length || Core.palletTotal(item) > 0),
    );
    const blocked = activeHasWork && !activeReady;
    const total = completed.reduce((sum, item) => sum + Core.palletTotal(item), 0);
    return modalShell(`<span class="atlas-coc-eyebrow">FINAL REVIEW</span><h2>${reportMode ? "Review completed COC" : "Complete this COC?"}</h2>
      <div class="atlas-coc-final-review">${completed.map((item) => `<section><header><strong>Pallet ${item.number}</strong><b>${plural(Core.palletTotal(item), "box")}</b></header>${item.lots.map((lot) => `<div><span>${escapeHtml(Core.displayLot(lot.lot))}</span><strong>${lot.cases}</strong></div>`).join("")}${reportMode ? `<button type="button" class="atlas-coc-review-edit" data-coc-action="review-reopen" data-pallet-id="${escapeHtml(item.id)}">Edit Pallet ${item.number} · SKU, Lots &amp; Boxes</button>` : ""}</section>`).join("")}</div>
      <p class="atlas-coc-final-total"><strong>TOTAL</strong><b>${plural(total, "box")} · ${plural(completed.length, "pallet")}</b></p>
      ${blocked
        ? `<p class="atlas-coc-warning">Pallet ${pallet.number} is not verified. Its confirmed and recorded box counts must match before completing the COC.</p>`
        : pallet && !activeHasWork
          ? `<p>The empty Pallet ${pallet.number} draft will not be included. Only the ${plural(completed.length, "verified pallet")} shown above will appear in the final report.</p>`
          : `<p>This will finalize the COC with the ${plural(completed.length, "verified pallet")} shown above. Your final report will be ready for office completion.</p>`}
      <div class="atlas-coc-modal-actions atlas-coc-final-actions"><button type="button" data-coc-action="view-draft-official" ${blocked || !completed.length ? "disabled" : ""}>View Official COC</button>${reportMode ? `<button type="button" class="atlas-coc-primary" data-coc-action="close-modal">Complete COC</button>` : `<button type="button" class="atlas-coc-primary" data-coc-action="complete-coc" ${blocked || !completed.length ? "disabled" : ""}>Complete COC</button>`}</div>`, { label: "Complete COC review" });
  }

  function mismatchModal() {
    const pallet = activePallet();
    const progress = Core.palletProgress(pallet);
    const difference = progress.difference > 0
      ? `+${progress.difference}`
      : String(progress.difference);
    const confirmedCopy = `${plural(progress.expected, "box")} ${progress.expected === 1 ? "was" : "were"} confirmed at the start of Pallet ${pallet.number}.`;
    const recordedCopy = `${plural(progress.recorded, "box")} ${progress.recorded === 1 ? "has" : "have"} been recorded.`;
    const detail = progress.difference > 0
      ? `${plural(progress.difference, "box")} recorded beyond the confirmed pallet total.`
      : `${plural(Math.abs(progress.difference), "box")} unaccounted for.`;
    return modalShell(`<span class="atlas-coc-eyebrow is-danger">PALLET COUNT MISMATCH</span><h2>Pallet ${pallet.number} cannot be finished</h2>
      <div class="atlas-coc-compare is-mismatch"><div><span>CONFIRMED</span><strong>${progress.expected}</strong></div><div><span>RECORDED</span><strong>${progress.recorded}</strong></div><div><span>DIFFERENCE</span><strong>${difference}</strong></div></div>
      <p class="atlas-coc-warning"><strong>${confirmedCopy}</strong> ${recordedCopy} ${detail}</p>
      <div class="atlas-coc-modal-actions atlas-coc-modal-actions--stack"><button type="button" class="atlas-coc-primary" data-coc-action="review-mismatch">Review Pallet</button><button type="button" data-coc-action="edit-expected">Correct Box Count</button></div>`, {
      label: `Pallet ${pallet.number} box count mismatch`, dismiss: false,
    });
  }

  function editExpectedModal() {
    const pallet = activePallet();
    return modalShell(`<span class="atlas-coc-eyebrow">CORRECT BOX COUNT</span><h2>Pallet ${pallet.number}</h2>
      <p>Correct the confirmed box count only when the original total was recorded incorrectly.</p>
      <form id="atlas-coc-edit-expected-form" class="atlas-coc-manual-form">
        <label><strong>Total Boxes on Pallet ${pallet.number}</strong><input name="expectedBoxes" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" value="${pallet.expectedBoxes}" required /></label>
        <p class="atlas-coc-form-error" aria-live="polite"></p>
        <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="show-mismatch">Cancel</button><button type="submit" class="atlas-coc-primary">Review Change</button></div>
      </form>`, { label: `Correct confirmed box count for pallet ${pallet.number}`, dismiss: false });
  }

  function confirmExpectedChangeModal(change) {
    return modalShell(`<span class="atlas-coc-eyebrow">CONFIRM COUNT CHANGE</span><h2>${change.previous} → ${change.next} boxes</h2>
      <p>Change the confirmed box count for Pallet ${activePallet()?.number}? The recorded boxes and lot details will not change.</p>
      <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="edit-expected">Go Back</button><button type="button" class="atlas-coc-primary" data-coc-action="confirm-expected-change" data-next="${change.next}">Confirm Change</button></div>`, {
      label: "Confirm box count correction", dismiss: false,
    });
  }

  function verifiedModal() {
    const pallet = activePallet();
    const progress = Core.palletProgress(pallet);
    return modalShell(`<span class="atlas-coc-verified-icon" aria-hidden="true">✓</span><span class="atlas-coc-eyebrow is-success">BOX COUNT VERIFIED</span><h2>Pallet ${pallet.number} is complete</h2>
      <div class="atlas-coc-compare is-verified"><div><span>CONFIRMED</span><strong>${progress.expected}</strong></div><div><span>RECORDED</span><strong>${progress.recorded}</strong></div></div>
      <p>${plural(progress.recorded, "box")} ${progress.recorded === 1 ? "is" : "are"} accounted for. Start another pallet or complete this COC with the verified pallets recorded so far.</p>
      <div class="atlas-coc-verified-actions">
        <button type="button" class="atlas-coc-primary atlas-coc-modal-wide" data-coc-action="start-next-pallet">Start Pallet ${pallet.number + 1}</button>
        <button type="button" class="atlas-coc-complete-secondary" data-coc-action="review-complete">Complete COC</button>
      </div>`, {
      label: `Pallet ${pallet.number} verified`, dismiss: false,
    });
  }

  function reopenPalletModal(palletId) {
    const pallet = session?.pallets.find((item) => item.id === palletId);
    if (!pallet) return "";
    return modalShell(`<span class="atlas-coc-eyebrow is-danger">REOPEN PALLET</span><h2>Reopen Pallet ${pallet.number}?</h2>
      <p>You are reopening a completed pallet. You can correct its confirmed box count, SKUs, lot codes, and box quantities. Every quantity must be verified again before the COC can be completed.</p>
      <div class="atlas-coc-compare is-verified"><div><span>CONFIRMED</span><strong>${pallet.expectedBoxes}</strong></div><div><span>RECORDED</span><strong>${Core.palletTotal(pallet)}</strong></div></div>
      <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="close-modal">Keep Locked</button><button type="button" class="atlas-coc-primary" data-coc-action="confirm-reopen" data-pallet-id="${escapeHtml(pallet.id)}">Reopen Pallet</button></div>`, {
      label: `Reopen pallet ${pallet.number}`, dismiss: false,
    });
  }

  function editLotModal(lotId) {
    const pallet = activePallet();
    const lot = pallet?.lots.find((item) => item.id === lotId);
    if (!pallet || !lot) return "";
    const models = Core.palletModels(session, pallet);
    return modalShell(`<span class="atlas-coc-eyebrow">EDIT PALLET ${pallet.number}</span><h2>Edit lot details</h2>
      <p>Correct the SKU, lot code, or number of boxes. Enter 0 boxes to remove this lot from the pallet.</p>
      <form id="atlas-coc-edit-lot-form" class="atlas-coc-manual-form" data-lot-id="${escapeHtml(lot.id)}">
        <label><strong>SKU / Model Number</strong><select name="model" required>${models.map((model) => `<option value="${escapeHtml(model.modelNumber)}" ${modelKey(model.modelNumber) === modelKey(lot.model) ? "selected" : ""}>${escapeHtml(model.modelNumber)}</option>`).join("")}</select></label>
        <label><strong>Lot Code</strong><input name="lotNumber" value="${escapeHtml(Core.displayLot(lot.lot))}" maxlength="120" autocapitalize="characters" autocomplete="off" required /></label>
        <label><strong>Boxes for This Lot</strong><input name="boxes" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" value="${lot.cases}" required /></label>
        <p class="atlas-coc-form-error" aria-live="polite"></p>
        <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="close-modal">Cancel</button><button type="submit" class="atlas-coc-primary">Save Lot Changes</button></div>
      </form>`, { label: `Edit lot on pallet ${pallet.number}` });
  }

  function discardModal() {
    const completedUnsent = session?.status === "report";
    return modalShell(`<span class="atlas-coc-eyebrow is-danger">${completedUnsent ? "COMPLETED COC NOT SENT" : "DISCARD COC"}</span><h2>${completedUnsent ? "Discard this completed COC?" : "Discard COC?"}</h2>
      <p>${completedUnsent ? "This completed COC has not been sent to the office. Discarding it removes the report from this device and cannot be undone." : "This will permanently discard the current COC and all saved pallet progress."}</p>
      <div class="atlas-coc-modal-actions"><button type="button" class="atlas-coc-primary" data-coc-action="keep-coc">${completedUnsent ? "Keep Completed COC" : "Keep COC"}</button><button type="button" class="atlas-coc-danger" data-coc-action="discard-coc">${completedUnsent ? "Discard &amp; Start Over" : "Discard COC"}</button></div>`, {
      label: "Discard COC confirmation", dismiss: false, showBack: false, showDiscard: false,
    });
  }

  function storageErrorModal() {
    return modalShell(`<span class="atlas-coc-eyebrow is-danger">SAVE PROBLEM</span><h2>Stop counting for a moment</h2>
      <p>ATLAS could not preserve the latest COC state on this device. Do not add another box until saving succeeds.</p>
      <div class="atlas-coc-modal-actions"><button type="button" class="atlas-coc-primary" data-coc-action="retry-save">Retry Saving</button></div>`, { label: "COC save problem", dismiss: false });
  }

  function resendCompletedModal() {
    const record = selectedCompleted;
    if (!record) return "";
    return modalShell(`<span class="atlas-coc-eyebrow">RESEND COMPLETED COC</span><h2>${escapeHtml(record.invoiceNumber)}</h2>
      <p>This sends the saved official workbook to the Office COC Station again. It does not rebuild the spreadsheet or delete the existing office record.</p>
      <div class="atlas-coc-final-review"><section><header><strong>${escapeHtml(record.customerName)}</strong><b>${plural(record.palletCount, "pallet")}</b></header><div><span>IF ${escapeHtml(record.ifNumber)}</span><strong>${plural(record.totalConfirmedBoxes, "box")}</strong></div></section></div>
      <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="close-modal" ${resendInProgress ? "disabled" : ""}>Cancel</button><button type="button" class="atlas-coc-primary" data-coc-action="confirm-resend-completed" ${resendInProgress ? "disabled" : ""}>${resendInProgress ? "Resending…" : "Resend to Office"}</button></div>`, {
      label: "Resend completed COC", dismiss: !resendInProgress, showBack: false, showDiscard: false,
    });
  }

  function replaceReceiverModal() {
    return modalShell(`<span class="atlas-coc-eyebrow is-danger">RECEIVER ALREADY PAIRED</span><h2>Replace the current office computer?</h2>
      <p>ATLAS already has an active Office COC Receiver. Replacing it will immediately disconnect that computer and pair the computer showing the new code.</p>
      <p class="atlas-coc-warning"><strong>Your COCs are safe.</strong> This does not delete the Office COC Station, completed spreadsheets, or Dashboard history. Only the old computer's receiver access is revoked.</p>
      <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="cancel-receiver-replacement">Cancel</button><button type="button" class="atlas-coc-primary" data-coc-action="confirm-receiver-replacement">Replace Existing Receiver</button></div>`, {
      label: "Replace existing Office COC Receiver", dismiss: false, showBack: false, showDiscard: false,
    });
  }

  function captureModal() {
    return modalShell(`<span class="atlas-coc-eyebrow">NEW LOT · ${escapeHtml(activeModelContext())}</span><h2>Align the label inside the blue frame</h2>
      <div class="atlas-coc-live-camera"><video id="atlas-coc-live-video" autoplay muted playsinline></video><div id="atlas-coc-roi-guide" aria-hidden="true"></div><p id="atlas-coc-camera-status">Starting camera…</p></div>
      <canvas id="atlas-coc-roi-canvas" hidden></canvas>
      <div class="atlas-coc-modal-actions atlas-coc-scanner-actions"><button type="button" class="atlas-coc-primary" data-coc-action="scan-live-roi">Scan Lot</button><button type="button" class="atlas-coc-manual-lot-button" data-coc-action="manual-lot">Enter Lot Manually</button></div>`, {
      label: "Photograph new lot", className: "atlas-coc-scanner-modal is-capture-first",
    });
  }

  function readingModal() {
    return modalShell(`<span class="atlas-coc-eyebrow">READING LOT</span><h2>Checking barcode and printed fields…</h2>
      ${capture.photo ? `<img class="atlas-coc-photo" src="${capture.photo}" alt="Full-resolution carton label photo" />` : ""}
      <div class="atlas-coc-progress"><i style="width:${capture.progress}%"></i></div><p>${escapeHtml(capture.status || "Preparing image…")}</p>`, {
      label: "Reading captured lot", dismiss: false,
    });
  }

  function confirmLotModal() {
    const result = capture.result || {};
    const verified = result.confidenceState === "verified";
    const barcodeLot = result.barcodeLot || "";
    const printedLot = result.printedLot || "";
    const comparison = barcodeLot && printedLot && !verified
      ? `<div class="atlas-coc-source-compare"><p><span>BARCODE</span><strong>${escapeHtml(barcodeLot)}</strong></p><p><span>PRINTED TEXT</span><strong>${escapeHtml(printedLot)}</strong></p></div>`
      : "";
    const statusCopy = verified
      ? "Barcode and printed text match"
      : capture.text
        ? "Verify every character before confirming"
        : "ATLAS could not isolate a lot—enter it below";
    return modalShell(`<span id="atlas-coc-review-status" class="atlas-coc-read-status ${verified ? "is-match" : "is-review"}"><i aria-hidden="true">${verified ? "✓" : "×"}</i>${escapeHtml(statusCopy)}</span>
      <h2>${verified ? "Lot matched" : "Verify lot"}</h2>
      ${capture.photo ? `<img class="atlas-coc-photo" src="${capture.photo}" alt="Exact blue-frame carton label crop" />` : ""}
      ${comparison}
      <label class="atlas-coc-lot-review"><strong>Lot Number</strong><input id="atlas-coc-lot-review-input" name="reviewLot" value="${escapeHtml(capture.text)}" maxlength="120" autocapitalize="characters" autocomplete="off" placeholder="Enter lot number" autofocus /></label>
      <p class="atlas-coc-review-help">Batch number and lot number are the same. When the read includes the SKU, ATLAS keeps only the code after the final SKU color.</p>
      <p class="atlas-coc-first-case">Confirming this new lot records <strong>Box 1</strong>.</p>
      <div class="atlas-coc-modal-actions atlas-coc-confirm-actions"><button type="button" data-coc-action="rescan-lot">Take New Photo</button><button type="button" class="atlas-coc-primary" data-coc-action="confirm-lot" ${Core.canonicalLot(capture.text) ? "" : "disabled"}>Confirm Lot + Box 1</button></div>`, { label: "Review recognized lot", dismiss: false });
  }

  function manualLotModal() {
    return modalShell(`<span class="atlas-coc-eyebrow">MANUAL LOT ENTRY</span><h2>Enter the lot twice</h2>
      <p>Type the printed lot exactly. Two matching entries prevent accidental characters.</p>
      <form id="atlas-coc-manual-form" class="atlas-coc-manual-form"><label><strong>Lot Number</strong><input name="lot1" maxlength="120" autocapitalize="characters" autocomplete="off" required /></label>
        <label><strong>Re-enter Lot Number</strong><input name="lot2" maxlength="120" autocapitalize="characters" autocomplete="off" required /></label>
        <p class="atlas-coc-form-error" aria-live="polite"></p>
        <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="rescan-lot">Use Camera</button><button type="submit" class="atlas-coc-primary">Confirm Lot + Box 1</button></div></form>`, { label: "Manually enter lot" });
  }

  function addModelModal() {
    return modalShell(`<span class="atlas-coc-eyebrow">ADD SKU</span><h2>Add SKU to this pallet</h2>
      <p>Select or enter the model number. ATLAS applies the stored CASE QTY automatically; if one is unavailable, enter the units per box once for this COC.</p>
      <form id="atlas-coc-add-model-form" class="atlas-coc-manual-form">
        <label><strong>SKU / Model Number</strong><input name="modelNumber" class="atlas-coc-model-search" maxlength="120" autocomplete="off" autocapitalize="characters" placeholder="Type any part of a SKU" role="combobox" aria-expanded="false" aria-controls="atlas-coc-model-suggestions" required /></label>
        <div id="atlas-coc-model-suggestions" class="atlas-coc-model-suggestions" role="listbox"></div>
        <p class="atlas-coc-model-result" aria-live="polite">Enter the complete model number on the shipment.</p>
        ${manualCaseQuantityMarkup()}
        <p class="atlas-coc-form-error" aria-live="polite"></p>
        <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="close-modal">Cancel</button><button type="submit" class="atlas-coc-primary">Add &amp; Select SKU</button></div>
      </form>`, { label: "Add COC SKU" });
  }

  function manageModelsModal() {
    const pallet = activePallet();
    const models = Core.palletModels(session, pallet);
    return modalShell(`<span class="atlas-coc-eyebrow">SKUs ON PALLET ${pallet?.number || 1}</span><h2>Edit or remove a SKU</h2>
      <p>Choose the SKU for the next lot or remove an unused one. A SKU with counted boxes stays protected until those boxes are undone.</p>
      <div class="atlas-coc-model-manager">${models.map((model) => {
        const isActive = model.modelNumber === activeModelContext();
        const count = pallet.lots.filter((lot) => lot.model === model.modelNumber).reduce((total, lot) => total + lot.cases, 0);
        const removable = models.length > 1 && count === 0;
        return `<section class="${isActive ? "is-active" : ""}"><div><strong>${escapeHtml(model.modelNumber)}</strong><small>${formatQuantity(model.caseQuantity)} units per case${isActive ? " · Active" : ""}</small></div>
          ${isActive ? "" : `<button type="button" data-coc-action="select-coc-model" data-model="${escapeHtml(model.modelNumber)}">Use this model</button>`}
          ${removable ? `<button type="button" class="is-remove" data-coc-action="remove-coc-model" data-model="${escapeHtml(model.modelNumber)}">Remove</button>` : count ? `<small class="atlas-coc-model-protected">Undo ${plural(count, "box")} before removing</small>` : ""}
        </section>`;
      }).join("")}</div>`, { label: "Edit or remove pallet SKUs" });
  }

  function allLotsModal() {
    const pallet = activePallet();
    const activeModel = activeModelContext();
    const lots = lotsForModel(pallet, activeModel);
    return modalShell(`<span class="atlas-coc-eyebrow">PALLET ${pallet?.number || 1}</span><h2>All lots for ${escapeHtml(activeModel)}</h2>
      <p>Tap a lot to make it active for box counting.</p>
      <div class="atlas-coc-all-lots-grid">${lots.map((item) => {
        const selected = item.id === pallet?.activeLotId;
        return `<button type="button" class="atlas-coc-lot-chip ${selected ? "is-active" : ""}" data-coc-action="select-lot" data-lot-id="${escapeHtml(item.id)}" aria-pressed="${selected}">
          <strong>${escapeHtml(Core.displayLot(item.lot))}</strong><span>· ${item.cases}</span></button>`;
      }).join("")}</div>
      <button type="button" class="atlas-coc-primary atlas-coc-modal-wide" data-coc-action="new-lot">+ Add New Lot</button>`, { label: `All lots for ${activeModel}` });
  }

  function updateModelSuggestions(input) {
    const target = input.closest("form, .atlas-coc-model-row")?.querySelector(".atlas-coc-model-suggestions") || document.getElementById("atlas-coc-model-suggestions");
    if (!target) return;
    const query = Catalog.normalize(input.value);
    const existing = Core.palletModels(session, activePallet()).map((model) => model.modelNumber);
    const matches = typeof Catalog.suggest === "function"
      ? Catalog.suggest(query, { exclude: existing, limit: 12 })
      : Catalog.list().filter((record) => !existing.some((value) => Catalog.normalize(value) === Catalog.normalize(record.modelNumber)) && query && Catalog.normalize(record.modelNumber).includes(query)).slice(0, 12);
    target.innerHTML = matches.map((record) => `<button type="button" role="option" data-coc-action="select-model-suggestion" data-model="${escapeHtml(record.modelNumber)}"><strong>${escapeHtml(record.modelNumber)}</strong><small>${record.caseQuantity ? `${formatQuantity(record.caseQuantity)} units/case` : "Case quantity not stored"}</small></button>`).join("");
    input.setAttribute("aria-expanded", String(Boolean(matches.length)));
  }

  function duplicateModal(lot) {
    return modalShell(`<span class="atlas-coc-eyebrow">LOT ALREADY EXISTS</span><h2>${escapeHtml(Core.displayLot(lot.lot))}</h2>
      <p>This lot is already on Pallet ${activePallet()?.number}. Use the existing lot instead of creating a duplicate row.</p>
      <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="new-lot">Scan Different Lot</button><button type="button" class="atlas-coc-primary" data-coc-action="use-existing" data-lot-id="${escapeHtml(lot.id)}">Use Existing Lot</button></div>`, { label: "Duplicate lot detected", dismiss: false });
  }

  function similarLotModal(similar) {
    return modalShell(`<span class="atlas-coc-eyebrow is-danger">SIMILAR LOT DETECTED</span><h2>Verify before continuing</h2>
      <div class="atlas-coc-similar"><p><span>NEW LOT</span><strong>${escapeHtml(capture.text)}</strong></p><p><span>EXISTING LOT</span><strong>${escapeHtml(similar.value)}</strong></p></div>
      <p>These are different lot numbers with very similar characters. Compare the printed label carefully.</p>
      <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="rescan-lot">Rescan</button><button type="button" class="atlas-coc-primary" data-coc-action="confirm-similar">Confirm New Lot</button></div>`, { label: "Similar lot detected", dismiss: false });
  }

  function modalMarkup() {
    if (!modal) return "";
    if (modal === "review-pallet") return reviewPalletModal();
    if (modal === "review-complete") return reviewCompleteModal();
    if (modal === "discard") return discardModal();
    if (modal === "capture") return captureModal();
    if (modal === "reading") return readingModal();
    if (modal === "confirm-lot") return confirmLotModal();
    if (modal === "manual-lot") return manualLotModal();
    if (modal === "manage-models") return manageModelsModal();
    if (modal === "add-model") return addModelModal();
    if (modal === "all-lots") return allLotsModal();
    if (modal === "storage-error") return storageErrorModal();
    if (modal === "resend-completed") return resendCompletedModal();
    if (modal?.type === "replace-receiver") return replaceReceiverModal();
    if (modal?.type === "duplicate") return duplicateModal(modal.lot);
    if (modal?.type === "mismatch") return mismatchModal();
    if (modal?.type === "edit-expected") return editExpectedModal();
    if (modal?.type === "confirm-expected-change") return confirmExpectedChangeModal(modal);
    if (modal?.type === "verified") return verifiedModal();
    // Old rejection states from interrupted pre-update sessions are converted
    // into the same editable review screen instead of reviving a blocker.
    if (modal?.type === "scan-mismatch" || modal?.type === "scan-failed") return confirmLotModal();
    if (modal?.type === "similar") return similarLotModal(modal.similar);
    if (modal?.type === "reopen") return reopenPalletModal(modal.palletId);
    if (modal?.type === "edit-lot") return editLotModal(modal.lotId);
    return "";
  }

  function renderAll() {
    document.documentElement.classList.toggle("atlas-coc-work-mode", isWorkflowSection());
    document.documentElement.classList.toggle("atlas-coc-has-active", Boolean(session));
    const bar = document.getElementById("atlas-coc-active-bar-slot");
    if (bar) {
      try {
        bar.innerHTML = barMarkup();
      } catch (error) {
        console.error("ATLAS could not render the active COC shortcut.", error);
        bar.innerHTML = "";
      }
    }
    const home = document.getElementById("atlas-coc-home-slot");
    if (home) home.innerHTML = "";
    const workflows = document.getElementById("atlas-coc-workflows-root");
    let renderError = null;
    if (workflows) {
      try {
        workflows.innerHTML = workflowMarkup();
        window.requestAnimationFrame?.(() => Excel.fitOfficialWorkbookPreviews?.(workflows));
      } catch (error) {
        renderError = error;
        console.error("ATLAS protected a COC that could not be displayed.", error);
        workflows.innerHTML = `<div class="atlas-coc-page atlas-coc-resume-error">
          <span class="atlas-coc-eyebrow is-danger">COC RECOVERY</span>
          <h1>This saved COC could not open</h1>
          <p>Your COC is still saved. Reload ATLAS and try once more. If this is an old test COC you no longer need, you can safely discard it.</p>
          <div class="atlas-coc-recovery-actions">
            <button type="button" class="atlas-coc-primary" data-coc-action="retry-resume">Try Resume Again</button>
            <button type="button" data-coc-action="discard-recovery-coc">Discard Old COC</button>
          </div>
        </div>`;
      }
    }
    let modalRoot = document.getElementById("atlas-coc-modal-root");
    if (!modalRoot) {
      modalRoot = document.createElement("div");
      modalRoot.id = "atlas-coc-modal-root";
      document.body.appendChild(modalRoot);
    }
    if (renderError) {
      modalRoot.innerHTML = "";
      document.documentElement.classList.remove("atlas-coc-modal-open");
      return;
    }
    try {
      modalRoot.innerHTML = modalMarkup();
      document.documentElement.classList.toggle("atlas-coc-modal-open", Boolean(modal));
    } catch (error) {
      console.error("ATLAS could not display the COC dialog.", error);
      modal = null;
      modalRoot.innerHTML = "";
      document.documentElement.classList.remove("atlas-coc-modal-open");
      showToast("The dialog could not open. Your COC is still saved.", "warning");
    }
  }

  function cancelScanSession() {
    recognitionToken += 1;
    const worker = activeOcrWorker;
    activeOcrWorker = null;
    worker?.terminate?.().catch(() => {});
    scannerState = SCANNER_STATES.IDLE;
    accumulatedDetections = [];
    cameraStream?.getTracks?.().forEach((track) => track.stop());
    cameraStream = null;
  }

  async function startLiveCamera() {
    const video = document.getElementById("atlas-coc-live-video");
    const status = document.getElementById("atlas-coc-camera-status");
    if (!video || cameraStream) return;
    if (!navigator.mediaDevices?.getUserMedia) { if (status) status.textContent = "Live camera is unavailable. Enter the lot manually."; return; }
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      video.srcObject = cameraStream;
      await video.play();
      await Scanner.configureTrack?.(cameraStream.getVideoTracks()[0]);
      if (status) status.textContent = "Camera ready — align the label, then tap Scan Lot.";
      scannerState = SCANNER_STATES.READY;
    } catch { if (status) status.textContent = "Camera access is unavailable. Enter the lot manually."; }
  }

  const waitForCaptureFrame = () => new Promise((resolve) => window.setTimeout(resolve, 90));

  async function scanLiveRoi() {
    const video = document.getElementById("atlas-coc-live-video");
    const guide = document.getElementById("atlas-coc-roi-guide");
    const status = document.getElementById("atlas-coc-camera-status");
    const scanButton = document.querySelector('[data-coc-action="scan-live-roi"]');
    if (scanButton) scanButton.disabled = true;
    if (status) status.textContent = "Capturing the clearest label frame…";
    const frames = [];
    for (let index = 0; index < 3; index += 1) {
      const canvas = document.createElement("canvas");
      const roi = Scanner.captureRoi?.(video, guide, canvas);
      if (roi) frames.push(roi);
      if (index < 2) await waitForCaptureFrame();
    }
    if (!frames.length) {
      if (scanButton) scanButton.disabled = false;
      showToast("Camera is not ready yet.", "warning");
      return;
    }
    frames.sort((left, right) =>
      (Scanner.qualityScore?.(right) || 0) - (Scanner.qualityScore?.(left) || 0),
    );
    const clearest = frames[0];
    clearest.toBlob((blob) => {
      if (!blob) {
        if (scanButton) scanButton.disabled = false;
        showToast("The label crop could not be captured.", "warning");
        return;
      }
      cameraStream?.getTracks?.().forEach((track) => track.stop());
      cameraStream = null;
      processCapturedPhoto(blob, { barcodeFrames: frames });
    }, "image/jpeg", 0.96);
  }

  function openCameraReady() {
    const failures = capture.failures;
    cancelScanSession();
    capture = freshCapture(failures);
    capture.sku = activeModelContext();
    scannerState = SCANNER_STATES.READY;
    modal = "capture";
    renderAll();
    window.requestAnimationFrame(startLiveCamera);
  }

  function rememberDetections(detections = []) {
    const merged = [...accumulatedDetections, ...detections];
    accumulatedDetections = [...new Map(merged.map((item) => [
      String(item.value || "").trim().toUpperCase(), item,
    ])).values()].filter((item) => item.value);
    return accumulatedDetections;
  }

  async function processCapturedPhoto(file, { barcodeFrames = [] } = {}) {
    if (!file) return;
    const failures = capture.failures;
    const token = ++recognitionToken;
    scannerState = SCANNER_STATES.PROCESSING;
    modal = "reading";
    capture = { ...freshCapture(failures), sku: activeModelContext(), status: "Loading full-resolution photo…", progress: 2 };
    renderAll();
    try {
      if (!String(file.type || "").startsWith("image/")) throw new Error("Choose or take a photo of the carton label.");
      const canvas = await Scanner.canvasFromImageFile(file, { maximumWidth: 3200 });
      if (token !== recognitionToken || !isInsideCocWorkflow()) return;
      capture.photo = canvas.toDataURL("image/jpeg", 0.9);
      capture.status = "Checking barcode and printed fields…";
      capture.progress = 4;
      recognitionTrace = {
        startedAt: performance.now(),
        capture: canvas.atlasCapture || null,
        qualityScore: Scanner.qualityScore?.(canvas) || null,
        barcode: null,
        ocr: null,
      };
      const decodeSources = barcodeFrames.length ? barcodeFrames : [canvas];
      const barcodeWork = Promise.all(decodeSources.map((source, index) =>
        Scanner.decodeFrame(source, {
          // The clearest frame receives the full enhancement set. The other
          // burst frames add native/original evidence without tripling delay.
          enhanced: index === 0,
          isCancelled: () => token !== recognitionToken || !isInsideCocWorkflow(),
          onTrace: (trace) => {
            if (!recognitionTrace) return;
            recognitionTrace.barcodeFrames = recognitionTrace.barcodeFrames || [];
            recognitionTrace.barcodeFrames[index] = trace;
            if (index === 0) recognitionTrace.barcode = trace;
          },
        }),
      )).then((groups) => groups.flat());
      await runOcr(token, barcodeWork, canvas);
    } catch (error) {
      if (token !== recognitionToken) return;
      capture.status = error instanceof Error ? error.message : "Enter the lot manually.";
      capture.result = {
        status: "confirm", lot: "", candidateLot: "",
        reason: "employee_verification_required", failureCode: "PHOTO_INPUT_FAILED",
        confidenceState: "needs_verification", comparisonStatus: "unread",
        needsEmployeeVerification: true, captureMethod: "manual_review",
        validationMethod: "photo_exception_employee_review",
      };
      capture.text = "";
      scannerState = SCANNER_STATES.REVIEW;
      modal = "confirm-lot";
      renderAll();
    }
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = source;
    });
  }

  async function runOcr(
    expectedToken, barcodeWork = Promise.resolve([]), recognitionCanvas = null,
  ) {
    modal = "reading";
    capture.status = "Preparing the captured label…";
    capture.progress = 5;
    renderAll();
    let worker = null;
    let ocrError = null;
    const readings = [];
    try {
      const tesseract = window.atlasTesseract;
      if (!tesseract?.createWorker) throw new Error("Printed-text recognition is unavailable.");
      let recognitionPass = 0;
      let passCount = 6;
      worker = await tesseract.createWorker("eng", tesseract.OEM.LSTM_ONLY, {
        workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/worker.min.js",
        langPath: "https://tessdata.projectnaptha.com/4.0.0",
        corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@7",
        logger: (message) => {
          if (expectedToken !== recognitionToken || message.status !== "recognizing text") return;
          capture.progress = 10 + Math.round(
            ((recognitionPass + (message.progress || 0)) / Math.max(1, passCount)) * 82,
          );
          if (modal === "reading") renderAll();
        },
      });
      activeOcrWorker = worker;
      await worker.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-./_ ",
        preserve_interword_spaces: "1",
      });
      let sourceCanvas = null;
      if (recognitionCanvas?.width && recognitionCanvas?.height) {
        sourceCanvas = Scanner?.copyCanvas?.(recognitionCanvas) || recognitionCanvas;
      } else {
        const sourceImage = await loadImage(capture.photo);
        sourceCanvas = document.createElement("canvas");
        sourceCanvas.width = sourceImage.naturalWidth || sourceImage.width;
        sourceCanvas.height = sourceImage.naturalHeight || sourceImage.height;
        sourceCanvas.getContext("2d", { willReadFrequently: true }).drawImage(sourceImage, 0, 0);
      }
      if (recognitionTrace) {
        recognitionTrace.ocr = {
          input: {
            width: sourceCanvas.width,
            height: sourceCanvas.height,
            sourceType: recognitionCanvas ? "exact_roi_canvas" : "lossless_roi_image",
          },
          passes: [],
        };
      }
      const passes = Scanner?.buildOcrPasses?.(sourceCanvas) || [
        { id: "original", status: "Reading the complete label…", create: () => sourceCanvas, mode: "sparse" },
        { id: "fields", status: "Finding Model and Batch fields…", create: () => Scanner?.labelFieldsRegion?.(sourceCanvas) || sourceCanvas, mode: "block" },
        { id: "barcode-text", status: "Reading text below the barcode…", create: () => Scanner?.textBand?.(sourceCanvas) || sourceCanvas, mode: "sparse" },
      ];
      passCount = passes.length;
      const ocrOutput = { text: true, blocks: true };
      const fieldConfidenceFor = (result, value) => {
        const target = Parser.canonical(value);
        if (!target) return 0;
        let best = 0;
        const visit = (node) => {
          if (!node || typeof node !== "object") return;
          if (typeof node.text === "string" && Parser.canonical(node.text).includes(target)) {
            const score = Number(node.confidence);
            if (Number.isFinite(score)) best = Math.max(best, score);
          }
          Object.values(node).forEach((child) => {
            if (Array.isArray(child)) child.forEach(visit);
            else if (child && typeof child === "object") visit(child);
          });
        };
        visit(result?.data?.blocks);
        return best;
      };
      for (let passIndex = 0; passIndex < passes.length; passIndex += 1) {
        if (expectedToken !== recognitionToken || !isInsideCocWorkflow()) return;
        const pass = passes[passIndex];
        recognitionPass = passIndex;
        capture.status = pass.status;
        capture.progress = 10 + Math.round((passIndex / passCount) * 82);
        renderAll();
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
        const passSource = typeof pass.create === "function" ? pass.create() : pass.source;
        await worker.setParameters({
          tessedit_pageseg_mode: pass.mode === "line"
            ? (tesseract.PSM?.SINGLE_LINE ?? 7)
            : pass.mode === "block"
              ? (tesseract.PSM?.SINGLE_BLOCK ?? 6)
              : (tesseract.PSM?.SPARSE_TEXT ?? 11),
        });
        const passStartedAt = performance.now();
        const result = await worker.recognize(passSource, {}, ocrOutput);
        if (expectedToken !== recognitionToken || !isInsideCocWorkflow()) return;
        const text = String(result.data.text || "");
        const confidence = Number(result.data.confidence) || 0;
        const fields = Parser.extractLabelFields(text);
        const reading = {
          id: pass.id,
          text,
          confidence,
          fields,
          fieldConfidence: {
            model: fieldConfidenceFor(result, fields.model),
            batch: fieldConfidenceFor(result, fields.batch),
          },
          input: { width: passSource.width || 0, height: passSource.height || 0 },
          durationMs: Math.round(performance.now() - passStartedAt),
        };
        readings.push(reading);
        recognitionTrace?.ocr?.passes?.push({
          id: reading.id,
          mode: pass.mode,
          input: reading.input,
          text: reading.text,
          confidence: reading.confidence,
          fieldConfidence: reading.fieldConfidence,
          durationMs: reading.durationMs,
        });
        // A clear structured label normally needs only the original, field,
        // and barcode-text passes. Difficult labels continue through the
        // sharpened and high-contrast passes without lowering confidence.
        if (readings.length >= 3) {
          const clearStructuredRead = readings.find((reading) =>
            reading.fields.hasStructuredModel && reading.fields.model &&
            reading.fields.batch &&
            Math.max(reading.fieldConfidence.batch, reading.confidence) >= 90,
          );
          if (clearStructuredRead) break;
        }
      }
    } catch (error) {
      ocrError = error;
      if (recognitionTrace) {
        recognitionTrace.ocr = recognitionTrace.ocr || { input: null, passes: [] };
        recognitionTrace.ocr.error = {
          code: String(error?.name || "OCR_EXCEPTION"),
          message: String(error?.message || "Printed-text recognition failed."),
        };
      }
      console.info("Printed-text recognition did not complete; checking barcode evidence.", error);
    } finally {
      await worker?.terminate?.().catch(() => {});
      if (activeOcrWorker === worker) activeOcrWorker = null;
    }

    try {
      const detections = await Promise.resolve(barcodeWork).catch(() => []);
      if (expectedToken !== recognitionToken || !isInsideCocWorkflow()) return;
      rememberDetections(detections);
      capture.barcodes = accumulatedDetections.map((item) => item.value);
      capture.barcodeDetections = [...accumulatedDetections];
      if (ocrError && !capture.barcodes.length) throw ocrError;

      const voteField = (name, structuredFlag) => {
        const structured = readings.filter((reading) => reading.fields[structuredFlag]);
        const pool = structured.length ? structured : readings;
        const groups = new Map();
        pool.forEach((reading) => {
          const value = String(reading.fields[name] || "").trim();
          const key = Parser.canonical(value);
          if (!key) return;
          const fieldScore = Math.max(
            Number(reading.fieldConfidence?.[name]) || 0,
            Number(reading.confidence) || 0,
          );
          const current = groups.get(key) || { value, count: 0, best: 0 };
          current.count += 1;
          current.best = Math.max(current.best, fieldScore);
          if (fieldScore >= current.best) current.value = value;
          groups.set(key, current);
        });
        const ranked = [...groups.values()].sort((left, right) =>
          (right.count * 100 + right.best) - (left.count * 100 + left.best),
        );
        const winner = ranked[0] || { value: "", count: 0, best: 0 };
        const runnerUp = ranked[1];
        return {
          ...winner,
          ambiguous: Boolean(runnerUp && winner.count === runnerUp.count &&
            Math.abs(winner.best - runnerUp.best) < 8),
        };
      };
      const modelVote = voteField("model", "hasStructuredModel");
      const batchVote = voteField("batch", "hasStructuredBatch");
      const hasStructuredModel = readings.some((reading) => reading.fields.hasStructuredModel);
      const hasStructuredBatch = readings.some((reading) => reading.fields.hasStructuredBatch);
      const rawOcr = readings.map((reading) => reading.text).filter(Boolean).join("\n");
      const anchored = [
        hasStructuredModel && modelVote.value ? `MODEL NO.: ${modelVote.value}` : "",
        hasStructuredBatch && batchVote.value ? `BATCH NO.: ${batchVote.value}` : "",
      ].filter(Boolean).join("\n");
      capture.ocrText = rawOcr;
      capture.fieldConfidence = modelVote.value && batchVote.value
        ? Math.min(modelVote.best, batchVote.best)
        : Math.max(modelVote.best, batchVote.best);
      const fieldAmbiguity = modelVote.ambiguous || batchVote.ambiguous;
      if (fieldAmbiguity) capture.fieldConfidence = Math.min(55, capture.fieldConfidence);
      capture.confidence = Math.max(0, ...readings.map((reading) => reading.confidence));
      if (fieldAmbiguity) capture.confidence = Math.min(65, capture.confidence);
      capture.status = "Matching SKU and verifying lot…";
      capture.progress = 96;
      renderAll();
      capture.result = Parser.evaluateCapture({
        barcodes: capture.barcodes,
        ocrText: [anchored, rawOcr].filter(Boolean).join("\n"),
        ocrConfidence: capture.confidence,
        fieldConfidence: capture.fieldConfidence,
        sku: capture.sku,
        barcodeDetections: capture.barcodeDetections,
        ocrReadings: readings,
      });
      const selectedOcr = capture.result?.ocrCandidates?.find((item) => item.strong) ||
        capture.result?.ocrCandidates?.[0] || null;
      const selectedBarcode = capture.result?.barcodeCandidates?.find((item) => item.accepted) || null;
      const completeTrace = {
        title: "ATLAS LOT RECOGNITION TRACE",
        expectedSku: capture.sku,
        capture: recognitionTrace?.capture || null,
        barcode: {
          formatsAttempted: recognitionTrace?.barcode?.formats || {},
          rawCandidates: recognitionTrace?.barcode?.rawCandidates || capture.barcodeDetections,
          selectedCandidate: selectedBarcode?.rawBarcode || "",
          decodeDurationMs: recognitionTrace?.barcode?.durationMs ?? null,
          errors: recognitionTrace?.barcode?.errors || [],
          variants: recognitionTrace?.barcode?.variants || [],
        },
        ocr: {
          input: recognitionTrace?.ocr?.input || null,
          passes: recognitionTrace?.ocr?.passes || readings,
          selectedCandidate: selectedOcr?.rawCandidates?.[0] || batchVote.value || "",
          selectedLot: selectedOcr?.lot || "",
          error: recognitionTrace?.ocr?.error || null,
          durationMs: (recognitionTrace?.ocr?.passes || []).reduce(
            (total, pass) => total + (Number(pass.durationMs) || 0), 0,
          ),
        },
        skuBoundary: Parser.skuBoundarySignatures?.(capture.sku)?.[0] || "",
        parseResults: {
          barcodeCleanLot: selectedBarcode?.lot || "",
          ocrCleanLot: selectedOcr?.lot || "",
        },
        confidenceSignals: {
          barcodeValid: Boolean(selectedBarcode),
          ocrValid: Boolean(selectedOcr?.strong),
          prefixExactMatch: Boolean(selectedBarcode?.parseDetails?.confidenceSignals?.prefixExact ||
            selectedOcr?.prefixExactVotes),
          sourcesAgree: Boolean(selectedBarcode && selectedOcr &&
            Parser.canonical(selectedBarcode.lot) === Parser.canonical(selectedOcr.lot)),
          skuMismatch: capture.result?.failureCode === "SKU_MISMATCH",
          ambiguity: capture.result?.failureCode === "AMBIGUOUS_LOT",
        },
        finalLot: capture.result?.lot || capture.result?.candidateLot || "",
        finalState: capture.result?.confidenceState || "needs_verification",
        failureReason: capture.result?.failureCode || "",
        stageFailures: capture.result?.failureSignals || [],
        totalProcessingTimeMs: recognitionTrace?.startedAt
          ? Math.round(performance.now() - recognitionTrace.startedAt)
          : null,
      };
      if (recognitionTrace) recognitionTrace.complete = completeTrace;
      Scanner?.logRecognitionTrace?.(completeTrace);
      capture.progress = 100;
      capture.text = capture.result.lot || capture.result.candidateLot || "";
      capture.status = capture.result.confidenceState === "verified"
        ? "Barcode and printed text match."
        : "Employee verification required.";
      modal = "confirm-lot";
      scannerState = SCANNER_STATES.REVIEW;
    } catch (error) {
      if (expectedToken !== recognitionToken || !isInsideCocWorkflow()) return;
      capture.status = error instanceof Error ? error.message : "Enter the lot manually.";
      capture.result = {
        status: "confirm",
        reason: "employee_verification_required",
        failureCode: ocrError ? "OCR_EXCEPTION" : "DECODER_EXCEPTION",
        confidenceState: "needs_verification",
        lot: "",
        candidateLot: "",
        comparisonStatus: "unread",
        needsEmployeeVerification: true,
        captureMethod: "manual_review",
        validationMethod: "scanner_exception_employee_review",
      };
      Scanner?.logRecognitionTrace?.({
        title: "ATLAS LOT RECOGNITION TRACE",
        expectedSku: capture.sku,
        capture: recognitionTrace?.capture || null,
        barcode: recognitionTrace?.barcode || null,
        ocr: recognitionTrace?.ocr || null,
        finalLot: "",
        finalState: "needs_verification",
        failureReason: capture.result.failureCode,
        totalProcessingTimeMs: recognitionTrace?.startedAt
          ? Math.round(performance.now() - recognitionTrace.startedAt)
          : null,
      });
      capture.text = "";
      modal = "confirm-lot";
      scannerState = SCANNER_STATES.REVIEW;
    } finally {
      if (expectedToken === recognitionToken && isInsideCocWorkflow()) renderAll();
    }
  }

  function acceptLot(value, options = {}, { skipSimilar = false } = {}) {
    try {
      const canonicalValue = Core.canonicalLot(value);
      const activeModel = activeModelContext();
      const modelKey = Catalog.normalize(activeModel);
      const modelLots = (activePallet()?.lots || []).filter(
        (lot) => Catalog.normalize(lot.model) === modelKey,
      );
      const exact = modelLots.find((lot) => Core.canonicalLot(lot.lot) === canonicalValue);
      if (exact) {
        modal = { type: "duplicate", lot: exact };
        renderAll();
        return;
      }
      const similar = !skipSimilar
        ? Parser.findSimilarLot(value, modelLots)
        : null;
      if (similar) {
        capture.text = Parser.cleanLot(value);
        capture.result = { ...(capture.result || {}), ...options };
        modal = { type: "similar", similar };
        renderAll();
        return;
      }
      const result = Core.addLot(session, value, {
        ...options,
        model: activeModel,
        expectedModel: activeModel,
        sku: activeModel,
      });
      if (result.duplicate) {
        modal = { type: "duplicate", lot: result.duplicate };
        renderAll();
        return;
      }
      session = result.session;
      scannerState = SCANNER_STATES.CONFIRMED;
      modal = null;
      capture = freshCapture();
      cancelScanSession();
      persist();
      navigator.vibrate?.(18);
      showToast("New lot confirmed · Box 1 recorded");
    } catch (error) {
      showToast(error?.code === "APPROVED_BOX_COUNT_REACHED"
        ? error.message
        : error?.message === "MODEL_CASE_QUANTITY_REQUIRED"
          ? "Select a model with a stored case quantity first."
          : "Enter a valid lot number.", "warning");
    }
  }

  function backWithinCoc() {
    cancelScanSession();
    capture = freshCapture();
    if (modal) {
      modal = null;
      renderAll();
      return;
    }
    workflowView = "landing";
    renderAll();
  }

  function restoreAfterDiscardReview() {
    const previousModal = discardReturnModal;
    const previousScannerState = discardReturnScannerState;
    discardReturnModal = null;
    discardReturnScannerState = SCANNER_STATES.IDLE;
    if ((previousModal === "capture" && (
      previousScannerState === SCANNER_STATES.STARTING ||
      previousScannerState === SCANNER_STATES.READY
    )) || previousModal === "reading") {
      openCameraReady();
      return;
    }
    modal = previousModal;
    scannerState = previousModal === "confirm-lot" ||
      previousModal?.type === "scan-failed" || previousModal?.type === "scan-mismatch"
      ? SCANNER_STATES.REVIEW
      : SCANNER_STATES.IDLE;
    renderAll();
  }

  function discardActiveCoc() {
    const wasCompleted = session?.status === "report";
    const id = session?.id;
    const deviceId = session?.deviceId;
    cancelScanSession();
    capture = freshCapture();
    discardReturnModal = null;
    discardReturnScannerState = SCANNER_STATES.IDLE;
    session = null;
    modal = null;
    workflowView = "landing";
    sendState = { phase: "ready" };
    persist({ cloud: false });
    cloudRpc("atlas_close_coc_session", {
      p_session_id: id,
      p_device_id: deviceId,
    }, { keepalive: true }).catch(() => {});
    showToast(wasCompleted ? "Completed COC discarded · ready to start over" : "Unfinished COC discarded", "info");
  }

  async function handleAction(button) {
    const action = button.dataset.cocAction;
    if (!action) return;
    if (action === "show-landing") {
      cancelScanSession(); capture = freshCapture(); modal = null;
      workflowView = "landing"; renderAll(); return;
    }
    if (action === "coc-back") { backWithinCoc(); return; }
    if (action === "start-setup") { workflowView = "setup"; renderAll(); return; }
    if (action === "show-completed") { workflowView = "history"; selectedCompleted = null; workbookPreview = { status: "idle", html: "", error: "", cocId: "" }; await refreshCompletedHistory(); renderAll(); return; }
    if (action === "open-completed") { selectedCompleted = await Storage.getCompleted(button.dataset.cocId, currentUserId()); workbookPreview = { status: "idle", html: "", error: "", cocId: "" }; workflowView = "history-detail"; renderAll(); return; }
    if (action === "download-completed") { if (selectedCompleted) Storage.downloadBlob(selectedCompleted.workbookBlob, selectedCompleted.workbookFileName); return; }
    if (action === "view-completed-official") { await openCompletedWorkbookPreview(); return; }
    if (action === "close-completed-official") { workflowView = "history-detail"; renderAll(); return; }
    if (action === "view-draft-official") { await openDraftWorkbookPreview(); return; }
    if (action === "close-draft-official") { workflowView = "session"; modal = "review-complete"; renderAll(); return; }
    if (action === "review-resend-completed") { modal = "resend-completed"; renderAll(); return; }
    if (action === "confirm-resend-completed") { await resendCompletedCoc(); return; }
    if (action === "receiver-setup") { workflowView = "receiver-setup"; renderAll(); return; }
    if (action === "cancel-receiver-replacement") { modal = null; renderAll(); return; }
    if (action === "confirm-receiver-replacement") {
      const approval = modal?.type === "replace-receiver" ? modal.approval : null;
      if (!approval?.pairingCode && !approval?.qrToken) {
        modal = null;
        renderAll();
        showToast("Create a new pairing code on the office computer.", "warning");
        return;
      }
      button.disabled = true;
      button.textContent = "Replacing…";
      await requestPairingApproval(approval, { replaceExisting: true });
      return;
    }
    if (action === "resume") { navigateWorkflows({ resume: true }); return; }
    if (action === "retry-resume") {
      readSession();
      navigateWorkflows({ resume: true });
      return;
    }
    if (action === "discard-recovery-coc") {
      discardActiveCoc();
      return;
    }
    if (action === "close-modal") { cancelScanSession(); modal = null; renderAll(); return; }
    if (action === "add-model-row") {
      button.insertAdjacentHTML("beforebegin", modelFieldMarkup({ removable: true }));
      button.previousElementSibling?.querySelector("input")?.focus();
      return;
    }
    if (action === "remove-model-row") {
      button.closest(".atlas-coc-model-row")?.remove();
      return;
    }
    if (action === "add-coc-model") { modal = "add-model"; renderAll(); return; }
    if (action === "manage-coc-models") { modal = "manage-models"; renderAll(); return; }
    if (action === "show-all-lots") { modal = "all-lots"; renderAll(); return; }
    if (action === "select-coc-model") {
      try {
        session = Core.selectModel(session, button.dataset.model);
        modal = null;
        persist();
        showToast(`Active model · ${session.activeModel}`);
      } catch {
        showToast("That model could not be selected.", "warning");
      }
      return;
    }
    if (action === "remove-coc-model") {
      try {
        session = Core.removeModel(session, button.dataset.model);
        persist();
        modal = "manage-models";
        renderAll();
        showToast("Model removed from this pallet.");
      } catch (error) {
        showToast(error?.code === "MODEL_HAS_RECORDED_LOTS"
          ? "Undo the boxes recorded under this model before removing it."
          : "Keep at least one model on a pallet.", "warning");
      }
      return;
    }
    if (action === "select-model-suggestion") {
      const form = button.closest("form"); const input = form?.elements?.modelNumber;
      if (input) {
        input.value = button.dataset.model || "";
        updateModelInputFeedback(input);
        updatePalletSetupButton(input.closest("form"));
        const suggestions = input.closest("form, .atlas-coc-model-row")?.querySelector(".atlas-coc-model-suggestions");
        if (suggestions) suggestions.innerHTML = "";
        input.setAttribute("aria-expanded", "false");
        const controls = manualQuantityControls(input);
        if (controls.wrap && !controls.wrap.hidden) controls.input?.focus?.();
        else input.focus();
      }
      return;
    }
    if (action === "review-mismatch") { modal = null; renderAll(); return; }
    if (action === "edit-expected") { modal = { type: "edit-expected" }; renderAll(); return; }
    if (action === "show-mismatch") { modal = { type: "mismatch" }; renderAll(); return; }
    if (action === "new-lot") {
      const pallet = activePallet();
      if (pallet && Core.palletTotal(pallet) >= pallet.expectedBoxes) { showToast(Core.boxLimitMessage(pallet), "warning"); return; }
      capture = freshCapture(); openCameraReady(); return;
    }
    if (action === "rescan-lot") { openCameraReady(); return; }
    if (action === "scan-live-roi") { scanLiveRoi(); return; }
    if (action === "manual-lot") { cancelScanSession(); modal = "manual-lot"; renderAll(); return; }
    if (action === "confirm-lot") {
      const reviewInput = document.getElementById("atlas-coc-lot-review-input");
      if (reviewInput) capture.text = String(reviewInput.value || "").trim().toUpperCase();
      if (!Core.canonicalLot(capture.text)) {
        showToast("Enter the lot number before confirming.", "warning");
        reviewInput?.focus();
        return;
      }
      acceptLot(capture.text, {
        rawBarcode: capture.result?.rawBarcode,
        barcodeFormat: capture.result?.barcodeFormat,
        rawBatchText: capture.result?.rawBatchText,
        sku: activeModelContext(),
        model: activeModelContext(),
        detectedModel: capture.result?.model,
        captureMethod: capture.result?.captureMethod,
        validationMethod: capture.result?.validationMethod,
        labelClass: capture.result?.labelClass,
        confidenceState: capture.result?.confidenceState,
        expectedModel: activeModelContext(),
        modelMatchMethod: capture.result?.modelMatchMethod,
        confidence: capture.result?.confidence,
        verification: capture.result?.confidenceState === "verified"
          ? "barcode_ocr_match" : "employee_confirmed",
      });
      return;
    }
    if (action === "confirm-similar") {
      acceptLot(capture.text, {
        rawBarcode: capture.result?.rawBarcode,
        barcodeFormat: capture.result?.barcodeFormat,
        rawBatchText: capture.result?.rawBatchText,
        sku: activeModelContext(),
        model: activeModelContext(),
        detectedModel: capture.result?.model,
        captureMethod: capture.result?.captureMethod,
        validationMethod: `${capture.result?.validationMethod || "manual"}_similar_confirmed`,
        labelClass: capture.result?.labelClass,
        confidenceState: capture.result?.confidenceState,
        expectedModel: activeModelContext(),
        modelMatchMethod: capture.result?.modelMatchMethod,
        confidence: capture.result?.confidence,
        verification: capture.result?.captureMethod === "manual" ? "manual" : "ocr",
      }, { skipSimilar: true });
      return;
    }
    if (action === "use-existing") {
      session = Core.selectLot(session, button.dataset.lotId); modal = null; persist();
      showToast("Existing lot selected"); return;
    }
    if (action === "select-lot") {
      session = Core.selectLot(session, button.dataset.lotId);
      if (modal === "all-lots") modal = null;
      persist();
      showToast("Active lot changed", "info"); return;
    }
    if (action === "add-case") {
      try {
        session = Core.addCase(session);
        persist(); navigator.vibrate?.(14);
        const add = document.querySelector(".atlas-coc-add-case");
        add?.classList.add("is-confirmed");
        window.setTimeout(() => add?.classList.remove("is-confirmed"), 180);
        if (!navigator.onLine) showToast("Box saved on device — connection pending", "info");
      } catch (error) { showToast(error?.code === "APPROVED_BOX_COUNT_REACHED" ? error.message : "Choose or add a lot first.", "warning"); }
      return;
    }
    if (action === "undo") {
      try {
        const selectedLot = activeLot();
        session = Core.undoCase(session, selectedLot?.id);
        persist();
      }
      catch { showToast("There is no box to undo.", "warning"); }
      return;
    }
    if (action === "edit-lot") {
      modal = { type: "edit-lot", lotId: button.dataset.lotId };
      renderAll();
      return;
    }
    if (action === "review-pallet") { modal = "review-pallet"; renderAll(); return; }
    if (action === "review-reopen") {
      modal = { type: "reopen", palletId: button.dataset.palletId };
      renderAll();
      return;
    }
    if (action === "confirm-reopen") {
      try {
        session = Core.reopenPallet(session, button.dataset.palletId);
        modal = null;
        workflowView = "session";
        persist();
        showToast(`Pallet ${activePallet()?.number} reopened · verify all quantities`);
      } catch (error) {
        showToast(error?.message === "ACTIVE_PALLET_IN_PROGRESS"
          ? "Finish the current pallet before reopening another."
          : "That pallet could not be reopened.", "warning");
      }
      return;
    }
    if (action === "verify-pallet") {
      const result = Core.verifyPallet(session);
      session = result.session;
      modal = { type: result.verified ? "verified" : "mismatch" };
      persist();
      return;
    }
    if (action === "confirm-expected-change") {
      try {
        session = Core.setExpectedBoxCount(session, button.dataset.next);
        const result = Core.verifyPallet(session);
        session = result.session;
        modal = { type: result.verified ? "verified" : "mismatch" };
        persist();
      } catch { showToast("Enter a whole number of boxes.", "warning"); }
      return;
    }
    if (action === "start-next-pallet") {
      try {
        const finishedNumber = activePallet()?.number;
        session = Core.finishPallet(session);
        modal = null;
        persist();
        showToast(`Pallet ${finishedNumber} verified and locked`);
      } catch { showToast("The box count must be verified first.", "warning"); }
      return;
    }
    if (action === "review-complete") { modal = "review-complete"; renderAll(); return; }
    if (action === "complete-coc") {
      try { session = Core.completeSession(session); modal = null; workflowView = "session"; persist(); scrollWorkflowToTop(); refreshStationPresence(); showToast("COC complete · ready to send"); }
      catch { showToast("Finish the active pallet first.", "warning"); }
      return;
    }
    if (action === "review-discard") {
      discardReturnModal = modal;
      discardReturnScannerState = scannerState;
      cancelScanSession();
      modal = "discard";
      renderAll();
      return;
    }
    if (action === "keep-coc") { restoreAfterDiscardReview(); return; }
    if (action === "discard-coc") {
      discardActiveCoc();
      return;
    }
    if (action === "send-to-office") { await sendCompletedCoc(); return; }
    if (action === "return-to-report") { workflowView = "session"; sendState = { phase: "ready" }; refreshStationPresence(); renderAll(); scrollWorkflowToTop(); return; }
    if (action === "finish-transfer") { session = null; localStorage.removeItem(ACTIVE_KEY); workflowView = "landing"; sendState = { phase: "ready" }; await refreshCompletedHistory(); renderAll(); return; }
    if (action === "retry-save") {
      if (persist()) { modal = null; renderAll(); showToast("COC saved on this device"); }
      return;
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-coc-action]");
    if (!button) return;
    event.preventDefault();
    handleAction(button);
  });

  document.addEventListener("change", (event) => {
    if (event.target.id === "atlas-coc-active-model") {
      try {
        session = Core.selectModel(session, event.target.value);
        persist();
        showToast(`Active model · ${session.activeModel}`, "info");
      } catch {
        showToast("That model could not be selected.", "warning");
      }
    }
  });

  document.addEventListener("beforeinput", (event) => {
    const input = event.target;
    if (!input?.matches?.(
      "#atlas-coc-expected-form input[name='expectedBoxes'], #atlas-coc-edit-expected-form input[name='expectedBoxes'], [data-coc-manual-quantity]",
    )) return;
    if (event.data && /\D/.test(event.data)) event.preventDefault();
  });

  document.addEventListener("input", (event) => {
    const input = event.target;
    if (input?.matches?.("#atlas-coc-start-form input[name='customerName']")) {
      input.value = input.value.toUpperCase();
      return;
    }
    if (input?.id === "atlas-coc-lot-review-input") {
      input.value = input.value.toUpperCase();
      const next = input.value.trim();
      if (next !== capture.text) {
        capture.text = next;
        capture.result = {
          ...(capture.result || {}),
          lot: next,
          candidateLot: next,
          confidenceState: "needs_verification",
          needsEmployeeVerification: true,
          comparisonStatus: "employee_edited",
          validationMethod: "employee_edited_camera_result",
        };
        const status = document.getElementById("atlas-coc-review-status");
        if (status) {
          status.classList.remove("is-match");
          status.classList.add("is-review");
          status.innerHTML = '<i aria-hidden="true">×</i>Employee-edited value — verify characters';
        }
      }
      const confirm = document.querySelector('[data-coc-action="confirm-lot"]');
      if (confirm) confirm.disabled = !Core.canonicalLot(next);
      return;
    }
    if (input?.matches?.("input[name='modelNumber']")) {
      input.value = input.value.toUpperCase();
      updateModelInputFeedback(input);
      updateModelSuggestions(input);
      updatePalletSetupButton(input.closest("form"));
      return;
    }
    if (input?.matches?.("[data-coc-manual-quantity]")) {
      input.value = input.value.replace(/\D/g, "");
      const form = input.closest("form");
      updatePalletSetupButton(form);
      const error = form?.querySelector?.(".atlas-coc-form-error");
      if (error && positiveWhole(input.value)) error.textContent = "";
      return;
    }
    if (!input?.matches?.("#atlas-coc-expected-form input[name='expectedBoxes']")) return;
    const form = input.closest("form");
    const button = form?.querySelector("[data-coc-box-confirm]");
    const error = form?.querySelector(".atlas-coc-form-error");
    const count = positiveWhole(input.value);
    updatePalletSetupButton(form);
    if (error) error.textContent = input.value ? boxCountError(input.value, activePallet()?.number || 1) : "";
  });

  document.addEventListener("submit", (event) => {
    if (event.target.id === "atlas-coc-pairing-form") {
      event.preventDefault();
      const error = event.target.querySelector(".atlas-coc-form-error");
      const pairingCode = String(new FormData(event.target).get("pairingCode") || "").replace(/\D/g, "");
      if (pairingCode.length !== 6) { error.textContent = "Enter the six-digit code shown on the office receiver."; return; }
      requestPairingApproval({ pairingCode }, { errorElement: error });
      return;
    }
    if (event.target.id === "atlas-coc-start-form") {
      event.preventDefault();
      const data = new FormData(event.target);
      const customerName = String(data.get("customerName") || "").trim().toUpperCase();
      const invoiceNumber = String(data.get("invoiceNumber") || "").trim();
      const ifNumber = String(data.get("ifNumber") || "").trim();
      const error = event.target.querySelector(".atlas-coc-form-error");
      if (!customerName) {
        if (error) error.textContent = "Customer Name is required.";
        return;
      }
      if (!invoiceNumber) {
        if (error) error.textContent = "Invoice Number is required.";
        return;
      }
      if (!ifNumber) {
        if (error) error.textContent = "IF Number is required.";
        return;
      }
      session = Core.createSession({
        customerName,
        invoiceNumber,
        ifNumber,
        deviceId: getDeviceId(),
        employee: getEmployee(),
        employeeDisplayName: getEmployeeDisplayName(),
      });
      workflowView = "session";
      persist();
      showToast("COC started · Pallet 1 ready");
      return;
    }
    if (event.target.id === "atlas-coc-add-model-form") {
      event.preventDefault();
      const data = new FormData(event.target);
      const value = String(data.get("modelNumber") || "").trim();
      const record = workflowModelRecord(value, data.get("manualCaseQuantity"));
      const error = event.target.querySelector(".atlas-coc-form-error");
      if (!record) {
        if (value) revealManualQuantity(event.target, value);
        else event.target.elements.modelNumber?.focus?.();
        if (error) error.textContent = value
          ? "Enter the number of units packed in each box for this SKU."
          : "Enter the complete SKU / Model Number.";
        return;
      }
      try {
        session = Core.addModel(session, record);
        modal = null;
        persist();
        showToast(`Model selected · ${session.activeModel}`);
      } catch {
        if (error) error.textContent = "That model could not be added.";
      }
      return;
    }
    if (event.target.id === "atlas-coc-expected-form") {
      event.preventDefault();
      const data = new FormData(event.target);
      const expected = positiveWhole(data.get("expectedBoxes"));
      const error = event.target.querySelector(".atlas-coc-form-error");
      if (!expected) {
        error.textContent = boxCountError(data.get("expectedBoxes"), activePallet()?.number || 1);
        return;
      }
      try {
        if (!Core.palletModels(session, activePallet()).length) {
          const modelValue = String(data.get("modelNumber") || "").trim();
          const record = workflowModelRecord(modelValue, data.get("manualCaseQuantity"));
          if (!record) {
            if (modelValue) revealManualQuantity(event.target, modelValue);
            else event.target.elements.modelNumber?.focus?.();
            error.textContent = modelValue
              ? "Enter the number of units packed in each box for this SKU."
              : `Enter the first Model Number on Pallet ${activePallet()?.number || 1}.`;
            return;
          }
          session = Core.addModel(session, record);
        }
        session = Core.setExpectedBoxCount(session, expected);
        persist();
        showToast(`Pallet ${activePallet()?.number} ready · ${plural(expected, "box")}`);
      } catch (failure) { error.textContent = failure?.code === "EXPECTED_BOX_COUNT_BELOW_RECORDED" ? failure.message : "The pallet setup could not be saved."; }
      return;
    }
    if (event.target.id === "atlas-coc-edit-expected-form") {
      event.preventDefault();
      const data = new FormData(event.target);
      const next = positiveWhole(data.get("expectedBoxes"));
      const previous = activePallet()?.expectedBoxes;
      const error = event.target.querySelector(".atlas-coc-form-error");
      if (!next) {
        error.textContent = boxCountError(data.get("expectedBoxes"), activePallet()?.number || 1);
        return;
      }
      if (next === previous) {
        error.textContent = "Enter a different confirmed box count.";
        return;
      }
      if (next < Core.palletTotal(activePallet())) { error.textContent = "The approved box count cannot be lower than the boxes already recorded."; return; }
      modal = { type: "confirm-expected-change", previous, next };
      renderAll();
      return;
    }
    if (event.target.id === "atlas-coc-edit-lot-form") {
      event.preventDefault();
      const data = new FormData(event.target);
      const lotId = event.target.dataset.lotId;
      const lotNumber = String(data.get("lotNumber") || "").trim().toUpperCase();
      const boxesRaw = String(data.get("boxes") || "").trim();
      const boxes = /^\d+$/.test(boxesRaw) ? Number(boxesRaw) : NaN;
      const error = event.target.querySelector(".atlas-coc-form-error");
      if (!Core.canonicalLot(lotNumber)) {
        error.textContent = "Enter a valid lot code.";
        return;
      }
      if (!Number.isInteger(boxes) || boxes < 0) {
        error.textContent = "Enter a whole number of boxes, or 0 to remove the lot.";
        return;
      }
      try {
        session = Core.updateLot(session, lotId, {
          lot: lotNumber,
          model: data.get("model"),
          cases: boxes,
        });
        modal = null;
        persist();
        showToast(boxes === 0
          ? "Lot removed from this pallet."
          : "Lot details updated · verify the pallet again");
      } catch (failure) {
        error.textContent = failure?.code === "DUPLICATE_LOT"
          ? "That lot already exists under the selected SKU."
          : failure?.code === "APPROVED_BOX_COUNT_EXCEEDED"
            ? failure.message
            : "The lot changes could not be saved.";
      }
      return;
    }
    if (event.target.id === "atlas-coc-manual-form") {
      event.preventDefault();
      const data = new FormData(event.target);
      const first = String(data.get("lot1") || "").trim();
      const second = String(data.get("lot2") || "").trim();
      const error = event.target.querySelector(".atlas-coc-form-error");
      if (!Core.canonicalLot(first) || first !== second) {
        error.textContent = "Both entries must match exactly.";
        return;
      }
      capture = freshCapture();
      capture.text = first;
      capture.result = {
        lot: first,
        captureMethod: "manual",
        validationMethod: "double_entry",
        confidence: null,
      };
      acceptLot(first, {
        captureMethod: "manual",
        validationMethod: "double_entry",
        verification: "manual",
      });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.target?.matches?.(
      "#atlas-coc-expected-form input[name='expectedBoxes'], #atlas-coc-edit-expected-form input[name='expectedBoxes'], [data-coc-manual-quantity]",
    ) && ["e", "E", "+", "-", ".", ","].includes(event.key)) {
      event.preventDefault();
      return;
    }
    const modalKey = typeof modal === "string" ? modal : modal?.type;
    const protectedModals = [
      "discard", "reading", "confirm-lot", "duplicate", "mismatch",
      "edit-expected", "confirm-expected-change", "verified",
      "similar", "reopen",
    ];
    if (event.key === "Escape" && modal && !protectedModals.includes(modalKey)) {
      cancelScanSession(); modal = null; renderAll();
    }
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== ACTIVE_KEY) return;
    readSession();
    if (!session) workflowView = "landing";
    renderAll();
  });
  window.addEventListener("online", () => scheduleCloudSync());
  window.addEventListener("online", () => Catalog.loadRemote());
  window.addEventListener("atlas:coc-case-quantities-ready", () => {
    const input = document.activeElement;
    if (input?.matches?.("input[name='modelNumber']")) {
      updateModelInputFeedback(input);
      updateModelSuggestions(input);
      updatePalletSetupButton(input.closest("form"));
    }
  });
  window.addEventListener("atlas:coc-case-quantities-ready", () => {
    if (!session || workflowView === "setup") renderAll();
  });
  window.addEventListener("beforeunload", cancelScanSession);

  window.atlasCoc = Object.freeze({
    sync(nextRoute) {
      const destination = nextRoute || route;
      if (isInsideCocWorkflow() && destination !== "workflows") {
        cancelScanSession();
        capture = freshCapture();
        modal = null;
      }
      route = destination;
      renderAll();
    },
    openWorkflows() {
      if (isInsideCocWorkflow()) {
        cancelScanSession();
        capture = freshCapture();
        modal = null;
      }
      route = "workflows";
      workflowView = "landing";
      renderAll();
    },
    resume() { navigateWorkflows({ resume: true }); },
    getState() { return session ? Core.sanitize(session) : null; },
    getScannerState() { return scannerState; },
    getExcelReadiness() { return Excel.mappingReadiness(); },
    buildExcelExportModel() { return Excel.buildExportModel(session, Core); },
  });

  readSession();
  Catalog.loadRemote();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { renderAll(); restoreFromCloud(); approvePairingFromLink(); }, { once: true });
  } else {
    renderAll(); restoreFromCloud(); approvePairingFromLink();
  }
})();
