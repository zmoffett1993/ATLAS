// Prepared sender policy, not connected to a scheduler or deployed service.
import policy from "../../atlas-routing-notifications.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDispatcher({ enabled = false, recipientId, store, sendNotification, now = () => new Date() }) {
  if (enabled && !UUID.test(recipientId || "")) throw new Error("Exactly one approved recipient is required.");
  return async function dispatch() {
    const date = enabled ? policy.dueDay(now()) : null;
    if (!date) return { attempted: 0, sent: 0, skipped: true };
    // Store must obtain current membership, role, warehouse and auth-session state from trusted DB rows.
    const devices = await store.authorizedDevices(recipientId, "CA");
    if (!Array.isArray(devices) || devices.length > 5) throw new Error("Invalid recipient response.");
    let attempted = 0, sent = 0;
    for (const device of devices) {
      if (device.userId !== recipientId || device.warehouse !== "CA" || device.enabled !== true || device.authorized !== true || !UUID.test(device.id || "") || !UUID.test(device.binding || "")) continue;
      let subscription; try { subscription = policy.subscription(device.subscription); } catch { continue; }
      // claim() atomically reserves (recipient, warehouse, device, day), rechecks current access,
      // and checks *all saved days* for unreviewed orders dispatched today, regardless of planning day.
      // A claim is permanent even on timeout: no automatic retry of an ambiguous push acceptance.
      const claim = await store.claim({ recipientId, warehouse: "CA", deviceId: device.id, binding: device.binding, day: date });
      if (claim?.claimed !== true) continue;
      if (policy.dueDay(now()) !== date || await store.stillAuthorized(device.id, device.binding, recipientId, "CA") !== true) continue;
      attempted++;
      try {
        // A maintained Web Push library will provide this function after installation approval.
        // It must disable redirects and use this timeout. Never pass exception bodies to logs.
        await sendNotification(subscription, JSON.stringify(policy.notice(date, device.binding)), { TTL: 900, urgency: "normal", topic: `atlas-review-${date}`, timeout: 10000 });
        sent++; await store.finish(device.id, date, "accepted");
      } catch (error) {
        const expired = error?.statusCode === 404 || error?.statusCode === 410;
        if (expired) await store.retire(device.id, device.binding);
        await store.finish(device.id, date, expired ? "expired" : "unconfirmed");
      }
    }
    // Counts only: never return subscription endpoints, recipient IDs or document details.
    return { attempted, sent, skipped: false };
  };
}
