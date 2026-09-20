import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { createHandler } from "./handler.mjs";

// Same server-side getUser verification and trusted-role authorization as v21.
const service = () => createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
Deno.serve(createHandler(service));
