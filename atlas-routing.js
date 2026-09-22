(() => {
  "use strict";

  const root = document.documentElement;
  const DEPOT = "4320 N Harbor Blvd, Fullerton, CA 92835";
  const state = { planningGeneration: 0, planningController: null, planned: null, loads: [], lockedTrips: [], assignments: {}, vanConfirmed: {}, truckPalletTarget: 11, dailyTripTarget: 3, open: false, ownerId: null, catalog: [], orders: [], draftPhotos: [], newUrls: [], allUrls: new Set(), editId: null, drag: null, importGeneration: 0 };
  const core = window.atlasRoutingCore;
  let photoGeneration = 0, photoController = null, photoSuggestion = null;
  const savedDay = { generation: 0, day: null, revision: 0, ready: false, dirty: false, busy: false, canEdit: false, message: "" };
  const history = { generation: 0, offset: 0, filters: {}, matches: [] };
  const todayPacific = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const documentNumbers = (value) => window.atlasRoutingStorage.references(value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean));
  const storage = () => window.atlasRoutingSavedDays;
  const reminders = () => window.atlasRoutingReminderController;
  let reminderDay = null;
  let printingTripSheet = false;
  let vehicleChanges = {};
  let intakeRequest = null;
  let draftGeneration = 0;
  let documentFlow = null;
  let cancelOrderDrag = () => {};
  let driverMode = false, entryGeneration = 0, accessReadOnly = false;
  const dispatchUI = { tab: "orders", query: "", move: null, lastPlan: null };
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const find = (selector) => document.getElementById("atlasDeliveryRouting")?.querySelector(selector);
  // Local SVG artwork keeps the routing UI crisp without external icon fonts.
  const iconPaths = {
    truck: '<path fill="currentColor" stroke="none" d="M2 5h12v11H2zM15 9h4l3 4v3h-7z"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
    van: '<path d="M2 7h14l5 5v6H2zM14 7v6h7"/><circle fill="white" cx="6" cy="18" r="2"/><circle fill="white" cx="18" cy="18" r="2"/>',
    map: '<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2zM9 3v16M15 5v16"/>',
    box: '<path fill="currentColor" stroke="none" d="m2 7 9 4v11l-9-5zm11 4 9-4v10l-9 5zM3 5l9-4 9 4-9 4z"/><path stroke="white" stroke-width="1" d="m7 3 10 4v4"/>',
    pallets: '<path fill="currentColor" stroke="none" d="m2 8 10-5 10 5-10 5z"/><path d="m2 12 10 5 10-5M2 16l10 5 10-5"/>',
    route: '<circle cx="6" cy="4" r="2"/><circle cx="18" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><path d="M6 6v3c0 4 12 2 12 6 0 4-10 0-10 4M18 6v2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    pin: '<path fill="currentColor" stroke="none" d="M12 23S4 14 4 9a8 8 0 1 1 16 0c0 5-8 14-8 14z"/><circle cx="12" cy="9" r="2.5" fill="white" stroke="none"/>',
    user: '<circle cx="12" cy="6" r="4" fill="currentColor" stroke="none"/><path fill="currentColor" stroke="none" d="M4 22v-4a8 8 0 0 1 16 0v4z"/>',
    users: '<circle cx="9" cy="7" r="3" fill="currentColor"/><path fill="currentColor" stroke="none" d="M2 21v-4a7 7 0 0 1 14 0v4zM17 11c6 0 6 6 6 10h-5v-4c0-2-1-4-2-5z"/><path d="M17 3a3 3 0 0 1 0 6"/>',
    gear: '<path fill="currentColor" stroke="none" d="m10 1 4 0 1 4 3-2 3 3-2 3 4 1v4l-4 1 2 3-3 3-3-2-1 4h-4l-1-4-3 2-3-3 2-3-4-1v-4l4-1-2-3 3-3 3 2z"/><circle cx="12" cy="12" r="4" fill="white" stroke="none"/>',
    document: '<rect x="4" y="2" width="16" height="20" rx="2" fill="currentColor" stroke="none"/><path stroke="white" stroke-width="1.5" d="M8 7h8M8 11h8M8 15h8M8 19h5"/>',
    dashboard: '<path fill="currentColor" stroke="none" d="M3 3h7v8H3zM13 3h8v5h-8zM3 14h7v7H3zM13 11h8v10h-8z"/>',
    inventory: '<path d="M3 8h18v13H3zM2 3h20v5H2zM9 12h6"/>',
    road: '<path fill="currentColor" stroke="none" d="M7 2h4v5H9l-1 5h3v5H7l-1 5H1zm6 0h4l6 20h-5l-1-5h-4v-5h3l-1-5h-2z"/>',
    chart: '<path fill="currentColor" stroke="none" d="M3 15h4v7H3zM10 9h4v13h-4zM17 2h4v20h-4z"/>',
    bulb: '<path d="M9 18h6M10 22h4M9 16c0-3-4-4-4-8a7 7 0 0 1 14 0c0 4-4 5-4 8M12 1v-1M2 3l-2-2M22 3l2-2M1 10H0M24 10h-1"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6M17 2v6M3 11h18"/>',
    template: '<rect x="7" y="3" width="14" height="18" rx="1"/><path d="M3 6v15M11 7h6M11 11h6M11 15h3"/>',
    print: '<path d="M6 9V3h12v6M6 18H3V9h18v9h-3M6 14h12v8H6zM17 12h1"/>',
    play: '<path fill="currentColor" stroke="none" d="m7 3 14 9-14 9z"/>',
    camera: '<path d="M3 6h4l2-3h6l2 3h4v15H3z"/><circle cx="12" cy="13" r="4"/>',
    upload: '<path d="M12 16V2m-5 5 5-5 5 5M3 16v6h18v-6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    chevron: '<path d="m7 9 5 5 5-5"/>',
    expand: '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>',
  };
  const icon = (name) => '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + iconPaths[name] + '</svg>';
  const warehouseArt = '<svg class="atlas-route-warehouse" viewBox="0 0 190 680" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><pattern id="atlasRouteCases" width="34" height="55" patternUnits="userSpaceOnUse"><path fill="#b1c7d6" fill-opacity=".14" d="M3 7h27v38H3z"/><path stroke="#bed9eb" stroke-opacity=".18" d="M16 7v15M3 45h27"/></pattern></defs><path fill="#234257" d="M0 0h190v680H0z"/><path fill="url(#atlasRouteCases)" d="M0 15h74v600H0zM119 15h71v600h-71z"/><g fill="none" stroke="#89adc6" stroke-opacity=".32" stroke-width="3"><path d="M8 0v660M70 0v610M123 0v610M183 0v660M8 70l62 45M8 190l62 30M8 310l62 15M8 430h62M8 550l62-15M123 115l60-45M123 220l60-30M123 325l60-15M123 430h60M123 535l60 15M8 70l62 150M8 190l62 135M8 310l62 120M8 430l62 105M183 70l-60 150M183 190l-60 135M183 310l-60 120M183 430l-60 105"/></g><path fill="#9db3c1" fill-opacity=".15" d="m70 535 53 0 67 145H0z"/><path stroke="#c7e5fa" stroke-opacity=".2" d="m0 680 94-210 96 210M0 640h190M31 585h125"/><g fill="#c5e8ff"><circle cx="20" cy="65" r="2"/><circle cx="174" cy="171" r="2"/><circle cx="12" cy="319" r="2"/></g></svg>';

  const card = (title, content, extraClass = "") => `<section class="atlas-route-card ${extraClass}"><h2>${title}</h2>${content}</section>`;

  function mount() {
    if (document.getElementById("atlasDeliveryRouting")) return;
    const section = document.createElement("section");
    section.id = "atlasDeliveryRouting";
    section.className = "atlas-route";
    section.hidden = true;
    section.setAttribute("aria-label", "ATLAS Delivery Routing");
    section.innerHTML = `
      <aside class="atlas-route-sidebar" aria-label="ATLAS navigation">
        <div class="atlas-route-logo"><img src="./atlas-brand-landscape-dark.svg?v=128" alt="ATLAS" /></div>
        ${warehouseArt}
        <nav>
          <button type="button" data-route-leave="Dashboard">${icon("dashboard")}<span>Dashboard</span></button>
          <button type="button" data-route-leave="Inventory">${icon("inventory")}<span>Inventory</span></button>
          <button type="button" data-route-leave="Workflows">${icon("document")}<span>COC</span></button>
          <button type="button" class="is-active" aria-current="page">${icon("truck")}<span>Delivery Routing</span></button>
        </nav>
        <p class="atlas-route-sidebar-note">A STRONGER<br />SUPPLY CHAIN<br />MOVES TOMORROW</p>
      </aside>
      <main class="atlas-route-main">
        <header class="atlas-route-header">
          <div><button type="button" class="atlas-route-button" data-route-host-menu>ATLAS Menu</button><h1>Daily Route Optimizer</h1><p>Optimize deliveries with primary-driver-first logic</p></div>
          <div class="atlas-route-header-actions"><label class="atlas-route-date">${icon("calendar")}<span>Planning day</span> <input type="date" data-route-date /></label><button type="button" class="atlas-route-button" data-route-history>${icon("calendar")}Saved Routes</button><button type="button" class="atlas-route-button atlas-route-primary" data-route-optimize disabled title="Add orders and connect routing to calculate traffic and timing">${icon("play")}Optimize Routes</button><button type="button" class="atlas-route-account" data-route-account aria-label="ATLAS account"><span class="atlas-route-avatar" data-route-avatar></span><span><strong data-route-user></strong><small>Delivery planning</small></span>${icon("chevron")}</button></div>
        </header>
        <div class="atlas-route-daybar"><span data-route-save-status role="status"></span><div class="atlas-route-day-actions"><button type="button" class="atlas-route-button" data-route-save-day>${icon("check")}Save Day</button><details class="atlas-route-day-menu"><summary>Day actions ${icon("chevron")}</summary><div><button type="button" class="atlas-route-button" data-route-load-day>View Saved Day</button><button type="button" class="atlas-route-button" data-route-reminders>${icon("clock")}Delivery Reminders</button><button type="button" class="atlas-route-button" data-route-confirm-day>All Delivered</button><p>All Delivered records your confirmation; select Save Day afterward. Sent-out orders without an issue are assumed delivered after 5 PM Pacific. Future plans are never completed automatically.</p></div></details></div></div>
        <details class="atlas-route-help"><summary>About this planning preview</summary><p>Review each photo reading, then select Add Order. Save Route stores the reviewed day. Saved days keep order details, specifications and load assignments; order-entry photos are temporary. Recalculate routes for current traffic.</p></details>
        <div class="atlas-route-notice" data-route-review-request hidden role="status"><span data-route-review-request-text></span><button type="button" class="atlas-route-button" data-route-review-request-open>Review Saved Deliveries</button></div>
        <div class="atlas-route-grid">
          <div class="atlas-route-column">
            ${card(`${icon("gear")} Route Setup`, `<div class="atlas-route-fields">
              <div class="atlas-route-field atlas-route-field-wide"><span>${icon("pin")} Chubby Gorilla / Start &amp; Finish</span><strong>Chubby Gorilla Warehouse</strong><small>${DEPOT}</small></div>
              <div class="atlas-route-field"><span>${icon("users")} Primary Driver Strategy</span><strong>Prioritize one driver</strong></div>
              <div class="atlas-route-field"><span>${icon("user")} Main Driver</span><strong>Bubba · Truck / Van</strong><small>6:00 AM–3:00 PM · depart 6:30 AM</small></div>
              <div class="atlas-route-field"><span>${icon("user")} Relief Driver</span><strong>Achmad · Cargo Van</strong><small>8:00 AM–5:00 PM · when needed</small></div>
              <label class="atlas-route-field"><span>${icon("truck")} Truck Pallet Target</span><input type="number" min="1" step="1" value="11" data-route-truck-target /><small>Usually 11 · adjust for the load</small></label>
              <div class="atlas-route-field"><span>${icon("van")} Cargo Vans · 2 Available</span><strong>2 pallets or loose boxes each</strong><small>Matching Nissan NV · 80% target</small></div>
              <label class="atlas-route-field"><span>${icon("pallets")} Typical Trips</span><input type="number" min="1" step="1" value="3" data-route-trip-target /><small>Extra trips allowed when needed</small></label>
            </div><div class="atlas-route-catalog-bar"><span data-route-catalog-status>Load product specifications to calculate pallets and van estimates.</span><label class="atlas-route-button">${icon("upload")}Load Product Specifications<input type="file" accept=".xlsx" data-route-catalog class="atlas-route-file-input" /></label></div>`)}
            ${card(`${icon("document")} Today's Deliveries`, `<div class="atlas-route-card-tools atlas-route-order-tools"><span>Photograph an order to add a delivery.</span><button type="button" class="atlas-route-button atlas-route-primary" data-route-intake>${icon("camera")}Add Orders</button><button type="button" class="atlas-route-button" data-route-manual-order>Enter Manually</button></div>
              <div class="atlas-route-capture-summary" data-route-capture-summary hidden></div>
              <div class="atlas-route-capacity" data-route-capacity role="status"></div>
              <div class="atlas-route-table-scroll"><table><thead><tr><th>#</th><th>Customer</th><th>City</th><th>Pallets</th><th>Time Window</th><th>Notes</th></tr></thead><tbody data-route-orders></tbody></table></div>
              <div class="atlas-route-summary"><div>${icon("box")}<span>Total Deliveries<strong data-route-total-orders>0</strong></span></div><div>${icon("pallets")}<span>Total Pallets<strong data-route-total-pallets>—</strong></span></div><div>${icon("truck")}<span>Vehicles Available<strong>Box Truck + 2 Cargo Vans</strong></span></div><div>${icon("road")}<span>Estimated Trips<strong data-route-total-trips>—</strong></span></div></div>`)}
            ${card(`${icon("route")} Optimized Plan`, `<details class="atlas-route-plan-settings"><summary>${icon("gear")}Planning settings</summary><div class="atlas-route-planner-options"><label><input type="checkbox" data-route-preserve /> Keep my stop order</label><label>Reload minutes<input type="number" min="0" max="120" value="40" data-route-reload /></label><label>Achmad lunch starts<input type="time" min="11:00" max="13:00" value="12:00" data-route-lunch /></label></div><p class="atlas-route-intake-note">Bubba: flexible one-hour lunch between stops or loads · Pacific time · Achmad’s first van departure is estimated at 8:30 AM.</p></details><div data-route-trip-controls></div><p data-route-progress role="status"></p><button type="button" class="atlas-route-button" data-route-stop hidden>Stop calculation</button><div data-route-plan></div>`)}
          </div>
          <div class="atlas-route-column">
            ${card(`${icon("map")} Route Map <span class="atlas-route-map-label">Preview</span>`, `<div class="atlas-route-map" data-route-map><div class="atlas-route-map-grid"></div><span class="atlas-route-map-pin">${icon("pin")}<strong>Chubby Gorilla</strong><small>Fullerton, CA</small></span><p>Google map loads when you calculate routes.</p></div>`, "atlas-route-map-card")}
            <div class="atlas-route-kpis"><div>${icon("clock")}<span>Total Drive Time<strong data-route-drive>—</strong></span></div><div>${icon("road")}<span>Total Distance<strong data-route-distance>—</strong></span></div><div>${icon("chart")}<span>Driver Utilization<strong data-route-utilization>—</strong></span></div><div>${icon("box")}<span>Freight Loaded<strong data-route-freight title="Pallet spaces assigned to the load plan">—</strong></span></div></div>
            ${card(`${icon("users")} Relief Driver`, `<div class="atlas-route-relief"><strong>${icon("check")}Achmad · standby</strong><p>Available when Bubba needs help with the day's load or schedule. Typical lunch is 12:00–1:00 PM and can move when needed.</p></div>`)}
          </div>
        </div>
      </main>
      <dialog class="atlas-route-intake" aria-labelledby="atlasRouteIntakeTitle"><form data-route-order-form>
        <button type="button" class="atlas-route-close" aria-label="Close" data-route-cancel>×</button><h2 id="atlasRouteIntakeTitle">Add Order</h2><p role="status" data-route-entry-status></p><p data-route-intake-day></p><label class="atlas-route-check-option" data-route-cutoff-exception-wrap hidden><input type="checkbox" data-route-cutoff-exception /> Same-day exception: I am assigning this afternoon delivery</label>
        <p>Photograph the sales order, packing list, and invoice for one delivery. Check the Ship To address, SKU and boxes before adding it to the day.</p>
        <div class="atlas-route-photo-actions"><label class="atlas-route-button">Take Photo<input type="file" accept="image/*" capture="environment" data-route-camera class="atlas-route-file-input" /></label><label class="atlas-route-button">Choose Photos<input type="file" accept="image/*" multiple data-route-images class="atlas-route-file-input" /></label><button type="button" class="atlas-route-button atlas-route-primary" data-route-read disabled>Read Photos</button><button type="button" class="atlas-route-button" data-route-stop-reading hidden>Cancel reading</button></div>
        <p class="atlas-route-intake-note" data-route-photo-help></p><p role="status" data-route-photo-status></p><div class="atlas-route-preview" data-route-preview></div>
        <section class="atlas-route-photo-review" data-route-photo-review hidden aria-label="Photo reading review"></section>
        <div class="atlas-route-form-grid"><label>Order number<input name="orderNumber" required maxlength="80" autocomplete="off" /></label><label>Customer<input name="customer" required maxlength="160" autocomplete="off" /></label><label class="atlas-route-form-wide">Ship-to address<input name="address" required maxlength="300" autocomplete="off" /></label><label>City<input name="city" required maxlength="100" autocomplete="off" /></label><label>Time Window<input name="timeWindow" maxlength="100" placeholder="Leave blank unless specified" /></label><label>Minutes at stop<input name="serviceMinutes" type="number" min="1" max="480" value="25" required /></label></div>
        <div class="atlas-route-order-lines" data-route-lines></div><button type="button" class="atlas-route-button" data-route-add-line>+ Add SKU</button>
        <div class="atlas-route-form-grid"><label>Invoice numbers<input name="invoiceNumbers" maxlength="1619" placeholder="Separate multiple numbers with commas" /></label><label>Item Fulfillment numbers<input name="fulfillmentNumbers" maxlength="1619" placeholder="Separate multiple numbers with commas" /></label></div>
        <fieldset class="atlas-route-delivery-confirmation"><legend>Delivery status</legend><label>Sent-out date<input name="dispatchedOn" type="date" /></label><label class="atlas-route-check-option"><input type="checkbox" name="delivered" /> Confirmed Delivered</label><label>Actual delivered date<input name="deliveredOn" type="date" /></label><label>Delivery issue / exception<textarea name="deliveryException" maxlength="500" rows="2" placeholder="Leave blank unless a shipment was not delivered or needs follow-up"></textarea></label><p>Split orders are marked sent out only after all their shipments leave. Use the manual sent-out date for older records or corrections. After 5 PM, orders without an issue are assumed delivered; this is separate from confirmation in WhatsApp or from the driver. Select Save Day afterward.</p></fieldset>
        <label class="atlas-route-form-label">Notes<textarea name="notes" rows="2" maxlength="1000"></textarea></label><label class="atlas-route-check-option"><input type="checkbox" name="checkOnDelivery" /> CHECK ON DELIVERY</label>
        <p class="atlas-route-intake-note">Case Qty is the total number of boxes. Item Qty is the total number of units. COD alone does not mark a check collection.</p><p class="atlas-route-form-error" role="alert" data-route-form-error></p><div class="atlas-route-card-tools"><button type="submit" class="atlas-route-button atlas-route-primary">Add to This Day</button><button type="submit" class="atlas-route-button" data-route-add-next>Add &amp; Next Order</button></div><p class="atlas-route-intake-note" data-route-entry-save-help></p>
      </form></dialog>
      <dialog class="atlas-route-intake" data-route-saved-review aria-label="Saved day review"><h2>Saved Day</h2><div data-route-saved-details></div><p>Loading this version replaces the orders and settings currently in this tab. Temporary photos will be cleared.</p><button type="button" class="atlas-route-button atlas-route-primary" data-route-use-saved>Load This Saved Version</button><button type="button" class="atlas-route-button" data-route-close-saved>Keep My Current Work</button></dialog>
      <dialog class="atlas-route-intake atlas-route-history" data-route-history-dialog aria-labelledby="atlasRouteHistoryTitle"><button type="button" class="atlas-route-close" aria-label="Close saved routes" data-route-close-history>×</button><h2 id="atlasRouteHistoryTitle">Saved Routes</h2><p>Find a shipment by its document number or date. Scheduled dates are separate from confirmed delivery dates.</p>
        <form data-route-history-form><div class="atlas-route-form-grid"><label class="atlas-route-form-wide">Sales Order, Invoice, or Item Fulfillment number<input name="query" maxlength="80" type="search" placeholder="Enter all or part of a number" /></label><label>Date to search<select name="dateField"><option value="planned">Scheduled day</option><option value="delivered">Delivery date (confirmed or assumed)</option></select></label><label>From<input name="from" type="date" /></label><label>Through<input name="to" type="date" /></label></div><button class="atlas-route-button atlas-route-primary" type="submit">Search Saved Routes</button></form>
        <p data-route-history-status role="status"></p><div data-route-history-results></div><div class="atlas-route-card-tools"><button class="atlas-route-button" type="button" data-route-history-prev disabled>Previous</button><button class="atlas-route-button" type="button" data-route-history-next disabled>Next</button></div>
      </dialog>`;
    document.body.appendChild(section);
    initializeDispatchUI(section);
    initializeDocumentFlow(section);
    const reminderDialog = document.createElement("dialog");
    reminderDialog.className = "atlas-route-intake atlas-route-reminders";
    reminderDialog.setAttribute("data-route-reminder-dialog", "");
    reminderDialog.setAttribute("aria-labelledby", "atlasRouteReminderTitle");
    reminderDialog.innerHTML = `<h2 id="atlasRouteReminderTitle">Delivery Reminders</h2><p><strong>Zach only · Monday–Friday · 5:00 PM Pacific</strong></p><p>One reminder on days with sent-out deliveries still needing review. No reminders to Bubba, Achmad, or other team members.</p><p>Opening a reminder does not confirm deliveries. You can choose All Delivered or record an issue, then Save Day.</p><p data-route-reminder-status role="status"></p><p class="atlas-route-intake-note">iPhone: add ATLAS to your Home Screen and open it there before enabling notifications. Android: use a browser that supports notifications. Each device needs your permission.</p><div class="atlas-route-card-tools"><button type="button" class="atlas-route-button atlas-route-primary" data-route-reminder-enable disabled>Enable on This Device</button><button type="button" class="atlas-route-button" data-route-reminder-disable hidden>Turn Off on This Device</button><button type="button" class="atlas-route-button" data-route-reminder-close>Close</button></div>`;
    section.appendChild(reminderDialog);
    const tripDialog = document.createElement("dialog");
    tripDialog.className = "atlas-route-intake atlas-route-trip-sheet";
    tripDialog.setAttribute("aria-label", "Driver trip sheet");
    tripDialog.innerHTML = `<div class="atlas-route-sheet-actions"><button type="button" class="atlas-route-button atlas-route-primary" data-route-print-sheet>${icon("print")}Print / Save PDF</button><button type="button" class="atlas-route-button" data-route-close-sheet>Close</button></div><div data-route-sheet-content></div>`;
    section.appendChild(tripDialog);
    tripDialog.addEventListener("close", () => { if (!tripDialog.open) clearTripSheet(); });
    section.querySelector("[data-route-date]").value = new Date().toLocaleDateString("en-CA");
    section.addEventListener("click", (event) => {
      if (event.target.closest(".atlas-route-day-menu button")) find(".atlas-route-day-menu").open = false;
      if (event.target.closest("[data-route-review-request-open]") && reminderDay && storage()?.enabled) {
        const form = find("[data-route-history-form]");
        form.elements.query.value = ""; form.elements.dateField.value = "delivered"; form.elements.from.value = form.elements.to.value = reminderDay;
        find("[data-route-review-request]").hidden = true;
        find("[data-route-history-dialog]").showModal(); void searchHistory(0);
      }
      if (event.target.closest("[data-route-reminders]")) { showReminderStatus(); find("[data-route-reminder-dialog]").showModal(); }
      if (event.target.closest("[data-route-reminder-close]")) find("[data-route-reminder-dialog]").close();
      if (event.target.closest("[data-route-reminder-enable]")) { const pending = reminders()?.enable(); showReminderStatus(); void pending?.finally(showReminderStatus); }
      if (event.target.closest("[data-route-reminder-disable]")) { const pending = reminders()?.disable(); showReminderStatus(); void pending?.finally(showReminderStatus); }
      if (event.target.closest("[data-route-save-day]")) void saveDay();
      if (event.target.closest("[data-route-confirm-day]")) updateDeliveryDay();
      if (event.target.closest("[data-route-lock-next]")) void lockNextTrip();
      if (event.target.closest("[data-route-reopen-last]")) void reopenLastTrip();
      if (event.target.closest("[data-route-load-day]")) void loadDay(true);
      if (event.target.closest("[data-route-history]")) { find("[data-route-history-dialog]").showModal(); void searchHistory(0); }
      if (event.target.closest("[data-route-close-history]")) find("[data-route-history-dialog]").close();
      if (event.target.closest("[data-route-history-prev]")) void searchHistory(history.offset - 50, true);
      if (event.target.closest("[data-route-history-next]")) void searchHistory(history.offset + 50, true);
      const historyResult = event.target.closest("[data-route-open-history]");
      if (historyResult) void openHistoryResult(Number(historyResult.dataset.routeOpenHistory));
      if (event.target.closest("[data-route-close-saved]")) find("[data-route-saved-review]").close();
      if (event.target.closest("[data-route-host-menu]")) document.querySelector(".premium-menu-button")?.click();
      if (event.target.closest("[data-route-optimize]")) void optimizeDay();
      const relief = event.target.closest("[data-route-try-relief]");
      if (relief && !state.planningController && state.ownerId === window.AtlasAuth?.getSession()?.user?.id) {
        const option = getReliefOptions(state.planned).find((item) => item.tripIndex === Number(relief.dataset.routeTryRelief));
        if (option) {
          state.assignments[option.tripIndex] = option.assignment;
          state.vanConfirmed[option.tripIndex] = false;
          delete vehicleChanges[option.tripIndex];
          renderOrders({ keepAssignments: true });
          void optimizeDay();
        }
      }
      const printTrip = event.target.closest("[data-route-print-trip]");
      if (printTrip) openTripSheet(Number(printTrip.dataset.routePrintTrip));
      if (event.target.closest("[data-route-close-sheet]")) clearTripSheet();
      if (event.target.closest("[data-route-print-sheet]") && state.open && state.planned?.complete && state.ownerId === window.AtlasAuth?.getSession()?.user?.id) window.print();
      if (event.target.closest("[data-route-adjust]")) renderOrders({ keepAssignments: true });
      if (event.target.closest("[data-route-stop]")) { state.planningController?.abort(); find("[data-route-progress]").textContent = "Calculation stopped. Completed trips remain below; the day is incomplete."; }
      if (event.target.closest("[data-route-account]")) window.AtlasAuth?.open();
      if (event.target.closest("[data-route-intake]")) openCapture();
      if (event.target.closest("[data-route-manual-order]")) openDraft();
      const leave = event.target.closest("[data-route-leave]");
      if (leave) leaveRouting(leave.dataset.routeLeave);
      const edit = event.target.closest("[data-route-edit]");
      if (edit) openDraft(edit.dataset.routeEdit);
      if (event.target.closest("[data-route-add-line]")) addLine();
      if (event.target.closest("[data-route-read]")) void readPhotos();
      if (event.target.closest("[data-route-stop-reading]")) { cancelPhotoReading(); find("[data-route-photo-status]").textContent = "Reading canceled. Your photos and entered fields remain available."; }
      if (event.target.closest("[data-route-use-reading]")) applyPhotoReading();
      const removePhoto = event.target.closest("[data-route-remove-photo]");
      if (removePhoto) {
        cancelPhotoReading();
        const [photo] = state.draftPhotos.splice(Number(removePhoto.dataset.routeRemovePhoto), 1);
        if (photo && state.newUrls.includes(photo.url)) { URL.revokeObjectURL(photo.url); state.allUrls.delete(photo.url); state.newUrls = state.newUrls.filter((url) => url !== photo.url); }
        renderPhotos();
      }
      if (event.target.closest("[data-route-cancel]")) find(".atlas-route-intake").close();
      const removeLine = event.target.closest("[data-route-remove-line]");
      if (removeLine && find("[data-route-lines]").children.length > 1) removeLine.closest(".atlas-route-line").remove();
      const move = event.target.closest("[data-route-move]");
      if (move) {
        const day = dayOrders();
        const index = day.findIndex((order) => order.id === move.dataset.id);
        const target = day[index + Number(move.dataset.routeMove)];
        if (target) moveOrder(move.dataset.id, target.id);
      }
    });
    find("[data-route-order-form]").addEventListener("submit", saveDraft);
    find("[data-route-history-form]").addEventListener("submit", (event) => { event.preventDefault(); void searchHistory(0); });
    find("[data-route-history-dialog]").addEventListener("close", () => { history.generation++; history.matches = []; find("[data-route-history-results]").replaceChildren(); });
    find('[name="delivered"]').addEventListener("change", (event) => {
      const field = find('[name="deliveredOn"]'); field.disabled = !event.target.checked; field.required = event.target.checked;
      if (event.target.checked && !field.value) field.value = todayPacific();
      if (!event.target.checked) field.value = "";
    });
    find(".atlas-route-intake").addEventListener("close", cleanupDraft);
    find("[data-route-cutoff-exception]").addEventListener("change", showIntakeDay);
    section.addEventListener("input", (event) => {
      const key = event.target.matches("[data-route-truck-target]") ? "truckPalletTarget" : event.target.matches("[data-route-trip-target]") ? "dailyTripTarget" : null;
      if (key && Number.isSafeInteger(Number(event.target.value)) && Number(event.target.value) >= 1) {
        state[key] = Number(event.target.value); renderOrders();
      }
      if (storage()?.enabled && event.target.matches("[data-route-truck-target], [data-route-trip-target], [data-route-reload], [data-route-lunch]")) {
        savedDay.dirty = true; savedDay.message = ""; showSaveStatus();
      }
    });
    find("[data-route-date]").addEventListener("change", () => {
      if (window.atlasRoutingPOD?.hasPending() && !window.confirm("These POD pages are still saving or could not be saved. Leave without saving them?")) { find("[data-route-date]").value = savedDay.day; return; }
      window.atlasRoutingPOD?.reset();
      if (driverMode) { void window.atlasRoutingPOD?.load(); return; }
      if (!storage()?.enabled) { renderOrders(); return; }
      if (savedDay.dirty && !window.confirm("This day has unsaved changes. Leave them and open the other day?")) { find("[data-route-date]").value = savedDay.day; return; }
      void loadDay().then(() => { if (dispatchUI.tab === "pods") void window.atlasRoutingPOD?.load(); });
    });
    for (const selector of ["[data-route-preserve]", "[data-route-reload]", "[data-route-lunch]"]) find(selector).addEventListener("change", renderOrders);
    section.addEventListener("change", (event) => {
      if (event.target.matches("[data-route-confirm-van]")) {
        if (Number(event.target.dataset.routeConfirmVan) < state.lockedTrips.length) { renderOrders({ keepAssignments: true, dirty: false }); return; }
        state.vanConfirmed[event.target.dataset.routeConfirmVan] = event.target.checked;
        renderOrders({ keepAssignments: true });
      }
      if (event.target.matches("[data-route-assignment]")) {
        if (Number(event.target.dataset.routeAssignment) < state.lockedTrips.length) { renderOrders({ keepAssignments: true, dirty: false }); return; }
        delete vehicleChanges[event.target.dataset.routeAssignment];
        state.assignments[event.target.dataset.routeAssignment] = event.target.value;
        state.vanConfirmed[event.target.dataset.routeAssignment] = false;
        renderOrders({ keepAssignments: true });
      }
    });
    for (const [selector, key] of [["[data-route-truck-target]", "truckPalletTarget"], ["[data-route-trip-target]", "dailyTripTarget"]]) {
      find(selector).addEventListener("change", (event) => {
        const value = Number(event.target.value);
        if (!Number.isSafeInteger(value) || value < 1) { event.target.value = state[key]; return; }
        state[key] = value;
        renderOrders();
      });
    }
    find("[data-route-catalog]").addEventListener("change", importCatalog);
    for (const selector of ["[data-route-images]", "[data-route-camera]"]) find(selector).addEventListener("change", (event) => {
      const files = [...event.target.files];
      if (files.length + state.draftPhotos.length > 20 || files.some((file) => file.size > 15 * 1024 * 1024 || !/^image\/(?:jpeg|png|webp|heic|heif)$/i.test(file.type))) {
        find("[data-route-form-error]").textContent = "Use up to 20 JPEG, PNG, WebP or HEIC photos per order, each smaller than 15 MB.";
        event.target.value = "";
        return;
      }
      cancelPhotoReading();
      files.forEach((file) => {
        const url = URL.createObjectURL(file);
        state.allUrls.add(url);
        state.newUrls.push(url);
        state.draftPhotos.push({ url, name: file.name, file });
      });
      event.target.value = "";
      renderPhotos();
    });
    installOrderDragging(section);
    renderOrders({ dirty: false });
  }

  function initializeDispatchUI(section) {
    const main = find(".atlas-route-main"), columns = [...main.querySelectorAll(".atlas-route-column")];
    const setup = find("[data-route-truck-target]").closest(".atlas-route-card");
    const orders = find("[data-route-orders]").closest(".atlas-route-card"); orders.dataset.dispatchOrders = "";
    const plan = find("[data-route-plan]").closest(".atlas-route-card"); plan.dataset.dispatchTrips = "";
    const settings = document.createElement("dialog"); settings.className = "atlas-route-intake atlas-dispatch-settings"; settings.dataset.dispatchSettings = "";
    settings.innerHTML = '<button type="button" class="atlas-route-close" data-dispatch-close="settings" aria-label="Close settings">×</button><h2>Route settings</h2>';
    settings.append(setup, find(".atlas-route-plan-settings"), find(".atlas-route-main > .atlas-route-help")); section.append(settings);
    const map = document.createElement("dialog"); map.className = "atlas-route-intake atlas-dispatch-map"; map.dataset.dispatchMap = "";
    map.innerHTML = '<button type="button" class="atlas-route-close" data-dispatch-close="map" aria-label="Close map">×</button><h2>Route map &amp; estimates</h2>';
    map.append(find(".atlas-route-map-card"), find(".atlas-route-kpis"), find(".atlas-route-relief").closest(".atlas-route-card")); section.append(map);
    const move = document.createElement("dialog"); move.className = "atlas-route-intake atlas-dispatch-move"; move.dataset.dispatchMove = ""; move.setAttribute("aria-label", "Review load move"); section.append(move);
    const toolbar = document.createElement("div"); toolbar.className = "atlas-dispatch-toolbar";
    toolbar.innerHTML = `<div class="atlas-dispatch-tabs" aria-label="Routing views">${[["orders","Orders","document"],["queue","Waiting loads","truck"],["trips","Trips","route"]].map(([id,label,name]) => `<button type="button" data-dispatch-tab="${id}" aria-pressed="${id === "orders"}">${icon(name)}<span>${label}</span></button>`).join("")}<button type="button" data-route-history>${icon("calendar")}<span>Saved</span></button><button type="button" data-dispatch-tab="pods" aria-pressed="false">${icon("document")}<span>PODs</span></button></div><div class="atlas-dispatch-tools"><button type="button" class="atlas-route-button" data-dispatch-show="map">${icon("map")}Map</button><button type="button" class="atlas-route-button" data-dispatch-show="settings">${icon("gear")}Settings</button></div>`;
    find(".atlas-route-grid").before(toolbar, find(".atlas-route-summary"));
    const filter = document.createElement("label"); filter.className = "atlas-dispatch-search";
    filter.innerHTML = '<span>Find an order</span><input type="search" data-dispatch-query placeholder="Customer, city, SO, invoice or fulfillment" />';
    orders.querySelector(".atlas-route-table-scroll").before(filter);
    const queue = document.createElement("section"); queue.className = "atlas-route-card atlas-dispatch-queue"; queue.dataset.dispatchQueue = ""; queue.hidden = true; columns[0].append(queue);
    const next = document.createElement("section"); next.className = "atlas-route-card atlas-dispatch-next"; next.dataset.dispatchNext = ""; columns[1].append(next, plan);
    const pods = document.createElement("section"); pods.className = "atlas-route-card atlas-dispatch-pods"; pods.dataset.dispatchPods = ""; pods.hidden = true;
    pods.innerHTML = `${icon("document")}<h2>Delivery documents</h2><p>POD submission is not connected yet.</p><p>Private document storage and driver-account assignments must be activated before signed documents can be saved here. Delivery status remains available in Saved Routes.</p><button type="button" class="atlas-route-button" data-route-history>Search saved deliveries</button>`; main.append(pods);
    section.addEventListener("click", (event) => {
      const tab = event.target.closest(".atlas-dispatch-tabs button[data-dispatch-tab]"); if (tab) { dispatchUI.tab = tab.dataset.dispatchTab; cancelOrderDrag(); applyDispatchTab(); if(dispatchUI.tab==="pods")void window.atlasRoutingPOD?.load(); }
      const show = event.target.closest("[data-dispatch-show]"); if (show) find(`[data-dispatch-${show.dataset.dispatchShow}]`)?.showModal();
      const close = event.target.closest("[data-dispatch-close]"); if (close) find(`[data-dispatch-${close.dataset.dispatchClose}]`)?.close();
      const promote = event.target.closest("[data-dispatch-promote]"); if (promote) openDispatchMove(promote.dataset.dispatchPromote, state.lockedTrips.length);
      const choose = event.target.closest("[data-dispatch-choose]"); if (choose) openDispatchMove(choose.dataset.dispatchChoose);
      if (event.target.closest("[data-dispatch-apply]")) applyDispatchMove();
    });
    section.addEventListener("input", (event) => { if (event.target.matches("[data-dispatch-query]")) { dispatchUI.query = event.target.value; filterDispatchOrders(); } });
    move.addEventListener("change", (event) => { if (event.target.matches("[data-dispatch-destination]")) { dispatchUI.move.trip = Number(event.target.value); dispatchUI.move.displaced = []; } else if (event.target.matches("[data-dispatch-displace]")) dispatchUI.move.displaced = [...move.querySelectorAll("[data-dispatch-displace]:checked")].map(el => el.value); renderDispatchMove(); });
    move.addEventListener("close", () => { dispatchUI.move = null; move.replaceChildren(); });
    window.atlasRoutingPOD?.mount(pods,()=>find("[data-route-date]").value);
    applyDispatchTab();
  }

  function applyDispatchTab() {
    const section = document.getElementById("atlasDeliveryRouting"); if (!section) return;
    section.dataset.dispatchTab = dispatchUI.tab;
    section.dataset.driverMode = String(driverMode);
    find(".atlas-route-header h1").textContent = driverMode ? "My Deliveries" : dispatchUI.tab === "pods" ? "Delivery Documents" : "Daily Route Optimizer";
    find('[data-dispatch-tab="pods"] span').textContent = driverMode ? "My Deliveries" : "PODs";
    section.querySelectorAll(".atlas-dispatch-tabs button[data-dispatch-tab]").forEach(el => el.setAttribute("aria-pressed", String(el.dataset.dispatchTab === dispatchUI.tab)));
    find("[data-dispatch-orders]").hidden = dispatchUI.tab !== "orders";
    find("[data-dispatch-queue]").hidden = dispatchUI.tab !== "queue";
    find("[data-dispatch-pods]").hidden = dispatchUI.tab !== "pods";
    find(".atlas-route-grid").hidden = dispatchUI.tab === "pods";
  }

  function filterDispatchOrders() {
    const q = dispatchUI.query.trim().toLowerCase();
    find("[data-route-orders]")?.querySelectorAll("[data-route-row]").forEach(row => {
      const o = dayOrders().find(item => item.id === row.dataset.routeRow);
      row.hidden = !!q && ![o.customer,o.city,o.orderNumber,...(o.invoiceNumbers || []),...(o.fulfillmentNumbers || [])].join(" ").toLowerCase().includes(q);
    });
  }

  function dispatchRows(shipments, { queue = false } = {}) {
    return `<div class="atlas-route-table-scroll atlas-dispatch-load-table"><table><tbody>${shipments.map(shipment => {
      const order = dayOrders().find(o => o.id === shipment.orderId); if (!order) return "";
      const editable = canReorderOrder(order.id, true), tripIndices = state.loads.flatMap((t,i) => t.shipments.some(s => s.orderId === order.id) ? [i] : []);
      const timed = state.planned?.trips.find(t => t.tripIndex === shipment.tripIndex);
      const visit = timed?.visits.find(v => timed.shipments[v.stopIndex]?.orderId === order.id);
      const date = find("[data-route-date]").value;
      return `<tr data-route-row="${order.id}"><td class="atlas-route-order-position">${editable ? `<button type="button" data-route-drag="${order.id}" aria-label="Hold to move ${escape(order.customer)}">⠿</button>` : '<span aria-label="Sent-out load locked">●</span>'}</td><td><button type="button" class="atlas-route-order-link" data-route-edit="${order.id}">${escape(order.customer)}</button><small>${escape(order.orderNumber)} · ${escape(order.city)}</small><small>${escape(date)} · Trip ${shipment.tripIndex + 1}${tripIndices.length > 1 ? ` · Split: ${tripIndices.length} shipments` : ""}</small><small>${visit ? `Estimated ${displayTime(visit.arrival)}` : "Arrival estimate needs calculation"}</small>${order.timeWindow ? `<small>Hours · ${escape(order.timeWindow)}</small>` : ""}${order.checkOnDelivery ? '<small class="atlas-route-check-badge">CHECK ON DELIVERY</small>' : ""}<div class="atlas-dispatch-row-actions">${editable ? `${queue ? `<button type="button" class="atlas-route-button" data-dispatch-promote="${order.id}">Move to next load</button>` : ""}<button type="button" class="atlas-route-button" data-dispatch-choose="${order.id}">Move…</button>` : '<small>Locked or read-only</small>'}</div></td><td></td><td><strong>${shipment.palletSpaces ?? "—"}</strong></td><td></td><td></td></tr>`;
    }).join("")}</tbody></table></div>`;
  }

  function renderDispatch() {
    if (!find("[data-dispatch-next]")) return;
    const nextIndex = state.lockedTrips.length, next = state.loads[nextIndex];
    const assignment = state.assignments[nextIndex] || "Bubba:truck", isVan = assignment.includes(":van");
    const capacity = !next ? "" : isVan ? (() => {
      const fit = core.assessVanShipments(next.shipments, state.catalog);
      const label = fit.status === "fits-estimate" ? "Likely fits" : fit.status === "does-not-fit" ? "Does not fit" : "Warehouse check needed";
      return `<p class="atlas-dispatch-muted">Loose-box van load · ${label}${fit.percent == null || fit.percent <= 80 ? "" : ` · ${fit.percent}%`}</p>`;
    })() : `<meter min="0" max="${state.truckPalletTarget}" value="${next.palletSpaces}" aria-label="Next load capacity"></meter><p class="atlas-dispatch-muted">${Math.max(0,state.truckPalletTarget-next.palletSpaces)} pallet spaces available · planning target</p>`;
    find("[data-dispatch-next]").innerHTML = `<h2>${icon("truck")}Next load${next ? ` · Trip ${nextIndex + 1}` : ""}</h2>${next ? `<div class="atlas-dispatch-load-heading"><strong>${isVan ? `${next.palletSpaces} pallet equivalents` : `${next.palletSpaces} / ${state.truckPalletTarget} pallets`}</strong><span>${escape(assignment.replace(":truck", " · Box Truck").replace(":van", " · Van "))}</span></div>${capacity}<details class="atlas-dispatch-next-stops"><summary>${next.shipments.length} ${next.shipments.length===1?'stop':'stops'} on this load · View or move orders</summary>${dispatchRows(next.shipments.map(s => ({...s,tripIndex:nextIndex})))}</details>` : '<p class="atlas-dispatch-muted">No unsent load. Add orders to begin.</p>'}`;
    find("[data-dispatch-next]").dataset.routeTripDrop = String(nextIndex);
    const waiting = state.loads.flatMap((trip,i) => i > nextIndex ? trip.shipments.map(s => ({...s,tripIndex:i})) : []);
    const unassigned = (state.loadPlan?.unscheduled || []).map(s => `<p>${escape(s.customer)} · ${escape(s.reason)}</p>`).join("");
    find("[data-dispatch-queue]").innerHTML = `<h2>${icon("pallets")}Waiting loads <span class="atlas-dispatch-count">${waiting.length}</span></h2><p class="atlas-dispatch-muted">Planned after the next load · ${escape(find("[data-route-date]").value)}</p>${waiting.length ? dispatchRows(waiting, {queue:true}) : '<div class="atlas-route-plan-empty"><strong>No loads waiting</strong><p>Orders assigned beyond the next trip appear here.</p></div>'}${unassigned ? `<div class="atlas-route-planning-review"><strong>Allocation needs review</strong>${unassigned}</div>` : ""}`;
    find("[data-route-plan]").querySelectorAll(".atlas-route-trip").forEach((article, position) => {
      const index = state.planned ? state.planned.trips[position]?.tripIndex : position;
      const trip = state.loads[index]; if (!trip || article.querySelector(".atlas-dispatch-trip-detail")) return;
      article.dataset.routeTripDrop = String(index);
      const content = article.children[1], header = content?.querySelector("header"); if (!content || !header) return;
      const detail = document.createElement("details"); detail.className = "atlas-dispatch-trip-detail";
      const summary = document.createElement("summary"); summary.textContent = `${trip.locked ? "Sent out · " : ""}${trip.shipments.length} stops · ${trip.palletSpaces} pallets · View details`;
      detail.append(summary); while (header.nextSibling) detail.append(header.nextSibling);
      const rows = document.createElement("div"); rows.innerHTML = dispatchRows(trip.shipments.map(s => ({...s,tripIndex:index}))); detail.append(rows); content.append(detail);
    });
    filterDispatchOrders(); applyDispatchTab();
  }

  function dispatchMovePreview() {
    const move = dispatchUI.move;
    return core.previewPriorityMove(state.analyzed.map(o => ({...o,palletSpaces:o.issues.some(issue=>issue.includes("item quantity")||issue.includes("case quantity"))?null:o.palletSpaces,dispatchedOn:o.source.dispatchedOn,deliveredOn:o.source.deliveredOn})), {truckPalletTarget:state.truckPalletTarget,dailyTripTarget:state.dailyTripTarget,lockedTrips:state.lockedTrips},move.id,move.trip,move.displaced);
  }

  function openDispatchMove(id, trip = state.lockedTrips.length) {
    if (!canReorderOrder(id)) return;
    dispatchUI.move = { id, trip, displaced: [], owner:state.ownerId, day:find("[data-route-date]").value, generation:state.planningGeneration };
    const target=state.loads[trip],source=state.analyzed.find(o=>o.id===id);
    if(target && !target.shipments.some(s=>s.orderId===id)) {
      let excess=target.palletSpaces+(source?.palletSpaces||0)-state.truckPalletTarget;
      const candidates=target.shipments.filter(s=>canReorderOrder(s.orderId)&&state.loads.filter(t=>t.shipments.some(x=>x.orderId===s.orderId)).length===1).sort((a,b)=>a.palletSpaces-b.palletSpaces);
      const single=candidates.find(s=>s.palletSpaces>=excess);
      for(const candidate of single?[single]:candidates.reverse()) { if(excess<=0)break;dispatchUI.move.displaced.push(candidate.orderId);excess-=candidate.palletSpaces; }
      if(dispatchUI.move.displaced.length)dispatchUI.move.suggestion="Suggested by pallet capacity. Check customer hours before moving these orders later; traffic and return-time effects require recalculation.";
    }
    renderDispatchMove(); find("[data-dispatch-move]").showModal();
  }

  function renderDispatchMove() {
    const move = dispatchUI.move; if (!move) return;
    const order = dayOrders().find(o=>o.id===move.id), target = state.loads[move.trip];
    let preview, error = ""; try { preview = dispatchMovePreview(); } catch (e) { error = e.message; }
    const changed = preview?.before.trips.flatMap((trip,index) => trip.shipments.map(s=>({id:s.orderId,index}))).filter(({id,index}) => !preview.after.trips[index]?.shipments.some(s=>s.orderId===id));
    const candidates = [...new Set(target?.shipments.map(s=>s.orderId))].filter(id=>id!==move.id&&canReorderOrder(id));
    find("[data-dispatch-move]").innerHTML = `<h2>Move ${escape(order?.customer)}</h2><p>${escape(order?.orderNumber)} · Review the load changes before applying.</p><label>Move toward<select data-dispatch-destination>${state.loads.map((t,i)=>t.locked?"":`<option value="${i}" ${i===move.trip?"selected":""}>Trip ${i+1} · ${t.palletSpaces} pallets</option>`).join("")}</select></label>${move.suggestion?`<p class="atlas-route-planning-review">${escape(move.suggestion)}</p>`:""}<fieldset><legend>Move another order later, if needed</legend>${candidates.map(id=>{const o=dayOrders().find(o=>o.id===id);return `<label class="atlas-dispatch-choice"><input type="checkbox" data-dispatch-displace value="${id}" ${move.displaced.includes(id)?"checked":""}/><span>${escape(o.customer)} · ${state.analyzed.find(a=>a.id===id)?.palletSpaces ?? "—"} pallets<br/><small>${escape(o.city)}${o.timeWindow?` · Hours: ${escape(o.timeWindow)}`:""}</small></span></label>`;}).join("") || '<p>No other movable orders on this trip.</p>'}</fieldset>${error?`<p role="alert">${escape(error)}</p>`:`<div class="atlas-route-planning-review"><strong>Resulting loads</strong>${preview.after.trips.filter(t=>!t.locked).map(t=>`<p>Trip ${preview.after.trips.indexOf(t)+1} · ${t.palletSpaces} pallets · ${t.shipments.map(s=>escape(s.customer)).join(" → ")}</p>`).join("")}${preview.actualTrip!==move.trip?'<p>Order priority places this load on a different trip. Review the result below; no fixed trip assignment has been saved.</p>':""}${changed?.length?'<p>Other orders change trips as shown above.</p>':""}</div>`}<p>Arrival times and traffic must be recalculated after this move. Customer hours, shift finish and van fit still need review. Save Day keeps the updated priority.</p><div class="atlas-route-card-tools"><button type="button" class="atlas-route-button" data-dispatch-close="move">Cancel</button><button type="button" class="atlas-route-button atlas-route-primary" data-dispatch-apply ${error?"disabled":""}>Apply move</button></div>`;
  }

  function applyDispatchMove() {
    const move = dispatchUI.move;
    if (!move || !canReorderOrder(move.id) || move.owner!==state.ownerId || move.day!==find("[data-route-date]").value || move.generation!==state.planningGeneration) { find("[data-dispatch-move]").close(); return; }
    try {
      const preview = dispatchMovePreview(), orderMap = new Map(dayOrders().map(o=>[o.id,o]));
      state.orders = [...state.orders.filter(o=>o.date!==move.day),...preview.orders.map(o=>orderMap.get(o.id))];
      find("[data-route-preserve]").checked = true; find("[data-dispatch-move]").close(); renderOrders(); flashOrderPlacement(move.id);
    } catch(e) { find("[data-route-progress]").textContent = e.message; }
  }

  function flashOrderPlacement(id) {
    document.getElementById("atlasDeliveryRouting").querySelectorAll("[data-route-row]").forEach(row=>{
      if(row.dataset.routeRow!==id)return;
      const check=document.createElement("span");check.className="atlas-route-placement-check";check.textContent="✓ Moved";check.setAttribute("role","status");row.querySelector(".atlas-route-order-link")?.after(check);setTimeout(()=>check.remove(),2200);
    });
  }

  function dayDocument() {
    return window.atlasRoutingStorage.document({ schemaVersion: 3, date: find("[data-route-date]").value, orders: dayOrders(), catalog: state.catalog,
      settings: { truckPalletTarget: Number(find("[data-route-truck-target]").value), dailyTripTarget: Number(find("[data-route-trip-target]").value), reloadMinutes: Number(find("[data-route-reload]").value), lunch: find("[data-route-lunch]").value, preserveOrder: find("[data-route-preserve]").checked },
      assignments: state.assignments, vanConfirmed: state.vanConfirmed, lockedTrips: state.lockedTrips });
  }

  function showSaveStatus() {
    if (!find("[data-route-save-status]")) return;
    const enabled = storage()?.enabled;
    find("[data-route-save-status]").textContent = !enabled ? "Orders are temporary. Shared saving is awaiting database approval and connection." : savedDay.message || (savedDay.dirty ? "Unsaved changes — select Save Day before leaving." : savedDay.revision ? `Saved version ${savedDay.revision} · recalculate routes for current traffic.` : "No saved orders for this day yet.");
    find("[data-route-save-day]").disabled = !enabled || !savedDay.ready || !savedDay.canEdit || savedDay.busy || Boolean(state.planningController);
    find("[data-route-load-day]").disabled = !enabled || savedDay.busy || Boolean(state.planningController);
    document.getElementById("atlasDeliveryRouting").querySelectorAll("[data-route-history]").forEach(button=>{button.disabled = !enabled || savedDay.busy || Boolean(state.planningController);});
    find("[data-route-confirm-day]").disabled = savedDay.busy || !dayOrders().length || (enabled && !savedDay.canEdit) || find("[data-route-date]").value > todayPacific();
    for (const selector of ["[data-route-lock-next]", "[data-route-reopen-last]"]) if (find(selector)) find(selector).disabled = savedDay.busy || !enabled || !savedDay.ready || !savedDay.canEdit || Boolean(state.planningController);
    find("[data-route-date]").disabled = savedDay.busy;
    applyReadOnlyControls();
  }

  function applyReadOnlyControls() {
    const section = document.getElementById("atlasDeliveryRouting"); if (!section) return;
    section.dataset.routingReadOnly = String(accessReadOnly);
    if (!accessReadOnly) return;
    const controls = '[data-route-optimize],[data-route-intake],[data-route-manual-order],[data-route-edit],[data-route-drag],[data-route-move],[data-route-assignment],[data-route-confirm-van],[data-route-lock-next],[data-route-reopen-last],[data-route-save-day],[data-route-confirm-day],[data-dispatch-promote],[data-dispatch-choose],[data-dispatch-apply],[data-dispatch-settings] input,[data-dispatch-settings] select';
    section.querySelectorAll(controls).forEach(el => { if (!el.disabled) el.dataset.routingDisabled = 'true'; el.disabled = true; });
    find('[data-route-save-status]').textContent = 'Read-only · Administrators manage routes and driver assignments.';
  }

  function showReminderStatus() {
    if (!find("[data-route-reminder-status]")) return;
    const status = reminders()?.status() || window.atlasRoutingNotifications.availability();
    find("[data-route-reminder-status]").textContent = status.message;
    find("[data-route-reminder-enable]").disabled = !status.canEnable || status.busy || status.enabled;
    find("[data-route-reminder-disable]").hidden = !status.enabled;
    find("[data-route-reminder-disable]").disabled = status.busy;
  }

  function applySavedDay(result, { preserveDraft = false } = {}) {
    vehicleChanges = {};
    const keep = new Set(preserveDraft ? state.draftPhotos.map(photo => photo.url) : []);
    state.allUrls.forEach((url) => { if (!keep.has(url)) URL.revokeObjectURL(url); }); state.allUrls = keep;
    const doc = result.document;
    state.orders = (doc?.orders || []).map((order) => ({ ...order, date: result.date, photos: [] }));
    state.catalog = doc?.catalog || [];
    state.truckPalletTarget = doc?.settings.truckPalletTarget ?? 11; state.dailyTripTarget = doc?.settings.dailyTripTarget ?? 3;
    state.assignments = doc?.assignments || {}; state.vanConfirmed = doc?.vanConfirmed || {}; state.lockedTrips = doc?.lockedTrips || [];
    find("[data-route-truck-target]").value = state.truckPalletTarget; find("[data-route-trip-target]").value = state.dailyTripTarget;
    find("[data-route-reload]").value = doc?.settings.reloadMinutes ?? 40; find("[data-route-lunch]").value = doc?.settings.lunch ?? "12:00";
    find("[data-route-preserve]").checked = doc?.settings.preserveOrder ?? false;
    savedDay.day = result.date; savedDay.revision = result.revision; savedDay.ready = true; savedDay.canEdit = result.canEdit; savedDay.dirty = false;
    savedDay.message = result.canEdit ? "" : "Read-only access to this saved day. Changes in this tab cannot be saved.";
    find("[data-route-catalog-status]").textContent = state.catalog.length ? `${state.catalog.length} saved specification rows loaded. NEW versions take precedence.` : "Load product specifications to calculate pallets and van estimates.";
    renderOrders({ keepAssignments: true, dirty: false });
  }

  async function loadDay(review = false) {
    if (!storage()?.enabled || savedDay.busy) return;
    const generation = ++savedDay.generation, owner = state.ownerId, day = find("[data-route-date]").value;
    const current = () => savedDay.generation === generation && state.open && state.ownerId === owner && window.AtlasAuth?.getSession()?.user?.id === owner;
    savedDay.busy = true; savedDay.message = "Opening saved day…";
    if (!review) { savedDay.ready = false; savedDay.day = day; }
    document.getElementById("atlasDeliveryRouting").inert = true;
    showSaveStatus();
    try {
      const result = await storage().load(day);
      if (!current()) return;
      if (!review) applySavedDay(result);
      else {
        const doc = result.document;
        find("[data-route-saved-details]").innerHTML = `<p>${escape(day)} · version ${result.revision} · ${doc?.orders.length || 0} orders</p>${doc ? `<p>Truck target: ${doc.settings.truckPalletTarget} pallets · typical trips: ${doc.settings.dailyTripTarget} · reload: ${doc.settings.reloadMinutes} minutes · Bubba: flexible one-hour lunch · Achmad lunch: ${escape(doc.settings.lunch)} · ${doc.catalog.length} product specifications</p>${doc.orders.map((order, index) => `<article><h3>${index + 1}. ${escape(order.customer)} · ${escape(order.orderNumber)}</h3><p>${escape(order.address)} · ${escape(order.city)}</p><p>Invoice: ${escape((order.invoiceNumbers || []).join(", ") || "Not recorded")} · Item Fulfillment: ${escape((order.fulfillmentNumbers || []).join(", ") || "Not recorded")}</p><p>${escape(window.atlasRoutingStorage.deliveryStatus(order).label)}${window.atlasRoutingStorage.deliveryStatus(order).date ? ` · ${escape(window.atlasRoutingStorage.deliveryStatus(order).date)}` : ""} ${escape(order.deliveryException || "")}</p><p>${escape(order.timeWindow)} · ${order.serviceMinutes} minutes at stop</p><p>${escape(order.notes)} ${order.checkOnDelivery ? "CHECK ON DELIVERY" : ""}</p><ul>${order.lines.map((line) => `<li>${escape(line.sku)} · ${line.caseQty} boxes${line.itemQty == null ? "" : ` · ${line.itemQty} units`}</li>`).join("")}</ul></article>`).join("")}` : "<p>No version has been saved.</p>"}`;
        find("[data-route-use-saved]").onclick = () => {
          if (!current()) return;
          if (savedDay.dirty && !window.confirm("Replace your unsaved orders and settings with this saved version?")) return;
          applySavedDay(result); find("[data-route-saved-review]").close();
        };
        savedDay.message = "Your current work has not been replaced. Compare it with the saved version.";
        find("[data-route-saved-review]").showModal();
      }
    } catch (error) { if (current()) savedDay.message = error.message; }
    finally { if (current()) { savedDay.busy = false; document.getElementById("atlasDeliveryRouting").inert = false; showSaveStatus(); } }
  }

  async function searchHistory(offset = 0, paging = false) {
    if (!storage()?.enabled) return;
    const generation = ++history.generation, owner = state.ownerId;
    const current = () => generation === history.generation && state.open && find("[data-route-history-dialog]").open && window.AtlasAuth?.getSession()?.user?.id === owner;
    const form = find("[data-route-history-form]");
    const status = find("[data-route-history-status]");
    find("[data-route-history-prev]").disabled = true; find("[data-route-history-next]").disabled = true;
    history.matches = []; find("[data-route-history-results]").replaceChildren(); status.textContent = "Searching saved deliveries…";
    try {
      const filters = paging ? history.filters : Object.fromEntries(["query", "from", "to", "dateField"].map((key) => [key, form.elements[key].value]));
      const result = await storage().search({ ...filters, offset });
      if (!current()) return;
      history.offset = offset; history.filters = filters; history.matches = result.matches;
      status.textContent = result.matches.length ? `Showing ${offset + 1}–${offset + result.matches.length}${result.hasMore ? " · more results available" : ""}.` : "No saved deliveries match. Try another number or date range.";
      find("[data-route-history-results]").innerHTML = result.matches.map((order, index) => `<article class="atlas-route-history-result"><h3>${escape(order.customer)}</h3><p>Sales Order: <strong>${escape(order.orderNumber)}</strong> · ${escape(order.city)}</p><p>Invoice: ${escape(order.invoiceNumbers.join(", ") || "Not recorded")}<br />Item Fulfillment: ${escape(order.fulfillmentNumbers.join(", ") || "Not recorded")}</p><p>Scheduled: ${escape(order.date)} · <strong>${escape(window.atlasRoutingStorage.deliveryStatus(order).label)}${window.atlasRoutingStorage.deliveryStatus(order).date ? `: ${escape(window.atlasRoutingStorage.deliveryStatus(order).date)}` : ""}</strong></p>${order.deliveryException ? `<p>${escape(order.deliveryException)}</p>` : ""}<button type="button" class="atlas-route-button" data-route-open-history="${index}">Open Shipment</button></article>`).join("");
      find("[data-route-history-prev]").disabled = offset === 0; find("[data-route-history-next]").disabled = !result.hasMore;
    } catch (error) { if (current()) status.textContent = error.code === "DISABLED" ? "Saved Routes search is awaiting the private database update. Existing saved days can still be opened by date in the connected preview." : error.message; }
  }

  function updateDeliveryDay() {
    const day = find("[data-route-date]").value;
    if (savedDay.busy || day > todayPacific() || (storage()?.enabled && !savedDay.canEdit)) return;
    let updated = 0;
    for (const order of dayOrders()) {
      if (order.dispatchedOn && order.dispatchedOn <= todayPacific() && !order.deliveryException?.trim() && !order.deliveredOn) { order.deliveredOn = todayPacific(); updated++; }
    }
    if (!updated) { savedDay.message = "No eligible orders changed. Review individual sent-out dates and delivery issues."; showSaveStatus(); return; }
    renderOrders({ keepAssignments: true });
    savedDay.message = `Sent-out orders without issues confirmed for ${todayPacific()}. Select Save Day to store this; edit an order to correct its date.`;
    showSaveStatus();
  }

  const isLockedOrder = (id) => state.lockedTrips.some((trip) => trip.shipments.some((shipment) => shipment.orderId === id));

  async function lockNextTrip() {
    const index = state.lockedTrips.length, load = state.loads[index], day = find("[data-route-date]").value;
    if (!storage()?.enabled || !savedDay.ready || !savedDay.canEdit || savedDay.busy || state.planningController || !load || day > todayPacific()) return;
    if (load.shipments.some((shipment) => !shipment.boxAllocation?.length)) {
      savedDay.message = "Confirm every SKU and box allocation before marking this trip sent out."; showSaveStatus(); return;
    }
    const assignment = state.assignments[index] || "Bubba:truck";
    if (assignment.includes(":van")) {
      const fit = core.assessVanShipments(load.shipments, state.catalog);
      if (!fit.allocationComplete || fit.status === "does-not-fit" || (fit.status !== "fits-estimate" && !state.vanConfirmed[index])) {
        savedDay.message = "Review and confirm this van load before marking it sent out."; showSaveStatus(); return;
      }
    }
    state.assignments[index] = assignment;
    state.vanConfirmed[index] = Boolean(state.vanConfirmed[index]);
    const sentOn = todayPacific();
    const snapshot = { shipments: load.shipments.map((shipment) => ({ orderId: shipment.orderId, palletSpaces: shipment.palletSpaces,
      boxAllocation: shipment.boxAllocation.map((line) => ({ sku: line.sku, boxes: line.boxes })) })),
      palletSpaces: load.palletSpaces, assignment, vanConfirmed: state.vanConfirmed[index], sentOn, completedOrderIds: [] };
    state.lockedTrips.push(snapshot);
    for (const order of dayOrders()) {
      if (order.dispatchedOn || !snapshot.shipments.some((shipment) => shipment.orderId === order.id)) continue;
      const assigned = state.lockedTrips.flatMap((trip) => trip.shipments).filter((shipment) => shipment.orderId === order.id).reduce((sum, shipment) => sum + shipment.palletSpaces, 0);
      const analyzed = state.analyzed.find((item) => item.id === order.id);
      if (analyzed?.palletSpaces === assigned) { order.dispatchedOn = sentOn; snapshot.completedOrderIds.push(order.id); }
    }
    renderOrders({ keepAssignments: true });
    await saveDay();
  }

  async function reopenLastTrip() {
    if (!storage()?.enabled || !savedDay.ready || !savedDay.canEdit || savedDay.busy || state.planningController || !state.lockedTrips.length) return;
    const trip = state.lockedTrips.pop();
    for (const id of trip.completedOrderIds) {
      const order = state.orders.find((item) => item.id === id);
      if (order?.dispatchedOn === trip.sentOn) order.dispatchedOn = null;
    }
    renderOrders({ keepAssignments: true });
    await saveDay();
  }

  async function openHistoryResult(index) {
    const match = history.matches[index];
    if (!match || savedDay.busy) return;
    if (savedDay.dirty && !window.confirm("Open this saved shipment and replace your unsaved day? Temporary photos will be cleared.")) return;
    const generation = history.generation, owner = state.ownerId;
    savedDay.busy = true; showSaveStatus();
    const current = () => generation === history.generation && state.open && window.AtlasAuth?.getSession()?.user?.id === owner;
    try {
      const result = await storage().load(match.date);
      if (!current()) return;
      if (!result.document?.orders.some((order) => order.id === match.orderId)) throw new Error("This shipment changed since the search. Search again to refresh the results.");
      find("[data-route-date]").value = match.date; applySavedDay(result);
      find("[data-route-history-dialog]").close(); openDraft(match.orderId);
    } catch (error) { if (current()) find("[data-route-history-status]").textContent = error.message; }
    finally { if (state.ownerId === owner) { savedDay.busy = false; showSaveStatus(); } }
  }

  async function saveDay() {
    if (!storage()?.enabled || !savedDay.ready || !savedDay.canEdit || savedDay.busy) return;
    const generation = savedDay.generation, owner = state.ownerId;
    const current = () => generation === savedDay.generation && state.open && state.ownerId === owner && window.AtlasAuth?.getSession()?.user?.id === owner;
    savedDay.busy = true; savedDay.message = "Saving reviewed details…"; showSaveStatus();
    try {
      const doc = dayDocument();
      if (doc.date !== savedDay.day) throw new Error("Open the saved day before saving changes to this date.");
      const result = await storage().save(doc.date, savedDay.revision, doc);
      if (!current()) return;
      savedDay.revision = result.revision;
      savedDay.dirty = JSON.stringify(dayDocument()) !== JSON.stringify(doc);
      savedDay.message = savedDay.dirty ? "The earlier version was saved. You have additional unsaved changes." : `Saved version ${result.revision}. Photos are temporary; reviewed details and load settings are saved.`;
    } catch (error) { if (current()) { savedDay.dirty = true; savedDay.message = error.message; } }
    finally { if (current()) { savedDay.busy = false; showSaveStatus(); } }
  }

  const dayOrders = () => state.orders.filter((order) => order.date === find("[data-route-date]").value);

  async function importCatalog(event) {
    const file = event.target.files[0];
    if (!file) return;
    const generation = ++state.importGeneration;
    const status = find("[data-route-catalog-status]");
    status.textContent = "Reading product specifications…";
    try {
      const catalog = await window.atlasRoutingCatalog.readWorkbook(file);
      if (generation !== state.importGeneration || !state.open) return;
      state.catalog = catalog;
      status.textContent = `${catalog.length} specification rows loaded for this screen. NEW versions take precedence; uncertain values are flagged.`;
      renderOrders();
    } catch (error) {
      if (generation === state.importGeneration) status.textContent = `${error.message} ${state.catalog.length ? "The previously loaded specifications are still in use." : ""}`;
    } finally { event.target.value = ""; }
  }

  function addLine(line = {}) {
    const row = document.createElement("div");
    row.className = "atlas-route-line";
    row.innerHTML = `<label>SKU<input data-line-sku required maxlength="100" value="${escape(line.sku)}" /></label><label>Case Qty · boxes<input data-line-cases type="number" min="1" max="1000000" required value="${escape(line.caseQty)}" /></label><label>Item Qty · units<input data-line-units type="number" min="1" max="1000000000" value="${escape(line.itemQty)}" /></label><button type="button" data-route-remove-line aria-label="Remove SKU line">×</button>`;
    find("[data-route-lines]").appendChild(row);
  }

  function showIntakeDay() {
    const selected = find("[data-route-date]").value;
    const policy = core.intakeDeliveryDay(selected, new Date(), find("[data-route-cutoff-exception]").checked);
    find("[data-route-cutoff-exception-wrap]").hidden = Boolean(state.editId) || !policy.exceptionAllowed;
    find("[data-route-intake-day]").textContent = state.editId
      ? `Delivery day: ${selected}. Existing assignments stay unchanged.`
      : policy.exceptionAllowed && find("[data-route-cutoff-exception]").checked
        ? `Delivery day: ${policy.date}. Manual same-day exception selected; assign the afternoon driver and vehicle yourself.`
        : `Delivery day: ${policy.date}. New orders at or after 12:00 PM Pacific go to the next weekday. Friday afternoon goes to Monday.`;
  }

  function openDraft(id = null, show = true) {
    if (intakeRequest || savedDay.busy || accessReadOnly || driverMode) return;
    draftGeneration++;
    cancelPhotoReading();
    const existing = state.orders.find((order) => order.id === id);
    const locked = Boolean(existing && isLockedOrder(existing.id));
    state.editId = existing?.id || null;
    state.draftPhotos = [...(existing?.photos || [])];
    state.newUrls = [];
    const form = find("[data-route-order-form]");
    form.reset();
    showIntakeDay();
    for (const key of ["orderNumber", "customer", "address", "city", "timeWindow", "notes", "serviceMinutes"]) form.elements[key].value = existing?.[key] ?? (key === "serviceMinutes" ? 25 : "");
    form.elements.checkOnDelivery.checked = existing?.checkOnDelivery || false;
    form.elements.invoiceNumbers.value = (existing?.invoiceNumbers || []).join(", ");
    form.elements.fulfillmentNumbers.value = (existing?.fulfillmentNumbers || []).join(", ");
    form.elements.delivered.checked = Boolean(existing?.deliveredOn);
    form.elements.deliveredOn.value = existing?.deliveredOn || "";
    form.elements.delivered.disabled = locked && !existing?.dispatchedOn;
    form.elements.deliveredOn.disabled = !existing?.deliveredOn || form.elements.delivered.disabled; form.elements.deliveredOn.required = Boolean(existing?.deliveredOn);
    form.elements.deliveredOn.max = todayPacific();
    form.elements.dispatchedOn.value = existing?.dispatchedOn || ""; form.elements.dispatchedOn.max = todayPacific();
    form.elements.deliveryException.value = existing?.deliveryException || "";
    find("[data-route-lines]").replaceChildren();
    (existing?.lines || [{}]).forEach(addLine);
    for (const key of ["orderNumber", "customer", "address", "city", "timeWindow", "serviceMinutes", "notes", "checkOnDelivery", "dispatchedOn"]) form.elements[key].disabled = locked;
    for (const field of form.querySelectorAll('[data-line-sku], [data-line-cases], [data-line-units], [data-route-remove-line], [data-route-camera], [data-route-images]')) field.disabled = locked;
    find("[data-route-add-line]").disabled = locked;
    find("#atlasRouteIntakeTitle").textContent = existing ? "Edit Order" : "Add Order";
    form.querySelector('[type="submit"]').textContent = locked ? "Update Delivery Status" : existing ? "Update This Order" : "Add to This Day";
    find("[data-route-add-next]").hidden = Boolean(existing);
    find("[data-route-entry-status]").textContent = "";
    find("[data-route-entry-save-help]").textContent = locked ? "This order is on a sent-out trip. Its load details are fixed until you reopen the latest trip. Delivery confirmation and exceptions can still be updated." : storage()?.enabled
      ? "Adding or updating an order changes this day's list. Select Save Day afterward to store the reviewed details. Photos are not saved."
      : "Orders and photos are temporary in this tab. Shared saving is not connected.";
    find("[data-route-form-error]").textContent = "";
    renderPhotos();
    if (locked) find("[data-route-read]").disabled = true;
    if (show && !find(".atlas-route-intake").open) find(".atlas-route-intake").showModal();
  }

  function intakeSnapshot() {
    const canEdit = state.open && !driverMode && !accessReadOnly && state.ownerId === window.AtlasAuth?.getSession()?.user?.id &&
      !savedDay.busy && !intakeRequest && !state.planningController && (!storage()?.enabled || (savedDay.ready && savedDay.canEdit));
    return { owner: state.ownerId, active: state.open && !driverMode && state.ownerId === window.AtlasAuth?.getSession()?.user?.id,
      canEdit, canSave: canEdit && storage()?.enabled && savedDay.ready, dirty: savedDay.dirty,
      canOptimize: canEdit && !find("[data-route-optimize]").disabled,
      planIssue: !window.atlasRoutingConnection?.available ? "Google routing is not connected. Your orders remain available." : state.loadPlan?.unscheduled.length ? "Some loads need review before routing. Open Trips to review them." : "",
      orders: dayOrders().map(o => ({ ...o, locked: isLockedOrder(o.id) || !!o.dispatchedOn || !!o.deliveredOn })),
      catalog: state.catalog, core, date: find("[data-route-date]").value,
      intakeDate: core.intakeDeliveryDay(find("[data-route-date]").value, new Date()).date,
      pallets: find("[data-route-total-pallets]").textContent, plan: state.planned, time: displayTime };
  }

  function initializeDocumentFlow(section) {
    documentFlow = window.atlasRoutingIntake.createDocumentFlow({ host: section, icon, snapshot: intakeSnapshot,
      read: async (file, signal) => {
        if (!window.atlasRoutingConnection?.photoAvailable) throw new Error("Photo reading is not connected yet.");
        const image = await window.atlasRoutingIntake.preparePhoto(file, signal);
        const response = await window.atlasRoutingConnection.readPhoto(image, { signal });
        if (!response.pages?.[0]) throw new Error("No readable text found. Take a clearer photo.");
        return response.pages[0];
      },
      submit: async order => {
        if (!intakeSnapshot().canEdit) throw new Error("This day cannot be edited right now.");
        openDraft(null, false);
        const form = find("[data-route-order-form]");
        for (const name of ["orderNumber", "customer", "address", "city", "timeWindow"]) form.elements[name].value = order[name];
        for (const name of ["invoiceNumbers", "fulfillmentNumbers"]) form.elements[name].value = (order[name] || []).join(", ");
        form.elements.checkOnDelivery.checked = order.checkOnDelivery;
        find("[data-route-lines]").replaceChildren(); order.lines.forEach(addLine);
        if (order.timeWindow) window.atlasRoutingPlanner.timeWindow(order.timeWindow, order.date, window.atlasRoutingPlanner.timestamp(order.date, 390), 25);
        const saved = await saveDraft({ preventDefault() {}, target: form, intakeDate: order.date });
        if (!saved) throw new Error(find("[data-route-form-error]").textContent || "Order could not be added. Try again.");
        cleanupDraft(); return saved;
      },
      optimize: async () => {
        if (!intakeSnapshot().canOptimize) throw new Error(intakeSnapshot().planIssue || "Review the orders and load assignments first.");
        await optimizeDay();
        if (!state.planned?.complete) throw new Error(find("[data-route-progress]").textContent || "Routes could not be calculated. Your orders are still here.");
      },
      save: async () => {
        if (!intakeSnapshot().canSave) throw new Error("Saving is unavailable. Your reviewed orders remain in this tab.");
        await saveDay();
        if (savedDay.dirty) throw new Error(savedDay.message || "Route was not saved. Please retry.");
      },
      edit: id => { if (intakeSnapshot().canEdit) openDraft(id); },
      remove: id => {
        if (!intakeSnapshot().canEdit || !canReorderOrder(id)) throw new Error("Sent-out, delivered or read-only orders cannot be removed.");
        if (!window.confirm("Remove this order from the current day? Save Day afterward to store the change.")) return;
        const order = state.orders.find(o => o.id === id);
        order?.photos.forEach(photo => { URL.revokeObjectURL(photo.url); state.allUrls.delete(photo.url); });
        state.orders = state.orders.filter(o => o.id !== id); renderOrders();
      },
      map: () => find("[data-dispatch-map]").showModal(),
      cancelPlan: () => state.planningController?.abort(),
    });
    const nav = document.createElement("nav"); nav.className = "atlas-route-manager-nav"; nav.setAttribute("aria-label", "Delivery routing");
    nav.innerHTML = [["home", "Home", "dashboard"], ["orders", "Orders", "document"], ["trips", "Trips", "truck"], ["more", "More", "gear"]].map(([id,label,glyph]) => `<button type="button" data-manager-tab="${id}">${icon(glyph)}<span>${label}</span></button>`).join(""); section.append(nav);
    const more = document.createElement("dialog"); more.className = "atlas-route-manager-more";
    more.innerHTML = '<h2>More</h2>' + [["queue","Waiting loads"],["history","Saved routes"],["map","Map"],["settings","Settings"],["pods","Delivery documents"],["day","Day actions"],["menu","Main Menu"]].map(([id,label]) => `<button type="button" class="atlas-route-button" data-manager-more="${id}">${label}</button>`).join("") + '<button type="button" class="atlas-route-button" data-manager-more="close">Close</button>'; section.append(more);
    nav.addEventListener("click", event => {
      const tab = event.target.closest("[data-manager-tab]")?.dataset.managerTab; if (!tab || driverMode) return;
      if (tab === "orders") documentFlow.open("ORDERS_READY");
      else if (tab === "more") more.showModal();
      else { dispatchUI.tab = tab === "home" ? "orders" : "trips"; applyDispatchTab(); window.scrollTo(0,0); }
    });
    more.addEventListener("click", event => {
      const action = event.target.closest("[data-manager-more]")?.dataset.managerMore; if (!action) return; more.close();
      if (["queue", "pods"].includes(action)) { dispatchUI.tab = action; applyDispatchTab(); if(action === "pods") void window.atlasRoutingPOD?.load(); }
      if (["map", "settings"].includes(action)) find(`[data-dispatch-${action}]`).showModal();
      if (action === "history") { find("[data-route-history-dialog]").showModal(); void searchHistory(0); }
      if (action === "menu") document.querySelector(".premium-menu-button")?.click();
      if (action === "day") { find(".atlas-route-day-menu").open = true; find(".atlas-route-day-menu").scrollIntoView({block:"center"}); }
    });
  }

  function openCapture() { if (intakeSnapshot().canEdit) documentFlow.open(); }

  function renderPhotos() {
    find("[data-route-preview]").replaceChildren(...state.draftPhotos.map((photo, index) => {
      const figure = document.createElement("figure"), link = document.createElement("a"), remove = document.createElement("button");
      const image = document.createElement("img");
      image.src = photo.url;
      image.alt = `Order photo ${index + 1}: ${photo.name}`;
      link.href = photo.url; link.target = "_blank"; link.rel = "noopener"; link.title = "Open original photo"; link.appendChild(image);
      remove.type = "button"; remove.className = "atlas-route-button"; remove.dataset.routeRemovePhoto = index;
      remove.textContent = `Remove photo ${index + 1}`; figure.append(link, remove); return figure;
    }));
    find("[data-route-read]").disabled = !state.draftPhotos.length || !window.atlasRoutingConnection?.photoAvailable || Boolean(photoController);
    find("[data-route-photo-help]").textContent = window.atlasRoutingConnection?.photoAvailable
      ? "Read Photos sends these images to Google Cloud Vision for text reading. Save Day keeps reviewed details only. Photos remain in this tab and are cleared when you leave routing."
      : "You can take photos and enter orders now. Automatic photo reading is awaiting its private Google connection.";
  }

  function cancelPhotoReading() {
    photoGeneration++; photoController?.abort(); photoController = null; photoSuggestion = null;
    if (find("[data-route-photo-review]")) { find("[data-route-photo-review]").hidden = true; find("[data-route-photo-review]").replaceChildren(); }
    if (find("[data-route-stop-reading]")) find("[data-route-stop-reading]").hidden = true;
    if (find("[data-route-photo-status]")) find("[data-route-photo-status]").textContent = "";
    if (find("[data-route-read]")) find("[data-route-read]").disabled = !state.draftPhotos.length || !window.atlasRoutingConnection?.photoAvailable;
  }

  async function readPhotos() {
    if (photoController || !state.draftPhotos.length || !window.atlasRoutingConnection?.photoAvailable) return;
    cancelPhotoReading();
    const generation = photoGeneration, owner = state.ownerId, photos = [...state.draftPhotos], pages = [];
    const controller = new AbortController(); photoController = controller;
    const current = () => generation === photoGeneration && state.open && find(".atlas-route-intake")?.open && window.AtlasAuth?.getSession()?.user?.id === owner;
    const status = find("[data-route-photo-status]");
    find("[data-route-read]").disabled = true; find("[data-route-stop-reading]").hidden = false;
    try {
      for (const [index, photo] of photos.entries()) {
        if (!current() || controller.signal.aborted) return;
        status.textContent = `Reading photo ${index + 1} of ${photos.length}…`;
        const image = await window.atlasRoutingIntake.preparePhoto(photo.file, controller.signal);
        if (!current() || controller.signal.aborted) return;
        const response = await window.atlasRoutingConnection.readPhoto(image, { signal: controller.signal });
        if (!current() || controller.signal.aborted) return;
        pages.push(response.pages[0]);
      }
      photoSuggestion = window.atlasRoutingIntake.combinePages(pages);
      const r = photoSuggestion, review = find("[data-route-photo-review]");
      review.innerHTML = `<h3>Review photo reading</h3><p>Compare these suggestions with the photos above. Nothing is added to the day until you save the order.</p>${r.issues.length ? `<ul>${r.issues.map((issue) => `<li>${escape(issue)}</li>`).join("")}</ul>` : ""}
        <dl>${[["Invoice", r.invoiceNumbers.join(", ")], ["Item Fulfillment", r.fulfillmentNumbers.join(", ")], ["Sales order", r.orderNumber], ["Customer", r.customer], ["Ship To", r.address], ["City", r.city], ["Time Window", r.timeWindow]].map(([label, value]) => `<dt>${label}</dt><dd>${escape(value || "Not confirmed")}</dd>`).join("")}</dl>
        ${r.lines.map((line) => `<p><strong>${escape(line.sku)}</strong> · ${line.caseQty ?? "Review"} boxes · ${line.itemQty ?? "—"} units <small>(photo ${line.sources.join(", ")})</small></p>`).join("")}
        ${r.checkOnDelivery ? '<p class="atlas-route-check-badge">CHECK ON DELIVERY found</p>' : ""}
        ${!r.mixedOrders ? '<button type="button" class="atlas-route-button atlas-route-primary" data-route-use-reading>Fill empty fields</button><p class="atlas-route-intake-note">Your existing entries are preserved. Quantities are never automatically added to an existing SKU.</p>' : ""}`;
      review.hidden = false; status.textContent = "Photos read. Review the suggestions, then check the order fields below.";
    } catch (error) { if (current()) status.textContent = error.name === "AbortError" ? "Photo reading stopped. No order was added." : `${error.message} No partial reading was applied; you can enter the fields manually.`; }
    finally { if (current()) { photoController = null; find("[data-route-stop-reading]").hidden = true; renderPhotos(); } }
  }

  function applyPhotoReading() {
    const r = photoSuggestion;
    if (!r || r.mixedOrders) return;
    const form = find("[data-route-order-form]");
    for (const field of ["orderNumber", "customer", "address", "city", "timeWindow"]) if (!form.elements[field].value.trim()) form.elements[field].value = r[field];
    if (r.checkOnDelivery) form.elements.checkOnDelivery.checked = true;
    for (const field of ["invoiceNumbers", "fulfillmentNumbers"]) if (!form.elements[field].value.trim()) form.elements[field].value = (r[field] || []).join(", ");
    const rows = [...find("[data-route-lines]").children];
    const empty = rows.length === 1 && !rows[0].querySelector("[data-line-sku]").value && !rows[0].querySelector("[data-line-cases]").value && !rows[0].querySelector("[data-line-units]").value;
    if (empty && r.lines.length) { find("[data-route-lines]").replaceChildren(); r.lines.forEach(addLine); }
    else if (r.lines.length) find("[data-route-form-error]").textContent = "Your existing SKU lines were preserved. Compare them with the photo reading and add or correct lines manually.";
    find("[data-route-photo-status]").textContent = "Empty fields filled. Verify the address, every SKU, and Case Qty against the photos before saving.";
  }

  async function saveDraft(event) {
    event.preventDefault();
    if (intakeRequest || savedDay.busy || accessReadOnly || driverMode) return;
    if (photoController) { find("[data-route-form-error]").textContent = "Wait for photo reading or cancel it before saving."; return; }
    const form = event.target;
    const addNext = !state.editId && Boolean(event.submitter?.matches("[data-route-add-next]"));
    const orderNumber = form.elements.orderNumber.value.trim();
    const selectedDay = find("[data-route-date]").value;
    const date = state.editId ? selectedDay : event.intakeDate || core.intakeDeliveryDay(selectedDay, new Date(), find("[data-route-cutoff-exception]").checked).date;
    let invoiceNumbers, fulfillmentNumbers, deliveredOn, dispatchedOn;
    try {
      invoiceNumbers = documentNumbers(form.elements.invoiceNumbers.value); fulfillmentNumbers = documentNumbers(form.elements.fulfillmentNumbers.value);
      deliveredOn = form.elements.delivered.checked ? window.atlasRoutingStorage.date(form.elements.deliveredOn.value) : null;
      dispatchedOn = window.atlasRoutingStorage.deliveredDate(form.elements.dispatchedOn.value);
      if (deliveredOn && deliveredOn > todayPacific()) throw new Error("A confirmed delivery date cannot be in the future.");
      if (dispatchedOn && dispatchedOn > todayPacific()) throw new Error("A sent-out date cannot be in the future.");
      if (dispatchedOn && deliveredOn && deliveredOn < dispatchedOn) throw new Error("Delivery cannot be before the sent-out date.");
      if (state.editId && isLockedOrder(state.editId) && !state.orders.find((item) => item.id === state.editId)?.dispatchedOn && deliveredOn) throw new Error("This split order still has an unsent shipment and cannot be confirmed delivered.");
    } catch (error) { find("[data-route-form-error]").textContent = error.message; return; }
    if (state.orders.some((order) => order.id !== state.editId && order.date === date && order.orderNumber.toUpperCase() === orderNumber.toUpperCase())) {
      find("[data-route-form-error]").textContent = "This order is already on this day. Open its customer name to add more documents or edit its quantities.";
      return;
    }
    const order = {
      id: state.editId || crypto.randomUUID(), date, orderNumber, invoiceNumbers, fulfillmentNumbers, deliveredOn, dispatchedOn, deliveryException: form.elements.deliveryException.value.trim(),
      ...Object.fromEntries(["customer", "address", "city", "timeWindow", "notes"].map((key) => [key, form.elements[key].value.trim()])),
      serviceMinutes: Number(form.elements.serviceMinutes.value),
      checkOnDelivery: form.elements.checkOnDelivery.checked || core.hasCheckOnDelivery(form.elements.notes.value),
      lines: [...find("[data-route-lines]").children].map((row) => ({ sku: row.querySelector("[data-line-sku]").value.trim(), caseQty: Number(row.querySelector("[data-line-cases]").value), itemQty: row.querySelector("[data-line-units]").value || null })),
      photos: [...state.draftPhotos],
    };
    if (state.editId && isLockedOrder(state.editId)) {
      const original = state.orders.find((item) => item.id === state.editId);
      const protectedFields = ["orderNumber", "customer", "address", "city", "timeWindow", "serviceMinutes", "notes", "checkOnDelivery", "dispatchedOn"];
      const lineValues = (value) => value.map((line) => ({ sku: line.sku, caseQty: Number(line.caseQty), itemQty: line.itemQty == null ? null : Number(line.itemQty) }));
      if (protectedFields.some((key) => JSON.stringify(order[key]) !== JSON.stringify(original[key])) || JSON.stringify(lineValues(order.lines)) !== JSON.stringify(lineValues(original.lines))) {
        find("[data-route-form-error]").textContent = "This trip was sent out. Reopen the latest trip before changing its load or sent-out date."; return;
      }
    }
    if (![orderNumber, order.customer, order.address, order.city].every(Boolean) || order.lines.some((line) => !line.sku)) {
      find("[data-route-form-error]").textContent = "Complete the order number, customer, address, city, and SKU fields.";
      return;
    }
    if (date !== selectedDay) {
      const request = {}, generation = draftGeneration, owner = state.ownerId;
      intakeRequest = request; form.inert = true;
      const current = () => intakeRequest === request && draftGeneration === generation && state.open && state.ownerId === owner && window.AtlasAuth?.getSession()?.user?.id === owner && (event.intakeDate ? documentFlow?.active() : find(".atlas-route-intake").open);
      try {
        if (storage()?.enabled) {
          if (!savedDay.ready || !savedDay.canEdit || savedDay.day !== selectedDay) throw new Error("Open an editable saved day before adding the order.");
          if (savedDay.dirty) {
            await saveDay();
            if (!current()) return;
            if (savedDay.dirty) throw new Error("Today's changes could not be saved. Your new order is still here; retry after resolving Save Day.");
          }
          const fallback = { ...dayDocument(), date, orders: [], assignments: {}, vanConfirmed: {}, lockedTrips: [] };
          savedDay.busy = true; showSaveStatus();
          find("[data-route-form-error]").textContent = `Opening delivery day ${date}…`;
          const result = await storage().load(date);
          if (!current()) return;
          if (result.date !== date || !result.canEdit) throw new Error("The next delivery day could not be opened for editing. Your order has not been added.");
          if (result.document?.orders.some(item => item.orderNumber.toUpperCase() === orderNumber.toUpperCase())) throw new Error("This order is already on the next delivery day. Open that day to update its existing order.");
          find("[data-route-date]").value = date;
          applySavedDay({ ...result, document: result.document || fallback }, { preserveDraft: true });
        } else {
          throw new Error(`This order belongs to ${date}. Connect shared saving before switching days so today's work is preserved.`);
        }
      } catch (error) {
        if (current()) find("[data-route-form-error]").textContent = error.message;
        return;
      } finally {
        if (intakeRequest === request) { intakeRequest = null; savedDay.busy = false; form.inert = false; showSaveStatus(); }
      }
    }
    const index = state.orders.findIndex((item) => item.id === order.id);
    if (index < 0) state.orders.push(order); else state.orders[index] = order;
    state.newUrls = [];
    const plan = renderOrders();
    if (addNext) {
      cleanupDraft();
      openDraft();
      find("[data-route-entry-status]").textContent = orderNumber + " added · " + dayOrders().length + " orders on this day. " + orderLoadMessage(plan, order.id) + (dayOrders().some((item) => (item.dispatchedOn || item.deliveredOn) && !isLockedOrder(item.id)) ? " This day has older sent-out statuses without trip locks; review the plan." : "") + " Ready for the next order.";
      form.elements.orderNumber.focus();
      find(".atlas-route-intake").scrollTop = 0;
    } else if (!event.intakeDate) find(".atlas-route-intake").close();
    return order;
  }

  function cleanupDraft() {
    draftGeneration++;
    cancelPhotoReading();
    state.newUrls.forEach((url) => { URL.revokeObjectURL(url); state.allUrls.delete(url); });
    state.newUrls = [];
    state.draftPhotos = [];
    state.editId = null;
    find("[data-route-preview]")?.replaceChildren();
    const input = find("[data-route-images]");
    if (input) input.value = "";
  }

  function canReorderOrder(id, accessOnly = false) {
    const order = dayOrders().find((item) => item.id === id);
    return !!order && state.open && state.ownerId === window.AtlasAuth?.getSession()?.user?.id &&
      (accessOnly || (!state.planningController && !savedDay.busy)) && (!storage()?.enabled || (savedDay.ready && savedDay.canEdit)) &&
      !isLockedOrder(id) && !order.dispatchedOn && !order.deliveredOn;
  }

  function installOrderDragging(section) {
    let suppressClickUntil = 0;
    cancelOrderDrag = () => {
      const drag = state.drag; state.drag = null;
      if (!drag) return;
      clearTimeout(drag.timer);
      drag.row.classList.remove("is-holding-order", "is-dragging-order");
      drag.layer?.remove();
      section.querySelectorAll(".is-drop-target").forEach((row) => row.classList.remove("is-drop-target"));
      if (drag.active) suppressClickUntil = Date.now() + 700;
      if (drag.row.hasPointerCapture(drag.pointerId)) drag.row.releasePointerCapture(drag.pointerId);
    };
    const position = (drag, x, y) => {
      if (drag.layer) drag.layer.style.transform = `translate3d(${x - drag.offsetX}px,${y - drag.offsetY}px,0)`;
    };
    const activate = (drag) => {
      if (state.drag !== drag || !drag.row.isConnected || !canReorderOrder(drag.id)) { cancelOrderDrag(); return; }
      drag.active = true;
      const rect = drag.row.getBoundingClientRect();
      drag.offsetX = drag.x - rect.left; drag.offsetY = drag.y - rect.top;
      const layer = document.createElement("div"), table = document.createElement("table"), body = document.createElement("tbody"), clone = drag.row.cloneNode(true);
      layer.className = "atlas-route-table-scroll atlas-route-drag-card";
      layer.setAttribute("aria-hidden", "true"); layer.inert = true;
      clone.removeAttribute("data-route-row"); clone.classList.remove("is-holding-order");
      clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
      layer.style.width = rect.width + "px"; body.appendChild(clone); table.appendChild(body); layer.appendChild(table); section.appendChild(layer);
      drag.layer = layer; drag.row.classList.remove("is-holding-order"); drag.row.classList.add("is-dragging-order");
      drag.row.setPointerCapture(drag.pointerId); position(drag, drag.x, drag.y);
    };
    section.addEventListener("click", (event) => {
      if (Date.now() < suppressClickUntil && event.target.closest("[data-route-edit]")) { suppressClickUntil = 0; event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    section.addEventListener("pointerdown", (event) => {
      const row = event.target.closest("[data-route-row]"), handle = event.target.closest("[data-route-drag]");
      const mobile = event.pointerType !== "mouse" || matchMedia("(max-width:750px)").matches;
      if (!row || state.drag || event.button !== 0 || !canReorderOrder(row.dataset.routeRow) || (!mobile && !handle)) return;
      if (mobile && event.target.closest("input,select,textarea,summary,[data-route-move],[data-dispatch-promote],[data-dispatch-choose]")) return;
      const drag = { id: row.dataset.routeRow, target: row.dataset.routeRow, pointerId: event.pointerId, row, x: event.clientX, y: event.clientY, active: false };
      state.drag = drag;
      if (mobile) { row.classList.add("is-holding-order"); drag.timer = setTimeout(() => activate(drag), 1000); }
      else { event.preventDefault(); activate(drag); }
    });
    section.addEventListener("pointermove", (event) => {
      const drag = state.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!drag.active) { if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 10) cancelOrderDrag(); return; }
      event.preventDefault(); position(drag, event.clientX, event.clientY);
      const row = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-route-row]");
      const trip = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-route-trip-drop]");
      drag.trip = trip && Number(trip.dataset.routeTripDrop) >= state.lockedTrips.length ? Number(trip.dataset.routeTripDrop) : null;
      drag.target = row && canReorderOrder(row.dataset.routeRow) ? row.dataset.routeRow : null;
      section.querySelectorAll("[data-route-row]").forEach((item) => item.classList.toggle("is-drop-target", item.dataset.routeRow === drag.target && drag.id !== drag.target));
    });
    section.addEventListener("touchmove", (event) => { if (state.drag?.active) event.preventDefault(); }, { passive: false });
    section.addEventListener("touchstart", (event) => { if (event.touches.length > 1) cancelOrderDrag(); }, { passive: true });
    section.addEventListener("contextmenu", (event) => { if (state.drag && event.target.closest("[data-route-row]")) event.preventDefault(); });
    section.addEventListener("pointerup", (event) => {
      const drag = state.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const { id, target, active, trip } = drag;
      cancelOrderDrag();
      const sourceTrip = state.loads.findIndex(load=>load.shipments.some(s=>s.orderId===id));
      if (active && trip != null && trip !== sourceTrip) openDispatchMove(id, trip);
      else if (active && target && id !== target) moveOrder(id, target);
    });
    section.addEventListener("pointercancel", cancelOrderDrag);
    section.addEventListener("lostpointercapture", (event) => { if (state.drag?.pointerId === event.pointerId) cancelOrderDrag(); });
    section.addEventListener("keydown", (event) => { if (event.key === "Escape") cancelOrderDrag(); });
    window.addEventListener("blur", cancelOrderDrag);
    document.addEventListener("visibilitychange", () => { if (document.hidden) cancelOrderDrag(); });
  }

  function moveOrder(id, targetId) {
    if (!canReorderOrder(id) || !canReorderOrder(targetId)) return;
    const day = dayOrders();
    const from = day.findIndex((order) => order.id === id);
    const to = day.findIndex((order) => order.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    day.splice(to, 0, day.splice(from, 1)[0]);
    const date = find("[data-route-date]").value;
    find("[data-route-preserve]").checked = true;
    state.orders = [...state.orders.filter((order) => order.date !== date), ...day];
    renderOrders();
    flashOrderPlacement(id);
  }

  function renderOrders({ keepAssignments = false, dirty = true } = {}) {
    cancelOrderDrag();
    if (dirty && storage()?.enabled && state.open) { savedDay.dirty = true; savedDay.message = ""; }
    invalidatePlan();
    if (!keepAssignments) { state.assignments = Object.fromEntries(state.lockedTrips.map((trip, index) => [index, trip.assignment])); state.vanConfirmed = Object.fromEntries(state.lockedTrips.map((trip, index) => [index, trip.vanConfirmed])); vehicleChanges = {}; }
    const orders = dayOrders();
    const analyzed = orders.map((order) => ({ ...core.analyzeOrder(order, state.catalog), source: order }));
    find("[data-route-orders]").innerHTML = analyzed.length ? analyzed.map((result, index) => {
      const order = result.source;
      const van = core.assessVanLoad([result]);
      const fit = van.status === "fits-estimate" ? "Van: likely fits*" : van.status === "does-not-fit" ? "Van: does not fit" : `Van: warehouse check${van.percent == null ? "" : ` · ${van.percent}%`}`;
      return `<tr data-route-row="${order.id}"><td class="atlas-route-order-position"><button type="button" data-route-drag="${order.id}" aria-label="Drag ${escape(order.customer)} to reorder" title="Drag to reorder">⠿ ${index + 1}</button><div><button type="button" aria-label="Move ${escape(order.customer)} up" data-route-move="-1" data-id="${order.id}" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" aria-label="Move ${escape(order.customer)} down" data-route-move="1" data-id="${order.id}" ${index === orders.length - 1 ? "disabled" : ""}>↓</button></div></td><td><button type="button" class="atlas-route-order-link" data-route-edit="${order.id}">${escape(order.customer)}</button><small>${escape(order.orderNumber)}${order.photos.length ? ` · ${order.photos.length} photos` : ""}</small><small>${escape(isLockedOrder(order.id) && !order.dispatchedOn ? "Partially sent out" : window.atlasRoutingStorage.deliveryStatus(order).label)}${window.atlasRoutingStorage.deliveryStatus(order).date ? ` · ${escape(window.atlasRoutingStorage.deliveryStatus(order).date)}` : ""}</small>${result.issues.length ? '<small class="atlas-route-warning">Review needed</small>' : ""}</td><td>${escape(order.city)}</td><td><strong>${result.palletSpaces ?? "—"}</strong><small title="${escape(van.reason)}">${escape(fit)}</small></td><td>${escape(order.timeWindow)}</td><td>${order.checkOnDelivery ? '<strong class="atlas-route-check-badge">CHECK ON DELIVERY</strong>' : ""}${escape(order.checkOnDelivery && /^CHECK\s+ON\s+DELIVERY$/i.test(order.notes) ? "" : order.notes)}${result.issues.length ? `<details><summary>Review ${result.issues.length} item${result.issues.length === 1 ? "" : "s"}</summary>${result.issues.map((issue) => `<p>${escape(issue)}</p>`).join("")}</details>` : ""}</td></tr>`;
    }).join("") : '<tr><td colspan="6" class="atlas-route-empty">No deliveries for this day. Select Add Orders to begin.</td></tr>';
    const plan = core.countTruckTrips(analyzed.map((order) => ({ ...order, palletSpaces: order.issues.some((issue) => issue.includes("item quantity") || issue.includes("case quantity")) ? null : order.palletSpaces })), { truckPalletTarget: state.truckPalletTarget, dailyTripTarget: state.dailyTripTarget, lockedTrips: state.lockedTrips });
    state.loads = plan.trips;
    state.loadPlan = plan;
    state.analyzed = analyzed;
    plan.trips.forEach((trip, index) => {
      if (trip.locked) return;
      const resolved = core.resolveVanAssignment(state.assignments[index] || "Bubba:truck", trip.shipments, state.catalog);
      if (!resolved.switched) return;
      state.assignments[index] = resolved.assignment;
      state.vanConfirmed[index] = false;
      vehicleChanges[index] = `Trip ${index + 1} moved to Bubba · Box Truck: ${resolved.fit.reason}${resolved.fit.percent == null ? "" : ` (${resolved.fit.percent}%)`}.`;
      if (storage()?.enabled && savedDay.canEdit) { savedDay.dirty = true; savedDay.message = ""; }
    });
    renderCapacity(plan, orders);
    find("[data-route-optimize]").disabled = !orders.length || !plan.trips.length || Boolean(plan.unscheduled.length) || !window.atlasRoutingConnection?.available;
    const knownPallets = analyzed.reduce((sum, order) => sum + (order.palletSpaces || 0), 0);
    find("[data-route-total-orders]").textContent = String(orders.length);
    find("[data-route-total-pallets]").textContent = analyzed.some((order) => order.palletSpaces == null) ? `${knownPallets} + review` : String(knownPallets);
    find("[data-route-total-trips]").textContent = orders.length ? `${plan.trips.length}${plan.unscheduled.length ? " + review" : ""}` : "—";
    find("[data-route-total-trips]").title = "Planning-target estimate only; extra trips are allowed and timing still needs review.";
    find("[data-route-freight]").textContent = `${plan.trips.reduce((sum, trip) => sum + trip.palletSpaces, 0)} pallets`;
    find("[data-route-plan]").innerHTML = !orders.length ? `<div class="atlas-route-plan-empty"><span class="atlas-route-empty-icon">${icon("route")}</span><strong>Your delivery plan starts here</strong><p>Add orders and product specifications to see trip cards and load estimates.</p></div>` : `
      <div class="atlas-route-plan-banner"><span class="atlas-route-plan-icon">${icon("truck")}</span><div><strong>TRUCK LOAD PLAN</strong><p>Stops follow your chosen order · ${plan.trips.length} estimated trip${plan.trips.length === 1 ? "" : "s"}</p></div><p class="atlas-route-plan-status">Timing pending<br />Select Optimize Routes to calculate traffic and timing.</p></div>
      ${plan.warnings.length ? `<div class="atlas-route-planning-review" role="status">${plan.warnings.map((warning) => `<p>${escape(warning)}</p>`).join("")}</div>` : ""}
      ${plan.trips.map((trip, index) => `<article class="atlas-route-trip"><span class="atlas-route-trip-number">${index + 1}</span><div><header><strong>Trip ${index + 1}</strong><label class="atlas-route-assignment">Driver / vehicle<select data-route-assignment="${index}" aria-label="Driver and vehicle for trip ${index + 1}" ${trip.locked ? "disabled" : ""}>${[["Bubba:truck", "Bubba · Box Truck"], ["Bubba:van1", "Bubba · Van 1"], ["Bubba:van2", "Bubba · Van 2"], ["Achmad:van1", "Achmad · Van 1"], ["Achmad:van2", "Achmad · Van 2"]].map(([value, label]) => `<option value="${value}" ${(state.assignments[index] || "Bubba:truck") === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><span class="atlas-route-trip-stats"><b>${(state.assignments[index] || "").includes(":van") ? `${trip.palletSpaces} pallet equivalents` : `${trip.palletSpaces} / ${state.truckPalletTarget} target pallets`}</b><span>${trip.shipments.length} stop${trip.shipments.length === 1 ? "" : "s"}</span><span>Timing pending</span></span></header>${trip.locked ? `<small class="atlas-route-check-badge">Sent out ${escape(trip.sentOn)} - load locked</small>` : ""}${trip.needsWarehouseReview ? '<small class="atlas-route-check-badge">Warehouse fit review · above usual 11 pallets</small>' : ""}${trip.needsScheduleReview ? '<small class="atlas-route-check-badge">Additional trip · schedule review</small>' : ""}<p class="atlas-route-trip-path">${icon("pin")}<span>Warehouse → ${trip.shipments.map((shipment) => `${escape(shipment.customer)} (${shipment.palletSpaces})`).join(" → ")} → Warehouse</span></p>${vehicleChanges[index] ? `<p class="atlas-route-planning-review" role="status" data-route-vehicle-change="${index}">${escape(vehicleChanges[index])}</p>` : ""}${vanLoadReview(trip, index)}${loadBoxList(trip)}${trip.shipments.some((shipment) => orders.find((order) => order.id === shipment.orderId)?.checkOnDelivery) ? '<small class="atlas-route-check-badge">CHECK ON DELIVERY on this trip</small>' : ""}</div></article>`).join("")}
      ${plan.unscheduled.length ? `<div class="atlas-route-unscheduled"><strong>Unscheduled deliveries</strong>${plan.unscheduled.map((shipment) => `<p>${escape(shipment.customer)}${shipment.palletSpaces == null ? "" : ` · ${shipment.palletSpaces} pallet spaces`} — ${escape(shipment.reason)}</p>`).join("")}</div>` : ""}
      <p class="atlas-route-intake-note">* Van estimates use upright stacks, the space between the wheel wells, and the 80% volume target. Stacking strength and the actual cargo-space shape still need warehouse confirmation. Different SKU models are rounded separately; pallets are never shared between orders.</p>`;
    find("[data-route-trip-controls]").innerHTML = !storage()?.enabled || !savedDay.ready || !savedDay.canEdit ? "" :
      `<div class="atlas-route-card-tools">${state.lockedTrips.length ? `<span>${state.lockedTrips.length} sent-out trip${state.lockedTrips.length === 1 ? "" : "s"} retained for this day.</span><button type="button" class="atlas-route-button" data-route-reopen-last>Reopen Trip ${state.lockedTrips.length}</button>` : "<span>Mark a trip sent out when it leaves Chubby Gorilla.</span>"}${plan.trips[state.lockedTrips.length] ? `<button type="button" class="atlas-route-button atlas-route-primary" data-route-lock-next>Mark Trip ${state.lockedTrips.length + 1} Sent Out</button>` : ""}</div>`;
    showSaveStatus();
    renderDispatch();
    return plan;
  }

  function rolloverMessage(move) {
    return `${move.customer} needs ${move.requiredPallets} pallet spaces; Trip ${move.fromTrip} has ${move.availablePallets} left (${move.excessPallets} over target). Kept together on Trip ${move.toTrip}.`;
  }

  function orderLoadMessage(plan, orderId) {
    if (plan.unscheduled.some((item) => item.orderId === orderId)) return "Pallet count or load allocation needs review.";
    const trips = plan.trips.map((trip, index) => ({ ...trip, number: index + 1 }))
      .filter((trip) => trip.shipments.some((shipment) => shipment.orderId === orderId));
    if (trips.length > 1) return `SPLIT SHIPMENT: ${trips.length} shipments on Trips ${trips.map((trip) => trip.number).join(", ")}.`;
    const move = plan.rollovers.find((item) => item.orderId === orderId);
    if (move) return rolloverMessage(move);
    const trip = trips[0];
    if (!trip) return "Load allocation needs review.";
    const room = plan.targets.truckPalletTarget - trip.palletSpaces;
    return `Trip ${trip.number}: ${trip.palletSpaces} / ${plan.targets.truckPalletTarget} target pallets. ${plan.unscheduled.length ? "Other pallet counts need review; remaining space is not confirmed." : room ? `${room} pallet spaces left in the plan.` : "At planning target; review before departure."}`;
  }

  function renderCapacity(plan, orders) {
    const panel = find("[data-route-capacity]");
    const truckTrips = plan.trips.map((trip, index) => ({ ...trip, number: index + 1 }))
      .filter((trip) => !trip.locked && !(state.assignments[trip.number - 1] || "").includes(":van"));
    const latest = truckTrips.at(-1), target = plan.targets.truckPalletTarget;
    const sentOut = orders.some((order) => (order.dispatchedOn || order.deliveredOn) && !isLockedOrder(order.id));
    const review = plan.unscheduled.length > 0 || sentOut;
    const remaining = latest ? target - latest.palletSpaces : target;
    const title = !orders.length ? `Truck target: ${target} pallets` : latest
      ? `Latest planned truck load · Trip ${latest.number}: ${latest.palletSpaces} / ${target} target pallets`
      : state.lockedTrips.length ? "All planned truck loads have been sent out" : "No truck load assigned";
    const detail = !orders.length ? "Add orders to track remaining pallet space." : review
      ? "Review needed before treating any space as available."
      : !latest ? state.lockedTrips.length ? "New orders will start another trip." : "Check the van estimates in the trip cards below."
      : remaining ? `${remaining} pallet spaces left in this planned load.`
      : "At planning target · the next order starts another trip.";
    const latestMove = plan.rollovers.at(-1);
    const splitIds = [...new Set(plan.trips.flatMap((trip) => trip.shipments.map((shipment) => shipment.orderId)))]
      .filter((id) => plan.trips.filter((trip) => trip.shipments.some((shipment) => shipment.orderId === id)).length > 1);
    panel.classList.toggle("needs-review", review || Boolean(latestMove) || Boolean(latest && !remaining));
    panel.innerHTML = `<strong>${icon("truck")}${escape(title)}</strong><p>${escape(detail)}</p>
      ${latest && !review ? `<meter min="0" max="${target}" value="${latest.palletSpaces}" aria-label="Pallet spaces on the latest planned truck load"></meter>` : ""}
      ${latestMove ? `<p>${escape(rolloverMessage(latestMove))} Adjust Truck Pallet Target in Route Setup if the warehouse can accommodate more.</p>` : ""}
      ${splitIds.map((id) => `<p><b>SPLIT SHIPMENT</b> · ${escape(orders.find((order) => order.id === id)?.customer)} · ${escape(orderLoadMessage(plan, id).replace(/^SPLIT SHIPMENT: /, ""))}</p>`).join("")}
      ${plan.unscheduled.length ? `<p>${plan.unscheduled.length} order${plan.unscheduled.length === 1 ? " still needs" : "s still need"} pallet/allocation review. Known loads exclude those quantities.</p>` : ""}
      ${sentOut ? "<p>Sent-out dates are recorded, but trips are not locked yet. Review the load plan before adding more orders.</p>" : ""}
      <small>Planning space only; load arrangement and departure timing still need review.</small>`;
  }

  function invalidatePlan() {
    clearTripSheet();
    state.planningGeneration++;
    state.planningController?.abort(); state.planningController = null; state.planned = null;
    window.atlasRoutingConnection?.clear();
    for (const name of ["drive", "distance", "utilization"]) if (find(`[data-route-${name}]`)) find(`[data-route-${name}]`).textContent = "—";
    if (find("[data-route-progress]")) find("[data-route-progress]").textContent = "";
    if (find("[data-route-stop]")) find("[data-route-stop]").hidden = true;
    const relief = find(".atlas-route-relief strong");
    if (relief) relief.textContent = "Achmad · standby";
  }

  const displayTime = (value) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }).format(new Date(value));
  function clearTripSheet() {
    printingTripSheet = false;
    find(".atlas-route-trip-sheet")?.close();
    find("[data-route-sheet-content]")?.replaceChildren();
    root.classList.remove("atlas-routing-print-sheet");
  }
  function openTripSheet(tripIndex) {
    if (!state.open || state.ownerId !== window.AtlasAuth?.getSession()?.user?.id) return;
    let sheet;
    try {
      sheet = window.atlasRoutingPlanner.tripSheet({ date: find("[data-route-date]").value, plan: state.planned, tripIndex, orders: dayOrders(), loads: state.loads });
    } catch (error) { find("[data-route-progress]").textContent = error.message; return; }
    find("[data-route-sheet-content]").innerHTML = `
      <header class="atlas-route-sheet-header"><img class="atlas-route-sheet-logo" src="./chubby-gorilla-header-v2.png" alt="Chubby Gorilla" width="348" height="82" /><span>Trip Sheet</span><h1>Trip ${sheet.number} · ${escape(sheet.driver)}</h1><p>${escape(sheet.date)} · ${escape(sheet.vehicle)} · ${sheet.stops.length} stops · ${sheet.palletSpaces} pallets</p></header>
      ${sheet.warnings.length ? `<aside class="atlas-route-sheet-review"><strong>Review before departure</strong>${sheet.warnings.map((warning) => `<p>${escape(warning)}</p>`).join("")}</aside>` : ""}
      ${sheet.lunch ? `<p><strong>Lunch:</strong> ${displayTime(sheet.lunch.start)}–${displayTime(sheet.lunch.end)}</p>` : ""}
      ${sheet.stops.map((stop) => `<section class="atlas-route-sheet-stop"><h2>${stop.number}. ${escape(stop.customer)} <span>${stop.palletSpaces} pallets</span></h2><p><strong>Sales order:</strong> ${escape(stop.orderNumber)}</p>${stop.checkOnDelivery ? '<p class="atlas-route-sheet-check">CHECK ON DELIVERY</p>' : ""}<p class="atlas-route-sheet-address">${escape(stop.address)}</p>${stop.timeWindow ? `<p><strong>Customer hours:</strong> ${escape(stop.timeWindow)}</p>` : ""}${stop.split ? splitShipmentNote(stop) : ""}${stop.lines.length ? `<table><thead><tr><th>SKU</th><th>Boxes</th></tr></thead><tbody>${stop.lines.map((line) => `<tr><td>${escape(line.sku)}</td><td>${escape(line.boxes)}</td></tr>`).join("")}</tbody></table>` : ""}${stop.notes ? `<p class="atlas-route-sheet-notes"><strong>Notes:</strong> ${escape(stop.notes)}</p>` : ""}</section>`).join("")}`;
    root.classList.add("atlas-routing-print-sheet");
    find(".atlas-route-trip-sheet").showModal();
  }
  function splitShipmentNote(stop) {
    const label = (number) => `<strong>Shipment ${number} of ${stop.shipmentCount}</strong>`;
    const others = Array.from({ length: stop.shipmentCount }, (_, index) => index + 1).filter((number) => number !== stop.shipmentNumber).map(label);
    const remaining = others.length > 1 ? `${others.slice(0, -1).join(", ")} and ${others.at(-1)}` : others[0];
    return `<p class="atlas-route-sheet-review"><strong>SPLIT SHIPMENT — SHIPMENT ${stop.shipmentNumber} OF ${stop.shipmentCount}</strong><br />Load only the pallet count assigned to ${label(stop.shipmentNumber)}. Confirm SKU and box allocation before loading. All ${stop.shipmentNumber === 1 ? "remaining" : "other"} pallets for this customer are assigned to ${remaining}.</p>`;
  }
  function loadBoxList(trip) {
    return `<details><summary>Boxes for this trip</summary>${trip.shipments.map((shipment) => `<p><strong>${escape(shipment.customer)}</strong> · ${shipment.palletSpaces} pallets</p>${shipment.boxAllocation ? `<ul>${shipment.boxAllocation.map((line) => `<li>${escape(line.sku)} · ${line.boxes} boxes</li>`).join("")}</ul>` : "<p>Confirm SKU and box allocation with the warehouse.</p>"}`).join("")}</details>`;
  }
  function vanLoadReview(trip, index) {
    if (!(state.assignments[index] || "").includes(":van")) return "";
    const fit = core.assessVanShipments(trip.shipments, state.catalog);
    const label = fit.status === "fits-estimate" ? "Likely fits" : fit.status === "does-not-fit" ? "Does not fit" : "Warehouse check needed";
    return `<div class="atlas-route-planning-review" data-route-van-fit="${index}"><strong>Loose-box van load: ${label}${fit.percent == null ? "" : ` · ${fit.percent}%`}</strong><p>${escape(fit.reason)}</p>${fit.allocationComplete && fit.status === "warehouse-check" ? `<label class="atlas-route-van-confirm"><input type="checkbox" data-route-confirm-van="${index}" ${state.vanConfirmed[index] ? "checked" : ""} /> Warehouse confirmed this van load fits</label>` : ""}</div>`;
  }
  function getReliefOptions(plan) {
    return window.atlasRoutingPlanner.reliefOptions({ date: find("[data-route-date]").value, plan, loads: state.loads, orders: dayOrders(),
      assessVan: (shipments) => core.assessVanShipments(shipments, state.catalog) });
  }
  function renderTimedPlan(plan) {
    state.planned = plan;
    const issues = [...Object.values(vehicleChanges), ...plan.warnings, ...state.loads.flatMap((load, index) => [
      ...(load.needsWarehouseReview ? [`Trip ${index + 1}: warehouse fit review above the usual 11 pallets.`] : []),
      ...(load.needsScheduleReview ? [`Trip ${index + 1}: additional trip — review the schedule.`] : []),
    ])];
    find("[data-route-drive]").textContent = `${Math.round(plan.driveSeconds / 60)} min${plan.complete ? "" : " so far"}`;
    find("[data-route-distance]").textContent = `${(plan.distanceMeters / 1609.344).toFixed(1)} mi`;
    find("[data-route-utilization]").textContent = plan.complete ? Object.entries(plan.drivers).filter(([, driver]) => driver.trips).map(([name, driver]) => `${name} ${driver.utilizationPercent}%`).join(" · ") || "—" : "Pending";
    find("[data-route-freight]").textContent = `${plan.trips.reduce((sum, trip) => sum + trip.visits.reduce((subtotal, visit) => subtotal + trip.shipments[visit.stopIndex].palletSpaces, 0), 0)} pallets`;
    find(".atlas-route-relief strong").textContent = plan.drivers.Achmad.trips ? `Achmad · ${plan.drivers.Achmad.trips} planned van trip${plan.drivers.Achmad.trips === 1 ? "" : "s"}` : "Achmad · standby";
    const accounted = new Set([...plan.trips.map((trip) => trip.tripIndex), ...plan.unscheduled.map((item) => item.tripIndex)]);
    const pending = state.loads.map((load, index) => ({ load, index })).filter(({ index }) => !accounted.has(index));
    const relief = getReliefOptions(plan);
    find("[data-route-plan]").innerHTML = `<div class="atlas-route-plan-banner"><span class="atlas-route-plan-icon">${icon("truck")}</span><div><strong>${plan.complete ? "DAILY ROUTE ESTIMATE" : "CALCULATION IN PROGRESS"}</strong><p>${plan.trips.length} calculated trips · ${plan.unscheduled.length} unscheduled shipments</p></div><p class="atlas-route-plan-status">${issues.length || plan.unscheduled.length ? "Review needed" : plan.complete ? "Ready for review" : "Day is incomplete"}</p></div>
      ${issues.length ? `<div class="atlas-route-planning-review">${issues.map((issue) => `<p>${escape(issue)}</p>`).join("")}</div>` : ""}
      ${relief.length ? `<div class="atlas-route-planning-review" data-route-relief-options><strong>Could Achmad help?</strong><p>Bubba's estimated day runs past 3 PM. These loads are estimated to fit as loose boxes in a van. Try one to recalculate the day and check Achmad's hours, customer windows and traffic.</p>${relief.map((option) => `<button type="button" class="atlas-route-button" data-route-try-relief="${option.tripIndex}">Trip ${option.tripIndex + 1}: Try Achmad · ${option.vehicleId === "van2" ? "Van 2" : "Van 1"}</button>`).join(" ")}</div>` : ""}
      ${plan.trips.map((trip) => {
        const visits = trip.visits.map((visit) => ({ ...visit, shipment: trip.shipments[visit.stopIndex] }));
        const params = new URLSearchParams({ api: "1", origin: DEPOT, destination: DEPOT, travelmode: "driving", waypoints: visits.map((visit) => { const p = trip.locations[visit.stopIndex].location; return `${p.latitude},${p.longitude}`; }).join("|") });
        return `<article class="atlas-route-trip"><span class="atlas-route-trip-number">${trip.tripIndex + 1}</span><div><header><strong>Trip ${trip.tripIndex + 1} — ${escape(trip.driver)} · ${trip.vehicle === "truck" ? "Box Truck" : trip.vehicleId === "van2" ? "Van 2" : "Van 1"}</strong><span class="atlas-route-trip-stats"><b>${visits.reduce((sum, visit) => sum + visit.shipment.palletSpaces, 0)} pallets</b><span>${Math.round(trip.driveSeconds / 60)} min driving</span></span></header><p><strong>${displayTime(trip.departure)} → ${displayTime(trip.returnTime)}</strong> · ${(trip.distanceMeters / 1609.344).toFixed(1)} mi${trip.overtime ? ' · <strong class="atlas-route-warning">After shift — review</strong>' : ""}</p><ol class="atlas-route-arrivals">${visits.map((visit) => { const order = dayOrders().find((item) => item.id === visit.shipment.orderId); return `<li><time>${displayTime(visit.arrival)}</time> ${escape(visit.shipment.customer)} · ${visit.shipment.palletSpaces} pallets${order?.checkOnDelivery ? ' <strong class="atlas-route-check-badge">CHECK ON DELIVERY</strong>' : ""}<small>${escape(trip.locations[visit.stopIndex].formattedAddress)}</small></li>`; }).join("")}</ol>${trip.lunch ? `<p>Lunch · ${displayTime(trip.lunch.start)}–${displayTime(trip.lunch.end)}</p>` : ""}${visits.length <= 9 ? `<a class="atlas-route-button" target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/dir/?${escape(params.toString())}">Open in Google Maps</a>` : ""} <button type="button" class="atlas-route-button" data-route-print-trip="${trip.tripIndex}" ${plan.complete ? "" : 'disabled title="Finish calculating the day before printing"'}>${icon("print")}Print Trip</button></div></article>`;
      }).join("")}
      ${pending.length ? `<div class="atlas-route-unscheduled"><strong>Not calculated yet</strong>${pending.map(({ load, index }) => `<p>Trip ${index + 1} · ${load.palletSpaces} pallets · ${load.shipments.map((item) => escape(item.customer)).join(", ")}</p>`).join("")}</div>` : ""}
      ${plan.unscheduled.length ? `<div class="atlas-route-unscheduled"><strong>Unscheduled — review these deliveries</strong>${plan.unscheduled.map((item) => `<p>${escape(item.customer)} · ${item.palletSpaces} pallets — ${escape(item.reason)}</p>`).join("")}</div>` : ""}
      ${Object.entries(plan.drivers).filter(([, driver]) => driver.trips).map(([name, driver]) => `<p class="atlas-route-intake-note">${name}: ${driver.lunch ? `lunch ${displayTime(driver.lunch.start)}–${displayTime(driver.lunch.end)}` : "lunch reserved; timing pending"}${plan.complete ? ` · ${Math.round(driver.workMinutes)} working minutes / 480 available` : ""}.</p>`).join("")}
      <button type="button" class="atlas-route-button" data-route-adjust>Adjust loads / drivers</button><p class="atlas-route-intake-note">Google optimizes stops within each assigned load. Loads follow the order list; this is not a global fleet optimum or a truck-clearance navigation service. Times include traffic estimates, stops, reloads and lunch.</p>`;
    renderDispatch();
  }

  async function optimizeDay() {
    if (state.planningController || !window.atlasRoutingConnection?.available) return;
    const connection = window.atlasRoutingConnection;
    const loads = state.loads.map((load, index) => {
      const [driver, vehicleId] = (state.assignments[index] || "Bubba:truck").split(":");
      const vehicle = vehicleId === "truck" ? "truck" : "van";
      return { ...load, driver, vehicle, vehicleId, warehouseConfirmed: Boolean(state.vanConfirmed[index]), palletTarget: state.truckPalletTarget };
    });
    const status = find("[data-route-progress]");
    for (const load of loads.filter((load) => load.vehicle === "van")) {
      const fit = core.assessVanShipments(load.shipments, state.catalog);
      if (!fit.allocationComplete || fit.status === "does-not-fit" || (fit.status !== "fits-estimate" && !load.warehouseConfirmed)) {
        status.textContent = `Trip ${loads.indexOf(load) + 1}: ${fit.reason}${fit.percent == null ? "" : ` (${fit.percent}%)`}. ${fit.allocationComplete && fit.status === "warehouse-check" ? "Confirm the fit with the warehouse before using a van." : "Review the assigned boxes or use the box truck."}`;
        return;
      }
    }
    renderOrders({ keepAssignments: true, dirty: false });
    const generation = state.planningGeneration, owner = state.ownerId;
    const controller = new AbortController(); state.planningController = controller;
    showSaveStatus();
    const current = () => generation === state.planningGeneration && state.open && window.AtlasAuth?.getSession()?.user?.id === owner;
    find("[data-route-optimize]").disabled = true; find("[data-route-stop]").hidden = false;
    try {
      status.textContent = "Loading Google Maps…";
      await connection.showMap(find("[data-route-map]"));
      if (!current() || controller.signal.aborted) return;
      const result = await window.atlasRoutingPlanner.planDay({ date: find("[data-route-date]").value, loads, orders: dayOrders(),
        reloadMinutes: Number(find("[data-route-reload]").value), lunchMinutes: window.atlasRoutingPlanner.clock(find("[data-route-lunch]").value),
        preserveOrder: find("[data-route-preserve]").checked, geocode: connection.geocode, route: connection.route, signal: controller.signal,
        onProgress: (message) => { if (current()) status.textContent = message; },
        onUpdate: (plan) => { if (current()) renderTimedPlan(plan); },
      });
      if (!current()) return;
      await connection.drawRoutes(find("[data-route-map]"), result, current);
      if (current()) status.textContent = result.unscheduled.length ? "Routes calculated. Review the unscheduled deliveries below." : "Routes calculated. Review the trip times, loads and any schedule notes.";
    } catch (error) {
      if (current()) {
        status.textContent = error.name === "AbortError" ? "Calculation stopped. The day is incomplete; completed trips remain below." : error.message;
        if (state.planned) { state.planned.complete = false; renderTimedPlan(state.planned); }
      }
    } finally {
      if (current()) { state.planningController = null; find("[data-route-stop]").hidden = true; find("[data-route-optimize]").disabled = false; showSaveStatus(); }
    }
  }

  function leaveRouting(target) {
    if (window.atlasRoutingPOD?.hasPending() && !window.confirm("These POD pages are still saving or could not be saved. Leave without saving them?")) return false;
    if ((savedDay.dirty || savedDay.busy || documentFlow?.active()) && !window.confirm("There are unsaved changes or unfinished photo readings. Leave and clear temporary photos?")) return false;
    state.open = false;
    resetWorkspace();
    root.classList.remove("atlas-routing-open");
    document.getElementById("atlasDeliveryRouting").hidden = true;
    if (target === "Dashboard") window.atlasOpenDashboard?.();
    else {
      document.querySelector(`.premium-drawer-link[data-nav="${target}"]`)?.click();
    }
    return true;
  }

  function resetWorkspace() {
    document.getElementById("atlasDeliveryRouting")?.querySelectorAll('[data-routing-disabled]').forEach(el => { el.disabled = false; delete el.dataset.routingDisabled; });
    entryGeneration++; driverMode = false; accessReadOnly = false;
    cancelOrderDrag();
    window.atlasRoutingPOD?.reset();
    dispatchUI.tab = "orders"; dispatchUI.query = ""; dispatchUI.lastPlan = null;
    for (const name of ["settings","map","move"]) find(`[data-dispatch-${name}]`)?.close();
    if (find("[data-dispatch-query]")) find("[data-dispatch-query]").value = "";
    documentFlow?.reset(); find(".atlas-route-manager-more")?.close();
    if (find(".atlas-route-main")) find(".atlas-route-main").inert = false;
    intakeRequest = null;
    if (find("[data-route-order-form]")) find("[data-route-order-form]").inert = false;
    vehicleChanges = {};
    reminderDay = null; if (find("[data-route-review-request]")) find("[data-route-review-request]").hidden = true;
    find("[data-route-reminder-dialog]")?.close();
    history.generation++; history.matches = []; history.filters = {}; history.offset = 0;
    find("[data-route-history-dialog]")?.close(); find("[data-route-history-form]")?.reset(); find("[data-route-history-results]")?.replaceChildren();
    savedDay.generation++; storage()?.reset();
    Object.assign(savedDay, { day: null, revision: 0, ready: false, dirty: false, busy: false, canEdit: false, message: "" });
    if (document.getElementById("atlasDeliveryRouting")) document.getElementById("atlasDeliveryRouting").inert = false;
    find("[data-route-saved-review]")?.close();
    invalidatePlan();
    state.importGeneration++;
    state.allUrls.forEach((url) => URL.revokeObjectURL(url));
    state.allUrls.clear();
    state.orders = [];
    state.truckPalletTarget = 11; state.dailyTripTarget = 3; state.assignments = {}; state.lockedTrips = []; state.vanConfirmed = {};
    if (find("[data-route-reload]")) find("[data-route-reload]").value = "40";
    if (find("[data-route-lunch]")) find("[data-route-lunch]").value = "12:00";
    if (find("[data-route-preserve]")) find("[data-route-preserve]").checked = false;
    if (find("[data-route-truck-target]")) find("[data-route-truck-target]").value = "11";
    if (find("[data-route-trip-target]")) find("[data-route-trip-target]").value = "3";
    state.catalog = [];
    state.drag = null;
    state.ownerId = null;
    find(".atlas-route-intake")?.close();
    cleanupDraft();
    if (find("[data-route-orders]")) renderOrders({ dirty: false });
    if (find("[data-route-catalog-status]")) find("[data-route-catalog-status]").textContent = "Load product specifications to calculate pallets and van estimates.";
  }

  document.addEventListener("click", (event) => {
    const navigation = event.target.closest?.(".premium-drawer-link, [data-atlas-inventory-action]");
    if (state.open && navigation && navigation.dataset.action !== "routing" && !leaveRouting()) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);

  window.atlasOpenRouting = async () => {
    if (state.open) return;
    const session = window.AtlasAuth?.getSession();
    if (!session?.user?.id) {
      window.AtlasAuth?.open();
      return;
    }
    const entry = ++entryGeneration;
    let access;
    try { access = await window.atlasRoutingPOD?.access(); }
    catch { access = { capability: "driver" }; }
    if (entry !== entryGeneration || window.AtlasAuth?.getSession()?.user?.id !== session.user.id) return;
    mount();
    // Fail closed to the assigned-deliveries screen, without fetching an office day.
    driverMode = !!access && !["office", "viewer"].includes(access.capability);
    accessReadOnly = !!access && access.canEdit !== true;
    const displayName = window.AtlasAuth.displayName(session) || "ATLAS user";
    find("[data-route-user]").textContent = displayName;
    find("[data-route-avatar]").textContent = displayName.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
    state.ownerId = session.user.id;
    state.open = true;
    renderOrders({ dirty: false });
    document.getElementById("atlasDeliveryRouting").hidden = false;
    root.classList.add("atlas-routing-open");
    window.scrollTo(0, 0);
    dispatchUI.tab = driverMode ? "pods" : "orders";
    applyDispatchTab();
    applyReadOnlyControls();
    if (driverMode) void window.atlasRoutingPOD?.load();
    else if (storage()?.enabled) void loadDay();
  };
  window.atlasOpenDeliveryReview = async day => {
    if (!window.atlasRoutingNotifications.day(day) || day > todayPacific() || !window.AtlasAuth?.getSession()?.user?.id) return false;
    await window.atlasOpenRouting();
    if (driverMode || !state.open) return false;
    reminderDay = day;
    find("[data-route-review-request-text]").textContent = `Delivery review for ${day}. Your current work is preserved. Open a saved shipment to confirm delivery or report an issue.`;
    find("[data-route-review-request]").hidden = false;
    return true;
  };
  window.addEventListener("atlas-reminders-changed", showReminderStatus);
  window.addEventListener("beforeunload", event => {
    if (state.open && (savedDay.dirty || savedDay.busy || documentFlow?.active())) { event.preventDefault(); event.returnValue = ""; }
  });
  // A modal's top layer can clip long printed sheets. Temporarily render it
  // in normal document flow so all stops can paginate, then restore the modal.
  window.addEventListener("beforeprint", () => {
    const dialog = find(".atlas-route-trip-sheet");
    if (!dialog?.open) return;
    if (!state.open || !state.planned?.complete || state.ownerId !== window.AtlasAuth?.getSession()?.user?.id) { clearTripSheet(); return; }
    printingTripSheet = true;
    dialog.close(); dialog.setAttribute("open", "");
  });
  window.addEventListener("afterprint", () => {
    if (!printingTripSheet) return;
    printingTripSheet = false;
    const dialog = find(".atlas-route-trip-sheet");
    dialog.removeAttribute("open"); dialog.showModal();
  });
  window.addEventListener("beforeunload", (event) => { if (savedDay.dirty || savedDay.busy || find(".atlas-route-intake")?.open) { event.preventDefault(); event.returnValue = ""; } });
  window.addEventListener("atlas-auth-changed", (event) => {
    if (event.detail?.session?.user?.id !== state.ownerId) entryGeneration++;
    if (state.ownerId && event.detail?.session?.user?.id !== state.ownerId) void reminders()?.reset();
    if (!state.open || (event.detail?.session?.user?.id && event.detail.session.user.id === state.ownerId)) return;
    state.open = false;
    resetWorkspace();
    root.classList.remove("atlas-routing-open");
    document.getElementById("atlasDeliveryRouting").hidden = true;
  });
  window.addEventListener("storage", (event) => {
    if (state.open && /warehouse/i.test(event.key || "")) {
      void reminders()?.reset();
      resetWorkspace();
      state.open = false;
      root.classList.remove("atlas-routing-open");
      find(".atlas-route-intake")?.close();
      document.getElementById("atlasDeliveryRouting").hidden = true;
    }
  });
})();
