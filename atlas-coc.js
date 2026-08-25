(function () {
  "use strict";

  const Core = window.AtlasCocCore;
  if (!Core) {
    console.error("ATLAS COC core did not load.");
    return;
  }

  const ACTIVE_KEY = "atlas-coc-active-v1";
  const ARCHIVE_KEY = "atlas-coc-archive-v1";
  const DEVICE_KEY = "atlas-coc-device-id-v1";
  const MAX_ARCHIVES = 20;
  let session = null;
  let route = "home";
  let workflowView = "landing";
  let modal = null;
  let toastTimer = null;
  let cloudTimer = null;
  let cameraStream = null;
  let storageFailure = false;
  let capture = { photo: "", text: "", confidence: null, status: "", progress: 0 };

  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const positiveWhole = (value) => {
    const text = String(value ?? "").trim();
    if (!/^\d+$/.test(text)) return null;
    const number = Number(text);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  };
  const formatDate = (value) => {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? "" : date.toLocaleString([], {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    });
  };
  const getEmployee = () => String(localStorage.getItem("atlasEmployee") || "").trim();
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
    if (!session) return "";
    if (session.status === "report") {
      return `<button type="button" class="atlas-coc-active-bar is-complete" data-coc-action="resume">
        <span class="atlas-coc-active-bar__signal" aria-hidden="true">✓</span>
        <span><strong>COC COMPLETE</strong><small>${session.orderNumber ? `Invoice ${escapeHtml(session.orderNumber)} · ` : ""}Review final report · ${plural(Core.sessionTotal(session), "box")}</small></span>
        <b>OPEN</b>
      </button>`;
    }
    const pallet = activePallet();
    const progress = Core.palletProgress(pallet);
    const countCopy = progress.expected
      ? `${progress.recorded} / ${progress.expected} boxes`
      : "Box count not verified";
    return `<button type="button" class="atlas-coc-active-bar" data-coc-action="resume">
      <span class="atlas-coc-active-bar__signal" aria-hidden="true"></span>
      <span><strong>COC ACTIVE · PALLET ${pallet?.number || 1}</strong><small>${session.orderNumber ? `Invoice ${escapeHtml(session.orderNumber)} · ` : ""}${countCopy}</small></span>
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
      <button type="button" class="atlas-coc-back" data-coc-action="show-landing">‹ Workflows</button>
      <header class="atlas-coc-page-head"><span>START COC</span><h1>Begin Pallet 1</h1><p>Add the invoice number if it helps identify this COC.</p></header>
      <form id="atlas-coc-start-form" class="atlas-coc-form-card">
        <label><strong>Invoice Number</strong><small>Optional</small>
          <input name="orderNumber" maxlength="80" autocomplete="off" placeholder="Leave blank if not needed" /></label>
        <div class="atlas-coc-zero-preview"><span>PALLET 1</span><strong>0</strong><small>Total Boxes · No Lots Recorded</small></div>
        <button type="submit" class="atlas-coc-primary">Start Pallet 1</button>
      </form>
    </div>`;
  }

  function completedPallets() {
    return session.pallets.filter(
      (item) => item.status === "locked" && (item.lots.length || Core.palletTotal(item) > 0),
    );
  }

  function expectedCountMarkup(pallet) {
    const locked = completedPallets().length;
    const recorded = Core.palletTotal(pallet);
    return `<div class="atlas-coc-page atlas-coc-expected">
      <button type="button" class="atlas-coc-back" data-coc-action="show-landing">‹ Workflows</button>
      <header class="atlas-coc-page-head"><span>PALLET ${pallet.number} · STEP 1</span><h1>Verify Box Count</h1>
        <p>Enter the expected number of boxes for this pallet before recording lots.</p></header>
      <form id="atlas-coc-expected-form" class="atlas-coc-form-card atlas-coc-expected-card">
        ${session.orderNumber ? `<p class="atlas-coc-invoice-line"><span>INVOICE</span><strong>${escapeHtml(session.orderNumber)}</strong></p>` : ""}
        <label><strong>Expected Boxes</strong><small>Required · whole number</small>
          <input name="expectedBoxes" type="number" inputmode="numeric" min="1" step="1" required autofocus placeholder="0" /></label>
        ${recorded ? `<p class="atlas-coc-preserved-count"><strong>${plural(recorded, "box")} already recorded</strong><span>Your saved lots are preserved. Confirm the expected count to continue.</span></p>` : ""}
        <p class="atlas-coc-form-error" aria-live="polite"></p>
        <button type="submit" class="atlas-coc-primary">Confirm Box Count</button>
      </form>
      <div class="atlas-coc-finish-actions">
        ${locked ? `<button type="button" class="atlas-coc-complete-link" data-coc-action="review-complete">Complete COC</button>` : ""}
        <button type="button" class="atlas-coc-discard-link" data-coc-action="review-discard">Discard COC</button>
      </div>
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
      <header class="atlas-coc-count-head">
        <div><span>COC${session.orderNumber ? ` · INVOICE ${escapeHtml(session.orderNumber)}` : ""}</span><h1>Pallet ${pallet.number}</h1><small>${locked ? `${plural(locked, "pallet")} completed · ` : ""}Saved automatically</small></div>
        <div class="atlas-coc-total ${difference > 0 ? "is-over" : ""}"><strong>${total} / ${pallet.expectedBoxes}</strong><span>Recorded / Expected Boxes</span></div>
      </header>
      ${difference > 0 ? `<p class="atlas-coc-overage">${plural(difference, "box")} over the expected count. Review before finishing.</p>` : ""}
      ${finished.length ? `<section class="atlas-coc-pallet-progress" aria-label="Completed pallets">
        <div class="atlas-coc-section-title"><h2>COC Progress</h2><span>${plural(finished.length, "finished pallet")}</span></div>
        <div>${finished.map((item) => `<article><span aria-hidden="true">✓</span><div><strong>Pallet ${item.number}</strong><small>${plural(Core.palletTotal(item), "box")} · ${plural(item.lots.length, "lot")} · Verified &amp; Locked</small></div></article>`).join("")}</div>
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
        <button type="button" class="atlas-coc-discard-link" data-coc-action="review-discard">Discard COC</button>
      </div>
    </div>`;
  }

  function reportMarkup() {
    const total = Core.sessionTotal(session);
    return `<div class="atlas-coc-page atlas-coc-report">
      <header class="atlas-coc-report-head"><span>COC COMPLETE</span><h1>Final Count Report</h1>
        <p>${session.orderNumber ? `Invoice <strong>${escapeHtml(session.orderNumber)}</strong> · ` : ""}${formatDate(session.completedAt)}</p></header>
      <section class="atlas-coc-report-summary"><div><strong>${session.pallets.length}</strong><span>Pallets</span></div><div><strong>${total}</strong><span>Total Boxes</span></div></section>
      <div class="atlas-coc-report-pallets">${session.pallets.map((pallet) => `
        <section class="atlas-coc-report-pallet"><header><h2>Pallet ${pallet.number}</h2><strong>${plural(Core.palletTotal(pallet), "box")}</strong></header>
          <p class="atlas-coc-report-verification"><span>Expected <strong>${pallet.expectedBoxes || "—"}</strong></span><span>Recorded <strong>${Core.palletTotal(pallet)}</strong></span><span class="${Core.palletProgress(pallet).verified ? "is-verified" : "is-unverified"}">${Core.palletProgress(pallet).verified ? "✓ Verified" : "Verification unavailable"}</span></p>
          <div>${pallet.lots.map((lot) => `<div class="atlas-coc-report-row"><span><small>LOT</small><strong>${escapeHtml(Core.displayLot(lot.lot))}</strong></span><b>${lot.cases}</b></div>`).join("") || `<p>No lots recorded</p>`}</div>
        </section>`).join("")}</div>
      <div class="atlas-coc-report-actions"><button type="button" data-coc-action="copy-report">Copy Report</button><button type="button" class="atlas-coc-primary" data-coc-action="review-close">Finish &amp; Close COC</button></div>
      <p class="atlas-coc-report-note">Keep this report open while entering the pallet and lot totals into the office system.</p>
    </div>`;
  }

  function workflowMarkup() {
    if (workflowView === "setup" && !session) return setupMarkup();
    if (workflowView === "session" && session)
      return session.status === "report" ? reportMarkup() : countingMarkup();
    return landingMarkup();
  }

  function modalShell(content, { label = "COC dialog", dismiss = true, className = "" } = {}) {
    return `<div class="atlas-coc-modal-backdrop ${className}" role="presentation">
      <section class="atlas-coc-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(label)}">
        ${dismiss ? `<button type="button" class="atlas-coc-modal-x" data-coc-action="close-modal" aria-label="Close">×</button>` : ""}
        ${content}
      </section></div>`;
  }

  function reviewPalletModal() {
    const pallet = activePallet();
    const progress = Core.palletProgress(pallet);
    return modalShell(`<span class="atlas-coc-eyebrow">REVIEW PALLET ${pallet.number}</span><h2>Verify this pallet?</h2>
      <div class="atlas-coc-compare"><div><span>EXPECTED</span><strong>${progress.expected}</strong></div><div><span>RECORDED</span><strong>${progress.recorded}</strong></div></div>
      <div class="atlas-coc-review-list">${pallet.lots.map((lot) => `<div><span>${escapeHtml(Core.displayLot(lot.lot))}</span><strong>${plural(lot.cases, "box")}</strong></div>`).join("") || `<p>No lots recorded.</p>`}</div>
      <p>The pallet can only be completed when the expected and recorded box counts match.</p>
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
    const detail = progress.difference > 0
      ? `${plural(progress.difference, "box")} over`
      : `${plural(Math.abs(progress.difference), "box")} short`;
    return modalShell(`<span class="atlas-coc-eyebrow is-danger">BOX COUNT MISMATCH</span><h2>Pallet ${pallet.number} cannot be finished</h2>
      <div class="atlas-coc-compare is-mismatch"><div><span>EXPECTED</span><strong>${progress.expected}</strong></div><div><span>RECORDED</span><strong>${progress.recorded}</strong></div><div><span>DIFFERENCE</span><strong>${difference}</strong></div></div>
      <p class="atlas-coc-warning"><strong>${detail}.</strong> Review the pallet or correct the expected count.</p>
      <div class="atlas-coc-modal-actions atlas-coc-modal-actions--stack"><button type="button" class="atlas-coc-primary" data-coc-action="review-mismatch">Review Pallet</button><button type="button" data-coc-action="edit-expected">Edit Expected Count</button></div>`, {
      label: `Pallet ${pallet.number} box count mismatch`, dismiss: false,
    });
  }

  function editExpectedModal() {
    const pallet = activePallet();
    return modalShell(`<span class="atlas-coc-eyebrow">EDIT EXPECTED COUNT</span><h2>Pallet ${pallet.number}</h2>
      <p>Update the expected count only when the pallet paperwork has changed or the original count was entered incorrectly.</p>
      <form id="atlas-coc-edit-expected-form" class="atlas-coc-manual-form">
        <label><strong>Expected Boxes</strong><input name="expectedBoxes" type="number" inputmode="numeric" min="1" step="1" value="${pallet.expectedBoxes}" required /></label>
        <p class="atlas-coc-form-error" aria-live="polite"></p>
        <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="show-mismatch">Cancel</button><button type="submit" class="atlas-coc-primary">Review Change</button></div>
      </form>`, { label: `Edit expected count for pallet ${pallet.number}`, dismiss: false });
  }

  function confirmExpectedChangeModal(change) {
    return modalShell(`<span class="atlas-coc-eyebrow">CONFIRM COUNT CHANGE</span><h2>${change.previous} → ${change.next} boxes</h2>
      <p>Change the expected count for Pallet ${activePallet()?.number}? The recorded boxes and lot details will not change.</p>
      <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="edit-expected">Go Back</button><button type="button" class="atlas-coc-primary" data-coc-action="confirm-expected-change" data-next="${change.next}">Confirm Change</button></div>`, {
      label: "Confirm expected box count change", dismiss: false,
    });
  }

  function verifiedModal() {
    const pallet = activePallet();
    const progress = Core.palletProgress(pallet);
    return modalShell(`<span class="atlas-coc-verified-icon" aria-hidden="true">✓</span><span class="atlas-coc-eyebrow is-success">BOX COUNT VERIFIED</span><h2>Pallet ${pallet.number} is complete</h2>
      <div class="atlas-coc-compare is-verified"><div><span>EXPECTED</span><strong>${progress.expected}</strong></div><div><span>RECORDED</span><strong>${progress.recorded}</strong></div></div>
      <p>All ${plural(progress.recorded, "box")} are accounted for. This pallet will be locked when you start the next pallet.</p>
      <button type="button" class="atlas-coc-primary atlas-coc-modal-wide" data-coc-action="start-next-pallet">Start Pallet ${pallet.number + 1}</button>`, {
      label: `Pallet ${pallet.number} verified`, dismiss: false,
    });
  }

  function discardModal() {
    return modalShell(`<span class="atlas-coc-eyebrow is-danger">DISCARD COC</span><h2>Discard this unfinished COC?</h2>
      <p>All pallet, lot, and box counts in this active COC will be removed from this device.</p>
      <div class="atlas-coc-modal-actions"><button type="button" class="atlas-coc-primary" data-coc-action="close-modal">Keep COC</button><button type="button" class="atlas-coc-danger" data-coc-action="discard-coc">Discard</button></div>`, { label: "Discard COC confirmation", dismiss: false });
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
    return modalShell(`<span class="atlas-coc-eyebrow">NEW LOT</span><h2>Scan the lot number</h2>
      <p>Place one printed lot inside the guide. The lot will not be saved until you compare and confirm it.</p>
      <div class="atlas-coc-camera"><video id="atlas-coc-video" playsinline muted></video><div class="atlas-coc-camera-guide"><span>LOT NUMBER</span></div></div>
      <p id="atlas-coc-camera-status" class="atlas-coc-camera-status">Starting camera…</p>
      <canvas id="atlas-coc-canvas" hidden></canvas>
      <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="manual-lot">Enter Manually</button><button type="button" class="atlas-coc-primary" data-coc-action="capture-photo" disabled>Capture Lot</button></div>`, { label: "Scan new lot", className: "atlas-coc-scanner-modal" });
  }

  function readingModal() {
    return modalShell(`<span class="atlas-coc-eyebrow">READING LOT</span><h2>Checking the printed characters…</h2>
      ${capture.photo ? `<img class="atlas-coc-photo" src="${capture.photo}" alt="Captured lot label" />` : ""}
      <div class="atlas-coc-progress"><i style="width:${capture.progress}%"></i></div><p>${escapeHtml(capture.status || "Preparing image…")}</p>`, { label: "Reading captured lot", dismiss: false });
  }

  function confirmLotModal() {
    const low = capture.confidence === null || capture.confidence < 82;
    return modalShell(`<span class="atlas-coc-eyebrow">VISUAL CONFIRMATION REQUIRED</span><h2>Compare every character</h2>
      <img class="atlas-coc-photo" src="${capture.photo}" alt="Captured printed lot for verification" />
      <label class="atlas-coc-lot-field"><strong>Recognized Lot</strong><input id="atlas-coc-confirm-lot" value="${escapeHtml(capture.text)}" maxlength="120" autocomplete="off" spellcheck="false" /></label>
      <p class="atlas-coc-confidence ${low ? "is-low" : "is-high"}">${low ? "LOT NOT VERIFIED — OCR confidence was low. Correct the field and compare it to the photo." : `High-confidence read · ${Math.round(capture.confidence)}%`}</p>
      <label class="atlas-coc-verify-check"><input id="atlas-coc-verify-check" type="checkbox" /> <span>I compared the field to the printed lot and every character matches.</span></label>
      <p class="atlas-coc-first-case">Confirming this new lot records <strong>Box 1</strong>.</p>
      <div class="atlas-coc-modal-actions"><button type="button" data-coc-action="rescan-lot">Rescan</button><button type="button" class="atlas-coc-primary" data-coc-action="confirm-lot" disabled>Confirm Lot + Box 1</button></div>`, { label: "Confirm recognized lot", dismiss: false });
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
    return "";
  }

  function renderAll() {
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
    if (modal === "capture") window.requestAnimationFrame(startCamera);
  }

  function stopCamera() {
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }

  async function startCamera() {
    stopCamera();
    const video = document.getElementById("atlas-coc-video");
    const status = document.getElementById("atlas-coc-camera-status");
    const button = document.querySelector('[data-coc-action="capture-photo"]');
    if (!video || !status || !button) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      status.textContent = "Camera is unavailable. Enter the lot manually.";
      return;
    }
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      if (!document.getElementById("atlas-coc-video")) return stopCamera();
      video.srcObject = cameraStream;
      await video.play();
      button.disabled = false;
      status.textContent = "Hold steady, avoid glare, then capture the printed lot.";
    } catch {
      status.textContent = "Camera access was not granted. Allow access or enter the lot manually.";
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

  function extractLotText(text) {
    const lines = String(text || "").toUpperCase().split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:LOT|BATCH)(?:\s*(?:NO|NUMBER|#))?\s*[:#.-]?\s*/i, "").trim())
      .filter((line) => /[A-Z0-9]/.test(line));
    const candidates = lines.map((line) => line.replace(/[^A-Z0-9 .\/_-]/g, "").trim())
      .filter(Boolean).sort((left, right) => Core.canonicalLot(right).length - Core.canonicalLot(left).length);
    return candidates[0] || "";
  }

  async function runOcr() {
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
          if (message.status === "recognizing text") {
            capture.progress = 15 + Math.round(((recognitionPass + (message.progress || 0)) / 2) * 78);
            capture.status = recognitionPass ? "Cross-checking the lot read…" : "Reading printed characters…";
            if (modal === "reading") renderAll();
          }
        },
      });
      await worker.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-./_ ",
        preserve_interword_spaces: "1",
        tessedit_pageseg_mode: tesseract.PSM.SPARSE_TEXT,
      });
      const firstResult = await worker.recognize(capture.photo);
      const firstText = extractLotText(firstResult.data.text);
      const firstConfidence = Number(firstResult.data.confidence) || 0;

      recognitionPass = 1;
      capture.status = "Cross-checking the lot read…";
      capture.progress = 58;
      renderAll();
      const sourceImage = await loadImage(capture.photo);
      const enhanced = document.createElement("canvas");
      enhanced.width = sourceImage.naturalWidth || sourceImage.width;
      enhanced.height = sourceImage.naturalHeight || sourceImage.height;
      const enhancedContext = enhanced.getContext("2d", { willReadFrequently: true });
      enhancedContext.drawImage(sourceImage, 0, 0);
      const pixels = enhancedContext.getImageData(0, 0, enhanced.width, enhanced.height);
      for (let index = 0; index < pixels.data.length; index += 4) {
        const gray = pixels.data[index] * .299 + pixels.data[index + 1] * .587 + pixels.data[index + 2] * .114;
        const value = gray > 154 ? 255 : 0;
        pixels.data[index] = value;
        pixels.data[index + 1] = value;
        pixels.data[index + 2] = value;
      }
      enhancedContext.putImageData(pixels, 0, 0);
      await worker.setParameters({ tessedit_pageseg_mode: tesseract.PSM.SINGLE_LINE });
      const secondResult = await worker.recognize(enhanced);
      const secondText = extractLotText(secondResult.data.text);
      const secondConfidence = Number(secondResult.data.confidence) || 0;
      const readingsAgree = Boolean(firstText && secondText &&
        Core.canonicalLot(firstText) === Core.canonicalLot(secondText));
      capture.text = secondConfidence > firstConfidence ? secondText : firstText;
      if (!capture.text) capture.text = firstText || secondText;
      capture.confidence = readingsAgree
        ? Math.min(100, (firstConfidence + secondConfidence) / 2)
        : Math.min(55, Math.max(firstConfidence, secondConfidence));
      capture.progress = 100;
      capture.status = capture.text
        ? readingsAgree ? "Two OCR reads agree." : "OCR reads differed. Visual correction is required."
        : "No lot characters were found.";
      modal = capture.text ? "confirm-lot" : "manual-lot";
    } catch (error) {
      capture.status = error instanceof Error ? error.message : "The lot could not be read.";
      modal = "manual-lot";
      showToast(capture.status, "warning");
    } finally {
      await worker?.terminate?.().catch(() => {});
      renderAll();
    }
  }

  async function capturePhoto() {
    const video = document.getElementById("atlas-coc-video");
    const canvas = document.getElementById("atlas-coc-canvas");
    if (!video?.videoWidth || !video?.videoHeight || !canvas) return;
    const sourceX = Math.round(video.videoWidth * .06);
    const sourceY = Math.round(video.videoHeight * .29);
    const sourceWidth = Math.round(video.videoWidth * .88);
    const sourceHeight = Math.round(video.videoHeight * .42);
    canvas.width = Math.min(1800, sourceWidth);
    canvas.height = Math.max(300, Math.round((sourceHeight / sourceWidth) * canvas.width));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    capture = { photo: canvas.toDataURL("image/jpeg", 0.9), text: "", confidence: null, status: "", progress: 0 };
    stopCamera();
    await runOcr();
  }

  function acceptLot(value, verification, confidence = null) {
    try {
      const result = Core.addLot(session, value, { verification, confidence });
      if (result.duplicate) {
        modal = { type: "duplicate", lot: result.duplicate };
        renderAll();
        return;
      }
      session = result.session;
      modal = null;
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
      session.orderNumber ? `Invoice: ${session.orderNumber}` : "",
      `Completed: ${formatDate(session.completedAt)}`,
      `Pallets: ${session.pallets.length}`,
      `Total Boxes: ${Core.sessionTotal(session)}`,
      "",
    ].filter((line, index) => line || index > 4);
    session.pallets.forEach((pallet) => {
      lines.push(`Pallet ${pallet.number} — Expected ${pallet.expectedBoxes || "—"} · Recorded ${Core.palletTotal(pallet)} · ${Core.palletProgress(pallet).verified ? "Verified" : "Verification unavailable"}`);
      pallet.lots.forEach((lot) => lines.push(`  ${lot.lot} — ${lot.cases} boxes`));
      lines.push("");
    });
    navigator.clipboard?.writeText(lines.join("\n")).then(
      () => showToast("COC report copied"),
      () => showToast("Could not copy report", "warning"),
    );
  }

  function handleAction(button) {
    const action = button.dataset.cocAction;
    if (!action) return;
    if (action === "show-landing") { workflowView = "landing"; renderAll(); return; }
    if (action === "start-setup") { workflowView = "setup"; renderAll(); return; }
    if (action === "resume") { navigateWorkflows({ resume: true }); return; }
    if (action === "close-modal") { stopCamera(); modal = null; renderAll(); return; }
    if (action === "review-mismatch") { modal = null; renderAll(); return; }
    if (action === "edit-expected") { modal = { type: "edit-expected" }; renderAll(); return; }
    if (action === "show-mismatch") { modal = { type: "mismatch" }; renderAll(); return; }
    if (action === "new-lot" || action === "rescan-lot") {
      stopCamera(); capture = { photo: "", text: "", confidence: null, status: "", progress: 0 };
      modal = "capture"; renderAll(); return;
    }
    if (action === "manual-lot") { stopCamera(); modal = "manual-lot"; renderAll(); return; }
    if (action === "capture-photo") { button.disabled = true; capturePhoto(); return; }
    if (action === "confirm-lot") {
      const input = document.getElementById("atlas-coc-confirm-lot");
      acceptLot(input?.value, "ocr", capture.confidence); return;
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
      } catch { showToast("Enter a positive whole box count.", "warning"); }
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
    if (action === "review-discard") { modal = "discard"; renderAll(); return; }
    if (action === "discard-coc") {
      const id = session?.id; const deviceId = session?.deviceId;
      session = null; modal = null; workflowView = "landing"; persist({ cloud: false });
      cloudRpc("atlas_close_coc_session", { p_session_id: id, p_device_id: deviceId }, { keepalive: true }).catch(() => {});
      showToast("Unfinished COC discarded", "info"); return;
    }
    if (action === "copy-report") { copyReport(); return; }
    if (action === "review-close") { modal = "close-report"; renderAll(); return; }
    if (action === "close-report") {
      const id = session?.id; const deviceId = session?.deviceId;
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
      if (confirm) confirm.disabled = !event.target.checked || !document.getElementById("atlas-coc-confirm-lot")?.value.trim();
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "atlas-coc-confirm-lot") {
      const checked = document.getElementById("atlas-coc-verify-check")?.checked;
      const confirm = document.querySelector('[data-coc-action="confirm-lot"]');
      if (confirm) confirm.disabled = !checked || !event.target.value.trim();
    }
  });

  document.addEventListener("submit", (event) => {
    if (event.target.id === "atlas-coc-start-form") {
      event.preventDefault();
      const data = new FormData(event.target);
      session = Core.createSession({
        orderNumber: data.get("orderNumber"), deviceId: getDeviceId(), employee: getEmployee(),
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
        error.textContent = "Enter a positive whole number of boxes.";
        return;
      }
      try {
        session = Core.setExpectedBoxCount(session, expected);
        persist();
        showToast(`Expected count confirmed · ${plural(expected, "box")}`);
      } catch { error.textContent = "The expected box count could not be saved."; }
      return;
    }
    if (event.target.id === "atlas-coc-edit-expected-form") {
      event.preventDefault();
      const data = new FormData(event.target);
      const next = positiveWhole(data.get("expectedBoxes"));
      const previous = activePallet()?.expectedBoxes;
      const error = event.target.querySelector(".atlas-coc-form-error");
      if (!next) {
        error.textContent = "Enter a positive whole number of boxes.";
        return;
      }
      if (next === previous) {
        error.textContent = "Enter a different expected count.";
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
      acceptLot(first, "manual");
    }
  });

  document.addEventListener("keydown", (event) => {
    const modalKey = typeof modal === "string" ? modal : modal?.type;
    const protectedModals = [
      "discard", "close-report", "reading", "confirm-lot", "duplicate", "mismatch",
      "edit-expected", "confirm-expected-change", "verified",
    ];
    if (event.key === "Escape" && modal && !protectedModals.includes(modalKey)) {
      stopCamera(); modal = null; renderAll();
    }
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== ACTIVE_KEY) return;
    readSession();
    if (!session) workflowView = "landing";
    renderAll();
  });
  window.addEventListener("online", () => scheduleCloudSync());
  window.addEventListener("beforeunload", stopCamera);

  window.atlasCoc = Object.freeze({
    sync(nextRoute) { route = nextRoute || route; renderAll(); },
    openWorkflows() { workflowView = "landing"; renderAll(); },
    resume() { navigateWorkflows({ resume: true }); },
    getState() { return session ? Core.sanitize(session) : null; },
  });

  readSession();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { renderAll(); restoreFromCloud(); }, { once: true });
  } else {
    renderAll(); restoreFromCloud();
  }
})();
