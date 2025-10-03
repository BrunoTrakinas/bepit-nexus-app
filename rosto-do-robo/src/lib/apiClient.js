// src/lib/apiClient.js
// ============================================================================
// Camada de chamadas HTTP do frontend (Chat + Itinerário + Admin)
// - Mantém TODAS as rotas Admin que você já usava (login, parceiros, regiões,
//   cidades, métricas, logs), incluindo o header "X-Admin-Key" quando necessário.
// - Mantém o chat e feedback.
// - Adiciona a função gerarItinerario para o endpoint /api/itinerario/:slugDaRegiao.
// - Usa VITE_API_BASE_URL quando existir; caso contrário usa "/" para proxy /api/*.
// ============================================================================

import axios from "axios";

/**
 * Estratégia:
 * - Se VITE_API_BASE_URL estiver definida, usamos ela (ex.: https://bepit-nexus-backend.onrender.com).
 * - Caso contrário, caímos para '/' para usar redirects/proxy do Netlify.
 * - Todos os endpoints começam com "/api", então o baseURL deve ser "" (barra) ou o domínio do backend.
 */
const RAW_BASE = (import.meta.env?.VITE_API_BASE_URL || "/").trim();

// Remove barra final para evitar //api
const baseURLDaApi = RAW_BASE.endsWith("/") ? RAW_BASE.slice(0, -1) : RAW_BASE;

// Instância Axios
const clienteAxios = axios.create({
  baseURL: baseURLDaApi,
  withCredentials: false,
  headers: { "Content-Type": "application/json" },
  // timeout aumentado para reduzir falsos timeouts em respostas mais longas (Gemini)
  timeout: 60000
});

// --------------------------- Helpers HTTP -----------------------------------
async function httpGet(url, config = {}) {
  try {
    const resp = await clienteAxios.get(url, config);
    return resp.data;
  } catch (e) {
    const msg =
      e?.response?.data?.error ||
      e?.response?.data?.message ||
      e?.message ||
      "Erro de rede";
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
    const msg =
      e?.response?.data?.error ||
      e?.response?.data?.message ||
      e?.message ||
      "Erro de rede";
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
    const msg =
      e?.response?.data?.error ||
      e?.response?.data?.message ||
      e?.message ||
      "Erro de rede";
    const err = new Error(msg);
    err.status = e?.response?.status;
    err.data = e?.response?.data;
    throw err;
  }
}

// --------------------------- API de alto nível -------------------------------

const apiClient = {
  // ---------------- Chat e Feedback ----------------
  /**
   * Envia mensagem para o chat do BEPIT.
   * Rota backend: POST /api/chat/:slugDaRegiao
   * Body: { message: string, conversationId?: string }
   */
  enviarMensagemParaChat: (slugDaRegiao, corpo) =>
    httpPost(`/api/chat/${encodeURIComponent(slugDaRegiao)}`, corpo),

  /**
   * Envia feedback de uma interação.
   * Rota backend: POST /api/feedback
   * Body: { interactionId: string, feedback: string }
   */
  enviarFeedbackDaInteracao: (corpo) => httpPost("/api/feedback", corpo),

  /**
   * Gera roteiro (itinerário) entre datas (seu backend já possui ou adicionaremos).
   * Rota backend: POST /api/itinerario/:slugDaRegiao
   * Body: { inicio: "10/12" | "2025-12-10", fim: "15/12" | "2025-12-15", cidadeSlug?: "cabo-frio" }
   */
  gerarItinerario: (slugDaRegiao, corpo) =>
    httpPost(`/api/itinerario/${encodeURIComponent(slugDaRegiao)}`, corpo),

  // ---------------- Admin - Autenticação ----------------
  /**
   * Login por chave administrativa (X-Admin-Key).
   * Rota backend: POST /api/auth/login
   * Body: { key }
   * Retorno esperado: { ok: true } quando válido.
   */
  authLoginByKey: (key) => httpPost("/api/auth/login", { key }),

  // ---------------- Admin - Parceiros ----------------
  /**
   * Cria parceiro/dica.
   * Header: { "X-Admin-Key": adminKey }
   * Rota backend: POST /api/admin/parceiros
   */
  adminCriarParceiro: (corpo, adminKey) =>
    httpPost("/api/admin/parceiros", corpo, {
      headers: { "X-Admin-Key": adminKey }
    }),

  /**
   * Lista parceiros/dicas por região e cidade.
   * Header: { "X-Admin-Key": adminKey }
   * Rota backend: GET /api/admin/parceiros/:regiaoSlug/:cidadeSlug
   */
  adminListarParceiros: (regiaoSlug, cidadeSlug, adminKey) =>
    httpGet(
      `/api/admin/parceiros/${encodeURIComponent(regiaoSlug)}/${encodeURIComponent(
        cidadeSlug
      )}`,
      { headers: { "X-Admin-Key": adminKey } }
    ),

  /**
   * Atualiza parceiro/dica por ID.
   * Header: { "X-Admin-Key": adminKey }
   * Rota backend: PUT /api/admin/parceiros/:id
   */
  adminAtualizarParceiro: (id, corpo, adminKey) =>
    httpPut(`/api/admin/parceiros/${encodeURIComponent(id)}`, corpo, {
      headers: { "X-Admin-Key": adminKey }
    }),

  // ---------------- Admin - Regiões e Cidades ----------------
  /**
   * Cria região (nome, slug, ativo?).
   * Header: { "X-Admin-Key": adminKey }
   * Rota backend: POST /api/admin/regioes
   */
  adminCriarRegiao: (corpo, adminKey) =>
    httpPost("/api/admin/regioes", corpo, {
      headers: { "X-Admin-Key": adminKey }
    }),

  /**
   * Cria cidade (regiaoSlug, nome, slug, ativo?, lat?, lng?).
   * Header: { "X-Admin-Key": adminKey }
   * Rota backend: POST /api/admin/cidades
   */
  adminCriarCidade: (corpo, adminKey) =>
    httpPost("/api/admin/cidades", corpo, {
      headers: { "X-Admin-Key": adminKey }
    }),

  // ---------------- Admin - Métricas e Logs ----------------
  /**
   * Resumo de métricas.
   * Header: { "X-Admin-Key": adminKey }
   * Rota backend: GET /api/admin/metrics/summary
   * Query: { regiaoSlug, cidadeSlug? }
   */
  adminMetricsSummary: (params, adminKey) =>
    httpGet("/api/admin/metrics/summary", {
      params,
      headers: { "X-Admin-Key": adminKey }
    }),

  /**
   * Logs (eventos_analytics).
   * Header: { "X-Admin-Key": adminKey }
   * Rota backend: GET /api/admin/logs
   * Query: { tipo?, regiaoSlug?, cidadeSlug?, parceiroId?, conversationId?, since?, until?, limit? }
   */
  adminLogs: (params, adminKey) =>
    httpGet("/api/admin/logs", {
      params,
      headers: { "X-Admin-Key": adminKey }
    })
};

export default apiClient;
