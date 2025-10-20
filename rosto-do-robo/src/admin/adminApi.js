// src/admin/adminApi.js
// ============================================================================
// Camada de acesso ao backend administrativo do BEPIT (versão estendida)
// - Compatível com o dashboard atualizado e com possíveis chamadas antigas
// - Todos os métodos retornam { ok: boolean, data?, error?, status? }
// - Inclui CRUD de Regiões, Cidades, Parceiros, Dicas, Avisos, Métricas e Logs
// - Possui utilitários e "aliases" para manter compatibilidade de nomes
// ============================================================================

/** Base da API (pode vir do .env do front: VITE_API_BASE) */
const API_BASE = import.meta?.env?.VITE_API_BASE || "";

/** Lê a X-Admin-Key (salva pelo login) */
function getAdminKey() {
  return (
    sessionStorage.getItem("adminKey") ||
    localStorage.getItem("adminKey") ||
    ""
  );
}

/** Normaliza erro em string amigável */
function normalizeError(resp, payload) {
  if (!resp) return "Falha de rede";
  const text =
    payload?.error ||
    payload?.message ||
    (typeof payload === "string" ? payload : null) ||
    `${resp.status} ${resp.statusText}`;
  return text;
}

/** Chamada genérica */
async function apiFetch(method, path, body) {
  const url = `${API_BASE}${path}`;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "X-Admin-Key": getAdminKey(),
  };

  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const isJson = (resp.headers.get("content-type") || "").includes(
      "application/json"
    );
    const payload = isJson ? await resp.json().catch(() => null) : null;

    if (!resp.ok) {
      return { ok: false, error: normalizeError(resp, payload), status: resp.status };
    }
    return { ok: true, data: payload };
  } catch (e) {
    return { ok: false, error: e?.message || "Falha de rede" };
  }
}

// ============================================================================
// Regiões
// ============================================================================
export async function getRegioes({ q, limit = 200 } = {}) {
  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (limit) qs.set("limit", String(limit));
  return apiFetch("GET", `/api/admin/regioes?${qs.toString()}`);
}
export async function createRegiao({ nome }) {
  return apiFetch("POST", "/api/admin/regioes", { nome });
}
export async function updateRegiao(id, { nome }) {
  return apiFetch("PATCH", `/api/admin/regioes/${id}`, { nome });
}
export async function deleteRegiao(id) {
  return apiFetch("DELETE", `/api/admin/regioes/${id}`);
}

// ============================================================================
// Cidades
// ============================================================================
export async function getCidades({ regiaoId, q, limit = 500 } = {}) {
  const qs = new URLSearchParams();
  if (regiaoId) qs.set("regiaoId", regiaoId);
  if (q) qs.set("q", q);
  if (limit) qs.set("limit", String(limit));
  return apiFetch("GET", `/api/admin/cidades?${qs.toString()}`);
}
export async function createCidade({ nome, regiaoId }) {
  return apiFetch("POST", "/api/admin/cidades", { nome, regiaoId });
}
export async function updateCidade(id, { nome, regiaoId }) {
  return apiFetch("PATCH", `/api/admin/cidades/${id}`, { nome, regiaoId });
}
export async function deleteCidade(id) {
  return apiFetch("DELETE", `/api/admin/cidades/${id}`);
}

// ============================================================================
// Parceiros
// ============================================================================
export async function getParceiros({ nome, cidadeId, page = 1, limit = 50 } = {}) {
  const qs = new URLSearchParams();
  if (nome) qs.set("nome", nome);
  if (cidadeId) qs.set("cidadeId", cidadeId);
  if (page) qs.set("page", String(page));
  if (limit) qs.set("limit", String(limit));
  return apiFetch("GET", `/api/admin/parceiros?${qs.toString()}`);
}
export async function getParceiroById(id) {
  return apiFetch("GET", `/api/admin/parceiros/${id}`);
}
export async function createParceiro(input) {
  // Campos leigos na UI → API espera colunas equivalentes
  const body = {
    nome: input.nome,
    cidadeId: input.cidadeId,
    logradouro: input.logradouro,
    numero: input.numero,
    bairro: input.bairro || null,
    cep: input.cep || null,
    descricao: input.descricao || null,
    categoria: input.categoria || null,
    referencias: input.referencias || null, // string solta
    contato: input.contato || null,         // telefone/site
  };
  return apiFetch("POST", "/api/admin/parceiros", body);
}
export async function updateParceiro(id, patch) {
  const body = {
    nome: patch.nome,
    cidadeId: patch.cidadeId,
    logradouro: patch.logradouro,
    numero: patch.numero,
    bairro: patch.bairro,
    cep: patch.cep,
    descricao: patch.descricao,
    categoria: patch.categoria,
    referencias: patch.referencias,
    contato: patch.contato,
  };
  return apiFetch("PATCH", `/api/admin/parceiros/${id}`, body);
}
export async function deleteParceiro(id) {
  return apiFetch("DELETE", `/api/admin/parceiros/${id}`);
}

/** (Opcional) Importação em lote — aceita um array de parceiros */
export async function bulkCreateParceiros(items = []) {
  return apiFetch("POST", "/api/admin/parceiros:bulk", { items });
}

// ============================================================================
// Dicas
// ============================================================================
export async function getDicas({ cidadeId, titulo, page = 1, limit = 50 } = {}) {
  const qs = new URLSearchParams();
  if (cidadeId) qs.set("cidadeId", cidadeId);
  if (titulo) qs.set("titulo", titulo);
  if (page) qs.set("page", String(page));
  if (limit) qs.set("limit", String(limit));
  return apiFetch("GET", `/api/admin/dicas?${qs.toString()}`);
}
export async function getDicaById(id) {
  return apiFetch("GET", `/api/admin/dicas/${id}`);
}
export async function createDica({ cidadeId, titulo, conteudo, categoria }) {
  return apiFetch("POST", "/api/admin/dicas", {
    cidadeId,
    titulo,
    conteudo,
    categoria,
  });
}
export async function updateDica(id, patch) {
  return apiFetch("PATCH", `/api/admin/dicas/${id}`, patch);
}
export async function deleteDica(id) {
  return apiFetch("DELETE", `/api/admin/dicas/${id}`);
}

// ============================================================================
// Avisos
// ============================================================================
export async function getAvisos({ cidadeId, regiaoId, page = 1, limit = 50 } = {}) {
  const qs = new URLSearchParams();
  if (cidadeId) qs.set("cidadeId", cidadeId);
  if (regiaoId) qs.set("regiaoId", regiaoId);
  if (page) qs.set("page", String(page));
  if (limit) qs.set("limit", String(limit));
  return apiFetch("GET", `/api/admin/avisos?${qs.toString()}`);
}
export async function createAviso({ titulo, mensagem, cidadeIds = [], regiaoId = null }) {
  return apiFetch("POST", "/api/admin/avisos", {
    titulo,
    mensagem,
    cidadeIds,
    regiaoId,
  });
}
export async function deleteAviso(id) {
  return apiFetch("DELETE", `/api/admin/avisos/${id}`);
}

// ============================================================================
// Métricas
// ============================================================================
export async function getMetricsSummary() {
  return apiFetch("GET", "/api/admin/metrics/summary");
}
export async function getMetricsApis() {
  return apiFetch("GET", "/api/admin/metrics/apis");
}
export async function getMetricsConversas({ de, ate } = {}) {
  const qs = new URLSearchParams();
  if (de) qs.set("de", de);
  if (ate) qs.set("ate", ate);
  return apiFetch("GET", `/api/admin/metrics/conversas?${qs.toString()}`);
}
export async function getMetricsParceiros({ de, ate } = {}) {
  const qs = new URLSearchParams();
  if (de) qs.set("de", de);
  if (ate) qs.set("ate", ate);
  return apiFetch("GET", `/api/admin/metrics/parceiros?${qs.toString()}`);
}

// ============================================================================
// Logs
// ============================================================================
export async function getLogs({ tipo, de, ate, limit = 100 } = {}) {
  const qs = new URLSearchParams();
  if (tipo) qs.set("tipo", tipo);
  if (de) qs.set("de", de);
  if (ate) qs.set("ate", ate);
  if (limit) qs.set("limit", String(limit));
  return apiFetch("GET", `/api/admin/logs?${qs.toString()}`);
}

/** (Opcional) Registro de log manual */
export async function putLog({ tipo, mensagem, contexto }) {
  return apiFetch("POST", "/api/admin/logs", { tipo, mensagem, contexto });
}

// ============================================================================
// Utilidades (comuns no dashboard)
// ============================================================================
export function byId(arr = [], id) {
  return (arr || []).find((x) => x.id === id) || null;
}
export function toOptions(arr = [], labelKey = "nome") {
  return (arr || []).map((x) => ({
    value: x.id,
    label: x[labelKey] || x.id,
  }));
}

/** (Compat) Alias antigos possíveis */
export const adminPost = (path, body) => apiFetch("POST", path, body);
export const adminGet = (path) => apiFetch("GET", path);
export const adminPut = (path, body) => apiFetch("PATCH", path, body);
export const adminDelete = (path) => apiFetch("DELETE", path);

/** (Compat) Nomes legados para evitar quebrar chamadas antigas da UI */
export const listRegioes = getRegioes;
export const listCidades = getCidades;
export const listParceiros = getParceiros;
export const listDicas = getDicas;
export const listAvisos = getAvisos;