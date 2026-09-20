import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function environmentKey(modernName: string, legacyName: string) {
  const modern = Deno.env.get(modernName);
  if (modern) {
    try {
      const parsed = JSON.parse(modern);
      if (parsed?.default) return String(parsed.default);
      const first = Object.values(parsed || {})[0];
      if (first) return String(first);
    } catch {
      return modern;
    }
  }
  return Deno.env.get(legacyName) || "";
}

function serviceRoleKey() {
  // The legacy service-role key is a JWT and is safe to pass through the
  // standard Supabase JS client. Prefer it for server-side database work so
  // PostgREST receives the service_role claim and bypasses the intentionally
  // locked-down Scanner Intelligence tables.
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    || environmentKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
}

function service() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = serviceRoleKey();
  if (!url || !key) throw Object.assign(new Error("SUPABASE_SERVICE_CONFIGURATION_MISSING"), { status: 500 });
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function authenticated(req: Request) {
  const authorization = req.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw Object.assign(new Error("ATLAS_AUTH_REQUIRED"), { status: 401 });
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = environmentKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
  if (!url || !key) throw Object.assign(new Error("SUPABASE_AUTH_CONFIGURATION_MISSING"), { status: 500 });
  const authClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const result = await authClient.auth.getUser(token);
  if (result.error || !result.data?.user)
    throw Object.assign(new Error("ATLAS_AUTH_REQUIRED"), { status: 401 });
  return result.data.user;
}

function hasRole(user: any, permitted: string[]) {
  const metadata = user?.app_metadata || {};
  const roles = new Set([metadata.role, metadata.atlas_role, ...(Array.isArray(metadata.roles) ? metadata.roles : [])]
    .map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
  return permitted.some((role) => roles.has(String(role).toLowerCase()));
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function fail(error: any) {
  console.error("scanner-intelligence", error);
  const status = Math.max(400, Math.min(599, Number(error?.status || 500)));
  return json({ error: String(error?.message || "SCANNER_INTELLIGENCE_FAILED") }, status);
}

const BUCKET = "coc-scan-corrections";
const PAGE_SIZE = 1000;
const text = (value: unknown, maximum = 240) => String(value ?? "").trim().slice(0, maximum);
const upper = (value: unknown, maximum = 240) => text(value, maximum).toUpperCase();
const numberValue = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : null;
const normalizedConfidence = (value: unknown) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const raw = numberValue(value);
  if (raw === null) return null;
  const normalized = raw > 1 ? raw / 100 : raw;
  return Math.max(0, Math.min(1, normalized));
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function rolesFor(user: any) {
  const meta = user?.app_metadata || {};
  return new Set([meta.role, meta.atlas_role, ...(Array.isArray(meta.roles) ? meta.roles : [])]
    .map((value) => text(value, 80).toLowerCase()).filter(Boolean));
}

function warehouseFor(user: any, requested: unknown, { allowAll = false } = {}) {
  const roles = rolesFor(user);
  const admin = ["admin", "administrator"].some((role) => roles.has(role));
  const home = upper(user?.app_metadata?.home_warehouse_code || user?.app_metadata?.warehouse_code || "CA", 8);
  const target = upper(requested || home, 8);
  if (allowAll && admin && target === "ALL") return "ALL";
  if (!["CA", "TX"].includes(target)) throw Object.assign(new Error("WAREHOUSE_INVALID"), { status: 400 });
  if (!admin && target !== home) throw Object.assign(new Error("WAREHOUSE_ACCESS_DENIED"), { status: 403 });
  return target;
}

function requireAdministrator(user: any) {
  if (!hasRole(user, ["admin", "administrator"]))
    throw Object.assign(new Error("ADMINISTRATOR_REQUIRED"), { status: 403 });
}

function comparison(originalValue: unknown, confirmedValue: unknown) {
  const left = [...upper(originalValue, 120)];
  const right = [...upper(confirmedValue, 120)];
  const matrix = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let row = 0; row <= left.length; row += 1) matrix[row][0] = row;
  for (let column = 0; column <= right.length; column += 1) matrix[0][column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
  }
  const changes: Array<{ from: string; to: string; type: string }> = [];
  let row = left.length, column = right.length;
  while (row > 0 || column > 0) {
    if (row > 0 && column > 0 && left[row - 1] === right[column - 1]) { row -= 1; column -= 1; continue; }
    if (row > 0 && column > 0 && matrix[row][column] === matrix[row - 1][column - 1] + 1) {
      changes.push({ from: left[row - 1], to: right[column - 1], type: "substitution" }); row -= 1; column -= 1; continue;
    }
    if (row > 0 && matrix[row][column] === matrix[row - 1][column] + 1) {
      changes.push({ from: left[row - 1], to: "∅", type: "deletion" }); row -= 1; continue;
    }
    changes.push({ from: "∅", to: right[column - 1], type: "insertion" }); column -= 1;
  }
  return { distance: matrix[left.length][right.length], compared: Math.max(left.length, right.length), changes: changes.reverse() };
}

function decodeImage(image: any) {
  const dataUrl = text(image?.dataUrl, 3000000);
  const match = dataUrl.match(/^data:(image\/(?:jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  const binary = atob(match[2]);
  if (binary.length > 2097152) throw Object.assign(new Error("SCANNER_IMAGE_TOO_LARGE"), { status: 413 });
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return {
    bytes,
    mimeType: match[1],
    width: Math.max(1, Math.min(10000, Number(image?.width) || 1)),
    height: Math.max(1, Math.min(10000, Number(image?.height) || 1)),
  };
}

function rangeStart(value: unknown) {
  const days = ({ "7d": 7, "30d": 30, "90d": 90 } as Record<string, number>)[text(value, 8)] || 30;
  return new Date(Date.now() - days * 86400000).toISOString();
}

function applyFilters(query: any, warehouse: string, body: any, correctionsOnly = false) {
  if (warehouse !== "ALL") query = query.eq("warehouse_code", warehouse);
  query = query.gte("recorded_at", rangeStart(body.range));
  if (correctionsOnly) query = query.eq("outcome", "corrected");
  if (text(body.sku, 120)) query = query.eq("sku", upper(body.sku, 120));
  if (text(body.employeeId, 140)) query = query.eq("employee_user_id", text(body.employeeId, 140));
  if (text(body.captureMethod, 80)) query = query.eq("capture_method", text(body.captureMethod, 80));
  if (text(body.scannerVersion, 80)) query = query.eq("scanner_version", text(body.scannerVersion, 80));
  if (text(body.reviewStatus, 40)) query = query.eq("review_status", text(body.reviewStatus, 40));
  return query;
}

async function allAttempts(db: any, warehouse: string, body: any) {
  const rows: any[] = [];
  for (let page = 0; page < 50; page += 1) {
    let query = db.from("coc_scanner_attempts").select("*");
    query = applyFilters(query, warehouse, body).order("recorded_at", { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    const result = await query;
    if (result.error) throw result.error;
    rows.push(...(result.data || []));
    if ((result.data || []).length < PAGE_SIZE) break;
  }
  return rows;
}

const percentage = (value: number) => Math.max(0, Math.min(100, value));

function metricsFor(rows: any[]) {
  const exact = rows.filter((row) => row.outcome === "exact");
  const corrected = rows.filter((row) => row.outcome === "corrected");
  const failures = rows.filter((row) => row.outcome === "failure");
  const compared = [...exact, ...corrected];
  const comparedCharacters = compared.reduce((sum, row) => sum + Number(row.compared_characters || 0), 0);
  const edits = compared.reduce((sum, row) => sum + Number(row.edit_distance || 0), 0);
  const exactRate = rows.length ? exact.length / rows.length * 100 : 0;
  const characterAccuracy = comparedCharacters ? (comparedCharacters - edits) / comparedCharacters * 100 : 0;
  const daily = new Map<string, any[]>();
  rows.forEach((row) => {
    const key = String(row.recorded_at || "").slice(0, 10);
    daily.set(key, [...(daily.get(key) || []), row]);
  });
  const trends = [...daily.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, values]) => {
    const dayCompared = values.filter((row) => row.outcome !== "failure");
    const chars = dayCompared.reduce((sum, row) => sum + Number(row.compared_characters || 0), 0);
    const dayEdits = dayCompared.reduce((sum, row) => sum + Number(row.edit_distance || 0), 0);
    return {
      date,
      exactRate: percentage(values.filter((row) => row.outcome === "exact").length / Math.max(1, values.length) * 100),
      characterAccuracy: chars ? percentage((chars - dayEdits) / chars * 100) : 0,
      attempts: values.length,
    };
  });
  const group = (key: string) => Object.values(rows.reduce((result: any, row) => {
    const name = text(row[key] || "Unknown", 120);
    result[name] ||= { name, attempts: 0, exact: 0, corrected: 0, failures: 0, edits: 0, characters: 0 };
    result[name].attempts += 1;
    result[name][row.outcome === "failure" ? "failures" : row.outcome] += 1;
    result[name].edits += Number(row.edit_distance || 0);
    result[name].characters += Number(row.compared_characters || 0);
    return result;
  }, {})).map((item: any) => ({
    ...item,
    exactRate: percentage(item.exact / Math.max(1, item.attempts) * 100),
    characterAccuracy: item.characters ? percentage((item.characters - item.edits) / item.characters * 100) : 0,
  })).sort((left: any, right: any) => right.attempts - left.attempts);
  const characterChanges = Object.values(corrected.flatMap((row) => row.character_changes || []).reduce((result: any, change: any) => {
    const key = `${change.from || "∅"}→${change.to || "∅"}`;
    result[key] ||= { pair: key, from: change.from || "∅", to: change.to || "∅", count: 0 };
    result[key].count += 1;
    return result;
  }, {})).sort((left: any, right: any) => right.count - left.count).slice(0, 20);
  const employees = [...new Map(rows.map((row) => [row.employee_user_id, {
    id: row.employee_user_id, name: row.employee_name || "Employee",
  }])).values()].sort((a: any, b: any) => a.name.localeCompare(b.name));
  return {
    summary: {
      attempts: rows.length,
      exactScans: exact.length,
      exactRate: percentage(exactRate),
      characterAccuracy: percentage(characterAccuracy),
      correctedScans: corrected.length,
      oneTwoCharacterCorrections: corrected.filter((row) => Number(row.edit_distance) <= 2).length,
      failures: failures.length,
      manualFallbackRate: percentage(failures.length / Math.max(1, rows.length) * 100),
      unreviewed: corrected.filter((row) => row.review_status === "unreviewed").length,
    },
    trends,
    byCaptureMethod: group("capture_method"),
    byVersion: group("scanner_version"),
    bySku: group("sku"),
    characterChanges,
    recentCorrections: corrected.slice(0, 6),
    filters: {
      skus: [...new Set(rows.map((row) => row.sku).filter(Boolean))].sort(),
      employees,
      captureMethods: [...new Set(rows.map((row) => row.capture_method).filter(Boolean))].sort(),
      versions: [...new Set(rows.map((row) => row.scanner_version).filter(Boolean))].sort(),
    },
  };
}

async function signedCorrectionRows(db: any, rows: any[]) {
  const paths = rows.map((row) => row.image_object_path).filter(Boolean);
  const signed = paths.length ? await db.storage.from(BUCKET).createSignedUrls(paths, 300) : { data: [], error: null };
  if (signed.error) throw signed.error;
  const urlByPath = new Map((signed.data || []).map((item: any) => [item.path, item.signedUrl]));
  return rows.map((row) => ({ ...row, imageUrl: urlByPath.get(row.image_object_path) || null }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const user = await authenticated(req);
    const body = await req.json();
    const action = text(body.action, 60);
    const db = service();

    if (action === "record-attempt") {
      const warehouse = warehouseFor(user, body.warehouseCode);
      const clientEventId = text(body.clientEventId, 140);
      if (!uuidPattern.test(clientEventId)) throw Object.assign(new Error("SCANNER_EVENT_ID_INVALID"), { status: 400 });
      const existing = await db.from("coc_scanner_attempts").select("id,outcome").eq("client_event_id", clientEventId).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data) return json({ accepted: true, duplicate: true, id: existing.data.id, outcome: existing.data.outcome });
      const original = upper(body.scannerOriginalLot, 120);
      const confirmed = upper(body.confirmedLot, 120);
      const measured = comparison(original, confirmed);
      const requestedOutcome = text(body.outcome, 20);
      const outcome = requestedOutcome === "failure" || !original || !confirmed
        ? "failure" : measured.distance > 0 ? "corrected" : "exact";
      const recordedAt = Number.isFinite(new Date(body.recordedAt).valueOf())
        ? new Date(body.recordedAt).toISOString() : new Date().toISOString();
      let objectPath: string | null = null;
      let imageMeta: any = null;
      if (outcome === "corrected" && body.image) {
        imageMeta = decodeImage(body.image);
        if (imageMeta) {
          objectPath = `${warehouse}/${recordedAt.slice(0, 10)}/${user.id}/${clientEventId}.jpg`;
          const uploaded = await db.storage.from(BUCKET).upload(objectPath, imageMeta.bytes, {
            contentType: imageMeta.mimeType, upsert: false, cacheControl: "private, max-age=0",
          });
          if (uploaded.error) throw uploaded.error;
        }
      }
      const record = {
        client_event_id: clientEventId,
        warehouse_code: warehouse,
        coc_id: text(body.cocId, 140),
        pallet_number: Math.max(1, Number(body.palletNumber) || 1),
        sku: upper(body.sku, 120),
        outcome,
        scanner_original_lot: original,
        confirmed_lot: confirmed,
        edit_distance: outcome === "failure" ? 0 : measured.distance,
        compared_characters: outcome === "failure" ? 0 : measured.compared,
        character_changes: outcome === "corrected" ? measured.changes : [],
        capture_method: text(body.captureMethod || "camera", 80),
        confidence: normalizedConfidence(body.confidence),
        scanner_version: text(body.scannerVersion || "unknown", 80),
        employee_user_id: user.id,
        employee_name: text(body.employeeName, 120),
        customer_name: text(body.customerName, 160),
        invoice_number: text(body.invoiceNumber, 80),
        if_number: text(body.ifNumber, 80),
        image_object_path: objectPath,
        image_mime_type: imageMeta?.mimeType || null,
        image_width: imageMeta?.width || null,
        image_height: imageMeta?.height || null,
        review_status: outcome === "corrected" ? "unreviewed" : "not_required",
        recorded_at: recordedAt,
      };
      const inserted = await db.from("coc_scanner_attempts").insert(record).select("id,outcome").single();
      if (inserted.error) {
        if (objectPath) await db.storage.from(BUCKET).remove([objectPath]);
        throw inserted.error;
      }
      return json({ accepted: true, id: inserted.data.id, outcome: inserted.data.outcome, imageStored: Boolean(objectPath) });
    }

    requireAdministrator(user);
    const warehouse = warehouseFor(user, body.warehouseCode, { allowAll: true });
    if (action === "metrics") {
      const rows = await allAttempts(db, warehouse, body);
      return json(metricsFor(rows));
    }
    if (action === "list-corrections") {
      const page = Math.max(1, Number.parseInt(String(body.page || 1), 10) || 1);
      const size = Math.max(1, Math.min(50, Number.parseInt(String(body.pageSize || 12), 10) || 12));
      let query = db.from("coc_scanner_attempts").select("*", { count: "exact" });
      query = applyFilters(query, warehouse, body, true);
      if (text(body.correctionSize, 20) === "1-2") query = query.lte("edit_distance", 2);
      if (text(body.correctionSize, 20) === "3+") query = query.gte("edit_distance", 3);
      const result = await query.order("recorded_at", { ascending: false }).range((page - 1) * size, page * size - 1);
      if (result.error) throw result.error;
      return json({ items: await signedCorrectionRows(db, result.data || []), total: result.count || 0, page, pageSize: size });
    }
    if (action === "correction-detail") {
      const id = text(body.attemptId, 140);
      let query = db.from("coc_scanner_attempts").select("*").eq("id", id).eq("outcome", "corrected");
      if (warehouse !== "ALL") query = query.eq("warehouse_code", warehouse);
      const result = await query.single();
      if (result.error) throw Object.assign(new Error("SCANNER_CORRECTION_NOT_FOUND"), { status: 404 });
      const history = await db.from("coc_scanner_review_events").select("*").eq("attempt_id", id).order("created_at", { ascending: false });
      if (history.error) throw history.error;
      return json({ item: (await signedCorrectionRows(db, [result.data]))[0], history: history.data || [] });
    }
    if (action === "review-correction") {
      const id = text(body.attemptId, 140);
      const classification = text(body.classification, 60);
      const allowed = ["scanner_misread", "damaged_label", "unusual_format", "employee_correction_error"];
      if (!allowed.includes(classification)) throw Object.assign(new Error("REVIEW_CLASSIFICATION_REQUIRED"), { status: 400 });
      let currentQuery = db.from("coc_scanner_attempts").select("id,warehouse_code,review_status,review_classification,retain_for_training")
        .eq("id", id).eq("outcome", "corrected");
      if (warehouse !== "ALL") currentQuery = currentQuery.eq("warehouse_code", warehouse);
      const current = await currentQuery.single();
      if (current.error) throw Object.assign(new Error("SCANNER_CORRECTION_NOT_FOUND"), { status: 404 });
      const next = {
        review_status: body.exclude ? "excluded" : "reviewed",
        review_classification: classification,
        retain_for_training: !body.exclude && Boolean(body.retainForTraining),
        reviewed_by_user_id: user.id,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const updated = await db.from("coc_scanner_attempts").update(next).eq("id", id).select("*").single();
      if (updated.error) throw updated.error;
      const audited = await db.from("coc_scanner_review_events").insert({
        attempt_id: id,
        warehouse_code: current.data.warehouse_code,
        actor_user_id: user.id,
        prior_state: current.data,
        next_state: next,
      });
      if (audited.error) throw audited.error;
      return json({ item: updated.data });
    }
    throw Object.assign(new Error("SCANNER_ACTION_NOT_SUPPORTED"), { status: 400 });
  } catch (error) {
    return fail(error);
  }
});
