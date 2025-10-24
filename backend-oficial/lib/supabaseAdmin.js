// Admin client do Supabase para o backend (usa SERVICE_ROLE)
// Caminho: server/lib/supabaseAdmin.js

import { createClient } from "@supabase/supabase-js";

// (Opcional) Polyfill para Node < 18; em Node 20/22 não é necessário.
if (typeof fetch !== "function") {
  globalThis.fetch = (...args) =>
    import("node-fetch").then(({ default: f }) => f(...args));
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "[supabaseAdmin] Faltam variáveis SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY."
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
