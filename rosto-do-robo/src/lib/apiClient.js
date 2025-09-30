import axios from "axios";

// Se VITE_API_BASE_URL estiver definida (ex: https://bepit-nexus-backend.onrender.com),
// usamos ela. Caso contrário, vazio -> mesmo host do Netlify, e os caminhos /api/*
// serão proxied pelo netlify.toml
const baseURLDaApi = import.meta.env.VITE_API_BASE_URL || "";

const clienteAxios = axios.create({
  baseURL: baseURLDaApi,
  withCredentials: false,
  headers: { "Content-Type": "application/json" }
});

const apiClient = {
  // Chat/Feedback
  enviarMensagemParaChat: (slugDaRegiao, corpo) => clienteAxios.post(`/api/chat/${encodeURIComponent(slugDaRegiao)}`, corpo),
  enviarFeedbackDaInteracao: (corpo) => clienteAxios.post("/api/feedback", corpo),

  // Admin (user/pass) – opcional se você usar o fluxo por chave
  adminLogin: (corpo) => clienteAxios.post("/api/admin/login", corpo),

  // Admin por chave (use header x-admin-key)
  adminCriarParceiro: (corpo) =>
    clienteAxios.post("/api/admin/parceiros", corpo, { headers: { "x-admin-key": corpo.adminKey } }),

  adminListarParceiros: (regiaoSlug, cidadeSlug, adminKey) =>
    clienteAxios.get(`/api/admin/parceiros/${regiaoSlug}/${cidadeSlug}`, { headers: { "x-admin-key": adminKey } }),

  adminAtualizarParceiro: (id, corpo, adminKey) =>
    clienteAxios.put(`/api/admin/parceiros/${id}`, corpo, { headers: { "x-admin-key": adminKey } }),

  adminCriarRegiao: (corpo, adminKey) =>
    clienteAxios.post("/api/admin/regioes", corpo, { headers: { "x-admin-key": adminKey } }),

  adminCriarCidade: (corpo, adminKey) =>
    clienteAxios.post("/api/admin/cidades", corpo, { headers: { "x-admin-key": adminKey } }),

  adminMetricsSummary: (params, adminKey) =>
    clienteAxios.get("/api/admin/metrics/summary", { params, headers: { "x-admin-key": adminKey } }),

  adminLogs: (params, adminKey) =>
    clienteAxios.get("/api/admin/logs", { params, headers: { "x-admin-key": adminKey } })
};

export default apiClient;
