import { connectRouting } from "./preview.mjs";

export const LIVE_ORIGIN = "https://zmoffett1993.github.io";
export const ROUTING_API = "https://atlas-routing-app-tbcotacnuq-uc.a.run.app";
const live = location.origin === LIVE_ORIGIN && /^\/ATLAS(?:\/|$)/.test(location.pathname);
let capabilityOwner = null, capabilityGeneration = 0, capabilityController = null;
const notifyCapability = () => window.dispatchEvent(new Event("atlas-scanner-capability-changed"));
window.atlasPersonalScannerAllowed = () => Boolean(capabilityOwner && capabilityOwner === window.AtlasAuth?.getSession()?.user?.id);

async function refreshCapability() {
  const generation = ++capabilityGeneration;
  capabilityController?.abort(); capabilityController = new AbortController();
  capabilityOwner = null; notifyCapability();
  const owner = window.AtlasAuth?.getSession()?.user?.id;
  if (!owner) return;
  try {
    const session = await window.AtlasAuth.getValidSession();
    if (generation !== capabilityGeneration || session?.user?.id !== owner) return;
    const response = await fetch(`${live ? ROUTING_API : ""}/api/scanner-capability`, {
      headers: { "X-Atlas-Authorization": `Bearer ${session.access_token}` },
      cache: "no-store", credentials: "omit", redirect: "error",
      signal: AbortSignal.any([capabilityController.signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) return;
    const profile = await response.json();
    if (generation !== capabilityGeneration || owner !== window.AtlasAuth?.getSession()?.user?.id) return;
    capabilityOwner = profile.capabilities?.includes("routing_scanner_quick_action") ? owner : null;
    notifyCapability();
  } catch { /* Fail closed to the ordinary COC shortcut. */ }
}
window.addEventListener("atlas-auth-changed", () => { void refreshCapability(); });

// Routing paints scanner startup before awaiting the shared connection.
async function connect() {
  const button = document.querySelector('[data-action="routing"]');
  button?.setAttribute("aria-busy", "true");
  try {
    const response = await fetch(`${live ? ROUTING_API : ""}/runtime-config.json`, { cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error("Configuration unavailable");
    const config = await response.json();
    config.apiBase = live ? ROUTING_API : "";
    if (live) config.notificationOrigin = LIVE_ORIGIN;
    window.atlasRoutingPOD?.configure({ enabled: config.podEnabled === true });
    await connectRouting(config);
    if (config.notificationsEnabled === true) {
      const { connectNotifications } = await import("./notification-client.mjs");
      await connectNotifications(config);
    }
    document.documentElement.dataset.atlasRoutingConnection = "ready";
    void refreshCapability();
  } catch {
    document.documentElement.dataset.atlasRoutingConnection = "unavailable";
    throw Error("Delivery Routing could not connect. Reconnect to the internet and try again.");
  } finally { button?.removeAttribute("aria-busy"); }
}
let connection, connecting=false;
window.atlasRoutingConnectionReady = () => {
  if (!connection) connection = connect().catch(error => { connection = null; throw error; });
  return connection;
};
const start = () => { void window.atlasRoutingConnectionReady().catch(() => {}); };
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
