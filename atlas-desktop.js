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
  const inventoryActions = [
    { id: "browse", label: "Browse Inventory", title: "Browse Inventory", icon: "browse" },
    { id: "move", label: "Move Inventory", title: "Move Inventory", icon: "move" },
    { id: "clear", label: "Mark Location Empty", title: "Mark Location Empty", icon: "clear" },
    { id: "pick", label: "Manage Pick First", title: "Manage Pick First", icon: "pick" },
    { id: "create", label: "Create SKU", title: "Create New SKU", icon: "create" },
    { id: "edit", label: "Edit SKU", title: "Edit SKU", icon: "edit" },
    { id: "delete", label: "Delete SKU", title: "Delete SKU", icon: "delete" },
  ];
  const actionIcons = {
    browse:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z"></path><path d="M8 5v14M4 10h16M4 15h16"></path></svg>',
    move:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h13"></path><path d="m13 4 4 4-4 4"></path><path d="M20 16H7"></path><path d="m11 12-4 4 4 4"></path></svg>',
    clear:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14"></path><path d="M9 7V4h6v3"></path><path d="m7 7 1 13h8l1-13"></path><path d="M10 11v5M14 11v5"></path></svg>',
    pick:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"></path></svg>',
    create:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>',
    edit:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 19 3.4-.7L19 7.7 16.3 5 5.7 15.6 5 19Z"></path><path d="m14.8 6.5 2.7 2.7"></path></svg>',
    delete:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14"></path><path d="M9 7V4h6v3"></path><path d="m7 7 1 13h8l1-13"></path><path d="M10 11v5M14 11v5"></path></svg>',
  };
  const workflowByTitle = new Map([
    ["Move Inventory", "move"],
    ["Mark Location Empty", "clear"],
    ["Manage Pick First", "pick"],
    ["Create New SKU", "create"],
    ["Edit SKU", "edit"],
    ["Delete SKU", "delete"],
  ]);
  let sidebarState = null;
  let inventoryExpanded = false;
  let lastEnsuredInventoryAction = "";

  const visibleWorkflowTitle = () => {
    const candidates = [
      ...document.querySelectorAll(".view-page .workflow-heading h2, .view-page .page-title"),
    ];
    const activeHeading = candidates.find((node) => node.getClientRects().length);
    return activeHeading?.textContent?.trim() || "";
  };

  const pageMeta = () => {
    if (root.classList.contains("atlas-dashboard-open")) {
      return { key: "dashboard", title: "Operations Dashboard" };
    }
    if (document.querySelector(".atlas-story-backdrop")) {
      return { key: "about", title: "About ATLAS" };
    }
    const active = [...document.querySelectorAll(".bottom-nav button")].find(
      (button) => button.classList.contains("active"),
    );
    const label = active?.textContent?.trim().toLowerCase() || "home";
    if (label.includes("browse")) {
      return { key: "aisles", title: "Browse Warehouse Aisles" };
    }
    if (label.includes("inventory")) {
      const workflowTitle = visibleWorkflowTitle();
      return {
        key: "inventory",
        title: workflowTitle || "Inventory Command Center",
        inventoryAction: workflowByTitle.get(workflowTitle) || "",
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
    const label =
      target === "inventory"
        ? "Inventory"
        : target === "aisles"
          ? "Browse Aisles"
          : "Home";
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

  const activateInventoryAction = (actionId) => {
    const target = inventoryActions.find((action) => action.id === actionId);
    if (!target) return;
    inventoryExpanded = true;
    document.querySelectorAll("[data-atlas-inventory-action]").forEach((item) => {
      const isTarget = item.dataset.atlasInventoryAction === actionId;
      item.classList.toggle("is-active", isTarget);
      if (isTarget) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    if (actionId === "browse") {
      navigate("aisles");
      queueSync();
      return;
    }
    if (root.classList.contains("atlas-dashboard-open")) {
      sidebarState?.home?.click();
      window.requestAnimationFrame(() => activateInventoryAction(actionId));
      return;
    }
    navigate("inventory");
    let attempts = 0;
    const open = () => {
      const actionButton = [...document.querySelectorAll(".inventory-action")].find(
        (button) => button.textContent?.trim().includes(target.title),
      );
      if (actionButton) {
        actionButton.click();
        return;
      }
      if (attempts++ < 12) window.requestAnimationFrame(open);
    };
    window.requestAnimationFrame(open);
  };

  const replaceInventoryParent = (inventory) => {
    const desktopParent = inventory.cloneNode(true);
    desktopParent.removeAttribute("data-nav");
    desktopParent.classList.add("atlas-desktop-inventory-parent");
    desktopParent.dataset.atlasDesktopInventoryParent = "true";
    desktopParent.setAttribute("aria-expanded", "false");
    desktopParent.querySelector(".atlas-menu-label").textContent = "Inventory";
    desktopParent.querySelector(".atlas-menu-chevron").textContent = "›";
    inventory.replaceWith(desktopParent);
    return desktopParent;
  };

  const setInventoryExpanded = (expanded) => {
    inventoryExpanded = Boolean(expanded);
    const parent = document.querySelector("[data-atlas-desktop-inventory-parent]");
    const group = document.querySelector(".atlas-desktop-inventory-children");
    parent?.classList.toggle("is-expanded", inventoryExpanded);
    parent?.setAttribute("aria-expanded", String(inventoryExpanded));
    const chevron = parent?.querySelector(".atlas-menu-chevron");
    if (chevron) chevron.textContent = inventoryExpanded ? "⌄" : "›";
    if (group) group.hidden = !inventoryExpanded;
  };

  const ensureDesktopSidebar = () => {
    const nav = document.querySelector(".premium-drawer-nav.atlas-menu-nav");
    if (!nav) return null;
    if (nav.dataset.atlasDesktopNavigation === "true") return nav;

    const home = nav.querySelector('[data-nav="Home"]');
    const browse = nav.querySelector('[data-nav="Browse Aisles"]');
    const inventory = nav.querySelector('[data-nav="Inventory"]');
    const dashboard = nav.querySelector('[data-action="dashboard"]');
    const about = nav.querySelector('[data-action="about"]');
    if (!home || !browse || !inventory || !dashboard || !about) return null;

    sidebarState = { nav, home, browse, inventory, dashboard, about };
    const desktopInventory = replaceInventoryParent(inventory);
    const group = document.createElement("div");
    group.className = "atlas-desktop-inventory-children";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Inventory management tools");
    group.innerHTML = inventoryActions
      .map(
        (action) => `
          <button type="button" class="atlas-desktop-inventory-child" data-atlas-inventory-action="${action.id}">
            <span aria-hidden="true">${actionIcons[action.icon]}</span>
            <strong>${action.label}</strong>
          </button>`,
      )
      .join("");
    group.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-atlas-inventory-action]");
      if (!button) return;
      event.preventDefault();
      activateInventoryAction(button.dataset.atlasInventoryAction);
    });

    desktopInventory.addEventListener("click", (event) => {
      event.preventDefault();
      setInventoryExpanded(!inventoryExpanded);
    });

    home.querySelector(".atlas-menu-label").textContent = "Search SKU";
    dashboard.querySelector(".atlas-menu-label").textContent = "Dashboard";
    about.querySelector(".atlas-menu-label").textContent = "About ATLAS";
    nav.replaceChildren(home, desktopInventory, group, dashboard, about);
    nav.dataset.atlasDesktopNavigation = "true";
    setInventoryExpanded(false);
    return nav;
  };

  const restoreMobileSidebar = () => {
    if (!sidebarState) return;
    const { nav, home, browse, inventory, dashboard, about } = sidebarState;
    const desktopParent = nav.querySelector("[data-atlas-desktop-inventory-parent]");
    desktopParent?.replaceWith(inventory);
    nav.replaceChildren(home, browse, inventory, dashboard, about);
    home.querySelector(".atlas-menu-label").textContent = "HOME";
    browse.querySelector(".atlas-menu-label").textContent = "BROWSE AISLES";
    dashboard.querySelector(".atlas-menu-label").textContent = "DASHBOARD";
    about.querySelector(".atlas-menu-label").textContent = "ABOUT";
    delete nav.dataset.atlasDesktopNavigation;
    sidebarState = null;
    inventoryExpanded = false;
    lastEnsuredInventoryAction = "";
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
      "atlas-view-about",
    );
    root.classList.add(`atlas-view-${meta.key}`);

    const topbar = ensureTopbar();
    ensureDesktopSidebar();
    const title = topbar.querySelector("[data-desktop-page-title]");
    if (title) title.textContent = meta.title;
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
        (meta.key === "dashboard" && action === "dashboard") ||
        (meta.key === "about" && action === "about");
      item.classList.toggle("is-active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    document.querySelectorAll("[data-atlas-inventory-action]").forEach((item) => {
      const active =
        (meta.key === "aisles" && item.dataset.atlasInventoryAction === "browse") ||
        (meta.key === "inventory" &&
          item.dataset.atlasInventoryAction === meta.inventoryAction);
      item.classList.toggle("is-active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    if (meta.key === "inventory" || meta.key === "aisles") inventoryExpanded = true;
    setInventoryExpanded(inventoryExpanded);

    const activeInventoryItem = document.querySelector(".atlas-desktop-inventory-child.is-active");
    const activeInventoryAction = activeInventoryItem?.dataset.atlasInventoryAction || "";
    if (activeInventoryItem && activeInventoryAction !== lastEnsuredInventoryAction) {
      lastEnsuredInventoryAction = activeInventoryAction;
      window.requestAnimationFrame(() =>
        activeInventoryItem.scrollIntoView({ block: "nearest", inline: "nearest" }),
      );
    } else if (!activeInventoryItem) {
      lastEnsuredInventoryAction = "";
    }

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
      "atlas-view-about",
    );
    restoreMobileSidebar();
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
