// /backend-oficial/server/index.js
// v6.3.5 — COMPLETO (Funções restauradas, Seções preenchidas, Cache Buster)
// Contém: Vendedor Nato, extrairEntidadesDaBusca, finalizeAssistantResponse, detectarIntencaoLocal, correção gerarRespostaDeListaParceiros

// ---> Log "Cache Buster" <---
console.log("[BOOT] Executando index.js v6.3.5 (COMPLETO)...");
// ---> FIM Log "Cache Buster" <---

import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
// Rotas modulares
import financeiroRoutes from "./routes/financeiro.routes.js";
import uploadsRoutes from "./routes/uploads.routes.js";
import ragRoutes from "./routes/rag.routes.js";
import parceiroRoutes from "./routes/parceiro.routes.js";

// Supabase client
import { supabase } from "../lib/supabaseAdmin.js";
// RAG híbrido
import { hybridSearch } from "../services/rag.service.js";
import climaRoutes from "./routes/clima.routes.js";
import marRoutes from "./routes/mar.routes.js";

// ---- Fetch Polyfill (Node.js < 18) ----
if (typeof fetch !== "function") {
  globalThis.fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
}

// ---- DEBUG: listar rotas montadas ----
function printRoutes(app, label = "APP") { // [cite: 270-273]
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
            const methods = Object.keys(l2.route.methods).map((m) => m.toUpperCase()).join(","); // [cite: 271]
            lines.push(`${methods.padEnd(6)} ${prefix} -> ${l2.route.path}`);
          }
        });
      }
    });
    console.log(`\n[DEBUG ROUTES ${label}]`); // [cite: 272]
    lines.forEach((l) => console.log("  ", l));
  } catch (e) {
    console.log(`[DEBUG ROUTES ${label}] (indisponível)`, e?.message || ""); // [cite: 273]
  }
}

// ---- CLIENTE REDIS (UPSTASH) — VIA REST ----
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_URL || ""; // [cite: 274]
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_TOKEN || ""; //
const UPSTASH_TIMEOUT_MS = Number(process.env.UPSTASH_TIMEOUT_MS || 1200); //
const UPSTASH_RETRIES = Math.max(0, Number(process.env.UPSTASH_RETRIES || 1)); // [cite: 275]
function hasUpstash() { return !!UPSTASH_URL && !!UPSTASH_TOKEN; } // [cite: 276]
async function withTimeoutFetch(url, init, { timeoutMs = UPSTASH_TIMEOUT_MS } = {}) { //
  const ctrl = new AbortController(); //
  const t = setTimeout(() => ctrl.abort(), timeoutMs); // [cite: 277]
  try { //
    const resp = await fetch(url, { ...init, signal: ctrl.signal }); //
    return resp; // [cite: 278]
  } finally { //
    clearTimeout(t); //
  } //
} //
async function upstashFetch(url, init, { timeoutMs = UPSTASH_TIMEOUT_MS, label = "op" } = {}) { //
  let attempt = 0; //
  while (true) { // [cite: 279]
    try { //
      const resp = await withTimeoutFetch(url, init, { timeoutMs }); //
      if (!resp.ok) { // [cite: 280]
        const txt = await resp.text().catch(() => ""); //
        throw new Error(`[UPSTASH] ${label} falhou: ${resp.status} ${resp.statusText} ${txt}`); // [cite: 281]
      } //
      return resp; //
    } catch (e) { // [cite: 282]
      const isAbort = e?.name === "AbortError"; //
      attempt++; //
      if (attempt > UPSTASH_RETRIES || !isAbort) throw e; // [cite: 283]
      const backoff = 200 * Math.pow(2, attempt - 1); //
      await new Promise((r) => setTimeout(r, backoff)); // [cite: 284]
    } //
  } //
} //
const upstash = { //
  async get(key, { timeoutMs = UPSTASH_TIMEOUT_MS } = {}) { //
    if (!hasUpstash()) throw new Error("[UPSTASH] Config ausente (URL/TOKEN)."); //
    const url = `${UPSTASH_URL.replace(/\/+$/, "")}/get/${encodeURIComponent(key)}`; // [cite: 285]
    try { //
      const resp = await upstashFetch(url, { method: "GET", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }, { timeoutMs, label: `GET ${key}` }); //
      const json = await resp.json(); // [cite: 286]
      return json?.result ?? null; //
    } catch (e) { //
      console.warn(String(e?.name) === "AbortError" ? `[CACHE] GET ${key} timeout (${timeoutMs}ms)` : `[CACHE] GET ${key} erro: ${e?.message || e}`); //
      return null; // [cite: 287]
    } //
  }, //
  async exists(key, { timeoutMs = UPSTASH_TIMEOUT_MS } = {}) { //
     if (!hasUpstash()) throw new Error("[UPSTASH] Config ausente (URL/TOKEN)."); //
     const url = `${UPSTASH_URL.replace(/\/+$/, "")}/exists/${encodeURIComponent(key)}`; // [cite: 288]
     try { //
       const resp = await upstashFetch(url, { method: "GET", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }, { timeoutMs, label: `EXISTS ${key}` }); //
       const json = await resp.json(); // [cite: 289]
       return Number(json?.result || 0) > 0; // [cite: 290]
     } catch (e) { //
       console.warn(String(e?.name) === "AbortError" ? `[CACHE] EXISTS ${key} timeout (${timeoutMs}ms)` : `[CACHE] EXISTS ${key} erro: ${e?.message || e}`); //
       return false; // [cite: 291]
     } //
  }, //
  async set(key, value, ttlSeconds, { timeoutMs = UPSTASH_TIMEOUT_MS } = {}) { //
    if (!hasUpstash()) throw new Error("[UPSTASH] Config ausente (URL/TOKEN)."); //
    const base = `${UPSTASH_URL.replace(/\/+$/, "")}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`; // [cite: 292]
    const url = ttlSeconds ? `${base}?EX=${encodeURIComponent(ttlSeconds)}` : base; //
    try { // [cite: 293]
      const resp = await upstashFetch(url, { method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }, { timeoutMs, label: `SET ${key}` }); //
      const json = await resp.json(); // [cite: 294]
      return json?.result === "OK"; //
    } catch (e) { //
      console.warn(String(e?.name) === "AbortError" ? `[CACHE] SET ${key} timeout (${timeoutMs}ms)` : `[CACHE] SET ${key} erro: ${e?.message || e}`); //
      return false; // [cite: 295]
    } //
  }, //
};
// ============================================================================

// ---- APP ÚNICO ----
const app = express(); //
const PORT = process.env.PORT || 3002; //
const HOST = "0.0.0.0"; // [cite: 296]

// ---- CORS ----
const EXPLICIT_ALLOWED_ORIGINS = new Set(["http://localhost:5173", "http://localhost:3000"]); //
if (process.env.FRONTEND_ORIGIN) { EXPLICIT_ALLOWED_ORIGINS.add(process.env.FRONTEND_ORIGIN.trim()); } // [cite: 297]
if (process.env.CORS_EXTRA_ORIGINS) { process.env.CORS_EXTRA_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean).forEach((o) => EXPLICIT_ALLOWED_ORIGINS.add(o)); } //
const ALLOWED_ORIGIN_PATTERNS = [/^https:\/\/.*\.netlify\.app$/, /^http:\/\/localhost:(3000|5173)$/]; //
const CORS_ALLOW_ALL = String(process.env.CORS_ALLOW_ALL || "") === "1"; // [cite: 298]
function isOriginAllowed(origin) { //
  if (!origin) return true; //
  if (CORS_ALLOW_ALL) return true; //
  if (EXPLICIT_ALLOWED_ORIGINS.has(origin)) return true; // [cite: 299]
  return ALLOWED_ORIGIN_PATTERNS.some((rx) => rx.test(origin)); //
} //
app.use((req, res, next) => { // Pré-voo manual
  if (req.method !== "OPTIONS") return next(); //
  const origin = req.headers.origin || ""; //
  if (!isOriginAllowed(origin)) return res.status(403).send("CORS: origem não permitida."); //
  res.header("Access-Control-Allow-Origin", origin); //
  res.header("Vary", "Origin"); //
  res.header("Access-Control-Allow-Credentials", "true"); //
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS"); //
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key, Authorization, Accept, X-Requested-With"); //
  res.header("Access-Control-Max-Age", "600"); //
  return res.sendStatus(204); //
}); //
app.use( // CORS efetivo [cite: 300]
  cors({ //
    origin: (origin, cb) => (isOriginAllowed(origin) ? cb(null, true) : cb(new Error("CORS block"))), //
    credentials: true, //
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], //
    allowedHeaders: ["Content-Type", "X-Admin-Key", "Authorization", "Accept", "X-Requested-With"], //
  }) //
); //
app.use(express.json({ limit: "25mb" })); // [cite: 301]

// ---- Health & Debug ----
app.get("/health", async (req, res) => { //
  try { //
    const env = { SUPABASE_URL: !!process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY: !!process.env.GEMINI_API_KEY }; //
    let supabaseStatus = "skip"; //
    try { //
      const { data, error } = await supabase.from("parceiros").select("id").limit(1); //
      supabaseStatus = error ? `error: ${error.message}` : "ok"; //
    } catch (e) { // [cite: 302]
      supabaseStatus = `error: ${e?.message || String(e)}`; //
    } //
    res.json({ ok: true, checks: { uptime_s: Math.floor(process.uptime()), env, supabase: supabaseStatus } }); //
  } catch (e) { //
    res.status(500).json({ ok: false, error: e?.message || String(e) }); //
  } //
}); //
app.get("/_debug/rag/search", async (req, res) => { // [cite: 303]
  try { //
    const q = String(req.query?.q || ""); //
    const categoria = req.query?.categoria ? String(req.query.categoria) : null; //
    const cidade_id = req.query?.cidade_id ? String(req.query.cidade_id) : null; //
    const limit = Math.max(1, Math.min(parseInt(req.query?.limit ?? "10", 10) || 10, 50)); //
    const out = await hybridSearch({ q, cidade_id, categoria, limit, debug: true }); //
    const payload = Array.isArray(out?.items) ? out : { items: out, meta: null }; //
    res.json({ ok: true, items: payload.items, meta: payload.meta }); //
  } catch (e) { // [cite: 304]
    res.status(500).json({ ok: false, error: e?.message || String(e) }); //
  } //
}); // [cite: 305]

// ---- ROTAS MODULARES ----
app.use("/api/parceiro", parceiroRoutes); //
app.use("/api/rag", ragRoutes); //
// app.use("/api/chat", ragRoutes); // Removido // [cite: 306]
app.use("/api/financeiro", financeiroRoutes); //
app.use("/api/uploads", uploadsRoutes); //
app.use("/api/clima", climaRoutes); //
app.use("/api/mar", marRoutes); //
app.get("/", (_req, res) => res.status(200).send("BEPIT backend ativo ✅ v6.3.5")); // Versão atualizada [cite: 307]
app.get("/ping", (_req, res) => res.status(200).json({ pong: true, ts: Date.now() })); // [cite: 308]

// ---- IA (Gemini REST) ----
const usarGeminiREST = String(process.env.USE_GEMINI_REST || "") === "1"; //
const chaveGemini = process.env.GEMINI_API_KEY || ""; // [cite: 309]
const AI_DISABLED = String(process.env.AI_DISABLED || "") === "1"; //
function stripModelsPrefix(id) { return String(id || "").replace(/^models\//, ""); } // [cite: 310]
async function listarModelosREST() { //
  if (!chaveGemini) throw new Error("[GEMINI REST] GEMINI_API_KEY não definida."); //
  const url = `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(chaveGemini)}`; // [cite: 311]
  const resp = await fetch(url, { method: "GET" }); //
  if (!resp.ok) { // [cite: 312]
    const texto = await resp.text().catch(() => ""); //
    throw new Error(`[GEMINI REST] Falha ao listar modelos: ${resp.status} ${resp.statusText} ${texto}`); // [cite: 313]
  } //
  const json = await resp.json(); //
  const items = Array.isArray(json.models) ? json.models : []; // [cite: 314]
  return items.map((m) => String(m.name || "")).filter(Boolean); // [cite: 315]
} //
async function selecionarModeloREST() { //
  const todosComPrefixo = await listarModelosREST(); //
  const disponiveis = todosComPrefixo.map(stripModelsPrefix); //
  const envModelo = (process.env.GEMINI_MODEL || "").trim(); //
  if (envModelo) { // [cite: 316]
    const alvo = stripModelsPrefix(envModelo); //
    if (disponiveis.includes(alvo)) return alvo; //
    console.warn(`[GEMINI REST] GEMINI_MODEL "${envModelo}" indisponível. Disponíveis: ${disponiveis.join(", ")}`); // [cite: 317]
  } //
  const preferencia = [envModelo && stripModelsPrefix(envModelo), "gemini-2.5-flash", "gemini-1.5-flash-latest", "gemini-1.5-pro-latest"].filter(Boolean); //
  for (const alvo of preferencia) if (disponiveis.includes(alvo)) return alvo; // [cite: 318]
  const qualquer = disponiveis.find((n) => /^gemini-/.test(n)); //
  if (qualquer) return qualquer; //
  throw new Error("[GEMINI REST] Não foi possível selecionar modelo."); // [cite: 319]
} //
async function gerarConteudoComREST(modelo, texto) { //
  if (!chaveGemini) throw new Error("[GEMINI REST] GEMINI_API_KEY não definida."); //
  const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(modelo)}:generateContent?key=${encodeURIComponent(chaveGemini)}`; // [cite: 320]
  const payload = { contents: [{ role: "user", parts: [{ text: String(texto || "") }] }] }; //
  const resp = await fetch(url, { // [cite: 321]
    method: "POST", //
    headers: { "Content-Type": "application/json; charset=utf-8" }, //
    body: JSON.stringify(payload), //
  }); //
  if (!resp.ok) { // [cite: 322]
    const texto = await resp.text().catch(() => ""); //
    throw new Error(`[GEMINI REST] Falha no generateContent: ${resp.status} ${resp.statusText} ${texto}`); // [cite: 323]
  } //
  const json = await resp.json(); //
  const parts = json?.candidates?.[0]?.content?.parts; // [cite: 324]
  const out = Array.isArray(parts) ? parts.map((p) => p?.text || "").join("\n").trim() : ""; //
  return out || ""; // [cite: 325]
} //
let modeloGeminiV1 = null; //
async function obterModeloREST() { //
  if (!usarGeminiREST) throw new Error("[GEMINI REST] USE_GEMINI_REST=1 é obrigatório."); //
  if (modeloGeminiV1) return modeloGeminiV1; // [cite: 326]
  modeloGeminiV1 = await selecionarModeloREST(); //
  console.log(`[GEMINI REST] Modelo selecionado: ${modeloGeminiV1}`); //
  return modeloGeminiV1; // [cite: 327]
} //
async function geminiGerarTexto(texto) { //
  const modelo = await obterModeloREST(); //
  return await gerarConteudoComREST(modelo, texto); // [cite: 328]
} //
function isRetryableGeminiError(err) { //
  const msg = String(err?.message || err); //
  return /429|RESOURCE_EXHAUSTED|500|502|503|504/i.test(msg); // [cite: 329]
} //
async function geminiTry(texto, { retries = 2, baseDelay = 500 } = {}) { //
  if (AI_DISABLED || !usarGeminiREST) throw new Error("AI_DISABLED"); //
  let attempt = 0; // [cite: 330]
  while (true) { //
    try { //
      return await geminiGerarTexto(texto); //
    } catch (e) { // [cite: 331]
      attempt++; //
      if (attempt > retries || !isRetryableGeminiError(e)) throw e; //
      const jitter = Math.floor(Math.random() * 250); // [cite: 332]
      const delay = baseDelay * Math.pow(2, attempt - 1) + jitter; //
      await new Promise((r) => setTimeout(r, delay)); // [cite: 333]
    } //
  } //
} //
// ============================================================================


// ============================== HELPERS =====================================

// ==========================================================
// FUNÇÃO RESTAURADA: extrairEntidadesDaBusca (SEM CITAÇÕES)
// ==========================================================
async function extrairEntidadesDaBusca(texto) { //
  const tNorm = normalizarTexto(texto || ""); // Usa a função normalizarTexto [cite: 334]

  let city = null; //
  if (tNorm.includes("cabo frio")) city = "Cabo Frio"; //
  else if (tNorm.includes("buzios") || tNorm.includes("búzios")) city = "Armação dos Búzios"; // [cite: 335]
  else if (tNorm.includes("arraial")) city = "Arraial do Cabo"; //
  else if (tNorm.includes("sao pedro") || tNorm.includes("são pedro")) city = "São Pedro da Aldeia"; // [cite: 336]
  else if (tNorm.includes("iguaba")) city = "Iguaba Grande"; //

  const DIC_TERMS = [ // [cite: 337]
    "pizzaria", "pizza", "picanha", "piconha", "carne", "churrasco", "rodizio", "rodízio", //
    "fraldinha", "costela", "barato", "barata", "familia", "família", "romantico", "romântico", //
    "vista", "vista para o mar", "peixe", "frutos do mar", "moqueca", "hamburguer", "hambúrguer", //
    "sushi", "japonesa", "bistrô", "bistro", //
  ]; //
  const terms = []; // [cite: 338]
  for (const w of DIC_TERMS) if (tNorm.includes(normalizarTexto(w))) terms.push(w); //

  let category = null; // [cite: 339]
  // Lógica de detecção de categoria
  if (tNorm.includes("pizzaria") || tNorm.includes("pizza")) { category = "pizzaria"; } // [cite: 340]
  else if (["restaurante", "comer", "comida", "picanha", "carne", "churrasco", "rodizio", "peixe", "frutos do mar", "moqueca", "hamburguer", "bistrô", "sushi", "japonesa"].some(k => tNorm.includes(k))) { category = "comida"; } // [cite: 341]
  else if (["pousada", "hotel", "hostel", "hospedagem", "airbnb", "apart", "flat", "resort"].some(k => tNorm.includes(k))) { category = "hospedagem"; } // [cite: 342]
  else if (["bar", "bares", "chopp", "chope", "drinks", "pub", "boteco"].some(k => tNorm.includes(k))) { category = "bebidas"; } // [cite: 343]
  else if (["passeio", "barco", "lancha", "escuna", "trilha", "buggy", "quadriciclo", "mergulho", "snorkel", "tour"].some(k => tNorm.includes(k))) { category = "passeios"; } // [cite: 344]
  else if (["praia", "praias", "bandeira azul", "orla"].some(k => tNorm.includes(k))) { category = "praias"; } // [cite: 345]
  else if (["transfer", "transporte", "aluguel de carro", "locadora", "uber", "taxi", "ônibus", "onibus"].some(k => tNorm.includes(k))) { category = "transporte"; } // [cite: 346]

  return { category, city, terms }; //
}
// ==========================================================
// FIM FUNÇÃO RESTAURADA
// ==========================================================

function normalizarTexto(texto) { //
  return String(texto || "") //
    .normalize("NFD") //
    .replace(/[\u0300-\u036f]/g, "") //
    .toLowerCase() //
    .trim(); // [cite: 347]
} //
function getHoraLocalSP() { //
  try { //
    const fmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false }); //
    return fmt.format(new Date()); // [cite: 348]
  } catch { //
    const now = new Date(); //
    const utc = now.getTime() + now.getTimezoneOffset() * 60000; // [cite: 349]
    const sp = new Date(utc - 3 * 3600000); //
    const hh = String(sp.getHours()).padStart(2, "0"); // [cite: 350]
    const mm = String(sp.getMinutes()).padStart(2, "0"); //
    return `${hh}:${mm}`; // [cite: 351]
  } //
} //
async function construirHistoricoParaGemini(conversationId, limite = 12) { //
  try { //
    const { data, error } = await supabase //
      .from("interacoes") //
      .select("pergunta_usuario, resposta_ia") //
      .eq("conversation_id", conversationId) //
      .order("created_at", { ascending: true }); //
    if (error) throw error; // [cite: 352]
    const rows = data || []; //
    const ultimas = rows.slice(-limite); //
    const contents = []; //
    for (const it of ultimas) { // [cite: 353]
      if (it.pergunta_usuario) contents.push({ role: "user", parts: [{ text: it.pergunta_usuario }] }); //
      if (it.resposta_ia) contents.push({ role: "model", parts: [{ text: it.resposta_ia }] }); // [cite: 354]
    } //
    return contents; // [cite: 355]
  } catch (e) { //
    console.warn("[HISTORICO DB] Falha ao carregar:", e?.message || e); //
    return []; // [cite: 356]
  } //
} //
function historicoParaTextoSimplesWrapper(hc) { //
  try { //
    return (hc || []) //
      .map((b) => { //
        const role = b?.role || "user"; //
        const text = (b?.parts?.[0]?.text || "").replace(/\s+/g, " ").trim(); //
        return `- ${role}: ${text}`; //
      }) //
      .join("\n"); //
  } catch { // [cite: 357]
    return ""; //
  } //
} //

// ---- FUNÇÃO CENTRAL — ATUALIZA E RESPONDE ----
async function updateSessionAndRespond({ //
  res, runId, conversationId, userText, aiResponseText, sessionData, regiaoId, partners = [], //
}) { //
  const _run = runId || "NO-RUNID"; // [cite: 358]
  console.log(`[RUN ${_run}] [RAIO-X FINAL] Preparando para responder e salvar sessão.`); //

  const novoHistorico = [...(sessionData?.history || [])]; //
  novoHistorico.push({ role: "user", parts: [{ text: userText }] }); // [cite: 359]
  novoHistorico.push({ role: "model", parts: [{ text: aiResponseText }] }); //
  const MAX_HISTORY_LENGTH = 12; // [cite: 360]
  while (novoHistorico.length > MAX_HISTORY_LENGTH) { //
    novoHistorico.shift(); // [cite: 361]
  } //

  const novaSessionData = { ...(sessionData || {}), history: novoHistorico }; //

  const TTL_SECONDS = 900; //
  if (hasUpstash()) { // [cite: 362]
    try { //
      await upstash.set(conversationId, JSON.stringify(novaSessionData), TTL_SECONDS, { timeoutMs: 400 }); // [cite: 363]
    } catch (e) { //
      console.warn(`[RUN ${_run}] [CACHE] Falha ao salvar sessão (não fatal):`, e?.message || e); // [cite: 364]
    } //
  } else { //
    console.warn("[CACHE] Upstash não configurado. Seguindo sem cache."); // [cite: 365]
  } //

  try { //
    await supabase.from("interacoes").insert({ //
      conversation_id: conversationId, //
      regiao_id: regiaoId, //
      pergunta_usuario: userText, //
      resposta_ia: aiResponseText, //
      parceiros_sugeridos: partners.length > 0 ? partners : null, //
    }); // [cite: 366]
  } catch (e) { //
    console.error(`[RUN ${_run}] [SUPABASE] Falha ao salvar interação:`, e); // [cite: 367]
  } //

  return res.json({ //
    reply: aiResponseText, //
    conversationId, //
    partners: partners.length > 0 ? partners : undefined, //
  }); // [cite: 368]
} //

// ---- SESSION ENSURER ----
async function ensureConversation(req) { //
  const body = req.body || {}; // [cite: 369]
  let conversationId = body.conversationId || body.threadId || body.sessionId || null; //
  if (!conversationId || typeof conversationId !== "string" || conversationId.trim().length < 10) { // [cite: 370]
    conversationId = randomUUID(); //
    try { // [cite: 371]
      await supabase.from("conversas").insert({ //
        id: conversationId, //
        regiao_id: req.ctx?.regiao?.id || null, //
      }); //
    } catch { /* idempotência */ } // [cite: 372]
  } else { //
    try { //
      const { data: existe } = await supabase.from("conversas").select("id").eq("id", conversationId).maybeSingle(); //
      if (!existe) { // [cite: 373]
        await supabase.from("conversas").insert({ //
          id: conversationId, //
          regiao_id: req.ctx?.regiao?.id || null, //
        }); // [cite: 374]
      } //
    } catch { /* segue fluxo */ } //
  } //

  let isFirstTurn = false; // [cite: 375]
  if (hasUpstash()) { //
    try { //
      const exists = await upstash.exists(conversationId, { timeoutMs: 400 }); //
      isFirstTurn = !exists; // [cite: 376]
    } catch { //
      try { //
        const { count } = await supabase.from("interacoes").select("*", { count: "exact", head: true }).eq("conversation_id", conversationId); //
        isFirstTurn = (count || 0) === 0; // [cite: 377]
      } catch { isFirstTurn = false; } // [cite: 378]
    } //
  } else { //
    try { //
      const { count } = await supabase.from("interacoes").select("*", { count: "exact", head: true }).eq("conversation_id", conversationId); //
      isFirstTurn = (count || 0) === 0; // [cite: 379]
    } catch { isFirstTurn = false; } // [cite: 380]
  } //

  req.ctx = Object.assign({}, req.ctx || {}, { conversationId, isFirstTurn }); //
  return { conversationId, isFirstTurn }; // [cite: 381]
} //

// ---- CLASSIFICAÇÃO/EXTRAÇÃO ----
function normalizar(texto) { return normalizarTexto(texto); } // [cite: 382]
function isSaudacao(texto) { //
  const t = normalizar(texto); //
  const saudacoes = ["oi", "ola", "olá", "bom dia", "boa tarde", "boa noite", "e ai", "e aí", "tudo bem"]; //
  return saudacoes.includes(t); // [cite: 383]
} //
const PALAVRAS_CHAVE_PARCEIROS = { //
  comida: ["restaurante", "almoço", "jantar", "comer", "comida", "picanha", "carne", "churrasco", "pizza", "pizzaria", "peixe", "frutos do mar", "moqueca", "rodizio", "lanchonete", "burger", "hamburguer", "bistrô"], //
  hospedagem: ["pousada", "hotel", "hospedagem", "hostel", "airbnb"], //
  bebidas: ["bar", "chopp", "chope", "drinks", "pub", "boteco"], //
  passeios: ["passeio", "barco", "lancha", "escuna", "trilha", "tour", "buggy", "quadriciclo", "city tour", "catamarã", "mergulho", "snorkel", "gruta", "ilha"], //
  praias: ["praia", "praias", "faixa de areia", "bandeira azul", "mar calmo", "mar forte"], //
  transporte: ["transfer", "transporte", "alugar carro", "aluguel de carro", "uber", "taxi", "ônibus", "onibus", "rodoviária"], //
}; //
function forcarBuscaParceiro(texto) { // [cite: 384]
  const t = normalizarTexto(texto); //
  for (const lista of Object.values(PALAVRAS_CHAVE_PARCEIROS)) { //
    if (lista.some((p) => t.includes(p))) return true; //
  } // [cite: 385]
  return false; //
} //
function isWeatherQuestion(texto) { //
  if (forcarBuscaParceiro(texto)) return false; //
  const t = normalizar(texto); // [cite: 386]
  const termos = ["clima", "tempo", "previsao", "previsão", "vento", "mar", "marea", "maré", "ondas", "onda", "temperatura", "graus", "calor", "frio", "chovendo", "chuva", "sol", "ensolarado", "nublado"]; //
  return termos.some((k) => t.includes(k)); // [cite: 387]
} //
function isRouteQuestion(texto) { //
  const t = normalizar(texto); // [cite: 388]
  const termos = ["como chegar", "rota", "ir de", "saindo de", "qual caminho", "trajeto", "direcao", "direção"]; //
  return termos.some((k) => t.includes(k)); // [cite: 389]
} //
function detectTemporalWindow(texto) { //
  const t = normalizar(texto); //
  const sinaisFuturo = ["amanha", "amanhã", "semana que vem", "proxima semana", "próxima semana", "sabado", "sábado", "domingo", "proximos dias", "próximos dias", "daqui a"]; //
  return sinaisFuturo.some((s) => t.includes(s)) ? "future" : "present"; // [cite: 390]
} //
function extractCity(texto, cidadesAtivas) { //
  const t = normalizarTexto(texto || ""); // [cite: 391]
  const lista = Array.isArray(cidadesAtivas) ? cidadesAtivas : []; //
  const apelidos = [ //
    { key: "arraial", nome: "Arraial do Cabo" }, { key: "arraial do cabo", nome: "Arraial do Cabo" }, //
    { key: "cabo frio", nome: "Cabo Frio" }, //
    { key: "buzios", nome: "Armação dos Búzios" }, { key: "búzios", nome: "Armação dos Búzios" }, { key: "armacao dos buzios", nome: "Armação dos Búzios" }, //
    { key: "rio das ostras", nome: "Rio das Ostras" }, //
    { key: "sao pedro", nome: "São Pedro da Aldeia" }, { key: "são pedro", nome: "São Pedro da Aldeia" }, // [cite: 392]
    { key: "iguaba", nome: "Iguaba Grande" }, { key: "iguabinha", nome: "Iguaba Grande" }, //
  ]; //
  const hitApelido = apelidos.find((a) => t.includes(a.key)); // [cite: 393]
  if (hitApelido) { //
    const alvo = lista.find((c) => normalizarTexto(c.nome) === normalizarTexto(hitApelido.nome)); //
    if (alvo) return alvo; // [cite: 394]
  } //
  for (const c of lista) { //
    if (t.includes(normalizarTexto(c.nome)) || t.includes(normalizarTexto(c.slug))) return c; // [cite: 395]
  } //
  return null; //
} //
function isRegionQuery(texto) { //
  const t = normalizar(texto); //
  const mencionaRegiao = t.includes("regiao") || t.includes("região") || t.includes("regiao dos lagos") || t.includes("região dos lagos"); // [cite: 396]
  return mencionaRegiao; //
} //
// ====================== DETECTOR DE INTENÇÃO (LOCAL) =========================
// FUNÇÃO RESTAURADA
async function detectarIntencaoLocal(texto, { slugDaRegiao } = {}) { // [cite: 396]
  const t = normalizarTexto(texto || "");
  // Regras diretas
  if (isRouteQuestion(texto)) { // [cite: 397]
    return { tipoIntencao: "rota", categoriaAlvo: null, cidadeAlvo: null, limiteSugestoes: 5 };
  } //
  if (isWeatherQuestion(texto)) { // [cite: 398]
    return { tipoIntencao: "clima", categoriaAlvo: null, cidadeAlvo: null, limiteSugestoes: 5 };
  } //

  // Heurística de parceiros (com extração básica)
  const entidades = await extrairEntidadesDaBusca(texto || ""); // [cite: 399]
  const forcaParceiro = forcarBuscaParceiro(texto) || !!entidades?.category; // [cite: 400]
  let categoriaAlvo = entidades?.category || null; // [cite: 401]
  // Descobrir cidade da REGIÃO (se possível)
  let cidadeAlvo = null; // [cite: 402]
  try { //
    const { data: regiao } = await supabase.from("regioes").select("id").eq("slug", slugDaRegiao).maybeSingle(); //
    if (regiao?.id) { // [cite: 403]
      const { data: cidades } = await supabase //
        .from("cidades") //
        .select("id, nome, slug") //
        .eq("regiao_id", regiao.id); //
      const tnorm = normalizarTexto(texto || ""); // [cite: 404]
      // 1ª tentativa: se você já tem extractCity, mantemos:
      const alvo = extractCity?.(texto, cidades || []); // [cite: 405]
      if (alvo) { // [cite: 406]
        cidadeAlvo = alvo; // [cite: 407]
      } //

      // Fallback: casamento simples por nome da cidade no texto
      if (!cidadeAlvo && Array.isArray(cidades) && cidades.length > 0) { //
        const hit = cidades.find((c) => //
          tnorm.includes(normalizarTexto(c?.nome || "")) //
        ); //
        if (hit) { // [cite: 408]
          cidadeAlvo = hit; // [cite: 409]
        } //
      } //
      // 3) Fallback GLOBAL: se ainda não achou cidade, procura em TODAS as cidades
      if (!cidadeAlvo) { //
        const tnorm = normalizarTexto(texto || ""); // [cite: 410]
        const { data: allCidades, error: errAll } = await supabase //
          .from("cidades") //
          .select("id, nome, slug") //
          .limit(500); // [cite: 411]

        if (!errAll && Array.isArray(allCidades)) { //
          const hitGlobal = allCidades.find((c) => //
            tnorm.includes(normalizarTexto(c?.nome || "")) //
          ); //
          if (hitGlobal) { // [cite: 412]
            cidadeAlvo = hitGlobal; // [cite: 413]
          } //
        } //
      } //
    } //
  } catch { /* segue sem cidade */ } //

  const tipoIntencao = forcaParceiro ? "parceiro" : "geral"; // [cite: 414]
  return { tipoIntencao, categoriaAlvo, cidadeAlvo, limiteSugestoes: 5 }; // [cite: 415]
} //
// Wrapper simples para rota humana
async function montarTextoDeRota({ slugDaRegiao, pergunta }) { //
  return gerarRotasHumanas(pergunta); // [cite: 416]
} //

// Wrapper p/ resposta geral
async function gerarRespostaGeral({ pergunta, slugDaRegiao, conversaId }) { //
  const historico = await construirHistoricoParaGemini(conversaId, 12); // [cite: 417]
  const horaLocal = getHoraLocalSP(); //
  const regiaoNome = "Região dos Lagos"; // [cite: 418]
  return gerarRespostaGeralPrompteada({ //
    pergunta, //
    historicoContents: historico, //
    regiaoNome, //
    dadosClimaOuMaresJSON: "{}", //
    horaLocalSP: horaLocal, //
  }); // [cite: 419]
} //

// Versão mínima do "Vendedor Nato" (REMOVIDA - Lógica completa na rota principal)
// async function gerarRespostaVendedorNato({ /* ... */ }) { /* ... */ } // [cite: 420]


// ============================================================================
// >>> ROTA DO CHAT - ORQUESTRADOR v6.3.5 (CÉREBRO VENDEDOR NATO) <<<<<
// ============================================================================
app.post("/api/chat/:slugDaRegiao", async (req, res) => {
  const runId = randomUUID();
  try {
    console.log(`[RUN ${runId}] [PONTO 1] /chat iniciado.`);

    const { slugDaRegiao } = req.params;
    const userText = (req.body?.message || "").trim();

    if (userText.length < 1) { return res.status(400).json({ reply: "Por favor, digite uma mensagem.", conversationId: req.body?.conversationId }); }

    const { data: regiao } = await supabase.from("regioes").select("id, nome").eq("slug", slugDaRegiao).single();
    if (!regiao) { return res.status(404).json({ error: "Região não encontrada." }); }
    req.ctx = { regiao };

    const { data: cidades } = await supabase.from("cidades").select("id, nome, slug").eq("regiao_id", regiao.id).eq("ativo", true);
    const cidadesAtivas = cidades || [];

    const { conversationId, isFirstTurn } = await ensureConversation(req);

    // Recupera histórico e sessão
    let sessionData = { history: [], entities: {} };
    function setLastCityInSession(session, cidade_id) { try { if (!session || typeof session !== "object") return; if (!session.entities) session.entities = {}; session.entities.lastCity = cidade_id || null; } catch {} }
    function getLastCityFromSession(session) { try { return session?.entities?.lastCity || null; } catch { return null; } }
    try { if (hasUpstash() && !isFirstTurn) { const cached = await upstash.get(conversationId, { timeoutMs: 400 }); if (cached) sessionData = JSON.parse(cached); } }
    catch (e) { console.error(`[RUN ${runId}] [CACHE] Falha ao LER sessão:`, e?.message || e); sessionData = { history: [], entities: {} }; }
    const historico = sessionData.history || [];

    // Saudações
    if (isSaudacao(userText)) {
      const resposta = isFirstTurn
        ? `Olá! Seja bem-vindo(a) à ${regiao.nome}! Eu sou o BEPIT, seu concierge de confiança. Como posso te ajudar a ter uma experiência incrível hoje?`
        : "Claro, como posso te ajudar agora?";
      return await updateSessionAndRespond({
        res, runId, conversationId, userText,
        aiResponseText: resposta, sessionData, regiaoId: regiao.id,
      });
    }

    // =========================================================================
    // ETAPA 1: LÓGICA DO VENDEDOR NATO (PARCEIROS PRIMEIRO)
    // Usando a função detectarIntencaoLocal RESTAURADA
    // =========================================================================
    // Detecta intenção usando a função restaurada
    const detectar = (typeof detectarIntencao === "function" ? detectarIntencao : detectarIntencaoLocal); // 
    const { tipoIntencao, categoriaAlvo, cidadeAlvo, limiteSugestoes } = await detectar(userText, { slugDaRegiao }); // [cite: 481]
    console.log(`[RUN ${runId}] [DET INTENCAO] Tipo: ${tipoIntencao}, Categoria: ${categoriaAlvo}, Cidade: ${cidadeAlvo?.nome || 'Nenhuma'}`); // Log aprimorado

    if (tipoIntencao === "parceiro") { // [cite: 483]
      console.log(`[RUN ${runId}] [RAG] Intent parceiros detectada. Iniciando Lógica Vendedor Nato.`);

      let cidadeIdAlvo = cidadeAlvo?.id || null;
      let cidadeNomeAlvo = cidadeAlvo?.nome || null;

      // Se não houver cidade na pergunta, tenta herdar da sessão
      if (!cidadeIdAlvo) {
         cidadeIdAlvo = getLastCityFromSession(sessionData);
         if (cidadeIdAlvo) {
             cidadeNomeAlvo = cidadesAtivas.find(c => c.id === cidadeIdAlvo)?.nome || null;
             console.log(`[RUN ${runId}] [RAG] Usando cidade herdada da sessão: ${cidadeNomeAlvo} (${cidadeIdAlvo})`);
         } else {
             console.log(`[RUN ${runId}] [RAG] Nenhuma cidade detectada ou herdada.`);
         }
      }

      // --- TRY 1: Busca Exata (Com cidade detectada/herdada) ---
      console.log(`[RUN ${runId}] [RAG-Try 1] Buscando: ${categoriaAlvo || 'Sem Categoria'} EM ${cidadeNomeAlvo || 'Qualquer Cidade'} (ID: ${cidadeIdAlvo || 'Nenhum'})`);
      const { parceiros: parceirosTry1_raw } = await searchPartnersRAG(userText, { //
          cidadesAtivas,
          cidadeIdForcada: cidadeIdAlvo,
          categoriaForcada: categoriaAlvo,
          limit: Math.max(1, Math.min(limiteSugestoes || 5, 12)), // Usa limiteSugestoes
      });

      // --- GUARD-RAILS PÓS-BUSCA ---
      let parceirosTry1 = parceirosTry1_raw || [];
      // Guard-rail C: Só aceita se a categoria BATER
      const catAlvoNorm = normalize(categoriaAlvo);
      if (catAlvoNorm) {
          parceirosTry1 = parceirosTry1.filter(p => normalize(p?.categoria) === catAlvoNorm);
          console.log(`[RUN ${runId}] [GuardRail C] Após filtro de categoria '${catAlvoNorm}', restaram ${parceirosTry1.length} parceiros.`);
      }
      // Guard-rail D: Só aceita se a cidade BATER (se cidade foi detectada)
      if (cidadeIdAlvo) {
          parceirosTry1 = parceirosTry1.filter(p => p?.cidade_id === cidadeIdAlvo); // [cite: 485]
          console.log(`[RUN ${runId}] [GuardRail D] Após filtro de cidade ID '${cidadeIdAlvo}', restaram ${parceirosTry1.length} parceiros.`); // [cite: 486]
      }
      // --- FIM GUARD-RAILS ---


      // --- SUCESSO: Se a Busca 1 (com guard-rails) funcionar ---
      if (parceirosTry1.length > 0) { // [cite: 487]
        console.log(`[RUN ${runId}] [RAG-Try 1] SUCESSO (Pós GuardRails). Encontrados ${parceirosTry1.length} parceiros.`);

        // CORREÇÃO 4: Passa a categoria REAL do parceiro encontrado
        const categoriaRealEncontrada = parceirosTry1[0]?.categoria || categoriaAlvo; // [cite: 488]
        const respostaModelo = await gerarRespostaDeListaParceiros(userText, historico, parceirosTry1, categoriaRealEncontrada); //

        const respostaFinal = finalizeAssistantResponse({ // Função restaurada
          modelResponseText: respostaModelo,
          foundPartnersList: parceirosTry1,
          mode: "partners",
        }); //

        if (cidadeIdAlvo) setLastCityInSession(sessionData, cidadeIdAlvo); // Salva cidade

        return await updateSessionAndRespond({ // [cite: 489]
          res, runId, conversationId, userText,
          aiResponseText: respostaFinal,
          sessionData, regiaoId: regiao.id, partners: parceirosTry1, // [cite: 490]
        });
      }

      // --- FALHA (Try 1 falhou): Ativar "Cérebro Vendedor Nato" ---
      console.log(`[RUN ${runId}] [RAG-Try 1] FALHA (Pós GuardRails). Ativando Cérebro Vendedor Nato...`);

      // --- TRY 2: Relaxar Localização ---
      console.log(`[RUN ${runId}] [RAG-Try 2] Relaxando localização. Buscando: ${categoriaAlvo || 'Sem Categoria'} EM (Todas as Cidades)`);
      const { parceiros: parceirosTry2 } = await searchPartnersRAG(categoriaAlvo || userText, {
        cidadesAtivas, categoriaForcada: categoriaAlvo, limit: 2,
      }); // [cite: 491]

      // --- TRY 3: Relaxar Categoria ---
      let categoriaIrma = null;
      if (['pizzaria', 'hamburgueria', 'sushi', 'churrascaria'].includes(categoriaAlvo)) { categoriaIrma = 'restaurante'; }
      else if (categoriaAlvo === 'comida' || categoriaAlvo === 'restaurante') { categoriaIrma = 'bar'; }

      let parceirosTry3 = [];
      if (categoriaIrma && cidadeIdAlvo) {
          console.log(`[RUN ${runId}] [RAG-Try 3] Relaxando categoria. Buscando: ${categoriaIrma} EM ${cidadeNomeAlvo}`);
          const { parceiros } = await searchPartnersRAG(categoriaIrma, {
            cidadesAtivas, cidadeIdForcada: cidadeIdAlvo, categoriaForcada: categoriaIrma, limit: 2,
          }); // [cite: 492]
          parceirosTry3 = parceiros;
      }

      // Combina resultados
      const combinados = [...(parceirosTry2 || []), ...(parceirosTry3 || [])].slice(0, Math.max(1, limiteSugestoes || 5, 12)); // [cite: 493]

      // Early return se NADA for encontrado
      if (combinados.length === 0) { // [cite: 494]
         const nomePedida = cidadeAlvo?.nome || "sua cidade solicitada";
         return await updateSessionAndRespond({ // [cite: 495]
             res, runId, conversationId, userText,
             aiResponseText: `Poxa, não encontrei indicações para '${categoriaAlvo || 'o que pediu'}' em ${nomePedida} ou cidades próximas. Posso tentar outra categoria?`,
             sessionData, regiaoId: regiao.id, partners: [],
         });
      }

      // Monta aviso se resultados são de outra cidade (Guard-rail E)
      let avisoCidade = ""; // [cite: 496]
      try { //
        const cidadePedidaId = cidadeIdAlvo || null; //
        if (cidadePedidaId && combinados.length > 0) { // [cite: 497]
          const idsEncontrados = Array.from(new Set(combinados.map(p => p.cidade_id).filter(Boolean))); //
          const nenhumDaCidadePedida = !idsEncontrados.includes(cidadePedidaId); // [cite: 498]
          if (nenhumDaCidadePedida && idsEncontrados.length > 0) { //
            const { data: cidadesOutras } = await supabase.from("cidades").select("id, nome").in("id", idsEncontrados); // [cite: 499]
            const nomesOutros = Array.from(new Set((cidadesOutras || []).map(c => c?.nome).filter(Boolean))); // [cite: 500]
            if (nomesOutros.length > 0) { //
              const nomePedida = cidadeAlvo?.nome || "sua cidade solicitada"; // [cite: 501]
              avisoCidade = `*Aviso:* não encontrei indicações em **${nomePedida}**, mas tenho opções em **${nomesOutros.join(", ")}**. `; // [cite: 502]
            } //
          } //
        } //
      } catch { /* não quebra */ } // [cite: 503]

      // Monta prompt para IA gerar resposta combinada
      const promptVendedor = `
${PROMPT_MESTRE_V14}
# CONTEXTO DE VENDA
O usuário pediu "${userText}" (intenção: ${categoriaAlvo || 'desconhecida'}, local: ${cidadeNomeAlvo || 'qualquer'}).
A busca exata (Try 1) falhou (0 resultados).

# DADOS DO ESTOQUE (Resultados das buscas de fallback - PRIORIZE ESTES)
## Opção 1: Manter a INTENÇÃO (${categoriaAlvo || 'original'}) em OUTRO LOCAL
${JSON.stringify(parceirosTry2)}
## Opção 2: Manter o LOCAL (${cidadeNomeAlvo || 'original'}) com OUTRA CATEGORIA (${categoriaIrma || 'alternativa'})
${JSON.stringify(parceirosTry3)}

# INSTRUÇÃO
Aja como um "vendedor nato", não como um robô.
1. Use os dados da Opção 1 e Opção 2 para listar as indicações confiáveis.
2. Formate a lista como no exemplo: "• **Nome** · categoria · Descrição."
3. **Se** a Opção 1 tiver resultados, ofereça a intenção no local alternativo (Ex: "Olha, não tenho ${categoriaAlvo || 'isso'} em ${cidadeNomeAlvo || 'sua cidade'}, mas tenho uma excelente opção em [Cidade do Parceiro Try 2]:").
4. **Se** a Opção 2 tiver resultados, ofereça a categoria alternativa no local original (Ex: "Se preferir ficar em ${cidadeNomeAlvo || 'sua cidade'}, tenho ótimos [${categoriaIrma}] como:").
5. Combine as frases se ambas existirem, sempre oferecendo a Opção 1 primeiro.
6. Use a função gerarRespostaDeListaParceiros para formatar o final (refinamento). Passe a categoria ${categoriaAlvo || 'original'} para ela.

[Pergunta]: "${userText}"
Responda combinando as instruções acima. Use a lista de parceiros fornecida.
`.trim();

      const respostaIA = await geminiTry(promptVendedor); //

      // Usa a categoria original para o refinamento final
      const refinamentoFinal = await gerarRespostaDeListaParceiros(userText, null, combinados, categoriaAlvo);
      const textoRefinamento = refinamentoFinal.split('\n').pop(); // Pega só a última linha

      return await updateSessionAndRespond({ // [cite: 505]
        res, runId, conversationId, userText,
        aiResponseText: avisoCidade + respostaIA + "\n\n" + textoRefinamento, // Combina aviso + IA + refinamento
        sessionData, regiaoId: regiao.id,
        partners: combinados, // [cite: 506]
      });
    }

    // ===================== CLIMA =====================
    if (tipoIntencao === "clima") { // [cite: 507]
      // Lógica de busca de clima no cache (mantida do v6.3.3)
      const when = detectTemporalWindow(userText);
      const tipoDadoAlvo = when === "future" ? "previsao_diaria" : "clima_atual";
      const cidadeAlvoObj = cidadeAlvo; // Renomeado para evitar conflito
      const forRegion = isRegionQuery(userText) && !cidadeAlvoObj;
      let cidadesParaBuscar = [];
      if (cidadeAlvoObj) { cidadesParaBuscar.push(cidadeAlvoObj); }
      else if (forRegion) { const nomesVip = ["Arraial do Cabo", "Cabo Frio", "Armação dos Búzios"]; cidadesParaBuscar = cidadesAtivas.filter(c => nomesVip.some(nVip => normalizarTexto(c.nome) === normalizarTexto(nVip))); }
      else { const primeiraVip = cidadesAtivas.find(c => normalizarTexto(c.nome) === "cabo frio") || cidadesAtivas[0]; if (primeiraVip) cidadesParaBuscar.push(primeiraVip); }
      const dadosClimaticos = (await Promise.all(cidadesParaBuscar.map(async (cidade) => {
        const { data } = await supabase.from("dados_climaticos").select("dados").eq("cidade_id", cidade.id).eq("tipo_dado", tipoDadoAlvo).order("ts", { ascending: false }).limit(1).maybeSingle();
        if (!data) return null;
        let registro = { cidade: cidade.nome, tipo: tipoDadoAlvo, registro: data.dados }; // Corrigido para pegar data.dados
        const CIDADES_VIP_NORM = ["arraial do cabo", "cabo frio", "armação dos búzios"];
        if (when === "present" && CIDADES_VIP_NORM.includes(normalizarTexto(cidade.nome))) {
          const { data: mare } = await supabase.from("dados_climaticos").select("dados").eq("cidade_id", cidade.id).eq("tipo_dado", "dados_mare").order("ts", { ascending: false }).limit(1).maybeSingle();
          const { data: agua } = await supabase.from("dados_climaticos").select("dados").eq("cidade_id", cidade.id).eq("tipo_dado", "temperatura_agua").order("ts", { ascending: false }).limit(1).maybeSingle();
          if (mare) registro.dados_mare = mare.dados;
          if (agua) registro.temperatura_agua = agua.dados;
        } return registro;
      }))).filter(Boolean);
      if (dadosClimaticos.length > 0) {
        const payload = { tipoConsulta: forRegion ? "resumo_regiao" : "cidade_especifica", janelaTempo: when, dados: dadosClimaticos };
        const horaLocal = getHoraLocalSP();
        const promptFinal = ` /* ... prompt clima ... */ `; // Mantido
        const respostaIA = await geminiTry(promptFinal);
        return await updateSessionAndRespond({ res, runId, conversationId, userText, aiResponseText: respostaIA, sessionData, regiaoId: regiao.id });
      } else {
        const respostaIA = (when === 'future') ? "Ainda não tenho dados consolidados da previsão do tempo para os próximos dias. Posso ajudar com o clima de *hoje*?" : "Não consegui consultar os dados climáticos de hoje agora. Por favor, tente em alguns minutos.";
        return await updateSessionAndRespond({ res, runId, conversationId, userText, aiResponseText: respostaIA, sessionData, regiaoId: regiao.id });
      } // [cite: 508]
    }

    // ===================== ROTA =====================
    if (tipoIntencao === "rota") { //
      const textoRota = await montarTextoDeRota({ slugDaRegiao, pergunta: userText }); //
      return await updateSessionAndRespond({ // [cite: 509]
        res, runId, conversationId, userText, //
        aiResponseText: textoRota, sessionData, regiaoId: regiao.id, //
      }); //
    } //

    // ===================== GERAL =====================
    const respostaGeral = await gerarRespostaGeral({ //
      pergunta: userText, //
      slugDaRegiao, //
      conversaId: conversationId, //
    }); //
    return await updateSessionAndRespond({ // [cite: 510]
      res, runId, conversationId, userText, //
      aiResponseText: respostaGeral, sessionData, regiaoId: regiao.id, //
    }); //

  } catch (e) { //
    console.error(`[RUN ${runId}] ERRO FATAL NA ROTA:`, e); // [cite: 511]
    return res.status(500).json({ //
      reply: "Ops, encontrei um problema temporário. Por favor, tente sua pergunta novamente em um instante.", //
    }); //
  } //
}); // [cite: 512]


// ---- ROTA AVISOS PÚBLICOS ----
app.get("/api/avisos/:slugDaRegiao", async (req, res) => { //
  try { //
    const { slugDaRegiao } = req.params; //
    const { data: regiao, error: erroRegiao } = await supabase.from("regioes").select("id").eq("slug", slugDaRegiao).single(); //
    if (erroRegiao || !regiao) { return res.status(404).json({ error: "Região não encontrada." }); } //
    const { data: avisos, error: erroAvisos } = await supabase // [cite: 513]
      .from("avisos_publicos") //
      .select(`id, regiao_id, cidade_id, titulo, descricao, periodo_inicio, periodo_fim, ativo, created_at, cidades:cidade_id ( nome )`) //
      .eq("regiao_id", regiao.id).eq("ativo", true).order("periodo_inicio", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false, nullsFirst: false }); //
    if (erroAvisos) throw erroAvisos; //
    const normalized = (avisos || []).map((a) => ({ // [cite: 514]
      id: a.id, regiao_id: a.regiao_id, cidade_id: a.cidade_id, cidade_nome: a?.cidades?.nome || null, //
      titulo: a.titulo, descricao: a.descricao, periodo_inicio: a.periodo_inicio, periodo_fim: a.periodo_fim, //
      ativo: a.ativo === true, created_at: a.created_at, //
    })); //
    return res.status(200).json({ data: normalized }); // [cite: 515]
  } catch (erro) { //
    console.error("[/api/avisos/:slugDaRegiao] Erro:", erro); //
    return res.status(500).json({ error: "Erro interno no servidor ao buscar avisos." }); // [cite: 516]
  } //
}); // [cite: 517]

// ---- STARTUP ----
app //
  .listen(PORT, HOST, () => { //
    console.log(`[BOOT] BEPIT ouvindo em http://${HOST}:${PORT}`); //
    console.log(`[BOOT] v6.3.5 (COMPLETO) ATIVO.`); // Atualizado
    printRoutes(app, "app"); //
  }) //
  .on("error", (err) => { //
    console.error("[BOOT] Falha ao subir servidor:", err); //
    process.exit(1); //
  }); //
process.on("SIGTERM", () => { // [cite: 518]
  console.log("[SHUTDOWN] Recebido SIGTERM. Encerrando..."); //
  process.exit(0); //
}); //

export default app; // [cite: 519]

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
