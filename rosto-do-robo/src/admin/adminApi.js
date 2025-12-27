// F:\uber-chat-mvp\rosto-do-robo\src\admin\adminApi.js

// URL base do backend (defina VITE_API_BASE_URL no Netlify)
export const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

// Chave do admin salva no navegador (localStorage)
export function getAdminKey() {
  return localStorage.getItem("BEPIT_ADMIN_KEY") || "";
}
export function setAdminKey(key) {
  localStorage.setItem("BEPIT_ADMIN_KEY", key || "");
}
export function clearAdminKey() {
  localStorage.removeItem("BEPIT_ADMIN_KEY");
}

// Normaliza o path para sempre começar com "/"
function normalizePath(path) {
  if (!path) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

async function doRequest(method, path, body) {
  if (!API_BASE) {
    throw new Error(
      "API_BASE vazio. Verifique VITE_API_BASE_URL no Netlify (ex.: https://backend-oficial-5fye.onrender.com)."
    );
  }

  const url = `${API_BASE}${normalizePath(path)}`;
  const headers = {
    "X-Admin-Key": getAdminKey()
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      mode: "cors"
    });
  } catch (e) {
    // Erros de rede (CORS, offline, DNS, etc.)
    throw new Error(`Falha de rede ao chamar ${url}: ${e.message || e}`);
  }

  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");

  if (!res.ok) {
    // tenta extrair a mensagem do backend
    try {
      const errPayload = isJson ? await res.json() : await res.text();
      const detail = typeof errPayload === "string" ? errPayload : (errPayload.error || JSON.stringify(errPayload));
      throw new Error(`HTTP ${res.status} - ${detail}`);
    } catch {
      throw new Error(`HTTP ${res.status} - resposta não lida`);
    }
  }

  // Sucesso
  try {
    return isJson ? await res.json() : await res.text();
  } catch {
    return null; // sem corpo
  }
}

export const adminGet    = (path)    => doRequest("GET",    path);
export const adminPost   = (path, b) => doRequest("POST",   path, b);
export const adminPut    = (path, b) => doRequest("PUT",    path, b);
export const adminDelete = (path)    => doRequest("DELETE", path);
