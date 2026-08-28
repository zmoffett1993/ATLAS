(function (global) {
  "use strict";

  const SOURCE = "Photographed company case-quantity tables · 2026-08-27";
  const EMBEDDED_ROWS = [
    ["CGPCS-40G", 600],
    ["CGPCS-50GL", 500, "NEW NOV 2025"],
    ["CGPCS-100G", 300],
    ["CGSSB1-30MLSC", 800],
    ["CGSSB1-60ML", 500],
    ["CGSSB1-60MLM", 500],
    ["CGSC1-30MLMTW", 200],
    ["CGSC1-2OZTW", 150],
    ["CGSC1-2OZ", 400],
    ["CGSB1-60MLM", 500],
    ["CGSC1-3OZ", 400],
    ["CGSC1-4OZ", 400],
    ["CGSC1-5OZ", 300],
    ["CGSC1-6OZ", 300],
    ["CGSC1-8OZ", 200],
    ["CGSC1-10OZWM", 120],
    ["CGSC1-7.5OZXL", 100],
    ["CGSC1-10OZXL", 80],
    ["CGSC1-18.5OZXL", 60],
    ["CGSC1-21.5OZXL", 40],
    ["CGST1-65MM", 400],
    ["CGST1-95MM", 300],
    ["CGST1-115MM", 200],
    ["CGST1-95MMXL", 200],
    ["CGSB1-10ML", 1000],
    ["CGSB1-16.5ML", 1000],
    ["CGSB1-20ML", 1000],
    ["CGSB1-30ML", 1000],
    ["CGSB1-30MLSC", 1000],
    ["CGSB1-50ML", 500],
    ["CGSB1-60ML", 500],
    ["CGSB1-100ML", 400],
    ["CGSB1-120ML", 400],
    ["CGSDCUP5-9ML-CNL", 2000],
    ["CGSDCUP5-20ML-CNL", 2000],
    ["CGSDCUP5-40ML-CNL", 1000],
    ["CGSC1-510R", 400],
    ["CGSC1-510F", 400],
    ["CGASB1-30MLSC", 800],
    ["CGASB1-60MLM", 500],
    ["CGASB1-60ML", 500, "NEW"],
    ["CGASB1-100MLM", 400],
    ["CGAC1-1OZ", 500],
    ["CGAC1-2OZ", 500],
    ["CGAC1-3OZ", 400],
    ["CGAC1-4OZ", 400],
    ["CGAC1-5OZ", 300],
    ["CGAC1-6OZ", 300],
    ["CGAC1-8OZ", 200, "NEW BOX"],
    ["CGAC1-7.5OZXL", 100],
    ["CGAC1-10OZXL", 80],
    ["CGAC1-18.5OZXL", 60],
    ["CGAC1-21.5OZXL", 40],
    ["CGAT1-65MMF", 500],
    ["CGAT1-100MMF", 400, "NEW"],
    ["CGAT6-100MM", 500],
    ["CGAT6-113MM", 500],
    ["CGAT1-115MMF", 400],
    ["CGAT6-120MM", 500],
    ["CGAPT5-78MM", 1500],
    ["CGAPT5-98MM", 1500],
    ["CGAPT5-116MM", 1500, "NEW"],
    ["CGAPT5-78MML", 1500],
    ["CGAPT5-98MML", 1500],
    ["CGAPT5-116MML", 1500],
    ["CGAB1-10ML", 1000],
    ["CGAB1-16.5ML", 1000],
    ["CGAB1-20ML", 1000],
    ["CGAB1-30ML", 1000],
    ["CGAB1-30MLSC", 1000],
    ["CGAB1-50ML", 500],
    ["CGAB1-60ML", 500],
    ["CGAB1-60MLM", 500],
    ["CGAB1-100ML", 400],
    ["CGAB1-120ML", 400],
    ["CGABB1-250ML", 120],
    ["CGABB1-500ML", 60],
    ["CGABB1-1LTR", 30],
    ["CGAC1-510R", 500],
    ["CGAC1-510F", 600, "NEW 2026"],
    ["CGUB1-5MLV3", 2000],
    ["CGUB1-9MLV3", 2000],
    ["CGUB1-10MLV3", 2000, "NEW"],
    ["CGUB1-15MLV3", 1000],
    ["CGUB1-20MLV3", 1000],
    ["CGUB1-30MLV3", 1000],
    ["CGUB1-50MLV3", 500],
    ["CGUB1-60MLV3", 500],
    ["CGUB1-75MLV3", 500],
    ["CGUB1-100MLV3", 400],
    ["CGUB1-120MLV3", 400],
    ["CGUB1-200MLV3", 300],
    ["CGUB1-20MLSC", 1000],
    ["CGUB1-30MLSC", 1000, "NEW"],
    ["CGUB1-60MLSC", 500],
    ["CGUB1-75MLSC", 500],
    ["CGUB1-60MLM", 500],
    ["CGUB1-75MLM", 400],
    ["CGUB1-10MLR", 2000, "NEW"],
    ["CGUB1-15MLR", 1000],
    ["CGUB1-20MLR", 1000],
    ["CGUB1-30MLR", 1000],
    ["CGUB1-50MLR", 500],
    ["CGUB1-60MLR", 500],
    ["CGUB1-100MLR", 400],
    ["CGUB1-120MLR", 400],
  ];

  function normalize(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .toUpperCase()
      .replace(/\([^)]*\)/g, "")
      .replace(/[‐‑‒–—―−﹘﹣－_]/g, "-")
      .replace(/\s+/g, "")
      .replace(/[^A-Z0-9./-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/([0-9])0Z/g, "$1OZ");
  }

  const catalog = new Map(EMBEDDED_ROWS.map(([modelNumber, caseQuantity, sourceRevision = "CURRENT"]) => {
    const normalized = normalize(modelNumber);
    return [normalized, Object.freeze({
      modelNumber: normalized,
      caseQuantity,
      sourceRevision,
      source: SOURCE,
      origin: "embedded",
    })];
  }));

  function list() {
    return [...catalog.values()].sort((a, b) => a.modelNumber.localeCompare(b.modelNumber));
  }

  function resolve(value) {
    const modelNumber = normalize(value);
    if (!modelNumber) return null;
    const exact = catalog.get(modelNumber);
    const record = exact || list()
      .filter((item) => modelNumber.startsWith(`${item.modelNumber}-`))
      .sort((a, b) => b.modelNumber.length - a.modelNumber.length)[0];
    if (!record) return null;
    return Object.freeze({
      modelNumber,
      catalogModel: record.modelNumber,
      caseQuantity: record.caseQuantity,
      sourceRevision: record.sourceRevision,
      source: record.source,
      origin: record.origin,
    });
  }

  function recordForSession(value) {
    const resolved = resolve(value);
    if (!resolved) return null;
    return Object.freeze({
      modelNumber: resolved.modelNumber,
      catalogModel: resolved.catalogModel,
      caseQuantity: resolved.caseQuantity,
      sourceRevision: resolved.sourceRevision,
      addedAt: new Date().toISOString(),
    });
  }

  async function loadRemote() {
    const config = global.atlasSupabaseConfig;
    if (!config?.url || !config?.key || !global.navigator?.onLine) return list();
    try {
      const response = await fetch(`${config.url}/rest/v1/coc_model_case_quantities?select=model_number,case_quantity,source_revision,effective_date&active=eq.true&order=model_number.asc`, {
        headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`catalog unavailable (${response.status})`);
      const rows = await response.json();
      rows.forEach((row) => {
        const modelNumber = normalize(row?.model_number);
        const caseQuantity = Number(row?.case_quantity);
        if (!modelNumber || !Number.isSafeInteger(caseQuantity) || caseQuantity <= 0) return;
        catalog.set(modelNumber, Object.freeze({
          modelNumber,
          caseQuantity,
          sourceRevision: String(row?.source_revision || row?.effective_date || "DATABASE"),
          source: "Supabase coc_model_case_quantities",
          origin: "database",
        }));
      });
      global.dispatchEvent?.(new CustomEvent("atlas:coc-case-quantities-ready"));
    } catch (error) {
      console.info("ATLAS is using the protected offline COC case-quantity catalog.", error.message);
    }
    return list();
  }

  global.AtlasCocCaseQuantities = Object.freeze({
    SOURCE,
    normalize,
    list,
    resolve,
    recordForSession,
    loadRemote,
  });
})(window);
