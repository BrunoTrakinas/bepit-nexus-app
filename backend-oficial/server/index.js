// /backend-oficial/server/index.js
// v6.3 (Vendedor Nato + Refinamento Dinâmico)
// ============================================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
// Rotas modulares (ajuste paths se necessário)
import financeiroRoutes from "./routes/financeiro.routes.js";
import uploadsRoutes from "./routes/uploads.routes.js";
import ragRoutes from "./routes/rag.routes.js";
import parceiroRoutes from "./routes/parceiro.routes.js";

// Supabase client (ajuste path se necessário)
import { supabase } from "../lib/supabaseAdmin.js";
// RAG híbrido (ajuste path se necessário)
import { hybridSearch } from "../services/rag.service.js"; // [cite: 105]
import climaRoutes from "./routes/clima.routes.js";
import marRoutes from "./routes/mar.routes.js";


// ---- Fetch Polyfill (Node.js < 18) --------------------------------------------
if (typeof fetch !== "function") {
  globalThis.fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
}
// -------------------------------------------------------------------------------

// ====================== DEBUG: listar rotas montadas =========================
function printRoutes(app, label = "APP") {
  try {
    const lines = [];
    app?._router?.stack?.forEach?.((layer) => {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).map((m) => m.toUpperCase()).join(",");
        lines.push(`${methods.padEnd(6)} ${layer.route.path}`);
      } else if (layer.name === "router" && layer.handle?.stack) {
        const prefix = (layer.regexp && layer.regexp.toString()) || "(subrouter)";
        layer.handle.stack.forEach((l2) => {
          if (l2.route?.path) {
            const methods = Object.keys(l2.route.methods).map((m) => m.toUpperCase()).join(",");
            lines.push(`${methods.padEnd(6)} ${prefix} -> ${l2.route.path}`);
          }
        });
      }
    });
    console.log(`\n[DEBUG ROUTES ${label}]`);
    lines.forEach((l) => console.log("  ", l));
  } catch (e) {
    console.log(`[DEBUG ROUTES ${label}] (indisponível)`, e?.message || "");
  }
}

// ===================== CLIENTE REDIS (UPSTASH) — VIA REST ====================
// (Baseado no [cite: 111-133] - Código do Upstash mantido integralmente)
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_TOKEN || "";
const UPSTASH_TIMEOUT_MS = Number(process.env.UPSTASH_TIMEOUT_MS || 1200);
const UPSTASH_RETRIES = Math.max(0, Number(process.env.UPSTASH_RETRIES || 1));
function hasUpstash() { return !!UPSTASH_URL && !!UPSTASH_TOKEN; }
async function withTimeoutFetch(url, init, { timeoutMs = UPSTASH_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    return resp;
  } finally {
    clearTimeout(t);
  }
}
async function upstashFetch(url, init, { timeoutMs = UPSTASH_TIMEOUT_MS, label = "op" } = {}) {
  let attempt = 0;
  while (true) {
    try {
      const resp = await withTimeoutFetch(url, init, { timeoutMs });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`[UPSTASH] ${label} falhou: ${resp.status} ${resp.statusText} ${txt}`);
      }
      return resp;
    } catch (e) {
      const isAbort = e?.name === "AbortError";
      attempt++;
      if (attempt > UPSTASH_RETRIES || !isAbort) throw e;
      const backoff = 200 * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}
const upstash = {
  async get(key, { timeoutMs = UPSTASH_TIMEOUT_MS } = {}) {
    if (!hasUpstash()) throw new Error("[UPSTASH] Config ausente (URL/TOKEN).");
    const url = `${UPSTASH_URL.replace(/\/+$/, "")}/get/${encodeURIComponent(key)}`;
    try {
      const resp = await upstashFetch(url, { method: "GET", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }, { timeoutMs, label: `GET ${key}` });
      const json = await resp.json();
      return json?.result ?? null;
    } catch (e) {
      console.warn(String(e?.name) === "AbortError" ? `[CACHE] GET ${key} timeout (${timeoutMs}ms)` : `[CACHE] GET ${key} erro: ${e?.message || e}`);
      return null;
    }
  },
  async exists(key, { timeoutMs = UPSTASH_TIMEOUT_MS } = {}) {
     if (!hasUpstash()) throw new Error("[UPSTASH] Config ausente (URL/TOKEN).");
     const url = `${UPSTASH_URL.replace(/\/+$/, "")}/exists/${encodeURIComponent(key)}`;
     try {
       const resp = await upstashFetch(url, { method: "GET", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }, { timeoutMs, label: `EXISTS ${key}` });
       const json = await resp.json();
       return Number(json?.result || 0) > 0;
     } catch (e) {
       console.warn(String(e?.name) === "AbortError" ? `[CACHE] EXISTS ${key} timeout (${timeoutMs}ms)` : `[CACHE] EXISTS ${key} erro: ${e?.message || e}`);
       return false;
     }
  },
  async set(key, value, ttlSeconds, { timeoutMs = UPSTASH_TIMEOUT_MS } = {}) {
    if (!hasUpstash()) throw new Error("[UPSTASH] Config ausente (URL/TOKEN).");
    const base = `${UPSTASH_URL.replace(/\/+$/, "")}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;
    const url = ttlSeconds ? `${base}?EX=${encodeURIComponent(ttlSeconds)}` : base;
    try {
      const resp = await upstashFetch(url, { method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }, { timeoutMs, label: `SET ${key}` });
      const json = await resp.json();
      return json?.result === "OK";
    } catch (e) {
      console.warn(String(e?.name) === "AbortError" ? `[CACHE] SET ${key} timeout (${timeoutMs}ms)` : `[CACHE] SET ${key} erro: ${e?.message || e}`);
      return false;
    }
  },
};
// ============================================================================

// ============================== APP ÚNICO ===================================
const app = express();
const PORT = process.env.PORT || 3002;
const HOST = "0.0.0.0";

// ------------------------------ CORS ----------------------------------------
// (Baseado no [cite: 134-139] - Código CORS mantido integralmente)
const EXPLICIT_ALLOWED_ORIGINS = new Set(["http://localhost:5173", "http://localhost:3000"]);
if (process.env.FRONTEND_ORIGIN) { EXPLICIT_ALLOWED_ORIGINS.add(process.env.FRONTEND_ORIGIN.trim()); }
if (process.env.CORS_EXTRA_ORIGINS) { process.env.CORS_EXTRA_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean).forEach((o) => EXPLICIT_ALLOWED_ORIGINS.add(o)); }
const ALLOWED_ORIGIN_PATTERNS = [/^https:\/\/.*\.netlify\.app$/, /^http:\/\/localhost:(3000|5173)$/];
const CORS_ALLOW_ALL = String(process.env.CORS_ALLOW_ALL || "") === "1";
function isOriginAllowed(origin) {
  if (!origin) return true;
  if (CORS_ALLOW_ALL) return true;
  if (EXPLICIT_ALLOWED_ORIGINS.has(origin)) return true;
  return ALLOWED_ORIGIN_PATTERNS.some((rx) => rx.test(origin));
}
app.use((req, res, next) => {
  if (req.method !== "OPTIONS") return next();
  const origin = req.headers.origin || "";
  if (!isOriginAllowed(origin)) return res.status(403).send("CORS: origem não permitida.");
  res.header("Access-Control-Allow-Origin", origin);
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key, Authorization, Accept, X-Requested-With");
  res.header("Access-Control-Max-Age", "600");
  return res.sendStatus(204);
});
app.use(
  cors({
    origin: (origin, cb) => (isOriginAllowed(origin) ? cb(null, true) : cb(new Error("CORS block"))),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Admin-Key", "Authorization", "Accept", "X-Requested-With"],
  })
);
app.use(express.json({ limit: "25mb" }));
// ---------------------------------------------------------------------------

// ------------------------------ Health & Debug -----------------------------
// (Baseado no [cite: 140-144] - Rotas /health e /_debug mantidas)
app.get("/health", async (req, res) => {
  try {
    const env = {
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
    };
    let supabaseStatus = "skip";
    try {
      const { data, error } = await supabase.from("parceiros").select("id").limit(1);
      supabaseStatus = error ? `error: ${error.message}` : "ok";
    } catch (e) {
      supabaseStatus = `error: ${e?.message || String(e)}`;
    }
    res.json({ ok: true, checks: { uptime_s: Math.floor(process.uptime()), env, supabase: supabaseStatus } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
app.get("/_debug/rag/search", async (req, res) => {
  try {
    const q = String(req.query?.q || "");
    const categoria = req.query?.categoria ? String(req.query.categoria) : null;
    const cidade_id = req.query?.cidade_id ? String(req.query.cidade_id) : null;
    const limit = Math.max(1, Math.min(parseInt(req.query?.limit ?? "10", 10) || 10, 50));
    const out = await hybridSearch({ q, cidade_id, categoria, limit, debug: true });
    const payload = Array.isArray(out?.items) ? out : { items: out, meta: null };
    res.json({ ok: true, items: payload.items, meta: payload.meta });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});
// ---------------------------------------------------------------------------


// ------------------------------ ROTAS MODULARES ------------------------------
app.use("/api/parceiro", parceiroRoutes);
app.use("/api/rag", ragRoutes);
// app.use("/api/chat", ragRoutes); // Removido, pois a rota principal está abaixo
app.use("/api/financeiro", financeiroRoutes);
app.use("/api/uploads", uploadsRoutes);
app.use("/api/clima", climaRoutes);
app.use("/api/mar", marRoutes);
app.get("/", (_req, res) => res.status(200).send("BEPIT backend ativo ✅"));
app.get("/ping", (_req, res) => res.status(200).json({ pong: true, ts: Date.now() }));
// ---------------------------------------------------------------------------


// ============================== IA (Gemini REST) =============================
// (Baseado no [cite: 148-173] - Lógica do Gemini mantida integralmente)
const usarGeminiREST = String(process.env.USE_GEMINI_REST || "") === "1";
const chaveGemini = process.env.GEMINI_API_KEY || "";
const AI_DISABLED = String(process.env.AI_DISABLED || "") === "1";
function stripModelsPrefix(id) { return String(id || "").replace(/^models\//, ""); }
async function listarModelosREST() {
  if (!chaveGemini) throw new Error("[GEMINI REST] GEMINI_API_KEY não definida.");
  const url = `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(chaveGemini)}`;
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    const texto = await resp.text().catch(() => "");
    throw new Error(`[GEMINI REST] Falha ao listar modelos: ${resp.status} ${resp.statusText} ${texto}`);
  }
  const json = await resp.json();
  const items = Array.isArray(json.models) ? json.models : [];
  return items.map((m) => String(m.name || "")).filter(Boolean);
}
async function selecionarModeloREST() {
  const todosComPrefixo = await listarModelosREST();
  const disponiveis = todosComPrefixo.map(stripModelsPrefix);
  const envModelo = (process.env.GEMINI_MODEL || "").trim();
  if (envModelo) {
    const alvo = stripModelsPrefix(envModelo);
    if (disponiveis.includes(alvo)) return alvo;
    console.warn(`[GEMINI REST] GEMINI_MODEL "${envModelo}" indisponível. Disponíveis: ${disponiveis.join(", ")}`);
  }
  const preferencia = [envModelo && stripModelsPrefix(envModelo), "gemini-2.5-flash", "gemini-1.5-flash-latest", "gemini-1.5-pro-latest"].filter(Boolean);
  for (const alvo of preferencia) if (disponiveis.includes(alvo)) return alvo;
  const qualquer = disponiveis.find((n) => /^gemini-/.test(n));
  if (qualquer) return qualquer;
  throw new Error("[GEMINI REST] Não foi possível selecionar modelo.");
}
async function gerarConteudoComREST(modelo, texto) {
  if (!chaveGemini) throw new Error("[GEMINI REST] GEMINI_API_KEY não definida.");
  const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(modelo)}:generateContent?key=${encodeURIComponent(chaveGemini)}`;
  const payload = { contents: [{ role: "user", parts: [{ text: String(texto || "") }] }] };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const texto = await resp.text().catch(() => "");
    throw new Error(`[GEMINI REST] Falha no generateContent: ${resp.status} ${resp.statusText} ${texto}`);
  }
  const json = await resp.json();
  const parts = json?.candidates?.[0]?.content?.parts;
  const out = Array.isArray(parts) ? parts.map((p) => p?.text || "").join("\n").trim() : "";
  return out || "";
}
let modeloGeminiV1 = null;
async function obterModeloREST() {
  if (!usarGeminiREST) throw new Error("[GEMINI REST] USE_GEMINI_REST=1 é obrigatório.");
  if (modeloGeminiV1) return modeloGeminiV1;
  modeloGeminiV1 = await selecionarModeloREST();
  console.log(`[GEMINI REST] Modelo selecionado: ${modeloGeminiV1}`);
  return modeloGeminiV1;
}
async function geminiGerarTexto(texto) {
  const modelo = await obterModeloREST();
  return await gerarConteudoComREST(modelo, texto);
}
function isRetryableGeminiError(err) {
  const msg = String(err?.message || err);
  return /429|RESOURCE_EXHAUSTED|500|502|503|504/i.test(msg);
}
async function geminiTry(texto, { retries = 2, baseDelay = 500 } = {}) {
  if (AI_DISABLED || !usarGeminiREST) throw new Error("AI_DISABLED");
  let attempt = 0;
  while (true) {
    try {
      return await geminiGerarTexto(texto);
    } catch (e) {
      attempt++;
      if (attempt > retries || !isRetryableGeminiError(e)) throw e;
      const jitter = Math.floor(Math.random() * 250);
      const delay = baseDelay * Math.pow(2, attempt - 1) + jitter;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
// ============================================================================
// ==========================================================
// CORREÇÃO v2: Restaurar extrairEntidadesDaBusca (SEM CITAÇÕES)
// ==========================================================
async function extrairEntidadesDaBusca(texto) {
  const tNorm = normalizarTexto(texto || ""); // Usa a função normalizarTexto

  let city = null;
  if (tNorm.includes("cabo frio")) city = "Cabo Frio";
  else if (tNorm.includes("buzios") || tNorm.includes("búzios")) city = "Armação dos Búzios";
  else if (tNorm.includes("arraial")) city = "Arraial do Cabo";
  else if (tNorm.includes("sao pedro") || tNorm.includes("são pedro")) city = "São Pedro da Aldeia";
  else if (tNorm.includes("iguaba")) city = "Iguaba Grande";

  const DIC_TERMS = [
    "pizzaria", "pizza", "picanha", "piconha", "carne", "churrasco", "rodizio", "rodízio",
    "fraldinha", "costela", "barato", "barata", "familia", "família", "romantico", "romântico",
    "vista", "vista para o mar", "peixe", "frutos do mar", "moqueca", "hamburguer", "hambúrguer",
    "sushi", "japonesa", "bistrô", "bistro",
  ];
  const terms = [];
  for (const w of DIC_TERMS) if (tNorm.includes(normalizarTexto(w))) terms.push(w);

  let category = null;
  // Lógica de detecção de categoria
  if (tNorm.includes("pizzaria") || tNorm.includes("pizza")) { category = "pizzaria"; }
  else if (["restaurante", "comer", "comida", "picanha", "carne", "churrasco", "rodizio", "peixe", "frutos do mar", "moqueca", "hamburguer", "bistrô", "sushi", "japonesa"].some(k => tNorm.includes(k))) { category = "comida"; }
  else if (["pousada", "hotel", "hostel", "hospedagem", "airbnb", "apart", "flat", "resort"].some(k => tNorm.includes(k))) { category = "hospedagem"; }
  else if (["bar", "bares", "chopp", "chope", "drinks", "pub", "boteco"].some(k => tNorm.includes(k))) { category = "bebidas"; }
  else if (["passeio", "barco", "lancha", "escuna", "trilha", "buggy", "quadriciclo", "mergulho", "snorkel", "tour"].some(k => tNorm.includes(k))) { category = "passeios"; }
  else if (["praia", "praias", "bandeira azul", "orla"].some(k => tNorm.includes(k))) { category = "praias"; }
  else if (["transfer", "transporte", "aluguel de carro", "locadora", "uber", "taxi", "ônibus", "onibus"].some(k => tNorm.includes(k))) { category = "transporte"; }

  return { category, city, terms };
}
// ==========================================================
// FIM DA CORREÇÃO v2
// ==========================================================

// (A função normalizarTexto continua abaixo)
function normalizarTexto(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
function getHoraLocalSP() {
  try {
    const fmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false });
    return fmt.format(new Date());
  } catch {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const sp = new Date(utc - 3 * 3600000);
    const hh = String(sp.getHours()).padStart(2, "0");
    const mm = String(sp.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
}
async function construirHistoricoParaGemini(conversationId, limite = 12) {
  try {
    const { data, error } = await supabase
      .from("interacoes")
      .select("pergunta_usuario, resposta_ia")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    const rows = data || [];
    const ultimas = rows.slice(-limite);
    const contents = [];
    for (const it of ultimas) {
      if (it.pergunta_usuario) contents.push({ role: "user", parts: [{ text: it.pergunta_usuario }] });
      if (it.resposta_ia) contents.push({ role: "model", parts: [{ text: it.resposta_ia }] });
    }
    return contents;
  } catch (e) {
    console.warn("[HISTORICO DB] Falha ao carregar:", e?.message || e);
    return [];
  }
}
function historicoParaTextoSimplesWrapper(hc) {
  try {
    return (hc || [])
      .map((b) => {
        const role = b?.role || "user";
        const text = (b?.parts?.[0]?.text || "").replace(/\s+/g, " ").trim();
        return `- ${role}: ${text}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

// ======================= FUNÇÃO CENTRAL — ATUALIZA E RESPONDE ===============
// (Baseado no [cite: 184-195] - updateSessionAndRespond mantido)
async function updateSessionAndRespond({
  res, runId, conversationId, userText, aiResponseText, sessionData, regiaoId, partners = [],
}) {
  const _run = runId || "NO-RUNID";
  console.log(`[RUN ${_run}] [RAIO-X FINAL] Preparando para responder e salvar sessão.`);

  const novoHistorico = [...(sessionData?.history || [])];
  novoHistorico.push({ role: "user", parts: [{ text: userText }] });
  novoHistorico.push({ role: "model", parts: [{ text: aiResponseText }] });
  const MAX_HISTORY_LENGTH = 12;
  while (novoHistorico.length > MAX_HISTORY_LENGTH) {
    novoHistorico.shift();
  }

  const novaSessionData = { ...(sessionData || {}), history: novoHistorico };

  const TTL_SECONDS = 900;
  if (hasUpstash()) {
    try {
      await upstash.set(conversationId, JSON.stringify(novaSessionData), TTL_SECONDS, { timeoutMs: 400 });
    } catch (e) {
      console.warn(`[RUN ${_run}] [CACHE] Falha ao salvar sessão (não fatal):`, e?.message || e);
    }
  } else {
    console.warn("[CACHE] Upstash não configurado. Seguindo sem cache.");
  }

  try {
    await supabase.from("interacoes").insert({
      conversation_id: conversationId,
      regiao_id: regiaoId,
      pergunta_usuario: userText,
      resposta_ia: aiResponseText,
      parceiros_sugeridos: partners.length > 0 ? partners : null,
    });
  } catch (e) {
    console.error(`[RUN ${_run}] [SUPABASE] Falha ao salvar interação:`, e);
  }

  return res.json({
    reply: aiResponseText,
    conversationId,
    partners: partners.length > 0 ? partners : undefined,
  });
}

// -------------------------- SESSION ENSURER ---------------------------------
// (Baseado no [cite: 196-207] - ensureConversation mantido)
async function ensureConversation(req) {
  const body = req.body || {};
  let conversationId = body.conversationId || body.threadId || body.sessionId || null;

  if (!conversationId || typeof conversationId !== "string" || conversationId.trim().length < 10) {
    conversationId = randomUUID();
    try {
      await supabase.from("conversas").insert({
        id: conversationId,
        regiao_id: req.ctx?.regiao?.id || null,
      });
    } catch { /* idempotência */ }
  } else {
    try {
      const { data: existe } = await supabase.from("conversas").select("id").eq("id", conversationId).maybeSingle();
      if (!existe) {
        await supabase.from("conversas").insert({
          id: conversationId,
          regiao_id: req.ctx?.regiao?.id || null,
        });
      }
    } catch { /* segue fluxo */ }
  }

  let isFirstTurn = false;
  if (hasUpstash()) {
    try {
      const exists = await upstash.exists(conversationId, { timeoutMs: 400 });
      isFirstTurn = !exists;
    } catch {
      try {
        const { count } = await supabase.from("interacoes").select("*", { count: "exact", head: true }).eq("conversation_id", conversationId);
        isFirstTurn = (count || 0) === 0;
      } catch { isFirstTurn = false; }
    }
  } else {
    try {
      const { count } = await supabase.from("interacoes").select("*", { count: "exact", head: true }).eq("conversation_id", conversationId);
      isFirstTurn = (count || 0) === 0;
    } catch { isFirstTurn = false; }
  }

  req.ctx = Object.assign({}, req.ctx || {}, { conversationId, isFirstTurn });
  return { conversationId, isFirstTurn };
}

// ---------------------- CLASSIFICAÇÃO/EXTRAÇÃO -------------------------------
// (Baseado no [cite: 208-221, 254-269] - Funções de classificação mantidas)
function normalizar(texto) { return normalizarTexto(texto); }
function isSaudacao(texto) {
  const t = normalizar(texto);
  const saudacoes = ["oi", "ola", "olá", "bom dia", "boa tarde", "boa noite", "e ai", "e aí", "tudo bem"];
  return saudacoes.includes(t);
}
const PALAVRAS_CHAVE_PARCEIROS = {
  comida: ["restaurante", "almoço", "jantar", "comer", "comida", "picanha", "carne", "churrasco", "pizza", "pizzaria", "peixe", "frutos do mar", "moqueca", "rodizio", "lanchonete", "burger", "hamburguer", "bistrô"],
  hospedagem: ["pousada", "hotel", "hospedagem", "hostel", "airbnb"],
  bebidas: ["bar", "chopp", "chope", "drinks", "pub", "boteco"],
  passeios: ["passeio", "barco", "lancha", "escuna", "trilha", "tour", "buggy", "quadriciclo", "city tour", "catamarã", "mergulho", "snorkel", "gruta", "ilha"],
  praias: ["praia", "praias", "faixa de areia", "bandeira azul", "mar calmo", "mar forte"],
  transporte: ["transfer", "transporte", "alugar carro", "aluguel de carro", "uber", "taxi", "ônibus", "onibus", "rodoviária"],
};
function forcarBuscaParceiro(texto) {
  const t = normalizarTexto(texto);
  for (const lista of Object.values(PALAVRAS_CHAVE_PARCEIROS)) {
    if (lista.some((p) => t.includes(p))) return true;
  }
  return false;
}
function isWeatherQuestion(texto) {
  if (forcarBuscaParceiro(texto)) return false;
  const t = normalizar(texto);
  const termos = ["clima", "tempo", "previsao", "previsão", "vento", "mar", "marea", "maré", "ondas", "onda", "temperatura", "graus", "calor", "frio", "chovendo", "chuva", "sol", "ensolarado", "nublado"];
  return termos.some((k) => t.includes(k));
}
function isRouteQuestion(texto) {
  const t = normalizar(texto);
  const termos = ["como chegar", "rota", "ir de", "saindo de", "qual caminho", "trajeto", "direcao", "direção"];
  return termos.some((k) => t.includes(k));
}
function detectTemporalWindow(texto) {
  const t = normalizar(texto);
  const sinaisFuturo = ["amanha", "amanhã", "semana que vem", "proxima semana", "próxima semana", "sabado", "sábado", "domingo", "proximos dias", "próximos dias", "daqui a"];
  return sinaisFuturo.some((s) => t.includes(s)) ? "future" : "present";
}
function extractCity(texto, cidadesAtivas) {
  const t = normalizarTexto(texto || "");
  const lista = Array.isArray(cidadesAtivas) ? cidadesAtivas : [];
  const apelidos = [
    { key: "arraial", nome: "Arraial do Cabo" }, { key: "arraial do cabo", nome: "Arraial do Cabo" },
    { key: "cabo frio", nome: "Cabo Frio" },
    { key: "buzios", nome: "Armação dos Búzios" }, { key: "búzios", nome: "Armação dos Búzios" }, { key: "armacao dos buzios", nome: "Armação dos Búzios" },
    { key: "rio das ostras", nome: "Rio das Ostras" },
    { key: "sao pedro", nome: "São Pedro da Aldeia" }, { key: "são pedro", nome: "São Pedro da Aldeia" },
    { key: "iguaba", nome: "Iguaba Grande" }, { key: "iguabinha", nome: "Iguaba Grande" },
  ];
  const hitApelido = apelidos.find((a) => t.includes(a.key));
  if (hitApelido) {
    const alvo = lista.find((c) => normalizarTexto(c.nome) === normalizarTexto(hitApelido.nome));
    if (alvo) return alvo;
  }
  for (const c of lista) {
    if (t.includes(normalizarTexto(c.nome)) || t.includes(normalizarTexto(c.slug))) return c;
  }
  return null;
}
function isRegionQuery(texto) {
  const t = normalizar(texto);
  const mencionaRegiao = t.includes("regiao") || t.includes("região") || t.includes("regiao dos lagos") || t.includes("região dos lagos");
  return mencionaRegiao;
}
// ====================== DETECTOR DE INTENÇÃO (LOCAL) =========================
async function detectarIntencaoLocal(texto, { slugDaRegiao } = {}) {
  const t = normalizarTexto(texto || "");
  
  // Regras diretas
  if (isRouteQuestion(texto)) {
    return { tipoIntencao: "rota", categoriaAlvo: null, cidadeAlvo: null, limiteSugestoes: 5 };
  }
  if (isWeatherQuestion(texto)) {
    return { tipoIntencao: "clima", categoriaAlvo: null, cidadeAlvo: null, limiteSugestoes: 5 };
  }

  // Heurística de parceiros (com extração básica)
  const entidades = await extrairEntidadesDaBusca(texto || "");
  const forcaParceiro = forcarBuscaParceiro(texto) || !!entidades?.category;
  let categoriaAlvo = entidades?.category || null;

  // Descobrir cidade da REGIÃO (se possível)
  let cidadeAlvo = null;
  try {
    const { data: regiao } = await supabase.from("regioes").select("id").eq("slug", slugDaRegiao).maybeSingle();
    if (regiao?.id) {
      const { data: cidades } = await supabase
        .from("cidades")
        .select("id, nome, slug")
        .eq("regiao_id", regiao.id);

              // ... depois de carregar `cidades` pela regiao.id:
      const tnorm = normalizarTexto(texto || "");

      // 1ª tentativa: se você já tem extractCity, mantemos:
      const alvo = extractCity?.(texto, cidades || []);
      if (alvo) {
        cidadeAlvo = alvo; // { id, nome, slug }
      }

      // Fallback: casamento simples por nome da cidade no texto ("cabo frio", "arraial do cabo", etc.)
      if (!cidadeAlvo && Array.isArray(cidades) && cidades.length > 0) {
        const hit = cidades.find((c) =>
          tnorm.includes(normalizarTexto(c?.nome || ""))
        );
        if (hit) {
          cidadeAlvo = hit; // { id, nome, slug }
        }
      }
            // 3) Fallback GLOBAL: se ainda não achou cidade, procura em TODAS as cidades
      if (!cidadeAlvo) {
        const tnorm = normalizarTexto(texto || "");
        const { data: allCidades, error: errAll } = await supabase
          .from("cidades")
          .select("id, nome, slug")
          .limit(500); // ajuste se sua tabela for pequena/grande

        if (!errAll && Array.isArray(allCidades)) {
          const hitGlobal = allCidades.find((c) =>
            tnorm.includes(normalizarTexto(c?.nome || ""))
          );
          if (hitGlobal) {
            cidadeAlvo = hitGlobal; // { id, nome, slug }
          }
        }
      }

    }
  } catch { /* segue sem cidade */ }

  const tipoIntencao = forcaParceiro ? "parceiro" : "geral";
  return { tipoIntencao, categoriaAlvo, cidadeAlvo, limiteSugestoes: 5 };
}
// Wrapper simples para rota humana (usa a função já existente gerarRotasHumanas)
async function montarTextoDeRota({ slugDaRegiao, pergunta }) {
  return gerarRotasHumanas(pergunta);
}

// Wrapper p/ resposta geral (usa gerarRespostaGeralPrompteada já presente no arquivo)
async function gerarRespostaGeral({ pergunta, slugDaRegiao, conversaId }) {
  const historico = await construirHistoricoParaGemini(conversaId, 12);
  const horaLocal = getHoraLocalSP();
  const regiaoNome = "Região dos Lagos";
  return gerarRespostaGeralPrompteada({
    pergunta,
    historicoContents: historico,
    regiaoNome,
    dadosClimaOuMaresJSON: "{}",
    horaLocalSP: horaLocal,
  });
}

// Versão mínima do "Vendedor Nato" (combina Try2 + Try3 usando o seu gerador de lista)
async function gerarRespostaVendedorNato({ q, cidadeAlvo, categoriaAlvo, candidatosTry2, candidatosTry3, limite, conversaId }) {
  const lista = [...(candidatosTry2 || []), ...(candidatosTry3 || [])].slice(0, Math.max(1, limite || 5));
  return gerarRespostaDeListaParceiros(q, null, lista, categoriaAlvo);
}


// ============================================================================
// >>>>>>>>>>>>>>>>>>>>>>>>>>> PROMPT MESTRE (V14) <<<<<<<<<<<<<<<<<<<<<<<<<<<
// (Baseado no [cite: 222-235] - Prompt Mestre mantido)
// ============================================================================
const PROMPT_MESTRE_V14 = `
# IDENTIDADE
Você é o **BEPIT**, concierge de turismo na Região dos Lagos (RJ).
Fala de forma humana, direta e útil. Não floreie, não alucine.
# FONTES E LIMITES
- Sempre priorize **dados internos** (Supabase: parceiros e dados_climaticos).
- Nunca recomende serviços privados externos (pousadas, restaurantes, passeios etc.).
- É permitido citar **serviços públicos externos** (bancos, 24h, farmácias, polícia, guarda municipal, capitania dos portos, hospitais, emergências, delegacias) — quando citar, diga que é “consulta pública”.
- Nunca responda sobre temas fora do turismo local (futebol, política, piadas, assuntos aleatórios).
# PARCEIROS (PRIORIDADE)
- Sempre que houver intenção de consumo (comer, bar, passeio, hospedagem, transporte), **priorize parceiros internos**.
- Ao listar, mostre nome, categoria e informações úteis.
- Fale como **“indicações confiáveis”** (não mencione “parceria”).
# CLIMA, MARÉS, ÁGUA
- Use **exclusivamente** a tabela interna \`dados_climaticos\`.
- Se faltar o tipo pedido (ex.: previsão futura), diga honestamente que ainda não há dados consolidados.
- Contextualize com a hora local (São Paulo) para sugerir atividades adequadas (sem inventar).
# ROTAS HUMANAS (SEM MAPS)
- Quando pedirem “como chegar”, explique em **texto humano**, ponto-a-ponto, usando rodovias e referências locais, sem fornecer links.
# ESTILO
- Respostas curtas (1–2 parágrafos) + bullets quando útil.
- Seja amigável e direto.
- Não inicie com saudação se não for o primeiro turno.
`.trim();
// ============================================================================

// ============================== RAG: BUSCA PARCEIROS =========================
// (Baseado no [cite: 269-280] - searchPartnersRAG mantido, mas com lógica de fallback interna)
async function searchPartnersRAG(textoDoUsuario, { cidadesAtivas, cidadeIdForcada, categoriaForcada, limit = 5 }) {
  
  let categoria = categoriaForcada;
  let cidade_id = cidadeIdForcada;

  // Se não forçado, extrai da pergunta
  if (!categoria || !cidade_id) {
    const entidades = await extrairEntidadesDaBusca(textoDoUsuario || ""); //
    if (!categoria) categoria = entidades?.category || null;
    if (!cidade_id && entidades?.city) {
      const alvo = (cidadesAtivas || []).find(
        (c) => normalizarTexto(c.nome) === normalizarTexto(entidades.city)
      );
      if (alvo) cidade_id = alvo.id;
    }
  }

  let results = [];
  try {
    const rag = await hybridSearch({
      q: textoDoUsuario,
      cidade_id,
      categoria,
      limit,
      debug: false,
    });
    results = Array.isArray(rag?.items) ? rag.items : Array.isArray(rag) ? rag : [];
  } catch (e) {
    console.warn("[RAG] Falhou, caindo para fallback direto no Supabase:", e?.message || e);
    // (O fallback bugado [cite: 276-279] foi removido e está dentro do hybridSearch (rag.service.js))
  }

  const parceiros = results.map((r) => ({
    id: r.id,
    tipo: r.tipo || null,
    nome: r.nome,
    categoria: r.categoria || categoria || null,
    descricao: r.descricao || null,
    endereco: r.endereco || null,
    contato: r.contato || null,
    beneficio_bepit: r.beneficio_bepit || null,
    faixa_preco: r.faixa_preco || null,
    fotos_parceiros: Array.isArray(r.fotos_parceiros) ? r.fotos_parceiros : [],
    cidade_id: r.cidade_id || null,
  }));

  return { parceiros, categoriaDetectada: categoria, cidadeIdDetectada: cidade_id };
}
// ==========================================================
// CORREÇÃO v3: Restaurar finalizeAssistantResponse
// ==========================================================
function finalizeAssistantResponse({ modelResponseText, foundPartnersList = [], mode = "general" }) {
  const txt = String(modelResponseText || "").trim();
  // Se estamos no modo de parceiros e a IA deu uma resposta vazia,
  // usamos uma frase padrão.
  if (mode === "partners" && !txt) {
    return "Aqui estão algumas **indicações confiáveis**.";
  }
  // Se a IA deu uma resposta vazia no modo geral, usamos outra frase padrão.
  if (!txt) {
     return "Posso te ajudar com informações e indicações na Região dos Lagos.";
  }
  // Caso contrário, retorna a resposta da IA.
  return txt;
}
// ==========================================================
// FIM DA CORREÇÃO v3
// ==========================================================

// ============================= FORMATADORES & IA =============================

// ============================================================================
// CORREÇÃO 1: Curar o Bug "Carro com Vista pro Mar"
// A função agora recebe a categoria e escolhe um refinamento inteligente.
// ============================================================================
async function gerarRespostaDeListaParceiros(userText, historico, parceiros, categoriaAlvo) {
  if (!Array.isArray(parceiros) || parceiros.length === 0) {
    return "Não encontrei parceiros adequados para o que você pediu. Quer tentar com outra categoria, cidade ou faixa de preço?";
  }
  
  const linhas = parceiros.slice(0, 8).map((p) => {
    const desc = p.descricao ? ` · ${p.descricao}` : "";
    return `• **${p.nome}** · ${p.categoria || "parceiro"}${desc}`;
  });

  // Mapeia categorias para refinamentos inteligentes
  const mapRefinamento = {
    'pizzaria': "Se quiser, eu refino por tipo de massa (fina, tradicional) ou ambiente (delivery, salão).",
    'restaurante': "Posso refinar por estilo (família, casal, vista para o mar) ou orçamento?",
    'churrascaria': "Prefere rodízio ou a la carte? Posso refinar por ambiente (família, amigos).",
    'sushi': "Posso refinar por ambiente (rodízio, a la carte) ou faixa de preço?",
    'hamburgueria': "Prefere um estilo mais artesanal ou um lanche rápido? Posso filtrar por preço.",
    'bar': "Busca algo com música ao vivo, drinks especiais ou um ambiente mais tranquilo?",
    'passeio_barco': "Quer um passeio mais longo (com paradas para mergulho) ou um tour mais rápido?",
    'locadora_veiculos': "Prefere um carro econômico, SUV ou algum modelo específico?",
  };
  
  // Normaliza a categoria (se existir)
  const catNorm = normalizarTexto(categoriaAlvo || parceiros[0]?.categoria || "");
  
  // Escolhe o refinamento
  const refinamentoPadrao = "Se quiser, eu refino conforme seu estilo (família, casal, orçamento, etc.). Pode me dizer o **número** ou o **nome** para ver mais detalhes.";
  const refinamento = mapRefinamento[catNorm] || refinamentoPadrao;

  return [
    "Aqui vão algumas **indicações confiáveis**:",
    ...linhas,
    "",
    refinamento,
  ].join("\n");
}
// ============================================================================
// FIM DA CORREÇÃO 1
// ============================================================================


// Geração de rotas em texto humano (sem links)
// (Baseado no [cite: 325-350] - gerarRotasHumanas mantido)
function gerarRotasHumanas(pergunta) {
  const t = normalizarTexto(pergunta);
  let origem = null;
  let destino = null;

  const m1 = t.match(/saindo de ([^,]+?) para ([^,\.!?\n]+)/i);
  if (m1) { origem = m1[1]?.trim(); destino = m1[2]?.trim(); }
  if (!origem || !destino) {
    const m2 = t.match(/de ([^,]+?) para ([^,\.!?\n]+)/i);
    if (m2) { origem = origem || m2[1]?.trim(); destino = destino || m2[2]?.trim(); }
  }
  if (!destino) {
    const m3 = t.match(/como chegar (em|para|até) ([^,\.!?\n]+)/i);
    if (m3) destino = m3[2]?.trim();
  }
  if (!origem) origem = "Rio de Janeiro";
  if (!destino) destino = "Cabo Frio";
  const rotasConhecidas = [
    { alvo: "cabo frio", texto: `Saindo de ${origem} para Cabo Frio: pegue a Via Dutra (BR-116) sentido Rio, entre na Linha Vermelha e siga para a Av. Brasil. Acesse a Ponte Rio–Niterói e, após cruzá-la, continue pela BR-101 até o acesso à Via Lagos (RJ-124). Siga a RJ-124 até a RJ-106/RJ-140 e entre rumo a Cabo Frio. Ao chegar, use a Av. América Central como referência.` },
    { alvo: "arraial do cabo", texto: `Saindo de ${origem} para Arraial do Cabo: utilize o mesmo eixo Dutra → Linha Vermelha → Av. Brasil → Ponte Rio–Niterói. Continue pela BR-101 e entre na Via Lagos (RJ-124). Siga até a RJ-140, passando por São Pedro da Aldeia, e depois pegue o acesso para Arraial do Cabo. Ao entrar na cidade, a Av. Gov. Leonel de Moura Brizola te leva ao Centro.` },
    { alvo: "armação dos búzios", texto: `Saindo de ${origem} para Búzios: siga Dutra → Linha Vermelha → Av. Brasil → Ponte Rio–Niterói → BR-101. Acesse a Via Lagos (RJ-124) e prossiga até a RJ-106 (Amaral Peixoto) sentido Cabo Frio/Búzios. Entre na RJ-102 rumo a Búzios. Ao chegar, use a Av. José Bento Ribeiro Dantas como referência.` },
  ];
  const match = rotasConhecidas.find((r) => destino && normalizarTexto(destino).includes(r.alvo));
  return match ? match.texto : `Rota sugerida saindo de ${origem} para ${destino}: use Dutra/BR-116 até o Rio, acesse Linha Vermelha → Av. Brasil → Ponte Rio–Niterói. Siga BR-101 e, conforme o destino, pegue a Via Lagos (RJ-124) e depois as conexões RJ-106/RJ-140 ou RJ-102.`;
}

// Resposta geral neutra, humana, sem forçar clima
async function gerarRespostaGeralPrompteada({ 
  pergunta, historicoContents, regiaoNome, dadosClimaOuMaresJSON = "{}", horaLocalSP }) {
  // (Baseado no [cite: 351-356] - mantido)
  const deveExplicarRotas = isRouteQuestion(pergunta);
  if (deveExplicarRotas) {
    return gerarRotasHumanas(pergunta);
  }
  const promptNeutro = `
${PROMPT_MESTRE_V14}
Hora local: ${horaLocalSP}
Região: ${regiaoNome}
Dados contextuais (internos ou vazios):
${dadosClimaOuMaresJSON}
Histórico resumido:
${historicoParaTextoSimplesWrapper(historicoContents)}
Pergunta do usuário: "${pergunta}"
Responda de forma direta, com 1–2 parágrafos no máximo.
Se não houver dados internos suficientes, seja honesto.
`.trim();
  try {
    return await geminiTry(promptNeutro);
  } catch {
    return "Entendido. Posso te indicar opções e explicar como chegar em texto simples. Diga a cidade/bairro e o tipo de lugar que você procura.";
  }
}

// ============================================================================
// >>> ROTA DO CHAT - ORQUESTRADOR v6.3 (CÉREBRO VENDEDOR NATO) <<<<<
// ============================================================================
app.post("/api/chat/:slugDaRegiao", async (req, res) => {
  const slugDaRegiao = req.params.slugDaRegiao;
  const { message, conversationId } = req.body || {};

  try {
    // 1) Detecta intenção (Parceiro / Clima / Rota / Geral)
    // depois (fallback inteligente):
    const detectar = (typeof detectarIntencao === "function" ? detectarIntencao : detectarIntencaoLocal);
    const { tipoIntencao, categoriaAlvo, cidadeAlvo, limiteSugestoes } =
      await detectar(message, { slugDaRegiao });

    console.log("[DET INTENCAO] tipo:", tipoIntencao, "categoria:", categoriaAlvo);
    console.log("[DET INTENCAO] cidadeAlvo:", cidadeAlvo);

    // ===================== PARCEIRO =====================
    if (tipoIntencao === "parceiro") {
      // Try 1: categoria + cidade (chama do JEITO que sua função espera)
const { parceiros: parceirosTry1_raw } = await searchPartnersRAG(message, {
  cidadeIdForcada: cidadeAlvo?.id || null,
  categoriaForcada: categoriaAlvo || null,
  limit: Math.max(1, Math.min(limiteSugestoes || 5, 12)),
});

// >>> Safeguard: só mantém parceiros da MESMA cidade pedida (se houver cidadeAlvo)
const parceirosTry1 = (cidadeAlvo?.id)
  ? (parceirosTry1_raw || []).filter((p) => p?.cidade_id === cidadeAlvo.id)
  : (parceirosTry1_raw || []);

// (opcional) log de auditoria
console.log("[CHAT][TRY1] cidadePedida:", cidadeAlvo?.nome, "id:", cidadeAlvo?.id, "qtdFiltrada:", parceirosTry1.length);

// Se, após o filtro, ainda houver resultados → sucesso do Try 1
if (Array.isArray(parceirosTry1) && parceirosTry1.length > 0) {
  const categoriaReal = parceirosTry1[0]?.categoria || categoriaAlvo || null;

  const resposta = await gerarRespostaDeListaParceiros(
    message,        // userText
    null,           // historico
    parceirosTry1,  // parceiros (APÓS FILTRO)
    categoriaReal   // categoria correta para refinamento
  );

  return res.json({
    ok: true,
    tipo: "parceiro",
    origem: "try1",
    count: parceirosTry1.length,
    resposta,
    parceiros: parceirosTry1,
  });
}

// Caso contrário, segue para Try 2 / Try 3 (seus blocos já corrigidos com o aviso)


// (se cair aqui, segue para Try 2 / Try 3 como você já implementou)


      // Try 2: relaxa cidade (mantém categoria)
      const { parceiros: parceirosTry2 } = await searchPartnersRAG(message, {
        cidadeIdForcada: null,
        categoriaForcada: categoriaAlvo || null,
        limit: Math.max(1, Math.min(limiteSugestoes || 5, 12)),
      });

      // Try 3: relaxa categoria (mantém cidade)
      const { parceiros: parceirosTry3 } = await searchPartnersRAG(message, {
        cidadeIdForcada: cidadeAlvo?.id || null,
        categoriaForcada: null,
        limit: Math.max(1, Math.min(limiteSugestoes || 5, 12)),
      });

    // Combina resultados (mantendo sua assinatura de gerador)
const combinados = [...(parceirosTry2 || []), ...(parceirosTry3 || [])]
  .slice(0, Math.max(1, Math.min(limiteSugestoes || 5, 12)));

// >>> Early-return quando não há resultados nem em cidades próximas
if (combinados.length === 0) {
  const nomePedida = cidadeAlvo?.nome || "sua cidade solicitada";
  return res.json({
    ok: true,
    tipo: "parceiro",
    origem: "try2_try3",
    resposta: `Poxa, não encontrei indicações **seguras** em **${nomePedida}** nem em cidades próximas. Posso tentar outra categoria, faixa de preço ou bairro?`,
    parceiros_try2: [],
    parceiros_try3: [],
  });
}

// >>> NOVO: se a cidade pedida existe e NENHUM parceiro for dessa cidade,
// vamos montar um aviso amigável de “cidade diferente”.
let avisoCidade = "";
try {
  const cidadePedidaId = cidadeAlvo?.id || null;
  if (cidadePedidaId && combinados.length > 0) {
    const idsEncontrados = Array.from(
      new Set(combinados.map((p) => p.cidade_id).filter(Boolean))
    );
    const nenhumDaCidadePedida = !idsEncontrados.includes(cidadePedidaId);

    if (nenhumDaCidadePedida && idsEncontrados.length > 0) {
      // Busca nomes das cidades retornadas
      const { data: cidadesOutras } = await supabase
        .from("cidades")
        .select("id, nome")
        .in("id", idsEncontrados);

      const nomesOutros = (cidadesOutras || [])
        .map((c) => c?.nome)
        .filter(Boolean);

      if (nomesOutros.length > 0) {
        // remove duplicados e monta string "Arraial do Cabo, Búzios"
        const listaNomes = Array.from(new Set(nomesOutros)).join(", ");
        const nomePedida = cidadeAlvo?.nome || "sua cidade solicitada";
        avisoCidade =
          `*Aviso:* não encontrei indicações **seguras** em **${nomePedida}**, ` +
          `mas tenho **ótimas opções** em **${listaNomes}**.`;
      }
    }
  }
} catch (e) {
  // Não deixa o aviso quebrar a resposta — silêncio em caso de erro.
}

// Gera a resposta de lista (como você já fazia)
const respostaLista = await gerarRespostaDeListaParceiros(
  message,
  null,
  combinados,
  categoriaAlvo || null
);

// >>> NOVO: prepend do aviso (se houver)
const respostaVendedorNato = avisoCidade
  ? `${avisoCidade}\n\n${respostaLista}`
  : respostaLista;

return res.json({
  ok: true,
  tipo: "parceiro",
  origem: "try2_try3",
  count_try2: parceirosTry2?.length || 0,
  count_try3: parceirosTry3?.length || 0,
  resposta: respostaVendedorNato,
  parceiros_try2: parceirosTry2 || [],
  parceiros_try3: parceirosTry3 || [],
});


    }

    // ===================== CLIMA =====================
    if (tipoIntencao === "clima") {
      // Se você tiver um serviço real de clima, chame-o aqui.
      // Mantendo compatível: devolve mensagem simples por ora.
      const respostaClima = "Consultando dados internos de clima... me diga a cidade para eu checar.";
      return res.json({ ok: true, tipo: "clima", resposta: respostaClima });
    }

    // ===================== ROTA =====================
    if (tipoIntencao === "rota") {
      const textoRota = await montarTextoDeRota({ slugDaRegiao, pergunta: message });
      return res.json({ ok: true, tipo: "rota", resposta: textoRota });
    }

    // ===================== GERAL =====================
    const respostaGeral = await gerarRespostaGeral({
      pergunta: message,
      slugDaRegiao,
      conversaId: conversationId,
    });
    return res.json({ ok: true, tipo: "geral", resposta: respostaGeral });

  } catch (e) {
    console.error("[/api/chat] Erro:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// === FIM DO BLOCO DA ROTA DO CHAT ===


// ------------------------------ AVISOS PÚBLICOS -----------------------------
// (Baseado no [cite: 410-415] - Rota de Avisos mantida)
app.get("/api/avisos/:slugDaRegiao", async (req, res) => {
  try {
    const { slugDaRegiao } = req.params;
    const { data: regiao, error: erroRegiao } = await supabase.from("regioes").select("id").eq("slug", slugDaRegiao).single();
    if (erroRegiao || !regiao) {
      return res.status(404).json({ error: "Região não encontrada." });
    }
    const { data: avisos, error: erroAvisos } = await supabase
      .from("avisos_publicos")
      .select(`id, regiao_id, cidade_id, titulo, descricao, periodo_inicio, periodo_fim, ativo, created_at, cidades:cidade_id ( nome )`)
      .eq("regiao_id", regiao.id)
      .eq("ativo", true)
      .order("periodo_inicio", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false, nullsFirst: false });
    if (erroAvisos) throw erroAvisos;
    const normalized = (avisos || []).map((a) => ({
      id: a.id,
      regiao_id: a.regiao_id,
      cidade_id: a.cidade_id,
      cidade_nome: a?.cidades?.nome || null,
      titulo: a.titulo,
      descricao: a.descricao,
      periodo_inicio: a.periodo_inicio,
      periodo_fim: a.periodo_fim,
      ativo: a.ativo === true,
      created_at: a.created_at,
    }));
    return res.status(200).json({ data: normalized });
  } catch (erro) {
    console.error("[/api/avisos/:slugDaRegiao] Erro:", erro);
    return res.status(500).json({ error: "Erro interno no servidor ao buscar avisos." });
  }
});
// ---------------------------------------------------------------------------


// ------------------------------ STARTUP -------------------------------------
app
  .listen(PORT, HOST, () => {
    console.log(`[BOOT] BEPIT ouvindo em http://${HOST}:${PORT}`);
    console.log(`[BOOT] v6.3 (Vendedor Nato + Refinamento Dinâmico) ATIVO.`);
    printRoutes(app, "app");
  })
  .on("error", (err) => {
    console.error("[BOOT] Falha ao subir servidor:", err);
    process.exit(1);
  });
process.on("SIGTERM", () => {
  console.log("[SHUTDOWN] Recebido SIGTERM. Encerrando...");
  process.exit(0);
});
// ============================================================================

export default app;

// ============================================================================
// ====================== TREINO/VALIDAÇÃO — 50 Q&As ==========================
// Uso: material de referência para afinar respostas. NÃO usado em runtime.
// ============================================================================
export const TRAINING_QA = [
  { q: "Quero 5 restaurantes em Cabo Frio com picanha", a: "Aqui vão algumas indicações confiáveis em Cabo Frio com foco em picanha: (listar parceiros internos). Posso refinar por orçamento ou bairro se preferir." },
  { q: "Sugere um bar com música ao vivo em Búzios?", a: "Tenho estas indicações confiáveis em Búzios: (listar parceiros internos). Se quiser um clima mais tranquilo, posso sugerir outras opções." },
  { q: "Onde jantar com vista para o mar em Arraial do Cabo?", a: "Estas são indicações confiáveis com vista: (listar parceiros internos). Quer uma faixa de preço específica?" },
  { q: "Quero uma pizzaria barata em São Pedro da Aldeia", a: "Indicações confiáveis com boa relação custo-benefício: (listar parceiros internos). Posso filtrar por bairro." },
  { q: "Passeio de barco em Arraial hoje está bom?", a: "Consultando dados internos de clima e mar. Se o mar estiver calmo e o vento baixo pela manhã, vale o passeio. Caso contrário, recomendo atividades em terra. (Resumo curto usando dados de dados_climaticos)." },
  { q: "Como está o clima agora em Cabo Frio?", a: "Dados internos mostram as condições atuais. (Condição + temperatura). Posso sugerir atividades adequadas para este horário." },
  { q: "Vai chover em Búzios amanhã?", a: "Verifico a previsão diária em dados internos. Se a previsão não estiver consolidada, aviso com honestidade." },
  { q: "Temperatura da água em Arraial está boa para mergulho?", a: "Uso dados internos de temperatura da água. Se estiver acima de ~22°C, digo que está agradável para mergulho." },
  { q: "Quero hamburgueria em Cabo Frio", a: "Indicações confiáveis: (listar parceiros internos). Posso priorizar opções com ambiente familiar ou delivery." },
  { q: "Restaurantes para família em Búzios", a: "Sugestões confiáveis para ir com família: (listar parceiros). Quer com área kids?" },
  { q: "Onde tomar café da manhã em Arraial?", a: "Estas são opções confiáveis: (padarias/cafeterias parceiras). Posso ordenar por proximidade do Centro." },
  { q: "Melhor churrascaria em São Pedro da Aldeia", a: "Indicações confiáveis: (listar parceiros). Quer rodízio ou a la carte?" },
  { q: "Onde encontro peixe fresco para almoço em Cabo Frio?", a: "Indicações confiáveis com foco em frutos do mar: (listar parceiros). Posso sugerir pratos assinatura." },
  { q: "Passeios ao pôr do sol em Búzios", a: "Para o fim de tarde/noite, recomendo atividades em terra e polos gastronômicos. (Jamais sugira barco à noite)." },
  { q: "Quero bar para ver o jogo", a: "Posso indicar bares parceiros com TVs, sem citar futebol em detalhes. (Listar parceiros)." },
  { q: "Qual a melhor praia hoje?", a: "Com base nos dados internos de vento/ondas, indico praia mais protegida. Se o mar estiver agitado, sugiro alternativas em terra." },
  { q: "Como chegar em Cabo Frio saindo de Nova Iguaçu?", a: "Rota humana: Dutra → Linha Vermelha → Av. Brasil → Ponte Rio–Niterói → BR-101 → Via Lagos (RJ-124) → RJ-106/RJ-140 até Cabo Frio." },
  { q: "Como ir de Búzios para Arraial do Cabo?", a: "Use RJ-102/RJ-106 até Cabo Frio e siga a RJ-140 em direção a Arraial. Ao chegar, use Av. Gov. Leonel Brizola para acessar as praias." },
  { q: "Tem caixa 24 horas perto do Centro de Cabo Frio?", a: "Posso indicar serviços públicos bancários por consulta pública. (Informar de forma genérica, sem nomes privados específicos)." },
  { q: "Farmácia 24h em Búzios", a: "Posso orientar serviços públicos de saúde/farmácia por consulta pública. Procure as vias principais (ex.: José Bento Ribeiro Dantas) para encontrar as unidades listadas publicamente." },
  { q: "Polícia/Guarda Municipal em Arraial", a: "Indico contatos/ofícios públicos por consulta pública (sem nomes privados). Posso orientar esquema de plantão e localizações gerais." },
  { q: "Capitania dos Portos mais próxima", a: "Indicação pública: Capitania dos Portos (consulta pública). Posso dar orientações gerais de acesso." },
  { q: "Hospital de referência em Cabo Frio", a: "Serviço público: Hospital municipal/regional (consulta pública). Siga pela Av. América Central e vias sinalizadas." },
  { q: "Emergência médica em Búzios", a: "Procure UPA/serviço de emergência público (consulta pública). Oriente-se pela via principal." },
  { q: "Delegacia em Arraial do Cabo", a: "Indicação pública (consulta pública). Posso orientar trajeto humano até lá." },
  { q: "Onde fica o Shopping Park Lagos?", a: "Referência urbana em Cabo Frio. Posso explicar como chegar com base nas vias principais sem links." },
  { q: "Quero um bistrô romântico em Búzios", a: "Indicações confiáveis (parceiros). Posso priorizar ambiente intimista e preço médio." },
  { q: "Pousada pé na areia em Arraial", a: "Posso indicar apenas parceiros internos cadastrados. Se não houver, não indico serviços privados externos." },
  { q: "Hotel barato em Cabo Frio", a: "Indico somente parceiros internos. Se preferir hostel, posso filtrar." },
  { q: "Passeio de buggy em Arraial", a: "Indicações confiáveis (parceiros). Posso falar sobre duração média e pontos visitados." },
  { q: "Tour de lancha em Búzios", a: "Indicações confiáveis (parceiros). Checar condições do mar conforme dados internos." },
  { q: "Onde comer moqueca em Cabo Frio", a: "Indicações confiáveis (parceiros com foco em frutos do mar). Posso sugerir pratos assinatura." },
  { q: "Hambúrguer artesanal em São Pedro", a: "Indicações confiáveis. Quer opção com música ao vivo?" },
  { q: "Churrasco em família domingo", a: "Indicações confiáveis com ambiente familiar. Posso filtrar por estacionamento." },
  { q: "Café e padaria para manhã cedo", a: "Indicações confiáveis (parceiros padaria/cafeteria). Se quiser, vejo alternativas próximas do seu bairro." },
  { q: "Lugar com vista para fotos", a: "Indico parceiros e pontos públicos populares (consulta pública), evitando citar serviços privados externos." },
  { q: "Qual praia está mais protegida do vento hoje?", a: "Com dados internos de vento/ondas, indico praias mais abrigadas. Se o vento estiver alto, recomendo atividades em terra." },
  { q: "Roteiro rápido em Búzios à noite", a: "Sugestão noturna: caminhada na Rua das Pedras / polo gastronômico (sem praia ou barco). Posso incluir indicações confiáveis de restaurantes." },
  { q: "Onde alugar carro?", a: "Indico apenas parceiros internos. Se não houver, explico que não recomendo serviços privados externos." },
  { q: "Transfer do aeroporto para Arraial", a: "Indicações confiáveis de transfer (parceiros). Posso estimar duração do trajeto." },
  { q: "Onde encontro sushi em Cabo Frio", a: "Indicações confiáveis (parceiros). Quer ambiente mais sofisticado ou simples?" },
  { q: "Bar com chope gelado em Búzios", a: "Indicações confiáveis. Se quiser música ao vivo, aviso quais dias e horários típicos." },
  { q: "Lanchonete rápida perto da rodoviária", a: "Indicações confiáveis. Posso orientar rotas simples a pé." },
  { q: "Passeio para família com crianças", a: "Indicações confiáveis (parceiros family-friendly). Se o tempo estiver ruim, sugiro opções em áreas internas." },
  { q: "Onde ver o pôr do sol", a: "Indico pontos públicos (consulta pública) e, se houver, parceiros com vista privilegiada." },
  { q: "Frutos do mar com preço justo", a: "Indicações confiáveis (parceiros). Posso ajustar pelo seu orçamento." },
  { q: "Pizza para grupo grande", a: "Indicações confiáveis que atendem grupos. Posso sugerir reservas e horários ideais." },
  { q: "Bar tranquilo sem música alta", a: "Indicações confiáveis conforme perfil. Posso sugerir bairros mais calmos." },
  { q: "Está ventando muito hoje?", a: "Consulto dados internos atuais. Se vento >5 m/s, menciono esportes a vela; se muito alto, recomendo atividades em terra." },
  { q: "Como ir de Cabo Frio para Búzios à noite?", a: "Explique trajeto humano: RJ-106 até o acesso da RJ-102 para Búzios; evite praia/banho noturno; foque em polo gastronômico." },
];
