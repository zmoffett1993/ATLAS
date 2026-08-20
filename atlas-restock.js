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

  const showRestock = async (skuValue) => {
    if (!skuValue || document.querySelector(".atlas-restock-overlay")) return;
    const overlay = document.createElement("div");
    overlay.className = "atlas-restock-overlay";
    overlay.innerHTML = `<section class="atlas-restock-modal" role="dialog" aria-modal="true" aria-label="Restock ${escapeHtml(skuValue)}"><p class="atlas-restock-kicker">OUT OF STOCK</p><h2>Restock ${escapeHtml(skuValue)}?</h2><p>Checking this SKU’s last recorded location…</p></section>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) close(overlay); });

    try {
      const api = window.atlasInventoryApi;
      if (!api?.findSku || !api?.locations) throw Error("Inventory connection is unavailable.");
      const sku = await api.findSku(skuValue);
      if (!sku) throw Error("This SKU could not be found in ATLAS.");
      const locations = await api.locations(sku.id);
      const lastKnown = locations.find((location) => location.is_active === false) || null;
      renderChoice(overlay, sku, locations, lastKnown);
    } catch (error) {
      overlay.querySelector(".atlas-restock-modal").innerHTML = `<p class="atlas-restock-kicker">OUT OF STOCK</p><h2>Unable to load restock options</h2><p class="atlas-restock-error">Please try again or contact a supervisor.</p><div class="atlas-restock-actions"><button type="button" class="muted" data-close>Close</button></div>`;
      overlay.querySelector("[data-close]")?.addEventListener("click", () => close(overlay));
    }
  };

  const renderChoice = (overlay, sku, locations, lastKnown) => {
    const modal = overlay.querySelector(".atlas-restock-modal");
    modal.innerHTML = `<p class="atlas-restock-kicker">OUT OF STOCK</p><h2>Restock ${escapeHtml(sku.sku)}?</h2><p>This SKU is currently out of stock.${lastKnown ? ` Its last recorded location was <strong>${escapeHtml(locationCode(lastKnown))}</strong>.` : " No previous location is available."} Where would you like to place the incoming inventory?</p><div class="atlas-restock-actions">${lastKnown ? `<button type="button" data-last><strong>Use Last Known Location</strong><span class="atlas-restock-choice-code">${escapeHtml(locationCode(lastKnown))}</span></button>` : ""}<button type="button" class="secondary" data-new>Choose a Different Location</button><button type="button" class="muted" data-close>Not Now</button></div>`;
    modal.querySelector("[data-last]")?.addEventListener("click", () => renderConfirmation(overlay, sku, locations, lastKnown, lastKnown, true));
    modal.querySelector("[data-new]")?.addEventListener("click", () => renderNewLocation(overlay, sku, locations, lastKnown));
    modal.querySelector("[data-close]")?.addEventListener("click", () => close(overlay));
  };

  const renderNewLocation = (overlay, sku, locations, lastKnown) => {
    const modal = overlay.querySelector(".atlas-restock-modal");
    const aisles = Array.from({ length: 23 }, (_, index) => index + 1);
    const savedEmployee = localStorage.getItem("atlasEmployee") || "";
    modal.innerHTML = `<p class="atlas-restock-kicker">RESTOCK LOCATION</p><h2>Choose a location</h2><p>Select where the incoming inventory will be placed.</p><div class="atlas-restock-fields"><label>Aisle<select data-aisle>${aisles.map((aisle) => `<option value="${aisle}">${aisle === 22 ? "Overflow" : aisle === 23 ? "Samples Rack" : `Aisle ${aisle}`}</option>`).join("")}</select></label><label>Section<select data-section></select></label><label class="employee">Employee name or initials<input data-employee maxlength="60" value="${escapeHtml(savedEmployee)}" placeholder="Example: ZM" /></label></div><div class="atlas-restock-actions"><button type="button" class="primary" data-continue>Continue</button><button type="button" class="muted" data-back>Back</button></div>`;
    const aisle = modal.querySelector("[data-aisle]");
    const section = modal.querySelector("[data-section]");
    const updateSections = () => { section.innerHTML = sectionsFor(aisle.value).map((item) => `<option value="${item}">Section ${item}</option>`).join(""); };
    aisle.addEventListener("change", updateSections);
    updateSections();
    modal.querySelector("[data-continue]").addEventListener("click", () => {
      const employee = modal.querySelector("[data-employee]").value.trim();
      if (employee.length < 2) return showError(modal, "Enter at least two letters for the employee name or initials.");
      const chosen = { aisle: Number(aisle.value), section: section.value };
      const existing = locations.find((location) => Number(location.aisle) === chosen.aisle && String(location.section).toUpperCase() === chosen.section.toUpperCase()) || null;
      renderConfirmation(overlay, sku, locations, lastKnown, existing || chosen, Boolean(existing), employee);
    });
    modal.querySelector("[data-back]").addEventListener("click", () => renderChoice(overlay, sku, locations, lastKnown));
  };

  const renderConfirmation = (overlay, sku, locations, lastKnown, target, restoring, selectedEmployee) => {
    const modal = overlay.querySelector(".atlas-restock-modal");
    const employee = selectedEmployee || localStorage.getItem("atlasEmployee") || "";
    const targetCode = locationCode(target);
    modal.innerHTML = `<p class="atlas-restock-kicker">CONFIRM RESTOCK</p><h2>Add inventory to ${escapeHtml(targetCode)}?</h2><p>${escapeHtml(sku.sku)} will be available to pick from this location.</p><div class="atlas-restock-summary"><strong>SKU</strong>${escapeHtml(sku.sku)}<br /><strong style="margin-top:12px">Location</strong>${escapeHtml(targetCode)}<br /><strong style="margin-top:12px">Employee</strong>${escapeHtml(employee || "Not entered")}</div><div class="atlas-restock-actions"><button type="button" class="primary" data-confirm>Add Inventory</button><button type="button" class="muted" data-back>Back to Edit</button></div>`;
    modal.querySelector("[data-confirm]").addEventListener("click", () => saveRestock(overlay, sku, locations, lastKnown, target, restoring, employee));
    modal.querySelector("[data-back]").addEventListener("click", () => renderChoice(overlay, sku, locations, lastKnown));
  };

  const saveRestock = async (overlay, sku, locations, lastKnown, target, restoring, employee) => {
    const modal = overlay.querySelector(".atlas-restock-modal");
    if (employee.trim().length < 2) return renderNewLocation(overlay, sku, locations, lastKnown);
    const confirm = modal.querySelector("[data-confirm]");
    confirm.disabled = true;
    confirm.textContent = "Saving…";
    try {
      localStorage.setItem("atlasEmployee", employee.trim());
      await window.atlasInventoryApi.rpc("add_inventory_location", { p_sku_id: sku.id, p_new_aisle: target.aisle, p_new_section: target.section, p_employee_name: employee.trim(), p_reason: `Inventory replenished at ${locationCode(target)}` });
      modal.innerHTML = `<p class="atlas-restock-kicker">INVENTORY ADDED</p><h2>Inventory added successfully</h2><p>${escapeHtml(sku.sku)} is now available to pick from <strong>${escapeHtml(locationCode(target))}</strong>.</p><div class="atlas-restock-actions"><button type="button" class="primary" data-done>Done</button></div>`;
      modal.querySelector("[data-done]").addEventListener("click", () => window.location.reload());
    } catch (error) {
      confirm.disabled = false;
      confirm.textContent = "Add Inventory";
      showError(modal, "ATLAS couldn't add this inventory. No changes were made. Please try again.");
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
      trigger.textContent = "Restock Incoming Inventory";
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
