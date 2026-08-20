(() => {
  "use strict";

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[character]));

  const locationCode = (location) => {
    const aisle = Number(location?.aisle);
    const section = String(location?.section || "").toUpperCase();
    if (aisle === 22) return `Overflow · ${{ A: "Left", B: "Middle", C: "Right" }[section] || section}`;
    if (aisle === 23) return `Samples Rack · Section ${section}`;
    return `Aisle ${aisle} · Section ${section}`;
  };

  const sectionsFor = (aisle) => {
    const value = Number(aisle);
    if (value === 1) return ["A", "B", "C"];
    if (value >= 2 && value <= 9) return ["A", "B", "C", "D"];
    if (value >= 10 && value <= 19) return ["B", "C", "D"];
    if (value === 20 || value === 21) return ["B", "C"];
    if (value === 22) return ["A", "B", "C"];
    return ["A", "B"];
  };

  const close = (overlay) => overlay?.remove();
  const employeeValue = () => localStorage.getItem("atlasEmployee") || "";
  const actionCopy = {
    restore: { kicker: "RESTORE LOCATION", title: "Restore this location?", button: "Restore Location", reason: "Product found at last known location", successKicker: "LOCATION RESTORED", successTitle: "Location restored successfully" },
    found: { kicker: "PRODUCT FOUND", title: "Add found location?", button: "Add Found Location", reason: "Product found at a different location", successKicker: "LOCATION ADDED", successTitle: "Found location added" },
    replenish: { kicker: "REPLENISH INVENTORY", title: "Replenish inventory here?", button: "Replenish Inventory", reason: "Inventory replenished", successKicker: "INVENTORY REPLENISHED", successTitle: "Inventory replenished successfully" },
  };

  const showRestock = async (skuValue) => {
    if (!skuValue || document.querySelector(".atlas-restock-overlay")) return;
    const overlay = document.createElement("div");
    overlay.className = "atlas-restock-overlay";
    overlay.innerHTML = `<section class="atlas-restock-modal" role="dialog" aria-modal="true" aria-label="Out of stock ${escapeHtml(skuValue)}"><p class="atlas-restock-kicker">OUT OF STOCK</p><h2>${escapeHtml(skuValue)}</h2><p>Checking this SKU’s last recorded location…</p></section>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) close(overlay); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(overlay); }, { once: true });

    try {
      const api = window.atlasInventoryApi;
      if (!api?.findSku || !api?.locations) throw Error("Inventory connection is unavailable.");
      const sku = await api.findSku(skuValue);
      if (!sku) throw Error("This SKU could not be found in ATLAS.");
      const locations = await api.locations(sku.id);
      const lastKnown = locations.find((location) => location.is_active === false) || null;
      renderOutOfStock(overlay, sku, locations, lastKnown);
    } catch (error) {
      overlay.querySelector(".atlas-restock-modal").innerHTML = `<p class="atlas-restock-kicker">OUT OF STOCK</p><h2>Unable to load location options</h2><p class="atlas-restock-error">Please try again or contact a supervisor.</p>`;
    }
  };

  const renderOutOfStock = (overlay, sku, locations, lastKnown) => {
    const modal = overlay.querySelector(".atlas-restock-modal");
    const lastLocation = lastKnown ? `<section class="atlas-restock-location-card"><p class="atlas-restock-location-label">LAST LOCATION TO VERIFY</p><strong>${escapeHtml(locationCode(lastKnown))}</strong><span>Marked empty — no active inventory</span><div class="atlas-restock-found"><p>PRODUCT FOUND?</p><button type="button" data-restore>Restore ${escapeHtml(locationCode(lastKnown))}</button><button type="button" data-found>Add a Different Found Location</button></div></section>` : `<section class="atlas-restock-location-card atlas-restock-location-card--empty"><p class="atlas-restock-location-label">NO LAST LOCATION ON RECORD</p><strong>Choose the location where product was found.</strong><div class="atlas-restock-found"><p>PRODUCT FOUND?</p><button type="button" data-found>Add a Found Location</button></div></section>`;
    modal.innerHTML = `<p class="atlas-restock-kicker">OUT OF STOCK</p><h2>${escapeHtml(sku.sku)}</h2><p>This SKU has no active pick location.</p>${lastLocation}<p class="atlas-restock-incoming-question">Have incoming inventory?</p><div class="atlas-restock-actions atlas-restock-actions--primary-only"><button type="button" class="primary" data-replenish>Replenish Inventory</button></div>`;
    modal.querySelector("[data-restore]")?.addEventListener("click", () => renderConfirmation(overlay, sku, locations, lastKnown, lastKnown, "restore"));
    modal.querySelector("[data-found]")?.addEventListener("click", () => renderLocationForm(overlay, sku, locations, lastKnown, "found"));
    modal.querySelector("[data-replenish]")?.addEventListener("click", () => lastKnown ? renderReplenishChoice(overlay, sku, locations, lastKnown) : renderLocationForm(overlay, sku, locations, lastKnown, "replenish"));
  };

  const renderReplenishChoice = (overlay, sku, locations, lastKnown) => {
    const modal = overlay.querySelector(".atlas-restock-modal");
    modal.innerHTML = `<p class="atlas-restock-kicker">REPLENISH INVENTORY</p><h2>Where should this inventory be placed?</h2><p>The last known location is selected by default.</p><div class="atlas-restock-actions"><button type="button" data-last><strong>Use Last Known Location</strong><span class="atlas-restock-choice-code">${escapeHtml(locationCode(lastKnown))} · Recommended</span></button><button type="button" class="secondary" data-new>Choose a Different Location</button><button type="button" class="muted" data-back>Back</button></div>`;
    modal.querySelector("[data-last]").addEventListener("click", () => renderConfirmation(overlay, sku, locations, lastKnown, lastKnown, "replenish"));
    modal.querySelector("[data-new]").addEventListener("click", () => renderLocationForm(overlay, sku, locations, lastKnown, "replenish"));
    modal.querySelector("[data-back]").addEventListener("click", () => renderOutOfStock(overlay, sku, locations, lastKnown));
  };

  const renderLocationForm = (overlay, sku, locations, lastKnown, mode) => {
    const modal = overlay.querySelector(".atlas-restock-modal");
    const copy = actionCopy[mode];
    const prompt = mode === "found" ? "Select the aisle and section where product was found." : "Select where the incoming inventory will be placed.";
    const aisles = Array.from({ length: 23 }, (_, index) => index + 1);
    modal.innerHTML = `<p class="atlas-restock-kicker">${escapeHtml(copy.kicker)}</p><h2>Choose a location</h2><p>${prompt}</p><div class="atlas-restock-fields"><label>Aisle<select data-aisle>${aisles.map((aisle) => `<option value="${aisle}">${aisle === 22 ? "Overflow" : aisle === 23 ? "Samples Rack" : `Aisle ${aisle}`}</option>`).join("")}</select></label><label>Section<select data-section></select></label></div><div class="atlas-restock-actions"><button type="button" class="primary" data-continue>Continue</button><button type="button" class="muted" data-back>Back</button></div>`;
    const aisle = modal.querySelector("[data-aisle]");
    const section = modal.querySelector("[data-section]");
    const updateSections = () => { section.innerHTML = sectionsFor(aisle.value).map((item) => `<option value="${item}">Section ${item}</option>`).join(""); };
    aisle.addEventListener("change", updateSections);
    updateSections();
    modal.querySelector("[data-continue]").addEventListener("click", () => {
      const target = { aisle: Number(aisle.value), section: section.value };
      const existing = locations.find((location) => Number(location.aisle) === target.aisle && String(location.section).toUpperCase() === target.section.toUpperCase()) || null;
      if (existing?.is_active) return showError(modal, `This SKU is already active at ${locationCode(existing)}.`);
      renderConfirmation(overlay, sku, locations, lastKnown, existing || target, mode);
    });
    modal.querySelector("[data-back]").addEventListener("click", () => renderOutOfStock(overlay, sku, locations, lastKnown));
  };

  const renderConfirmation = (overlay, sku, locations, lastKnown, target, mode) => {
    const modal = overlay.querySelector(".atlas-restock-modal");
    const copy = actionCopy[mode];
    const targetCode = locationCode(target);
    const description = mode === "restore" ? `${escapeHtml(sku.sku)} will be active again at this location. Pick First will not change.` : mode === "found" ? `${escapeHtml(sku.sku)} will be active at this found location. The last location will remain inactive.` : `${escapeHtml(sku.sku)} will be available to pick from this location.`;
    modal.innerHTML = `<p class="atlas-restock-kicker">${escapeHtml(copy.kicker)}</p><h2>${escapeHtml(copy.title)}</h2><p>${description}</p><div class="atlas-restock-summary"><strong>Location</strong>${escapeHtml(targetCode)}</div><div class="atlas-restock-fields atlas-restock-fields--employee"><label class="employee">Employee name or initials<input data-employee maxlength="60" value="${escapeHtml(employeeValue())}" placeholder="Example: ZM" /></label></div><div class="atlas-restock-actions"><button type="button" class="primary" data-confirm>${escapeHtml(copy.button)}</button><button type="button" class="muted" data-back>Back to Edit</button></div>`;
    modal.querySelector("[data-confirm]").addEventListener("click", () => saveAction(overlay, sku, locations, lastKnown, target, mode));
    modal.querySelector("[data-back]").addEventListener("click", () => renderOutOfStock(overlay, sku, locations, lastKnown));
  };

  const saveAction = async (overlay, sku, locations, lastKnown, target, mode) => {
    const modal = overlay.querySelector(".atlas-restock-modal");
    const employee = modal.querySelector("[data-employee]")?.value.trim() || "";
    const copy = actionCopy[mode];
    if (employee.length < 2) return showError(modal, "Enter at least two letters for the employee name or initials.");
    const confirm = modal.querySelector("[data-confirm]");
    confirm.disabled = true;
    confirm.textContent = "Saving…";
    try {
      localStorage.setItem("atlasEmployee", employee);
      const targetCode = locationCode(target);
      let result;
      if (mode === "restore") {
        result = await window.atlasInventoryApi.rpc("set_inventory_location_active", { p_location_id: target.id, p_is_active: true, p_employee_name: employee, p_reason: `${copy.reason}: ${targetCode}` });
      } else {
        result = await window.atlasInventoryApi.rpc("add_inventory_location", { p_sku_id: sku.id, p_new_aisle: target.aisle, p_new_section: target.section, p_employee_name: employee, p_reason: `${copy.reason} at ${targetCode}` });
      }
      const saved = Array.isArray(result) ? result[0] : result;
      const locationId = saved?.location_id || saved?.id || target.id;
      renderSuccess(overlay, sku, target, mode, locationId, employee);
    } catch (error) {
      confirm.disabled = false;
      confirm.textContent = copy.button;
      showError(modal, error?.message || "ATLAS couldn't save this change. No changes were made. Please try again.");
    }
  };

  const renderSuccess = (overlay, sku, target, mode, locationId, employee) => {
    const modal = overlay.querySelector(".atlas-restock-modal");
    const copy = actionCopy[mode];
    const targetCode = locationCode(target);
    modal.innerHTML = `<p class="atlas-restock-kicker">${escapeHtml(copy.successKicker)}</p><h2>${escapeHtml(copy.successTitle)}</h2><p>${escapeHtml(sku.sku)} is now active at <strong>${escapeHtml(targetCode)}</strong>.</p><div class="atlas-restock-actions"><button type="button" class="primary" data-done>Done</button><button type="button" data-undo>Undo</button></div>`;
    modal.querySelector("[data-done]").addEventListener("click", () => window.location.reload());
    modal.querySelector("[data-undo]").addEventListener("click", () => undoAction(overlay, locationId, employee));
  };

  const undoAction = async (overlay, locationId, employee) => {
    const modal = overlay.querySelector(".atlas-restock-modal");
    const undo = modal.querySelector("[data-undo]");
    undo.disabled = true;
    undo.textContent = "Undoing…";
    try {
      await window.atlasInventoryApi.rpc("set_inventory_location_active", { p_location_id: locationId, p_is_active: false, p_employee_name: employee, p_reason: "Undo out-of-stock location update" });
      modal.innerHTML = `<p class="atlas-restock-kicker">CHANGE UNDONE</p><h2>Location update undone</h2><p>The location is no longer active for picker results.</p><div class="atlas-restock-actions"><button type="button" class="primary" data-done>Done</button></div>`;
      modal.querySelector("[data-done]").addEventListener("click", () => window.location.reload());
    } catch (error) {
      undo.disabled = false;
      undo.textContent = "Undo";
      showError(modal, error?.message || "ATLAS couldn't undo this change. Please try again.");
    }
  };

  const showError = (modal, message) => {
    modal.querySelector(".atlas-restock-error")?.remove();
    const error = document.createElement("p");
    error.className = "atlas-restock-error";
    error.textContent = message;
    modal.appendChild(error);
  };

  const attachRestock = (emptyState) => {
    if (!emptyState.closest(".result-card") || !/out of stock/i.test(emptyState.textContent || "")) return;
    const sku = emptyState.closest(".result-card").querySelector(".sku-copy strong")?.textContent?.trim();
    if (!sku) return;
    let trigger = emptyState.querySelector(".atlas-restock-trigger");
    if (!trigger) {
      trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "atlas-restock-trigger";
      trigger.textContent = "View Out of Stock Options";
      trigger.addEventListener("click", () => showRestock(trigger.dataset.atlasSku));
      emptyState.appendChild(trigger);
    }
    trigger.dataset.atlasSku = sku;
    if (emptyState.dataset.atlasRestockPrompted !== sku) {
      emptyState.dataset.atlasRestockPrompted = sku;
      window.setTimeout(() => showRestock(sku), 180);
    }
  };

  const scan = () => document.querySelectorAll(".empty-state.compact").forEach(attachRestock);
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", scan, { once: true });
  scan();
})();
