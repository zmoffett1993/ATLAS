(() => {
  "use strict";

  const workflowTitles = new Set([
    "Move Inventory",
    "Manage Pick First",
    "Create New SKU",
    "Edit SKU",
    "Delete SKU",
  ]);

  const workflowCopy = {
    "Move Inventory": {
      stepOne: "Search for a SKU",
      stepTwo: "Choose source and destination",
      success: "Inventory moved successfully",
      reviewLabel: "Review Move",
      confirmLabel: "Confirm Move",
    },
    "Manage Pick First": {
      stepOne: "Search for a SKU",
      stepTwo: "Select a location",
      success: "Pick First updated",
    },
    "Create New SKU": {
      stepOne: "Enter a SKU",
      stepTwo: "Choose the first location",
      success: "SKU created successfully",
      reviewLabel: "Review SKU",
      confirmLabel: "Create SKU",
    },
    "Edit SKU": {
      stepOne: "Search for a SKU",
      stepTwo: "Edit information",
      success: "SKU updated successfully",
      reviewLabel: "Review Changes",
      confirmLabel: "Save Changes",
    },
    "Delete SKU": {
      stepOne: "Search for a SKU",
      stepTwo: "Review this SKU",
      success: "Deletion request sent",
      reviewLabel: "Review deletion request",
      confirmLabel: "Request Deletion",
    },
  };

  let syncQueued = false;

  const escapeHtml = (value) =>
    String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

  const titleFor = (card) =>
    card
      ?.closest(".view-page")
      ?.querySelector(".workflow-heading h2")
      ?.textContent?.trim() || "";

  const directChild = (parent, selector) =>
    [...parent.children].find((node) => node.matches(selector)) || null;

  const makeStep = (key, number, title, success = false) => {
    const step = document.createElement("section");
    step.className = `atlas-guided-step${success ? " atlas-guided-step--success" : ""}`;
    step.dataset.atlasGuidedStep = key;
    step.innerHTML = `
      <div class="atlas-guided-step__heading">
        <span aria-hidden="true">${number}</span>
        <h3>${escapeHtml(title)}</h3>
      </div>`;
    return step;
  };

  const ensureStep = (card, key, number, title, reference, success = false) => {
    if (!card || !reference) return;
    let step = card.querySelector(`[data-atlas-guided-step="${key}"]`);
    if (!step) step = makeStep(key, number, title, success);
    if (step.nextElementSibling !== reference) {
      reference.insertAdjacentElement("beforebegin", step);
    }
  };

  const fieldFor = (card, prefix) =>
    [...card.querySelectorAll(".field")].find((field) =>
      field.firstElementChild?.textContent?.trim().startsWith(prefix),
    ) || null;

  const valueForField = (card, prefix) =>
    fieldFor(card, prefix)?.querySelector("input, select, textarea")?.value?.trim() || "";

  const selectedTextForField = (card, prefix) => {
    const control = fieldFor(card, prefix)?.querySelector("select");
    return control?.selectedOptions?.[0]?.textContent?.trim() || valueForField(card, prefix);
  };

  const employeeValue = (card) => valueForField(card, "Employee name or initials");

  const selectedSku = (card) =>
    card.querySelector(".selected-sku strong")?.textContent?.trim() ||
    card.querySelector(".sku-save-preview strong")?.textContent?.trim() ||
    "";

  const cardFor = (node) => node?.closest?.(".workflow-card") || null;

  const isBusy = (button) =>
    /saving|creating|deleting/i.test(button?.textContent || "");

  const readyForReview = (card, title) => {
    const employee = employeeValue(card);
    if (employee.length < 2) return false;

    if (title === "Move Inventory") return Boolean(selectedSku(card));
    if (title === "Create New SKU") {
      return Boolean(selectedSku(card) && card.querySelector(".confirm-sku input")?.checked);
    }
    if (title === "Edit SKU") {
      return Boolean(
        selectedSku(card) &&
          card.querySelector(".change-summary") &&
          card.querySelector(".confirm-sku input")?.checked,
      );
    }
    if (title === "Delete SKU") {
      const selected = card.querySelector(".selected-sku strong")?.textContent?.trim() || "";
      const confirmation = valueForField(card, "Type the full SKU or DELETE to confirm").toUpperCase();
      return Boolean(selected && (confirmation === "DELETE" || confirmation === selected.toUpperCase()));
    }
    return false;
  };

  const moveDestination = (card) => {
    const aisle = valueForField(card, "Aisle");
    const section = valueForField(card, "Section").toUpperCase();
    if (!aisle || !section) return "the selected destination";
    if (Number(aisle) === 22) {
      return `Overflow · ${({ A: "Left", B: "Middle", C: "Right" })[section] || section}`;
    }
    if (Number(aisle) === 23) return `Samples Rack · Section ${section}`;
    return `${aisle}${section}`;
  };

  const buildReview = (card, title) => {
    const sku = selectedSku(card) || "this SKU";
    if (title === "Move Inventory") {
      const mode = card.querySelector(".movement-mode.active strong")?.textContent?.replace(/SAFER DEFAULT/g, "").trim() || "Selected move";
      const source = selectedTextForField(card, "Original location") || "the current active source location";
      const impact = /move all/i.test(mode)
        ? `${source} will be removed from active locations.`
        : `${source} will remain an active location.`;
      return {
        heading: `Move ${sku}?`,
        body: impact,
        rows: [
          ["SKU", sku],
          ["From", source],
          ["Move type", mode],
          ["To", moveDestination(card)],
        ],
      };
    }
    if (title === "Create New SKU") {
      return {
        heading: `Create ${sku}?`,
        body: "ATLAS will create this canonical SKU and its first active warehouse location.",
        rows: [["SKU", sku]],
      };
    }
    if (title === "Edit SKU") {
      return {
        heading: "Save these SKU changes?",
        body: "Review the changes below before ATLAS updates the warehouse record.",
        rows: [["SKU", sku]],
      };
    }
    return {
      heading: `Delete ${sku}?`,
      body: "This sends a permanent deletion request for supervisor approval. ATLAS will not change inventory until the request is approved.",
      rows: [["SKU", sku]],
    };
  };

  const removeConfirmation = (card) => {
    card?.querySelector(".atlas-guided-confirmation")?.remove();
    document.querySelectorAll(".atlas-guided-review-overlay").forEach((node) => node.remove());
    document.body.classList.remove("atlas-guided-review-open");
    card?.querySelectorAll(".atlas-guided-pick-selected").forEach((node) =>
      node.classList.remove("atlas-guided-pick-selected"),
    );
  };

  const showFormConfirmation = (form, title, submitter) => {
    const card = cardFor(form);
    if (!card) return;
    removeConfirmation(card);
    const detail = buildReview(card, title);
    const overlay = document.createElement("div");
    overlay.className = "atlas-guided-review-overlay";
    const panel = document.createElement("section");
    panel.className = "atlas-guided-confirmation atlas-guided-confirmation--overlay";
    panel.dataset.atlasGuidedConfirmation = title;
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", `Confirm ${title}`);
    panel.innerHTML = `
      <div class="atlas-guided-step__heading">
        <span aria-hidden="true">3</span>
        <div>
          <small>FINAL REVIEW</small>
          <h3>${escapeHtml(detail.heading)}</h3>
        </div>
      </div>
      <p>${escapeHtml(detail.body)}</p>
      <dl>${detail.rows
        .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
        .join("")}</dl>
      <div class="atlas-guided-confirmation__actions">
        <button type="button" class="atlas-guided-cancel">Back to Edit</button>
        <button type="button" class="atlas-guided-confirm">${escapeHtml(workflowCopy[title].confirmLabel)}</button>
      </div>`;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    document.body.classList.add("atlas-guided-review-open");
    panel.querySelector(".atlas-guided-cancel")?.addEventListener("click", () => removeConfirmation(card));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) removeConfirmation(card);
    });
    panel.querySelector(".atlas-guided-confirm")?.addEventListener("click", () => {
      form.dataset.atlasGuidedConfirmed = "true";
      removeConfirmation(card);
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit(submitter && !submitter.disabled ? submitter : undefined);
      } else {
        submitter?.click();
      }
    });
    panel.querySelector(".atlas-guided-confirm")?.focus({ preventScroll: true });
  };

  const showPickFirstConfirmation = (button) => {
    const card = cardFor(button);
    if (!card) return;
    removeConfirmation(card);
    card.querySelectorAll(".pick-toggle").forEach((node) =>
      node.classList.toggle("atlas-guided-pick-selected", node === button),
    );
    const location = button.querySelector(".manage-location")?.textContent?.trim() || "this location";
    const enabled = button.classList.contains("enabled");
    const sku = selectedSku(card) || "this SKU";
    const panel = document.createElement("section");
    panel.className = "atlas-guided-confirmation atlas-guided-confirmation--pick";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Confirm Pick First change");
    panel.innerHTML = `
      <div class="atlas-guided-step__heading">
        <span aria-hidden="true">3</span>
        <div>
          <small>FINAL REVIEW</small>
          <h3>${enabled ? `Remove ${escapeHtml(location)} from Pick First?` : `Make ${escapeHtml(location)} Pick First?`}</h3>
        </div>
      </div>
      <p>${enabled ? `ATLAS will remove the Pick First preference from ${escapeHtml(location)} for ${escapeHtml(sku)}.` : `${escapeHtml(location)} will become the preferred picking location for ${escapeHtml(sku)}.`}</p>
      <dl><div><dt>SKU</dt><dd>${escapeHtml(sku)}</dd></div><div><dt>Location</dt><dd>${escapeHtml(location)}</dd></div></dl>
      <div class="atlas-guided-confirmation__actions">
        <button type="button" class="atlas-guided-cancel">Cancel</button>
        <button type="button" class="atlas-guided-confirm">${enabled ? "Remove Pick First" : "Confirm Pick First"}</button>
      </div>`;
    const list = card.querySelector(".manage-list");
    list?.insertAdjacentElement("afterend", panel);
    panel.querySelector(".atlas-guided-cancel")?.addEventListener("click", () => removeConfirmation(card));
    panel.querySelector(".atlas-guided-confirm")?.addEventListener("click", () => {
      button.dataset.atlasGuidedConfirmed = "true";
      panel.remove();
      button.classList.remove("atlas-guided-pick-selected");
      button.click();
    });
    panel.querySelector(".atlas-guided-confirm")?.focus({ preventScroll: false });
  };

  const tuneSubmit = (card, title) => {
    const button = [...card.querySelectorAll('button[type="submit"]')].find(
      (node) => !node.closest(".atlas-guided-confirmation"),
    );
    if (!button || isBusy(button) || card.querySelector(".atlas-guided-confirmation")) return;
    const label = workflowCopy[title]?.reviewLabel;
    button.classList.add("atlas-guided-review-trigger");
    if (label && button.textContent?.trim() !== label) button.textContent = label;
  };

  const enhanceCard = (card) => {
    if (card.classList.contains("atlas-cleared-workflow")) return;
    const title = titleFor(card);
    const copy = workflowCopy[title];
    if (!copy) return;
    card.classList.add("atlas-guided-workflow");
    const search = directChild(card, ".inventory-sku-search, .sku-search-field");
    ensureStep(card, "find", 1, copy.stepOne, search);

    let next = null;
    if (title === "Move Inventory") next = directChild(card, ".movement-mode-selector");
    if (title === "Manage Pick First") next = directChild(card, ".manage-list");
    if (title === "Create New SKU") next = directChild(card, ".form-grid");
    if (title === "Edit SKU") next = directChild(card, ".existing-sku-card")?.nextElementSibling || directChild(card, ".field");
    if (title === "Delete SKU") next = directChild(card, ".delete-warning");
    ensureStep(card, "configure", 2, copy.stepTwo, next);

    if (title !== "Manage Pick First") tuneSubmit(card, title);
    const success = directChild(card, ".workflow-message.success");
    if (success) {
      success.classList.add("atlas-guided-success-message");
      ensureStep(card, "success", 4, copy.success, success, true);
    }
  };

  const sync = () => {
    syncQueued = false;
    document.querySelectorAll(".workflow-card").forEach(enhanceCard);
  };

  const queueSync = () => {
    if (syncQueued) return;
    syncQueued = true;
    window.requestAnimationFrame(sync);
  };

  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const card = cardFor(form);
      const title = titleFor(card);
      if (!workflowTitles.has(title) || title === "Manage Pick First") return;
      if (form.dataset.atlasGuidedConfirmed === "true") {
        delete form.dataset.atlasGuidedConfirmed;
        return;
      }
      if (!readyForReview(card, title)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showFormConfirmation(form, title, event.submitter);
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest?.(".workflow-card .pick-toggle");
      if (!(button instanceof HTMLButtonElement)) return;
      const card = cardFor(button);
      if (titleFor(card) !== "Manage Pick First") return;
      if (button.dataset.atlasGuidedConfirmed === "true") {
        delete button.dataset.atlasGuidedConfirmed;
        return;
      }
      if (employeeValue(card).length < 2) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showPickFirstConfirmation(button);
    },
    true,
  );

  new MutationObserver(queueSync).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  document.addEventListener("DOMContentLoaded", queueSync, { once: true });
  queueSync();
})();
