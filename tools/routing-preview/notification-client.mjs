import { createBindingStore } from "./notification-binding.mjs";
const BASE = "https://dwrrbpiprcmajfyronlf.supabase.co";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createNotificationRpc({ key, getSession, getValidSession, fetchImpl = fetch }) {
  return async (action, payload = {}) => {
    if (!["status", "prepare", "register", "revoke"].includes(action)) throw new Error("Invalid reminder action.");
    const owner = getSession()?.user?.id;
    const session = await getValidSession();
    if (!UUID.test(owner || "") || session?.user?.id !== owner || getSession()?.user?.id !== owner || !session.access_token) throw new Error("Sign into ATLAS again.");
    const response = await fetchImpl(`${BASE}/rest/v1/rpc/atlas_routing_notification_device`, { method: "POST", cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { apikey: key, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_action: action, p_payload: payload }) });
    const reader = response.body?.getReader(); if (!reader) throw new Error("Reminders unavailable.");
    const chunks = []; let length = 0;
    try { while (true) { const {value,done} = await reader.read(); if (done) break; length += value.length; if (length > 4096) { await reader.cancel(); throw new Error("Reminders unavailable."); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    if (!response.ok || getSession()?.user?.id !== owner) throw new Error("Reminders unavailable for this account.");
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  };
}
export async function connectNotifications(config, host = window) {
  // Both flags and the exact origin must come from the permanent host's allowlisted public configuration.
  if (config.notificationsEnabled !== true || host.location.origin !== config.notificationOrigin || host.location.protocol !== "https:" || /\.cloudshell\.dev$/.test(host.location.hostname)) return null;
  const policy = host.atlasRoutingNotifications;
  const bindingStore = createBindingStore(host.indexedDB);
  const auth = host.AtlasAuth;
  const rpc = createNotificationRpc({ key: config.key, getSession: () => auth.getSession(), getValidSession: () => auth.getValidSession() });
  let eligible = false, active = null, account = auth.getSession()?.user?.id || null, generation = 0;
  const registration = async () => {
    const result = await host.navigator.serviceWorker.getRegistration("/");
    if (!result?.active || result.active.scriptURL !== new URL("/tools/routing-preview/routing-notification-sw.mjs", host.location.origin).href) throw new Error("Reminder worker not ready.");
    return result;
  };
  const supported = () => Boolean(host.Notification && host.PushManager && host.navigator.serviceWorker && host.indexedDB);
  const emit = () => host.dispatchEvent(new host.CustomEvent("atlas-reminders-changed"));
  const device = {
    requestPermission: () => host.Notification.requestPermission(),
    subscribe: async key => {
      if (!/^[A-Za-z0-9_-]{87}$/.test(key || "")) throw new Error("Invalid public configuration.");
      const reg = await registration(), existing = await reg.pushManager.getSubscription();
      if (existing) await existing.unsubscribe();
      const decoded = host.atob(key.replace(/-/g,"+").replace(/_/g,"/") + "=");
      return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(decoded, c => c.charCodeAt(0)) });
    },
    bind: async binding => { active = { binding, owner: auth.getSession()?.user?.id }; await bindingStore.write(active); },
    clear: async () => { await bindingStore.clear(); const reg = await host.navigator.serviceWorker.getRegistration("/"); for (const notification of await reg?.getNotifications() || []) notification.close(); },
    unsubscribe: async () => { const reg = await host.navigator.serviceWorker.getRegistration("/"); const sub = await reg?.pushManager.getSubscription(); if (sub && await sub.unsubscribe() !== true) throw new Error("Could not unsubscribe."); },
  };
  const backend = {
    prepare: async () => { if (active?.binding) await rpc("revoke", {binding:active.binding}); active = null; return rpc("prepare"); },
    register: input => rpc("register", input),
    revoke: async ({binding} = {}) => { const id = binding || active?.binding; if (id) await rpc("revoke",{binding:id}); active = null; },
  };
  const controller = policy.createController({ environment: () => ({ connected: true, stableOrigin: true, secure: host.isSecureContext, supported: supported(), eligible,
    ios: /iPhone|iPad|iPod/.test(host.navigator.userAgent) || (host.navigator.platform === "MacIntel" && host.navigator.maxTouchPoints > 1),
    standalone: host.navigator.standalone === true || host.matchMedia("(display-mode: standalone)").matches,
    permission: host.Notification?.permission }), backend, device, identity: () => auth.getSession()?.user?.id, changed: emit });
  host.atlasRoutingReminderController = controller;
  async function sync() {
    const owner = auth.getSession()?.user?.id || null;
    if (account === owner && controller.status().busy) return;
    const current = ++generation;
    eligible = false;
    if (account !== owner) { account = owner; await controller.reset(); active = null; }
    if (!owner || !supported()) { emit(); return; }
    try {
      const persisted = await bindingStore.read();
      if (persisted && persisted.owner !== owner) { await controller.reset(); active = null; }
      else active = persisted;
      const status = await rpc("status", { binding: active?.binding || null });
      if (current !== generation || auth.getSession()?.user?.id !== owner) return;
      eligible = status?.eligible === true && status.userId === owner && status.warehouse === "CA";
      if (!eligible) { await controller.reset(); active = null; return; }
      await host.navigator.serviceWorker.register("/tools/routing-preview/routing-notification-sw.mjs", {type:"module",scope:"/"});
      const reg = await host.navigator.serviceWorker.ready;
      if (current !== generation || auth.getSession()?.user?.id !== owner) return;
      const subscribed = Boolean(await reg.pushManager.getSubscription());
      if (active && (!status.enabled || !subscribed || host.Notification.permission !== "granted")) { await controller.reset(); active = null; }
      else controller.restoreEnabled(Boolean(active && status.enabled && subscribed));
    } catch { eligible = false; await controller.reset(); active = null; }
    finally { emit(); }
  }
  host.addEventListener("atlas-auth-changed", () => { void sync(); });
  const openReview = day => host.atlasOpenDeliveryReview?.(day);
  function reviewLink() {
    const match = /^#delivery-review=(20\d{2}-\d{2}-\d{2})$/.exec(host.location.hash);
    if (match && openReview(match[1])) host.history.replaceState(null,"",host.location.pathname+host.location.search);
  }
  host.navigator.serviceWorker.addEventListener("message",event=>{
    if (event.source === host.navigator.serviceWorker.controller && event.data?.type === "atlas-delivery-review") openReview(event.data.day);
  });
  host.addEventListener("atlas-auth-changed",reviewLink);
  host.addEventListener("storage", event => { if (/warehouse/i.test(event.key || "")) { generation++; eligible = false; void controller.reset(); } });
  await sync();
  reviewLink();
  return controller;
}
