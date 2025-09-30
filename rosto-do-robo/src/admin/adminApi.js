// rosto-do-robo/src/admin/adminApi.js

// Base da API: se VITE_API_BASE_URL não estiver setado, usamos caminho relativo
const BASE = import.meta.env.VITE_API_BASE_URL ? String(import.meta.env.VITE_API_BASE_URL) : "";

const ADMIN_KEY_STORAGE = "adminKey";

// Helpers de chave
export function setAdminKey(key) {
  try {
    if (key) localStorage.setItem(ADMIN_KEY_STORAGE, key);
  } catch (_) {}
}

export function getAdminKey() {
  try {
    return localStorage.getItem(ADMIN_KEY_STORAGE) || "";
  } catch (_) {
    return "";
  }
}

export function clearAdminKey() {
  try {
    localStorage.removeItem(ADMIN_KEY_STORAGE);
  } catch (_) {}
}

// Requisição base
async function req(method, path, { body, params } = {}) {
  const url = new URL((BASE || "") + path, window.location.origin);
  if (params && typeof params === "object") {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
  }

  const headers = { "Content-Type": "application/json" };
  const adminKey = getAdminKey();
  if (adminKey) headers["X-Admin-Key"] = adminKey;

  const resp = await fetch(url.toString().replace(url.origin, ""), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  // tenta parsear json sempre
  const maybeJson = await resp.json().catch(() => null);

  if (!resp.ok) {
    const msg = (maybeJson && (maybeJson.error || maybeJson.message)) || `HTTP ${resp.status}`;
    throw new Error(msg);
  }

  return maybeJson;
}

// Exports REST
export function adminGet(path, params) {
  return req("GET", path, { params });
}
export function adminPost(path, body) {
  return req("POST", path, { body });
}
export function adminPut(path, body) {
  return req("PUT", path, { body });
}

// Login por CHAVE (novo fluxo)
// - chama /api/auth/login com { key }
// - se ok, persiste em localStorage e retorna { ok: true }
export async function adminLoginWithKey(key) {
  const res = await req("POST", "/api/auth/login", { body: { key } });
  if (res && res.ok) {
    setAdminKey(key);
    return { ok: true };
  }
  throw new Error(res?.error || "Falha ao logar");
}
