import { authenticated, cors, fail, hasRole, json, service } from "../_shared/coc.ts";

const INTERNAL_DOMAIN = "users.atlas.invalid";
const clean = (value: unknown, maximum = 120) => String(value ?? "").trim().slice(0, maximum);
const normalizeLoginName = (value: unknown) => clean(value, 80)
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9._-]+/g, "")
  .slice(0, 48);
const internalEmail = (loginName: unknown) => {
  const normalized = normalizeLoginName(loginName);
  if (normalized.length < 2) throw Object.assign(new Error("Enter at least two letters for the employee name."), { status: 400 });
  return `${normalized}@${INTERNAL_DOMAIN}`;
};
const allowedRole = (value: unknown) => {
  const role = clean(value, 40).toLowerCase();
  if (!["picker", "office_receiver", "supervisor", "admin"].includes(role)) {
    throw Object.assign(new Error("ATLAS_ROLE_INVALID"), { status: 400 });
  }
  return role;
};
const safeProfileUpsert = async (db: ReturnType<typeof service>, userId: string, displayName: string, role: string) => {
  const profileRole = role === "office_receiver" ? "picker" : role;
  const result = await db.from("profiles").upsert({ user_id: userId, display_name: displayName, role: profileRole }, { onConflict: "user_id" });
  if (result.error) throw result.error;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const actor = await authenticated(req);
    if (!hasRole(actor, ["admin", "administrator"])) {
      throw Object.assign(new Error("ADMINISTRATOR_REQUIRED"), { status: 403 });
    }
    const body = await req.json();
    const action = clean(body.action, 40).toLowerCase();
    const db = service();

    if (action === "list") {
      const [{ data: authData, error: authError }, { data: profiles, error: profileError }] = await Promise.all([
        db.auth.admin.listUsers({ page: 1, perPage: 1000 }),
        db.from("profiles").select("user_id,display_name,role"),
      ]);
      if (authError) throw authError;
      if (profileError) throw profileError;
      const profileById = new Map((profiles || []).map((profile: any) => [profile.user_id, profile]));
      const users = (authData.users || []).map((user: any) => {
        const profile: any = profileById.get(user.id) || {};
        const loginName = clean(user.app_metadata?.login_name || String(user.email || "").split("@")[0], 48);
        return {
          id: user.id,
          display_name: profile.display_name || user.user_metadata?.display_name || loginName,
          login_name: loginName,
          role: user.app_metadata?.atlas_role || user.app_metadata?.role || profile.role || "picker",
          active: !user.banned_until || new Date(user.banned_until).valueOf() <= Date.now(),
          last_sign_in_at: user.last_sign_in_at,
          created_at: user.created_at,
          is_current: user.id === actor.id,
        };
      });
      return json({ users });
    }

    if (action === "create") {
      const displayName = clean(body.display_name, 60);
      const loginName = normalizeLoginName(body.login_name || displayName);
      const password = String(body.password || "");
      const role = allowedRole(body.role);
      if (!displayName) throw Object.assign(new Error("DISPLAY_NAME_REQUIRED"), { status: 400 });
      if (password.length < 10) throw Object.assign(new Error("PASSWORD_TOO_SHORT"), { status: 400 });
      const email = internalEmail(loginName);
      const { data, error } = await db.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { role, atlas_role: role, login_name: loginName },
        user_metadata: { display_name: displayName },
      });
      if (error) {
        if (/already|registered|exists/i.test(error.message)) throw Object.assign(new Error("That employee name is already in use. Add a last initial."), { status: 409 });
        throw error;
      }
      try { await safeProfileUpsert(db, data.user.id, displayName, role); }
      catch (error) { await db.auth.admin.deleteUser(data.user.id); throw error; }
      return json({ message: `${displayName}'s ATLAS account was created.`, user_id: data.user.id, login_name: loginName });
    }

    if (["update", "password", "delete"].includes(action)) {
      const userId = clean(body.user_id, 80);
      if (!userId) throw Object.assign(new Error("USER_ID_REQUIRED"), { status: 400 });
      if (action === "delete") {
        if (userId === actor.id) throw Object.assign(new Error("CANNOT_DELETE_CURRENT_ACCOUNT"), { status: 409 });
        const { error } = await db.auth.admin.deleteUser(userId);
        if (error) throw error;
        return json({ message: "The ATLAS account was deleted." });
      }
      if (action === "password") {
        const password = String(body.password || "");
        if (password.length < 10) throw Object.assign(new Error("PASSWORD_TOO_SHORT"), { status: 400 });
        const { error } = await db.auth.admin.updateUserById(userId, { password });
        if (error) throw error;
        return json({ message: "The ATLAS password was changed." });
      }

      const { data: current, error: currentError } = await db.auth.admin.getUserById(userId);
      if (currentError || !current.user) throw currentError || new Error("ACCOUNT_NOT_FOUND");
      const displayName = clean(body.display_name, 60);
      const loginName = normalizeLoginName(body.login_name || displayName);
      const role = allowedRole(body.role);
      if (!displayName) throw Object.assign(new Error("DISPLAY_NAME_REQUIRED"), { status: 400 });
      const { error } = await db.auth.admin.updateUserById(userId, {
        email: internalEmail(loginName),
        email_confirm: true,
        app_metadata: { ...(current.user.app_metadata || {}), role, atlas_role: role, login_name: loginName },
        user_metadata: { ...(current.user.user_metadata || {}), display_name: displayName },
      });
      if (error) {
        if (/already|registered|exists/i.test(error.message)) throw Object.assign(new Error("That employee name is already in use. Add a last initial."), { status: 409 });
        throw error;
      }
      await safeProfileUpsert(db, userId, displayName, role);
      const ownAccount = userId === actor.id;
      return json({
        message: ownAccount
          ? `${displayName}'s ATLAS access was updated. Sign out once, then sign in with ${loginName}.`
          : `${displayName}'s ATLAS access was updated. Their sign-in name is ${loginName}.`,
        login_name: loginName,
        requires_reauthentication: ownAccount,
      });
    }

    throw Object.assign(new Error("ACCOUNT_ACTION_NOT_SUPPORTED"), { status: 400 });
  } catch (error) {
    return fail(error);
  }
});
