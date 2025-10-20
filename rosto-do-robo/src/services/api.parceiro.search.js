// /frontend/src/services/api.parceiro.search.js
export async function searchParceiros(q, limit = 3){
  const p = new URLSearchParams();
  p.set("q", q);
  p.set("limit", String(limit));
  const r = await fetch(`/api/parceiro/search?` + p.toString());
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "Falha na busca de parceiros");
  return Array.isArray(j.data) ? j.data : [];
}
