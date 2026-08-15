/* Routes Delete SKU through the protected request/approval Edge Function.
   The React inventory form continues to own the selected SKU and UI state. */
(() => {
  "use strict";
  const API_URL = "https://dwrrbpiprcmajfyronlf.supabase.co";
  const PUBLIC_KEY = "sb_publishable_akr0opK3RV0Mg5CQpF2woQ_hBFyRIJa";
  const SESSION_KEY = "atlas-dashboard-session-v1";
  const session = () => {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch (_) { return null; }
  };
  window.atlasRequestSkuDelete = async ({ skuId }) => {
    const saved = session();
    if (!saved?.access_token) throw new Error("Sign in with your ATLAS account before requesting SKU deletion.");
    const response = await fetch(`${API_URL}/functions/v1/atlas-user-admin`, {
      method: "POST",
      headers: { apikey: PUBLIC_KEY, Authorization: `Bearer ${saved.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "submit_sku_delete_request", sku_id: skuId }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || "The deletion request could not be sent.");
    return payload;
  };
})();
