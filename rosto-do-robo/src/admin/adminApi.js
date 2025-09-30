// Base de API: VITE_API_BASE (se setada) OU /api (proxy do Netlify)
const BASE = import.meta.env.VITE_API_BASE || "/api";

export function setAdminKey(key) {
  if (key) localStorage.setItem("adminKey", key);
  else localStorage.removeItem("adminKey");
}

function getAdminHeaders() {
  const key = localStorage.getItem("adminKey") || "";
  return {
    "Content-Type": "application/json",
    "x-admin-key": key,
  };
}

export async function adminGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    method: "GET",
    headers: getAdminHeaders(),
    credentials: "omit",
  });
  if (!res.ok) {
    const err = await safeJson(res);
    throw new Error(err?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function adminPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: getAdminHeaders(),
    body: JSON.stringify(body || {}),
    credentials: "omit",
  });
  if (!res.ok) {
    const err = await safeJson(res);
    throw new Error(err?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}