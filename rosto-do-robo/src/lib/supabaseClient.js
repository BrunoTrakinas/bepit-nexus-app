// src/lib/supabaseClient.js
import { createClient } from "@supabase/supabase-js";

// ⚠️ Estas variáveis vêm do Vite (defina no Netlify e no .env.local)
// VITE_SUPABASE_URL=https://xxxx.supabase.co
// VITE_SUPABASE_ANON_KEY=eyJhbGciOiJI...

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Ajuda no debug em dev; não quebra produção
  console.warn(
    "[Supabase Frontend] VITE_SUPABASE_URL e/ou VITE_SUPABASE_ANON_KEY não estão definidas."
  );
}

// Cliente PÚBLICO (NUNCA use chave service_role no frontend)
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true, // mantém sessão do usuário (se você usar Auth)
    autoRefreshToken: true
  }
});