// /scripts/embeddings/refreshPartners.ts
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function embed(text: string): Promise<number[]> {
  const resp = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedText?key=" +
      process.env.GEMINI_API_KEY,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-004", input: text }),
    }
  );
  if (!resp.ok) throw new Error(`Embedding error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const vector = data?.embedding?.value || data?.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error("Invalid embedding payload");
  return vector;
}

async function run() {
  // Busca parceiros sem embedding, já trazendo nome da cidade via view ou join RPC
  // Para manter fácil, uso uma RPC simples (ver SQL da seção 4.6) ou faça duas queries:
  const { data: rows, error } = await supabase
    .from("parceiros_view_com_cidade") // criada na seção 4.6
    .select("id,nome,descricao,categoria,cidade_nome,embedding")
    .is("embedding", null)
    .limit(1000);

  if (error) throw error;

  for (const p of rows ?? []) {
    const text = [p.nome, p.descricao, p.categoria, p.cidade_nome].filter(Boolean).join(" | ");
    const vec = await embed(text);
    const { error: upErr } = await supabase
      .from("parceiros")
      .update({ embedding: vec })
      .eq("id", p.id);
    if (upErr) throw upErr;
    console.log(`Embedded parceiro ${p.id} - ${p.nome}`);
  }
  console.log("Embedding refresh done.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
