// /backend-oficial/server/index.js
// ============================================================================
// BEPIT Nexus - Servidor (Express) — Unificado
// Orquestrador Lógico — Arquitetura "Cache-First + Classificador + Roteamento"
// v6.2.0 (Unificação: uma única instância Express + CORS + Rotas modulares)
// ============================================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import financeiroRoutes from "./routes/financeiro.routes.js";
import uploadsRoutes from "./routes/uploads.routes.js";
import ragRoutes from "./routes/rag.routes.js";
import parceiroRoutes from "./routes/parceiro.routes.js";
import { supabase } from "../lib/supabaseClient.js";
import { buscarParceirosTolerante } from "./utils/searchPartners.js";
import { hybridSearch } from "../services/rag.service.js";



// === DEBUG: listar rotas montadas (use só em desenvolvimento) ===
function printRoutes(app, label = "APP") {
  try {
    const lines = [];
    app?._router?.stack?.forEach?.((layer) => {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods)
          .map((m) => m.toUpperCase())
          .join(",");
        lines.push(`${methods.padEnd(6)} ${layer.route.path}`);
      } else if (layer.name === "router" && layer.handle?.stack) {
        const prefix = (layer.regexp && layer.regexp.toString()) || "(subrouter)";
        layer.handle.stack.forEach((l2) => {
          if (l2.route?.path) {
            const methods = Object.keys(l2.route.methods)
              .map((m) => m.toUpperCase())
              .join(",");
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
// Variáveis de ambiente esperadas:
//   UPSTASH_REDIS_REST_URL  (ou UPSTASH_REDIS_URL)
//   UPSTASH_REDIS_REST_TOKEN (ou UPSTASH_REDIS_TOKEN)
const UPSTASH_URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_URL || "";
const UPSTASH_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_TOKEN || "";

function hasUpstash() {
  return !!UPSTASH_URL && !!UPSTASH_TOKEN;
}

function withTimeout(promise, ms, label = "op") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return Promise.race([
    promise(ctrl.signal),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`[CACHE TIMEOUT] ${label} excedeu ${ms}ms`)), ms)
    ),
  ]).finally(() => clearTimeout(t));
}

const upstash = {
  async get(key, { timeoutMs = 400 } = {}) {
    if (!hasUpstash()) throw new Error("[UPSTASH] Config ausente (URL/TOKEN).");
    const url = `${UPSTASH_URL.replace(/\/+$/, "")}/get/${encodeURIComponent(key)}`;
    return await withTimeout(async (signal) => {
      const resp = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
        signal,
      });
      if (!resp.ok) throw new Error(`[UPSTASH] GET falhou: ${resp.status} ${resp.statusText}`);
      const json = await resp.json();
      return json?.result ?? null; // { result: "valor" } ou { result: null }
    }, timeoutMs, `GET ${key}`);
  },

  async exists(key, { timeoutMs = 400 } = {}) {
    if (!hasUpstash()) throw new Error("[UPSTASH] Config ausente (URL/TOKEN).");
    const url = `${UPSTASH_URL.replace(/\/+$/, "")}/exists/${encodeURIComponent(key)}`;
    return await withTimeout(async (signal) => {
      const resp = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
        signal,
      });
      if (!resp.ok) throw new Error(`[UPSTASH] EXISTS falhou: ${resp.status} ${resp.statusText}`);
      const json = await resp.json();
      return Number(json?.result || 0) > 0; // { result: 0 | 1 }
    }, timeoutMs, `EXISTS ${key}`);
  },

  async set(key, value, ttlSeconds, { timeoutMs = 400 } = {}) {
    if (!hasUpstash()) throw new Error("[UPSTASH] Config ausente (URL/TOKEN).");
    const base = `${UPSTASH_URL.replace(/\/+$/, "")}/set/${encodeURIComponent(
      key
    )}/${encodeURIComponent(value)}`;
    const url = ttlSeconds ? `${base}?EX=${encodeURIComponent(ttlSeconds)}` : base;
    return await withTimeout(async (signal) => {
      const resp = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
        signal,
      });
      if (!resp.ok) throw new Error(`[UPSTASH] SET falhou: ${resp.status} ${resp.statusText}`);
      const json = await resp.json();
      return json?.result === "OK";
    }, timeoutMs, `SET ${key}`);
  },
};

// ============================== APP ÚNICO ===================================
const app = express();
const PORT = process.env.PORT || 3002;
const HOST = "0.0.0.0";

// ------------------------------ CORS ----------------------------------------
const EXPLICIT_ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://localhost:3000",
  "https://bepitnexus.netlify.app",
  "https://bepit-nexus.netlify.app",
]);
if (process.env.CORS_EXTRA_ORIGINS) {
  process.env.CORS_EXTRA_ORIGINS
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((o) => EXPLICIT_ALLOWED_ORIGINS.add(o));
}
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/(deploy-preview-\d+--)?bepitnexus\.netlify\.app$/,
  /^https:\/\/(deploy-preview-\d+--)?bepit-nexus\.netlify\.app$/,
  /^http:\/\/localhost:(3000|5173)$/,
];

function isOriginAllowed(origin) {
  if (!origin) return true; // requests server-side / curl etc.
  if (EXPLICIT_ALLOWED_ORIGINS.has(origin)) return true;
  return ALLOWED_ORIGIN_PATTERNS.some((rx) => rx.test(origin));
}

// Pré-voo manual para reduzir 403 indevidos em OPTIONS
app.use((req, res, next) => {
  if (req.method !== "OPTIONS") return next();
  const origin = req.headers.origin || "";
  if (!isOriginAllowed(origin)) {
    return res.status(403).send("CORS: Origem não permitida por política de segurança.");
  }
  res.header("Access-Control-Allow-Origin", origin);
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-admin-key, authorization, Accept");
  res.header("Access-Control-Max-Age", "600");
  return res.sendStatus(204);
});

// CORS efetivo
app.use(
  cors({
    origin: (origin, cb) => (isOriginAllowed(origin) ? cb(null, true) : cb(new Error("CORS block"))),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-admin-key", "authorization", "Accept"],
  })
);

// Body parser
app.use(express.json({ limit: "25mb" }));

// ------------------------------ ROTAS MODULARES ------------------------------
// Importantes: a rota de ping do parceiro (GET /api/parceiro/_ping) está definida
// dentro de parceiro.routes.js. Ao montar abaixo, ela passa a responder corretamente.
app.use("/api/parceiro", parceiroRoutes);
app.use("/api/rag", ragRoutes);
app.use("/api/financeiro", financeiroRoutes);
app.use("/api/uploads", uploadsRoutes);

// ------------------------------ HEALTHCHECKS --------------------------------
app.get("/", (_req, res) => res.status(200).send("BEPIT backend ativo ✅"));
app.get("/ping", (_req, res) => res.status(200).json({ pong: true, ts: Date.now() }));

// Health global do app principal (porta 3002)
app.get("/_ping", (_req, res) =>
  res.json({ ok: true, app: "app", now: new Date().toISOString() })
);

// ============================== IA (Gemini REST) =============================
const usarGeminiREST = String(process.env.USE_GEMINI_REST || "") === "1";
const chaveGemini = process.env.GEMINI_API_KEY || "";
const AI_DISABLED = String(process.env.AI_DISABLED || "") === "1";

function stripModelsPrefix(id) {
  return String(id || "").replace(/^models\//, "");
}
async function listarModelosREST() {
  if (!chaveGemini) throw new Error("[GEMINI REST] GEMINI_API_KEY não definida.");
  const url = `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(
    chaveGemini
  )}`;
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    const texto = await resp.text().catch(() => "");
    throw new Error(
      `[GEMINI REST] Falha ao listar modelos: ${resp.status} ${resp.statusText} ${texto}`
    );
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
    console.warn(
      `[GEMINI REST] GEMINI_MODEL "${envModelo}" indisponível. Disponíveis: ${disponiveis.join(", ")}`
    );
  }
  const preferencia = [
    envModelo && stripModelsPrefix(envModelo),
    "gemini-2.5-flash",
    "gemini-1.5-flash-latest",
    "gemini-1.5-pro-latest",
  ].filter(Boolean);
  for (const alvo of preferencia) if (disponiveis.includes(alvo)) return alvo;
  const qualquer = disponiveis.find((n) => /^gemini-/.test(n));
  if (qualquer) return qualquer;
  throw new Error("[GEMINI REST] Não foi possível selecionar modelo.");
}
async function gerarConteudoComREST(modelo, texto) {
  if (!chaveGemini) throw new Error("[GEMINI REST] GEMINI_API_KEY não definida.");
  const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(
    modelo
  )}:generateContent?key=${encodeURIComponent(chaveGemini)}`;
  const payload = { contents: [{ role: "user", parts: [{ text: String(texto || "") }] }] };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const texto = await resp.text().catch(() => "");
    throw new Error(
      `[GEMINI REST] Falha no generateContent: ${resp.status} ${resp.statusText} ${texto}`
    );
  }
  const json = await resp.json();
  const parts = json?.candidates?.[0]?.content?.parts;
  const out = Array.isArray(parts)
    ? parts.map((p) => p?.text || "").join("\n").trim()
    : "";
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

// ============================== HELPERS =====================================
function normalizarTexto(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
function getHoraLocalSP() {
  try {
    const fmt = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
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
async function updateSessionAndRespond({
  res,
  runId, // opcional para logs
  conversationId,
  userText,
  aiResponseText,
  sessionData,
  regiaoId,
  partners = [],
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

  // Cache curto na Upstash (15 minutos)
  const TTL_SECONDS = 900;
  if (hasUpstash()) {
    try {
      console.log(`[RUN ${_run}] [CACHE] SET com timeout curto...`);
      await upstash.set(conversationId, JSON.stringify(novaSessionData), TTL_SECONDS, { timeoutMs: 400 });
      console.log(`[RUN ${_run}] [CACHE] Sessão salva com sucesso.`);
    } catch (e) {
      console.error(`[RUN ${_run}] [CACHE] Falha ao salvar sessão:`, e?.message || e);
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
async function ensureConversation(req) {
  const body = req.body || {};
  let conversationId = body.conversationId || body.threadId || body.sessionId || null;

  console.log("[RAIO-X PONTO 2.1] ensureConversation iniciado.");

  if (!conversationId || typeof conversationId !== "string" || conversationId.trim().length < 10) {
    conversationId = randomUUID();
    try {
      await supabase.from("conversas").insert({
        id: conversationId,
        regiao_id: req.ctx?.regiao?.id || null,
      });
    } catch {
      // idempotência
    }
  } else {
    try {
      const { data: existe } = await supabase
        .from("conversas")
        .select("id")
        .eq("id", conversationId)
        .maybeSingle();
      if (!existe) {
        await supabase.from("conversas").insert({
          id: conversationId,
          regiao_id: req.ctx?.regiao?.id || null,
        });
      }
    } catch {
      // segue fluxo
    }
  }

  console.log("[RAIO-X PONTO 2.2] Conversa garantida no Supabase. Checando 1º turno...");

  let isFirstTurn = false;

  if (hasUpstash()) {
    try {
      console.log("[RAIO-X PONTO 2.3] EXISTS no cache (timeout curto)...");
      const exists = await upstash.exists(conversationId, { timeoutMs: 400 });
      isFirstTurn = !exists;
      console.log(`[RAIO-X PONTO 2.3] EXISTS concluído. sessionExists=${exists}`);
    } catch (e) {
      console.warn("[RAIO-X PONTO 2.3] Falha no cache EXISTS. Fallback Supabase.", e?.message || e);
      try {
        const { count } = await supabase
          .from("interacoes")
          .select("*", { count: "exact", head: true })
          .eq("conversation_id", conversationId);
        isFirstTurn = (count || 0) === 0;
      } catch {
        isFirstTurn = false;
      }
    }
  } else {
    console.warn("[RAIO-X PONTO 2.3] Cache não configurado. Usando Supabase para checar 1º turno.");
    try {
      const { count } = await supabase
        .from("interacoes")
        .select("*", { count: "exact", head: true })
        .eq("conversation_id", conversationId);
      isFirstTurn = (count || 0) === 0;
    } catch {
      isFirstTurn = false;
    }
  }

  console.log(
    `[RAIO-X PONTO 2.4] ensureConversation concluído. conversationId=${conversationId}, isFirstTurn=${isFirstTurn}`
  );

  req.ctx = Object.assign({}, req.ctx || {}, { conversationId, isFirstTurn });
  return { conversationId, isFirstTurn };
}

// ---------------------- CLASSIFICAÇÃO/EXTRAÇÃO -------------------------------
function normalizar(texto) {
  return normalizarTexto(texto);
}
function isSaudacao(texto) {
  const t = normalizar(texto);
  const saudacoes = ["oi", "ola", "olá", "bom dia", "boa tarde", "boa noite", "e ai", "e aí", "tudo bem"];
  return saudacoes.includes(t);
}
function isWeatherQuestion(texto) {
  const t = normalizar(texto);
  const termos = [
    "clima",
    "tempo",
    "previsao",
    "previsão",
    "vento",
    "mar",
    "marea",
    "maré",
    "ondas",
    "onda",
    "temperatura",
    "graus",
    "calor",
    "frio",
    "chovendo",
    "chuva",
    "sol",
    "ensolarado",
    "nublado",
  ];
  return termos.some((k) => t.includes(k));
}
function detectTemporalWindow(texto) {
  const t = normalizar(texto);
  const sinaisFuturo = [
    "amanha",
    "amanhã",
    "semana que vem",
    "proxima semana",
    "próxima semana",
    "sabado",
    "sábado",
    "domingo",
    "proximos dias",
    "próximos dias",
    "daqui a",
  ];
  return sinaisFuturo.some((s) => t.includes(s)) ? "future" : "present";
}
function extractCity(texto, cidadesAtivas) {
  const t = normalizar(texto || "");
  const lista = Array.isArray(cidadesAtivas) ? cidadesAtivas : [];
  const apelidos = [
    { key: "arraial", nome: "Arraial do Cabo" },
    { key: "arraial do cabo", nome: "Arraial do Cabo" },
    { key: "cabo frio", nome: "Cabo Frio" },
    { key: "buzios", nome: "Armação dos Búzios" },
    { key: "búzios", nome: "Armação dos Búzios" },
    { key: "armacao dos buzios", nome: "Armação dos Búzios" },
    { key: "armação dos búzios", nome: "Armação dos Búzios" },
    { key: "rio das ostras", nome: "Rio das Ostras" },
    { key: "sao pedro", nome: "São Pedro da Aldeia" },
    { key: "são pedro", nome: "São Pedro da Aldeia" },
  ];
  const hitApelido = apelidos.find((a) => t.includes(a.key));
  if (hitApelido) {
    const alvo = lista.find((c) => normalizar(c.nome) === normalizar(hitApelido.nome));
    if (alvo) return alvo;
  }
  for (const c of lista) {
    if (t.includes(normalizar(c.nome)) || t.includes(normalizar(c.slug))) {
      return c;
    }
  }
  return null;
}
function isRegionQuery(texto) {
  const t = normalizar(texto);
  const mencionaRegiao =
    t.includes("regiao") || t.includes("região") || t.includes("regiao dos lagos") || t.includes("região dos lagos");
  return mencionaRegiao;
}

// -------------------------- PROMPT MESTRE v1.3 ------------------------------
const PROMPT_MESTRE_V13 = `
# 1. IDENTIDADE E MISSÃO
- Você é o BEPIT, um concierge de turismo especialista e confiável na Região dos Lagos.
- Sua missão é fornecer informações precisas baseadas EXCLUSIVAMENTE nos dados fornecidos. Você NUNCA usa conhecimento externo.
# 2. DIRETRIZES GERAIS
- Seja proativo, amigável e honesto.
- Priorize sempre os parceiros cadastrados.
- **REGRA DE ETIQUETA:** Se a conversa já começou (ou seja, se não for a primeira mensagem), NUNCA inicie sua resposta com "Olá!", "Seja bem-vindo" ou qualquer outra saudação.
Vá direto ao ponto ou use uma transição curta como "Claro," ou "Entendido,".
# 3. MÓDULO DE RACIOCÍNIO: CONCIERGE DE CLIMA, MARÉS E ATIVIDADES CONTEXTUAIS
- Sua função é ser um "conselheiro" para o turista, conectando dados brutos a atividades práticas e contextuais.
- **REGRA DE OURO DE CONTEXTO:** Você DEVE usar a "HORA ATUAL" fornecida para dar sugestões apropriadas.
- **SE FOR DE MANHÃ (até 10:00):**
    - Se \`ondas\` e \`vento\` estiverem baixos, sua sugestão principal deve ser um **passeio de barco**.
Ex: "O dia está simplesmente perfeito para um passeio de barco agora pela manhã!"
- **SE FOR "MEIO DO DIA" (das 10:01 às 14:00):**
    - Se \`ondas\` e \`vento\` estiverem baixos, você ainda pode sugerir passeio de barco, mas com um tom de "última chamada".
Ex: "O tempo está ótimo para um passeio de barco! Se você ainda conseguir uma vaga em alguma embarcação, vale muito a pena!"
- Se as condições do mar **não** estiverem boas para barco, sua sugestão alternativa deve ser o **Shopping Park Lagos**.
Ex: "O mar está um pouco agitado para passeios agora, mas é uma ótima oportunidade para conhecer o Shopping Park Lagos em Cabo Frio."
- **SE FOR DE TARDE (das 14:01 às 17:00):**
    - **NUNCA MAIS** sugira passeio de barco.
- Se o tempo estiver bom (sol/sem chuva), sua sugestão principal deve ser **curtir uma praia**.
Ex: "A tarde está linda e o sol ainda está forte, perfeito para aproveitar a praia!"
- **SE FOR FIM DE TARDE / NOITE (a partir das 17:01):**
    - **NUNCA** sugira atividades de praia ou barco como algo a se fazer "agora".
- Use a temperatura para contextualizar sugestões noturnas.
    - **EXEMPLO DE SUGESTÃO NOTURNA:** "A noite em Búzios está muito agradável, com cerca de 26°C. É uma temperatura perfeita para uma caminhada pela Rua das Pedras ou para explorar o polo gastronômico do bairro da Passagem em Cabo Frio."
- Você pode, opcionalmente, mencionar como o dia esteve: "O mar esteve ótimo para mergulho hoje..." mas a sua sugestão de ação deve ser para a noite.
- **REGRAS ADICIONAIS (qualquer horário):**
    - Se a \`temperatura da água\` estiver agradável (>22°C), mencione que "o mar está ótimo para um mergulho".
- Se o \`vento\` estiver moderado/alto (>5 m/s), mencione que "as condições estão favoráveis para esportes a vela, como windsurf ou kitesurf".
- Se houver dados de maré, informe os horários e a dica sobre a pesca.
- **Regra para Resumo da Região:** Se você receber uma lista de dados climáticos para múltiplas cidades, sua tarefa é criar um resumo comparativo e conciso para o usuário.
Comece com uma frase como "O tempo na Região dos Lagos está variado hoje!".
Em seguida, resuma a condição de cada cidade. Ex: "Em Cabo Frio, o céu está com poucas nuvens e 25°C. Já em Búzios, está ensolarado com 26°C..."
- **Regra de honestidade futuro:** Se você não receber dados de \`previsao_diaria\` ao ser perguntado sobre o futuro, sua resposta deve ser: "Ainda não tenho os dados consolidados para a previsão futura. Meu robô de coleta de dados trabalha constantemente para me atualizar. Por favor, tente novamente mais tarde."
# 4. DADOS CONTEXTUAIS (serão injetados abaixo)
- HORA ATUAL (São Paulo): [[HORA_ATUAL]]
- REGIÃO ATUAL: [[REGIAO]]
- [DADOS CLIMA / MARÉS / ÁGUA]: 
[[DADOS_JSON]]
# 5. TAREFA FINAL
Com base nas regras e nos dados fornecidos, formule a melhor e mais útil resposta.
`.trim();

// ============================== LISTA VIP ===================================
const CIDADES_VIP = ["arraial do cabo", "cabo frio", "armação dos búzios"];

// ======================= FALLBACKS SEM IA ===================================
function montarListaParceirosSemIA(parceiros) {
  const items = (parceiros || []).slice(0, 8);
  if (!items.length)
    return "Não encontrei parceiros para esse filtro no momento. Quer tentar com outra categoria ou cidade?";
  const linhas = items.map((p, i) => `${i + 1}. **${p.nome}** — ${p.descricao || "sem descrição"}`);
  return `${linhas.join("\n")}\n\nAlguma dessas opções te interessou? Me diga o número ou o nome para ver mais detalhes.`;
}
function montarResumoClimaSemIA({ dadosIA, regiaoNome, horaLocalSP }) {
  try {
    const { when, escopo, resultados = [], cidade } = dadosIA || {};
    const introWhen = when === "future" ? "para os próximos dias" : "agora";
    if (!resultados.length) return "Ainda não tenho dados climáticos consolidados para essa consulta.";

    if (escopo === "regiao") {
      const linhas = resultados.map((r) => {
        const nome = r.cidade || "Cidade";
        const tipo = r.tipo;
        const d = r?.registro?.dados || {};
        const resumo =
          tipo === "previsao_diaria"
            ? `previsão diária disponível (${(d?.daily || []).length || 0} dias)`
            : `${d?.condicao || d?.descricao || "condições atuais"}${d?.temp ? `, ${d.temp}°C` : ""}`;
        return `- ${nome}: ${resumo}`;
      });
      return `Resumo do clima na ${regiaoNome} ${introWhen} (hora local ${horaLocalSP}):\n${linhas.join("\n")}`;
    }

    const r0 = resultados[0];
    const d = r0?.registro?.dados || {};
    if (r0?.tipo === "previsao_diaria") {
      const dias = Array.isArray(d?.daily) ? d.daily.slice(0, 5) : [];
      const linhas = dias.map((dia) => {
        const label = dia?.data || dia?.date || "";
        const tmax = dia?.tmax ?? dia?.max ?? "";
        const tmin = dia?.tmin ?? dia?.min ?? "";
        const cond = dia?.condicao || dia?.descricao || "";
        return `- ${label}: ${cond} ${tmin && tmax ? `(${tmin}°C–${tmax}°C)` : ""}`;
      });
      return `Previsão para ${cidade?.nome || "a cidade"}: \n${linhas.join("\n")}`;
    } else {
      const cond = d?.condicao || d?.descricao || "condições atuais";
      const t = d?.temp ? `${d.temp}°C` : "";
      return `Condições em ${cidade?.nome || "a cidade"} ${introWhen}: ${cond} ${t}`.trim();
    }
  } catch {
    return "Não foi possível montar o resumo climático agora.";
  }
}

// ============================== PARCEIROS ===================================
const PALAVRAS_CHAVE = {
  comida: [
    "restaurante",
    "restaurantes",
    "almoço",
    "almoco",
    "jantar",
    "comer",
    "comida",
    "picanha",
    "piconha",
    "carne",
    "churrasco",
    "pizza",
    "pizzaria",
    "peixe",
    "frutos do mar",
    "moqueca",
    "rodizio",
    "rodízio",
    "lanchonete",
    "burger",
    "hamburguer",
    "hambúrguer",
    "bistrô",
    "bistro",
  ],
  hospedagem: ["pousada", "pousadas", "hotel", "hotéis", "hospedagem", "hostel", "airbnb"],
  bebidas: ["bar", "bares", "chopp", "chope", "drinks", "pub", "boteco"],
  passeios: [
    "passeio",
    "passeios",
    "barco",
    "lancha",
    "escuna",
    "trilha",
    "trilhas",
    "tour",
    "buggy",
    "quadriciclo",
    "city tour",
    "catamarã",
    "catamara",
    "mergulho",
    "snorkel",
    "gruta",
    "ilha",
  ],
  praias: ["praia", "praias", "faixa de areia", "bandeira azul", "mar calmo", "mar forte"],
  transporte: [
    "transfer",
    "transporte",
    "alugar carro",
    "aluguel de carro",
    "uber",
    "taxi",
    "ônibus",
    "onibus",
    "rodoviária",
    "rodoviaria",
  ],
};

function forcarBuscaParceiro(texto) {
  const t = normalizarTexto(texto);
  for (const lista of Object.values(PALAVRAS_CHAVE)) {
    if (lista.some((p) => t.includes(p))) return true;
  }
  return false;
}

async function extrairEntidadesDaBusca(texto) {
  const tNorm = normalizarTexto(texto || "");

  let cidade = null;
  if (tNorm.includes("cabo frio")) cidade = "Cabo Frio";
  else if (tNorm.includes("buzios") || tNorm.includes("búzios")) cidade = "Armação dos Búzios";
  else if (tNorm.includes("arraial")) cidade = "Arraial do Cabo";
  else if (tNorm.includes("sao pedro") || tNorm.includes("são pedro")) cidade = "São Pedro da Aldeia";

  const DIC_TERMS = [
    "picanha",
    "piconha",
    "carne",
    "churrasco",
    "rodizio",
    "rodízio",
    "fraldinha",
    "costela",
    "barato",
    "barata",
    "familia",
    "família",
    "romantico",
    "romântico",
    "vista",
    "vista para o mar",
    "rodizio",
    "pizza",
    "peixe",
    "frutos do mar",
    "moqueca",
    "hamburguer",
    "hambúrguer",
    "sushi",
    "japonesa",
    "bistrô",
    "bistro",
  ];
  const terms = [];
  for (const w of DIC_TERMS) if (tNorm.includes(normalizarTexto(w))) terms.push(w);

  let category = null;
  if (
    [
      "restaurante",
      "comer",
      "comida",
      "picanha",
      "piconha",
      "carne",
      "churrasco",
      "rodizio",
      "rodízio",
      "pizza",
      "pizzaria",
      "peixe",
      "frutos do mar",
      "hamburguer",
      "hambúrguer",
      "bistrô",
      "bistro",
      "sushi",
      "japonesa",
    ].some((k) => tNorm.includes(k))
  ) {
    category = "comida";
  } else if (
    ["pousada", "hotel", "hostel", "hospedagem", "airbnb", "apart", "flat", "resort"].some((k) =>
      tNorm.includes(k)
    )
  ) {
    category = "hospedagem";
  } else if (["bar", "bares", "chopp", "chope", "drinks", "pub", "boteco"].some((k) => tNorm.includes(k))) {
    category = "bebidas";
  } else if (
    ["passeio", "barco", "lancha", "escuna", "trilha", "buggy", "quadriciclo", "mergulho", "snorkel", "tour"].some(
      (k) => tNorm.includes(k)
    )
  ) {
    category = "passeios";
  } else if (["praia", "praias", "bandeira azul", "orla"].some((k) => tNorm.includes(k))) {
    category = "praias";
  } else if (
    ["transfer", "transporte", "aluguel de carro", "locadora", "uber", "taxi", "ônibus", "onibus"].some((k) =>
      tNorm.includes(k)
    )
  ) {
    category = "transporte";
  }

  return { category, city: cidade, terms };
}

// ============================== BUSCA PARCEIROS ==============================
// NOTA: esta função depende de um serviço existente no seu projeto chamado
// `buscarParceirosTolerante`. Caso ele não esteja neste arquivo e sim num
// serviço externo, mantenha a importação original que você já usa.
// Aqui assumimos que essa função está disponível no escopo global do projeto.
async function ferramentaBuscarParceirosOuDicas({
  cidadesAtivas,
  argumentosDaFerramenta,
  textoOriginal,
  isInitialSearch = false,
  excludeIds = [],
}) {
  const categoriaProcurada = (argumentosDaFerramenta?.category || "").trim();
  const cidadeProcurada = (argumentosDaFerramenta?.city || "").trim();

  const textoN = normalizarTexto(textoOriginal || "");
  const sinaisCarne = ["picanha", "piconha", "carne", "churrasco", "rodizio", "rodízio"].some((s) =>
    textoN.includes(s)
  );
  const sinaisVista = ["vista", "vista para o mar", "beira mar", "orla"].some((s) => textoN.includes(s));

  const cidadesValidas = Array.isArray(cidadesAtivas) ? cidadesAtivas : [];
  let cidadeSlug = "";
  if (cidadeProcurada) {
    const alvo = cidadesValidas.find(
      (c) =>
        normalizarTexto(c.nome) === normalizarTexto(cidadeProcurada) ||
        normalizarTexto(c.slug) === normalizarTexto(cidadeProcurada)
    );
    cidadeSlug = alvo?.slug || "";
  }
  if (!cidadeSlug && cidadesValidas.length > 0) cidadeSlug = cidadesValidas[0].slug;

  const MAPA_CESTA_PARA_CATEGORIAS_DB = {
    comida: [
      "churrascaria",
      "restaurante",
      "pizzaria",
      "lanchonete",
      "frutos do mar",
      "sushi",
      "padaria",
      "cafeteria",
      "bistrô",
      "bistro",
      "hamburgueria",
      "pizza",
    ],
    bebidas: ["bar", "pub", "cervejaria", "wine bar", "balada", "boteco"],
    passeios: [
      "passeio",
      "barco",
      "lancha",
      "escuna",
      "trilha",
      "buggy",
      "quadriciclo",
      "city tour",
      "catamarã",
      "catamara",
      "mergulho",
      "snorkel",
      "gruta",
      "ilha",
      "tour",
    ],
    praias: ["praia", "praias", "bandeira azul", "orla"],
    hospedagem: ["pousada", "hotel", "hostel", "apart", "flat", "resort", "hospedagem"],
    transporte: [
      "transfer",
      "transporte",
      "aluguel de carro",
      "locadora",
      "taxi",
      "ônibus",
      "onibus",
      "rodoviária",
      "rodoviaria",
    ],
  };

  let categoriasAProcurar = [];
  if (categoriaProcurada) categoriasAProcurar.push(normalizarTexto(categoriaProcurada));

  if (categoriaProcurada === "comida" || (!categoriaProcurada && MAPA_CESTA_PARA_CATEGORIAS_DB.comida)) {
    if (sinaisCarne) {
      categoriasAProcurar = ["churrascaria", "restaurante"];
    } else if (categoriasAProcurar.length === 0) {
      categoriasAProcurar = ["restaurante"];
    }
    for (const cat of MAPA_CESTA_PARA_CATEGORIAS_DB.comida) {
      const cn = normalizarTexto(cat);
      if (!categoriasAProcurar.includes(cn)) categoriasAProcurar.push(cn);
    }
  }
  if (
    categoriasAProcurar.length === 0 &&
    categoriaProcurada &&
    MAPA_CESTA_PARA_CATEGORIAS_DB[categoriaProcurada]
  ) {
    categoriasAProcurar = MAPA_CESTA_PARA_CATEGORIAS_DB[categoriaProcurada].map(normalizarTexto);
  }

  let termoDeBusca = null;
  if (sinaisCarne) termoDeBusca = "picanha";
  else if (sinaisVista) termoDeBusca = "vista";
  else {
    const termosConhecidos = [
      "pizza",
      "peixe",
      "rodizio",
      "frutos do mar",
      "moqueca",
      "hamburguer",
      "sushi",
      "bistrô",
      "bistro",
      "barato",
      "família",
      "romântico",
      "vista",
    ];
    const achou = termosConhecidos.find((k) => textoN.includes(normalizarTexto(k)));
    if (achou) termoDeBusca = achou;
  }
  if (!termoDeBusca && categoriasAProcurar.length > 0) termoDeBusca = categoriasAProcurar[0];

  const agregados = [];
  const vistos = new Set();
  const alvoInicialFix = 3;
  const alvoRefinoFix = 5;

  // ATENÇÃO: `buscarParceirosTolerante` deve existir (no seu serviço original).
  // Se está em outro módulo, mantenha a importação que você já utiliza.
  for (const cat of categoriasAProcurar) {
    // eslint-disable-next-line no-undef
    const r = await buscarParceirosTolerante({
      cidadeSlug,
      categoria: cat,
      term: termoDeBusca,
      isInitialSearch: isInitialSearch,
      excludeIds: Array.from(vistos),
    });

    if (r?.ok && Array.isArray(r.items)) {
      for (const it of r.items) {
        if (it?.id && !vistos.has(it.id)) {
          vistos.add(it.id);
          agregados.push(it);
        }
      }
    }

    if (isInitialSearch && agregados.length >= alvoInicialFix) break;
    if (!isInitialSearch && agregados.length >= alvoRefinoFix) break;
  }

  const limiteFinal = isInitialSearch ? alvoInicialFix : alvoRefinoFix;
  const limitados = agregados.slice(0, limiteFinal);

  try {
    await supabase.from("eventos_analytics").insert({
      tipo_evento: "partner_query",
      payload: {
        termos: argumentosDaFerramenta?.terms || [],
        categoriaProcurada,
        cidadeProcurada,
        isInitialSearch,
        excludeIds,
        categoriasTentadas: categoriasAProcurar,
        total_filtrado: limitados.length,
        cidadeSlug,
      },
    });
  } catch {
    // analytics não-bloqueante
  }

  return {
    ok: true,
    count: limitados.length,
    items: limitados.map((p) => ({
      id: p.id,
      tipo: p.tipo,
      nome: p.nome,
      categoria: p.categoria,
      descricao: p.descricao,
      endereco: p.endereco,
      contato: p.contato,
      beneficio_bepit: p.beneficio_bepit,
      faixa_preco: p.faixa_preco,
      fotos_parceiros: Array.isArray(p.fotos_parceiros) ? p.fotos_parceiros : [],
      cidade_id: p.cidade_id,
    })),
  };
}

async function gerarRespostaDeListaParceiros(pergunta, historicoContents, parceiros) {
  const historicoTexto = historicoParaTextoSimplesWrapper(historicoContents);
  const contextoParceiros = JSON.stringify(parceiros ?? [], null, 2);
  const prompt = [
    "Você é um assistente de consulta. Sua única função é apresentar os resultados de uma busca em uma lista numerada.",
    "Para cada estabelecimento no [Contexto], crie um item na lista com o NOME em negrito, seguido por um traço e a DESCRIÇÃO.",
    "NÃO inclua endereço, contato ou qualquer outra informação. Apenas NOME e DESCRIÇÃO.",
    "A lista deve ser clara e objetiva.",
    "Após a lista, finalize com a pergunta: 'Alguma dessas opções te interessou? Me diga o número ou o nome para ver mais detalhes.'",
    "",
    `[Contexto]: ${contextoParceiros}`,
    `[Histórico]:\n${historicoTexto}`,
    `[Pergunta do Usuário]: "${pergunta}"`,
  ].join("\n");

  try {
    return await geminiTry(prompt, { retries: 2 });
  } catch (e) {
    console.warn("[IA indisponível] Listagem de parceiros será gerada sem IA:", e?.message || e);
    return montarListaParceirosSemIA(parceiros);
  }
}

async function gerarRespostaGeralPrompteada({
  pergunta,
  historicoContents,
  regiaoNome,
  dadosClimaOuMaresJSON,
  horaLocalSP,
}) {
  const historicoTexto = historicoParaTextoSimplesWrapper(historicoContents);
  const prompt = PROMPT_MESTRE_V13.replace("[[HORA_ATUAL]]", String(horaLocalSP || ""))
    .replace("[[REGIAO]]", String(regiaoNome || "Região dos Lagos"))
    .replace("[[DADOS_JSON]]", dadosClimaOuMaresJSON || "{}");

  const payload = [
    prompt,
    "",
    `[Histórico de Conversa]:\n${historicoTexto}`,
    `[Pergunta do Usuário]: "${pergunta}"`,
  ].join("\n");

  try {
    return await geminiTry(payload, { retries: 2 });
  } catch (e) {
    console.warn("[IA indisponível] Resposta geral será gerada sem IA:", e?.message || e);
    try {
      const dadosIA = JSON.parse(dadosClimaOuMaresJSON || "{}");
      const texto = montarResumoClimaSemIA({ dadosIA, regiaoNome, horaLocalSP });
      return texto || "Estou com alta demanda agora. Posso te ajudar com indicações e dados disponíveis.";
    } catch {
      return "Estou com alta demanda agora. Posso te ajudar com indicações e dados disponíveis.";
    }
  }
}

async function lidarComNovaBusca({
  textoDoUsuario,
  historicoGemini,
  regiao,
  cidadesAtivas,
  idDaConversa,
  isInitialSearch = true,
  excludeIds = [],
}) {
  const entidades = await extrairEntidadesDaBusca(textoDoUsuario);

  const resultadoBusca = await ferramentaBuscarParceirosOuDicas({
    cidadesAtivas,
    argumentosDaFerramenta: entidades,
    textoOriginal: textoDoUsuario,
    isInitialSearch,
    excludeIds,
  });

  if (resultadoBusca?.ok && (resultadoBusca?.count || 0) > 0) {
    const parceirosSugeridos = resultadoBusca.items || [];
    const respostaModelo = await gerarRespostaDeListaParceiros(
      textoDoUsuario,
      historicoGemini,
      parceirosSugeridos
    );
    const respostaFinal = finalizeAssistantResponse({
      modelResponseText: respostaModelo,
      foundPartnersList: parceirosSugeridos,
      mode: "partners",
    });
    try {
      await supabase
        .from("conversas")
        .update({
          parceiros_sugeridos: parceirosSugeridos,
          parceiro_em_foco: null,
          topico_atual: entidades?.category || null,
        })
        .eq("id", idDaConversa);
    } catch {
      // segue
    }
    return { respostaFinal, parceirosSugeridos };
  } else {
    const respostaModelo = await gerarRespostaGeralPrompteada({
      pergunta: textoDoUsuario,
      historicoContents: historicoGemini,
      regiaoNome: regiao?.nome,
      dadosClimaOuMaresJSON: "{}",
      horaLocalSP: getHoraLocalSP(),
    });
    const respostaFinal = finalizeAssistantResponse({
      modelResponseText: respostaModelo,
      foundPartnersList: [],
      mode: "general",
    });
    return { respostaFinal, parceirosSugeridos: [] };
  }
}

// ============================= FORMATADOR FINAL ==============================
// Mantido do seu código original: formata a resposta final do assistente
function finalizeAssistantResponse({ modelResponseText, foundPartnersList = [], mode = "general" }) {
  const txt = String(modelResponseText || "").trim();
  if (mode === "partners") {
    // Você pode manter qualquer pós-processamento que já usava aqui.
    return txt || "Aqui estão algumas opções de parceiros.";
  }
  return txt || "Posso te ajudar com informações e indicações na Região dos Lagos.";
}

// ============================================================================
// >>>>>>>>>>>>>>>>> ROTA DO CHAT - ORQUESTRADOR v6.0.4 (COM RAIO-X) <<<<<<<<<<
// ============================================================================
app.post("/api/chat/:slugDaRegiao", async (req, res) => {
  const runId = randomUUID();
  try {
    console.log(`[RUN ${runId}] [RAIO-X PONTO 1] Rota /chat iniciada.`);

    const { slugDaRegiao } = req.params;
    const userText = (req.body?.message || "").trim();

    if (userText.length < 1) {
      return res
        .status(400)
        .json({ reply: "Por favor, digite uma mensagem.", conversationId: req.body?.conversationId });
    }

    const { data: regiao } = await supabase
      .from("regioes")
      .select("id, nome")
      .eq("slug", slugDaRegiao)
      .single();
    if (!regiao) return res.status(404).json({ error: "Região não encontrada." });
    req.ctx = { regiao };

    const { data: cidades } = await supabase
      .from("cidades")
      .select("id, nome, slug")
      .eq("regiao_id", regiao.id)
      .eq("ativo", true);
    const cidadesAtivas = cidades || [];
    console.log(`[RUN ${runId}] [RAIO-X PONTO 2] Contexto de região e cidades carregado.`);

    const { conversationId, isFirstTurn } = await ensureConversation(req);

    console.log(
      `[RUN ${runId}] [RAIO-X PONTO 3] Sessão garantida. ID: ${conversationId}, É o primeiro turno: ${isFirstTurn}`
    );

    // Recupera histórico curto do cache (se houver)
    let sessionData = { history: [], entities: {} };
    try {
      if (hasUpstash() && !isFirstTurn) {
        console.log(`[RUN ${runId}] [RAIO-X PONTO 4] Tentando ler do cache Upstash (timeout curto)...`);
        const cachedSession = await upstash.get(conversationId, { timeoutMs: 400 });
        console.log(`[RUN ${runId}] [RAIO-X PONTO 5] Leitura do Upstash concluída.`);
        if (cachedSession) {
          sessionData = JSON.parse(cachedSession);
          console.log(`[RUN ${runId}] [CACHE] Sessão recuperada do cache.`);
        }
      } else if (!hasUpstash()) {
        console.warn(`[RUN ${runId}] [CACHE] Upstash não configurado. Pulando cache.`);
      }
    } catch (e) {
      console.error(`[RUN ${runId}] [CACHE] Falha ao LER sessão (operando sem memória):`, e?.message || e);
      sessionData = { history: [], entities: {} };
    }

    const historico = sessionData.history || [];
    console.log(`[RUN ${runId}] [RAIO-X PONTO 6] Histórico de conversa preparado.`);

    if (isSaudacao(userText)) {
      console.log(`[RUN ${runId}] [RAIO-X PONTO 7] Intenção de saudação detectada.`);
      const resposta = isFirstTurn
        ? `Olá! Seja bem-vindo(a) à ${regiao.nome}! Eu sou o BEPIT, seu concierge de confiança. Minha missão é te conectar com os melhores e mais seguros parceiros da região. Como posso te ajudar a ter uma experiência incrível hoje?`
        : "Oi! Como posso te ajudar agora?";

      return await updateSessionAndRespond({
        res,
        runId,
        conversationId,
        userText,
        aiResponseText: resposta,
        sessionData,
        regiaoId: regiao.id,
      });
    }

    if (isWeatherQuestion(userText)) {
      const when = detectTemporalWindow(userText);
      const tipoDadoAlvo = when === "future" ? "previsao_diaria" : "clima_atual";
      const cidadeAlvo = extractCity(userText, cidadesAtivas);
      const forRegion = isRegionQuery(userText) && !cidadeAlvo;

      let cidadesParaBuscar = [];
      if (cidadeAlvo) {
        cidadesParaBuscar.push(cidadeAlvo);
      } else if (forRegion) {
        const nomesVip = ["Arraial do Cabo", "Cabo Frio", "Armação dos Búzios"];
        cidadesParaBuscar = cidadesAtivas.filter((c) =>
          nomesVip.some((nVip) => normalizarTexto(c.nome) === normalizarTexto(nVip))
        );
      }

      const dadosClimaticos = (
        await Promise.all(
          cidadesParaBuscar.map(async (cidade) => {
            const { data } = await supabase
              .from("dados_climaticos")
              .select("dados")
              .eq("cidade_id", cidade.id)
              .eq("tipo_dado", tipoDadoAlvo)
              .order("data_hora_consulta", { ascending: false })
              .limit(1)
              .single();
            if (!data) return null;

            let registro = { cidade: cidade.nome, [tipoDadoAlvo]: data.dados };

            if (when === "present" && CIDADES_VIP.includes(normalizarTexto(cidade.nome))) {
              const { data: mare } = await supabase
                .from("dados_climaticos")
                .select("dados")
                .eq("cidade_id", cidade.id)
                .eq("tipo_dado", "dados_mare")
                .order("data_hora_consulta", { ascending: false })
                .limit(1)
                .single();
              const { data: agua } = await supabase
                .from("dados_climaticos")
                .select("dados")
                .eq("cidade_id", cidade.id)
                .eq("tipo_dado", "temperatura_agua")
                .order("data_hora_consulta", { ascending: false })
                .limit(1)
                .single();
              if (mare) registro.dados_mare = mare.dados;
              if (agua) registro.temperatura_agua = agua.dados;
            }
            return registro;
          })
        )
      ).filter(Boolean);

      if (dadosClimaticos.length > 0) {
        const payload = {
          tipoConsulta: forRegion ? "resumo_regiao" : "cidade_especifica",
          janelaTempo: when,
          dados: dadosClimaticos,
        };
        const horaLocal = getHoraLocalSP();
        const promptFinal = `${PROMPT_MESTRE_V13.replace("[[HORA_ATUAL]]", horaLocal)
          .replace("[[REGIAO]]", regiao.nome)
          .replace("[[DADOS_JSON]]", JSON.stringify(payload))}\n\n[Histórico de Conversa]:\n${historicoParaTextoSimplesWrapper(
          historico
        )}\n[Pergunta do Usuário]: "${userText}"`;
        const respostaIA = await geminiTry(promptFinal);

        return await updateSessionAndRespond({
          res,
          runId,
          conversationId,
          userText,
          aiResponseText: respostaIA,
          sessionData,
          regiaoId: regiao.id,
        });
      } else {
        const fallback =
          "Ainda não tenho os dados consolidados para esta previsão. Meu robô de coleta de dados trabalha constantemente para me atualizar. Por favor, tente novamente mais tarde.";
        return await updateSessionAndRespond({
          res,
          runId,
          conversationId,
          userText,
          aiResponseText: fallback,
          sessionData,
          regiaoId: regiao.id,
        });
      }
    }

        if (forcarBuscaParceiro(userText)) {
      console.log(`[RUN ${runId}] [RAG] Intent de parceiros detectada — usando hybridSearch.`);

      // 1) Extrai entidade simples já existente no seu código
      const entidades = await extrairEntidadesDaBusca(userText);

      // 2) Resolve cidade_id se o usuário citou a cidade
      let cidadeId = null;
      if (entidades?.city) {
        const alvo = (cidadesAtivas || []).find(
          (c) =>
            normalizarTexto(c.nome) === normalizarTexto(entidades.city) ||
            normalizarTexto(c.slug) === normalizarTexto(entidades.city)
        );
        cidadeId = alvo?.id || null;
      }

      // 3) Categoria (se vier)
      const categoria = entidades?.category || null;

      // 4) Chama a busca híbrida (RAG)
      const ragOut = await hybridSearch({
        q: userText,
        cidade_id: cidadeId,
        categoria,
        limit: 5,
        debug: false,
      });

      // `ragOut` pode ser array direto ou {items, meta}
      const items = Array.isArray(ragOut?.items) ? ragOut.items : ragOut;
      const parceirosSugeridos = (items || []).map((r) => ({
        id: r.id,
        tipo: r.tipo || null,
        nome: r.nome,
        categoria: r.categoria || null,
        descricao: r.descricao || "",
        endereco: r.endereco || null,
        contato: r.contato || null,
        beneficio_bepit: r.beneficio_bepit || null,
        faixa_preco: r.faixa_preco || null,
        fotos_parceiros: Array.isArray(r.fotos_parceiros) ? r.fotos_parceiros : [],
        cidade_id: r.cidade_id || null,
      }));

      // 5) Se achou algo, lista; senão, fallback geral
      let respostaFinal;
      if (parceirosSugeridos.length > 0) {
        const respostaModelo = await gerarRespostaDeListaParceiros(
          userText,
          historico,
          parceirosSugeridos
        );
        respostaFinal = finalizeAssistantResponse({
          modelResponseText: respostaModelo,
          foundPartnersList: parceirosSugeridos,
          mode: "partners",
        });

        try {
          await supabase
            .from("conversas")
            .update({
              parceiros_sugeridos: parceirosSugeridos,
              parceiro_em_foco: null,
              topico_atual: categoria || null,
            })
            .eq("id", conversationId);
        } catch {
          // ignora
        }
      } else {
        // nada encontrado => responde geral (sem IA pesada, se preferir)
        respostaFinal =
          "Não encontrei parceiros que combinem com o que você pediu. Quer tentar com outra palavra, cidade ou categoria?";
      }

      return await updateSessionAndRespond({
        res,
        runId,
        conversationId,
        userText,
        aiResponseText: respostaFinal,
        sessionData,
        regiaoId: regiao.id,
        partners: parceirosSugeridos,
      });
    }


    console.log(`[RUN ${runId}] [RAIO-X PONTO 8] Roteado para Fallback Geral.`);
    const horaLocalSP = getHoraLocalSP();
    const promptGeral = `${PROMPT_MESTRE_V13.replace("[[HORA_ATUAL]]", horaLocalSP)
      .replace("[[REGIAO]]", regiao.nome)
      .replace("[[DADOS_JSON]]", "{}")}\n\n[Histórico de Conversa]:\n${historicoParaTextoSimplesWrapper(
      historico
    )}\n[Pergunta do Usuário]: "${userText}"`;

    console.log(`[RUN ${runId}] [RAIO-X PONTO 9] Tentando chamar a IA Gemini...`);
    const respostaGeral = await geminiTry(promptGeral);
    console.log(`[RUN ${runId}] [RAIO-X PONTO 10] Resposta da IA Gemini recebida.`);

    return await updateSessionAndRespond({
      res,
      runId,
      conversationId,
      userText,
      aiResponseText: respostaGeral,
      sessionData,
      regiaoId: regiao.id,
    });
  } catch (erro) {
    console.error(`[RUN ${runId}] ERRO FATAL NA ROTA:`, erro);
    return res.status(500).json({
      reply:
        "Ops, encontrei um problema temporário. Por favor, tente sua pergunta novamente em um instante.",
    });
  }
});

// ------------------------------ AVISOS PÚBLICOS -----------------------------
app.get("/api/avisos/:slugDaRegiao", async (req, res) => {
  try {
    const { slugDaRegiao } = req.params;

    const { data: regiao, error: erroRegiao } = await supabase
      .from("regioes")
      .select("id")
      .eq("slug", slugDaRegiao)
      .single();

    if (erroRegiao || !regiao) {
      return res.status(404).json({ error: "Região não encontrada." });
    }

    const { data: avisos, error: erroAvisos } = await supabase
      .from("avisos_publicos")
      .select(
        `
        id,
        regiao_id,
        cidade_id,
        titulo,
        descricao,
        periodo_inicio,
        periodo_fim,
        ativo,
        created_at,
        cidades:cidade_id ( nome )
      `
      )
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

// ------------------------------ STARTUP -------------------------------------
app
  .listen(PORT, HOST, () => {
    console.log(`[BOOT] BEPIT ouvindo em http://${HOST}:${PORT}`);
    printRoutes(app, "app");
  })
  .on("error", (err) => {
    console.error("[BOOT] Falha ao subir servidor:", err);
    process.exit(1);
  });

// Encerramento gracioso
process.on("SIGTERM", () => {
  console.log("[SHUTDOWN] Recebido SIGTERM. Encerrando...");
  process.exit(0);
});

export default app;
