// rosto-do-robo/src/lib/apiClient.js
import axios from "axios";

/**
 * Estratégia:
 * - Se VITE_API_BASE_URL estiver definida, usamos ela (ex.: https://bepit-nexus-backend.onrender.com).
 * - Caso contrário, caímos para '/' para usar redirects do Netlify.
 * - Todos os endpoints começam com "/api", então o baseURL deve ser "" (barra) ou o domínio do backend.
 */
const RAW_BASE = (import.meta.env?.VITE_API_BASE_URL || "/").trim();

// Remove barra final para evitar //api
const baseURLDaApi = RAW_BASE.endsWith("/") ? RAW_BASE.slice(0, -1) : RAW_BASE;

// Cria instância
const clienteAxios = axios.create({
  baseURL: baseURLDaApi,
  withCredentials: false,
  headers: { "Content-Type": "application/json" }
});

// Helpers de chamada HTTP com tratamento de erro consistente
async function httpGet(url, config = {}) {
  try {
    const resp = await clienteAxios.get(url, config);
    return resp.data;
  } catch (e) {
    // Preserva mensagem de backend se existir
    const msg = e?.response?.data?.error || e?.response?.data?.message || e?.message || "Erro de rede";
    const err = new Error(msg);
    err.status = e?.response?.status;
    err.data = e?.response?.data;
    throw err;
  }
}

async function httpPost(url, body = {}, config = {}) {
  try {
    const resp = await clienteAxios.post(url, body, config);
    return resp.data;
  } catch (e) {
    const msg = e?.response?.data?.error || e?.response?.data?.message || e?.message || "Erro de rede";
    const err = new Error(msg);
    err.status = e?.response?.status;
    err.data = e?.response?.data;
    throw err;
  }
}

async function httpPut(url, body = {}, config = {}) {
  try {
    const resp = await clienteAxios.put(url, body, config);
    return resp.data;
  } catch (e) {
    const msg = e?.response?.data?.error || e?.response?.data?.message || e?.message || "Erro de rede";
    const err = new Error(msg);
    err.status = e?.response?.status;
    err.data = e?.response?.data;
    throw err;
  }
}

// API de alto nível usada pelo app
const apiClient = {
  // Chat
  enviarMensagemParaChat: (slugDaRegiao, corpo) =>
    httpPost(`/api/chat/${encodeURIComponent(slugDaRegiao)}`, corpo),

  enviarFeedbackDaInteracao: (corpo) => httpPost("/api/feedback", corpo),

  // Admin - login por chave (X-Admin-Key)
  authLoginByKey: (key) => httpPost("/api/auth/login", { key }),

  // Admin (com header X-Admin-Key)
  adminCriarParceiro: (corpo, adminKey) =>
    httpPost("/api/admin/parceiros", corpo, { headers: { "X-Admin-Key": adminKey } }),

  adminListarParceiros: (regiaoSlug, cidadeSlug, adminKey) =>
    httpGet(`/api/admin/parceiros/${encodeURIComponent(regiaoSlug)}/${encodeURIComponent(cidadeSlug)}`, {
      headers: { "X-Admin-Key": adminKey }
    }),

  adminAtualizarParceiro: (id, corpo, adminKey) =>
    httpPut(`/api/admin/parceiros/${encodeURIComponent(id)}`, corpo, {
      headers: { "X-Admin-Key": adminKey }
    }),

  adminCriarRegiao: (corpo, adminKey) =>
    httpPost("/api/admin/regioes", corpo, { headers: { "X-Admin-Key": adminKey } }),

  adminCriarCidade: (corpo, adminKey) =>
    httpPost("/api/admin/cidades", corpo, { headers: { "X-Admin-Key": adminKey } }),

  adminMetricsSummary: (params, adminKey) =>
    httpGet("/api/admin/metrics/summary", { params, headers: { "X-Admin-Key": adminKey } }),

  adminLogs: (params, adminKey) =>
    httpGet("/api/admin/logs", { params, headers: { "X-Admin-Key": adminKey } })
};

export default apiClient;
