// src/admin/adminApi.js
// ============================================================================
// Camada de chamadas administrativas do frontend (Admin Dashboard)
// - Autenticação por chave: POST /api/auth/login  -> { ok: true } quando válido
// - Armazena a chave no localStorage (chave "adminKey")
// - Todas as chamadas admin enviam o header "X-Admin-Key"
// - Usa baseURL do .env (VITE_API_BASE_URL) quando presente; caso contrário usa
//   caminho relativo (para funcionar com proxy do Netlify /api/*).
// ============================================================================

// ------------------------------- Configuração --------------------------------
const STORAGE_KEY = "adminKey";
const API_BASE = (import.meta?.env?.VITE_API_BASE_URL || "").trim();

/**
 * Concatena a base da API quando definida; senão retorna o path como está.
 * Exemplo:
 * - Com API_BASE = "https://bepit-nexus-backend.onrender.com"
 *   makeUrl("/api/health") -> "https://bepit-nexus-backend.onrender.com/api/health"
 * - Sem API_BASE:
 *   makeUrl("/api/health") -> "/api/health" (usado pelo Netlify proxy)
 */
function makeUrl(path) {
  if (!path || typeof path !== "string") throw new Error("Parâmetro 'path' inválido.");
  if (API_BASE) {
    // Evita double slash ao concatenar
    const base = API_BASE.endsWith("/") ? API_BASE.slice(0, -1) : API_BASE;
    const p = path.startsWith("/") ? path : `/${path}`;
    return `${base}${p}`;
  }
  return path;
}

// ---------------------------- Persistência da chave --------------------------
export function setAdminKey(k) {
  if (typeof k !== "string" || !k.trim()) {
    throw new Error("Chave administrativa inválida.");
  }
  localStorage.setItem(STORAGE_KEY, k.trim());
}

export function getAdminKey() {
  return localStorage.getItem(STORAGE_KEY) || "";
}

export function clearAdminKey() {
  localStorage.removeItem(STORAGE_KEY);
}

// --------------------------------- Auth --------------------------------------
/**
 * Login por chave administrativa (rotina nova do backend)
 * POST /api/auth/login  -> body: { key }
 * Sucesso: { ok: true }
 */
export async function adminLoginByKey(key) {
  const candidate = (key || "").trim();
  if (!candidate) throw new Error("missing_key");

  const res = await fetch(makeUrl("/api/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: candidate }),
    credentials: "include"
  });

  // Trata erro de servidor / rota
  if (!res.ok) {
    let errPayload = null;
    try { errPayload = await res.json(); } catch { /* ignore */ }
    const message = errPayload?.error || `HTTP ${res.status}`;
    throw new Error(message);
  }

  const data = await res.json().catch(() => ({}));
  if (data?.ok === true) {
    setAdminKey(candidate);
    return true;
  }

  throw new Error(data?.error || "invalid_key");
}

// ------------------------------ Helpers HTTP ---------------------------------
async function httpGet(path) {
  const key = getAdminKey();
  const res = await fetch(makeUrl(path), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": key
    },
    credentials: "include"
  });
  if (!res.ok) {
    let errPayload = null;
    try { errPayload = await res.json(); } catch { /* ignore */ }
    const message = errPayload?.error || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return res.json();
}

async function httpPost(path, body) {
  const key = getAdminKey();
  const res = await fetch(makeUrl(path), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": key
    },
    body: JSON.stringify(body || {}),
    credentials: "include"
  });
  if (!res.ok) {
    let errPayload = null;
    try { errPayload = await res.json(); } catch { /* ignore */ }
    const message = errPayload?.error || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return res.json();
}

async function httpPut(path, body) {
  const key = getAdminKey();
  const res = await fetch(makeUrl(path), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": key
    },
    body: JSON.stringify(body || {}),
    credentials: "include"
  });
  if (!res.ok) {
    let errPayload = null;
    try { errPayload = await res.json(); } catch { /* ignore */ }
    const message = errPayload?.error || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return res.json();
}

// ----------------------- Funções genéricas (export) --------------------------
/**
 * Mantém as assinaturas usadas no AdminDashboard:
 *  - adminGet(path)
 *  - adminPost(path, body)
 *  - adminPut(path, body)
 * Essas funções aceitam paths como "/api/admin/..." e delegam para o backend.
 * O header X-Admin-Key é injetado automaticamente.
 */
export async function adminGet(path) {
  return httpGet(path);
}

export async function adminPost(path, body) {
  return httpPost(path, body);
}

export async function adminPut(path, body) {
  return httpPut(path, body);
}

// ---------------------- Atalhos específicos (opcional) -----------------------
// Estes utilitários podem ser usados se quiser padronizar do lado do painel.
// Não são obrigatórios; o AdminDashboard já trabalha com adminGet/Post/Put.

export async function adminListarParceiros(regiaoSlug, cidadeSlug) {
  if (!regiaoSlug || !cidadeSlug) throw new Error("Parâmetros 'regiaoSlug' e 'cidadeSlug' são obrigatórios.");
  const path = `/api/admin/parceiros/${encodeURIComponent(regiaoSlug)}/${encodeURIComponent(cidadeSlug)}`;
  return httpGet(path);
}

export async function adminCriarParceiro(payload) {
  return httpPost("/api/admin/parceiros", payload);
}

export async function adminAtualizarParceiro(id, payload) {
  if (!id) throw new Error("Parâmetro 'id' é obrigatório.");
  return httpPut(`/api/admin/parceiros/${encodeURIComponent(String(id))}`, payload);
}

export async function adminCriarRegiao(payload) {
  return httpPost("/api/admin/regioes", payload);
}

export async function adminCriarCidade(payload) {
  return httpPost("/api/admin/cidades", payload);
}

export async function adminMetricsSummary(params = {}) {
  const usp = new URLSearchParams();
  if (params.regiaoSlug) usp.set("regiaoSlug", params.regiaoSlug);
  if (params.cidadeSlug) usp.set("cidadeSlug", params.cidadeSlug);
  const qs = usp.toString() ? `?${usp.toString()}` : "";
  return httpGet(`/api/admin/metrics/summary${qs}`);
}

export async function adminLogs(params = {}) {
  const usp = new URLSearchParams();
  if (params.tipo) usp.set("tipo", params.tipo);
  if (params.regiaoSlug) usp.set("regiaoSlug", params.regiaoSlug);
  if (params.cidadeSlug) usp.set("cidadeSlug", params.cidadeSlug);
  if (params.parceiroId) usp.set("parceiroId", params.parceiroId);
  if (params.conversationId) usp.set("conversationId", params.conversationId);
  if (params.since) usp.set("since", params.since);
  if (params.until) usp.set("until", params.until);
  if (Number.isFinite(params.limit)) usp.set("limit", String(params.limit));
  const qs = usp.toString() ? `?${usp.toString()}` : "";
  return httpGet(`/api/admin/logs${qs}`);
}
