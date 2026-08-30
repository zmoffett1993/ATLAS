(function (global) {
  "use strict";

  const PROJECT_REF = "dwrrbpiprcmajfyronlf";
  const AUTH_STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;
  const LEGACY_DASHBOARD_KEY = "atlas-dashboard-session-v1";
  const INTERNAL_DOMAIN = "users.atlas.invalid";
  const REFRESH_MARGIN_MS = 60_000;
  const REFRESH_RETRY_MS = 30_000;
  let modal = null;
  let refreshPromise = null;
  let refreshTimer = null;

  const config = () => {
    const value = global.atlasSupabaseConfig;
    if (!value?.url || !value?.key) throw new Error("ATLAS sign-in is not configured.");
    return value;
  };

  const safeJson = (value) => {
    try { return JSON.parse(value || "null"); } catch { return null; }
  };

  const normalizeLoginName = (value) => String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "")
    .slice(0, 48);

  const internalEmail = (loginName) => {
    const legacyEmail = String(loginName || "").trim().toLowerCase();
    if (legacyEmail.includes("@")) return legacyEmail;
    const normalized = normalizeLoginName(loginName);
    if (normalized.length < 2) throw new Error("Enter your ATLAS name.");
    return `${normalized}@${INTERNAL_DOMAIN}`;
  };

  const parseSession = (raw) => {
    const parsed = typeof raw === "string" ? safeJson(raw) : raw;
    const session = parsed?.currentSession || parsed?.session || parsed;
    return session?.access_token && session?.user?.id ? session : null;
  };

  const storedSession = () => parseSession(global.localStorage?.getItem(AUTH_STORAGE_KEY))
    || parseSession(global.sessionStorage?.getItem(LEGACY_DASHBOARD_KEY));

  const persist = (session) => {
    if (!session?.access_token || !session?.user?.id) throw new Error("ATLAS sign-in did not return a valid session.");
    session.expires_at = Number(session.expires_at || 0)
      || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600);
    global.localStorage?.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    global.sessionStorage?.setItem(LEGACY_DASHBOARD_KEY, JSON.stringify(session));
    global.dispatchEvent(new CustomEvent("atlas-auth-changed", { detail: { session } }));
    scheduleRefresh(session);
    syncMenu();
    return session;
  };

  const request = async (path, body, accessToken = "") => {
    const { url, key } = config();
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${accessToken || key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body || {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const source = String(payload?.error_description || payload?.message || payload?.error || "Sign in failed.");
      const message = /invalid login credentials/i.test(source)
        ? "That name or password is incorrect."
        : source;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return payload;
  };

  const permanentRefreshFailure = (error) => [400, 401, 403].includes(Number(error?.status || 0));

  function scheduleRefresh(session = storedSession(), retryInMs = 0) {
    if (refreshTimer) global.clearTimeout(refreshTimer);
    refreshTimer = null;
    if (!session?.refresh_token) return;
    const expiresAt = Number(session.expires_at || 0) * 1000;
    const delay = retryInMs || Math.max(0, expiresAt - Date.now() - REFRESH_MARGIN_MS);
    refreshTimer = global.setTimeout(() => refresh(session), delay);
  }

  const refresh = async (session = storedSession()) => {
    if (!session?.refresh_token) return null;
    if (refreshPromise) return refreshPromise;
    refreshPromise = request("/auth/v1/token?grant_type=refresh_token", { refresh_token: session.refresh_token })
      .then(persist)
      .catch((error) => {
        // Only an invalid/revoked refresh token should forget this device.
        // Wi-Fi, rate-limit, and server failures keep the saved login and retry.
        if (permanentRefreshFailure(error)) clearSession();
        else scheduleRefresh(session, REFRESH_RETRY_MS);
        return null;
      })
      .finally(() => { refreshPromise = null; });
    return refreshPromise;
  };

  const getSession = () => {
    const session = storedSession();
    if (!session) return null;
    const expiresAt = Number(session.expires_at || 0) * 1000;
    if (expiresAt && expiresAt <= Date.now()) return null;
    if (expiresAt && expiresAt <= Date.now() + REFRESH_MARGIN_MS) refresh(session);
    return session;
  };

  const signIn = async (loginName, password) => {
    const session = await request("/auth/v1/token?grant_type=password", {
      email: internalEmail(loginName),
      password: String(password || ""),
    });
    return persist(session);
  };

  function clearSession() {
    if (refreshTimer) global.clearTimeout(refreshTimer);
    refreshTimer = null;
    global.localStorage?.removeItem(AUTH_STORAGE_KEY);
    global.sessionStorage?.removeItem(LEGACY_DASHBOARD_KEY);
    global.dispatchEvent(new CustomEvent("atlas-auth-changed", { detail: { session: null } }));
    syncMenu();
  }

  const signOut = async () => {
    const session = storedSession();
    clearSession();
    if (session?.access_token) request("/auth/v1/logout", {}, session.access_token).catch(() => {});
  };

  const displayName = (session = getSession()) => session?.user?.user_metadata?.display_name
    || session?.user?.app_metadata?.display_name
    || session?.user?.app_metadata?.login_name
    || "ATLAS user";

  function closeModal() {
    modal?.remove();
    modal = null;
  }

  function openModal() {
    closeModal();
    const session = getSession();
    modal = document.createElement("div");
    modal.className = "atlas-auth-backdrop";
    modal.innerHTML = session ? `
      <section class="atlas-auth-modal" role="dialog" aria-modal="true" aria-labelledby="atlasAuthTitle">
        <button type="button" class="atlas-auth-close" data-auth-close aria-label="Close">×</button>
        <p class="atlas-auth-eyebrow">ATLAS ACCOUNT</p>
        <h2 id="atlasAuthTitle">Signed in</h2>
        <p class="atlas-auth-person">${escapeHtml(displayName(session))}</p>
        <button type="button" class="atlas-auth-primary" data-auth-sign-out>Sign Out</button>
      </section>` : `
      <section class="atlas-auth-modal" role="dialog" aria-modal="true" aria-labelledby="atlasAuthTitle">
        <button type="button" class="atlas-auth-close" data-auth-close aria-label="Close">×</button>
        <p class="atlas-auth-eyebrow">ATLAS ACCOUNT</p>
        <h2 id="atlasAuthTitle">Sign in</h2>
        <p>Use your employee name and ATLAS password. You will stay signed in on this device until you sign out.</p>
        <form data-auth-form>
          <label><span>Employee name</span><input name="login_name" autocomplete="username" autocapitalize="words" required></label>
          <label><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
          <p class="atlas-auth-message" data-auth-message role="alert"></p>
          <button type="submit" class="atlas-auth-primary">Sign In</button>
        </form>
      </section>`;
    document.body.appendChild(modal);
    modal.querySelector("input")?.focus();
  }

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);

  document.addEventListener("click", async (event) => {
    if (event.target === modal || event.target.closest?.("[data-auth-close]")) closeModal();
    if (event.target.closest?.("[data-action='account']")) { event.preventDefault(); openModal(); }
    if (event.target.closest?.("[data-auth-sign-out]")) { await signOut(); openModal(); }
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target.closest?.("[data-auth-form]");
    if (!form) return;
    event.preventDefault();
    const button = form.querySelector("button[type='submit']");
    const message = form.querySelector("[data-auth-message]");
    button.disabled = true;
    button.textContent = "Signing in…";
    message.textContent = "";
    try {
      await signIn(form.elements.login_name.value, form.elements.password.value);
      closeModal();
    } catch (error) {
      message.textContent = error.message || "Sign in failed.";
      button.disabled = false;
      button.textContent = "Sign In";
    }
  });

  function syncMenu() {
    const nav = document.querySelector(".atlas-menu-nav");
    if (!nav) return;
    let button = nav.querySelector("[data-action='account']");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "premium-drawer-link atlas-menu-item";
      button.dataset.action = "account";
      button.innerHTML = `<span class="atlas-menu-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.5-4 3-6 7-6s6.5 2 7 6"/></svg></span><span class="atlas-menu-label" data-auth-menu-label></span><span class="drawer-chevron atlas-menu-chevron" aria-hidden="true">›</span>`;
      nav.appendChild(button);
    }
    const session = getSession();
    const label = button.querySelector("[data-auth-menu-label]");
    const nextLabel = session ? displayName(session).toUpperCase() : "SIGN IN";
    if (label && label.textContent !== nextLabel) label.textContent = nextLabel;
  }

  const observer = new MutationObserver(syncMenu);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const restore = () => {
    const session = storedSession();
    syncMenu();
    if (!session) return;
    const expiresAt = Number(session.expires_at || 0) * 1000;
    if (!expiresAt || expiresAt <= Date.now() + REFRESH_MARGIN_MS) refresh(session);
    else scheduleRefresh(session);
  };
  global.addEventListener("DOMContentLoaded", restore);
  global.addEventListener("online", restore);
  global.addEventListener("visibilitychange", () => {
    if (!global.document?.hidden) restore();
  });
  global.addEventListener("storage", (event) => {
    if (event?.key !== AUTH_STORAGE_KEY) return;
    const session = storedSession();
    syncMenu();
    global.dispatchEvent(new CustomEvent("atlas-auth-changed", { detail: { session } }));
    if (session) scheduleRefresh(session);
  });

  global.AtlasAuth = Object.freeze({
    AUTH_STORAGE_KEY,
    INTERNAL_DOMAIN,
    normalizeLoginName,
    internalEmail,
    getSession,
    refresh,
    signIn,
    signOut,
    open: openModal,
    displayName,
    restore,
  });
})(window);
