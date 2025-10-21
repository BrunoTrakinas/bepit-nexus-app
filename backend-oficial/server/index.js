// /backend-oficial/server/index.js
// ============================================================================
// BEPIT Nexus - Servidor (Express) — Unificado
// Orquestrador Lógico — "Cache-First + Classificador + Roteamento"
// v6.2.1 (partners-first, rotas humanas, anti-alucinação, fontes públicas)
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

// Busca tolerante (se usar) e RAG híbrido (ajuste path se necessário)
import { buscarParceirosTolerante } from "./utils/searchPartners.js";
import { hybridSearch } from "../services/rag.service.js";

// ====================== DEBUG: listar rotas montadas =========================
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
      return json?.result ?? null;
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
      return Number(json?.result || 0) > 0;
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
]);

if (process.env.FRONTEND_ORIGIN) {
  EXPLICIT_ALLOWED_ORIGINS.add(process.env.FRONTEND_ORIGIN.trim());
}
if (process.env.CORS_EXTRA_ORIGINS) {
  process.env.CORS_EXTRA_ORIGINS
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((o) => EXPLICIT_ALLOWED_ORIGINS.add(o));
}

const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/.*\.netlify\.app$/,
  /^http:\/\/localhost:(3000|5173)$/,
];

const CORS_ALLOW_ALL = String(process.env.CORS_ALLOW_ALL || "") === "1";

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (CORS_ALLOW_ALL) return true;
  if (EXPLICIT_ALLOWED_ORIGINS.has(origin)) return true;
  return ALLOWED_ORIGIN_PATTERNS.some((rx) => rx.test(origin));
}

// Pré-voo manual
app.use((req, res, next) => {
  if (req.method !== "OPTIONS") return next();
  const origin = req.headers.origin || "";
  if (!isOriginAllowed(origin)) {
    return res.status(403).send("CORS: origem não permitida.");
  }
  res.header("Access-Control-Allow-Origin", origin);
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Admin-Key, Authorization, Accept, X-Requested-With"
  );
  res.header("Access-Control-Max-Age", "600");
  return res.sendStatus(204);
});

// CORS efetivo
app.use(
  cors({
    origin: (origin, cb) => (isOriginAllowed(origin) ? cb(null, true) : cb(new Error("CORS block"))),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Admin-Key", "Authorization", "Accept", "X-Requested-With"],
  })
);

// Body parser
app.use(express.json({ limit: "25mb" }));

// ------------------------------ ROTAS MODULARES ------------------------------
app.use("/api/parceiro", parceiroRoutes);
app.use("/api/rag", ragRoutes);
app.use("/api/financeiro", financeiroRoutes);
app.use("/api/uploads", uploadsRoutes);

// ------------------------------ HEALTHCHECKS --------------------------------
app.get("/", (_req, res) => res.status(200).send("BEPIT backend ativo ✅"));
app.get("/ping", (_req, res) => res.status(200).json({ pong: true, ts: Date.now() }));
app.get("/_ping", (_req, res) => res.json({ ok: true, app: "app", now: new Date().toISOString() }));

// ============================== IA (Gemini REST) =============================
const usarGeminiREST = String(process.env.USE_GEMINI_REST || "") === "1";
const chaveGemini = process.env.GEMINI_API_KEY || "";
const AI_DISABLED = String(process.env.AI_DISABLED || "") === "1";

function stripModelsPrefix(id) {
  return String(id || "").replace(/^models\//, "");
}
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
  runId,
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

  const TTL_SECONDS = 900;
  if (hasUpstash()) {
    try {
      await upstash.set(conversationId, JSON.stringify(novaSessionData), TTL_SECONDS, { timeoutMs: 400 });
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

  let isFirstTurn = false;

  if (hasUpstash()) {
    try {
      const exists = await upstash.exists(conversationId, { timeoutMs: 400 });
      isFirstTurn = !exists;
    } catch {
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
  // Não deixa clima sequestrar quando houver intenção clara de parceiros
  if (forcarBuscaParceiro(texto)) return false;
  const t = normalizar(texto);
  const termos = [
    "clima","tempo","previsao","previsão","vento","mar","marea","maré","ondas","onda","temperatura",
    "graus","calor","frio","chovendo","chuva","sol","ensolarado","nublado"
  ];
  return termos.some((k) => t.includes(k));
}
function isRouteQuestion(texto) {
  const t = normalizar(texto);
  const termos = ["como chegar", "rota", "ir de", "saindo de", "qual caminho", "trajeto", "direcao", "direção"];
  return termos.some((k) => t.includes(k));
}
function detectTemporalWindow(texto) {
  const t = normalizar(texto);
  const sinaisFuturo = ["amanha","amanhã","semana que vem","proxima semana","próxima semana","sabado","sábado","domingo","proximos dias","próximos dias","daqui a"];
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
    { key: "iguaba", nome: "Iguaba Grande" },
    { key: "iguabinha", nome: "Iguaba Grande" },
  ];
  const hitApelido = apelidos.find((a) => t.includes(a.key));
  if (hitApelido) {
    const alvo = lista.find((c) => normalizar(c.nome) === normalizar(hitApelido.nome));
    if (alvo) return alvo;
  }
  for (const c of lista) {
    if (t.includes(normalizar(c.nome)) || t.includes(normalizar(c.slug))) return c;
  }
  return null;
}
function isRegionQuery(texto) {
  const t = normalizar(texto);
  const mencionaRegiao = t.includes("regiao") || t.includes("região") || t.includes("regiao dos lagos") || t.includes("região dos lagos");
  return mencionaRegiao;
}

// -------------------------- PROMPT MESTRE (regras novas) --------------------
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
- Ao listar, mostre nome, categoria e informações úteis (endereço, contato, faixa de preço, benefícios).
- Fale como **“indicações confiáveis”** (não mencione “parceria”).

# CLIMA, MARÉS, ÁGUA
- Use **exclusivamente** a tabela interna \`dados_climaticos\`.
- Se faltar o tipo pedido (ex.: previsão futura), diga honestamente que ainda não há dados consolidados.
- Contextualize com a hora local (São Paulo) para sugerir atividades adequadas (sem inventar).

# ROTAS HUMANAS (SEM MAPS)
- Quando pedirem “como chegar”, explique em **texto humano**, ponto-a-ponto, usando rodovias e referências locais (“saindo de Nova Iguaçu para Cabo Frio, vá pela Dutra, entre na Linha Vermelha...”), sem fornecer links.

# ESTILO
- Respostas curtas (1–2 parágrafos) + bullets quando útil.
- Seja amigável e direto. Não inicie com saudação se não for o primeiro turno.
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
    "restaurante","restaurantes","almoço","almoco","jantar","comer","comida",
    "picanha","piconha","carne","churrasco","pizza","pizzaria","peixe","frutos do mar",
    "moqueca","rodizio","rodízio","lanchonete","burger","hamburguer","hambúrguer","bistrô","bistro"
  ],
  hospedagem: ["pousada","pousadas","hotel","hotéis","hospedagem","hostel","airbnb"],
  bebidas: ["bar","bares","chopp","chope","drinks","pub","boteco"],
  passeios: [
    "passeio","passeios","barco","lancha","escuna","trilha","trilhas","tour","buggy",
    "quadriciclo","city tour","catamarã","catamara","mergulho","snorkel","gruta","ilha"
  ],
  praias: ["praia","praias","faixa de areia","bandeira azul","mar calmo","mar forte"],
  transporte: [
    "transfer","transporte","alugar carro","aluguel de carro","uber","taxi","ônibus","onibus",
    "rodoviária","rodoviaria"
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

  let city = null;
  if (tNorm.includes("cabo frio")) city = "Cabo Frio";
  else if (tNorm.includes("buzios") || tNorm.includes("búzios")) city = "Armação dos Búzios";
  else if (tNorm.includes("arraial")) city = "Arraial do Cabo";
  else if (tNorm.includes("sao pedro") || tNorm.includes("são pedro")) city = "São Pedro da Aldeia";
  else if (tNorm.includes("iguaba")) city = "Iguaba Grande";

  const DIC_TERMS = [
    "picanha","piconha","carne","churrasco","rodizio","rodízio","fraldinha","costela","barato","barata",
    "familia","família","romantico","romântico","vista","vista para o mar","pizza","peixe","frutos do mar",
    "moqueca","hamburguer","hambúrguer","sushi","japonesa","bistrô","bistro"
  ];
  const terms = [];
  for (const w of DIC_TERMS) if (tNorm.includes(normalizarTexto(w))) terms.push(w);

  let category = null;
  if (
    ["restaurante","comer","comida","picanha","piconha","carne","churrasco","rodizio","rodízio","pizza","pizzaria","peixe","frutos do mar","hamburguer","hambúrguer","bistrô","bistro","sushi","japonesa"].some((k) => tNorm.includes(k))
  ) {
    category = "comida";
  } else if (
    ["pousada","hotel","hostel","hospedagem","airbnb","apart","flat","resort"].some((k) => tNorm.includes(k))
  ) {
    category = "hospedagem";
  } else if (["bar","bares","chopp","chope","drinks","pub","boteco"].some((k) => tNorm.includes(k))) {
    category = "bebidas";
  } else if (
    ["passeio","barco","lancha","escuna","trilha","buggy","quadriciclo","mergulho","snorkel","tour"].some((k) => tNorm.includes(k))
  ) {
    category = "passeios";
  } else if (["praia","praias","bandeira azul","orla"].some((k) => tNorm.includes(k))) {
    category = "praias";
  } else if (
    ["transfer","transporte","aluguel de carro","locadora","uber","taxi","ônibus","onibus"].some((k) => tNorm.includes(k))
  ) {
    category = "transporte";
  }

  return { category, city, terms };
}

// ============================== RAG: BUSCA PARCEIROS =========================
async function searchPartnersRAG({ textoDoUsuario, cidadesAtivas, limit = 5 }) {
  const entidades = await extrairEntidadesDaBusca(textoDoUsuario || "");
  const categoria = entidades?.category || null;
  const cidadeNome = entidades?.city || null;

  let cidade_id = null;
  if (cidadeNome && Array.isArray(cidadesAtivas)) {
    const alvo = cidadesAtivas.find(
      (c) =>
        normalizarTexto(c.nome) === normalizarTexto(cidadeNome) ||
        normalizarTexto(c.slug) === normalizarTexto(cidadeNome)
    );
    cidade_id = alvo?.id || null;
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
    try {
      let query = supabase
        .from("parceiros")
        .select("id, tipo, nome, categoria, descricao, endereco, contato, beneficio_bepit, faixa_preco, fotos_parceiros, cidade_id")
        .eq("ativo", true);
      if (cidade_id) query = query.eq("cidade_id", cidade_id);
      if (categoria) query = query.ilike("categoria", `%${categoria}%`);
      if (textoDoUsuario) query = query.or(`nome.ilike.%${textoDoUsuario}%,descricao.ilike.%${textoDoUsuario}%`);
      const { data: fb } = await query.limit(limit || 5);
      results = Array.isArray(fb) ? fb : [];
    } catch {}
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

  return { parceiros, entidades };
}

// ============================== FERRAMENTA PARCEIROS =========================
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
  const sinaisCarne = ["picanha", "piconha", "carne", "churrasco", "rodizio", "rodízio"].some((s) => textoN.includes(s));
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

  let cidadeUUID = null;
  if (cidadeSlug) {
    const alvo = (cidadesAtivas || []).find((c) => {
      const slugOk = c.slug && cidadeSlug && c.slug.toLowerCase() === cidadeSlug.toLowerCase();
      const nomeOk = c.nome && cidadeSlug && c.nome.toLowerCase() === cidadeSlug.toLowerCase();
      return slugOk || nomeOk;
    });
    cidadeUUID = alvo ? alvo.id : null;
  }

  const MAPA_CESTA_PARA_CATEGORIAS_DB = {
    comida: ["churrascaria","restaurante","pizzaria","lanchonete","frutos do mar","sushi","padaria","cafeteria","bistrô","bistro","hamburgueria","pizza"],
    bebidas: ["bar","pub","cervejaria","wine bar","balada","boteco"],
    passeios: ["passeio","barco","lancha","escuna","trilha","buggy","quadriciclo","city tour","catamarã","catamara","mergulho","snorkel","gruta","ilha","tour"],
    praias: ["praia","praias","bandeira azul","orla"],
    hospedagem: ["pousada","hotel","hostel","apart","flat","resort","hospedagem"],
    transporte: ["transfer","transporte","aluguel de carro","locadora","taxi","ônibus","onibus","rodoviária","rodoviaria"],
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

  if (categoriasAProcurar.length === 0 && categoriaProcurada && MAPA_CESTA_PARA_CATEGORIAS_DB[categoriaProcurada]) {
    categoriasAProcurar = MAPA_CESTA_PARA_CATEGORIAS_DB[categoriaProcurada].map(normalizarTexto);
  }

  let termoDeBusca = null;
  if (sinaisCarne) termoDeBusca = "picanha";
  else if (sinaisVista) termoDeBusca = "vista";
  else {
    const termosConhecidos = ["pizza","peixe","rodizio","frutos do mar","moqueca","hamburguer","sushi","bistrô","bistro","barato","família","romântico","vista"];
    const achou = termosConhecidos.find((k) => textoN.includes(normalizarTexto(k)));
    if (achou) termoDeBusca = achou;
  }
  if (!termoDeBusca && categoriasAProcurar.length > 0) termoDeBusca = categoriasAProcurar[0];

  const agregados = [];
  const vistos = new Set();
  const alvoInicialFix = 3;
  const alvoRefinoFix = 5;

  function buildQueryForCategory(cat, termo) {
    if (termo && termo.trim()) return termo.trim();
    const map = {
      restaurante: "restaurante comida",
      pizzaria: "pizza pizzaria",
      churrascaria: "churrasco picanha",
      lanchonete: "lanche sanduíche",
      "frutos do mar": "frutos do mar peixe",
      sushi: "sushi japonesa",
      padaria: "padaria café",
      cafeteria: "cafeteria café",
      bistrô: "bistrô",
      bistro: "bistrô",
      hamburgueria: "hambúrguer burger",
      bar: "bar pub drinks",
      pub: "pub bar",
      cervejaria: "cervejaria chopp",
      "wine bar": "vinho wine bar",
      balada: "balada noite",
      boteco: "boteco",
      passeio: "passeio",
      barco: "passeio de barco escuna lancha",
      lancha: "lancha passeio",
      escuna: "escuna passeio",
      trilha: "trilha",
      buggy: "buggy",
      quadriciclo: "quadriciclo",
      "city tour": "city tour",
      catamarã: "catamarã",
      catamara: "catamarã",
      mergulho: "mergulho snorkel",
      snorkel: "snorkel",
      gruta: "gruta",
      ilha: "ilha",
      tour: "tour",
      praia: "praia",
      praias: "praia",
      pousada: "pousada hospedagem",
      hotel: "hotel hospedagem",
      hostel: "hostel hospedagem",
      resort: "resort hospedagem",
      transfer: "transfer transporte",
      transporte: "transporte",
      "aluguel de carro": "aluguel de carro locadora",
      locadora: "locadora de veículos",
      taxi: "táxi taxi",
      ônibus: "ônibus onibus",
      onibus: "ônibus",
      rodoviária: "rodoviária",
      rodoviaria: "rodoviária",
    };
    const chave = cat && typeof cat.toLowerCase === "function" ? cat.toLowerCase() : cat;
    return map[chave] || cat || "parceiro";
  }

  for (const cat of categoriasAProcurar) {
    const q = buildQueryForCategory(cat, termoDeBusca);

    let items = [];
    try {
      const ragItems = await hybridSearch({
        q,
        cidade_id: cidadeUUID,
        categoria: cat,
        limit: isInitialSearch ? 3 : 5,
        debug: false,
      });
      items = Array.isArray(ragItems) ? ragItems : [];
    } catch {
      items = [];
    }

    for (const it of items) {
      if (it && it.id && !vistos.has(it.id) && !excludeIds.includes(it.id)) {
        vistos.add(it.id);
        agregados.push({
          id: it.id,
          tipo: it.tipo || null,
          nome: it.nome,
          categoria: it.categoria || null,
          descricao: it.descricao || "",
          endereco: it.endereco || null,
          contato: it.contato || null,
          beneficio_bepit: it.beneficio_bepit || null,
          faixa_preco: it.faixa_preco || null,
          fotos_parceiros: Array.isArray(it.fotos_parceiros) ? it.fotos_parceiros : [],
          cidade_id: it.cidade_id || null,
        });
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
  } catch {}

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

// ============================= FORMATADORES & IA =============================
function finalizeAssistantResponse({ modelResponseText, foundPartnersList = [], mode = "general" }) {
  const txt = String(modelResponseText || "").trim();
  if (mode === "partners") {
    return txt || "Aqui estão algumas **indicações confiáveis**.";
  }
  return txt || "Posso te ajudar com informações e indicações na Região dos Lagos.";
}

// Resposta humana para lista de parceiros (corrige ReferenceError)
async function gerarRespostaDeListaParceiros(userText, historico, parceiros) {
  if (!Array.isArray(parceiros) || parceiros.length === 0) {
    return "Não encontrei parceiros adequados para o que você pediu. Quer tentar com outra categoria, cidade ou faixa de preço?";
  }
  const linhas = parceiros.slice(0, 8).map((p) => {
    const desc = p.descricao ? ` · ${p.descricao}` : "";
    const end = p.endereco ? ` • Endereço: ${p.endereco}` : "";
    const contato = p.contato ? ` • Contato: ${p.contato}` : "";
    const preco = p.faixa_preco ? ` • Faixa de preço: ${p.faixa_preco}` : "";
    return `• **${p.nome}** · ${p.categoria || "parceiro"}${desc}${end}${contato}${preco}`;
  });
  return [
    "Aqui vão algumas **indicações confiáveis**:",
    ...linhas,
    "",
    "Se quiser, eu refino conforme seu estilo (família, casal, vista para o mar, orçamento, etc.). Pode me dizer o **número** ou o **nome** para ver mais detalhes.",
  ].join("\n");
}

// Geração de rotas em texto humano (sem links)
function gerarRotasHumanas(pergunta) {
  // Heurística simples: detectar origem e destino por padrões comuns do usuário
  // Exemplos: "saindo de nova iguaçu para cabo frio", "como chegar em búzios de rio de janeiro"
  const t = normalizarTexto(pergunta);
  let origem = null;
  let destino = null;

  // Padrões "saindo de X para Y"
  const m1 = t.match(/saindo de ([^,]+?) para ([^,\.!?\n]+)/i);
  if (m1) {
    origem = m1[1]?.trim();
    destino = m1[2]?.trim();
  }

  // Padrões "de X para Y"
  if (!origem || !destino) {
    const m2 = t.match(/de ([^,]+?) para ([^,\.!?\n]+)/i);
    if (m2) {
      origem = origem || m2[1]?.trim();
      destino = destino || m2[2]?.trim();
    }
  }

  // Padrão "como chegar em Y"
  if (!destino) {
    const m3 = t.match(/como chegar (em|para|até) ([^,\.!?\n]+)/i);
    if (m3) destino = m3[2]?.trim();
  }

  // Defaults regionais amigáveis se nada claro
  if (!origem) origem = "Rio de Janeiro";
  if (!destino) destino = "Cabo Frio";

  // Traçados comuns de referência (heurística, sem mapas)
  const rotasConhecidas = [
    {
      alvo: "cabo frio",
      texto: `Saindo de ${origem} para Cabo Frio: pegue a Via Dutra (BR-116) sentido Rio, entre na Linha Vermelha e siga para a Av. Brasil. Acesse a Ponte Rio–Niterói e, após cruzá-la, continue pela BR-101 até o acesso à Via Lagos (RJ-124). Siga a RJ-124 até a RJ-106/RJ-140 e entre rumo a Cabo Frio. Ao chegar, use a Av. América Central como referência para os principais bairros e praias.`,
    },
    {
      alvo: "arraial do cabo",
      texto: `Saindo de ${origem} para Arraial do Cabo: utilize o mesmo eixo Dutra → Linha Vermelha → Av. Brasil → Ponte Rio–Niterói. Continue pela BR-101 e entre na Via Lagos (RJ-124). Siga até a RJ-140, passando por São Pedro da Aldeia, e depois pegue o acesso para Arraial do Cabo. Ao entrar na cidade, a Av. Gov. Leonel de Moura Brizola te leva ao Centro e às praias principais (Praia dos Anjos, Pontal do Atalaia).`,
    },
    {
      alvo: "armação dos búzios",
      texto: `Saindo de ${origem} para Búzios: siga Dutra → Linha Vermelha → Av. Brasil → Ponte Rio–Niterói → BR-101. Acesse a Via Lagos (RJ-124) e prossiga até a RJ-106 (Amaral Peixoto) sentido Cabo Frio/Búzios. Entre na RJ-102 rumo a Búzios. Ao chegar, use a Av. José Bento Ribeiro Dantas como referência para circular entre os bairros e as praias.`,
    },
    {
      alvo: "são pedro da aldeia",
      texto: `Saindo de ${origem} para São Pedro da Aldeia: faça Dutra → Linha Vermelha → Av. Brasil → Ponte Rio–Niterói → BR-101. Acesse a Via Lagos (RJ-124) e siga até a RJ-140, entrando em São Pedro da Aldeia. A RJ-106 (Amaral Peixoto) cruza a cidade e conecta com Cabo Frio e Iguaba.`,
    },
    {
      alvo: "iguaba grande",
      texto: `Saindo de ${origem} para Iguaba Grande: utilize Dutra → Linha Vermelha → Av. Brasil → Ponte Rio–Niterói. Siga pela BR-101 e entre na Via Lagos (RJ-124) até a RJ-106 (Amaral Peixoto). Siga sentido Macaé e entre em Iguaba Grande. A Av. Paulino Pinto Pinheiro e a RJ-106 servem de eixos principais.`,
    },
  ];

  const match = rotasConhecidas.find((r) => destino && normalizarTexto(destino).includes(r.alvo));
  return match ? match.texto : `Rota sugerida saindo de ${origem} para ${destino}: use Dutra/BR-116 até o Rio, acesse Linha Vermelha → Av. Brasil → Ponte Rio–Niterói. Siga BR-101 e, conforme o destino na Região dos Lagos, pegue a Via Lagos (RJ-124) e depois as conexões RJ-106/RJ-140 ou RJ-102. Ao entrar na cidade, use as avenidas principais (como América Central em Cabo Frio ou José Bento Ribeiro Dantas em Búzios) para se orientar.`;
}

// Resposta geral neutra, humana, sem forçar clima (corrige ReferenceError)
async function gerarRespostaGeralPrompteada({
  pergunta,
  historicoContents,
  regiaoNome,
  dadosClimaOuMaresJSON = "{}",
  horaLocalSP,
}) {
  const deveExplicarRotas = isRouteQuestion(pergunta);
  if (deveExplicarRotas) {
    // Retorna rotas humanizadas direto (sem IA), garantindo zero alucinação
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

Responda de forma direta, com 1–2 parágrafos no máximo. Se não houver dados internos suficientes, seja honesto. Quando mencionar serviços públicos externos, deixe claro que é "consulta pública". Não forneça links de mapas, explique o caminho em texto humano apenas quando for pedido.
`.trim();

  try {
    return await geminiTry(promptNeutro);
  } catch {
    // fallback sem IA
    return "Entendido. Posso te indicar opções e explicar como chegar em texto simples. Diga a cidade/bairro e o tipo de lugar que você procura.";
  }
}

// ============================================================================
// >>> ROTA DO CHAT - ORQUESTRADOR v6.2.1 (partners-first, rotas humanas) <<<<<
// ============================================================================
app.post("/api/chat/:slugDaRegiao", async (req, res) => {
  const runId = randomUUID();
  try {
    console.log(`[RUN ${runId}] [PONTO 1] /chat iniciado.`);

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

    const { conversationId, isFirstTurn } = await ensureConversation(req);

    // Recupera histórico curto do cache (se houver)
    let sessionData = { history: [], entities: {} };
    try {
      if (hasUpstash() && !isFirstTurn) {
        const cachedSession = await upstash.get(conversationId, { timeoutMs: 400 });
        if (cachedSession) sessionData = JSON.parse(cachedSession);
      }
    } catch (e) {
      console.error(`[RUN ${runId}] [CACHE] Falha ao LER sessão:`, e?.message || e);
      sessionData = { history: [], entities: {} };
    }

    const historico = sessionData.history || [];

    // Saudações
    if (isSaudacao(userText)) {
      const resposta = isFirstTurn
        ? `Olá! Seja bem-vindo(a) à ${regiao.nome}! Eu sou o BEPIT, seu concierge de confiança. Como posso te ajudar a ter uma experiência incrível hoje?`
        : "Claro, como posso te ajudar agora?";
      return await updateSessionAndRespond({
        res, runId, conversationId, userText, aiResponseText: resposta, sessionData, regiaoId: regiao.id,
      });
    }

    // 1) PARCEIROS PRIMEIRO (evita clima engolir intenção)
    if (forcarBuscaParceiro(userText)) {
      console.log(`[RUN ${runId}] [RAG] Intent parceiros detectada — chamando hybridSearch...`);

      const { parceiros, entidades } = await searchPartnersRAG({
        textoDoUsuario: userText,
        cidadesAtivas,
        limit: 5,
      });

      if (parceiros.length > 0) {
        const respostaModelo = await gerarRespostaDeListaParceiros(userText, historico, parceiros);
        const respostaFinal = finalizeAssistantResponse({
          modelResponseText: respostaModelo,
          foundPartnersList: parceiros,
          mode: "partners",
        });

        try {
          await supabase
            .from("conversas")
            .update({
              parceiros_sugeridos: parceiros,
              parceiro_em_foco: null,
              topico_atual: entidades?.category || null,
            })
            .eq("id", conversationId);
        } catch {}

        return await updateSessionAndRespond({
          res,
          runId,
          conversationId,
          userText,
          aiResponseText: respostaFinal,
          sessionData,
          regiaoId: regiao.id,
          partners: parceiros,
        });
      }
      // Se não achou parceiros, segue fluxo para os demais módulos
    }

    // 2) CLIMA (só se NÃO for intenção de parceiros)
    if (!forcarBuscaParceiro(userText) && isWeatherQuestion(userText)) {
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

        const promptFinal = `
${PROMPT_MESTRE_V14}

# CONTEXTO CLIMA/MAR
Hora local: ${horaLocal}
Região: ${regiao.nome}
DADOS (tabela interna dados_climaticos):
${JSON.stringify(payload)}

[Histórico]:
${historicoParaTextoSimplesWrapper(historico)}

[Pergunta]:
"${userText}"
`.trim();

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
          "Ainda não tenho os dados consolidados para esta previsão. Meu robô interno atualiza a base com frequência — tente novamente mais tarde.";
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

    // 3) ROTAS HUMANAS (quando pedido explicitamente)
    if (isRouteQuestion(userText)) {
      const respostaRotas = gerarRotasHumanas(userText);
      return await updateSessionAndRespond({
        res,
        runId,
        conversationId,
        userText,
        aiResponseText: respostaRotas,
        sessionData,
        regiaoId: regiao.id,
      });
    }

    // 4) FALLBACK GERAL (neutro, humano, com prompt mestre)
    const horaLocalSP = getHoraLocalSP();
    const promptGeral = `
${PROMPT_MESTRE_V14}

Hora local: ${horaLocalSP}
Região: ${regiao.nome}
Dados internos: {}

[Histórico]:
${historicoParaTextoSimplesWrapper(historico)}

[Pergunta]:
"${userText}"
`.trim();

    const respostaGeral = await geminiTry(promptGeral);

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
      reply: "Ops, encontrei um problema temporário. Por favor, tente sua pergunta novamente em um instante.",
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
  { q: "Quero bar para ver o jogo", a: "Posso indicar bares parceiros com TVs, sem citar futebol em detalhes. (Listar parceiros)."},
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
  { q: "Qual praia está mais protegida do vento hoje?", a: "Com dados internos de vento/ondas, indico praias mais abrigadas. Se o vento estiver alto, sugiro atividades em terra." },
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
