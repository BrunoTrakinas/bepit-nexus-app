// /frontend/src/services/api.parceiro.js
export async function listarMidias(id){
  const r = await fetch(`/api/uploads/partner/${id}/list`);
  const j = await r.json();
  return j.data;
}

export async function removerMidia(id, storageKey){
  const r = await fetch(`/api/uploads/partner/${id}/remove`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storageKey })
  });
  const j = await r.json();
  return j.data;
}

