// ============================================================================
// BEPIT Nexus - Servidor (Express) — Orquestrador Lógico v3.3 (com REST v1 Gemini)
// - Stack: ESM, Express, Supabase, Gemini (REST v1 ou SDK v1)
// - Rotas: health, diag, chat, feedback, auth, admin (parceiros/regiões/cidades/metrics/logs)
// - Observações:
//   * Para evitar 404 nos modelos Gemini, ative o modo REST v1: USE_GEMINI_REST=1
//   * O SDK também funciona (>= 0.24.0). Fixe @google/generative-ai em 0.27.0.
//   * CORS liberado para Netlify e localhost.
// ============================================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai"; // usado quando USE_GEMINI_REST != 1
import { supabase } from "../lib/supabaseClient.js";

// ============================== CONFIGURAÇÃO BÁSICA =========================
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "2mb" }));

// --------------------------------- CORS -------------------------------------
function isOriginAllowed(origin) {
  if (!origin) return true; // curl/Postman/health
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost") return true;
    if (url.host === "bepitnexus.netlify.app") return true;
    if (url.host === "bepit-nexus.netlify.app") return true;
    if (url.host.endsWith(".netlify.app")) return true;
    return false;
  } catch {
    return false;
  }
}

app.use(
  cors({
    origin: (origin, callback) =>
      isOriginAllowed(origin) ? callback(null, true) : callback(new Error("CORS: origem não permitida.")),
    credentials: true,
    allowedHeaders: ["Content-Type", "x-admin-key", "authorization"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  })
);
app.options("*", cors());

// ================================ GEMINI ====================================
//
// Dois modos de uso:
// - REST v1 nativo (recomendado): defina USE_GEMINI_REST=1. Ignora SDK.
// - SDK oficial (@google/generative-ai >= 0.24.0): deixe USE_GEMINI_REST vazio/0.
//
// Variáveis:
//   GEMINI_API_KEY (obrigatória)
//   GEMINI_MODEL   (opcional; ex: gemini-1.5-pro-002)
//   USE_GEMINI_REST=1 para REST v1
//
const USE_GEMINI_REST = String(process.env.USE_GEMINI_REST || "0") === "1";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL_PREF = (process.env.GEMINI_MODEL || "").trim();

const CANDIDATOS_V1 = [
  GEMINI_MODEL_PREF || null,
  "gemini-1.5-pro-002",
  "gemini-1.5-pro",
  "gemini-1.5-flash-002",
  "gemini-1.5-flash"
].filter(Boolean);

// ---------- REST v1 helpers ----------
async function geminiListModelsV1(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`[GEMINI REST] listModels falhou: ${r.status} ${r.statusText} ${t}`);
  }
  const json = await r.json();
  const models = Array.isArray(json.models) ? json.models : [];
  return models.map(m => m.name).filter(Boolean);
}

async function geminiGenerateContentV1(apiKey, modelName, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }]}]
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`[GEMINI REST] generateContent falhou: ${r.status} ${r.statusText} ${t}`);
  }
  const json = await r.json();
  const texto =
    json?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("")?.trim() || "";
  return texto;
}

let GEMINI_MODEL_SELECTED_REST = null;

async function geminiPickModelREST() {
  if (!GEMINI_API_KEY) throw new Error("[GEMINI REST] GEMINI_API_KEY ausente.");
  if (GEMINI_MODEL_SELECTED_REST) return GEMINI_MODEL_SELECTED_REST;

  let available = [];
  try {
    available = await geminiListModelsV1(GEMINI_API_KEY);
  } catch (e) {
    console.warn(String(e));
  }

  const candidates = CANDIDATOS_V1.length ? CANDIDATOS_V1 : ["gemini-1.5-pro-002", "gemini-1.5-flash-002"];
  for (const name of candidates) {
    try {
      if (available.length && !available.includes(name)) continue;
      await geminiGenerateContentV1(GEMINI_API_KEY, name, "ok");
      GEMINI_MODEL_SELECTED_REST = name;
      console.log(`[GEMINI REST] Modelo selecionado: ${name}`);
      return name;
    } catch (e) {
      console.warn(`[GEMINI REST] Falha no modelo ${name}: ${e?.message || e}`);
    }
  }
  throw new Error("[GEMINI REST] Não foi possível selecionar um modelo v1.");
}

async function geminiGenerateText(prompt) {
  if (!GEMINI_API_KEY) throw new Error("[GEMINI] GEMINI_API_KEY ausente no ambiente.");

  if (USE_GEMINI_REST) {
    const model = await geminiPickModelREST();
    return await geminiGenerateContentV1(GEMINI_API_KEY, model, prompt);
  }

  // SDK oficial (>= 0.24.0)
  const client = new GoogleGenerativeAI(GEMINI_API_KEY);
  let lastErr = null;
  for (const name of CANDIDATOS_V1) {
    try {
      const model = client.getGenerativeModel({ model: name });
      const ping = await model.generateContent({ contents: [{ role: "user", parts: [{ text: "ok" }]}] });
      console.log(`[GEMINI SDK] Modelo selecionado: ${name} · ping: ${(ping?.response?.text() || "").trim()}`);
      const resp = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }]}] });
      return (resp?.response?.text() || "").trim();
    } catch (e) {
      lastErr = e;
      console.warn(`[GEMINI SDK] Falha no modelo ${name}: ${e?.message || e}`);
    }
  }
  throw lastErr || new Error("[GEMINI SDK] Nenhum modelo disponível.");
}

// ============================ FUNÇÕES AUXILIARES ============================

function normalizarTexto(txt) {
  return String(txt || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function degToRad(deg) { return (deg * Math.PI) / 180; }

function haversineKm(a, b) {
  const R = 6371;
  const dLat = degToRad(b.lat - a.lat);
  const dLng = degToRad(b.lng - a.lng);
  const lat1 = degToRad(a.lat);
  const lat2 = degToRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const coordenadasFallback = {
  "cabo frio": { lat: -22.8894, lng: -42.0286 },
  "arraial do cabo": { lat: -22.9661, lng: -42.0271 },
  "buzios": { lat: -22.7469, lng: -41.8817 },
  "búzios": { lat: -22.7469, lng: -41.8817 },
  "sao pedro da aldeia": { lat: -22.8427, lng: -42.1026 },
  "são pedro da aldeia": { lat: -22.8427, lng: -42.1026 }
};

function obterCoordsPorTexto(txt, cidades) {
  const key = normalizarTexto(txt);
  const hit = (cidades || []).find(
    c => normalizarTexto(c.nome) === key || normalizarTexto(c.slug) === key
  );
  if (hit && typeof hit.lat === "number" && typeof hit.lng === "number") {
    return { lat: hit.lat, lng: hit.lng, fonte: "db" };
  }
  if (coordenadasFallback[key]) return { ...coordenadasFallback[key], fonte: "fallback" };
  return null;
}

async function historicoGemini(conversationId, limit = 12) {
  try {
    const { data, error } = await supabase
      .from("interacoes")
      .select("pergunta_usuario, resposta_ia")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    const all = data || [];
    const last = all.slice(-limit);

    const contents = [];
    for (const it of last) {
      if (it.pergunta_usuario) contents.push({ role: "user", parts: [{ text: it.pergunta_usuario }] });
      if (it.resposta_ia) contents.push({ role: "model", parts: [{ text: it.resposta_ia }] });
    }
    return contents;
  } catch (e) {
    console.warn("[HISTORICO] Falha ao carregar:", e?.message || e);
    return [];
  }
}

function historicoComoTexto(contents) {
  try {
    return (contents || [])
      .map(b => {
        const role = b?.role || "user";
        const text = (b?.parts?.[0]?.text || "").replace(/\s+/g, " ").trim();
        return `- ${role}: ${text}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

// ============================ FERRAMENTAS RAG (BASE) ========================

async function buscarParceirosOuDicas({ cidadesAtivas, argumentos }) {
  const categoria = (argumentos?.category || "").trim();
  const cidade = (argumentos?.city || "").trim();
  const termos = Array.isArray(argumentos?.terms) ? argumentos.terms : [];

  const cidadesValidas = (cidadesAtivas || []);
  let idsCidades = cidadesValidas.map(c => c.id);
  if (cidade) {
    const alvo = cidadesValidas.find(
      c => normalizarTexto(c.nome) === normalizarTexto(cidade) || normalizarTexto(c.slug) === normalizarTexto(cidade)
    );
    if (alvo) idsCidades = [alvo.id];
  }

  let q = supabase
    .from("parceiros")
    .select("id, tipo, nome, categoria, descricao, endereco, contato, beneficio_bepit, faixa_preco, fotos_parceiros, cidade_id, tags, ativo")
    .eq("ativo", true)
    .in("cidade_id", idsCidades);

  if (categoria) q = q.ilike("categoria", `%${categoria}%`);

  const { data, error } = await q;
  if (error) throw error;

  let items = Array.isArray(data) ? data : [];

  if (termos.length > 0) {
    const tn = termos.map(t => normalizarTexto(t));
    items = items.filter(p => {
      const nn = normalizarTexto(p.nome);
      const cn = normalizarTexto(p.categoria || "");
      const tags = Array.isArray(p.tags) ? p.tags.map(x => normalizarTexto(String(x))) : [];
      return tn.some(t => nn.includes(t) || cn.includes(t) || tags.includes(t));
    });
  }

  items.sort((a, b) => (a.tipo === "DICA" ? 1 : 0) - (b.tipo === "DICA" ? 1 : 0));
  const lim = items.slice(0, 8);

  return {
    ok: true,
    count: lim.length,
    items: lim.map(p => ({
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
      cidade_id: p.cidade_id
    }))
  };
}

async function definirPreferenciaDeIndicacao({ conversationId, argumentos }) {
  const pref = String(argumentos?.preference || "").toLowerCase();
  const topic = argumentos?.topic || null;
  if (!["locais", "generico"].includes(pref)) {
    return { ok: false, error: "preference deve ser 'locais' ou 'generico'." };
  }
  try {
    const { error } = await supabase
      .from("conversas")
      .update({ preferencia_indicacao: pref, topico_atual: topic || null })
      .eq("id", conversationId);
    if (error) throw error;
    return { ok: true, saved: { preference: pref, topic: topic || null } };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// =============================== HEALTHCHECKS ===============================

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, message: "Servidor BEPIT Nexus online", port: String(PORT) });
});

app.get("/api/health", (_req, res) => {
  res.status(200).json({ ok: true, scope: "api", message: "BEPIT Nexus API ok", port: String(PORT) });
});

app.get("/api/health/db", async (_req, res) => {
  try {
    const { data, error } = await supabase.from("regioes").select("id").limit(1);
    if (error) throw error;
    return res.json({
      ok: true,
      sample: data && data.length ? data : []
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "db_error", details: e?.message || String(e) });
  }
});

// ============================== DIAGNÓSTICOS ================================

app.get("/api/diag/gemini", async (_req, res) => {
  try {
    const modo = USE_GEMINI_REST ? "REST" : "SDK";
    let info = { modo };

    if (!GEMINI_API_KEY) {
      return res.status(400).json({ ok: false, error: "gemini_api_key_missing", info });
    }

    if (USE_GEMINI_REST) {
      let modelos = [];
      try {
        modelos = await geminiListModelsV1(GEMINI_API_KEY);
      } catch (e) {
        info.list_models_error = String(e?.message || e);
      }
      let escolhido = null;
      try {
        escolhido = await geminiPickModelREST();
      } catch (e) {
        info.pick_model_error = String(e?.message || e);
      }
      let ping = null;
      if (escolhido) {
        try {
          ping = await geminiGenerateContentV1(GEMINI_API_KEY, escolhido, "ok");
        } catch (e) {
          info.generate_error = String(e?.message || e);
        }
      }
      return res.json({ ok: true, modo, modelos, escolhido, ping });
    } else {
      let ping = null;
      try {
        ping = await geminiGenerateText("ok");
      } catch (e) {
        info.generate_error = String(e?.message || e);
        return res.status(500).json({ ok: false, modo, info });
      }
      return res.json({ ok: true, modo, ping });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/diag/region/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const { data, error } = await supabase
      .from("regioes")
      .select("id, nome, slug, ativo")
      .eq("slug", slug)
      .single();
    if (error) throw error;
    return res.json({ ok: true, region: data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "supabase_error_region", internal: e });
  }
});

app.get("/api/diag/cidades/:regiaoSlug", async (req, res) => {
  try {
    const { regiaoSlug } = req.params;
    const { data: reg, error: eReg } = await supabase
      .from("regioes")
      .select("id")
      .eq("slug", regiaoSlug)
      .single();
    if (eReg) throw eReg;
    const { data, error } = await supabase
      .from("cidades")
      .select("id, nome, slug, ativo, lat, lng")
      .eq("regiao_id", reg.id);
    if (error) throw error;
    return res.json({ ok: true, cidades: data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "supabase_error_cidades", internal: e });
  }
});

app.get("/api/diag/columns", async (_req, res) => {
  async function probe(table, cols) {
    const p = {};
    for (const c of cols) {
      try {
        const { error } = await supabase.from(table).select(`${c}`).limit(1);
        p[c] = { ok: !error };
      } catch {
        p[c] = { ok: false };
      }
    }
    return { table, probe: p };
  }

  const checks = await Promise.all([
    probe("cidades", ["id", "nome", "slug", "regiao_id", "ativo", "lat", "lng"]),
    probe("regioes", ["id", "nome", "slug", "ativo"]),
    probe("parceiros", ["id", "tipo", "nome", "categoria", "descricao", "endereco", "contato", "beneficio_bepit", "faixa_preco", "fotos_parceiros", "cidade_id", "tags", "ativo"]),
    probe("conversas", ["id", "regiao_id", "parceiro_em_foco", "parceiros_sugeridos", "ultima_pergunta_usuario", "ultima_resposta_ia", "preferencia_indicacao", "topico_atual"]),
    probe("interacoes", ["id", "regiao_id", "conversation_id", "pergunta_usuario", "resposta_ia", "parceiros_sugeridos", "feedback_usuario", "created_at"])
  ]);

  return res.json({ ok: true, columns: checks });
});

// =============================== INTENÇÃO/LLM ===============================

async function classificarIntentUsuario(frase) {
  const prompt =
    `Sua única tarefa é analisar a frase do usuário e classificá-la em uma das seguintes categorias: ` +
    `'busca_parceiro', 'follow_up_parceiro', 'pergunta_geral', 'mudanca_contexto', 'small_talk'. ` +
    `Responda apenas com a string da categoria.\nFrase: "${frase}"`;
  const txt = await geminiGenerateText(prompt);
  const t = (txt || "").trim().toLowerCase();
  const classes = new Set(["busca_parceiro", "follow_up_parceiro", "pergunta_geral", "mudanca_contexto", "small_talk"]);
  return classes.has(t) ? t : "pergunta_geral";
}

async function extrairEntidadesDeBusca(frase) {
  const prompt =
    `Extraia entidades de busca para parceiros no formato JSON estrito (sem comentários).\n` +
    `Campos: {"category": string|null, "city": string|null, "terms": string[]}\n` +
    `- "category" deve ser algo como restaurante, passeio, hotel, bar, transfer, mergulho, pizzaria, etc.\n` +
    `- "city" se houver menção explícita.\n` +
    `- "terms" são adjetivos/necessidades: ["barato", "crianças", "vista para o mar", "pet friendly", etc]\n` +
    `Seja flexível com erros de digitação e abreviações.\n` +
    `Responda apenas com JSON.\nFrase: "${frase}"`;
  const raw = await geminiGenerateText(prompt);
  try {
    const parsed = JSON.parse(raw);
    const category = typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim() : null;
    const city = typeof parsed.city === "string" && parsed.city.trim() ? parsed.city.trim() : null;
    const terms = Array.isArray(parsed.terms) ? parsed.terms.filter(t => typeof t === "string" && t.trim()).map(t => t.trim()) : [];
    return { category, city, terms };
  } catch {
    return { category: null, city: null, terms: [] };
  }
}

async function gerarRespostaComParceiros(pergunta, historicoContents, parceiros, regiaoNome = "") {
  const histTxt = historicoComoTexto(historicoContents);
  const ctx = JSON.stringify(parceiros ?? [], null, 2);
  const prompt = [
    "Você é o BEPIT, um concierge especialista.",
    "Responda à pergunta do usuário de forma útil, baseando-se EXCLUSIVAMENTE nas informações dos parceiros fornecidas em [Contexto].",
    "Se a pergunta for ambígua, peça esclarecimentos.",
    "",
    `[Contexto de Parceiros]: ${ctx}`,
    `[Histórico da Conversa]:\n${histTxt}`,
    `[Região]: ${regiaoNome}`,
    `[Pergunta do Usuário]: "${pergunta}"`
  ].join("\n");
  return await geminiGenerateText(prompt);
}

async function gerarRespostaGeral(pergunta, historicoContents, regiao) {
  const histTxt = historicoComoTexto(historicoContents);
  const nomeRegiao = regiao?.nome || "Região dos Lagos";
  const prompt = [
    `Você é o BEPIT, um concierge amigável e conhecedor da região de ${nomeRegiao}.`,
    "Responda à pergunta do usuário de forma prestativa, usando seu conhecimento geral.",
    "Se a pergunta for ambígua, peça esclarecimentos.",
    "",
    `[Histórico da Conversa]:\n${histTxt}`,
    `[Pergunta do Usuário]: "${pergunta}"`
  ].join("\n");
  return await geminiGenerateText(prompt);
}

function encontrarParceiroNaLista(texto, lista) {
  try {
    const t = normalizarTexto(texto);
    if (!Array.isArray(lista) || lista.length === 0) return null;

    const m = t.match(/\b(\d{1,2})(?:º|o|a|\.|°)?\b/);
    if (m) {
      const idx = Number(m[1]);
      if (Number.isFinite(idx) && idx >= 1 && idx <= lista.length) {
        return lista[idx - 1];
      }
    }

    const ordinais = ["primeiro", "segundo", "terceiro", "quarto", "quinto", "sexto", "sétimo", "setimo", "oitavo"];
    for (let i = 0; i < ordinais.length; i++) {
      if (t.includes(ordinais[i])) {
        const pos = i + 1;
        if (pos >= 1 && pos <= lista.length) return lista[pos - 1];
      }
    }

    for (const p of lista) {
      const nome = normalizarTexto(p?.nome || "");
      if (nome && t.includes(nome)) return p;
      const tokens = nome.split(/\s+/).filter(Boolean);
      if (tokens.length > 0) {
        const acertos = tokens.filter(x => t.includes(x)).length;
        if (acertos >= Math.max(1, Math.ceil(tokens.length * 0.6))) return p;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ================================ CHAT ======================================

const RAW_MODE = process.env.RAW_MODE === "1";

app.post("/api/chat/:slugDaRegiao", async (req, res) => {
  try {
    const { slugDaRegiao } = req.params;
    let { message, conversationId } = req.body || {};

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "O campo 'message' é obrigatório e deve ser string não vazia." });
    }
    message = message.trim();

    // Região
    const { data: regiao, error: eReg } = await supabase
      .from("regioes")
      .select("id, nome, slug, ativo")
      .eq("slug", slugDaRegiao)
      .single();
    if (eReg || !regiao) return res.status(404).json({ error: "Região não encontrada." });
    if (regiao.ativo === false) return res.status(403).json({ error: "Região desativada." });

    // Cidades
    const { data: cidadesRaw, error: eCid } = await supabase
      .from("cidades")
      .select("id, nome, slug, lat, lng, ativo")
      .eq("regiao_id", regiao.id);
    if (eCid) return res.status(500).json({ error: "Erro ao carregar cidades.", internal: eCid });
    const cidadesAtivas = (cidadesRaw || []).filter(c => c.ativo !== false);

    // Conversation
    if (!conversationId || typeof conversationId !== "string" || !conversationId.trim()) {
      conversationId = randomUUID();
      try {
        const { error: insErr } = await supabase.from("conversas").insert({
          id: conversationId,
          regiao_id: regiao.id,
          parceiro_em_foco: null,
          parceiros_sugeridos: [],
          ultima_pergunta_usuario: null,
          ultima_resposta_ia: null,
          preferencia_indicacao: null,
          topico_atual: null
        });
        if (insErr) throw insErr;
      } catch (e) {
        return res.status(500).json({ error: "Erro ao criar conversa.", internal: e });
      }
    }

    // Estado da conversa
    let conversaAtual = null;
    try {
      const { data: conv } = await supabase
        .from("conversas")
        .select("id, parceiro_em_foco, preferencia_indicacao, topico_atual, parceiros_sugeridos")
        .eq("id", conversationId)
        .maybeSingle();
      conversaAtual = conv || null;
    } catch {
      // segue
    }

    if (RAW_MODE) {
      const hist = await historicoGemini(conversationId, 12);
      const reply = await geminiGenerateText(
        [
          "Modo bruto (RAW_MODE=1). Historico abaixo, em seguida a pergunta do usuário.",
          historicoComoTexto(hist),
          `Usuário: ${message}`
        ].join("\n\n")
      );

      let interactionId = null;
      try {
        const { data: novaInt } = await supabase
          .from("interacoes")
          .insert({
            regiao_id: regiao.id,
            conversation_id: conversationId,
            pergunta_usuario: message,
            resposta_ia: reply,
            parceiros_sugeridos: []
          })
          .select("id").single();
        interactionId = novaInt?.id || null;
      } catch { /* noop */ }

      return res.status(200).json({
        reply,
        interactionId,
        photoLinks: [],
        conversationId
      });
    }

    const hist = await historicoGemini(conversationId, 12);

    // Follow-up escolheu um dos parceiros sugeridos anteriormente?
    const candidatos = Array.isArray(conversaAtual?.parceiros_sugeridos) ? conversaAtual.parceiros_sugeridos : [];
    const escolhido = encontrarParceiroNaLista(message, candidatos);
    if (escolhido) {
      try {
        await supabase
          .from("conversas")
          .update({ parceiro_em_foco: escolhido, parceiros_sugeridos: candidatos })
          .eq("id", conversationId);
      } catch { /* noop */ }

      const respostaCurta = await gerarRespostaComParceiros(message, hist, [escolhido], regiao?.nome);
      let interactionId = null;
      try {
        const { data: novaInt } = await supabase
          .from("interacoes")
          .insert({
            regiao_id: regiao.id,
            conversation_id: conversationId,
            pergunta_usuario: message,
            resposta_ia: respostaCurta,
            parceiros_sugeridos: [escolhido]
          })
          .select("id").single();
        interactionId = novaInt?.id || null;
      } catch { /* noop */ }

      const photos = [escolhido].flatMap(p => p?.fotos_parceiros || []).filter(Boolean);
      return res.status(200).json({
        reply: respostaCurta,
        interactionId,
        photoLinks: photos,
        conversationId,
        intent: "follow_up_parceiro",
        partners: [escolhido]
      });
    }

    // Classificação e resposta
    const intent = await classificarIntentUsuario(message);
    let reply = "";
    let parceirosSugeridos = [];

    switch (intent) {
      case "busca_parceiro": {
        const entidades = await extrairEntidadesDeBusca(message);
        const resultado = await buscarParceirosOuDicas({
          cidadesAtivas,
          argumentos: entidades
        });
        if (resultado?.ok && (resultado?.count || 0) > 0) {
          parceirosSugeridos = resultado.items || [];
          reply = await gerarRespostaComParceiros(message, hist, parceirosSugeridos, regiao?.nome);
          try {
            await supabase
              .from("conversas")
              .update({
                parceiros_sugeridos: parceirosSugeridos,
                parceiro_em_foco: null,
                topico_atual: entidades?.category || null
              })
              .eq("id", conversationId);
          } catch { /* noop */ }
        } else {
          reply = await gerarRespostaGeral(message, hist, regiao);
        }
        break;
      }

      case "follow_up_parceiro": {
        const emFoco = conversaAtual?.parceiro_em_foco || null;
        if (emFoco) {
          reply = await gerarRespostaComParceiros(message, hist, [emFoco], regiao?.nome);
          parceirosSugeridos = [emFoco];
        } else {
          const entidades = await extrairEntidadesDeBusca(message);
          const resultado = await buscarParceirosOuDicas({
            cidadesAtivas,
            argumentos: entidades
          });
          if (resultado?.ok && (resultado?.count || 0) > 0) {
            parceirosSugeridos = resultado.items || [];
            reply = await gerarRespostaComParceiros(message, hist, parceirosSugeridos, regiao?.nome);
            try {
              await supabase
                .from("conversas")
                .update({
                  parceiros_sugeridos: parceirosSugeridos,
                  parceiro_em_foco: null,
                  topico_atual: entidades?.category || null
                })
                .eq("id", conversationId);
            } catch { /* noop */ }
          } else {
            reply = await gerarRespostaGeral(message, hist, regiao);
          }
        }
        break;
      }

      case "pergunta_geral":
      case "mudanca_contexto": {
        reply = await gerarRespostaGeral(message, hist, regiao);
        try {
          await supabase.from("conversas").update({ parceiro_em_foco: null }).eq("id", conversationId);
        } catch { /* noop */ }
        break;
      }

      case "small_talk": {
        reply = "Olá! Sou o BEPIT, seu concierge na Região dos Lagos. O que você gostaria de fazer hoje?";
        break;
      }

      default: {
        reply = "Não entendi muito bem. Você poderia reformular sua pergunta?";
        break;
      }
    }

    if (!reply) {
      reply = "Posso ajudar com roteiros, transporte, passeios, praias e onde comer. O que você gostaria de saber?";
    }

    let interactionId = null;
    try {
      const { data: novaInt } = await supabase
        .from("interacoes")
        .insert({
          regiao_id: regiao.id,
          conversation_id: conversationId,
          pergunta_usuario: message,
          resposta_ia: reply,
          parceiros_sugeridos: parceirosSugeridos
        })
        .select("id")
        .single();
      interactionId = novaInt?.id || null;
    } catch (e) {
      console.warn("[INTERACOES] Falha ao salvar:", e?.message || e);
    }

    const photos = (parceirosSugeridos || []).flatMap(p => p?.fotos_parceiros || []).filter(Boolean);

    return res.status(200).json({
      reply,
      interactionId,
      photoLinks: photos,
      conversationId,
      intent,
      partners: parceirosSugeridos
    });
  } catch (e) {
    console.error("[/api/chat/:slugDaRegiao] Erro:", e);
    return res.status(500).json({ error: "Erro interno no servidor do BEPIT.", internal: { message: e?.message || String(e) } });
  }
});

// ================================ FEEDBACK ==================================

app.post("/api/feedback", async (req, res) => {
  try {
    const { interactionId, feedback } = req.body || {};
    if (!interactionId || typeof interactionId !== "string") {
      return res.status(400).json({ error: "interactionId é obrigatório (uuid)." });
    }
    if (!feedback || typeof feedback !== "string" || !feedback.trim()) {
      return res.status(400).json({ error: "feedback é obrigatório (string não vazia)." });
    }
    const { error } = await supabase
      .from("interacoes")
      .update({ feedback_usuario: feedback })
      .eq("id", interactionId);
    if (error) return res.status(500).json({ error: "Erro ao registrar feedback." });

    try {
      await supabase.from("eventos_analytics").insert({
        tipo_evento: "feedback",
        payload: { interactionId, feedback }
      });
    } catch { /* noop */ }

    res.json({ success: true });
  } catch (e) {
    console.error("[/api/feedback] Erro:", e);
    res.status(500).json({ error: "Erro interno." });
  }
});

// ================================= AUTH ====================================

// Login simples por "key" (front usa essa rota)
app.post("/api/auth/login", async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key || typeof key !== "string") {
      return res.status(400).json({ error: "missing_key" });
    }
    const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";
    if (ADMIN_API_KEY && key === ADMIN_API_KEY) {
      return res.status(200).json({ ok: true });
    }
    return res.status(401).json({ error: "invalid_key" });
  } catch (e) {
    console.error("[/api/auth/login] Erro:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// ================================= ADMIN ===================================

app.post("/api/admin/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const okUser = username && username === process.env.ADMIN_USER;
    const okPass = password && password === process.env.ADMIN_PASS;
    if (!okUser || !okPass) return res.status(401).json({ error: "Credenciais inválidas." });
    return res.json({ ok: true, adminKey: process.env.ADMIN_API_KEY });
  } catch (e) {
    console.error("[/api/admin/login] Erro:", e);
    return res.status(500).json({ error: "Erro interno." });
  }
});

function exigirChaveAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== (process.env.ADMIN_API_KEY || "")) {
    return res.status(401).json({ error: "Chave administrativa inválida ou ausente." });
  }
  next();
}

// Criar parceiro/dica
app.post("/api/admin/parceiros", exigirChaveAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const { regiaoSlug, cidadeSlug, ...rest } = body;

    const { data: regiao, error: eReg } = await supabase
      .from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (eReg || !regiao) return res.status(400).json({ error: "regiaoSlug inválido." });

    const { data: cidade, error: eCid } = await supabase
      .from("cidades").select("id").eq("regiao_id", regiao.id).eq("slug", cidadeSlug).single();
    if (eCid || !cidade) return res.status(400).json({ error: "cidadeSlug inválido." });

    const novo = {
      cidade_id: cidade.id,
      tipo: rest.tipo || "PARCEIRO",
      nome: rest.nome,
      descricao: rest.descricao || null,
      categoria: rest.categoria || null,
      beneficio_bepit: rest.beneficio_bepit || null,
      endereco: rest.endereco || null,
      contato: rest.contato || null,
      tags: Array.isArray(rest.tags) ? rest.tags : null,
      horario_funcionamento: rest.horario_funcionamento || null,
      faixa_preco: rest.faixa_preco || null,
      fotos_parceiros: Array.isArray(rest.fotos_parceiros) ? rest.fotos_parceiros : (Array.isArray(rest.fotos) ? rest.fotos : null),
      ativo: rest.ativo !== false
    };

    const { data, error } = await supabase.from("parceiros").insert(novo).select("*").single();
    if (error) {
      console.error("[/api/admin/parceiros] Insert Erro:", error);
      return res.status(500).json({ error: "Erro ao criar parceiro/dica." });
    }

    return res.status(200).json({ ok: true, data });
  } catch (e) {
    console.error("[/api/admin/parceiros] Erro:", e);
    return res.status(500).json({ error: "Erro interno." });
  }
});

// PUT de parceiro por ID (atualização)
app.put("/api/admin/parceiros/:id", exigirChaveAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    const atualizacao = {
      nome: body.nome ?? null,
      categoria: body.categoria ?? null,
      descricao: body.descricao ?? null,
      beneficio_bepit: body.beneficio_bepit ?? null,
      endereco: body.endereco ?? null,
      contato: body.contato ?? null,
      tags: Array.isArray(body.tags) ? body.tags : null,
      horario_funcionamento: body.horario_funcionamento ?? null,
      faixa_preco: body.faixa_preco ?? null,
      fotos_parceiros: Array.isArray(body.fotos_parceiros)
        ? body.fotos_parceiros
        : (Array.isArray(body.fotos) ? body.fotos : null),
      ativo: body.ativo !== false
    };

    const { data, error } = await supabase
      .from("parceiros")
      .update(atualizacao)
      .eq("id", id)
      .select("*")
      .single();

    if (error) {
      console.error("[/api/admin/parceiros PUT] Erro:", error);
      return res.status(500).json({ error: "Erro ao atualizar parceiro/dica." });
    }

    return res.json({ ok: true, data });
  } catch (e) {
    console.error("[/api/admin/parceiros PUT] Erro:", e);
    return res.status(500).json({ error: "Erro interno." });
  }
});

// Listar parceiros por região e cidade
app.get("/api/admin/parceiros/:regiaoSlug/:cidadeSlug", exigirChaveAdmin, async (req, res) => {
  try {
    const { regiaoSlug, cidadeSlug } = req.params;

    const { data: regiao, error: eReg } = await supabase
      .from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (eReg || !regiao) return res.status(400).json({ error: "regiaoSlug inválido." });

    const { data: cidade, error: eCid } = await supabase
      .from("cidades").select("id").eq("regiao_id", regiao.id).eq("slug", cidadeSlug).single();
    if (eCid || !cidade) return res.status(400).json({ error: "cidadeSlug inválido." });

    const { data, error } = await supabase
      .from("parceiros")
      .select("*")
      .eq("cidade_id", cidade.id)
      .order("nome");
    if (error) {
      console.error("[/api/admin/parceiros list] Erro:", error);
      return res.status(500).json({ error: "Erro ao listar parceiros/dicas." });
    }

    return res.status(200).json({ data });
  } catch (e) {
    console.error("[/api/admin/parceiros list] Erro:", e);
    return res.status(500).json({ error: "Erro interno." });
  }
});

// Criar região
app.post("/api/admin/regioes", exigirChaveAdmin, async (req, res) => {
  try {
    const { nome, slug, ativo = true } = req.body || {};
    if (!nome || !slug) return res.status(400).json({ error: "Campos 'nome' e 'slug' são obrigatórios." });

    const { data, error } = await supabase
      .from("regioes")
      .insert({ nome, slug, ativo: Boolean(ativo) })
      .select("*")
      .single();
    if (error) {
      console.error("[/api/admin/regioes] Insert Erro:", error);
      return res.status(500).json({ error: "Erro ao criar região." });
    }

    res.json({ ok: true, data });
  } catch (e) {
    console.error("[/api/admin/regioes] Erro:", e);
    res.status(500).json({ error: "Erro interno." });
  }
});

// Criar cidade
app.post("/api/admin/cidades", exigirChaveAdmin, async (req, res) => {
  try {
    const { regiaoSlug, nome, slug, ativo = true, lat = null, lng = null } = req.body || {};
    if (!regiaoSlug || !nome || !slug) return res.status(400).json({ error: "Campos 'regiaoSlug', 'nome' e 'slug' são obrigatórios." });

    const { data: regiao, error: eReg } = await supabase
      .from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (eReg || !regiao) return res.status(400).json({ error: "regiaoSlug inválido." });

    const { data, error } = await supabase
      .from("cidades")
      .insert({
        regiao_id: regiao.id,
        nome,
        slug,
        ativo: Boolean(ativo),
        lat: lat === null ? null : Number(lat),
        lng: lng === null ? null : Number(lng)
      })
      .select("*")
      .single();
    if (error) {
      console.error("[/api/admin/cidades] Insert Erro:", error);
      return res.status(500).json({ error: "Erro ao criar cidade." });
    }

    res.json({ ok: true, data });
  } catch (e) {
    console.error("[/api/admin/cidades] Erro:", e);
    res.status(500).json({ error: "Erro interno." });
  }
});

// Métricas
app.get("/api/admin/metrics/summary", exigirChaveAdmin, async (req, res) => {
  try {
    const { regiaoSlug, cidadeSlug } = req.query;
    if (!regiaoSlug) return res.status(400).json({ error: "O parâmetro 'regiaoSlug' é obrigatório." });

    const { data: regiao, error: eReg } = await supabase
      .from("regioes")
      .select("id, nome, slug")
      .eq("slug", regiaoSlug)
      .single();
    if (eReg || !regiao) return res.status(404).json({ error: "Região não encontrada." });

    const { data: cidades, error: eCid } = await supabase
      .from("cidades")
      .select("id, nome, slug")
      .eq("regiao_id", regiao.id);
    if (eCid) return res.status(500).json({ error: "Erro ao carregar cidades." });

    let cidade = null;
    let idsCidades = (cidades || []).map(c => c.id);
    if (cidadeSlug) {
      cidade = (cidades || []).find(c => c.slug === cidadeSlug) || null;
      if (!cidade) return res.status(404).json({ error: "Cidade não encontrada nesta região." });
      idsCidades = [cidade.id];
    }

    const { data: parceirosAtivos, error: ePar } = await supabase
      .from("parceiros")
      .select("id")
      .eq("ativo", true)
      .in("cidade_id", idsCidades);
    if (ePar) return res.status(500).json({ error: "Erro ao contar parceiros." });

    const { data: buscas, error: eBus } = await supabase
      .from("buscas_texto")
      .select("id, cidade_id, regiao_id")
      .eq("regiao_id", regiao.id);
    if (eBus) return res.status(500).json({ error: "Erro ao contar buscas." });
    const totalBuscas = (buscas || []).filter(b => (cidade ? b.cidade_id === cidade.id : true)).length;

    const { data: interacoes, error: eInt } = await supabase
      .from("interacoes")
      .select("id, regiao_id")
      .eq("regiao_id", regiao.id);
    if (eInt) return res.status(500).json({ error: "Erro ao contar interações." });
    const totalInteracoes = (interacoes || []).length;

    const { data: views, error: eViews } = await supabase
      .from("parceiro_views")
      .select("parceiro_id, views_total, last_view_at")
      .order("views_total", { ascending: false })
      .limit(50);
    if (eViews) return res.status(500).json({ error: "Erro ao ler views." });

    const idsParceiros = Array.from(new Set((views || []).map(v => v.parceiro_id)));
    const { data: infos } = await supabase
      .from("parceiros")
      .select("id, nome, categoria, cidade_id")
      .in("id", idsParceiros);

    const mapa = new Map((infos || []).map(p => [p.id, p]));
    const top5 = (views || [])
      .filter(v => {
        const info = mapa.get(v.parceiro_id);
        if (!info) return false;
        return cidade ? info.cidade_id === cidade.id : idsCidades.includes(info.cidade_id);
      })
      .slice(0, 5)
      .map(v => {
        const info = mapa.get(v.parceiro_id);
        return {
          parceiro_id: v.parceiro_id,
          nome: info?.nome || "—",
          categoria: info?.categoria || "—",
          views_total: v.views_total,
          last_view_at: v.last_view_at
        };
      });

    return res.json({
      regiao: { id: regiao.id, nome: regiao.nome, slug: regiao.slug },
      cidade: cidade ? { id: cidade.id, nome: cidade.nome, slug: cidade.slug } : null,
      total_parceiros_ativos: (parceirosAtivos || []).length,
      total_buscas: totalBuscas,
      total_interacoes: totalInteracoes,
      top5_parceiros_por_views: top5
    });
  } catch (e) {
    console.error("[/api/admin/metrics/summary] Erro:", e);
    res.status(500).json({ error: "Erro interno." });
  }
});

// Logs
app.get("/api/admin/logs", exigirChaveAdmin, async (req, res) => {
  try {
    const {
      tipo, regiaoSlug, cidadeSlug, parceiroId, conversationId, since, until, limit
    } = req.query;

    let limite = Number(limit || 50);
    if (!Number.isFinite(limite) || limite <= 0) limite = 50;
    if (limite > 200) limite = 200;

    let regiaoId = null;
    let cidadeId = null;

    if (regiaoSlug) {
      const { data: regiao, error: eReg } = await supabase
        .from("regioes")
        .select("id, slug")
        .eq("slug", String(regiaoSlug))
        .single();
      if (eReg) return res.status(500).json({ error: "Erro ao buscar região." });
      if (!regiao) return res.status(404).json({ error: "Região não encontrada." });
      regiaoId = regiao.id;
    }

    if (cidadeSlug && regiaoId) {
      const { data: cidade, error: eCid } = await supabase
        .from("cidades")
        .select("id, slug, regiao_id")
        .eq("slug", String(cidadeSlug))
        .eq("regiao_id", regiaoId)
        .single();
      if (eCid) return res.status(500).json({ error: "Erro ao buscar cidade." });
      if (!cidade) return res.status(404).json({ error: "Cidade não encontrada nesta região." });
      cidadeId = cidade.id;
    }

    let q = supabase
      .from("eventos_analytics")
      .select("id, created_at, regiao_id, cidade_id, parceiro_id, conversation_id, tipo_evento, payload")
      .order("created_at", { ascending: false })
      .limit(limite);

    if (tipo) q = q.eq("tipo_evento", String(tipo));
    if (regiaoId) q = q.eq("regiao_id", regiaoId);
    if (cidadeId) q = q.eq("cidade_id", cidadeId);
    if (parceiroId) q = q.eq("parceiro_id", String(parceiroId));
    if (conversationId) q = q.eq("conversation_id", String(conversationId));
    if (since) q = q.gte("created_at", String(since));
    if (until) q = q.lte("created_at", String(until));

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: "Erro ao consultar logs." });

    return res.json({ data });
  } catch (e) {
    console.error("[/api/admin/logs] Erro inesperado:", e);
    return res.status(500).json({ error: "Erro interno." });
  }
});

// ============================ INICIAR SERVIDOR ==============================

app.listen(PORT, () => {
  console.log(`✅ BEPIT Nexus (Orquestrador v3.3) rodando em http://localhost:${PORT}`);
});
