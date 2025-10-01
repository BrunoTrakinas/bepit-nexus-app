// ============================================================================
// Supabase Client (backend)
// - Usa SEMPRE a Service Role Key (chave secreta do servidor).
// - NUNCA use a anon key no backend (risco de permissão e RLS).
// - Aceita vários nomes de env para a Service Role por conveniência.
// ============================================================================

import { createClient } from "@supabase/supabase-js";

// URL do seu projeto Supabase (ex.: https://abcdefg.supabase.co)
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();

// Procuramos a Service Role Key em várias chaves de ambiente comuns:
const SUPABASE_SERVICE_KEY =
  (process.env.SUPABASE_SERVICE_ROLE || "").trim() ||
  (process.env.SUPABASE_SERVICE_KEY || "").trim() ||
  (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim() ||
  (process.env.SUPABASE_SERVICE || "").trim();

// Se quiser DESENVOLVER localmente usando anon key temporariamente,
// descomente o bloco abaixo e defina ALLOW_ANON_ON_BACKEND=1 (NÃO use em produção).
// const ALLOW_ANON_ON_BACKEND = process.env.ALLOW_ANON_ON_BACKEND === "1";
// if (!SUPABASE_SERVICE_KEY && ALLOW_ANON_ON_BACKEND) {
//   console.warn("[Supabase] ATENÇÃO: usando VITE_SUPABASE_ANON_KEY no BACKEND (somente dev).");
//   // Em dev local, o Vite costuma expor essa env (não use isso no Render).
//   const maybeAnon = (process.env.VITE_SUPABASE_ANON_KEY || "").trim();
//   if (maybeAnon) {
//     process.env.__USING_ANON_ON_BACKEND = "1";
//   }
// }

if (!SUPABASE_URL) {
  throw new Error("[Supabase] SUPABASE_URL não definido no ambiente.");
}

if (!SUPABASE_SERVICE_KEY) {
  // Erro proposital para te forçar a configurar a Service Role no Render
  throw new Error(
    "[Supabase] SUPABASE_SERVICE_ROLE/SUPABASE_SERVICE_KEY não definido no ambiente (evite usar a anon key no backend)."
  );
}

// Cria o client com a Service Role Key
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false
  },
  global: {
    headers: {
      "X-Client-Info": "bepit-backend/3.3.1"
    }
  }
});

// (Opcional) Helper para testar a conexão diretamente
export async function pingDb() {
  const { data, error } = await supabase.from("regioes").select("id").limit(1);
  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
}
