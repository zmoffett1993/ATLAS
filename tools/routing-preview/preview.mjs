let lastRoutingCall = 0;
export function sampleTrip(now = new Date()) {
  const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const tomorrow = new Date(`${localDay}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const day = tomorrow.toISOString().slice(0, 10);
  const zone = new Intl.DateTimeFormat("en", { timeZone: "America/Los_Angeles", timeZoneName: "shortOffset" }).formatToParts(tomorrow).find((part) => part.type === "timeZoneName").value;
  const hourOffset = Number(zone.match(/^GMT([+-]\d+)$/)?.[1]);
  if (![-7, -8].includes(hourOffset)) throw new Error("Pacific time unavailable");
  const offset = `-${String(-hourOffset).padStart(2, "0")}:00`;
  return { action: "optimizeTrip", warehouse: "CA", departure: `${day}T06:30:00${offset}`, returnBy: `${day}T15:00:00${offset}`,
    preserveOrder: true, stops: [{ location: { latitude: 33.8707996, longitude: -117.9294156 }, pallets: 1, serviceMinutes: 25 }] };
}

export async function requestTrip({ session, payload, fetchImpl = fetch, signal }) {
  if (!session?.user?.id || !session.access_token) throw new Error("Sign into ATLAS first.");
  let response;
  try {
    response = await fetchImpl(payload.action === "planTrip" ? "/api/plan-trip" : "/api/optimize-trip", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
      headers: { "Content-Type": "application/json", "X-Atlas-Authorization": `Bearer ${session.access_token}` }, body: JSON.stringify(payload) });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error("The browser could not reach the private preview. Use Check preview connection below. No automatic retry was made.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const messages = { SIGN_IN_REQUIRED: "Please sign into ATLAS again.", PREVIEW_DISABLED: "The backend is still disabled.",
      PREVIEW_ACCESS_DENIED: "This ATLAS account is not an approved tester.", WAREHOUSE_ACCESS_DENIED: "This test requires authorized CA access.",
      PREVIEW_RATE_LIMITED: "Wait 30 seconds before another test.", GOOGLE_QUOTA_REACHED: "The Google testing quota has been reached. Try later.",
      PREVIEW_TEST_LIMIT_REACHED: "This preview session has reached its testing allowance. The calculated trips remain available for review.", GOOGLE_AUTH_UNAVAILABLE: "The Google service identity needs attention.",
      GOOGLE_ROUTING_UNAVAILABLE: "Google could not complete this test. No automatic retry was made." };
    throw new Error(messages[data.error] || "The preview connection could not complete. No automatic retry was made.");
  }
  if (data.warehouse !== "CA" || data.scope !== (payload.action === "planTrip" ? "daily-planner-trip" : "single-truck-trip") || data.wholeDayValidated !== false || !Array.isArray(data.visits) || !Array.isArray(data.skippedStopIndices)) throw new Error("Unexpected routing response.");
  return data;
}

export async function checkPreviewConnection(fetchImpl = fetch) {
  const results = [];
  for (const [name, extra] of [["No bearer", {}], ["Standard bearer", { Authorization: "Bearer synthetic-preview-connection-check" }], ["App header", { "X-Atlas-Authorization": "Bearer synthetic-preview-connection-check" }]]) {
    try {
      // Invalid payload cannot reach Google routing, even if a header is accepted.
      const response = await fetchImpl("/api/optimize-trip", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json", ...extra }, body: "null" });
      results.push(`${name}: HTTP ${response.status}`);
    } catch { results.push(`${name}: browser connection failed`); }
  }
  return results.join(" · ");
}

export async function requestPhoto({ session, image, signal, fetchImpl = fetch }) {
  if (!session?.user?.id || !session.access_token) throw new Error("Sign into ATLAS first.");
  const response = await fetchImpl("/api/read-order-photo", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
    headers: { "Content-Type": "application/json", "X-Atlas-Authorization": `Bearer ${session.access_token}` },
    body: JSON.stringify({ action: "readOrderPhoto", warehouse: "CA", image }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const messages = { PHOTO_READING_DISABLED: "Automatic photo reading is not connected yet.", SIGN_IN_REQUIRED: "Sign into ATLAS again.",
      PREVIEW_ACCESS_DENIED: "This account is not approved for the private preview.", WAREHOUSE_ACCESS_DENIED: "Photo reading requires authorized CA access.",
      PHOTO_RATE_LIMITED: "Wait a moment before reading again.", PREVIEW_RATE_LIMITED: "Another preview request is running. Try again shortly.",
      PHOTO_TEST_LIMIT_REACHED: "The photo testing allowance has been reached.", PREVIEW_TEST_LIMIT_REACHED: "The photo testing allowance has been reached.",
      GOOGLE_QUOTA_REACHED: "The Google photo reading quota has been reached.", INVALID_PHOTO: "This photo could not be read. Try a clearer JPEG or PNG image." };
    throw new Error(messages[data.error] || "Photo reading could not complete. No automatic retry was made.");
  }
  if (data.warehouse !== "CA" || data.scope !== "order-photo" || !Array.isArray(data.pages) || data.pages.length !== 1 || !Array.isArray(data.pages[0].words)) throw new Error("Unexpected photo reading response.");
  return data;
}

export async function connectRouting(config) {
    window.atlasSupabaseConfig = { url: config.url, key: config.key };
    window.atlasRoutingSavedDays = window.atlasRoutingStorage.createClient({ enabled: config.storageEnabled === true, key: config.key,
      getSession: () => window.AtlasAuth?.getSession(), getValidSession: () => window.AtlasAuth.getValidSession() });
    const maps = await import("./maps.mjs");
    let lastPhotoCall = 0;
    window.atlasRoutingConnection = {
      available: Boolean(config.mapsBrowserKey),
      photoAvailable: config.photoEnabled === true,
      async readPhoto(image, { signal }) {
        const owner = window.AtlasAuth.getSession()?.user?.id;
        const delay = Math.max(0, lastPhotoCall + 6100 - Date.now());
        if (delay) await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new DOMException("Canceled", "AbortError")); };
          const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, delay);
          signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
        });
        const session = await window.AtlasAuth.getValidSession();
        if (!owner || session?.user?.id !== owner || signal?.aborted) throw new Error("Photo reading stopped because the account or order changed.");
        lastPhotoCall = Date.now();
        return requestPhoto({ session, image, signal: AbortSignal.any([signal, AbortSignal.timeout(45000)].filter(Boolean)) });
      },
      showMap: (element) => maps.showMap(config.mapsBrowserKey, element),
      geocode: (address) => maps.locate(config.mapsBrowserKey, address),
      drawRoutes: (element, plan, current) => maps.drawRoutes(config.mapsBrowserKey, element, plan, current),
      clear: maps.clearRoutes,
      async route(payload, { signal, onProgress }) {
        const owner = window.AtlasAuth.getSession()?.user?.id;
        const delay = Math.max(0, lastRoutingCall + 31000 - Date.now());
        if (delay) {
          onProgress("Waiting briefly between trips to respect the Google testing quota…");
          await new Promise((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(new DOMException("Canceled", "AbortError")); };
            const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, delay);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        }
        if (signal?.aborted) throw new DOMException("Canceled", "AbortError");
        const session = await window.AtlasAuth.getValidSession();
        if (!owner || session?.user?.id !== owner || signal?.aborted) throw new Error("The ATLAS account changed. Start planning again.");
        lastRoutingCall = Date.now();
        return requestTrip({ session, payload, signal: AbortSignal.any([signal, AbortSignal.timeout(55000)].filter(Boolean)) });
      },
    };
}

async function mount() {
  const status = document.getElementById("status"), result = document.getElementById("result");
  const signIn = document.getElementById("sign-in"), planner = document.getElementById("open-planner"), test = document.getElementById("test-route");
  let controller = null, generation = 0, pending = false;
  const check = document.getElementById("check-connection"), connectionStatus = document.getElementById("connection-status");
  check.addEventListener("click", async () => {
    check.disabled = true; connectionStatus.textContent = "Checking preview connection…";
    try { connectionStatus.textContent = await checkPreviewConnection(); }
    finally { check.disabled = false; }
  });
  const sync = () => {
    generation++; controller?.abort(); pending = false; result.hidden = true; result.textContent = "";
    const session = window.AtlasAuth?.getSession();
    planner.disabled = test.disabled = !session?.user?.id;
    signIn.textContent = session ? "ATLAS account" : "Sign into ATLAS";
    status.textContent = session ? `Signed in as ${window.AtlasAuth.displayName(session)}. Ready to open the planning preview.` : "Sign into ATLAS to test the connection.";
  };
  try {
    const configResponse = await fetch("/runtime-config.json", { cache: "no-store", credentials: "same-origin" });
    if (!configResponse.ok) throw new Error("Configuration unavailable");
    const config = await configResponse.json();
    await connectRouting(config);
    // Reuse the existing ATLAS sign-in UI unchanged; credentials go directly to Supabase.
    await new Promise((resolve, reject) => { const script = document.createElement("script"); script.src = "/atlas-auth.js"; script.onload = resolve; script.onerror = reject; document.head.appendChild(script); });
    signIn.disabled = false;
    signIn.addEventListener("click", () => window.AtlasAuth.open());
    planner.addEventListener("click", () => window.atlasOpenRouting());
    window.atlasOpenDashboard = () => { document.getElementById("root").scrollIntoView(); };
    window.addEventListener("atlas-auth-changed", sync);
    window.addEventListener("pagehide", () => { generation++; controller?.abort(); });
    document.getElementById("sample-time").textContent = `Sample departure: ${sampleTrip().departure.slice(0, 10)}, 6:30 AM Pacific.`;
    window.AtlasAuth.restore(); sync();
    if (config.notificationsEnabled === true) {
      const notifications = await import("./tools/routing-preview/notification-client.mjs");
      await notifications.connectNotifications(config);
    }
    test.addEventListener("click", async () => {
      if (pending) return;
      pending = true; test.disabled = true; result.hidden = true;
      const session = await window.AtlasAuth.getValidSession();
      const owner = session?.user?.id, current = generation;
      controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 55000);
      status.textContent = "Checking your CA access and calculating the sample route…";
      try {
        lastRoutingCall = Date.now();
        const route = await requestTrip({ session, payload: sampleTrip(), signal: controller.signal });
        if (current !== generation || window.AtlasAuth.getSession()?.user?.id !== owner) return;
        if (route.skippedStopIndices.length || route.visits.length !== 1 || route.trafficInfeasible) throw new Error("Google responded, but the sample route needs review.");
        result.textContent = `Google connection succeeded.\nEstimated drive time: ${Math.round(route.driveSeconds / 60)} minutes\nDistance: ${(route.distanceMeters / 1609.344).toFixed(1)} miles\nIncludes a 25-minute test stop. This does not validate a full driver's day.`;
        result.hidden = false; status.textContent = "ATLAS sign-in, CA access and Google routing passed this connection test.";
      } catch (error) {
        if (current === generation) status.textContent = error.name === "AbortError" ? "Test stopped or timed out. No automatic retry was made." : error.message;
      } finally { clearTimeout(timeout); if (current === generation) { pending = false; test.disabled = !window.AtlasAuth.getSession()?.user?.id; } }
    });
  } catch { status.textContent = "The private preview could not load its configuration."; }
}
if (typeof window !== "undefined" && document.getElementById("open-planner")) mount();
