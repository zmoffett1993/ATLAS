import { connectRouting } from "./preview.mjs";

export const LIVE_ORIGIN = "https://zmoffett1993.github.io";
export const ROUTING_API = "https://atlas-routing-app-tbcotacnuq-uc.a.run.app";
const live = location.origin === LIVE_ORIGIN && /^\/ATLAS(?:\/|$)/.test(location.pathname);

// Both hosts reuse the existing ATLAS session; no redirect or second sign-in.
async function connect() {
  const button = document.querySelector('[data-action="routing"]');
  const open = window.atlasOpenRouting;
  let ready = false, requested = false;
  if (open) window.atlasOpenRouting = () => {
    if (ready) return open();
    requested = true;
    window.showPremiumToast?.("Connecting Delivery Routing…", 3000);
  };
  if (button) button.setAttribute("aria-busy", "true");
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
    ready = true;
    document.documentElement.dataset.atlasRoutingConnection = "ready";
    if (requested) open?.();
  } catch {
    document.documentElement.dataset.atlasRoutingConnection = "unavailable";
    // Leave other ATLAS screens available; never silently save to a different store.
    if (open) window.atlasOpenRouting = () => window.alert("Delivery Routing could not connect. Reconnect to the internet and refresh ATLAS. Your saved days have not changed.");
  } finally {
    button?.removeAttribute("aria-busy");
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", connect, { once: true });
else void connect();
