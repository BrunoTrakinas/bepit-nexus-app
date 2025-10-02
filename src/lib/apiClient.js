import axios from "axios";

/**
 * Como configurar:
 * - Se for usar o proxy do Netlify, deixe VITE_API_BASE_URL em branco (ou não defina).
 *   As chamadas irão para caminhos relativos /api/* e o Netlify redireciona para o Render.
 *
 * - Se quiser apontar direto para o Render, defina:
 *   VITE_API_BASE_URL=https://bepit-nexus-backend.onrender.com
 *
 * - NÃO coloque /api no final da variável. Se colocar, este cliente trata para não duplicar.
 */
const RAW_BASE = (import.meta.env.VITE_API_BASE_URL || "").trim().replace(/\/+$/, "");

/**
 * Corrige o path quando a base já termina com /api
 * Ex.: base = https://.../api e path = /api/chat → vira /chat
 */
function fixPath(path) {
  if (!RAW_BASE) return path; // usando proxy → caminho relativo funciona
  const baseHasApi = /\/api$/i.test(RAW_BASE);
  if (baseHasApi) return path.replace(/^\/api\b/i, "") || "/";
  return path;
}

const axiosInstance = axios.create({
  baseURL: RAW_BASE || "",
  withCredentials: false,
  headers: { "Content-Type": "application/json" },
});

const apiClient = {
  // Chat & Feedback
  enviarMensagemParaChat: (slugDaRegiao, body) =>
    axiosInstance.post(fixPath(`/api/chat/${encodeURIComponent(slugDaRegiao)}`), body),

  enviarFeedbackDaInteracao: (body) =>
    axiosInstance.post(fixPath("/api/feedback"), body),

  // Auth por chave
  authLoginByKey: (key) =>
    axiosInstance.post(fixPath("/api/auth/login"), { key }),

  // Admin
  adminLoginUserPass: (body) =>
    axiosInstance.post(fixPath("/api/admin/login"), body),

  adminCriarParceiro: (body, adminKey) =>
    axiosInstance.post(fixPath("/api/admin/parceiros"), body, {
      headers: { "X-Admin-Key": adminKey },
    }),

  adminListarParceiros: (regiaoSlug, cidadeSlug, adminKey) =>
    axiosInstance.get(fixPath(`/api/admin/parceiros/${regiaoSlug}/${cidadeSlug}`), {
      headers: { "X-Admin-Key": adminKey },
    }),

  adminAtualizarParceiro: (id, body, adminKey) =>
    axiosInstance.put(fixPath(`/api/admin/parceiros/${id}`), body, {
      headers: { "X-Admin-Key": adminKey },
    }),

  adminCriarRegiao: (body, adminKey) =>
    axiosInstance.post(fixPath("/api/admin/regioes"), body, {
      headers: { "X-Admin-Key": adminKey },
    }),

  adminCriarCidade: (body, adminKey) =>
    axiosInstance.post(fixPath("/api/admin/cidades"), body, {
      headers: { "X-Admin-Key": adminKey },
    }),

  adminMetricsSummary: (params, adminKey) =>
    axiosInstance.get(fixPath("/api/admin/metrics/summary"), {
      params,
      headers: { "X-Admin-Key": adminKey },
    }),

  adminLogs: (params, adminKey) =>
    axiosInstance.get(fixPath("/api/admin/logs"), {
      params,
      headers: { "X-Admin-Key": adminKey },
    }),
};

export default apiClient;
