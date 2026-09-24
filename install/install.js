(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  const button = byId("install-button");
  const status = byId("install-status");
  const standalone = window.matchMedia("(display-mode: standalone)");
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(navigator.userAgent);
  let deferredPrompt = null;
  let installed = standalone.matches || navigator.standalone === true;
  let prompting = false;
  function render() {
    byId("iphone").hidden = installed || !ios;
    byId("browser-guidance").hidden = installed || ios;
    byId("device-heading").textContent = installed ? "ATLAS is installed" : ios ? "Install on iPhone" : android ? "Install on Android" : "Install on your device";
    byId("device-copy").textContent = android && deferredPrompt
      ? "Tap the button below to install ATLAS on your Android device."
      : android ? "Open this link in Chrome to add ATLAS to your Home screen."
        : "Open ATLAS in your browser, or use your browser’s Install app option when available.";
    button.hidden = installed || ios || !deferredPrompt;
    button.disabled = prompting;
    byId("page-title").textContent = installed ? "ATLAS is installed" : ios ? "Install on iPhone" : android ? "Install on Android" : "Install ATLAS";
    byId("page-intro").textContent = installed ? "Open ATLAS to access your warehouse tools." : ios ? "Follow these steps to add ATLAS to your Home Screen." : android && deferredPrompt ? "Tap the button below to install ATLAS on your Android device." : "Add ATLAS to your phone for quick access to warehouse tools.";
    byId("android-icon").hidden = !android || installed || !deferredPrompt;
    byId("device-copy").hidden = android && !!deferredPrompt;
    byId("fallback").hidden = !android || !!deferredPrompt;
    byId("open-app").textContent = "Open ATLAS";
    byId("offline-note").hidden = navigator.onLine !== false;
  }
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    if (installed || ios) return;
    deferredPrompt = event;
    status.textContent = "ATLAS is ready to install.";
    render();
  });
  button.addEventListener("click", async () => {
    if (!deferredPrompt || installed || prompting) return;
    const prompt = deferredPrompt;
    deferredPrompt = null;
    prompting = true;
    render();
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (!installed) status.textContent = choice.outcome === "accepted"
        ? "Installation accepted. Once installed, open ATLAS from your Home Screen."
        : "Installation dismissed. You can still open ATLAS or use the browser menu to install.";
    } catch {
      if (!installed) status.textContent = "Use your browser’s installation menu, or open ATLAS below.";
    } finally {
      prompting = false;
      render();
    }
  });
  function markInstalled() {
    installed = true;
    deferredPrompt = null;
    status.textContent = "ATLAS is installed.";
    render();
  }
  window.addEventListener("appinstalled", markInstalled);
  standalone.addEventListener?.("change", event => { if (event.matches) markInstalled(); });
  window.addEventListener("online", render);
  window.addEventListener("offline", render);
  byId("copy-link").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText("https://zmoffett1993.github.io/ATLAS/install/");
      byId("copy-status").textContent = "Link copied.";
    } catch {
      byId("copy-status").textContent = "Press and hold the link above to copy it.";
    }
  });
  render();

  // Keep the existing root worker (including reminders) instead of replacing it
  // with a competing install-page-only worker. No account or notification APIs.
  if ("serviceWorker" in navigator && window.isSecureContext) {
    const scope = new URL("../", window.location.href);
    navigator.serviceWorker.getRegistration(scope.href).then(registration => {
      if (registration?.scope === scope.href) return registration.update();
      return navigator.serviceWorker.register("../atlas-routing-worker.mjs?v=281", {
        type: "module", scope: scope.href, updateViaCache: "none",
      });
    }).catch(() => {
      byId("offline-note").hidden = false;
      byId("offline-note").textContent = "Offline setup is not available yet. You can still follow the installation instructions or open ATLAS.";
    });
  }
})();
