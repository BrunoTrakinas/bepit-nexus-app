// rosto-do-robo/src/lib/apiClient.js
// Cliente central de API com fallback:
// - Se VITE_API_BASE_URL estiver definido, usa base absoluta (ex.: https://bepit-nexus-backend.onrender.com)
// - Caso contrário, usa caminho relativo e espera que o proxy do Netlify redirecione /api/*

const baseURLDaApi = (import.meta.env.VITE_API_BASE_URL || "").trim();

async function doFetch(method, path, { body, params, headers } = {}) {
  // Monta URL (absoluta se baseURLDaApi tiver valor; relativa caso contrário)
  let url = baseURLDaApi ? new URL(path, baseURLDaApi) : new URL(path, window.location.origin);

  if (params && typeof params === "object") {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
  }

  const resp = await fetch(baseURLDaApi ? url.toString() : url.toString().replace(window.location.origin, ""), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(headers || {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  // tenta parsear JSON; se vier HTML de 404, vai cair no catch
  const maybeJson = await resp.json().catch(() => null);

  if (!resp.ok) {
    const msg = (maybeJson && (maybeJson.error || maybeJson.message)) || `Falha HTTP ${resp.status}`;
    throw new Error(msg);
  }

  // compat: algumas rotas eu retorno {data}, outras um objeto direto
  return { data: maybeJson };
}

const apiClient = {
  // Chat
  enviarMensagemParaChat: (slugDaRegiao, corpo) =>
    doFetch("POST", `/api/chat/${encodeURIComponent(slugDaRegiao)}`, { body: corpo }),

  // Feedback
  enviarFeedbackDaInteracao: (corpo) => doFetch("POST", "/api/feedback", { body: corpo }),

  // Admin (fluxo por chave)
  adminLogin: (corpo) => doFetch("POST", "/api/admin/login", { body: corpo }),
  adminAuthByKey: (key) => doFetch("POST", "/api/auth/login", { body: { key } }),

  adminCriarParceiro: (corpo) =>
    doFetch("POST", "/api/admin/parceiros", {
      body: corpo,
      headers: { "X-Admin-Key": corpo.adminKey }
    }),

  adminListarParceiros: (regiaoSlug, cidadeSlug, adminKey) =>
    doFetch("GET", `/api/admin/parceiros/${regiaoSlug}/${cidadeSlug}`, {
      headers: { "X-Admin-Key": adminKey }
    }),

  adminAtualizarParceiro: (id, corpo, adminKey) =>
    doFetch("PUT", `/api/admin/parceiros/${id}`, {
      body: corpo,
      headers: { "X-Admin-Key": adminKey }
    }),

  adminCriarRegiao: (corpo, adminKey) =>
    doFetch("POST", "/api/admin/regioes", {
      body: corpo,
      headers: { "X-Admin-Key": adminKey }
    }),

  adminCriarCidade: (corpo, adminKey) =>
    doFetch("POST", "/api/admin/cidades", {
      body: corpo,
      headers: { "X-Admin-Key": adminKey }
    }),

  adminMetricsSummary: (params, adminKey) =>
    doFetch("GET", "/api/admin/metrics/summary", {
      params,
      headers: { "X-Admin-Key": adminKey }
    }),

  adminLogs: (params, adminKey) =>
    doFetch("GET", "/api/admin/logs", {
      params,
      headers: { "X-Admin-Key": adminKey }
    })
};

export default apiClient;
