(() => {
  "use strict";

  const desktopQuery = window.matchMedia(
    "(min-width: 1024px) and (hover: hover) and (pointer: fine)",
  );
  const root = document.documentElement;
  let observer = null;
  let clockTimer = null;
  let syncQueued = false;

  const icons = {
    search:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m15.5 15.5 5 5"></path></svg>',
    inventory:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 7.5 8-4.25 8 4.25-8 4.25L4 7.5Z"></path><path d="m4 7.5 8 4.25 8-4.25v9L12 20.75 4 16.5v-9Z"></path><path d="M12 11.75v9"></path></svg>',
    dashboard:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V11M10 20V5M16 20v-7M21 20H2"></path></svg>',
  };

  const pageMeta = () => {
    if (root.classList.contains("atlas-dashboard-open")) {
      return { key: "dashboard", title: "Operations Dashboard" };
    }
    const active = [...document.querySelectorAll(".bottom-nav button")].find(
      (button) => button.classList.contains("active"),
    );
    const label = active?.textContent?.trim().toLowerCase() || "home";
    if (label.includes("browse")) {
      return { key: "aisles", title: "Browse Warehouse Aisles" };
    }
    if (label.includes("inventory")) {
      const workflowTitle = document
        .querySelector(".view-page .workflow-heading h2, .view-page .page-title")
        ?.textContent?.trim();
      return {
        key: "inventory",
        title: workflowTitle || "Inventory Command Center",
      };
    }
    const sku = document
      .querySelector(".result-card .sku-copy strong")
      ?.textContent?.trim();
    return {
      key: "home",
      title: sku ? `SKU Search · ${sku}` : "Warehouse SKU Search",
    };
  };

  const ensureTopbar = () => {
    let topbar = document.querySelector(".atlas-desktop-topbar");
    if (topbar) return topbar;
    topbar = document.createElement("header");
    topbar.className = "atlas-desktop-topbar";
    topbar.setAttribute("aria-label", "ATLAS desktop command bar");
    topbar.innerHTML = `
      <div class="atlas-desktop-topbar__context">
        <span>ATLAS WAREHOUSE MANAGEMENT</span>
        <strong data-desktop-page-title>Warehouse SKU Search</strong>
      </div>
      <div class="atlas-desktop-topbar__actions">
        <div class="atlas-desktop-topbar__status" aria-live="polite">
          <i aria-hidden="true"></i>
          <span data-desktop-status>Live warehouse data</span>
          <time data-desktop-clock></time>
        </div>
        <button type="button" data-desktop-action="search">${icons.search}<span>Search SKU</span></button>
        <button type="button" data-desktop-action="inventory">${icons.inventory}<span>Inventory</span></button>
        <button type="button" data-desktop-action="dashboard">${icons.dashboard}<span>Dashboard</span></button>
      </div>`;
    document.body.appendChild(topbar);
    return topbar;
  };

  const updateClock = () => {
    const clock = document.querySelector("[data-desktop-clock]");
    if (!clock) return;
    const now = new Date();
    clock.dateTime = now.toISOString();
    clock.textContent = now.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const navigate = (target) => {
    if (target === "dashboard") {
      window.atlasOpenDashboard?.();
      return;
    }
    const label = target === "inventory" ? "Inventory" : "Home";
    const button = [...document.querySelectorAll(".bottom-nav button")].find(
      (item) => item.textContent?.trim().toLowerCase().includes(label.toLowerCase()),
    );
    button?.click();
    if (target === "search") {
      window.requestAnimationFrame(() => {
        const input = document.querySelector(".home-view .search-input");
        input?.focus({ preventScroll: false });
      });
    }
  };

  const syncDesktop = () => {
    syncQueued = false;
    if (!desktopQuery.matches) return;

    const meta = pageMeta();
    root.classList.remove(
      "atlas-view-home",
      "atlas-view-aisles",
      "atlas-view-inventory",
      "atlas-view-dashboard",
    );
    root.classList.add(`atlas-view-${meta.key}`);

    const topbar = ensureTopbar();
    const title = topbar.querySelector("[data-desktop-page-title]");
    if (title) title.textContent = meta.title;
    topbar.querySelectorAll("[data-desktop-action]").forEach((button) => {
      const action = button.dataset.desktopAction;
      const active =
        (meta.key === "home" && action === "search") ||
        (meta.key === "inventory" && action === "inventory") ||
        (meta.key === "dashboard" && action === "dashboard");
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const status = topbar.querySelector("[data-desktop-status]");
    if (status) {
      status.textContent = root.classList.contains("atlas-offline")
        ? "Offline warehouse data"
        : "Live warehouse data";
    }

    const backdrop = document.querySelector(".atlas-menu-backdrop");
    const drawer = document.querySelector(".atlas-menu-drawer");
    if (backdrop) backdrop.setAttribute("aria-hidden", "false");
    if (drawer) {
      drawer.setAttribute("aria-modal", "false");
      drawer.setAttribute("aria-label", "ATLAS primary navigation");
    }

    document.querySelectorAll(".atlas-menu-item").forEach((item) => {
      const nav = item.dataset.nav?.toLowerCase() || "";
      const action = item.dataset.action || "";
      const active =
        (meta.key === "home" && nav === "home") ||
        (meta.key === "aisles" && nav.includes("browse")) ||
        (meta.key === "inventory" && nav === "inventory") ||
        (meta.key === "dashboard" && action === "dashboard");
      item.classList.toggle("is-active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });

    updateClock();
  };

  const queueSync = () => {
    if (!desktopQuery.matches || syncQueued) return;
    syncQueued = true;
    window.requestAnimationFrame(syncDesktop);
  };

  const enableDesktop = () => {
    if (!desktopQuery.matches) return;
    root.classList.add("atlas-desktop");
    ensureTopbar().addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-desktop-action]");
      if (button) navigate(button.dataset.desktopAction);
    });
    if (!observer) {
      observer = new MutationObserver(queueSync);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "hidden", "data-sku"],
      });
    }
    if (!clockTimer) clockTimer = window.setInterval(updateClock, 30000);
    queueSync();
  };

  const disableDesktop = () => {
    root.classList.remove(
      "atlas-desktop",
      "atlas-view-home",
      "atlas-view-aisles",
      "atlas-view-inventory",
      "atlas-view-dashboard",
    );
    document.querySelector(".atlas-desktop-topbar")?.remove();
    observer?.disconnect();
    observer = null;
    if (clockTimer) window.clearInterval(clockTimer);
    clockTimer = null;
  };

  const handleQueryChange = () => {
    if (desktopQuery.matches) enableDesktop();
    else disableDesktop();
  };

  desktopQuery.addEventListener?.("change", handleQueryChange);
  window.addEventListener("DOMContentLoaded", handleQueryChange, { once: true });
  if (document.readyState !== "loading") handleQueryChange();
})();
