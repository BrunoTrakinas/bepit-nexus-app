// src/lib/api.js
const API = import.meta.env.VITE_API_URL || "https://backend-oficial-5fye.onrender.com"; 
// Em produção, coloque VITE_API_URL=https://seu-back.com no .env do front

export async function chat(regiaoSlug, message, conversationId) {
  const resp = await fetch(`${API}/api/chat/${regiaoSlug}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(conversationId ? { message, conversationId } : { message }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${err}`);
  }
  return resp.json();
}

export async function health() {
  const r = await fetch(`${API}/health`);
  return r.json();
}
