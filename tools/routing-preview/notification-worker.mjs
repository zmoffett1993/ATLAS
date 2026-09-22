// Host adapter for the eventual permanent-origin worker. Not registered by the temporary preview.
import * as notificationModule from "../../atlas-routing-notifications.js";
const policy = notificationModule.default || globalThis.atlasRoutingNotifications;

export function createNotificationHandlers({ scope, registration, clients, getBinding, now = () => new Date() }) {
  async function push(event) {
    let payload;
    try { const text = event.data?.text(); if (!text || text.length > 1024) return; payload = JSON.parse(text); } catch { return; }
    const notice = policy.notificationOptions(payload, scope);
    if (!notice || payload.binding !== await getBinding()) return;
    const time = policy.pacificTime(now());
    // Discard stale, weekend and late deliveries, including offline devices reconnecting tomorrow.
    if (payload.day !== time.date || !policy.schedule.weekdays.includes(time.weekday) || time.hour !== 17 || time.minute >= 30) return;
    await registration.showNotification(notice.title, notice.options);
  }
  async function click(event) {
    event.notification.close();
    const data = event.notification.data;
    const notice = policy.notificationOptions({ version: 1, type: data?.type, day: data?.day, binding: data?.binding }, scope);
    if (!notice || data.binding !== await getBinding()) return;
    // Ignore any supplied URL. Rebuild an exact same-origin, same-app review destination.
    const target = notice.options.data.url;
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: false });
    const app = new URL("./", scope);
    for (const client of windows) {
      const url = new URL(client.url);
      if (url.origin === app.origin && url.pathname === app.pathname) {
        // Message instead of navigating: never discard an open order or unsaved routing draft.
        client.postMessage({ type: "atlas-delivery-review", day: data.day });
        await client.focus(); return;
      }
    }
    await clients.openWindow(target);
  }
  return Object.freeze({ push, click });
}
