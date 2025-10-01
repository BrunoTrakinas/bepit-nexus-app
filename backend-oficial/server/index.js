// ============================================================================
// BEPIT Nexus - Servidor (Express) — Orquestrador Lógico v3.3
// - Mudanças-chave desta versão:
//   1) /api/health e /api/health/db para smoke & DB check
//   2) CORS com allowlist Netlify (bepit-nexus.netlify.app ou variantes)
//   3) Rota PUT /api/admin/parceiros/:id (edição de parceiro)
//   4) Rota POST /api/auth/login (login por "key" via ADMIN_API_KEY)
//   5) Todas as rotas de API sob prefixo /api/* (compatível com netlify.toml)
//   6) Logs de erro mais claros para diagnosticar Supabase
// ============================================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { supabase } from "../lib/supabaseClient.js";

// ============================== CONFIGURAÇÃO BÁSICA =========================
const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json({ limit: "2mb" }));

// --------------------------------- CORS ------------------------------------
function isOriginAllowed(origin) {
  if (!origin) return true; // curl/Postman/health checks
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
    origin: (origin, cb) =>
      isOriginAllowed(origin) ? cb(null, true) : cb(new Error("CORS: origem não permitida.")),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-admin-key", "authorization"],
  })
);
app.options("*", cors());

// ------------------------------- GEMINI -------------------------------------
const geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const preferModel = (process.env.GEMINI_MODEL || "").trim();
const modelCandidates = [
  preferModel || null,
  "gemini-1.5-pro-latest",
  "gemini-1.5-flash-latest",
  "gemini-1.5-pro",
  "gemini-pro",
].filter(Boolean);

let chosenModelName = null;

async function getModel() {
  if (chosenModelName) return geminiClient.getGenerativeModel({ model: chosenModelName });
  let lastErr = null;
  for (const name of modelCandidates) {
    try {
      const m = geminiClient.getGenerativeModel({ model: name });
      await m.generateContent({ contents: [{ role: "user", parts: [{ text: "ok" }] }] });
      chosenModelName = name;
      console.log(`[GEMINI] Modelo selecionado: ${name}`);
      return m;
    } catch (e) {
      lastErr = e;
      console.warn(`[GEMINI] Falha ao usar modelo ${name}: ${e?.message || e}`);
    }
  }
  throw lastErr || new Error("Nenhum modelo Gemini disponível no momento.");
}

const RAW_MODE = process.env.RAW_MODE === "1";

// ------------------------------ FUNÇÕES AUXILIARES --------------------------
function normalizeText(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function deg2rad(g) {
  return (g * Math.PI) / 180;
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = deg2rad(b.lat - a.lat);
  const dLng = deg2rad(b.lng - a.lng);
  const lat1 = deg2rad(a.lat);
  const lat2 = deg2rad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Fallback coordinates
const fallbackCoords = {
  "cabo frio": { lat: -22.8894, lng: -42.0286 },
  "arraial do cabo": { lat: -22.9661, lng: -42.0271 },
  buzios: { lat: -22.7469, lng: -41.8817 },
  "búzios": { lat: -22.7469, lng: -41.8817 },
  "sao pedro da aldeia": { lat: -22.8427, lng: -42.1026 },
  "são pedro da aldeia": { lat: -22.8427, lng: -42.1026 },
};

function coordsFromCityOrText(text, cities) {
  const key = normalizeText(text);
  const dbHit = (cities || []).find(
    (c) => normalizeText(c.nome) === key || normalizeText(c.slug) === key
  );
  if (dbHit && typeof dbHit.lat === "number" && typeof dbHit.lng === "number") {
    return { lat: dbHit.lat, lng: dbHit.lng, fonte: "db" };
  }
  if (fallbackCoords[key]) return { ...fallbackCoords[key], fonte: "fallback" };
  return null;
}

// Histórico da conversa
async function buildHistoryForGemini(conversationId, limitPairs = 12) {
  try {
    const { data, error } = await supabase
      .from("interacoes")
      .select("pergunta_usuario, resposta_ia")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    const all = data || [];
    const last = all.slice(-limitPairs);
    const contents = [];
    for (const it of last) {
      if (it.pergunta_usuario) {
        contents.push({ role: "user", parts: [{ text: it.pergunta_usuario }] });
      }
      if (it.resposta_ia) {
        contents.push({ role: "model", parts: [{ text: it.resposta_ia }] });
      }
    }
    return contents;
  } catch (e) {
    console.warn("[HISTÓRICO] Falha ao carregar histórico:", e?.message || e);
    return [];
  }
}

function historyToPlain(contents) {
  try {
    return (contents || [])
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

// ------------------------------ FERRAMENTAS ---------------------------------
async function toolBuscarParceirosOuDicas({ regiao, cidadesAtivas, args }) {
  const category = (args?.category || "").trim();
  const city = (args?.city || "").trim();
  const terms = Array.isArray(args?.terms) ? args.terms : [];

  const validCities = cidadesAtivas || [];
  let cityIds = validCities.map((c) => c.id);
  if (city) {
    const found = validCities.find(
      (c) => normalizeText(c.nome) === normalizeText(city) || normalizeText(c.slug) === normalizeText(city)
    );
    if (found) cityIds = [found.id];
  }

  let q = supabase
    .from("parceiros")
    .select(
      "id, tipo, nome, categoria, descricao, endereco, contato, beneficio_bepit, faixa_preco, fotos_parceiros, cidade_id, tags, ativo"
    )
    .eq("ativo", true)
    .in("cidade_id", cityIds);

  if (category) q = q.ilike("categoria", `%${category}%`);

  const { data: base, error } = await q;
  if (error) throw error;

  let items = Array.isArray(base) ? base : [];

  if (terms.length > 0) {
    const nTerms = terms.map((t) => normalizeText(t));
    items = items.filter((p) => {
      const n = normalizeText(p.nome);
      const c = normalizeText(p.categoria || "");
      const tags = Array.isArray(p.tags) ? p.tags.map((x) => normalizeText(String(x))) : [];
      return nTerms.some((t) => n.includes(t) || c.includes(t) || tags.includes(t));
    });
  }

  items.sort((a, b) => (a.tipo === "DICA" ? 1 : 0) - (b.tipo === "DICA" ? 1 : 0));
  const limited = items.slice(0, 8);

  return {
    ok: true,
    count: limited.length,
    items: limited.map((p) => ({
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

async function toolRotaOuDistancia({ args, regiao, cidadesAtivas }) {
  const origin = String(args?.origin || "").trim();
  const destination = String(args?.destination || "").trim();
  if (!origin || !destination) {
    return { ok: false, error: "Os campos 'origin' e 'destination' são obrigatórios." };
  }
  const cO = coordsFromCityOrText(origin, cidadesAtivas);
  const cD =
    coordsFromCityOrText(destination, cidadesAtivas) ||
    coordsFromCityOrText("cabo frio", cidadesAtivas);
  if (!cO || !cD) {
    return { ok: false, error: "Coordenadas não disponíveis para origem ou destino informados." };
  }
  const kmLine = haversineKm(cO, cD);
  const kmRoad = Math.round(kmLine * 1.2);
  const hMin = Math.round(kmRoad / 70);
  const hMax = Math.round(kmRoad / 55);
  return {
    ok: true,
    origin,
    destination,
    km_estimated: kmRoad,
    hours_range: [hMin, hMax],
    notes: [
      "Estimativa por aproximação (linha reta + 20%). Utilize Waze/Maps para trânsito em tempo real.",
      "Em alta temporada, sair cedo ajuda a evitar congestionamento na Via Lagos (RJ-124).",
    ],
  };
}

async function toolDefinirPreferencia({ conversationId, args }) {
  const preference = String(args?.preference || "").toLowerCase();
  const topic = args?.topic || null;
  if (!["locais", "generico"].includes(preference)) {
    return { ok: false, error: "O campo 'preference' deve ser 'locais' ou 'generico'." };
  }
  try {
    const { error } = await supabase
      .from("conversas")
      .update({ preferencia_indicacao: preference, topico_atual: topic || null })
      .eq("id", conversationId);
    if (error) throw error;
    return { ok: true, saved: { preference, topic: topic || null } };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ================================ HEALTH ====================================
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, message: "Servidor BEPIT Nexus online", port: String(PORT) });
});

app.get("/api/health", (_req, res) => {
  res.status(200).json({ ok: true, scope: "api", message: "BEPIT Nexus API ok", port: String(PORT) });
});

// Verifica conexão e tabelas mínimas
app.get("/api/health/db", async (_req, res) => {
  try {
    const { data, error } = await supabase.from("regioes").select("id, slug").limit(1);
    if (error) {
      return res.status(500).json({ ok: false, db: "down", error: error.message });
    }
    return res.status(200).json({ ok: true, db: "up", sample: data || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, db: "down", error: e?.message || String(e) });
  }
});

// ================================ LÓGICA LLM ================================
async function classificarIntencao(userText) {
  const prompt = `Sua única tarefa é analisar a frase do usuário e classificá-la em uma das seguintes categorias: 'busca_parceiro', 'follow_up_parceiro', 'pergunta_geral', 'mudanca_contexto', 'small_talk'. Responda apenas com a string da categoria.
Frase: "${userText}"`;
  const model = await getModel();
  const resp = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
  const text = (resp?.response?.text() || "").trim().toLowerCase();
  const classes = new Set(["busca_parceiro", "follow_up_parceiro", "pergunta_geral", "mudanca_contexto", "small_talk"]);
  return classes.has(text) ? text : "pergunta_geral";
}

function historyToPrompt(contents) {
  return historyToPlain(contents);
}

async function respostaComParceiros(pergunta, historico, parceiros, regiaoNome = "") {
  const hist = historyToPrompt(historico);
  const ctx = JSON.stringify(parceiros ?? [], null, 2);

  const prompt = [
    "Você é o BEPIT, um concierge especialista.",
    "Responda à pergunta do usuário de forma útil, baseando-se EXCLUSIVAMENTE nas informações dos parceiros fornecidas em [Contexto].",
    "Se uma pergunta for ambígua ou completamente incompreensível, peça esclarecimentos de forma amigável antes de tentar adivinhar. Por exemplo: \"Não entendi muito bem o que você quis dizer com 'x', poderia me explicar de outra forma?\"",
    "",
    `[Contexto de Parceiros]: ${ctx}`,
    `[Histórico da Conversa]:\n${hist}`,
    `[Região]: ${regiaoNome}`,
    `[Pergunta do Usuário]: "${pergunta}"`,
  ].join("\n");

  const model = await getModel();
  const out = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
  return (out?.response?.text() || "").trim();
}

async function respostaGeral(pergunta, historico, regiao) {
  const hist = historyToPrompt(historico);
  const nomeRegiao = regiao?.nome || "Região dos Lagos";
  const prompt = [
    `Você é o BEPIT, um concierge amigável e conhecedor da região de ${nomeRegiao}.`,
    "Responda à pergunta do usuário de forma prestativa, usando seu conhecimento geral.",
    "Se uma pergunta for ambígua ou completamente incompreensível, peça esclarecimentos de forma amigável antes de tentar adivinhar. Por exemplo: \"Não entendi muito bem o que você quis dizer com 'x', poderia me explicar de outra forma?\"",
    "",
    `[Histórico da Conversa]:\n${hist}`,
    `[Pergunta do Usuário]: "${pergunta}"`,
  ].join("\n");

  const model = await getModel();
  const out = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
  return (out?.response?.text() || "").trim();
}

function encontrarParceiroNaLista(userText, lista) {
  try {
    const texto = normalizeText(userText);
    if (!Array.isArray(lista) || lista.length === 0) return null;

    const mNum = texto.match(/\b(\d{1,2})(?:º|o|a|\.|°)?\b/);
    if (mNum) {
      const idx = Number(mNum[1]);
      if (Number.isFinite(idx) && idx >= 1 && idx <= lista.length) return lista[idx - 1];
    }

    const ordinais = ["primeiro", "segundo", "terceiro", "quarto", "quinto", "sexto", "sétimo", "setimo", "oitavo"];
    for (let i = 0; i < ordinais.length; i++) {
      if (texto.includes(ordinais[i])) {
        const pos = i + 1;
        if (pos >= 1 && pos <= lista.length) return lista[pos - 1];
      }
    }

    for (const p of lista) {
      const n = normalizeText(p?.nome || "");
      if (!n) continue;
      if (texto.includes(n)) return p;
      const tokens = n.split(/\s+/).filter(Boolean);
      if (tokens.length > 0) {
        const hits = tokens.filter((t) => texto.includes(t)).length;
        if (hits >= Math.max(1, Math.ceil(tokens.length * 0.6))) return p;
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function lidarComNovaBusca({ userText, historicoGemini, regiao, cidadesAtivas, conversationId }) {
  const entPrompt = `Extraia entidades de busca para parceiros no formato JSON estrito (sem comentários).
Campos: {"category": string|null, "city": string|null, "terms": string[]}
- "category" deve ser algo como restaurante, passeio, hotel, bar, transfer, mergulho, pizzaria, etc.
- "city" se houver menção explícita.
- "terms" são adjetivos/necessidades: ["barato", "crianças", "vista para o mar", "pet friendly", etc]
Seja flexível com erros de digitação e abreviações comuns (ex: "restorante" -> "restaurante", "qd" -> "quando", "vc" -> "você").
Responda apenas com JSON.
Frase: "${userText}"`;

  const model = await getModel();
  const resp = await model.generateContent({ contents: [{ role: "user", parts: [{ text: entPrompt }] }] });
  const raw = (resp?.response?.text() || "").trim();
  let entities = { category: null, city: null, terms: [] };
  try {
    const parsed = JSON.parse(raw);
    entities = {
      category: typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim() : null,
      city: typeof parsed.city === "string" && parsed.city.trim() ? parsed.city.trim() : null,
      terms: Array.isArray(parsed.terms)
        ? parsed.terms.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim())
        : [],
    };
  } catch {
    // segue com vazios
  }

  const busca = await toolBuscarParceirosOuDicas({
    regiao,
    cidadesAtivas,
    args: entities,
  });

  if (busca?.ok && (busca?.count || 0) > 0) {
    const parceirosSugeridos = busca.items || [];
    const reply = await respostaComParceiros(userText, historicoGemini, parceirosSugeridos, regiao?.nome);

    try {
      await supabase
        .from("conversas")
        .update({
          parceiros_sugeridos: parceirosSugeridos,
          parceiro_em_foco: null,
          topico_atual: entities?.category || null,
        })
        .eq("id", conversationId);
    } catch {}

    return { reply, parceirosSugeridos };
  } else {
    const reply = await respostaGeral(userText, historicoGemini, regiao);
    return { reply, parceirosSugeridos: [] };
  }
}

// ================================ ROTAS CHAT =================================
app.post("/api/chat/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    let { message: userText, conversationId } = req.body || {};

    if (!userText || typeof userText !== "string" || !userText.trim()) {
      return res.status(400).json({ error: "O campo 'message' é obrigatório e deve ser uma string não vazia." });
    }
    userText = userText.trim();

    // Região
    const { data: region, error: eRegion } = await supabase
      .from("regioes")
      .select("id, nome, slug, ativo")
      .eq("slug", slug)
      .single();
    if (eRegion || !region) return res.status(404).json({ error: "Região não encontrada." });
    if (region.ativo === false) return res.status(403).json({ error: "Região desativada." });

    // Cidades
    const { data: cities, error: eCities } = await supabase
      .from("cidades")
      .select("id, nome, slug, lat, lng, ativo")
      .eq("regiao_id", region.id);
    if (eCities) {
      console.error("[DB] Erro ao carregar cidades:", eCities?.message || eCities);
      return res.status(500).json({ error: "Erro ao carregar cidades." });
    }
    const activeCities = (cities || []).filter((c) => c.ativo !== false);

    // Conversa
    if (!conversationId || typeof conversationId !== "string" || !conversationId.trim()) {
      conversationId = randomUUID();
      try {
        await supabase.from("conversas").insert({
          id: conversationId,
          regiao_id: region.id,
          parceiro_em_foco: null,
          parceiros_sugeridos: [],
          ultima_pergunta_usuario: null,
          ultima_resposta_ia: null,
          preferencia_indicacao: null,
          topico_atual: null,
        });
      } catch {}
    }

    // Conversa atual
    let conv = null;
    try {
      const { data: c } = await supabase
        .from("conversas")
        .select("id, parceiro_em_foco, preferencia_indicacao, topico_atual, parceiros_sugeridos")
        .eq("id", conversationId)
        .maybeSingle();
      conv = c || null;
    } catch {}

    if (RAW_MODE) {
      const model = await getModel();
      const hist = await buildHistoryForGemini(conversationId, 12);
      const out = await model.generateContent({
        contents: [...hist, { role: "user", parts: [{ text: userText }] }],
      });
      const freeText = (out?.response?.text?.() || "").trim() || "…";

      let interactionId = null;
      try {
        const { data: newInt } = await supabase
          .from("interacoes")
          .insert({
            regiao_id: region.id,
            conversation_id: conversationId,
            pergunta_usuario: userText,
            resposta_ia: freeText,
            parceiros_sugeridos: [],
          })
          .select("id")
          .single();
        interactionId = newInt?.id || null;
      } catch {}

      return res.status(200).json({
        reply: freeText,
        interactionId,
        photoLinks: [],
        conversationId,
      });
    }

    const hist = await buildHistoryForGemini(conversationId, 12);

    // Follow-up: escolher parceiro já sugerido
    const suggested = Array.isArray(conv?.parceiros_sugeridos) ? conv.parceiros_sugeridos : [];
    const picked = encontrarParceiroNaLista(userText, suggested);
    if (picked) {
      try {
        await supabase
          .from("conversas")
          .update({ parceiro_em_foco: picked, parceiros_sugeridos: suggested })
          .eq("id", conversationId);
      } catch {}

      const shortReply = await respostaComParceiros(userText, hist, [picked], region?.nome);

      let interactionId = null;
      try {
        const { data: newInt2 } = await supabase
          .from("interacoes")
          .insert({
            regiao_id: region.id,
            conversation_id: conversationId,
            pergunta_usuario: userText,
            resposta_ia: shortReply,
            parceiros_sugeridos: [picked],
          })
          .select("id")
          .single();
        interactionId = newInt2?.id || null;
      } catch (e) {
        console.warn("[INTERACOES] Falha ao salvar interação (seleção):", e?.message || e);
      }

      const photos = [picked].flatMap((p) => p?.fotos_parceiros || []).filter(Boolean);
      return res.status(200).json({
        reply: shortReply,
        interactionId,
        photoLinks: photos,
        conversationId,
        intent: "follow_up_parceiro",
        partners: [picked],
      });
    }

    // Classificação
    const intent = await classificarIntencao(userText);
    let finalReply = "";
    let suggestedPartners = [];

    switch (intent) {
      case "busca_parceiro": {
        const r = await lidarComNovaBusca({
          userText,
          historicoGemini: hist,
          regiao: region,
          cidadesAtivas: activeCities,
          conversationId,
        });
        finalReply = r.reply;
        suggestedPartners = r.parceirosSugeridos;
        break;
      }

      case "follow_up_parceiro": {
        const focus = conv?.parceiro_em_foco || null;
        if (focus) {
          finalReply = await respostaComParceiros(userText, hist, [focus], region?.nome);
          suggestedPartners = [focus];
        } else {
          const r = await lidarComNovaBusca({
            userText,
            historicoGemini: hist,
            regiao: region,
            cidadesAtivas: activeCities,
            conversationId,
          });
          finalReply = r.reply;
          suggestedPartners = r.parceirosSugeridos;
        }
        break;
      }

      case "pergunta_geral":
      case "mudanca_contexto": {
        finalReply = await respostaGeral(userText, hist, region);
        try {
          await supabase.from("conversas").update({ parceiro_em_foco: null }).eq("id", conversationId);
        } catch {}
        break;
      }

      case "small_talk": {
        finalReply = "Olá! Sou o BEPIT, seu concierge na Região dos Lagos. O que você gostaria de fazer hoje?";
        break;
      }

      default: {
        finalReply = "Não entendi muito bem. Você poderia reformular sua pergunta?";
        break;
      }
    }

    if (!finalReply) {
      finalReply =
        "Posso ajudar com roteiros, transporte, passeios, praias e onde comer. O que você gostaria de saber?";
    }

    let interactionId = null;
    try {
      const { data: newInt3, error: insErr } = await supabase
        .from("interacoes")
        .insert({
          regiao_id: region.id,
          conversation_id: conversationId,
          pergunta_usuario: userText,
          resposta_ia: finalReply,
          parceiros_sugeridos: suggestedPartners,
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      interactionId = newInt3?.id || null;
    } catch (e) {
      console.warn("[INTERACOES] Falha ao salvar interação:", e?.message || e);
    }

    const photoLinks = (suggestedPartners || [])
      .flatMap((p) => p?.fotos_parceiros || [])
      .filter(Boolean);

    return res.status(200).json({
      reply: finalReply,
      interactionId,
      photoLinks,
      conversationId,
      intent,
      partners: suggestedPartners,
    });
  } catch (e) {
    console.error("[/api/chat/:slug] Erro:", e);
    return res.status(500).json({ error: "Erro interno no servidor do BEPIT." });
  }
});

// ================================ FEEDBACK ===================================
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
        payload: { interactionId, feedback },
      });
    } catch {}

    res.json({ success: true });
  } catch (e) {
    console.error("[/api/feedback] Erro:", e);
    res.status(500).json({ error: "Erro interno." });
  }
});

// ================================ AUTH ======================================
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

// ================================ ADMIN =====================================
app.post("/api/admin/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const okU = username && username === process.env.ADMIN_USER;
    const okP = password && password === process.env.ADMIN_PASS;

    if (!okU || !okP) return res.status(401).json({ error: "Credenciais inválidas." });

    return res.json({ ok: true, adminKey: process.env.ADMIN_API_KEY });
  } catch (e) {
    console.error("[/api/admin/login] Erro:", e);
    return res.status(500).json({ error: "Erro interno." });
  }
});

function requireAdminKey(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== (process.env.ADMIN_API_KEY || "")) {
    return res.status(401).json({ error: "Chave administrativa inválida ou ausente." });
  }
  next();
}

app.post("/api/admin/parceiros", requireAdminKey, async (req, res) => {
  try {
    const body = req.body || {};
    const { regiaoSlug, cidadeSlug, ...rest } = body;

    const { data: region, error: eReg } = await supabase
      .from("regioes")
      .select("id")
      .eq("slug", regiaoSlug)
      .single();
    if (eReg || !region) return res.status(400).json({ error: "regiaoSlug inválido." });

    const { data: city, error: eCity } = await supabase
      .from("cidades")
      .select("id")
      .eq("regiao_id", region.id)
      .eq("slug", cidadeSlug)
      .single();
    if (eCity || !city) return res.status(400).json({ error: "cidadeSlug inválido." });

    const newRow = {
      cidade_id: city.id,
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
      fotos_parceiros: Array.isArray(rest.fotos_parceiros)
        ? rest.fotos_parceiros
        : Array.isArray(rest.fotos)
        ? rest.fotos
        : null,
      ativo: rest.ativo !== false,
    };

    const { data, error } = await supabase.from("parceiros").insert(newRow).select("*").single();
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

app.get("/api/admin/parceiros/:regiaoSlug/:cidadeSlug", requireAdminKey, async (req, res) => {
  try {
    const { regiaoSlug, cidadeSlug } = req.params;

    const { data: region, error: eReg } = await supabase
      .from("regioes")
      .select("id")
      .eq("slug", regiaoSlug)
      .single();
    if (eReg || !region) return res.status(400).json({ error: "regiaoSlug inválido." });

    const { data: city, error: eCity } = await supabase
      .from("cidades")
      .select("id")
      .eq("regiao_id", region.id)
      .eq("slug", cidadeSlug)
      .single();
    if (eCity || !city) return res.status(400).json({ error: "cidadeSlug inválido." });

    const { data, error } = await supabase
      .from("parceiros")
      .select("*")
      .eq("cidade_id", city.id)
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

// >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
// PONTO DE REFERÊNCIA: INSIRA/ENCONTRE ESTA ROTA DE ATUALIZAÇÃO (PUT)
// Fica logo após as rotas de parceiros (POST/GET) e antes das métricas/logs.
// >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
app.put("/api/admin/parceiros/:id", requireAdminKey, async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    const update = {
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
        : Array.isArray(body.fotos)
        ? body.fotos
        : null,
      ativo: body.ativo !== false,
    };

    const { data, error } = await supabase
      .from("parceiros")
      .update(update)
      .eq("id", id)
      .select("*")
      .single();

    if (error) {
      console.error("[/api/admin/parceiros/:id PUT] Erro:", error);
      return res.status(500).json({ error: "Erro ao atualizar parceiro." });
    }

    return res.status(200).json({ ok: true, data });
  } catch (e) {
    console.error("[/api/admin/parceiros/:id PUT] Erro:", e);
    return res.status(500).json({ error: "Erro interno." });
  }
});

// Métricas
app.get("/api/admin/metrics/summary", requireAdminKey, async (req, res) => {
  try {
    const { regiaoSlug, cidadeSlug } = req.query;
    if (!regiaoSlug) return res.status(400).json({ error: "O parâmetro 'regiaoSlug' é obrigatório." });

    const { data: region, error: eReg } = await supabase
      .from("regioes")
      .select("id, nome, slug")
      .eq("slug", regiaoSlug)
      .single();
    if (eReg || !region) return res.status(404).json({ error: "Região não encontrada." });

    const { data: cities, error: eCities } = await supabase
      .from("cidades")
      .select("id, nome, slug")
      .eq("regiao_id", region.id);
    if (eCities) return res.status(500).json({ error: "Erro ao carregar cidades." });

    let city = null;
    let cityIds = (cities || []).map((c) => c.id);
    if (cidadeSlug) {
      city = (cities || []).find((c) => c.slug === cidadeSlug) || null;
      if (!city) return res.status(404).json({ error: "Cidade não encontrada nesta região." });
      cityIds = [city.id];
    }

    const { data: activePartners, error: eP } = await supabase
      .from("parceiros")
      .select("id")
      .eq("ativo", true)
      .in("cidade_id", cityIds);
    if (eP) return res.status(500).json({ error: "Erro ao contar parceiros." });

    const { data: searches, error: eS } = await supabase
      .from("buscas_texto")
      .select("id, cidade_id, regiao_id")
      .eq("regiao_id", region.id);
    if (eS) return res.status(500).json({ error: "Erro ao contar buscas." });
    const totalBuscas = (searches || []).filter((b) => (city ? b.cidade_id === city.id : true)).length;

    const { data: inter, error: eI } = await supabase
      .from("interacoes")
      .select("id, regiao_id")
      .eq("regiao_id", region.id);
    if (eI) return res.status(500).json({ error: "Erro ao contar interações." });
    const totalInteracoes = (inter || []).length;

    const { data: views, error: eV } = await supabase
      .from("parceiro_views")
      .select("parceiro_id, views_total, last_view_at")
      .order("views_total", { ascending: false })
      .limit(50);
    if (eV) return res.status(500).json({ error: "Erro ao ler views." });

    const ids = Array.from(new Set((views || []).map((v) => v.parceiro_id)));
    const { data: infos } = await supabase
      .from("parceiros")
      .select("id, nome, categoria, cidade_id")
      .in("id", ids);

    const map = new Map((infos || []).map((p) => [p.id, p]));
    const top5 = (views || [])
      .filter((reg) => {
        const info = map.get(reg.parceiro_id);
        if (!info) return false;
        return city ? info.cidade_id === city.id : cityIds.includes(info.cidade_id);
      })
      .slice(0, 5)
      .map((reg) => {
        const info = map.get(reg.parceiro_id);
        return {
          parceiro_id: reg.parceiro_id,
          nome: info?.nome || "—",
          categoria: info?.categoria || "—",
          views_total: reg.views_total,
          last_view_at: reg.last_view_at,
        };
      });

    return res.json({
      regiao: { id: region.id, nome: region.nome, slug: region.slug },
      cidade: city ? { id: city.id, nome: city.nome, slug: city.slug } : null,
      total_parceiros_ativos: (activePartners || []).length,
      total_buscas: totalBuscas,
      total_interacoes: totalInteracoes,
      top5_parceiros_por_views: top5,
    });
  } catch (e) {
    console.error("[/api/admin/metrics/summary] Erro:", e);
    res.status(500).json({ error: "Erro interno." });
  }
});

app.get("/api/admin/logs", requireAdminKey, async (req, res) => {
  try {
    const { tipo, regiaoSlug, cidadeSlug, parceiroId, conversationId, since, until, limit } = req.query;

    let lim = Number(limit || 50);
    if (!Number.isFinite(lim) || lim <= 0) lim = 50;
    if (lim > 200) lim = 200;

    let regionId = null;
    let cityId = null;

    if (regiaoSlug) {
      const { data: region, error: eReg } = await supabase
        .from("regioes")
        .select("id, slug")
        .eq("slug", String(regiaoSlug))
        .single();
      if (eReg) {
        console.error("[/api/admin/logs] Erro ao buscar região:", eReg);
        return res.status(500).json({ error: "Erro ao buscar região." });
      }
      if (!region) return res.status(404).json({ error: "Região não encontrada." });
      regionId = region.id;
    }

    if (cidadeSlug && regionId) {
      const { data: city, error: eCity } = await supabase
        .from("cidades")
        .select("id, slug, regiao_id")
        .eq("slug", String(cidadeSlug))
        .eq("regiao_id", regionId)
        .single();
      if (eCity) {
        console.error("[/api/admin/logs] Erro ao buscar cidade:", eCity);
        return res.status(500).json({ error: "Erro ao buscar cidade." });
      }
      if (!city) return res.status(404).json({ error: "Cidade não encontrada nesta região." });
      cityId = city.id;
    }

    let q = supabase
      .from("eventos_analytics")
      .select("id, created_at, regiao_id, cidade_id, parceiro_id, conversation_id, tipo_evento, payload")
      .order("created_at", { ascending: false })
      .limit(lim);

    if (tipo) q = q.eq("tipo_evento", String(tipo));
    if (regionId) q = q.eq("regiao_id", regionId);
    if (cityId) q = q.eq("cidade_id", cityId);
    if (parceiroId) q = q.eq("parceiro_id", String(parceiroId));
    if (conversationId) q = q.eq("conversation_id", String(conversationId));
    if (since) q = q.gte("created_at", String(since));
    if (until) q = q.lte("created_at", String(until));

    const { data, error } = await q;
    if (error) {
      console.error("[/api/admin/logs] Erro Supabase:", error);
      return res.status(500).json({ error: "Erro ao consultar logs." });
    }

    return res.json({ data });
  } catch (e) {
    console.error("[/api/admin/logs] Erro inesperado:", e);
    return res.status(500).json({ error: "Erro interno." });
  }
});

// ------------------------ INICIAR SERVIDOR ----------------------------------
app.listen(PORT, () => {
  console.log(`✅ BEPIT Nexus (Orquestrador v3.3) rodando em http://localhost:${PORT}`);
});
