// Baseline: deployed coc-workbook-revisions v13; pending COC support prepared locally.
import { createClient } from "npm:@supabase/supabase-js@2";
import { stationForWarehouse } from "../_shared/coc.ts";
import JSZip from "npm:jszip@3.10.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "coc-reports";
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
const REQUIRED_MERGES = ["A1:C1", "A5:C5", "C3:C4"];

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
  if (result.error || !result.data?.user) throw Object.assign(new Error("ATLAS_AUTH_REQUIRED"), { status: 401 });
  return result.data.user;
}

const text = (value: unknown, maximum = 240) => String(value ?? "").trim().slice(0, maximum);
const upper = (value: unknown, maximum = 240) => text(value, maximum).toUpperCase();

function rolesFor(user: any) {
  const meta = user?.app_metadata || {};
  return new Set([meta.role, meta.atlas_role, ...(Array.isArray(meta.roles) ? meta.roles : [])]
    .map((value) => text(value, 80).toLowerCase()).filter(Boolean));
}

function canViewRevisionHistory(user: any) {
  const roles = rolesFor(user);
  return roles.has("supervisor") || roles.has("admin") || roles.has("administrator");
}

function warehouseFor(user: any, requested: unknown) {
  const roles = rolesFor(user);
  const admin = roles.has("admin") || roles.has("administrator");
  const home = upper(user?.app_metadata?.home_warehouse_code || user?.app_metadata?.warehouse_code || "CA", 8);
  const target = upper(requested || home, 8);
  if (!["CA", "TX"].includes(target)) throw Object.assign(new Error("WAREHOUSE_INVALID"), { status: 400 });
  if (!admin && target !== home) throw Object.assign(new Error("WAREHOUSE_ACCESS_DENIED"), { status: 403 });
  return target;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function fail(error: any) {
  console.error("coc-workbook-revisions", error);
  const status = Math.max(400, Math.min(599, Number(error?.status || 500)));
  return json({ error: String(error?.message || "COC_WORKBOOK_REVISION_FAILED") }, status);
}

function decodeBase64(value: unknown) {
  const encoded = text(value, Math.ceil(MAX_FILE_BYTES * 1.4) + 32);
  if (!encoded || encoded.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8)
    throw Object.assign(new Error("COC_REVISION_FILE_TOO_LARGE"), { status: 413 });
  let binary = "";
  try { binary = atob(encoded); } catch { throw Object.assign(new Error("COC_REVISION_FILE_INVALID"), { status: 400 }); }
  if (!binary.length || binary.length > MAX_FILE_BYTES)
    throw Object.assign(new Error("COC_REVISION_FILE_TOO_LARGE"), { status: 413 });
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    throw Object.assign(new Error("COC_REVISION_XLSX_REQUIRED"), { status: 400 });
  return bytes;
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function xmlAttribute(attributes: string, name: string) {
  return attributes.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1] || "";
}

function stringValues(xml: string) {
  const values: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
    const pieces = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((part) => decodeXml(part[1]));
    values.push(pieces.join(""));
  }
  return values;
}

function cellValues(sheetXml: string, shared: string[]) {
  const cells: Record<string, string> = {};
  for (const match of sheetXml.matchAll(/<c\b([^>]*\br="([A-Z]+\d+)"[^>]*)>([\s\S]*?)<\/c>/gi)) {
    const attributes = match[1], reference = match[2].toUpperCase(), body = match[3];
    const type = xmlAttribute(attributes, "t").toLowerCase();
    const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] || "";
    if (type === "s") cells[reference] = shared[Number(raw)] || "";
    else if (type === "inlinestr") cells[reference] = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((item) => decodeXml(item[1])).join("");
    else cells[reference] = decodeXml(raw);
  }
  return cells;
}

function normalizedValue(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function parseWorkbook(bytes: Uint8Array, allowPending = false) {
  let zip: any;
  try { zip = await JSZip.loadAsync(bytes); }
  catch { throw Object.assign(new Error("COC_REVISION_XLSX_INVALID"), { status: 400 }); }

  const entries: any[] = Object.values(zip.files || {});
  const totalSize = entries.reduce((sum: number, item: any) => sum + Number(item?._data?.uncompressedSize || 0), 0);
  if (totalSize > MAX_UNCOMPRESSED_BYTES)
    throw Object.assign(new Error("COC_REVISION_WORKBOOK_TOO_COMPLEX"), { status: 413 });
  if (entries.some((item: any) => /(^|\/)(vbaProject\.bin|externalLinks|connections\.xml)/i.test(item.name)))
    throw Object.assign(new Error("COC_REVISION_EXTERNAL_CONTENT_NOT_ALLOWED"), { status: 400 });

  const required = ["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/styles.xml"];
  if (required.some((path) => !zip.file(path)))
    throw Object.assign(new Error("COC_REVISION_TEMPLATE_STRUCTURE_MISSING"), { status: 400 });

  const [workbookXml, sheetXml, sharedXml] = await Promise.all([
    zip.file("xl/workbook.xml")!.async("string"),
    zip.file("xl/worksheets/sheet1.xml")!.async("string"),
    zip.file("xl/sharedStrings.xml")?.async("string") || Promise.resolve(""),
  ]);
  if (workbookXml.length + sheetXml.length + sharedXml.length > MAX_UNCOMPRESSED_BYTES)
    throw Object.assign(new Error("COC_REVISION_WORKBOOK_TOO_COMPLEX"), { status: 413 });
  if (!/name="Sheet1"/i.test(workbookXml))
    throw Object.assign(new Error("COC_REVISION_OFFICIAL_SHEET_REQUIRED"), { status: 400 });

  const mergeXml = sheetXml.match(/<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/i)?.[1] || "";
  const merges = new Set([...mergeXml.matchAll(/<mergeCell\b[^>]*ref="([^"]+)"/gi)].map((match) => match[1].toUpperCase()));
  if (REQUIRED_MERGES.some((reference) => !merges.has(reference)))
    throw Object.assign(new Error("COC_REVISION_TEMPLATE_LAYOUT_CHANGED"), { status: 400 });

  const cells = cellValues(sheetXml, stringValues(sharedXml));
  const customerName = normalizedValue(cells.B2);
  const invoiceNumber = normalizedValue(cells.B3);
  const ifNumber = normalizedValue(cells.B4);
  if (!customerName || (!allowPending && (!invoiceNumber || !ifNumber)))
    throw Object.assign(new Error("COC_REVISION_HEADER_FIELDS_REQUIRED"), { status: 400 });

  const detail: Array<{ row: number; model: string; lot: string; quantity: string }> = [];
  for (let row = 7; row <= 748; row += 1) {
    const model = normalizedValue(cells[`A${row}`]);
    const lot = normalizedValue(cells[`B${row}`]);
    const quantity = normalizedValue(cells[`C${row}`]);
    if (model || lot || quantity) detail.push({ row, model, lot, quantity });
  }
  if (!detail.length) throw Object.assign(new Error("COC_REVISION_DETAIL_ROWS_REQUIRED"), { status: 400 });

  return { customerName, invoiceNumber, ifNumber, detail, cells };
}

function changeLabel(reference: string) {
  if (reference === "B2") return "Customer name";
  if (reference === "B3") return "Invoice number";
  if (reference === "B4") return "IF number";
  const match = reference.match(/^([ABC])(\d+)$/);
  if (!match) return reference;
  return `${({ A: "Model number", B: "Lot / pallet", C: "Quantity" } as Record<string, string>)[match[1]]} · row ${match[2]}`;
}

function compareWorkbooks(original: any, revised: any, allowUnchanged = false) {
  const references = ["B2", "B3", "B4"];
  for (let row = 7; row <= 748; row += 1) references.push(`A${row}`, `B${row}`, `C${row}`);
  const changes = references.flatMap((reference) => {
    const before = normalizedValue(original.cells[reference]);
    const after = normalizedValue(revised.cells[reference]);
    return before === after ? [] : [{ reference, label: changeLabel(reference), before, after }];
  });
  if (!changes.length && !allowUnchanged) throw Object.assign(new Error("COC_REVISION_HAS_NO_CHANGES"), { status: 400 });
  if (changes.length > 250) throw Object.assign(new Error("COC_REVISION_TOO_MANY_CHANGES"), { status: 400 });
  return changes;
}

function safeFileName(value: unknown, fallback = "Official COC Revised.xlsx") {
  const clean = text(value, 160).replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  const name = clean || fallback;
  return /\.xlsx$/i.test(name) ? name : `${name}.xlsx`;
}

async function deliveryFor(db: any, deliveryId: string, warehouseCode: string, stationId: string) {
  const result = await db.from("coc_deliveries")
    .select("id,status,station_id,submitted_by_user_id,workbook_file_name,workbook_object_path,report_snapshot")
    .eq("id", deliveryId).eq("station_id", stationId).single();
  if (result.error || !result.data) throw Object.assign(new Error("COC_DELIVERY_NOT_FOUND"), { status: 404 });
  const recordWarehouse = upper(result.data.report_snapshot?.warehouseCode || result.data.report_snapshot?.warehouse_code || "CA", 8);
  if (recordWarehouse !== warehouseCode) throw Object.assign(new Error("WAREHOUSE_ACCESS_DENIED"), { status: 403 });
  if (!["RECEIVED", "OFFICE_COMPLETED"].includes(upper(result.data.status, 32)))
    throw Object.assign(new Error("COC_REVISION_STATUS_NOT_EDITABLE"), { status: 409 });
  if (!result.data.workbook_object_path) throw Object.assign(new Error("COC_WORKBOOK_NOT_AVAILABLE"), { status: 404 });
  return result.data;
}

async function ensureOriginalRevision(db: any, delivery: any, warehouseCode: string, actorId: string) {
  const existing = await db.from("coc_workbook_revisions").select("*").eq("delivery_id", delivery.id).order("revision_number", { ascending: true });
  if (existing.error) throw existing.error;
  if (existing.data?.length) return existing.data;

  const downloaded = await db.storage.from(BUCKET).download(delivery.workbook_object_path);
  if (downloaded.error || !downloaded.data) throw downloaded.error || new Error("COC_WORKBOOK_NOT_AVAILABLE");
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  const parsed = await parseWorkbook(bytes, true);
  const inserted = await db.from("coc_workbook_revisions").insert({
    delivery_id: delivery.id,
    warehouse_code: warehouseCode,
    revision_number: 1,
    status: "APPROVED",
    is_current: true,
    workbook_file_name: delivery.workbook_file_name || "Official COC.xlsx",
    workbook_object_path: delivery.workbook_object_path,
    workbook_size_bytes: bytes.length,
    workbook_sha256: await sha256(bytes),
    correction_reason: "Original warehouse submission",
    revision_note: "Original Official COC preserved automatically before the first revision.",
    parsed_workbook: { customerName: parsed.customerName, invoiceNumber: parsed.invoiceNumber, ifNumber: parsed.ifNumber },
    change_summary: [],
    created_by_user_id: delivery.submitted_by_user_id || actorId,
    approved_by_user_id: delivery.submitted_by_user_id || actorId,
    approved_at: new Date().toISOString(),
  }).select("*").single();
  if (inserted.error) {
    const raced = await db.from("coc_workbook_revisions").select("*").eq("delivery_id", delivery.id).order("revision_number", { ascending: true });
    if (raced.error || !raced.data?.length) throw inserted.error;
    return raced.data;
  }
  return [inserted.data];
}

function publicRevision(row: any) {
  return {
    id: row.id,
    revisionNumber: Number(row.revision_number),
    status: row.status,
    isCurrent: Boolean(row.is_current),
    fileName: row.workbook_file_name,
    fileSize: Number(row.workbook_size_bytes || 0),
    sha256: row.workbook_sha256,
    reason: row.correction_reason,
    note: row.revision_note,
    changes: Array.isArray(row.change_summary) ? row.change_summary : [],
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    createdByUserId: row.created_by_user_id,
    approvedByUserId: row.approved_by_user_id,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (req.method !== "POST") throw Object.assign(new Error("METHOD_NOT_ALLOWED"), { status: 405 });
    const user = await authenticated(req);
    const body = await req.json();
    const action = text(body.action, 60);
    const roles = rolesFor(user);
    if (!["office", "office_receiver", "supervisor", "admin", "administrator"].some(role => roles.has(role)))
      throw Object.assign(new Error("OFFICE_ROLE_REQUIRED"), { status: 403 });
    const resolved = await stationForWarehouse(user, body.warehouseCode);
    const warehouseCode = resolved.context.selectedWarehouse.code;
    const db = service();

    if (action === "list-edits") {
      if (!canViewRevisionHistory(user))
        throw Object.assign(new Error("COC_REVISION_HISTORY_MANAGEMENT_ONLY"), { status: 403 });
      const limit = Math.max(1, Math.min(100, Number.parseInt(String(body.limit || "50"), 10) || 50));
      const revised = await db.from("coc_workbook_revisions").select("*")
        .eq("warehouse_code", warehouseCode)
        .eq("status", "APPROVED")
        .gt("revision_number", 1)
        .order("approved_at", { ascending: false, nullsFirst: false })
        .limit(limit);
      if (revised.error) throw revised.error;
      const deliveryIds = [...new Set((revised.data || []).map((row: any) => row.delivery_id).filter(Boolean))];
      const deliveries = deliveryIds.length
        ? await db.from("coc_deliveries").select("id,status,report_snapshot,workbook_file_name,completed_at,sent_at,received_at,office_completed_at,receiver_archived_at").in("id", deliveryIds)
        : { data: [], error: null };
      if (deliveries.error) throw deliveries.error;
      const deliveryById = new Map((deliveries.data || []).map((delivery: any) => [delivery.id, delivery]));
      return json({
        edits: (revised.data || []).map((row: any) => ({
          ...publicRevision(row),
          deliveryId: row.delivery_id,
          delivery: deliveryById.get(row.delivery_id) || null,
        })),
      });
    }

    const deliveryId = text(body.deliveryId, 80);
    if (!deliveryId) throw Object.assign(new Error("COC_DELIVERY_REQUIRED"), { status: 400 });
    const delivery = await deliveryFor(db, deliveryId, warehouseCode, resolved.station.id);

    if (action === "status") {
      const history = await db.from("coc_workbook_revisions").select("*").eq("delivery_id", deliveryId).order("revision_number", { ascending: false });
      if (history.error) throw history.error;
      const inferred = history.data?.length ? null : {
        id: null, revisionNumber: 1, status: "APPROVED", isCurrent: true,
        fileName: delivery.workbook_file_name || "Official COC.xlsx", reason: "Original warehouse submission",
        note: "", changes: [], createdAt: delivery.report_snapshot?.completedAt || null, approvedAt: null,
      };
      const revisions = history.data?.length ? history.data.map(publicRevision) : [inferred];
      return json({
        currentRevision: revisions.find((item: any) => item.isCurrent) || revisions[0],
        hasPendingRevision: revisions.some((item: any) => item.status === "PENDING"),
        revisions: canViewRevisionHistory(user) ? revisions : [],
      });
    }

    if (action === "pending-revision") {
      const result = await db.from("coc_workbook_revisions").select("*")
        .eq("delivery_id", deliveryId).eq("warehouse_code", warehouseCode).eq("status", "PENDING")
        .order("revision_number", { ascending: false }).limit(1).maybeSingle();
      if (result.error) throw result.error;
      if (!result.data) return json({ pending: null });
      const signed = await db.storage.from(BUCKET).createSignedUrl(result.data.workbook_object_path, 60);
      if (signed.error || !signed.data?.signedUrl) throw signed.error || new Error("COC_WORKBOOK_NOT_AVAILABLE");
      return json({ pending: publicRevision(result.data), downloadUrl: signed.data.signedUrl });
    }

    if (action === "stage-revision" || action === "save-pending") {
      const savePending = action === "save-pending";
      if (savePending && delivery.status === "OFFICE_COMPLETED")
        throw Object.assign(new Error("COC_ALREADY_COMPLETED_AT_OFFICE"), { status: 409 });
      const fileName = safeFileName(body.fileName);
      const reason = text(body.reason, 120);
      const note = text(body.note, 500);
      if (!reason) throw Object.assign(new Error("COC_REVISION_REASON_REQUIRED"), { status: 400 });
      const bytes = decodeBase64(body.workbookBase64);
      const revised = await parseWorkbook(bytes, savePending);
      const revisions = await ensureOriginalRevision(db, delivery, warehouseCode, user.id);
      const current = [...revisions].sort((left: any, right: any) => Number(right.revision_number) - Number(left.revision_number))
        .find((row: any) => row.is_current) || revisions[0];
      const originalDownload = await db.storage.from(BUCKET).download(current.workbook_object_path);
      if (originalDownload.error || !originalDownload.data) throw originalDownload.error || new Error("COC_WORKBOOK_NOT_AVAILABLE");
      const originalBytes = new Uint8Array(await originalDownload.data.arrayBuffer());
      const original = await parseWorkbook(originalBytes, true);
      const changes = compareWorkbooks(original, revised, true);
      const maximum = revisions.reduce((value: number, row: any) => Math.max(value, Number(row.revision_number || 0)), 0);
      const revisionNumber = maximum + 1;
      const objectPath = `${warehouseCode.toLowerCase()}/${deliveryId}/revisions/revision-${revisionNumber}-${crypto.randomUUID()}.xlsx`;
      const upload = await db.storage.from(BUCKET).upload(objectPath, bytes, {
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        upsert: false,
        cacheControl: "0",
      });
      if (upload.error) throw upload.error;
      const digest = await sha256(bytes);
      const inserted = await db.from("coc_workbook_revisions").insert({
        delivery_id: deliveryId,
        warehouse_code: warehouseCode,
        revision_number: revisionNumber,
        status: "PENDING",
        is_current: false,
        workbook_file_name: fileName,
        workbook_object_path: objectPath,
        workbook_size_bytes: bytes.length,
        workbook_sha256: digest,
        correction_reason: reason,
        revision_note: note || null,
        parsed_workbook: { customerName: revised.customerName, invoiceNumber: revised.invoiceNumber, ifNumber: revised.ifNumber },
        change_summary: changes,
        created_by_user_id: user.id,
      }).select("*").single();
      if (inserted.error) {
        await db.storage.from(BUCKET).remove([objectPath]);
        throw inserted.error;
      }
      return json({ candidate: publicRevision(inserted.data) });
    }

    if (action === "approve-revision") {
      const revisionId = text(body.revisionId, 80);
      if (!revisionId) throw Object.assign(new Error("COC_REVISION_REQUIRED"), { status: 400 });
      const candidate = await db.from("coc_workbook_revisions").select("*")
        .eq("id", revisionId).eq("delivery_id", deliveryId).eq("warehouse_code", warehouseCode).single();
      if (candidate.error || !candidate.data) throw Object.assign(new Error("COC_REVISION_NOT_FOUND"), { status: 404 });
      if (candidate.data.status !== "PENDING") throw Object.assign(new Error("COC_REVISION_NOT_PENDING"), { status: 409 });
      const parsed = candidate.data.parsed_workbook || {};
      if (!text(parsed.customerName) || !text(parsed.invoiceNumber) || !text(parsed.ifNumber))
        throw Object.assign(new Error("COC_REVISION_HEADER_FIELDS_REQUIRED"), { status: 400 });
      const approved = await db.rpc("atlas_approve_coc_workbook_revision", {
        p_delivery_id: deliveryId,
        p_revision_id: revisionId,
        p_actor_user_id: user.id,
      });
      if (approved.error) throw approved.error;
      const snapshotUpdate = await db.from("coc_deliveries").update({
        report_snapshot: {
          ...(delivery.report_snapshot || {}),
          customerName: text(parsed.customerName || delivery.report_snapshot?.customerName, 160),
          invoiceNumber: text(parsed.invoiceNumber || delivery.report_snapshot?.invoiceNumber, 100),
          ifNumber: text(parsed.ifNumber || delivery.report_snapshot?.ifNumber, 100),
        },
        updated_at: new Date().toISOString(),
      }).eq("id", deliveryId);
      if (snapshotUpdate.error) throw snapshotUpdate.error;
      const history = await db.from("coc_workbook_revisions").select("*").eq("delivery_id", deliveryId).order("revision_number", { ascending: false });
      if (history.error) throw history.error;
      return json({
        approved: publicRevision(history.data.find((row: any) => row.id === revisionId)),
        revisions: canViewRevisionHistory(user) ? history.data.map(publicRevision) : [],
      });
    }

    throw Object.assign(new Error("COC_REVISION_ACTION_NOT_SUPPORTED"), { status: 400 });
  } catch (error) {
    return fail(error);
  }
});
