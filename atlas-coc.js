(function () {
  "use strict";

  const Core = window.AtlasCocCore;
  const Parser = window.AtlasCocParser;
  const Excel = window.AtlasCocExcel;
  const Scanner = window.AtlasCocScannerV2;
  if (!Core || !Parser || !Excel) {
    console.error("ATLAS COC modules did not load.");
    return;
  }

  const ACTIVE_KEY = "atlas-coc-active-v1";
  const ARCHIVE_KEY = "atlas-coc-archive-v1";
  const DEVICE_KEY = "atlas-coc-device-id-v1";
  const MAX_ARCHIVES = 20;
  const SCANNER_STATES = Object.freeze({
    IDLE: "idle",
    STARTING: "starting",
    READY: "ready",
    PROCESSING: "processing",
    VERIFYING: "verifying",
    REVIEW: "review",
    REJECTED: "rejected",
    CONFIRMED: "confirmed",
  });
  let session = null;
  let route = "home";
  let workflowView = "landing";
  let modal = null;
  let toastTimer = null;
  let cloudTimer = null;
  let cameraStream = null;
  let cameraTrack = null;
  let scannerState = SCANNER_STATES.IDLE;
  let recognitionToken = 0;
  let activeOcrWorker = null;
  let cameraStarting = false;
  let scanFinalizing = false;
  let bestFrame = null;
  let bestFrameScore = 0;
  let accumulatedDetections = [];
  let torchEnabled = false;
  let discardReturnModal = null;
  let discardReturnScannerState = SCANNER_STATES.IDLE;
  let storageFailure = false;
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
  const currentSkuContext = () => String(
    document.querySelector(".result-card .sku-copy strong")?.textContent || "",
  ).trim().toUpperCase();
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

  function archiveCurrent() {
    if (!session) return;
    let archives = [];
    try {
      const stored = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "[]");
      if (Array.isArray(stored)) archives = stored;
    } catch {}
    archives.unshift({ ...session, archivedAt: new Date().toISOString() });
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archives.slice(0, MAX_ARCHIVES)));
  }

  function apiConfig() {
    const config = window.atlasSupabaseConfig;
    return config?.url && config?.key ? config : null;
  }

  async function cloudRpc(name, body, { keepalive = false } = {}) {
    const config = apiConfig();
    if (!config || !navigator.onLine) return null;
    const response = await fetch(`${config.url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
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

  function navigateWorkflows({ resume = false } = {}) {
    if (resume) {
      cancelScanSession();
      capture = freshCapture();
      modal = null;
    }
    const button = [...document.querySelectorAll(".bottom-nav button")]
      .find((item) => item.textContent?.toLowerCase().includes("workflows"));
    button?.click();
    workflowView = resume && session ? "session" : "landing";
    if (resume && session?.status === "active") {
      const pallet = activePallet();
      const progress = pallet ? Core.palletProgress(pallet) : null;
      if (progress?.state === "count_mismatch") modal = { type: "mismatch" };
      if (progress?.state === "verified") modal = { type: "verified" };
    }
    window.requestAnimationFrame(() => {
      renderAll();
      window.scrollTo({ top: 0, behavior: "auto" });
    });
  }

  function barMarkup() {
    if (!session || isInsideCocWorkflow()) return "";
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
      ? `${plural(progress.expected, "box")} confirmed`
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
    </div>`;
  }

  function setupMarkup() {
    return `<div class="atlas-coc-page atlas-coc-setup">
      <button type="button" class="atlas-coc-back" data-coc-action="coc-back">‹ Back</button>
      <header class="atlas-coc-page-head"><span>START COC</span><h1>Begin Pallet 1</h1><p>Enter the Invoice Number to begin this COC.</p></header>
      <form id="atlas-coc-start-form" class="atlas-coc-form-card">
        <label><strong>Invoice Number</strong><small>Required</small>
          <input name="invoiceNumber" maxlength="80" autocomplete="off" placeholder="Enter invoice number" required /></label>
        <div class="atlas-coc-zero-preview"><span>PALLET 1</span><strong>0</strong><small>Total Boxes · No Lots Recorded</small></div>
        <p class="atlas-coc-form-error" aria-live="polite"></p>
        <button type="submit" class="atlas-coc-primary">Start Pallet 1</button>
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

  function expectedCountMarkup(pallet) {
    const locked = completedPallets().length;
    const recorded = Core.palletTotal(pallet);
    return `<div class="atlas-coc-page atlas-coc-expected">
      <button type="button" class="atlas-coc-back" data-coc-action="coc-back">‹ Back</button>
      <header class="atlas-coc-page-head"><span>PALLET ${pallet.number} · STEP 1</span><h1>Count &amp; Confirm Boxes</h1>
        <p>Enter total number of boxes on Pallet ${pallet.number}.</p></header>
      <form id="atlas-coc-expected-form" class="atlas-coc-form-card atlas-coc-expected-card">
        ${session.invoiceNumber ? `<p class="atlas-coc-invoice-line"><span>INVOICE</span><strong>${escapeHtml(session.invoiceNumber)}</strong></p>` : ""}
        <label><strong>Total Boxes on Pallet ${pallet.number}</strong>
          <input name="expectedBoxes" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" required autofocus placeholder="Enter box count" aria-describedby="atlas-coc-box-count-error" /></label>
        ${recorded ? `<p class="atlas-coc-preserved-count"><strong>${plural(recorded, "box")} already recorded</strong><span>Your saved lots are preserved. Confirm the total box count to continue.</span></p>` : ""}
        <p id="atlas-coc-box-count-error" class="atlas-coc-form-error" aria-live="polite"></p>
        <button type="submit" class="atlas-coc-primary" data-coc-box-confirm disabled>Confirm Box Count</button>
      </form>
      ${locked ? `<div class="atlas-coc-finish-actions"><button type="button" class="atlas-coc-complete-link" data-coc-action="review-complete">Complete COC</button></div>` : ""}
      ${discardFooterMarkup()}
    </div>`;
  }

  function countingMarkup() {
    const pallet = activePallet();
    const lot = activeLot();
    if (!pallet) return landingMarkup();
    if (!pallet.expectedBoxes) return expectedCountMarkup(pallet);
    const total = Core.palletTotal(pallet);
    const finished = completedPallets();
    const locked = finished.length;
    const difference = total - pallet.expectedBoxes;
    return `<div class="atlas-coc-page atlas-coc-counting">
      <button type="button" class="atlas-coc-back" data-coc-action="coc-back">‹ Back</button>
      <header class="atlas-coc-count-head">
        <div><span>COC${session.invoiceNumber ? ` · INVOICE ${escapeHtml(session.invoiceNumber)}` : ""}</span><h1>Pallet ${pallet.number}</h1><small>${locked ? `${plural(locked, "pallet")} completed · ` : ""}Saved automatically</small></div>
        <div class="atlas-coc-total ${difference > 0 ? "is-over" : ""}"><strong>${total} / ${pallet.expectedBoxes}</strong><span>Recorded / Confirmed Boxes</span></div>
      </header>
      ${difference > 0 ? `<p class="atlas-coc-overage">${plural(difference, "box")} over the confirmed pallet total. Review before finishing.</p>` : ""}
      ${finished.length ? `<section class="atlas-coc-pallet-progress" aria-label="Completed pallets">
        <div class="atlas-coc-section-title"><h2>COC Progress</h2><span>${plural(finished.length, "finished pallet")}</span></div>
        <div>${finished.map((item) => `<button type="button" class="atlas-coc-pallet-chip" data-coc-action="review-reopen" data-pallet-id="${escapeHtml(item.id)}"><span aria-hidden="true">✓</span><div><strong>Pallet ${item.number}</strong><small>${plural(Core.palletTotal(item), "box")} · ${plural(item.lots.length, "lot")} · Verified &amp; Locked</small></div><b>Review</b></button>`).join("")}</div>
      </section>` : ""}
      ${lot ? `<section class="atlas-coc-active-lot">
        <span>ACTIVE LOT</span><h2>${escapeHtml(Core.displayLot(lot.lot))}</h2><strong>${plural(lot.cases, "box")}</strong>
        <button type="button" class="atlas-coc-add-case" data-coc-action="add-case"><span aria-hidden="true">+</span> ADD BOX</button>
      </section>` : `<section class="atlas-coc-no-lot"><span>PALLET ${pallet.number}</span><h2>No Lots Recorded</h2><p>Scan and verify the first lot. The confirmed lot records the first box.</p>
        <button type="button" class="atlas-coc-primary" data-coc-action="new-lot">+ New Lot</button></section>`}
      ${lot ? `<div class="atlas-coc-secondary-actions">
        <button type="button" data-coc-action="new-lot">+ New Lot</button>
        <button type="button" data-coc-action="undo" ${pallet.history.length ? "" : "disabled"}>↶ Undo Last Box</button>
      </div>` : ""}
      <section class="atlas-coc-lots">
        <div class="atlas-coc-section-title"><h2>Lots on This Pallet</h2><span>${plural(pallet.lots.length, "lot")}</span></div>
        ${pallet.lots.length ? `<div class="atlas-coc-lot-list">${pallet.lots.map((item) => `
          <button type="button" class="atlas-coc-lot-row ${item.id === pallet.activeLotId ? "is-active" : ""}" data-coc-action="select-lot" data-lot-id="${escapeHtml(item.id)}" aria-pressed="${item.id === pallet.activeLotId}">
            <span><small>${item.id === pallet.activeLotId ? "ACTIVE LOT" : "LOT"}</small><strong>${escapeHtml(Core.displayLot(item.lot))}</strong></span>
            <b>${item.cases}<small> ${item.cases === 1 ? "BOX" : "BOXES"}</small></b>
          </button>`).join("")}</div>` : `<div class="atlas-coc-empty-list">No lots recorded yet.</div>`}
      </section>
      <div class="atlas-coc-finish-actions">
        <button type="button" class="atlas-coc-finish" data-coc-action="review-pallet">Verify &amp; Finish Pallet ${pallet.number}</button>
        ${locked ? `<button type="button" class="atlas-coc-complete-link" data-coc-action="review-complete">Complete COC</button>` : ""}
      </div>
      ${discardFooterMarkup()}
    </div>`;
  }

  function reportMarkup() {
    const total = Core.sessionTotal(session);
    return `<div class="atlas-coc-page atlas-coc-report">
      <button type="button" class="atlas-coc-back" data-coc-action="coc-back">‹ Back</button>
      <header class="atlas-coc-report-head"><span>COC COMPLETE</span><h1>Final Count Report</h1>
        <p>${session.invoiceNumber ? `Invoice <strong>${escapeHtml(session.invoiceNumber)}</strong> · ` : ""}${formatDate(session.completedAt)}</p></header>
      <section class="atlas-coc-report-summary"><div><strong>${session.pallets.length}</strong><span>Pallets</span></div><div><strong>${total}</strong><span>Total Boxes</span></div></section>
      <div class="atlas-coc-report-pallets">${session.pallets.map((pallet) => `
        <section class="atlas-coc-report-pallet"><header><h2>Pallet ${pallet.number}</h2><strong>${plural(Core.palletTotal(pallet), "box")}</strong></header>
          <p class="atlas-coc-report-verification"><span>Confirmed <strong>${pallet.expectedBoxes || "—"}</strong></span><span>Recorded <strong>${Core.palletTotal(pallet)}</strong></span><span class="${Core.palletProgress(pallet).verified ? "is-verified" : "is-unverified"}">${Core.palletProgress(pallet).verified ? "✓ Verified" : "Verification unavailable"}</span></p>
          <div>${pallet.lots.map((lot) => `<div class="atlas-coc-report-row"><span><small>${lot.model ? `MODEL ${escapeHtml(lot.model)} · ` : ""}LOT</small><strong>${escapeHtml(Core.displayLot(lot.lot))}</strong></span><b>${lot.cases}</b></div>`).join("") || `<p>No lots recorded</p>`}</div>
          <button type="button" class="atlas-coc-reopen-report" data-coc-action="review-reopen" data-pallet-id="${escapeHtml(pallet.id)}">Reopen Pallet ${pallet.number}</button>
        </section>`).join("")}</div>
      <div class="atlas-coc-report-actions"><button type="button" data-coc-action="copy-report">Copy Report</button><button type="button" class="atlas-coc-primary" data-coc-action="review-close">Finish &amp; Close COC</button></div>
      <p class="atlas-coc-report-note">Keep this report open while entering the pallet and lot totals into the office system.</p>
      ${discardFooterMarkup()}
    </div>`;
  }

  function workflowMarkup() {
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
    return modalShell(`<span class="atlas-coc-eyebrow">REVIEW PALLET ${pallet.number}</span><h2>Verify this pallet?</h2>
      <div class="atlas-coc-compare"><div><span>CONFIRMED</span><strong>${progress.expected}</strong></div><div><span>RECORDED</span><strong>${progress.recorded}</strong></div></div>
      <div class="atlas-coc-review-list">${pallet.lots.map((lot) => `<div><span>${escapeHtml(Core.displayLot(lot.lot))}</span><strong>${plural(lot.cases, "box")}</strong></div>`).join("") || `<p>No lots recorded.</p>`}</div>
      <p>The pallet can only be completed when the confirmed and recorded box counts match.</p>
      <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="close-modal">Keep Counting</button><button type="button" class="atlas-coc-primary" data-coc-action="verify-pallet">Verify &amp; Finish</button></div>`, { label: `Review pallet ${pallet.number}` });
  }

  function reviewCompleteModal() {
    const pallet = activePallet();
    const unfinished = Core.palletTotal(pallet);
    const completed = session.pallets.filter(
      (item) => item.status === "locked" && (item.lots.length || Core.palletTotal(item) > 0),
    );
    return modalShell(`<span class="atlas-coc-eyebrow">FINAL REVIEW</span><h2>Complete this COC?</h2>
      <div class="atlas-coc-final-review">${completed.map((item) => `<section><header><strong>Pallet ${item.number}</strong><b>${plural(Core.palletTotal(item), "box")}</b></header>${item.lots.map((lot) => `<div><span>${escapeHtml(Core.displayLot(lot.lot))}</span><strong>${lot.cases}</strong></div>`).join("")}</section>`).join("")}</div>
      <p class="atlas-coc-final-total"><strong>TOTAL</strong><b>${plural(completed.reduce((sum, item) => sum + Core.palletTotal(item), 0), "box")} · ${plural(completed.length, "pallet")}</b></p>
      ${unfinished ? `<p class="atlas-coc-warning">Pallet ${pallet.number} contains ${plural(unfinished, "box")}. Finish that pallet before completing the COC.</p>` : `<p>The empty Pallet ${pallet.number} draft will not be included. Your final report will remain open for office entry.</p>`}
      <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="close-modal">Keep COC Open</button><button type="button" class="atlas-coc-primary" data-coc-action="complete-coc" ${unfinished ? "disabled" : ""}>Complete COC</button></div>`, { label: "Complete COC review" });
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
      <p>Correct the confirmed box count only when the original total was entered incorrectly.</p>
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
      <p>${plural(progress.recorded, "box")} ${progress.recorded === 1 ? "is" : "are"} accounted for. This pallet will be locked when you start the next pallet.</p>
      <button type="button" class="atlas-coc-primary atlas-coc-modal-wide" data-coc-action="start-next-pallet">Start Pallet ${pallet.number + 1}</button>`, {
      label: `Pallet ${pallet.number} verified`, dismiss: false,
    });
  }

  function reopenPalletModal(palletId) {
    const pallet = session?.pallets.find((item) => item.id === palletId);
    if (!pallet) return "";
    return modalShell(`<span class="atlas-coc-eyebrow is-danger">REOPEN PALLET</span><h2>Reopen Pallet ${pallet.number}?</h2>
      <p>You are reopening a completed pallet. All quantities must be verified again before it can be completed.</p>
      <div class="atlas-coc-compare is-verified"><div><span>CONFIRMED</span><strong>${pallet.expectedBoxes}</strong></div><div><span>RECORDED</span><strong>${Core.palletTotal(pallet)}</strong></div></div>
      <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="close-modal">Keep Locked</button><button type="button" class="atlas-coc-primary" data-coc-action="confirm-reopen" data-pallet-id="${escapeHtml(pallet.id)}">Reopen Pallet</button></div>`, {
      label: `Reopen pallet ${pallet.number}`, dismiss: false,
    });
  }

  function discardModal() {
    return modalShell(`<span class="atlas-coc-eyebrow is-danger">DISCARD COC</span><h2>Discard COC?</h2>
      <p>This will permanently discard the current COC and all saved pallet progress.</p>
      <div class="atlas-coc-modal-actions"><button type="button" class="atlas-coc-primary" data-coc-action="keep-coc">Keep COC</button><button type="button" class="atlas-coc-danger" data-coc-action="discard-coc">Discard COC</button></div>`, {
      label: "Discard COC confirmation", dismiss: false, showBack: false, showDiscard: false,
    });
  }

  function closeReportModal() {
    return modalShell(`<span class="atlas-coc-eyebrow">CLOSE COC</span><h2>Finished entering this report?</h2>
      <p>Closing removes the active COC indicators. A device history copy is retained, but this report will no longer be the active workflow.</p>
      <div class="atlas-coc-modal-actions"><button type="button" class="atlas-coc-primary" data-coc-action="close-modal">Keep Report Open</button><button type="button" data-coc-action="close-report">Finish &amp; Close</button></div>`, { label: "Close completed COC", dismiss: false });
  }

  function storageErrorModal() {
    return modalShell(`<span class="atlas-coc-eyebrow is-danger">SAVE PROBLEM</span><h2>Stop counting for a moment</h2>
      <p>ATLAS could not preserve the latest COC state on this device. Do not add another box until saving succeeds.</p>
      <div class="atlas-coc-modal-actions"><button type="button" class="atlas-coc-primary" data-coc-action="retry-save">Retry Saving</button></div>`, { label: "COC save problem", dismiss: false });
  }

  function captureModal() {
    const active = scannerState === SCANNER_STATES.STARTING ||
      scannerState === SCANNER_STATES.READY;
    const rejected = scannerState === SCANNER_STATES.REJECTED;
    const scannerPanel = active
      ? `<div class="atlas-coc-camera is-active"><video id="atlas-coc-video" playsinline muted></video><div class="atlas-coc-scan-shade top"></div><div class="atlas-coc-scan-shade bottom"></div><div class="atlas-coc-camera-guide"><span>PRINTED LOT · MODEL · BATCH · BARCODE</span></div></div>
        <p id="atlas-coc-camera-status" class="atlas-coc-camera-status">${scannerState === SCANNER_STATES.STARTING ? "Starting camera…" : "Ready to Scan · nothing is being read yet."}</p>
        <canvas id="atlas-coc-canvas" hidden></canvas>
        <div class="atlas-coc-camera-controls"><button id="atlas-coc-torch" type="button" data-coc-action="toggle-torch" aria-pressed="false" hidden>Turn Light On</button><label id="atlas-coc-zoom-control" hidden><span>ZOOM</span><input id="atlas-coc-zoom" type="range" data-coc-action="set-zoom" /></label></div>
        <div class="atlas-coc-modal-actions atlas-coc-scanner-actions"><button id="atlas-coc-manual-fallback" type="button" data-coc-action="manual-lot" ${capture.failures >= 2 ? "" : "hidden"}>Enter Lot Manually</button><button type="button" class="atlas-coc-primary" data-coc-action="scan-lot" ${scannerState === SCANNER_STATES.STARTING ? "disabled" : ""}>Scan Lot</button></div>`
      : `<div class="atlas-coc-camera-idle" aria-live="polite"><span aria-hidden="true">▣</span><strong>${rejected ? "Unable to Verify Lot" : "Camera Unavailable"}</strong><small>${escapeHtml(capture.status || "Position the label and try again.")}</small></div>
        <p class="atlas-coc-camera-status">No lot was read or saved.</p>
        <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="manual-lot">Enter Lot Manually</button><button type="button" class="atlas-coc-primary" data-coc-action="rescan-lot">Retry Camera</button></div>`;
    return modalShell(`<span class="atlas-coc-eyebrow">NEW LOT</span><h2>Scan the printed label</h2>
      <p>Position the complete label inside the guide. ATLAS will not read anything until you tap Scan Lot.</p>
      ${scannerPanel}`, { label: "Scan new lot", className: `atlas-coc-scanner-modal is-${scannerState}` });
  }

  function readingModal() {
    return modalShell(`<span class="atlas-coc-eyebrow">READING LOT</span><h2>Checking barcode and printed fields…</h2>
      ${capture.photo ? `<img class="atlas-coc-photo" src="${capture.photo}" alt="Captured lot label" />` : ""}
      <div class="atlas-coc-progress"><i style="width:${capture.progress}%"></i></div><p>${escapeHtml(capture.status || "Preparing image…")}</p>`, {
      label: "Reading captured lot", dismiss: false,
    });
  }

  function confirmLotModal() {
    const result = capture.result || {};
    const verifiedCopy = result.validationMethod === "barcode_print_match"
      ? "Barcode + printed batch match"
      : result.captureMethod === "legacy_ocr"
        ? "Legacy Model + Batch rule verified"
        : result.captureMethod === "printed_batch_ocr"
          ? "Printed Model + Batch verified"
          : result.captureMethod === "printed_text_ocr"
            ? "Printed barcode text verified with SKU rules"
        : "Lot barcode identified";
    return modalShell(`<span class="atlas-coc-eyebrow is-success">LOT DETECTED</span><h2>${escapeHtml(Core.displayLot(capture.text))}</h2>
      <img class="atlas-coc-photo" src="${capture.photo}" alt="Captured printed lot for verification" />
      <div class="atlas-coc-capture-proof">${result.model ? `<p><span>MODEL</span><strong>${escapeHtml(result.model)}</strong></p>` : ""}${result.rawBatchText ? `<p><span>PRINTED BATCH</span><strong>${escapeHtml(result.rawBatchText)}</strong></p>` : ""}<p><span>VALIDATION</span><strong>${escapeHtml(verifiedCopy)}</strong></p></div>
      <label class="atlas-coc-verify-check"><input id="atlas-coc-verify-check" type="checkbox" /> <span>I compared <strong>${escapeHtml(capture.text)}</strong> to the printed lot and every character matches.</span></label>
      <p class="atlas-coc-first-case">Confirming this new lot records <strong>Box 1</strong>.</p>
      <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="rescan-lot">Rescan</button><button type="button" class="atlas-coc-primary" data-coc-action="confirm-lot" disabled>Confirm Lot + Box 1</button></div>`, { label: "Confirm recognized lot", dismiss: false });
  }

  function scanMismatchModal() {
    const result = capture.result || {};
    return modalShell(`<span class="atlas-coc-eyebrow is-danger">LOT DOES NOT MATCH</span><h2>Rescan the label</h2>
      <p>The barcode and printed batch number did not agree. ATLAS did not save a lot.</p>
      <div class="atlas-coc-compare is-scan-mismatch"><div><span>BARCODE LOT</span><strong>${escapeHtml(result.lot || "—")}</strong></div><div><span>PRINTED LOT</span><strong>${escapeHtml(result.printedLot || "—")}</strong></div></div>
      <button type="button" class="atlas-coc-primary atlas-coc-modal-wide" data-coc-action="rescan-lot">Rescan</button>`, { label: "Barcode and printed lot mismatch", dismiss: false });
  }

  function scanFailedModal() {
    const reasonCopy = {
      low_ocr_confidence: "The Model or Batch characters were not clear enough to verify.",
      lot_barcode_not_identified: "A product or carton barcode was visible, but a valid lot barcode was not confidently identified.",
      legacy_boundary_not_found: "The product/color boundary could not be verified inside the printed Batch number.",
      legacy_rule_not_found: "The label did not match a configured legacy extraction rule.",
      ambiguous_printed_lot: "More than one possible printed lot was visible.",
    }[capture.result?.reason] || "ATLAS could not confidently verify the lot from this label.";
    return modalShell(`<span class="atlas-coc-eyebrow is-danger">LOT NOT VERIFIED</span><h2>Please rescan the label</h2>
      <p>${escapeHtml(reasonCopy)} No guessed value was saved.</p>
      <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="rescan-lot">Scan Again</button><button type="button" class="atlas-coc-primary" data-coc-action="manual-lot">Enter Lot Manually</button></div>`, { label: "Lot not verified", dismiss: false });
  }

  function manualLotModal() {
    return modalShell(`<span class="atlas-coc-eyebrow">MANUAL LOT ENTRY</span><h2>Enter the lot twice</h2>
      <p>Type the printed lot exactly. Two matching entries prevent accidental characters.</p>
      <form id="atlas-coc-manual-form" class="atlas-coc-manual-form"><label><strong>Lot Number</strong><input name="lot1" maxlength="120" autocapitalize="characters" autocomplete="off" required /></label>
        <label><strong>Re-enter Lot Number</strong><input name="lot2" maxlength="120" autocapitalize="characters" autocomplete="off" required /></label>
        <p class="atlas-coc-form-error" aria-live="polite"></p>
        <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="rescan-lot">Use Camera</button><button type="submit" class="atlas-coc-primary">Confirm Lot + Box 1</button></div></form>`, { label: "Manually enter lot" });
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
    if (modal === "close-report") return closeReportModal();
    if (modal === "capture") return captureModal();
    if (modal === "reading") return readingModal();
    if (modal === "confirm-lot") return confirmLotModal();
    if (modal === "manual-lot") return manualLotModal();
    if (modal === "storage-error") return storageErrorModal();
    if (modal?.type === "duplicate") return duplicateModal(modal.lot);
    if (modal?.type === "mismatch") return mismatchModal();
    if (modal?.type === "edit-expected") return editExpectedModal();
    if (modal?.type === "confirm-expected-change") return confirmExpectedChangeModal(modal);
    if (modal?.type === "verified") return verifiedModal();
    if (modal?.type === "scan-mismatch") return scanMismatchModal();
    if (modal?.type === "scan-failed") return scanFailedModal();
    if (modal?.type === "similar") return similarLotModal(modal.similar);
    if (modal?.type === "reopen") return reopenPalletModal(modal.palletId);
    return "";
  }

  function renderAll() {
    document.documentElement.classList.toggle("atlas-coc-work-mode", isInsideCocWorkflow());
    const bar = document.getElementById("atlas-coc-active-bar-slot");
    if (bar) bar.innerHTML = barMarkup();
    const home = document.getElementById("atlas-coc-home-slot");
    if (home) home.innerHTML = "";
    const workflows = document.getElementById("atlas-coc-workflows-root");
    if (workflows) workflows.innerHTML = workflowMarkup();
    let modalRoot = document.getElementById("atlas-coc-modal-root");
    if (!modalRoot) {
      modalRoot = document.createElement("div");
      modalRoot.id = "atlas-coc-modal-root";
      document.body.appendChild(modalRoot);
    }
    modalRoot.innerHTML = modalMarkup();
    document.documentElement.classList.toggle("atlas-coc-modal-open", Boolean(modal));
    if (modal === "capture" && scannerState === SCANNER_STATES.STARTING)
      window.requestAnimationFrame(startCamera);
  }

  function stopCamera() {
    torchEnabled = false;
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    cameraTrack = null;
  }

  function cancelScanSession() {
    recognitionToken += 1;
    cameraStarting = false;
    const worker = activeOcrWorker;
    activeOcrWorker = null;
    worker?.terminate?.().catch(() => {});
    stopCamera();
    scannerState = SCANNER_STATES.IDLE;
    scanFinalizing = false;
    bestFrame = null;
    bestFrameScore = 0;
    accumulatedDetections = [];
  }

  function openCameraReady() {
    const failures = capture.failures;
    cancelScanSession();
    capture = freshCapture(failures);
    capture.sku = session?.sku || currentSkuContext();
    scannerState = SCANNER_STATES.STARTING;
    modal = "capture";
    renderAll();
  }

  function setCameraStatus(message) {
    const status = document.getElementById("atlas-coc-camera-status");
    if (status) status.textContent = message;
  }

  function captureCurrentFrame(video, canvas) {
    if (Scanner) return Scanner.captureRoi(video, canvas);
    if (!video?.videoWidth || !video?.videoHeight || !canvas) return null;
    const sourceX = Math.round(video.videoWidth * 0.04);
    const sourceY = Math.round(video.videoHeight * 0.12);
    const sourceWidth = Math.round(video.videoWidth * 0.92);
    const sourceHeight = Math.round(video.videoHeight * 0.76);
    canvas.width = Math.min(1800, sourceWidth);
    canvas.height = Math.max(360, Math.round((sourceHeight / sourceWidth) * canvas.width));
    canvas.getContext("2d", { willReadFrequently: true }).drawImage(
      video, sourceX, sourceY, sourceWidth, sourceHeight,
      0, 0, canvas.width, canvas.height,
    );
    return canvas;
  }

  function retainBestFrame(canvas) {
    if (!Scanner || !canvas?.width) return;
    const score = Scanner.qualityScore(canvas);
    if (!bestFrame || score > bestFrameScore) {
      bestFrame = Scanner.copyCanvas(canvas);
      bestFrameScore = score;
    }
  }

  function rememberDetections(detections = []) {
    const merged = [...accumulatedDetections, ...detections];
    accumulatedDetections = [...new Map(merged.map((item) => [
      String(item.value || "").trim().toUpperCase(), item,
    ])).values()].filter((item) => item.value);
    return accumulatedDetections;
  }

  async function finishFrameScan(canvas, detections = []) {
    if (scanFinalizing || !canvas?.width) return;
    scanFinalizing = true;
    const failures = capture.failures;
    const finalCanvas = Scanner?.copyCanvas(canvas) || canvas;
    const photo = finalCanvas.toDataURL("image/jpeg", 0.94);
    const uniqueDetections = [...new Map(detections.map((item) => [
      String(item.value || "").trim().toUpperCase(), item,
    ])).values()].filter((item) => item.value);
    capture = {
      ...freshCapture(failures),
      photo,
      barcodes: uniqueDetections.map((item) => item.value),
      barcodeDetections: uniqueDetections,
      sku: session?.sku || currentSkuContext(),
    };
    scannerState = SCANNER_STATES.VERIFYING;
    const token = ++recognitionToken;
    stopCamera();
    try {
      await runOcr(token);
    } finally {
      scanFinalizing = false;
      bestFrame = null;
      bestFrameScore = 0;
    }
  }

  async function startCamera() {
    if (cameraStarting || scannerState !== SCANNER_STATES.STARTING ||
      modal !== "capture" || !isInsideCocWorkflow()) return;
    cameraStarting = true;
    const expectedRecognitionToken = recognitionToken;
    stopCamera();
    bestFrame = null;
    bestFrameScore = 0;
    accumulatedDetections = [];
    scanFinalizing = false;
    const video = document.getElementById("atlas-coc-video");
    const status = document.getElementById("atlas-coc-camera-status");
    const button = document.querySelector('[data-coc-action="scan-lot"]');
    if (!video || !status || !button) {
      cameraStarting = false;
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      capture.status = "Camera is unavailable. Enter the lot manually.";
      capture.failures += 1;
      scannerState = SCANNER_STATES.REJECTED;
      cameraStarting = false;
      renderAll();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      if (expectedRecognitionToken !== recognitionToken ||
        scannerState !== SCANNER_STATES.STARTING || modal !== "capture" ||
        !isInsideCocWorkflow() || !document.getElementById("atlas-coc-video")) {
        stream.getTracks().forEach((track) => track.stop());
        cameraStarting = false;
        return;
      }
      cameraStream = stream;
      cameraTrack = cameraStream.getVideoTracks()[0] || null;
      video.srcObject = cameraStream;
      await video.play();
      const capabilities = await Scanner?.configureTrack(cameraTrack) || {};
      const torch = document.getElementById("atlas-coc-torch");
      if (torch) torch.hidden = !capabilities.torch;
      const zoomControl = document.getElementById("atlas-coc-zoom-control");
      const zoom = document.getElementById("atlas-coc-zoom");
      if (zoomControl && zoom && capabilities.zoom && capabilities.zoom.max > capabilities.zoom.min) {
        zoomControl.hidden = false;
        zoom.min = String(capabilities.zoom.min);
        zoom.max = String(capabilities.zoom.max);
        zoom.step = String(capabilities.zoom.step);
        zoom.value = String(Math.min(capabilities.zoom.max, Math.max(
          capabilities.zoom.min,
          capabilities.zoom.min + ((capabilities.zoom.max - capabilities.zoom.min) * 0.18),
        )));
      }
      scannerState = SCANNER_STATES.READY;
      cameraStarting = false;
      button.disabled = false;
      status.textContent = "Ready to Scan · nothing is being read yet.";
    } catch {
      if (expectedRecognitionToken !== recognitionToken) return;
      stopCamera();
      capture.status = "Camera access was not granted. Allow access or enter the lot manually.";
      capture.failures += 1;
      scannerState = SCANNER_STATES.REJECTED;
      cameraStarting = false;
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

  async function detectBarcodes(source) {
    if (!globalThis.BarcodeDetector) return [];
    try {
      const supported = await globalThis.BarcodeDetector.getSupportedFormats?.();
      const detector = new globalThis.BarcodeDetector(supported?.length ? { formats: supported } : undefined);
      const results = await detector.detect(source);
      return results.map((result) => String(result.rawValue || "").trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  async function runOcr(expectedToken) {
    modal = "reading";
    capture.status = "Preparing the lot image…";
    capture.progress = 5;
    renderAll();
    let worker = null;
    try {
      const tesseract = window.atlasTesseract;
      if (!tesseract?.createWorker) throw new Error("OCR is unavailable. Enter the lot manually.");
      let recognitionPass = 0;
      worker = await tesseract.createWorker("eng", tesseract.OEM.LSTM_ONLY, {
        workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@7/dist/worker.min.js",
        langPath: "https://tessdata.projectnaptha.com/4.0.0",
        corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@7",
        logger: (message) => {
          if (expectedToken !== recognitionToken) return;
          if (message.status === "recognizing text") {
            capture.progress = 12 + Math.round(((recognitionPass + (message.progress || 0)) / 3) * 82);
            capture.status = recognitionPass === 0
              ? "Reading printed characters…"
              : recognitionPass === 1
                ? "Checking Model and Batch fields…"
                : "Cross-checking the text below the barcode…";
            if (modal === "reading") renderAll();
          }
        },
      });
      activeOcrWorker = worker;
      await worker.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-./_ ",
        preserve_interword_spaces: "1",
        tessedit_pageseg_mode: tesseract.PSM.SPARSE_TEXT,
      });
      const ocrOutput = { text: true, blocks: true };
      const firstResult = await worker.recognize(capture.photo, {}, ocrOutput);
      if (expectedToken !== recognitionToken || !isInsideCocWorkflow()) return;
      const firstText = String(firstResult.data.text || "");
      const firstConfidence = Number(firstResult.data.confidence) || 0;

      recognitionPass = 1;
      capture.status = "Checking the Model and Batch fields…";
      capture.progress = 40;
      renderAll();
      const sourceImage = await loadImage(capture.photo);
      const sourceCanvas = document.createElement("canvas");
      sourceCanvas.width = sourceImage.naturalWidth || sourceImage.width;
      sourceCanvas.height = sourceImage.naturalHeight || sourceImage.height;
      sourceCanvas.getContext("2d", { willReadFrequently: true }).drawImage(sourceImage, 0, 0);
      const fieldsRegion = Scanner?.labelFieldsRegion(sourceCanvas) || sourceCanvas;
      await worker.setParameters({ tessedit_pageseg_mode: tesseract.PSM.SINGLE_BLOCK });
      const secondResult = await worker.recognize(fieldsRegion, {}, ocrOutput);
      if (expectedToken !== recognitionToken || !isInsideCocWorkflow()) return;
      const secondText = String(secondResult.data.text || "");
      const secondConfidence = Number(secondResult.data.confidence) || 0;

      recognitionPass = 2;
      capture.status = "Reading the printed text below the barcode…";
      capture.progress = 67;
      renderAll();
      const textBand = Scanner?.textBand(sourceCanvas) || sourceCanvas;
      const thirdResult = await worker.recognize(textBand, {}, ocrOutput);
      if (expectedToken !== recognitionToken || !isInsideCocWorkflow()) return;
      const thirdText = String(thirdResult.data.text || "");
      const thirdConfidence = Number(thirdResult.data.confidence) || 0;
      const firstFields = Parser.extractLabelFields(firstText);
      const secondFields = Parser.extractLabelFields(secondText);
      const thirdFields = Parser.extractLabelFields(thirdText);
      const results = [firstResult, secondResult, thirdResult];
      capture.ocrText = [firstText, secondText, thirdText].filter(Boolean).join("\n");
      const fieldReads = [firstFields, secondFields, thirdFields];
      const distinctBatchReads = [...new Set(fieldReads.map((item) => Parser.canonical(item.batch)).filter(Boolean))];
      const labeledReadsDisagree = distinctBatchReads.length > 1;
      const confidenceFor = (value) => {
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
        results.forEach((result) => visit(result?.data?.blocks));
        return best;
      };
      const combinedFields = Parser.extractLabelFields(capture.ocrText);
      const modelConfidence = confidenceFor(combinedFields.model);
      const batchConfidence = confidenceFor(combinedFields.batch);
      capture.fieldConfidence = modelConfidence && batchConfidence
        ? Math.min(modelConfidence, batchConfidence)
        : Math.max(modelConfidence, batchConfidence);
      if (labeledReadsDisagree) capture.fieldConfidence = Math.min(55, capture.fieldConfidence);
      capture.confidence = labeledReadsDisagree
        ? Math.min(55, Math.max(firstConfidence, secondConfidence, thirdConfidence))
        : Math.max(firstConfidence, secondConfidence, thirdConfidence);
      capture.result = Parser.evaluateCapture({
        barcodes: capture.barcodes,
        ocrText: capture.ocrText,
        ocrConfidence: capture.confidence,
        fieldConfidence: capture.fieldConfidence,
        sku: capture.sku,
        barcodeDetections: capture.barcodeDetections,
      });
      capture.progress = 100;
      if (capture.result.status === "confirm") {
        capture.text = capture.result.lot;
        capture.status = "Lot ready for employee confirmation.";
        modal = "confirm-lot";
        scannerState = SCANNER_STATES.REVIEW;
      } else {
        capture.failures += 1;
        capture.status = "No lot was saved.";
        modal = { type: capture.result.status === "mismatch" ? "scan-mismatch" : "scan-failed" };
        scannerState = SCANNER_STATES.REJECTED;
      }
    } catch (error) {
      if (expectedToken !== recognitionToken || !isInsideCocWorkflow()) return;
      capture.status = error instanceof Error ? error.message : "The lot could not be read.";
      capture.failures += 1;
      capture.result = { status: "rescan", reason: "scanner_error" };
      modal = { type: "scan-failed" };
      scannerState = SCANNER_STATES.REJECTED;
      showToast(capture.status, "warning");
    } finally {
      await worker?.terminate?.().catch(() => {});
      if (activeOcrWorker === worker) activeOcrWorker = null;
      if (expectedToken === recognitionToken && isInsideCocWorkflow()) renderAll();
    }
  }

  async function capturePhoto() {
    if (scannerState !== SCANNER_STATES.READY || modal !== "capture") return;
    const video = document.getElementById("atlas-coc-video");
    const canvas = document.getElementById("atlas-coc-canvas");
    if (!video?.videoWidth || !video?.videoHeight || !canvas) return;
    scannerState = SCANNER_STATES.PROCESSING;
    const expectedToken = ++recognitionToken;
    const button = document.querySelector('[data-coc-action="scan-lot"]');
    if (button) button.disabled = true;
    setCameraStatus("Scanning Lot…");
    captureCurrentFrame(video, canvas);
    retainBestFrame(canvas);
    const source = Scanner?.copyCanvas(bestFrame || canvas) || bestFrame || canvas;
    capture.photo = source.toDataURL("image/jpeg", 0.94);
    capture.status = "Checking barcode and printed fields…";
    capture.progress = 3;
    stopCamera();
    modal = "reading";
    renderAll();
    let detections = [];
    try {
      detections = Scanner
        ? await Scanner.decodeFrame(source, { enhanced: true })
        : (await detectBarcodes(source)).map((value) => ({ value, format: "unknown", engine: "native" }));
    } catch (error) {
      console.info("Enhanced decoder unavailable; continuing with printed text.", error);
    }
    if (expectedToken !== recognitionToken || !isInsideCocWorkflow() || modal !== "reading") return;
    await finishFrameScan(source, rememberDetections(detections));
  }

  function acceptLot(value, options = {}, { skipSimilar = false } = {}) {
    try {
      const canonicalValue = Core.canonicalLot(value);
      const exact = (activePallet()?.lots || []).find((lot) => Core.canonicalLot(lot.lot) === canonicalValue);
      if (exact) {
        modal = { type: "duplicate", lot: exact };
        renderAll();
        return;
      }
      const similar = !skipSimilar
        ? Parser.findSimilarLot(value, activePallet()?.lots || [])
        : null;
      if (similar) {
        capture.text = Parser.cleanLot(value);
        capture.result = { ...(capture.result || {}), ...options };
        modal = { type: "similar", similar };
        renderAll();
        return;
      }
      const result = Core.addLot(session, value, options);
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
    } catch {
      showToast("Enter a valid lot number.", "warning");
    }
  }

  function copyReport() {
    if (!session) return;
    const lines = [
      "ATLAS COC FINAL COUNT REPORT",
      session.invoiceNumber ? `Invoice: ${session.invoiceNumber}` : "",
      `Completed: ${formatDate(session.completedAt)}`,
      `Pallets: ${session.pallets.length}`,
      `Total Boxes: ${Core.sessionTotal(session)}`,
      "",
    ].filter((line, index) => line || index > 4);
    session.pallets.forEach((pallet) => {
      lines.push(`Pallet ${pallet.number} — Confirmed ${pallet.expectedBoxes || "—"} · Recorded ${Core.palletTotal(pallet)} · ${Core.palletProgress(pallet).verified ? "Verified" : "Verification unavailable"}`);
      pallet.lots.forEach((lot) => lines.push(`  ${lot.lot} — ${lot.cases} boxes`));
      lines.push("");
    });
    navigator.clipboard?.writeText(lines.join("\n")).then(
      () => showToast("COC report copied"),
      () => showToast("Could not copy report", "warning"),
    );
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
    scannerState = previousModal === "confirm-lot"
      ? SCANNER_STATES.REVIEW
      : previousModal?.type === "scan-failed" || previousModal?.type === "scan-mismatch"
        ? SCANNER_STATES.REJECTED
        : SCANNER_STATES.IDLE;
    renderAll();
  }

  function handleAction(button) {
    const action = button.dataset.cocAction;
    if (!action) return;
    if (action === "show-landing") {
      cancelScanSession(); capture = freshCapture(); modal = null;
      workflowView = "landing"; renderAll(); return;
    }
    if (action === "coc-back") { backWithinCoc(); return; }
    if (action === "start-setup") { workflowView = "setup"; renderAll(); return; }
    if (action === "resume") { navigateWorkflows({ resume: true }); return; }
    if (action === "close-modal") { cancelScanSession(); modal = null; renderAll(); return; }
    if (action === "review-mismatch") { modal = null; renderAll(); return; }
    if (action === "edit-expected") { modal = { type: "edit-expected" }; renderAll(); return; }
    if (action === "show-mismatch") { modal = { type: "mismatch" }; renderAll(); return; }
    if (action === "new-lot") {
      capture = freshCapture(); openCameraReady(); return;
    }
    if (action === "rescan-lot") { openCameraReady(); return; }
    if (action === "scan-lot") { capturePhoto(); return; }
    if (action === "manual-lot") { cancelScanSession(); modal = "manual-lot"; renderAll(); return; }
    if (action === "toggle-torch") {
      torchEnabled = !torchEnabled;
      Promise.resolve(Scanner?.setTorch(cameraTrack, torchEnabled)).then((applied) => {
        if (!applied) torchEnabled = false;
        const torch = document.getElementById("atlas-coc-torch");
        if (torch) {
          torch.setAttribute("aria-pressed", String(torchEnabled));
          torch.textContent = torchEnabled ? "Turn Light Off" : "Turn Light On";
        }
      });
      return;
    }
    if (action === "set-zoom") {
      Scanner?.setZoom(cameraTrack, button.value);
      return;
    }
    if (action === "confirm-lot") {
      acceptLot(capture.text, {
        rawBarcode: capture.result?.rawBarcode,
        barcodeFormat: capture.result?.barcodeFormat,
        rawBatchText: capture.result?.rawBatchText,
        sku: capture.sku || session?.sku,
        model: capture.result?.model,
        captureMethod: capture.result?.captureMethod,
        validationMethod: capture.result?.validationMethod,
        confidence: capture.result?.confidence,
        verification: "ocr",
      });
      return;
    }
    if (action === "confirm-similar") {
      acceptLot(capture.text, {
        rawBarcode: capture.result?.rawBarcode,
        barcodeFormat: capture.result?.barcodeFormat,
        rawBatchText: capture.result?.rawBatchText,
        sku: capture.sku || session?.sku,
        model: capture.result?.model,
        captureMethod: capture.result?.captureMethod,
        validationMethod: `${capture.result?.validationMethod || "manual"}_similar_confirmed`,
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
      session = Core.selectLot(session, button.dataset.lotId); persist();
      showToast("Active lot changed", "info"); return;
    }
    if (action === "add-case") {
      try {
        session = Core.addCase(session); persist(); navigator.vibrate?.(14);
        const add = document.querySelector(".atlas-coc-add-case");
        add?.classList.add("is-confirmed");
        window.setTimeout(() => add?.classList.remove("is-confirmed"), 180);
        if (!navigator.onLine) showToast("Box saved on device — connection pending", "info");
      } catch { showToast("Choose or add a lot first.", "warning"); }
      return;
    }
    if (action === "undo") {
      try {
        const pallet = activePallet();
        const lastEntry = pallet?.history[pallet.history.length - 1];
        const previousLot = pallet?.lots.find((item) => item.id === lastEntry?.lotId);
        session = Core.undoCase(session);
        persist();
        const updatedLot = activePallet()?.lots.find((item) => item.id === lastEntry?.lotId);
        const suffix = previousLot?.lot ? `…${Core.canonicalLot(previousLot.lot).slice(-5)}` : "lot";
        showToast(`Last box removed — ${suffix} now ${updatedLot?.cases || 0} boxes`, "info");
      }
      catch { showToast("There is no box to undo.", "warning"); }
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
      try { session = Core.completeSession(session); modal = null; workflowView = "session"; persist(); showToast("COC complete · report ready"); }
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
      const id = session?.id; const deviceId = session?.deviceId;
      cancelScanSession();
      capture = freshCapture();
      discardReturnModal = null;
      discardReturnScannerState = SCANNER_STATES.IDLE;
      session = null; modal = null; workflowView = "landing"; persist({ cloud: false });
      cloudRpc("atlas_close_coc_session", { p_session_id: id, p_device_id: deviceId }, { keepalive: true }).catch(() => {});
      showToast("Unfinished COC discarded", "info"); return;
    }
    if (action === "copy-report") { copyReport(); return; }
    if (action === "review-close") { modal = "close-report"; renderAll(); return; }
    if (action === "close-report") {
      const id = session?.id; const deviceId = session?.deviceId;
      cancelScanSession();
      archiveCurrent(); session = null; modal = null; workflowView = "landing"; persist({ cloud: false });
      cloudRpc("atlas_close_coc_session", { p_session_id: id, p_device_id: deviceId }, { keepalive: true }).catch(() => {});
      showToast("COC closed"); return;
    }
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
    if (event.target.id === "atlas-coc-verify-check") {
      const confirm = document.querySelector('[data-coc-action="confirm-lot"]');
      if (confirm) confirm.disabled = !event.target.checked;
    }
  });

  document.addEventListener("beforeinput", (event) => {
    const input = event.target;
    if (!input?.matches?.(
      "#atlas-coc-expected-form input[name='expectedBoxes'], #atlas-coc-edit-expected-form input[name='expectedBoxes']",
    )) return;
    if (event.data && /\D/.test(event.data)) event.preventDefault();
  });

  document.addEventListener("input", (event) => {
    const input = event.target;
    if (input?.id === "atlas-coc-zoom") {
      Scanner?.setZoom(cameraTrack, input.value);
      return;
    }
    if (!input?.matches?.("#atlas-coc-expected-form input[name='expectedBoxes']")) return;
    const form = input.closest("form");
    const button = form?.querySelector("[data-coc-box-confirm]");
    const error = form?.querySelector(".atlas-coc-form-error");
    const count = positiveWhole(input.value);
    if (button) {
      button.disabled = !count;
      button.textContent = count
        ? `Confirm ${count} ${count === 1 ? "Box" : "Boxes"}`
        : "Confirm Box Count";
    }
    if (error) error.textContent = input.value ? boxCountError(input.value, activePallet()?.number || 1) : "";
  });

  document.addEventListener("submit", (event) => {
    if (event.target.id === "atlas-coc-start-form") {
      event.preventDefault();
      const data = new FormData(event.target);
      const invoiceNumber = String(data.get("invoiceNumber") || "").trim();
      const error = event.target.querySelector(".atlas-coc-form-error");
      if (!invoiceNumber) {
        if (error) error.textContent = "Invoice Number is required.";
        return;
      }
      session = Core.createSession({
        invoiceNumber,
        deviceId: getDeviceId(),
        employee: getEmployee(),
        sku: currentSkuContext(),
      });
      workflowView = "session";
      persist();
      showToast("COC started · Pallet 1 ready");
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
        session = Core.setExpectedBoxCount(session, expected);
        persist();
        showToast(`Box count confirmed · ${plural(expected, "box")}`);
      } catch { error.textContent = "The box count could not be saved."; }
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
      modal = { type: "confirm-expected-change", previous, next };
      renderAll();
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
      "#atlas-coc-expected-form input[name='expectedBoxes'], #atlas-coc-edit-expected-form input[name='expectedBoxes']",
    ) && ["e", "E", "+", "-", ".", ","].includes(event.key)) {
      event.preventDefault();
      return;
    }
    const modalKey = typeof modal === "string" ? modal : modal?.type;
    const protectedModals = [
      "discard", "close-report", "reading", "confirm-lot", "duplicate", "mismatch",
      "edit-expected", "confirm-expected-change", "verified", "scan-mismatch", "scan-failed",
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
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { renderAll(); restoreFromCloud(); }, { once: true });
  } else {
    renderAll(); restoreFromCloud();
  }
})();
