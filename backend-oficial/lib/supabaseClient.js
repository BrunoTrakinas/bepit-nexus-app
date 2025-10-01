// backend-oficial/lib/supabaseClient.js
// Cliente Supabase para uso no BACKEND (Node.js)
// - Prioriza a Service Role Key (SUPABASE_SERVICE_ROLE ou SUPABASE_SERVICE_KEY)
// - Permite fallback controlado para Anon Key SOMENTE se ALLOW_ANON_BACKEND=1
// - Não persiste sessão (server side)

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();

// Tente ler a Service Role Key em nomes comuns
const SERVICE_KEY =
  (process.env.SUPABASE_SERVICE_ROLE || "").trim() ||
  (process.env.SUPABASE_SERVICE_KEY || "").trim();

// (Opcional) Fallback com anon key (NÃO recomendado em produção)
const ALLOW_ANON_BACKEND = process.env.ALLOW_ANON_BACKEND === "1";
const ANON_KEY = (process.env.SUPABASE_ANON_KEY || "").trim();

if (!SUPABASE_URL) {
  throw new Error("[Supabase] SUPABASE_URL não definido no ambiente.");
}

let SUPABASE_KEY_IN_USE = null;
let MODE = null;

if (SERVICE_KEY) {
  SUPABASE_KEY_IN_USE = SERVICE_KEY;
  MODE = "service_role";
  console.log("[Supabase] Usando Service Role Key.");
} else if (ALLOW_ANON_BACKEND && ANON_KEY) {
  SUPABASE_KEY_IN_USE = ANON_KEY;
  MODE = "anon_fallback";
  console.warn(
    "[Supabase] ALLOW_ANON_BACKEND=1 — usando ANON KEY no backend (apenas para testes; não recomendado em produção)."
  );
} else {
  // Sem service key e sem fallback permitido → erro explícito
  throw new Error(
    "[Supabase] SUPABASE_SERVICE_ROLE/SUPABASE_SERVICE_KEY não definido no ambiente (evite usar a anon key no backend)."
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY_IN_USE, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  global: {
    headers: {
      "X-Client-Info": `bepit-backend/3.3 (${MODE})`,
    },
  },
});
