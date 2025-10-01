// backend-oficial/lib/supabaseClient.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.SUPABASE_URL && process.env.SUPABASE_URL.trim();
const SUPABASE_SERVICE_KEY =
  (process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE || "").trim();

if (!SUPABASE_URL) {
  throw new Error("[Supabase] SUPABASE_URL não definido no ambiente.");
}
if (!SUPABASE_SERVICE_KEY) {
  throw new Error("[Supabase] SUPABASE_SERVICE_ROLE/SUPABASE_SERVICE_KEY não definido no ambiente (evite usar a anon key no backend).");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  },
  global: {
    headers: { "x-application-name": "bepit-nexus-backend" }
  }
});
