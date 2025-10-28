// /backend-oficial/server/index.js
// v6.3.7 — COMPLETO (SyntaxError Corrigido em isRegionQuery)
// Contém: Vendedor Nato, Funções Restauradas, Ordem Corrigida, Correção Refinamento.

// ---> Log "Cache Buster" <---
console.log("[BOOT] Executando index.js v6.3.7 (SyntaxError Corrigido)...");
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

// ---- Fetch Polyfill ----
if (typeof fetch !== "function") {
  globalThis.fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
}

// ---- DEBUG: listar rotas montadas ----
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

// ---- CLIENTE REDIS (UPSTASH) — VIA REST ----
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
    if (!hasUpstash()) return null; // Não lança erro, apenas retorna null se não configurado
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
     if (!hasUpstash()) return false; // Retorna false se não configurado
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
    if (!hasUpstash()) return false; // Retorna false se não configurado
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

// ---- APP ÚNICO ----
const app = express();
const PORT = process.env.PORT || 3002;
const HOST = "0.0.0.0";

// ---- CORS ----
const EXPLICIT_ALLOWED_ORIGINS = new Set(["http://localhost:5173", "http://localhost:3000"]);
if (process.env.FRONTEND_ORIGIN) { EXPLICIT_ALLOWED_ORIGINS.add(process.env.FRONTEND_ORIGIN.trim()); }
if (process.env.CORS_EXTRA_ORIGINS) { process.env.CORS_EXTRA_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean).forEach((o) => EXPLICIT_ALLOWED_ORIGINS.add(o)); }
const ALLOWED_ORIGIN_PATTERNS = [/^https:\/\/.*\.netlify\.app$/, /^http:\/\/localhost:(3000|5173)$/, /^https:\/\/.*\.vercel\.app$/]; // Adicionado Vercel
const CORS_ALLOW_ALL = String(process.env.CORS_ALLOW_ALL || "") === "1";
function isOriginAllowed(origin) {
  if (!origin) return true; // Permite requisições sem origin (ex: Postman, curl)
  if (CORS_ALLOW_ALL) return true;
  if (EXPLICIT_ALLOWED_ORIGINS.has(origin)) return true;
  return ALLOWED_ORIGIN_PATTERNS.some((rx) => rx.test(origin));
}
app.use((req, res, next) => { // Pré-voo manual
  const origin = req.headers.origin || "";
  if (isOriginAllowed(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin"); // Importante para cache
  }
  if (req.method === "OPTIONS") {
    if (!isOriginAllowed(origin)) return res.status(403).send("CORS: origem não permitida.");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key, Authorization, Accept, X-Requested-With");
    res.header("Access-Control-Max-Age", "600");
    return res.sendStatus(204);
  }
  next();
});
app.use( // CORS efetivo
  cors({
    origin: (origin, cb) => (isOriginAllowed(origin) ? cb(null, true) : cb(new Error("CORS block"))),
    credentials: true, // Se você usa cookies/sessions
  })
);
app.use(express.json({ limit: "25mb" }));

// ---- Health & Debug ----
app.get("/health", async (req, res) => {
  try {
    const env = { SUPABASE_URL: !!process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY: !!process.env.GEMINI_API_KEY };
    let supabaseStatus = "skip";
    try {
      const { data, error } = await supabase.from("parceiros").select("id", { count: 'exact', head: true }).limit(1); // Mais eficiente
      supabaseStatus = error ? `error: ${error.message}` : "ok";
    } catch (e) {
      supabaseStatus = `error: ${e?.message || String(e)}`;
    }
    let redisStatus = hasUpstash() ? "skip" : "disabled";
    if (hasUpstash()) {
      try {
        const exists = await upstash.exists("healthcheck", { timeoutMs: 300 });
        redisStatus = "ok";
      } catch (e) {
        redisStatus = `error: ${e?.message || String(e)}`;
      }
    }
    res.json({ ok: true, checks: { uptime_s: Math.floor(process.uptime()), env, supabase: supabaseStatus, redis: redisStatus } });
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
    const out = await hybridSearch({ q, cidade_id, categoria, limit, debug: true }); // hybridSearch vem do rag.service
    res.json({ ok: true, items: out?.items || [], meta: out?.meta || null }); // Garante retorno
  } catch (e) {
    console.error("[/_debug/rag/search] Erro:", e); // Loga erro no debug
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ---- ROTAS MODULARES ----
app.use("/api/parceiro", parceiroRoutes);
app.use("/api/rag", ragRoutes);
app.use("/api/financeiro", financeiroRoutes);
app.use("/api/uploads", uploadsRoutes);
app.use("/api/clima", climaRoutes);
app.use("/api/mar", marRoutes);
app.get("/", (_req, res) => res.status(200).send("BEPIT backend ativo ✅ v6.3.7")); // Versão atualizada
app.get("/ping", (_req, res) => res.status(200).json({ pong: true, ts: Date.now() }));

// ---- IA (Gemini REST) ----
const usarGeminiREST = String(process.env.USE_GEMINI_REST || "") === "1";
const chaveGemini = process.env.GEMINI_API_KEY || "";
const AI_DISABLED = String(process.env.AI_DISABLED || "") === "1";
function stripModelsPrefix(id) { return String(id || "").replace(/^models\//, ""); }
async function listarModelosREST() { /* ... código mantido ... */ }
async function selecionarModeloREST() { /* ... código mantido ... */ }
async function gerarConteudoComREST(modelo, texto) { /* ... código mantido ... */ }
let modeloGeminiV1 = null;
async function obterModeloREST() { /* ... código mantido ... */ }
async function geminiGerarTexto(texto) { /* ... código mantido ... */ }
function isRetryableGeminiError(err) { const msg = String(err?.message || err); return /429|RESOURCE_EXHAUSTED|500|502|503|504/i.test(msg); }
async function geminiTry(texto, { retries = 2, baseDelay = 500 } = {}) {
  if (AI_DISABLED || !usarGeminiREST) { console.warn("[AI] AI está desabilitada ou não configurada para REST."); return "Desculpe, a função de IA está temporariamente indisponível."; } // Mensagem padrão se desabilitado
  let attempt = 0;
  while (true) {
    try {
      return await geminiGerarTexto(texto);
    } catch (e) {
      console.error(`[GEMINI TRY ${attempt+1}/${retries+1}] Erro:`, e?.message || e); // Loga erro da tentativa
      attempt++;
      if (attempt > retries || !isRetryableGeminiError(e)) throw e;
      const jitter = Math.floor(Math.random() * 250);
      const delay = baseDelay * Math.pow(2, attempt - 1) + jitter;
      console.log(`[GEMINI TRY] Tentando novamente em ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ============================== HELPERS =====================================

// Função restaurada
async function extrairEntidadesDaBusca(texto) {
  const tNorm = normalizarTexto(texto || "");
  let city = null;
  if (tNorm.includes("cabo frio")) city = "Cabo Frio";
  else if (tNorm.includes("buzios") || tNorm.includes("búzios")) city = "Armação dos Búzios";
  else if (tNorm.includes("arraial")) city = "Arraial do Cabo";
  else if (tNorm.includes("sao pedro") || tNorm.includes("são pedro")) city = "São Pedro da Aldeia";
  else if (tNorm.includes("iguaba")) city = "Iguaba Grande";
  const DIC_TERMS = ["pizzaria", "pizza", "picanha", /* ... outros termos ... */ "bistro"];
  const terms = [];
  for (const w of DIC_TERMS) if (tNorm.includes(normalizarTexto(w))) terms.push(w);
  let category = null;
  if (tNorm.includes("pizzaria") || tNorm.includes("pizza")) { category = "pizzaria"; }
  else if (["restaurante", /* ... outras comidas ... */ "japonesa"].some(k => tNorm.includes(k))) { category = "comida"; }
  else if (["pousada", /* ... hospedagem ... */ "resort"].some(k => tNorm.includes(k))) { category = "hospedagem"; }
  else if (["bar", /* ... bebidas ... */ "boteco"].some(k => tNorm.includes(k))) { category = "bebidas"; }
  else if (["passeio", /* ... passeios ... */ "tour"].some(k => tNorm.includes(k))) { category = "passeios"; }
  else if (["praia", /* ... praias ... */ "orla"].some(k => tNorm.includes(k))) { category = "praias"; }
  else if (["transfer", /* ... transporte ... */ "onibus"].some(k => tNorm.includes(k))) { category = "transporte"; }
  return { category, city, terms };
}

function normalizarTexto(texto) { return String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim(); }
function getHoraLocalSP() { try { const fmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false }); return fmt.format(new Date()); } catch { const now = new Date(); const utc = now.getTime() + now.getTimezoneOffset() * 60000; const sp = new Date(utc - 3 * 3600000); const hh = String(sp.getHours()).padStart(2, "0"); const mm = String(sp.getMinutes()).padStart(2, "0"); return `${hh}:${mm}`; } }
async function construirHistoricoParaGemini(conversationId, limite = 12) { try { const { data, error } = await supabase.from("interacoes").select("pergunta_usuario, resposta_ia").eq("conversation_id", conversationId).order("created_at", { ascending: true }); if (error) throw error; const rows = data || []; const ultimas = rows.slice(-limite); const contents = []; for (const it of ultimas) { if (it.pergunta_usuario) contents.push({ role: "user", parts: [{ text: it.pergunta_usuario }] }); if (it.resposta_ia) contents.push({ role: "model", parts: [{ text: it.resposta_ia }] }); } return contents; } catch (e) { console.warn("[HISTORICO DB] Falha:", e?.message || e); return []; } }
function historicoParaTextoSimplesWrapper(hc) { try { return (hc || []).map((b) => `- ${b?.role || "user"}: ${(b?.parts?.[0]?.text || "").replace(/\s+/g, " ").trim()}`).join("\n"); } catch { return ""; } }

// ---- FUNÇÃO CENTRAL — ATUALIZA E RESPONDE ----
async function updateSessionAndRespond({ res, runId, conversationId, userText, aiResponseText, sessionData, regiaoId, partners = [] }) {
  const _run = runId || "NO-RUNID";
  console.log(`[RUN ${_run}] [RAIO-X FINAL] Preparando resposta e salvando sessão.`);
  const novoHistorico = [...(sessionData?.history || [])];
  novoHistorico.push({ role: "user", parts: [{ text: userText }] });
  novoHistorico.push({ role: "model", parts: [{ text: aiResponseText }] });
  const MAX_HISTORY_LENGTH = 12;
  while (novoHistorico.length > MAX_HISTORY_LENGTH) { novoHistorico.shift(); }
  const novaSessionData = { ...(sessionData || {}), history: novoHistorico, entities: sessionData?.entities }; // Preserva entities
  const TTL_SECONDS = 900;
  if (hasUpstash()) {
    try { await upstash.set(conversationId, JSON.stringify(novaSessionData), TTL_SECONDS, { timeoutMs: 400 }); }
    catch (e) { console.warn(`[RUN ${_run}] [CACHE] Falha ao salvar sessão (não fatal):`, e?.message || e); }
  } else { console.warn("[CACHE] Upstash não configurado."); }
  try {
    await supabase.from("interacoes").insert({
      conversation_id: conversationId, regiao_id: regiaoId, pergunta_usuario: userText,
      resposta_ia: aiResponseText, parceiros_sugeridos: partners.length > 0 ? partners.map(p => p.id) : null, // Salva só IDs
    });
  } catch (e) { console.error(`[RUN ${_run}] [SUPABASE] Falha ao salvar interação:`, e); }
  return res.json({ reply: aiResponseText, conversationId, partners: partners.length > 0 ? partners : undefined });
}

// ---- SESSION ENSURER ----
async function ensureConversation(req) {
    const body = req.body || {};
    let conversationId = body.conversationId || body.threadId || body.sessionId || null;
    let isNewConversation = false; // Flag para saber se criamos a conversa AGORA

    if (!conversationId || typeof conversationId !== "string" || conversationId.trim().length < 10) {
        conversationId = randomUUID();
        isNewConversation = true; // É nova
        try {
            await supabase.from("conversas").insert({
                id: conversationId,
                regiao_id: req.ctx?.regiao?.id || null,
            });
            console.log(`[SESSION] Nova conversa criada: ${conversationId}`);
        } catch (e) {
             // Ignora erro de chave duplicada (idempotência), mas loga outros
             if (!e?.message?.includes('duplicate key value')) {
                 console.error(`[SESSION] Erro ao criar conversa ${conversationId}:`, e);
             }
        }
    } else {
        // Verifica se a conversa já existe no DB (para garantir consistência com cache)
        try {
            const { data: existe, error: errCheck } = await supabase.from("conversas").select("id").eq("id", conversationId).maybeSingle();
            if (errCheck) {
                 console.error(`[SESSION] Erro ao verificar conversa ${conversationId}:`, errCheck);
            } else if (!existe) {
                // Se não existe no DB (talvez foi deletada?), cria de novo
                isNewConversation = true; // Considera nova para buscar histórico
                await supabase.from("conversas").insert({
                    id: conversationId,
                    regiao_id: req.ctx?.regiao?.id || null,
                });
                console.log(`[SESSION] Conversa ${conversationId} recriada no DB.`);
            }
        } catch (e) {
             if (!e?.message?.includes('duplicate key value')) { // Ignora duplicada
                 console.error(`[SESSION] Erro ao recriar conversa ${conversationId}:`, e);
             }
        }
    }

    // Determina se é o primeiro turno REAL (sem interações salvas)
    let isFirstTurn = false;
    if (isNewConversation) {
        // Se acabamos de criar a conversa, é o primeiro turno
        isFirstTurn = true;
    } else {
        // Se a conversa já existia, verifica se há interações no DB
        try {
            const { count, error: errCount } = await supabase.from("interacoes").select("*", { count: "exact", head: true }).eq("conversation_id", conversationId);
            if (errCount) {
                 console.error(`[SESSION] Erro ao contar interações para ${conversationId}:`, errCount);
                 isFirstTurn = false; // Supõe que não é o primeiro em caso de erro
            } else {
                 isFirstTurn = (count || 0) === 0;
            }
        } catch (e) {
            console.error(`[SESSION] Exceção ao contar interações para ${conversationId}:`, e);
            isFirstTurn = false; // Supõe que não é o primeiro
        }
    }
    console.log(`[SESSION ${conversationId}] isFirstTurn: ${isFirstTurn}`);

    req.ctx = Object.assign({}, req.ctx || {}, { conversationId, isFirstTurn });
    return { conversationId, isFirstTurn };
}

// ---- CLASSIFICAÇÃO/EXTRAÇÃO ----
function normalizar(texto) { return normalizarTexto(texto); }
function isSaudacao(texto) { const t = normalizar(texto); const saudacoes = ["oi", "ola", "olá", /* ... */ "tudo bem"]; return saudacoes.includes(t); }
const PALAVRAS_CHAVE_PARCEIROS = { /* ... */ };
function forcarBuscaParceiro(texto) { const t = normalizarTexto(texto); for (const lista of Object.values(PALAVRAS_CHAVE_PARCEIROS)) { if (lista.some(p => t.includes(p))) return true; } return false; }
function isWeatherQuestion(texto) { if (forcarBuscaParceiro(texto)) return false; const t = normalizar(texto); const termos = ["clima", /* ... */ "nublado"]; return termos.some(k => t.includes(k)); }
function isRouteQuestion(texto) { const t = normalizar(texto); const termos = ["como chegar", /* ... */ "direção"]; return termos.some(k => t.includes(k)); }
function detectTemporalWindow(texto) { const t = normalizar(texto); const sinaisFuturo = ["amanha", /* ... */ "daqui a"]; return sinaisFuturo.some(s => t.includes(s)) ? "future" : "present"; }
function extractCity(texto, cidadesAtivas) { const t = normalizarTexto(texto || ""); const lista = Array.isArray(cidadesAtivas) ? cidadesAtivas : []; const apelidos = [ /* ... */ ]; const hitApelido = apelidos.find(a => t.includes(a.key)); if (hitApelido) { const alvo = lista.find(c => normalizarTexto(c.nome) === normalizarTexto(hitApelido.nome)); if (alvo) return alvo; } for (const c of lista) { if (t.includes(normalizarTexto(c.nome)) || t.includes(normalizarTexto(c.slug))) return c; } return null; }
// CORREÇÃO: Função isRegionQuery completa
function isRegionQuery(texto) {
  const t = normalizar(texto);
  const mencionaRegiao = t.includes("regiao") || t.includes("região") || t.includes("regiao dos lagos") || t.includes("região dos lagos"); // Condição completa
  return mencionaRegiao;
}

// ==========================================================
// FUNÇÃO MOVIDA PARA ANTES DA ROTA DO CHAT (v6.3.6)
// ==========================================================
async function searchPartnersRAG(textoDoUsuario, { cidadesAtivas, cidadeIdForcada, categoriaForcada, limit = 5 }) {

  let categoria = categoriaForcada;
  let cidade_id = cidadeIdForcada;

  // Se não forçado, extrai da pergunta
  if (!categoria || !cidade_id) {
    const entidades = await extrairEntidadesDaBusca(textoDoUsuario || "");
    if (!categoria) categoria = entidades?.category || null;
    if (!cidade_id && entidades?.city) {
      const cidadeObj = (cidadesAtivas || []).find(
        (c) => normalizarTexto(c.nome) === normalizarTexto(entidades.city)
      );
      if (cidadeObj) cidade_id = cidadeObj.id;
    }
  }

  let results = [];
  try {
    // Chama o rag.service.js (v2.8.1 com fallback desativado)
    console.log(`[searchPartnersRAG] Chamando hybridSearch com: q=${textoDoUsuario}, cidade_id=${cidade_id}, categoria=${categoria}, limit=${limit}`);
    const rag = await hybridSearch({
      q: textoDoUsuario,
      cidade_id,
      categoria,
      limit,
      debug: false, // Mudar para true se precisar depurar o RAG interno
    });
    results = Array.isArray(rag) ? rag : [];
    console.log(`[searchPartnersRAG] hybridSearch retornou ${results.length} resultados.`);
  } catch (e) {
    console.error(`[searchPartnersRAG] Falha CRÍTICA no hybridSearch: ${e?.message || e}. Retornando lista vazia.`);
    results = []; // Garante que retorne vazio em caso de erro CRÍTICO
  }

  // Mapeia o resultado
  const parceiros = results.map((r) => ({
    id: r.id, tipo: r.tipo || null, nome: r.nome, categoria: r.categoria || categoria || null,
    descricao: r.descricao || null, endereco: r.endereco || null, contato: r.contato || null,
    beneficio_bepit: r.beneficio_bepit || null, faixa_preco: r.faixa_preco || null,
    fotos_parceiros: Array.isArray(r.fotos_parceiros) ? r.fotos_parceiros : [],
    cidade_id: r.cidade_id || null,
  }));

  return { parceiros, categoriaDetectada: categoria, cidadeIdDetectada: cidade_id };
}
// ==========================================================
// FIM DA FUNÇÃO MOVIDA
// ==========================================================

// ---- DETECTOR DE INTENÇÃO (LOCAL) ---- RESTAURADO
async function detectarIntencaoLocal(texto, { slugDaRegiao } = {}) {
  const t = normalizarTexto(texto || "");
  if (isRouteQuestion(texto)) { return { tipoIntencao: "rota", categoriaAlvo: null, cidadeAlvo: null, limiteSugestoes: 5 }; }
  if (isWeatherQuestion(texto)) { return { tipoIntencao: "clima", categoriaAlvo: null, cidadeAlvo: null, limiteSugestoes: 5 }; }
  const entidades = await extrairEntidadesDaBusca(texto || "");
  const forcaParceiro = forcarBuscaParceiro(texto) || !!entidades?.category;
  let categoriaAlvo = entidades?.category || null;
  let cidadeAlvo = null;
  try {
    const { data: regiao } = await supabase.from("regioes").select("id").eq("slug", slugDaRegiao).maybeSingle();
    if (regiao?.id) {
      // Busca cidades DENTRO da função para garantir que temos a lista
      const { data: cidades } = await supabase.from("cidades").select("id, nome, slug").eq("regiao_id", regiao.id).eq("ativo", true);
      const cidadesAtivasNaRegiao = cidades || [];

      // Tenta extrair cidade usando a função extractCity (que busca na lista fornecida)
      const alvo = extractCity?.(texto, cidadesAtivasNaRegiao);
      if (alvo) {
        cidadeAlvo = alvo;
      } else {
          // Fallback global (se não achou na região, tenta em todas) - MENOS RECOMENDADO, PODE PEGAR CIDADE ERRADA
          // console.warn(`[DET INTENCAO] Cidade não encontrada na região ${slugDaRegiao}. Buscando globalmente... (Pode ser impreciso)`);
          // const { data: allCidades } = await supabase.from("cidades").select("id, nome, slug").limit(500);
          // if (Array.isArray(allCidades)) {
          //   const hitGlobal = allCidades.find((c) => t.includes(normalizarTexto(c?.nome || "")));
          //   if (hitGlobal) { cidadeAlvo = hitGlobal; }
          // }
      }
    }
  } catch (e) { console.error("[DET INTENCAO] Erro ao buscar/processar cidades:", e?.message || e); }
  const tipoIntencao = forcaParceiro ? "parceiro" : "geral";
  // Log mais detalhado da detecção
  console.log(`[DET INTENCAO FINAL] Texto: "${texto}" | Tipo: ${tipoIntencao} | Categoria: ${categoriaAlvo} | Cidade: ${cidadeAlvo?.nome || 'Nenhuma'}`);
  return { tipoIntencao, categoriaAlvo, cidadeAlvo, limiteSugestoes: 5 };
}

// ---- PROMPT MESTRE (V14) ----
const PROMPT_MESTRE_V14 = `
# IDENTIDADE
Você é o **BEPIT**, concierge de turismo na Região dos Lagos (RJ).
Fala de forma humana, direta e útil. Não floreie, não alucine.
# FONTES E LIMITES
- Sempre priorize **dados internos** (Supabase: parceiros e dados_climaticos).
- Nunca recomende serviços privados externos (pousadas, restaurantes, passeios etc.).
- É permitido citar **serviços públicos externos** (bancos, 24h, farmácias, etc.) — diga que é “consulta pública”.
- Nunca responda sobre temas fora do turismo local.
# PARCEIROS (PRIORIDADE)
- Intenção de consumo → **priorize parceiros internos**.
- Liste nome, categoria e infos úteis. Fale como **“indicações confiáveis”**.
# CLIMA, MARÉS, ÁGUA
- Use **exclusivamente** \`dados_climaticos\`. Se faltar, diga.
- Contextualize com hora local (São Paulo).
# ROTAS HUMANAS (SEM MAPS)
- Explique em **texto humano**, ponto-a-ponto.
# ESTILO
- Curto (1–2 parágrafos) + bullets. Amigável e direto. Não saúde se não for 1º turno.
`.trim();

// ---- FORMATADORES & IA ----

// Função restaurada
function finalizeAssistantResponse({ modelResponseText, foundPartnersList = [], mode = "general" }) {
  const txt = String(modelResponseText || "").trim();
  if (mode === "partners" && !txt) { return "Aqui estão algumas **indicações confiáveis**."; }
  if (!txt) { return "Posso te ajudar com informações e indicações na Região dos Lagos."; }
  return txt;
}

// Função corrigida para usar categoria real
async function gerarRespostaDeListaParceiros(userText, historico, parceiros, categoriaReal) {
  if (!Array.isArray(parceiros) || parceiros.length === 0) { return "Não encontrei parceiros adequados..."; }
  const linhas = parceiros.slice(0, 8).map((p) => `• **${p.nome}** · ${p.categoria || "parceiro"}${p.descricao ? ` · ${p.descricao}` : ""}`);
  const mapRefinamento = {
    'pizzaria': "Se quiser, eu refino por tipo de massa ou ambiente.",
    'restaurante': "Posso refinar por estilo (família, casal, vista) ou orçamento?",
    'churrascaria': "Prefere rodízio ou a la carte?",
    'sushi': "Posso refinar por ambiente ou faixa de preço?",
    'hamburgueria': "Prefere artesanal ou lanche rápido?",
    'bar': "Busca música ao vivo, drinks ou ambiente tranquilo?",
    'barco': "Quer passeio longo (mergulho) ou tour rápido?",
    'locadora_veiculos': "Prefere econômico, SUV ou outro modelo?",
  };
  const catNorm = normalizarTexto(categoriaReal || parceiros[0]?.categoria || "");
  const refinamentoPadrao = "Se quiser, eu refino (família, casal, orçamento...). Diga o **número** ou **nome** para detalhes.";
  const refinamento = mapRefinamento[catNorm] || refinamentoPadrao;
  return ["Aqui vão algumas **indicações confiáveis**:", ...linhas, "", refinamento].join("\n");
}

// Geração de rotas em texto humano
function gerarRotasHumanas(pergunta) {
  const t = normalizarTexto(pergunta); let origem = null; let destino = null;
  const m1 = t.match(/saindo de ([^,]+?) para ([^,\.!?\n]+)/i); if (m1) { origem = m1[1]?.trim(); destino = m1[2]?.trim(); }
  if (!origem || !destino) { const m2 = t.match(/de ([^,]+?) para ([^,\.!?\n]+)/i); if (m2) { origem = origem || m2[1]?.trim(); destino = destino || m2[2]?.trim(); } }
  if (!destino) { const m3 = t.match(/como chegar (em|para|até) ([^,\.!?\n]+)/i); if (m3) destino = m3[2]?.trim(); }
  if (!origem) origem = "Rio de Janeiro"; if (!destino) destino = "Cabo Frio";
  const rotasConhecidas = [
    { alvo: "cabo frio", texto: `Saindo de ${origem} para Cabo Frio: Dutra → Linha Vermelha → Av. Brasil → Ponte Rio–Niterói → BR-101 → Via Lagos (RJ-124) → RJ-106/RJ-140 → Cabo Frio.` },
    { alvo: "arraial do cabo", texto: `Saindo de ${origem} para Arraial: Dutra → L. Vermelha → Av. Brasil → Ponte → BR-101 → Via Lagos (RJ-124) → RJ-140 (passa S. Pedro) → acesso Arraial.` },
    { alvo: "armação dos búzios", texto: `Saindo de ${origem} para Búzios: Dutra → L. Vermelha → Av. Brasil → Ponte → BR-101 → Via Lagos (RJ-124) → RJ-106 → RJ-102 → Búzios.` },
  ];
  const match = rotasConhecidas.find(r => destino && normalizarTexto(destino).includes(r.alvo));
  return match ? match.texto : `Rota sugerida de ${origem} para ${destino}: Eixo Dutra/Ponte → BR-101 → Via Lagos (RJ-124) → Conexões locais (RJ-106/140 ou 102).`;
}

// Resposta geral neutra
async function gerarRespostaGeralPrompteada({ pergunta, historicoContents, regiaoNome, dadosClimaOuMaresJSON = "{}", horaLocalSP }) {
  if (isRouteQuestion(pergunta)) { return gerarRotasHumanas(pergunta); }
  const promptNeutro = `
${PROMPT_MESTRE_V14}
Hora local: ${horaLocalSP} | Região: ${regiaoNome} | Dados: ${dadosClimaOuMaresJSON}
Histórico: ${historicoParaTextoSimplesWrapper(historicoContents)}
Pergunta: "${pergunta}"
Responda direto (1–2 §§). Se sem dados, seja honesto.`.trim();
  try { return await geminiTry(promptNeutro); }
  catch (e) { console.error("[GERAL PROMPT] Erro Gemini:", e?.message || e); return "Entendido. Posso te indicar opções e explicar como chegar. Diga a cidade e o tipo de lugar."; }
}
// Wrapper para rota humana
async function montarTextoDeRota({ slugDaRegiao, pergunta }) { return gerarRotasHumanas(pergunta); }
// Wrapper para resposta geral
async function gerarRespostaGeral({ pergunta, slugDaRegiao, conversaId }) {
  const historico = await construirHistoricoParaGemini(conversaId, 12);
  const horaLocal = getHoraLocalSP();
  let regiaoNome = "Região dos Lagos"; // Default
  try { // Tenta buscar nome real da região
      const { data: reg } = await supabase.from("regioes").select("nome").eq("slug", slugDaRegiao).single();
      if (reg?.nome) regiaoNome = reg.nome;
  } catch {/* usa default */}
  return gerarRespostaGeralPrompteada({ pergunta, historicoContents: historico, regiaoNome, horaLocalSP: horaLocal });
}

// ============================================================================
// >>> ROTA DO CHAT - ORQUESTRADOR v6.3.6 (CÉREBRO VENDEDOR NATO) <<<<<
// ============================================================================
app.post("/api/chat/:slugDaRegiao", async (req, res) => {
  const runId = randomUUID();
  try {
    console.log(`[RUN ${runId}] [PONTO 1] /chat iniciado.`);

    const { slugDaRegiao } = req.params;
    const userText = (req.body?.message || "").trim();

    if (userText.length < 1) { return res.status(400).json({ reply: "Por favor, digite uma mensagem.", conversationId: req.body?.conversationId }); }

    // Carrega Região e Cidades Ativas UMA VEZ
    const { data: regiao, error: errRegiao } = await supabase.from("regioes").select("id, nome").eq("slug", slugDaRegiao).single();
    if (errRegiao || !regiao) { console.error(`[RUN ${runId}] Região não encontrada: ${slugDaRegiao}`); return res.status(404).json({ error: "Região não encontrada." }); }
    req.ctx = { regiao }; // Adiciona ao contexto para ensureConversation
    const { data: cidades, error: errCidades } = await supabase.from("cidades").select("id, nome, slug").eq("regiao_id", regiao.id).eq("ativo", true);
    if (errCidades) { console.error(`[RUN ${runId}] Erro ao buscar cidades:`, errCidades); }
    const cidadesAtivas = cidades || [];

    // Garante Conversa e obtém dados da sessão
    const { conversationId, isFirstTurn } = await ensureConversation(req);
    let sessionData = { history: [], entities: {} };
    function setLastCityInSession(session, cidade_id) { try { if (!session || typeof session !== "object") return; if (!session.entities) session.entities = {}; session.entities.lastCity = cidade_id || null; } catch {} }
    function getLastCityFromSession(session) { try { return session?.entities?.lastCity || null; } catch { return null; } }
    try { if (hasUpstash() && !isFirstTurn) { const cached = await upstash.get(conversationId, { timeoutMs: 400 }); if (cached) { try { sessionData = JSON.parse(cached); } catch { console.warn(`[RUN ${runId}] Falha ao parsear sessão do cache.`); sessionData = { history: [], entities: {} }; } } } }
    catch (e) { console.error(`[RUN ${runId}] [CACHE] Falha ao LER sessão:`, e?.message || e); sessionData = { history: [], entities: {} }; }
    const historico = sessionData.history || [];

    // Saudações
    if (isSaudacao(userText)) {
        const resposta = isFirstTurn
            ? `Olá! Seja bem-vindo(a) à ${regiao.nome}! Eu sou o BEPIT, seu concierge de confiança. Como posso te ajudar a ter uma experiência incrível hoje?`
            : "Claro, como posso te ajudar agora?";
        return await updateSessionAndRespond({ res, runId, conversationId, userText, aiResponseText: resposta, sessionData, regiaoId: regiao.id });
    }

    // Detecta intenção usando a função restaurada
    const { tipoIntencao, categoriaAlvo, cidadeAlvo, limiteSugestoes } = await detectarIntencaoLocal(userText, { slugDaRegiao }); // Passa cidadesAtivas aqui? Não precisa, ela busca no DB.
    console.log(`[RUN ${runId}] [DET INTENCAO] Tipo: ${tipoIntencao}, Categoria: ${categoriaAlvo}, Cidade: ${cidadeAlvo?.nome || 'Nenhuma'}`);

    // =========================================================================
    // ETAPA 1: LÓGICA DO VENDEDOR NATO (PARCEIROS PRIMEIRO)
    // =========================================================================
    if (tipoIntencao === "parceiro") {
      console.log(`[RUN ${runId}] [RAG] Intent parceiros detectada. Iniciando Lógica Vendedor Nato.`);

      let cidadeIdAlvo = cidadeAlvo?.id || null;
      let cidadeNomeAlvo = cidadeAlvo?.nome || null;

      // Se não houver cidade detectada na INTENÇÃO, tenta herdar da sessão
      if (!cidadeIdAlvo) {
         cidadeIdAlvo = getLastCityFromSession(sessionData);
         if (cidadeIdAlvo) {
             cidadeNomeAlvo = cidadesAtivas.find(c => c.id === cidadeIdAlvo)?.nome || null; // Busca nome na lista já carregada
             console.log(`[RUN ${runId}] [RAG] Usando cidade herdada da sessão: ${cidadeNomeAlvo} (${cidadeIdAlvo})`);
         } else {
             console.log(`[RUN ${runId}] [RAG] Nenhuma cidade detectada ou herdada.`);
         }
      }

      // --- TRY 1: Busca Exata ---
      console.log(`[RUN ${runId}] [RAG-Try 1] Buscando: ${categoriaAlvo || 'Sem Categoria'} EM ${cidadeNomeAlvo || 'Qualquer Cidade'} (ID: ${cidadeIdAlvo || 'Nenhum'})`);
      const { parceiros: parceirosTry1_raw } = await searchPartnersRAG(userText, { // Chama a função que agora está ANTES
          cidadesAtivas, // Passa a lista carregada
          cidadeIdForcada: cidadeIdAlvo,
          categoriaForcada: categoriaAlvo,
          limit: Math.max(1, Math.min(limiteSugestoes || 5, 12)),
      });

      // --- GUARD-RAILS PÓS-BUSCA ---
      let parceirosTry1 = parceirosTry1_raw || [];
      const catAlvoNorm = normalize(categoriaAlvo);
      if (catAlvoNorm) {
          parceirosTry1 = parceirosTry1.filter(p => normalize(p?.categoria) === catAlvoNorm);
          console.log(`[RUN ${runId}] [GuardRail C] Após filtro de categoria '${catAlvoNorm}', restaram ${parceirosTry1.length} parceiros.`);
      }
      if (cidadeIdAlvo) {
          parceirosTry1 = parceirosTry1.filter(p => p?.cidade_id === cidadeIdAlvo);
          console.log(`[RUN ${runId}] [GuardRail D] Após filtro de cidade ID '${cidadeIdAlvo}', restaram ${parceirosTry1.length} parceiros.`);
      }

      // --- SUCESSO TRY 1 ---
      if (parceirosTry1.length > 0) {
        console.log(`[RUN ${runId}] [RAG-Try 1] SUCESSO (Pós GuardRails). Encontrados ${parceirosTry1.length} parceiros.`);
        const categoriaRealEncontrada = parceirosTry1[0]?.categoria || categoriaAlvo;
        const respostaModelo = await gerarRespostaDeListaParceiros(userText, historico, parceirosTry1, categoriaRealEncontrada);
        const respostaFinal = finalizeAssistantResponse({ modelResponseText: respostaModelo, foundPartnersList: parceirosTry1, mode: "partners" });
        if (cidadeIdAlvo) setLastCityInSession(sessionData, cidadeIdAlvo); // Salva cidade na sessão
        return await updateSessionAndRespond({ res, runId, conversationId, userText, aiResponseText: respostaFinal, sessionData, regiaoId: regiao.id, partners: parceirosTry1 });
      }

      // --- FALHA TRY 1 ---
      console.log(`[RUN ${runId}] [RAG-Try 1] FALHA (Pós GuardRails). Ativando Cérebro Vendedor Nato...`);
      // --- TRY 2: Relaxar Localização ---
      console.log(`[RUN ${runId}] [RAG-Try 2] Relaxando localização. Buscando: ${categoriaAlvo || 'Sem Categoria'} EM (Todas as Cidades)`);
      const { parceiros: parceirosTry2 } = await searchPartnersRAG(categoriaAlvo || userText, { cidadesAtivas, categoriaForcada: categoriaAlvo, limit: 2 });
      // --- TRY 3: Relaxar Categoria ---
      let categoriaIrma = null;
      if (['pizzaria', 'hamburgueria', 'sushi', 'churrascaria'].includes(categoriaAlvo)) { categoriaIrma = 'restaurante'; }
      else if (categoriaAlvo === 'comida' || categoriaAlvo === 'restaurante') { categoriaIrma = 'bar'; }
      let parceirosTry3 = [];
      if (categoriaIrma && cidadeIdAlvo) { // Só tenta se tinha cidade original
          console.log(`[RUN ${runId}] [RAG-Try 3] Relaxando categoria. Buscando: ${categoriaIrma} EM ${cidadeNomeAlvo}`);
          const { parceiros } = await searchPartnersRAG(categoriaIrma, { cidadesAtivas, cidadeIdForcada: cidadeIdAlvo, categoriaForcada: categoriaIrma, limit: 2 });
          parceirosTry3 = parceiros;
      }
      // Combina resultados
      const combinados = [...(parceirosTry2 || []), ...(parceirosTry3 || [])]
          // Remove duplicados pelo ID antes de cortar
          .filter((p, index, self) => index === self.findIndex((t) => t.id === p.id))
          .slice(0, Math.max(1, limiteSugestoes || 5, 12));

      // Early return se NADA for encontrado
      if (combinados.length === 0) {
         const nomePedida = cidadeNomeAlvo || "sua cidade solicitada";
         return await updateSessionAndRespond({ res, runId, conversationId, userText, aiResponseText: `Poxa, não encontrei indicações para '${categoriaAlvo || 'o que pediu'}' em ${nomePedida} ou cidades próximas. Posso tentar outra categoria?`, sessionData, regiaoId: regiao.id, partners: [] });
      }
      // Monta aviso se resultados são de outra cidade (Guard-rail E)
      let avisoCidade = "";
      try {
        const cidadePedidaId = cidadeIdAlvo || null;
        if (cidadePedidaId && combinados.length > 0) {
          const idsEncontrados = Array.from(new Set(combinados.map(p => p.cidade_id).filter(Boolean)));
          const nenhumDaCidadePedida = !idsEncontrados.includes(cidadePedidaId);
          if (nenhumDaCidadePedida && idsEncontrados.length > 0) {
            // Busca nomes das cidades (poderia otimizar buscando só os IDs que não são a cidade pedida)
            const { data: cidadesOutras } = await supabase.from("cidades").select("id, nome").in("id", idsEncontrados);
            const nomesOutros = Array.from(new Set((cidadesOutras || []).map(c => c?.nome).filter(Boolean)));
            if (nomesOutros.length > 0) {
              const nomePedida = cidadeNomeAlvo || "sua cidade solicitada";
              avisoCidade = `*Aviso:* não encontrei indicações em **${nomePedida}**, mas tenho opções em **${nomesOutros.join(", ")}**. `;
            }
          }
        }
      } catch(e) { console.error(`[GuardRail E] Erro ao gerar aviso de cidade: ${e?.message || e}`); /* não quebra */ }
      // Monta prompt para IA
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
1. Se a Opção 1 tiver resultados, comece oferecendo a intenção no local alternativo (Ex: "Olha, não tenho ${categoriaAlvo || 'isso'} em ${cidadeNomeAlvo || 'sua cidade'}, mas tenho uma excelente opção em [Cidade do Parceiro Try 2]:"). Mencione o nome da cidade alternativa. Liste os parceiros da Opção 1 formatados ("• **Nome** · categoria · Descrição.").
2. Se a Opção 2 tiver resultados, ofereça a categoria alternativa no local original (Ex: "Se preferir ficar em ${cidadeNomeAlvo || 'sua cidade'}, tenho ótimos [${categoriaIrma}] como:"). Liste os parceiros da Opção 2 formatados.
3. Combine as frases se ambas existirem, sempre oferecendo a Opção 1 primeiro. Se só uma opção tiver resultados, use apenas a frase correspondente.
4. NUNCA diga que a busca falhou ou que não achou resultados exatos. Apenas apresente as alternativas encontradas.

[Pergunta]: "${userText}"
Responda combinando as instruções acima. Use a lista de parceiros fornecida.
`.trim();
      const respostaIA = await geminiTry(promptVendedor);
      // Pega refinamento final (usa categoria original)
      const refinamentoFinal = await gerarRespostaDeListaParceiros(userText, null, combinados, categoriaAlvo);
      const textoRefinamento = refinamentoFinal.split('\n').pop() || "";
      // Responde
      return await updateSessionAndRespond({ res, runId, conversationId, userText, aiResponseText: avisoCidade + respostaIA + "\n\n" + textoRefinamento, sessionData, regiaoId: regiao.id, partners: combinados });
    }

    // ===================== CLIMA =====================
    if (tipoIntencao === "clima") {
      const when = detectTemporalWindow(userText);
      const tipoDadoAlvo = when === "future" ? "previsao_diaria" : "clima_atual";
      const cidadeAlvoObj = cidadeAlvo; // Renomeado
      const forRegion = isRegionQuery(userText) && !cidadeAlvoObj;
      let cidadesParaBuscar = [];
      if (cidadeAlvoObj) { cidadesParaBuscar.push(cidadeAlvoObj); }
      else if (forRegion) { const nomesVip = ["Arraial do Cabo", "Cabo Frio", "Armação dos Búzios"]; cidadesParaBuscar = cidadesAtivas.filter(c => nomesVip.some(nVip => normalizarTexto(c.nome) === normalizarTexto(nVip))); }
      else { const primeiraVip = cidadesAtivas.find(c => normalizarTexto(c.nome) === "cabo frio") || cidadesAtivas[0]; if (primeiraVip) cidadesParaBuscar.push(primeiraVip); }

      console.log(`[RUN ${runId}] [CLIMA] Buscando dados para: ${cidadesParaBuscar.map(c=>c.nome).join(', ')} | Tipo: ${tipoDadoAlvo}`);

      const dadosClimaticos = (await Promise.all(cidadesParaBuscar.map(async (cidade) => {
        try {
            const { data, error: errCli } = await supabase.from("dados_climaticos").select("dados").eq("cidade_id", cidade.id).eq("tipo_dado", tipoDadoAlvo).order("ts", { ascending: false }).limit(1).maybeSingle();
            if (errCli) { console.error(`[CLIMA DB] Erro ao buscar ${tipoDadoAlvo} para ${cidade.nome}:`, errCli); return null; }
            if (!data?.dados) { console.log(`[CLIMA DB] Nenhum dado recente de ${tipoDadoAlvo} para ${cidade.nome}.`); return null; }

            let registro = { cidade: cidade.nome, tipo: tipoDadoAlvo, registro: data.dados };
            const CIDADES_VIP_NORM = ["arraial do cabo", "cabo frio", "armação dos búzios"];
            if (when === "present" && CIDADES_VIP_NORM.includes(normalizarTexto(cidade.nome))) {
                const { data: mare, error: errMare } = await supabase.from("dados_climaticos").select("dados").eq("cidade_id", cidade.id).eq("tipo_dado", "dados_mare").order("ts", { ascending: false }).limit(1).maybeSingle();
                if (errMare) { console.error(`[CLIMA DB] Erro ao buscar maré para ${cidade.nome}:`, errMare); } else if (mare?.dados) { registro.dados_mare = mare.dados; }

                const { data: agua, error: errAgua } = await supabase.from("dados_climaticos").select("dados").eq("cidade_id", cidade.id).eq("tipo_dado", "temperatura_agua").order("ts", { ascending: false }).limit(1).maybeSingle();
                 if (errAgua) { console.error(`[CLIMA DB] Erro ao buscar temp. água para ${cidade.nome}:`, errAgua); } else if (agua?.dados) { registro.temperatura_agua = agua.dados; }
            }
            return registro;
        } catch (e) {
             console.error(`[CLIMA DB] Exceção ao buscar dados para ${cidade.nome}:`, e);
             return null;
        }
      }))).filter(Boolean);

      if (dadosClimaticos.length > 0) {
        const payload = { tipoConsulta: forRegion ? "resumo_regiao" : "cidade_especifica", janelaTempo: when, dados: dadosClimaticos };
        const horaLocal = getHoraLocalSP();
        const promptFinal = `
${PROMPT_MESTRE_V14}
# CONTEXTO CLIMA/MAR
Hora local: ${horaLocal} | Região: ${regiao.nome} | DADOS: ${JSON.stringify(payload)}
[Histórico]: ${historicoParaTextoSimplesWrapper(historico)}
[Pergunta]: "${userText}"
Responda interpretando os DADOS para responder à Pergunta. Seja direto. Se pedir previsão e não houver ('previsao_diaria' vazia nos DADOS), diga que não há previsão consolidada. Se pedir clima atual e não houver ('clima_atual' vazio), peça para tentar mais tarde. Se houver dados de maré/água, inclua-os na resposta se relevante.`.trim();
        const respostaIA = await geminiTry(promptFinal);
        return await updateSessionAndRespond({ res, runId, conversationId, userText, aiResponseText: respostaIA, sessionData, regiaoId: regiao.id });
      } else {
        console.log(`[RUN ${runId}] [CLIMA] Nenhum dado encontrado no cache para a consulta.`);
        const respostaIA = (when === 'future') ? "Ainda não tenho dados consolidados da previsão do tempo para os próximos dias. Posso ajudar com o clima de *hoje*?" : "Não consegui consultar os dados climáticos de hoje agora. Por favor, tente em alguns minutos.";
        return await updateSessionAndRespond({ res, runId, conversationId, userText, aiResponseText: respostaIA, sessionData, regiaoId: regiao.id });
      }
    }

    // ===================== ROTA =====================
    if (tipoIntencao === "rota") {
      const textoRota = await montarTextoDeRota({ slugDaRegiao, pergunta: userText });
      return await updateSessionAndRespond({ res, runId, conversationId, userText, aiResponseText: textoRota, sessionData, regiaoId: regiao.id });
    }

    // ===================== GERAL =====================
    console.log(`[RUN ${runId}] [GERAL] Intenção não reconhecida como parceiro/clima/rota. Usando fallback geral.`);
    const respostaGeral = await gerarRespostaGeral({
      pergunta: userText, slugDaRegiao, conversaId: conversationId,
    });
    return await updateSessionAndRespond({ res, runId, conversationId, userText, aiResponseText: respostaGeral, sessionData, regiaoId: regiao.id });

  } catch (erro) {
    console.error(`[RUN ${runId}] ERRO FATAL NA ROTA /api/chat/:slugDaRegiao:`, erro);
    return res.status(500).json({
      reply: "Ops, encontrei um problema temporário. Por favor, tente sua pergunta novamente em um instante.",
    });
  }
});


// ---- ROTA AVISOS PÚBLICOS ----
app.get("/api/avisos/:slugDaRegiao", async (req, res) => {
  try {
    const { slugDaRegiao } = req.params;
    const { data: regiao, error: erroRegiao } = await supabase.from("regioes").select("id").eq("slug", slugDaRegiao).single();
    if (erroRegiao || !regiao) { return res.status(404).json({ error: "Região não encontrada." }); }
    const { data: avisos, error: erroAvisos } = await supabase
      .from("avisos_publicos")
      .select(`id, regiao_id, cidade_id, titulo, descricao, periodo_inicio, periodo_fim, ativo, created_at, cidades:cidade_id ( nome )`)
      .eq("regiao_id", regiao.id).eq("ativo", true).order("periodo_inicio", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false, nullsFirst: false });
    if (erroAvisos) throw erroAvisos;
    const normalized = (avisos || []).map((a) => ({
      id: a.id, regiao_id: a.regiao_id, cidade_id: a.cidade_id, cidade_nome: a?.cidades?.nome || null,
      titulo: a.titulo, descricao: a.descricao, periodo_inicio: a.periodo_inicio, periodo_fim: a.periodo_fim,
      ativo: a.ativo === true, created_at: a.created_at,
    }));
    return res.status(200).json({ data: normalized });
  } catch (erro) {
    console.error("[/api/avisos/:slugDaRegiao] Erro:", erro);
    return res.status(500).json({ error: "Erro interno no servidor ao buscar avisos." });
  }
});

// ---- STARTUP ----
app
  .listen(PORT, HOST, () => {
    console.log(`[BOOT] BEPIT ouvindo em http://${HOST}:${PORT}`);
    console.log(`[BOOT] v6.3.6 (Ordem Corrigida) ATIVO.`); // Log de versão
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
