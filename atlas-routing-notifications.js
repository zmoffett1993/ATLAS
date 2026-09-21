/* Shared reminder policy and opt-in controller. Disabled until a private backend is connected. */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.atlasRoutingNotifications = api;
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : null, () => {
  "use strict";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const schedule = Object.freeze({ timeZone: "America/Los_Angeles", hour: 17, minute: 0, weekdays: Object.freeze([1, 2, 3, 4, 5]), recipient: "Zach only" });
  function day(value) {
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(value || "")) return false;
    const parsed = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  function pacificTime(now = new Date()) {
    const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: schedule.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
    const date = `${values.year}-${values.month}-${values.day}`;
    return { date, weekday: new Date(`${date}T12:00:00Z`).getUTCDay(), hour: Number(values.hour), minute: Number(values.minute) };
  }
  function dueDay(now = new Date()) {
    const time = pacificTime(now);
    // The job runs at 17:00; allow bounded scheduler delay, never a next-day catch-up.
    return schedule.weekdays.includes(time.weekday) && time.hour === 17 && time.minute < 15 ? time.date : null;
  }
  function needsReview(order, date) {
    return day(date) && order?.dispatchedOn === date && !order.deliveredOn && !String(order.deliveryException || "").trim();
  }
  function reviewCount(orders, date) {
    return Array.isArray(orders) ? orders.filter((order) => needsReview(order, date)).length : 0;
  }
  function subscription(value) {
    const fail = () => { throw new Error("Invalid push subscription."); };
    if (!value || typeof value.endpoint !== "string" || value.endpoint.length > 2048) fail();
    let url; try { url = new URL(value.endpoint); } catch { fail(); }
    // Exact providers only: no redirects, credentials, ports, fragments, or arbitrary fetch targets.
    const provider = url.hostname === "fcm.googleapis.com" || url.hostname === "web.push.apple.com" || url.hostname === "updates.push.services.mozilla.com";
    if (!provider || url.protocol !== "https:" || url.username || url.password || url.port || url.hash || url.search || url.pathname === "/" || url.href !== value.endpoint) fail();
    const keys = value.keys;
    if (!/^[A-Za-z0-9_-]{87}$/.test(keys?.p256dh || "") || !/^[A-Za-z0-9_-]{22}$/.test(keys?.auth || "")) fail();
    return { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth } };
  }
  function notice(date, binding) {
    if (!day(date) || !UUID.test(binding || "")) throw new Error("Invalid delivery reminder.");
    return { version: 1, type: "atlas-delivery-review", day: date, binding };
  }
  function notificationOptions(payload, scope) {
    if (payload?.version !== 1 || payload.type !== "atlas-delivery-review") return null;
    let clean, base; try { clean = notice(payload.day, payload.binding); base = new URL(scope); } catch { return null; }
    if (base.protocol !== "https:" || base.username || base.password) return null;
    const target = new URL("./", base); target.hash = `delivery-review=${clean.day}`;
    return { title: "ATLAS", options: { body: "Review today’s deliveries.", tag: `atlas-delivery-review-${clean.day}`, renotify: false,
      icon: new URL("atlas-icon-v2-192.png?v=101", base).href, data: { type: clean.type, day: clean.day, binding: clean.binding, url: target.href } } };
  }
  function availability({ connected = false, secure = false, stableOrigin = false, supported = false, ios = false, standalone = false, permission = "default", eligible = false } = {}) {
    if (!connected) return { canEnable: false, message: "Phone reminders are not connected yet. Your delivery-day review is available below." };
    if (!secure || !stableOrigin) return { canEnable: false, message: "Open ATLAS at its permanent secure address to enable phone reminders." };
    if (ios && !standalone) return { canEnable: false, message: "On iPhone, add ATLAS to your Home Screen, open it there, then enable reminders." };
    if (!supported) return { canEnable: false, message: "This browser does not support phone reminders. You can still review deliveries in ATLAS." };
    if (!eligible) return { canEnable: false, message: "Delivery reminders are available only to Zach’s approved account." };
    if (permission === "denied") return { canEnable: false, message: "Notifications are blocked. Change the notification permission in your phone or browser settings to enable them." };
    return { canEnable: true, message: "One delivery review reminder at 5:00 PM Pacific, Monday–Friday, on this device." };
  }
  // The eventual host supplies a server-authorized adapter. No config means no permission prompt or network call.
  function createController({ environment, backend, device, identity, changed = () => {} }) {
    let generation = 0, busy = false, enabled = false, message = "";
    const status = () => ({ ...availability(environment()), busy, enabled, ...(message ? { message } : {}) });
    const update = () => changed(status());
    async function enable() {
      if (busy || !status().canEnable || enabled) return false;
      const owner = identity(), current = ++generation;
      if (!UUID.test(owner || "")) return false;
      const valid = () => current === generation && owner === identity();
      busy = true; message = ""; update();
      let acquired = null, binding = null;
      try {
        // Call immediately from the Enable button gesture, before any network await (required on iOS).
        const permission = await device.requestPermission();
        if (!valid()) throw new Error("The ATLAS account changed. Open reminders again.");
        if (permission !== "granted") { message = "Notifications were not enabled. Delivery review remains available in ATLAS."; return false; }
        const config = await backend.prepare();
        if (!valid() || config?.eligible !== true || config.userId !== owner || config.warehouse !== "CA" || !UUID.test(config.binding || "")) throw new Error("This account is not eligible for reminders.");
        binding = config.binding;
        acquired = await device.subscribe(config.publicKey);
        if (!valid()) throw new Error("The ATLAS account changed. Open reminders again.");
        const result = await backend.register({ binding, subscription: subscription(acquired.toJSON()) });
        if (!valid() || result?.enabled !== true || result.binding !== binding) throw new Error("Reminder setup could not be confirmed.");
        await device.bind(binding);
        if (!valid()) throw new Error("The ATLAS account changed. Open reminders again.");
        enabled = true; message = "Enabled on this device · Zach only · 5:00 PM Pacific, Monday–Friday."; return true;
      } catch {
        // Uncertain registration never leaves an active browser subscription.
        await device.clear().catch(() => {});
        if (acquired) await acquired.unsubscribe().catch(() => {});
        if (binding) await backend.revoke({ binding }).catch(() => {});
        if (valid()) message = "Reminders could not be enabled. Delivery review remains available in ATLAS. Try again after checking the connection.";
        return false;
      } finally { if (valid()) { busy = false; update(); } }
    }
    async function disable() {
      if (busy) return false;
      const current = ++generation; busy = true; message = ""; update();
      try {
        // Local suppression comes first, including when the server is unreachable.
        await device.clear();
        await device.unsubscribe();
        await backend.revoke();
        if (current === generation) { enabled = false; message = "Reminders are off on this device."; }
        return true;
      } catch { if (current === generation) message = "Could not confirm reminders are off. Check the connection and try again, or block notifications in your phone settings."; return false; }
      finally { if (current === generation) { busy = false; update(); } }
    }
    async function reset() {
      generation++; busy = false; enabled = false; message = "";
      // Also required on warehouse switches and cross-tab sign-out. Never re-enroll automatically.
      await device.clear().catch(() => {}); await device.unsubscribe().catch(() => {}); update();
    }
    const restoreEnabled = value => { if (!busy) { enabled = value === true; message = enabled ? "Enabled on this device · Zach only · 5:00 PM Pacific, Monday–Friday." : ""; update(); } };
    return Object.freeze({ status, enable, disable, reset, restoreEnabled });
  }
  return Object.freeze({ schedule, day, pacificTime, dueDay, needsReview, reviewCount, subscription, notice, notificationOptions, availability, createController });
});
