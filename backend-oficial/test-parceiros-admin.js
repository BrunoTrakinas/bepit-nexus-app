import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,   // service role
  { auth: { persistSession: false } }
);

async function main() {
  console.log('[test] iniciando leitura de parceiros com service role...');
  const { data, error } = await supabase
    .from('parceiros')
    .select('id, nome, categoria, ativo')
    .limit(5);

  console.log('[test] resultado:', {
    len: data?.length || 0,
    error: error?.message || null
  });

  if (data?.length) {
    data.forEach((r, i) => console.log(`${i+1}. ${r.nome} (${r.categoria}) ativo=${r.ativo}`));
  }
}
main().catch(console.error);
