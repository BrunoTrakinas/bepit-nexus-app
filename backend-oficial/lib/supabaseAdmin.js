// backend-oficial/lib/supabaseAdmin.js
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, // ⚠️ service role - nunca no frontend
  { auth: { persistSession: false } }
);
export default supabase;