// /frontend/src/services/api.rag.js
export async function ragIndex(partnerId, chunks) {
  const r = await fetch(`/api/rag/index/${encodeURIComponent(partnerId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chunks })
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "Falha ao indexar (RAG)");
  return j.data;
}

export async function ragSearch({ query, partnerId = null, k = 6 }) {
  const r = await fetch(`/api/rag/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, partnerId, k })
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "Falha na busca (RAG)");
  return j.data; // array de { id, partner_id, chunk, similarity }
}
