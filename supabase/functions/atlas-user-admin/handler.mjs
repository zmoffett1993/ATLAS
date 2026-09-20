const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-atlas-receiver-id,x-atlas-receiver-secret" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = (value, maximum = 120) => String(value ?? "").trim().slice(0, maximum);
const normalizeLoginName = value => clean(value, 80).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "").slice(0, 48);
const checked = result => { if (result.error) throw result.error; return result.data; };
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const revision = user => Number(user?.app_metadata?.atlas_assignment_revision || 0);
const snapshot = (db, actor, operation = null) => db.rpc("atlas_account_admin_snapshot", { p_actor: actor, p_operation: operation }).then(checked);

async function assignment(db, body) {
  const role = clean(body.role, 40).toLowerCase();
  if (!["picker", "office_receiver", "supervisor", "admin"].includes(role)) throw problem("ATLAS_ROLE_INVALID");
  const code = typeof body.warehouse_code === "string" ? body.warehouse_code.trim().toUpperCase() : "";
  if (!/^[A-Z]{2,8}$/.test(code)) throw problem("WAREHOUSE_REQUIRED_OR_INVALID");
  const displayName = clean(body.display_name, 60);
  const loginName = normalizeLoginName(body.login_name);
  if (!displayName) throw problem("DISPLAY_NAME_REQUIRED");
  if (loginName.length < 2) throw problem("Enter at least two characters for the sign-in name.");
  return { role, warehouse_code: code, display_name: displayName, login_name: loginName };
}

export function createHandler(service) {
  return async req => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({error:"METHOD_NOT_ALLOWED"},405);
    try {
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!token) throw problem("ATLAS_AUTH_REQUIRED", 401);
      const db = service();
      const auth = await db.auth.getUser(token);
      if (auth.error || !auth.data?.user) throw problem("ATLAS_AUTH_REQUIRED", 401);
      const actor = auth.data.user;
      // The service-only RPC checks current Auth AND profile role, ban and deletion
      // in the database. Neither user_metadata nor stale JWT role claims authorize.
      const body = await req.json();
      const action = clean(body.action, 40).toLowerCase();
      if (action === "list") return json({ users: await snapshot(db, actor.id) });
      if (["create", "update"].includes(action)) {
        if (!uuid(body.operation_id)) throw problem("Refresh ATLAS before saving this account.",409);
        const value = await assignment(db, body);
        if (action === "update" && !uuid(body.user_id)) throw problem("USER_ID_REQUIRED");
        const reconcile = async () => {
          const saved = await snapshot(db, actor.id, body.operation_id);
          if (!saved) return null;
          if ((action === "create" && saved.revision !== 1) ||
              (action === "update" && (saved.user_id !== body.user_id || saved.revision !== body.expected_revision + 1)) ||
              Object.keys(value).some(key => value[key] !== saved.request?.[key])) {
            throw problem("This save attempt already belongs to a different change. Reopen the account form.",409);
          }
          return { message: action === "create" ? "The ATLAS account was created." : "The ATLAS access was updated.",
            user_id: saved.user_id, login_name: value.login_name, assignment_revision: saved.revision, operation_id: body.operation_id };
        };
        const prior = await reconcile();
        if (prior) return json(prior);
        const users = await snapshot(db, actor.id);
        if (action === "update" && (!Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0)) {
          throw problem("Refresh the account list and reopen this account before saving.",409);
        }
        const home = checked(await db.from("warehouses").select("id,code,active").eq("active",true));
        if (!home.some(row => row.code === value.warehouse_code)) throw problem("WAREHOUSE_INACTIVE_OR_UNKNOWN");
        if (users.some(user => user.id !== body.user_id && normalizeLoginName(user.login_name) === value.login_name)) {
          throw problem("That sign-in name is already in use.",409);
        }
        const marker = { ...value, actor_id: actor.id, operation_id: body.operation_id,
          expected_revision: action === "create" ? 0 : body.expected_revision };
        try {
          if (action === "create") {
            const password = String(body.password || "");
            if (password.length < 10) throw problem("PASSWORD_TOO_SHORT");
            checked(await db.auth.admin.createUser({email:value.login_name+"@users.atlas.invalid",password,email_confirm:true,
              app_metadata:{atlas_assignment_request:marker}}));
          } else {
            const current = checked(await db.auth.admin.getUserById(body.user_id)).user;
            if (!current || current.deleted_at) throw problem("ACCOUNT_NOT_FOUND",404);
            if (revision(current) !== body.expected_revision) throw problem("This account changed. Reload the account list before saving.",409);
            checked(await db.auth.admin.updateUserById(body.user_id,{email:value.login_name+"@users.atlas.invalid",email_confirm:true,
              app_metadata:{atlas_assignment_request:marker}}));
          }
        } catch(error) {
          // The HTTP response may have been lost after commit. A durable operation
          // record resolves that ambiguity; never compensate with separate writes.
          const saved = await reconcile();
          if (saved) return json(saved);
          if (error.status && error.status < 500) throw error;
          throw problem("The save could not be confirmed. Retry this same form to check its outcome.",503);
        }
        const saved = await reconcile();
        if (!saved) throw problem("The save could not be confirmed. Retry this same form to check its outcome.",503);
        return json(saved);
      }
      if (["password","delete"].includes(action)) {
        await snapshot(db, actor.id);
        const userId = body.user_id;
        if (!uuid(userId)) throw problem("USER_ID_REQUIRED");
        if (action === "delete") {
          if (userId === actor.id) throw problem("CANNOT_DELETE_CURRENT_ACCOUNT",409);
          checked(await db.auth.admin.deleteUser(userId,true));
          return json({message:"The ATLAS account was deleted."});
        }
        const password = String(body.password || "");
        if (password.length < 10) throw problem("PASSWORD_TOO_SHORT");
        checked(await db.auth.admin.updateUserById(userId,{password}));
        return json({message:"The ATLAS password was changed."});
      }
      throw problem("ACCOUNT_ACTION_NOT_SUPPORTED");
    } catch(error) {
      const forbidden = error?.code === "42501";
      const status = forbidden ? 403 : Number(error?.status) || 500;
      // Never forward database/SDK diagnostics, which may contain account details.
      return json({error:forbidden ? "ADMINISTRATOR_REQUIRED" : error instanceof Error && error.status ?
        error.message : "ACCOUNT_REQUEST_FAILED"},status);
    }
  };
}
