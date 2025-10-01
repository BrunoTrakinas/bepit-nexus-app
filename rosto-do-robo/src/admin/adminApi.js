import apiClient from "../lib/apiClient";

// Chave guardada localmente
const STORAGE_KEY = "adminKey";

export function setAdminKey(k) {
  localStorage.setItem(STORAGE_KEY, k);
}

export function getAdminKey() {
  return localStorage.getItem(STORAGE_KEY) || "";
}

export function clearAdminKey() {
  localStorage.removeItem(STORAGE_KEY);
}

// Autenticação por chave (nova rota)
export async function adminLoginByKey(key) {
  const resp = await apiClient.authLoginByKey(key).catch((e) => {
    const msg = e?.response?.data?.error || e.message;
    throw new Error(msg);
  });
  if (resp?.data?.ok) {
    setAdminKey(key);
    return true;
  }
  throw new Error("invalid_key");
}

// Rotas administrativas (usam header X-Admin-Key)
export async function adminGet(path) {
  const key = getAdminKey();
  const resp = await apiClient.adminLogs({}, key).catch(() => null); // apenas para validar key? não — manter genérico abaixo
  // Implementação genérica:
  const url = path;
  const res = await fetch(url, {
    method: "GET",
    headers: { "X-Admin-Key": key },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Versões específicas usando apiClient (preferíveis)
export async function adminPost(path, body) {
  const key = getAdminKey();
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": key },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function adminPut(path, body) {
  const key = getAdminKey();
  const res = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Admin-Key": key },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || `HTTP ${res.status}`);
  }
  return res.json();
}
