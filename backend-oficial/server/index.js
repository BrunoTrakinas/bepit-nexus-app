// ============================================================================
// BEPIT Nexus - Servidor (Express) — Orquestrador Lógico v3.3 (REST Gemini)
// - Modo Gemini: REST v1 somente (compatível com modelos atuais, sem SDK)
// - Requisitos de ambiente (Render):
//   USE_GEMINI_REST=1
//   GEMINI_API_KEY=... (chave do Google AI Studio / MakerSuite habilitada p/ v1)
//   SUPABASE_URL=...
//   SUPABASE_SERVICE_ROLE=...  (ou SUPABASE_SERVICE_KEY)
//   ADMIN_API_KEY=...          (para rotas /api/admin/* e /api/auth/login por "key")
//   (opcionais)
//   GEMINI_MODEL=gemini-2.5-flash (ou sem "models/")
//   ADMIN_USER=... / ADMIN_PASS=... (login alternativo por user/pass)
// ============================================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { supabase } from "../lib/supabaseClient.js";

// >>>>>>>>>>>>>>>>>>>>>>>> IMPORTANTE: GUARDRAILS (CAMINHO CORRIGIDO) <<<<<<<<
import {
  finalizeAssistantResponse,
  buildNoPartnerFallback,
  BEPIT_SYSTEM_PROMPT_APPENDIX
} from "../utils/bepitGuardrails.js";
// >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

// ============================== CONFIGURAÇÃO BÁSICA =========================
const aplicacaoExpress = express();
const portaDoServidor = process.env.PORT || 3002;

aplicacaoExpress.use(express.json({ limit: "2mb" }));

// --------------------------------- CORS ------------------------------------
function origemPermitida(origem) {
  if (!origem) return true; // curl/Postman/health
  try {
    const url = new URL(origem);
    if (url.hostname === "localhost") return true;
    if (url.host === "bepitnexus.netlify.app") return true;
    if (url.host === "bepit-nexus.netlify.app") return true;
    if (url.host.endsWith(".netlify.app")) return true;
    return false;
  } catch {
    return false;
  }
}

aplicacaoExpress.use(
  cors({
    origin: (origin, callback) =>
      origemPermitida(origin) ? callback(null, true) : callback(new Error("CORS: origem não permitida.")),
    credentials: true,
    allowedHeaders: ["Content-Type", "x-admin-key", "authorization"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  })
);
aplicacaoExpress.options("*", cors());

// ============================================================================
// GEMINI (REST v1) — descoberta e seleção robustas de modelo
// ============================================================================
const usarGeminiREST = String(process.env.USE_GEMINI_REST || "") === "1";
const chaveGemini = process.env.GEMINI_API_KEY || "";

function stripModelsPrefix(id) {
  return String(id || "").replace(/^models\//, "");
}

async function listarModelosREST() {
  if (!chaveGemini) {
    throw new Error("[GEMINI REST] GEMINI_API_KEY não definida.");
  }
  const url = `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(chaveGemini)}`;
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    const texto = await resp.text().catch(() => "");
    throw new Error(`[GEMINI REST] Falha ao listar modelos (GET /v1/models): ${resp.status} ${resp.statusText} ${texto}`);
  }
  const json = await resp.json();
  const items = Array.isArray(json.models) ? json.models : [];
  return items.map(m => String(m.name || "")).filter(Boolean);
}

async function selecionarModeloREST() {
  const todosComPrefixo = await listarModelosREST();
  const disponiveisSimples = todosComPrefixo.map(stripModelsPrefix);

  const envModelo = (process.env.GEMINI_MODEL || "").trim();
  if (envModelo) {
    const alvo = stripModelsPrefix(envModelo);
    if (disponiveisSimples.includes(alvo)) return alvo;
    console.warn(`[GEMINI REST] Modelo definido em GEMINI_MODEL ("${envModelo}") não está disponível. Modelos: ${disponiveisSimples.join(", ")}`);
  }

  const preferencia = [
    envModelo && stripModelsPrefix(envModelo),
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-2.0-flash-001",
    "gemini-2.0-flash-lite",
    "gemini-1.5-pro-002",
    "gemini-1.5-flash-002"
  ].filter(Boolean);

  for (const alvo of preferencia) {
    if (disponiveisSimples.includes(alvo)) return alvo;
  }

  const qualquerGemini = disponiveisSimples.find(n => /^gemini-\d/.test(n) || /^gemini-/.test(n));
  if (qualquerGemini) return qualquerGemini;

  throw new Error("[GEMINI REST] Não foi possível selecionar um modelo v1.");
}

async function gerarConteudoComREST(modelo, texto) {
  if (!chaveGemini) {
    throw new Error("[GEMINI REST] GEMINI_API_KEY não definida.");
  }
  const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(modelo)}:generateContent?key=${encodeURIComponent(chaveGemini)}`;
  const payload = {
    contents: [{ role: "user", parts: [{ text: String(texto || "") }] }]
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const texto = await resp.text().catch(() => "");
    throw new Error(`[GEMINI REST] Falha no generateContent: ${resp.status} ${resp.statusText} ${texto}`);
  }
  const json = await resp.json();
  const parts = json?.candidates?.[0]?.content?.parts;
  const out = Array.isArray(parts) ? parts.map(p => p?.text || "").join("\n").trim() : "";
  return out || "";
}

let modeloGeminiV1 = null;
async function obterModeloREST() {
  if (!usarGeminiREST) {
    throw new Error("[GEMINI REST] USE_GEMINI_REST não está ativo (defina USE_GEMINI_REST=1).");
  }
  if (modeloGeminiV1) return modeloGeminiV1;
  modeloGeminiV1 = await selecionarModeloREST();
  console.log(`[GEMINI REST] Modelo selecionado: ${modeloGeminiV1}`);
  return modeloGeminiV1;
}

async function geminiGerarTexto(texto) {
  if (!usarGeminiREST) {
    throw new Error("[GEMINI] Backend configurado para REST. Ative USE_GEMINI_REST=1.");
  }
  const modelo = await obterModeloREST();
  return await gerarConteudoComREST(modelo, texto);
}

// ============================================================================
// HELPERS DE TEXTO, GEO E HISTÓRICO
// ============================================================================
function normalizarTexto(texto) {
  return String(texto || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function converterGrausParaRadianos(valorEmGraus) { return (valorEmGraus * Math.PI) / 180; }

function calcularDistanciaHaversineEmKm(coordenadaA, coordenadaB) {
  const raioDaTerraKm = 6371;
  const diferencaLat = converterGrausParaRadianos(coordenadaB.lat - coordenadaA.lat);
  const diferencaLng = converterGrausParaRadianos(coordenadaB.lng - coordenadaA.lng);
  const lat1Rad = converterGrausParaRadianos(coordenadaA.lat);
  const lat2Rad = converterGrausParaRadianos(coordenadaB.lat);
  const h = Math.sin(diferencaLat / 2) ** 2 + Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(diferencaLng / 2) ** 2;
  return 2 * raioDaTerraKm * Math.asin(Math.sqrt(h));
}

const coordenadasFallback = {
  "cabo frio": { lat: -22.8894, lng: -42.0286 },
  "arraial do cabo": { lat: -22.9661, lng: -42.0271 },
  "buzios": { lat: -22.7469, lng: -41.8817 },
  "búzios": { lat: -22.7469, lng: -41.8817 },
  "sao pedro da aldeia": { lat: -22.8427, lng: -42.1026 },
  "são pedro da aldeia": { lat: -22.8427, lng: -42.1026 }
};

function obterCoordenadasPorCidadeOuTexto(texto, listaDeCidades) {
  const chave = normalizarTexto(texto);
  const candidatoNaBase = (listaDeCidades || []).find(
    c => normalizarTexto(c.nome) === chave || normalizarTexto(c.slug) === chave
  );
  if (candidatoNaBase && typeof candidatoNaBase.lat === "number" && typeof candidatoNaBase.lng === "number") {
    return { lat: candidatoNaBase.lat, lng: candidatoNaBase.lng, fonte: "db" };
  }
  const candidatoFallback = coordenadasFallback[chave];
  if (candidatoFallback) return { ...candidatoFallback, fonte: "fallback" };
  return null;
}

async function construirHistoricoParaGemini(idDaConversa, limiteDeTrocas = 12) {
  try {
    const { data, error } = await supabase
      .from("interacoes")
      .select("pergunta_usuario, resposta_ia")
      .eq("conversation_id", idDaConversa)
      .order("created_at", { ascending: true });
    if (error) throw error;
    const todasAsInteracoes = (data || []);
    const ultimasInteracoes = todasAsInteracoes.slice(-limiteDeTrocas);

    const historicoGemini = [];
    for (const interacao of ultimasInteracoes) {
      if (interacao.pergunta_usuario) {
        historicoGemini.push({ role: "user", parts: [{ text: interacao.pergunta_usuario }] });
      }
      if (interacao.resposta_ia) {
        historicoGemini.push({ role: "model", parts: [{ text: interacao.resposta_ia }] });
      }
    }
    return historicoGemini;
  } catch (erro) {
    console.warn("[HISTORICO] Falha ao carregar histórico:", erro?.message || erro);
    return [];
  }
}

function historicoParaTextoSimples(historicoContents) {
  try {
    return (historicoContents || [])
      .map(bloco => {
        const role = bloco?.role || "user";
        const text = (bloco?.parts?.[0]?.text || "").replace(/\s+/g, " ").trim();
        return `- ${role}: ${text}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

// ============================================================================
// FERRAMENTAS (busca parceiros; distancia; preferências)
// ============================================================================
async function ferramentaBuscarParceirosOuDicas({ regiao, cidadesAtivas, argumentosDaFerramenta }) {
  const categoriaProcurada = (argumentosDaFerramenta?.category || "").trim();
  const cidadeProcurada = (argumentosDaFerramenta?.city || "").trim();
  const listaDeTermos = Array.isArray(argumentosDaFerramenta?.terms) ? argumentosDaFerramenta.terms : [];

  const cidadesValidas = (cidadesAtivas || []);
  let listaDeIdsDeCidadesParaFiltro = cidadesValidas.map(c => c.id);
  if (cidadeProcurada) {
    const alvo = cidadesValidas.find(
      c => normalizarTexto(c.nome) === normalizarTexto(cidadeProcurada) || normalizarTexto(c.slug) === normalizarTexto(cidadeProcurada)
    );
    if (alvo) listaDeIdsDeCidadesParaFiltro = [alvo.id];
  }

  let construtorDeConsulta = supabase
    .from("parceiros")
    .select("id, tipo, nome, categoria, descricao, endereco, contato, beneficio_bepit, faixa_preco, fotos_parceiros, cidade_id, tags, ativo")
    .eq("ativo", true)
    .in("cidade_id", listaDeIdsDeCidadesParaFiltro);

  if (categoriaProcurada) construtorDeConsulta = construtorDeConsulta.ilike("categoria", `%${categoriaProcurada}%`);

  const { data: registrosBase, error } = await construtorDeConsulta;
  if (error) throw error;
  let itens = Array.isArray(registrosBase) ? registrosBase : [];

  if (listaDeTermos.length > 0) {
    const termosNormalizados = listaDeTermos.map((termo) => normalizarTexto(termo));
    itens = itens.filter((parc) => {
      const nomeNormalizado = normalizarTexto(parc.nome);
      const categoriaNormalizada = normalizarTexto(parc.categoria || "");
      const listaDeTags = Array.isArray(parc.tags) ? parc.tags.map((x) => normalizarTexto(String(x))) : [];
      return termosNormalizados.some((termo) => nomeNormalizado.includes(termo) || categoriaNormalizada.includes(termo) || listaDeTags.includes(termo));
    });
  }

  itens.sort((a, b) => (a.tipo === "DICA" ? 1 : 0) - (b.tipo === "DICA" ? 1 : 0));
  const itensLimitados = itens.slice(0, 8);

  return {
    ok: true,
    count: itensLimitados.length,
    items: itensLimitados.map((p) => ({
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

async function ferramentaObterRotaOuDistanciaAproximada({ argumentosDaFerramenta, regiao, cidadesAtivas }) {
  const origem = String(argumentosDaFerramenta?.origin || "").trim();
  const destino = String(argumentosDaFerramenta?.destination || "").trim();
  if (!origem || !destino) {
    return { ok: false, error: "Os campos 'origin' e 'destination' são obrigatórios." };
  }

  const coordenadasOrigem = obterCoordenadasPorCidadeOuTexto(origem, cidadesAtivas);
  const coordenadasDestino = obterCoordenadasPorCidadeOuTexto(destino, cidadesAtivas) ||
                             obterCoordenadasPorCidadeOuTexto("cabo frio", cidadesAtivas);
  if (!coordenadasOrigem || !coordenadasDestino) {
    return { ok: false, error: "Coordenadas não disponíveis para origem ou destino informados." };
  }
  const distanciaEmLinhaRetaKm = calcularDistanciaHaversineEmKm(coordenadasOrigem, coordenadasDestino);
  const distanciaRodoviariaAproximadaKm = Math.round(distanciaEmLinhaRetaKm * 1.2);
  const tempoMinimoHoras = Math.round(distanciaRodoviariaAproximadaKm / 70);
  const tempoMaximoHoras = Math.round(distanciaRodoviariaAproximadaKm / 55);

  return {
    ok: true,
    origin: origem,
    destination: destino,
    km_estimated: distanciaRodoviariaAproximadaKm,
    hours_range: [tempoMinimoHoras, tempoMaximoHoras],
    notes: [
      "Estimativa por aproximação (linha reta + 20%). Utilize Waze/Maps para trânsito em tempo real.",
      "Em alta temporada, sair cedo ajuda a evitar congestionamento na Via Lagos (RJ-124)."
    ]
  };
}

async function ferramentaDefinirPreferenciaDeIndicacao({ idDaConversa, argumentosDaFerramenta }) {
  const preferencia = String(argumentosDaFerramenta?.preference || "").toLowerCase();
  const topico = (argumentosDaFerramenta?.topic || null);
  if (!["locais", "generico"].includes(preferencia)) {
    return { ok: false, error: "O campo 'preference' deve ser 'locais' ou 'generico'." };
  }
  try {
    const { error } = await supabase
      .from("conversas")
      .update({ preferencia_indicacao: preferencia, topico_atual: topico || null })
      .eq("id", idDaConversa);
    if (error) throw error;
    return { ok: true, saved: { preference: preferencia, topic: topico || null } };
  } catch (erro) {
    return { ok: false, error: erro?.message || String(erro) };
  }
}

// ============================================================================
// HEALTHCHECKS
// ============================================================================
aplicacaoExpress.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, message: "Servidor BEPIT Nexus online", port: String(portaDoServidor) });
});

aplicacaoExpress.get("/api/health", (_req, res) => {
  res.status(200).json({ ok: true, scope: "api", message: "BEPIT Nexus API ok", port: String(portaDoServidor) });
});

aplicacaoExpress.get("/api/health/db", async (_req, res) => {
  try {
    const { data, error } = await supabase.from("regioes").select("id").limit(1);
    if (error) throw error;
    res.json({ ok: true, sample: data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_error", internal: e });
  }
});

// ============================================================================
// DIAGNÓSTICOS
// ============================================================================
aplicacaoExpress.get("/api/diag/gemini", async (_req, res) => {
  try {
    if (!usarGeminiREST) {
      return res.status(200).json({ ok: false, modo: "SDK", info: "USE_GEMINI_REST não está ativo." });
    }
    const modelos = await listarModelosREST();
    let escolhido = null;
    let ping = null;
    try {
      escolhido = await obterModeloREST();
      const texto = await gerarConteudoComREST(escolhido, "ping");
      ping = texto ? "ok" : "vazio";
    } catch (e) {
      ping = String(e?.message || e);
    }
    res.json({ ok: true, modo: "REST", modelos, escolhido, ping });
  } catch (e) {
    res.status(500).json({ ok: false, modo: "REST", error: String(e?.message || e) });
  }
});

aplicacaoExpress.get("/api/diag/region/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const { data, error } = await supabase
      .from("regioes").select("*").eq("slug", slug).single();
    if (error) throw error;
    res.json({ ok: true, region: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: "supabase_error_region", internal: e });
  }
});

aplicacaoExpress.get("/api/diag/cidades/:regiaoSlug", async (req, res) => {
  try {
    const { regiaoSlug } = req.params;
    const { data: regiao, error: erroReg } = await supabase
      .from("regioes").select("id, slug").eq("slug", regiaoSlug).single();
    if (erroReg) throw erroReg;
    const { data, error } = await supabase
      .from("cidades").select("id, nome, slug, regiao_id, ativo, lat, lng").eq("regiao_id", regiao.id);
    if (error) throw error;
    res.json({ ok: true, cidades: data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: "supabase_error_cidades", internal: e });
  }
});

aplicacaoExpress.get("/api/diag/columns", async (_req, res) => {
  try {
    const probe = async (table, cols) => {
      const sel = cols.join(", ");
      const out = { table, probe: {} };
      for (const c of cols) out.probe[c] = { ok: true };
      await supabase.from(table).select(sel).limit(1);
      return out;
    };
    const checks = [];
    checks.push(await probe("cidades", ["id","nome","slug","regiao_id","ativo","lat","lng"]));
    checks.push(await probe("regioes", ["id","nome","slug","ativo"]));
    checks.push(await probe("parceiros", ["id","tipo","nome","categoria","descricao","endereco","contato","beneficio_bepit","faixa_preco","fotos_parceiros","cidade_id","tags","ativo"]));
    checks.push(await probe("conversas", ["id","regiao_id","parceiro_em_foco","parceiros_sugeridos","ultima_pergunta_usuario","ultima_resposta_ia","preferencia_indicacao","topico_atual"]));
    checks.push(await probe("interacoes", ["id","regiao_id","conversation_id","pergunta_usuario","resposta_ia","parceiros_sugeridos","feedback_usuario","created_at"]));
    res.json({ ok: true, columns: checks });
  } catch (e) {
    res.status(500).json({ ok: false, error: "columns_probe_error", internal: e });
  }
});

// ============================================================================
// CÉREBRO / PROMPTS
// ============================================================================
async function analisarIntencaoDoUsuario(textoDoUsuario) {
  const prompt = `Sua única tarefa é analisar a frase do usuário e classificá-la em uma das seguintes categorias: 'busca_parceiro', 'follow_up_parceiro', 'pergunta_geral', 'mudanca_contexto', 'small_talk'. Responda apenas com a string da categoria.
Frase: "${textoDoUsuario}"`;
  const saida = await geminiGerarTexto(prompt);
  const text = (saida || "").trim().toLowerCase();
  const classes = new Set(["busca_parceiro", "follow_up_parceiro", "pergunta_geral", "mudanca_contexto", "small_talk"]);
  return classes.has(text) ? text : "pergunta_geral";
}

async function extrairEntidadesDaBusca(texto) {
  const prompt = `Extraia entidades de busca para parceiros no formato JSON estrito (sem comentários).
Campos: {"category": string|null, "city": string|null, "terms": string[]}
- "category" deve ser algo como restaurante, passeio, hotel, bar, transfer, mergulho, pizzaria, etc.
- "city" se houver menção explícita.
- "terms" são adjetivos/necessidades: ["barato", "crianças", "vista para o mar", "pet friendly", etc]
Seja flexível com erros de digitação e abreviações comuns (ex: "restorante" -> "restaurante", "qd" -> "quando", "vc" -> "você").
Responda apenas com JSON.
Frase: "${texto}"`;
  try {
    const bruto = await geminiGerarTexto(prompt);
    const parsed = JSON.parse(bruto);
    const category = typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim() : null;
    const city = typeof parsed.city === "string" && parsed.city.trim() ? parsed.city.trim() : null;
    const terms = Array.isArray(parsed.terms) ? parsed.terms.filter(t => typeof t === "string" && t.trim()).map(t => t.trim()) : [];
    return { category, city, terms };
  } catch {
    return { category: null, city: null, terms: [] };
  }
}

function historicoParaTextoSimples(historicoContents) {
  try {
    return (historicoContents || [])
      .map(bloco => {
        const role = bloco?.role || "user";
        const text = (bloco?.parts?.[0]?.text || "").replace(/\s+/g, " ").trim();
        return `- ${role}: ${text}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

async function gerarRespostaComParceiros(pergunta, historicoContents, parceiros, regiaoNome = "") {
  const historicoTexto = historicoParaTextoSimples(historicoContents);
  const contextoParceiros = JSON.stringify(parceiros ?? [], null, 2);
  const prompt = [
    "Você é o BEPIT, um concierge especialista.",
    "Responda à pergunta do usuário de forma útil, baseando-se EXCLUSIVAMENTE nas informações dos parceiros fornecidas em [Contexto].",
    "Se uma pergunta for ambígua ou completamente incompreensível, peça esclarecimentos de forma amigável antes de tentar adivinhar. Por exemplo: \"Não entendi muito bem o que você quis dizer com 'x', poderia me explicar de outra forma?\"",
    "",
    BEPIT_SYSTEM_PROMPT_APPENDIX,
    "",
    `[Contexto de Parceiros]: ${contextoParceiros}`,
    `[Histórico da Conversa]:\n${historicoTexto}`,
    `[Região]: ${regiaoNome}`,
    `[Pergunta do Usuário]: "${pergunta}"`
  ].join("\n");
  return await geminiGerarTexto(prompt);
}

async function gerarRespostaGeral(pergunta, historicoContents, regiao) {
  const historicoTexto = historicoParaTextoSimples(historicoContents);
  const nomeRegiao = regiao?.nome || "Região dos Lagos";
  const prompt = [
    `Você é o BEPIT, um concierge amigável e conhecedor da região de ${nomeRegiao}.`,
    "Responda à pergunta do usuário de forma prestativa, usando seu conhecimento geral.",
    "Se uma pergunta for ambígua ou completamente incompreensível, peça esclarecimentos de forma amigável antes de tentar adivinhar. Por exemplo: \"Não entendi muito bem o que você quis dizer com 'x', poderia me explicar de outra forma?\"",
    "",
    BEPIT_SYSTEM_PROMPT_APPENDIX,
    "",
    `[Histórico da Conversa]:\n${historicoTexto}`,
    `[Pergunta do Usuário]: "${pergunta}"`
  ].join("\n");
  return await geminiGerarTexto(prompt);
}

function encontrarParceiroNaLista(textoDoUsuario, listaDeParceiros) {
  try {
    const texto = normalizarTexto(textoDoUsuario);
    if (!Array.isArray(listaDeParceiros) || listaDeParceiros.length === 0) return null;

    const matchNumero = texto.match(/\b(\d{1,2})(?:º|o|a|\.|°)?\b/);
    if (matchNumero) {
      const idx = Number(matchNumero[1]);
      if (Number.isFinite(idx) && idx >= 1 && idx <= listaDeParceiros.length) {
        return listaDeParceiros[idx - 1];
      }
    }

    const ordinais = ["primeiro", "segundo", "terceiro", "quarto", "quinto", "sexto", "sétimo", "setimo", "oitavo"];
    for (let i = 0; i < ordinais.length; i++) {
      if (texto.includes(ordinais[i])) {
        const pos = i + 1;
        if (pos >= 1 && pos <= listaDeParceiros.length) {
          return listaDeParceiros[pos - 1];
        }
      }
    }

    for (const p of listaDeParceiros) {
      const nome = normalizarTexto(p?.nome || "");
      if (nome && texto.includes(nome)) return p;
      const tokens = (nome || "").split(/\s+/).filter(Boolean);
      if (tokens.length > 0) {
        const acertos = tokens.filter(t => texto.includes(t)).length;
        if (acertos >= Math.max(1, Math.ceil(tokens.length * 0.6))) {
          return p;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function lidarComNovaBusca({ textoDoUsuario, historicoGemini, regiao, cidadesAtivas, idDaConversa }) {
  const entidades = await extrairEntidadesDaBusca(textoDoUsuario);

  const resultadoBusca = await ferramentaBuscarParceirosOuDicas({
    regiao,
    cidadesAtivas,
    argumentosDaFerramenta: entidades
  });

  if (resultadoBusca?.ok && (resultadoBusca?.count || 0) > 0) {
    const parceirosSugeridos = resultadoBusca.items || [];
    const respostaFinal = await gerarRespostaComParceiros(textoDoUsuario, historicoGemini, parceirosSugeridos, regiao?.nome);

    try {
      await supabase
        .from("conversas")
        .update({ parceiros_sugeridos: parceirosSugeridos, parceiro_em_foco: null, topico_atual: entidades?.category || null })
        .eq("id", idDaConversa);
    } catch { /* segue */ }

    return { respostaFinal, parceirosSugeridos };
  } else {
    const respostaFinal = await gerarRespostaGeral(textoDoUsuario, historicoGemini, regiao);
    return { respostaFinal, parceirosSugeridos: [] };
  }
}

// ============================================================================
// ROTA DE CHAT (com guardrails aplicados)
// ============================================================================
aplicacaoExpress.post("/api/chat/:slugDaRegiao", async (requisicao, resposta) => {
  try {
    const { slugDaRegiao } = requisicao.params;
    let { message: textoDoUsuario, conversationId: idDaConversa } = requisicao.body || {};

    if (!textoDoUsuario || typeof textoDoUsuario !== "string" || !textoDoUsuario.trim()) {
      return resposta.status(400).json({ error: "O campo 'message' é obrigatório e deve ser uma string não vazia." });
    }
    textoDoUsuario = textoDoUsuario.trim();

    const { data: regiao, error: erroRegiao } = await supabase
      .from("regioes")
      .select("id, nome, slug, ativo")
      .eq("slug", slugDaRegiao)
      .single();
    if (erroRegiao || !regiao) return resposta.status(404).json({ error: "Região não encontrada." });
    if (regiao.ativo === false) return resposta.status(403).json({ error: "Região desativada." });

    const { data: cidades, error: erroCidades } = await supabase
      .from("cidades")
      .select("id, nome, slug, lat, lng, ativo")
      .eq("regiao_id", regiao.id);
    if (erroCidades) return resposta.status(500).json({ error: "Erro ao carregar cidades.", internal: erroCidades });
    const cidadesAtivas = (cidades || []).filter(c => c.ativo !== false);

    if (!idDaConversa || typeof idDaConversa !== "string" || !idDaConversa.trim()) {
      idDaConversa = randomUUID();
      try {
        await supabase.from("conversas").insert({
          id: idDaConversa,
          regiao_id: regiao.id,
          parceiro_em_foco: null,
          parceiros_sugeridos: [],
          ultima_pergunta_usuario: null,
          ultima_resposta_ia: null,
          preferencia_indicacao: null,
          topico_atual: null
        });
      } catch (e) {
        return resposta.status(500).json({ error: "Erro ao criar conversa.", internal: e });
      }
    }

    let conversaAtual = null;
    try {
      const { data: conv } = await supabase
        .from("conversas")
        .select("id, parceiro_em_foco, preferencia_indicacao, topico_atual, parceiros_sugeridos")
        .eq("id", idDaConversa)
        .maybeSingle();
      conversaAtual = conv || null;
    } catch { /* segue */ }

    const historicoGemini = await construirHistoricoParaGemini(idDaConversa, 12);

    const candidatosDaConversa = Array.isArray(conversaAtual?.parceiros_sugeridos) ? conversaAtual.parceiros_sugeridos : [];
    const parceiroSelecionado = encontrarParceiroNaLista(textoDoUsuario, candidatosDaConversa);
    if (parceiroSelecionado) {
      try {
        await supabase
          .from("conversas")
          .update({ parceiro_em_foco: parceiroSelecionado, parceiros_sugeridos: candidatosDaConversa })
          .eq("id", idDaConversa);
      } catch { /* segue */ }

      const respostaCurta = await gerarRespostaComParceiros(
        textoDoUsuario,
        historicoGemini,
        [parceiroSelecionado],
        regiao?.nome
      );

      const respostaCurtaSegura = finalizeAssistantResponse({
        modelResponseText: respostaCurta,
        foundPartnersList: [parceiroSelecionado]
      });

      let idDaInteracaoSalvaSel = null;
      try {
        const { data: novaInteracaoSel } = await supabase
          .from("interacoes")
          .insert({
            regiao_id: regiao.id,
            conversation_id: idDaConversa,
            pergunta_usuario: textoDoUsuario,
            resposta_ia: respostaCurtaSegura,
            parceiros_sugeridos: [parceiroSelecionado]
          })
          .select("id")
          .single();
        idDaInteracaoSalvaSel = novaInteracaoSel?.id || null;
      } catch (erro) {
        console.warn("[INTERACOES] Falha ao salvar interação (seleção):", erro?.message || erro);
      }

      const fotosDosParceiros = [parceiroSelecionado].flatMap(p => p?.fotos_parceiros || []).filter(Boolean);
      return resposta.status(200).json({
        reply: respostaCurtaSegura,
        interactionId: idDaInteracaoSalvaSel,
        photoLinks: fotosDosParceiros,
        conversationId: idDaConversa,
        intent: "follow_up_parceiro",
        partners: [parceiroSelecionado]
      });
    }

    const intent = await analisarIntencaoDoUsuario(textoDoUsuario);
    let respostaFinal = "";
    let parceirosSugeridos = [];

    switch (intent) {
      case "busca_parceiro": {
        const resultado = await lidarComNovaBusca({
          textoDoUsuario,
          historicoGemini,
          regiao,
          cidadesAtivas,
          idDaConversa
        });
        respostaFinal = resultado.respostaFinal;
        parceirosSugeridos = resultado.parceirosSugeridos;
        break;
      }

      case "follow_up_parceiro": {
        const parceiroEmFoco = conversaAtual?.parceiro_em_foco || null;
        if (parceiroEmFoco) {
          respostaFinal = await gerarRespostaComParceiros(textoDoUsuario, historicoGemini, [parceiroEmFoco], regiao?.nome);
          parceirosSugeridos = [parceiroEmFoco];
        } else {
          const resultado = await lidarComNovaBusca({
            textoDoUsuario,
            historicoGemini,
            regiao,
            cidadesAtivas,
            idDaConversa
          });
          respostaFinal = resultado.respostaFinal;
          parceirosSugeridos = resultado.parceirosSugeridos;
        }
        break;
      }

      case "pergunta_geral":
      case "mudanca_contexto": {
        respostaFinal = await gerarRespostaGeral(textoDoUsuario, historicoGemini, regiao);
        try {
          await supabase.from("conversas").update({ parceiro_em_foco: null }).eq("id", idDaConversa);
        } catch { /* segue */ }
        break;
      }

      case "small_talk": {
        respostaFinal = "Olá! Sou o BEPIT, seu concierge na Região dos Lagos. O que você gostaria de fazer hoje?";
        break;
      }

      default: {
        respostaFinal = "Não entendi muito bem. Você poderia reformular sua pergunta?";
        break;
      }
    }

    if (!respostaFinal) {
      respostaFinal = "Posso ajudar com roteiros, transporte, passeios, praias e onde comer. O que você gostaria de saber?";
    }

    const respostaFinalSegura = finalizeAssistantResponse({
      modelResponseText: respostaFinal,
      foundPartnersList: Array.isArray(parceirosSugeridos) ? parceirosSugeridos : []
    });

    let idDaInteracaoSalva = null;
    try {
      const { data: novaInteracao, error: erroDeInsert } = await supabase
        .from("interacoes")
        .insert({
          regiao_id: regiao.id,
          conversation_id: idDaConversa,
          pergunta_usuario: textoDoUsuario,
          resposta_ia: respostaFinalSegura,
          parceiros_sugeridos: parceirosSugeridos
        })
        .select("id")
        .single();
      if (erroDeInsert) throw erroDeInsert;
      idDaInteracaoSalva = novaInteracao?.id || null;
    } catch (erro) {
      console.warn("[INTERACOES] Falha ao salvar interação:", erro?.message || erro);
    }

    const fotosDosParceiros = (parceirosSugeridos || []).flatMap(p => p?.fotos_parceiros || []).filter(Boolean);

    return resposta.status(200).json({
      reply: respostaFinalSegura,
      interactionId: idDaInteracaoSalva,
      photoLinks: fotosDosParceiros,
      conversationId: idDaConversa,
      intent,
      partners: parceirosSugeridos
    });
  } catch (erro) {
    console.error("[/api/chat/:slugDaRegiao] Erro:", erro);
    return resposta.status(500).json({ error: "Erro interno no servidor do BEPIT.", internal: { message: String(erro?.message || erro) } });
  }
});

// ============================================================================
// FEEDBACK
// ============================================================================
aplicacaoExpress.post("/api/feedback", async (requisicao, resposta) => {
  try {
    const { interactionId, feedback } = requisicao.body || {};
    if (!interactionId || typeof interactionId !== "string") {
      return resposta.status(400).json({ error: "interactionId é obrigatório (uuid)." });
    }
    if (!feedback || typeof feedback !== "string" || !feedback.trim()) {
      return resposta.status(400).json({ error: "feedback é obrigatório (string não vazia)." });
    }
    const { error } = await supabase
      .from("interacoes")
      .update({ feedback_usuario: feedback })
      .eq("id", interactionId);
    if (error) return resposta.status(500).json({ error: "Erro ao registrar feedback." });

    try {
      await supabase.from("eventos_analytics").insert({
        tipo_evento: "feedback",
        payload: { interactionId, feedback }
      });
    } catch { /* segue */ }

    resposta.json({ success: true });
  } catch (erro) {
    console.error("[/api/feedback] Erro:", erro);
    resposta.status(500).json({ error: "Erro interno." });
  }
});

// ============================================================================
// AUTH + ADMIN
// ============================================================================
aplicacaoExpress.post("/api/auth/login", async (req, res) => {
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
  } catch (erro) {
    console.error("[/api/auth/login] Erro:", erro);
    return res.status(500).json({ error: "server_error" });
  }
});

aplicacaoExpress.post("/api/admin/login", async (requisicao, resposta) => {
  try {
    const { username, password } = requisicao.body || {};
    const usuarioValido = username && username === process.env.ADMIN_USER;
    const senhaValida = password && password === process.env.ADMIN_PASS;

    if (!usuarioValido || !senhaValida) return resposta.status(401).json({ error: "Credenciais inválidas." });

    return resposta.json({ ok: true, adminKey: process.env.ADMIN_API_KEY });
  } catch (erro) {
    console.error("[/api/admin/login] Erro:", erro);
    return resposta.status(500).json({ error: "Erro interno." });
  }
});

function exigirChaveDeAdministrador(requisicao, resposta, proximo) {
  const chave = requisicao.headers["x-admin-key"];
  if (!chave || chave !== (process.env.ADMIN_API_KEY || "")) {
    return resposta.status(401).json({ error: "Chave administrativa inválida ou ausente." });
  }
  proximo();
}

aplicacaoExpress.post("/api/admin/parceiros", exigirChaveDeAdministrador, async (requisicao, resposta) => {
  try {
    const corpo = requisicao.body || {};
    const { regiaoSlug, cidadeSlug, ...restante } = corpo;

    const { data: regiao, error: erroReg } = await supabase
      .from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (erroReg || !regiao) return resposta.status(400).json({ error: "regiaoSlug inválido." });

    const { data: cidade, error: erroCid } = await supabase
      .from("cidades").select("id").eq("regiao_id", regiao.id).eq("slug", cidadeSlug).single();
    if (erroCid || !cidade) return resposta.status(400).json({ error: "cidadeSlug inválido." });

    const novoRegistro = {
      cidade_id: cidade.id,
      tipo: restante.tipo || "PARCEIRO",
      nome: restante.nome,
      descricao: restante.descricao || null,
      categoria: restante.categoria || null,
      beneficio_bepit: restante.beneficio_bepit || null,
      endereco: restante.endereco || null,
      contato: restante.contato || null,
      tags: Array.isArray(restante.tags) ? restante.tags : null,
      horario_funcionamento: restante.horario_funcionamento || null,
      faixa_preco: restante.faixa_preco || null,
      fotos_parceiros: Array.isArray(restante.fotos_parceiros) ? restante.fotos_parceiros : (Array.isArray(restante.fotos) ? restante.fotos : null),
      ativo: restante.ativo !== false
    };

    const { data, error } = await supabase.from("parceiros").insert(novoRegistro).select("*").single();
    if (error) {
      console.error("[/api/admin/parceiros] Insert Erro:", error);
      return resposta.status(500).json({ error: "Erro ao criar parceiro/dica." });
    }

    return resposta.status(200).json({ ok: true, data });
  } catch (erro) {
    console.error("[/api/admin/parceiros] Erro:", erro);
    return resposta.status(500).json({ error: "Erro interno." });
  }
});

aplicacaoExpress.get("/api/admin/parceiros/:regiaoSlug/:cidadeSlug", exigirChaveDeAdministrador, async (requisicao, resposta) => {
  try {
    const { regiaoSlug, cidadeSlug } = requisicao.params;

    const { data: regiao, error: erroReg } = await supabase.from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (erroReg || !regiao) return resposta.status(400).json({ error: "regiaoSlug inválido." });

    const { data: cidade, error: erroCid } = await supabase
      .from("cidades").select("id").eq("regiao_id", regiao.id).eq("slug", cidadeSlug).single();
    if (erroCid || !cidade) return resposta.status(400).json({ error: "cidadeSlug inválido." });

    const { data, error } = await supabase.from("parceiros").select("*").eq("cidade_id", cidade.id).order("nome");
    if (error) {
      console.error("[/api/admin/parceiros list] Erro:", error);
      return resposta.status(500).json({ error: "Erro ao listar parceiros/dicas." });
    }

    return resposta.status(200).json({ data });
  } catch (erro) {
    console.error("[/api/admin/parceiros list] Erro:", erro);
    return resposta.status(500).json({ error: "Erro interno." });
  }
});

aplicacaoExpress.post("/api/admin/regioes", exigirChaveDeAdministrador, async (requisicao, resposta) => {
  try {
    const { nome, slug, ativo = true } = requisicao.body || {};
    if (!nome || !slug) return resposta.status(400).json({ error: "Campos 'nome' e 'slug' são obrigatórios." });

    const { data, error } = await supabase.from("regioes").insert({ nome, slug, ativo: Boolean(ativo) }).select("*").single();
    if (error) {
      console.error("[/api/admin/regioes] Insert Erro:", error);
      return resposta.status(500).json({ error: "Erro ao criar região." });
    }

    resposta.json({ ok: true, data });
  } catch (erro) {
    console.error("[/api/admin/regioes] Erro:", erro);
    resposta.status(500).json({ error: "Erro interno." });
  }
});

aplicacaoExpress.post("/api/admin/cidades", exigirChaveDeAdministrador, async (requisicao, resposta) => {
  try {
    const { regiaoSlug, nome, slug, ativo = true, lat = null, lng = null } = requisicao.body || {};
    if (!regiaoSlug || !nome || !slug) return resposta.status(400).json({ error: "Campos 'regiaoSlug', 'nome' e 'slug' são obrigatórios." });

    const { data: regiao, error: erroReg } = await supabase.from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (erroReg || !regiao) return resposta.status(400).json({ error: "regiaoSlug inválido." });

    const { data, error } = await supabase
      .from("cidades")
      .insert({ regiao_id: regiao.id, nome, slug, ativo: Boolean(ativo), lat: lat === null ? null : Number(lat), lng: lng === null ? null : Number(lng) })
      .select("*")
      .single();
    if (error) {
      console.error("[/api/admin/cidades] Insert Erro:", error);
      return resposta.status(500).json({ error: "Erro ao criar cidade." });
    }

    resposta.json({ ok: true, data });
  } catch (erro) {
    console.error("[/api/admin/cidades] Erro:", erro);
    resposta.status(500).json({ error: "Erro interno." });
  }
});

aplicacaoExpress.get("/api/admin/metrics/summary", exigirChaveDeAdministrador, async (requisicao, resposta) => {
  try {
    const { regiaoSlug, cidadeSlug } = requisicao.query;
    if (!regiaoSlug) return resposta.status(400).json({ error: "O parâmetro 'regiaoSlug' é obrigatório." });

    const { data: regiao, error: erroReg } = await supabase
      .from("regioes")
      .select("id, nome, slug")
      .eq("slug", regiaoSlug)
      .single();
    if (erroReg || !regiao) return resposta.status(404).json({ error: "Região não encontrada." });

    const { data: cidades, error: erroCid } = await supabase
      .from("cidades")
      .select("id, nome, slug")
      .eq("regiao_id", regiao.id);
    if (erroCid) return resposta.status(500).json({ error: "Erro ao carregar cidades." });

    let cidade = null;
    let listaDeIdsDeCidades = (cidades || []).map((c) => c.id);
    if (cidadeSlug) {
      cidade = (cidades || []).find((c) => c.slug === cidadeSlug) || null;
      if (!cidade) return resposta.status(404).json({ error: "Cidade não encontrada nesta região." });
      listaDeIdsDeCidades = [cidade.id];
    }

    const { data: parceirosAtivos, error: erroParc } = await supabase
      .from("parceiros")
      .select("id")
      .eq("ativo", true)
      .in("cidade_id", listaDeIdsDeCidades);
    if (erroParc) return resposta.status(500).json({ error: "Erro ao contar parceiros." });

    const { data: buscas, error: erroBus } = await supabase
      .from("buscas_texto")
      .select("id, cidade_id, regiao_id")
      .eq("regiao_id", regiao.id);
    if (erroBus) return resposta.status(500).json({ error: "Erro ao contar buscas." });
    const totalDeBuscas = (buscas || []).filter((b) => (cidade ? b.cidade_id === cidade.id : true)).length;

    const { data: interacoes, error: erroInt } = await supabase
      .from("interacoes")
      .select("id, regiao_id")
      .eq("regiao_id", regiao.id);
    if (erroInt) return resposta.status(500).json({ error: "Erro ao contar interações." });
    const totalDeInteracoes = (interacoes || []).length;

    const { data: registrosDeViews, error: erroViews } = await supabase
      .from("parceiro_views")
      .select("parceiro_id, views_total, last_view_at")
      .order("views_total", { ascending: false })
      .limit(50);
    if (erroViews) return resposta.status(500).json({ error: "Erro ao ler views." });

    const listaDeIdsDeParceiros = Array.from(new Set((registrosDeViews || []).map((v) => v.parceiro_id)));
    const { data: informacoesDosParceiros } = await supabase
      .from("parceiros")
      .select("id, nome, categoria, cidade_id")
      .in("id", listaDeIdsDeParceiros);

    const mapaParceiroPorId = new Map((informacoesDosParceiros || []).map((p) => [p.id, p]));
    const topCincoPorViews = (registrosDeViews || [])
      .filter((reg) => {
        const info = mapaParceiroPorId.get(reg.parceiro_id);
        if (!info) return false;
        const cidadesOk = cidade ? info.cidade_id === cidade.id : listaDeIdsDeCidades.includes(info.cidade_id);
        return cidadesOk;
      })
      .slice(0, 5)
      .map((reg) => {
        const info = mapaParceiroPorId.get(reg.parceiro_id);
        return {
          parceiro_id: reg.parceiro_id,
          nome: info?.nome || "—",
          categoria: info?.categoria || "—",
          views_total: reg.views_total,
          last_view_at: reg.last_view_at
        };
      });

    return resposta.json({
      regiao: { id: regiao.id, nome: regiao.nome, slug: regiao.slug },
      cidade: cidade ? { id: cidade.id, nome: cidade.nome, slug: cidade.slug } : null,
      total_parceiros_ativos: (parceirosAtivos || []).length,
      total_buscas: totalDeBuscas,
      total_interacoes: totalDeInteracoes,
      top5_parceiros_por_views: topCincoPorViews
    });
  } catch (erro) {
    console.error("[/api/admin/metrics/summary] Erro:", erro);
    resposta.status(500).json({ error: "Erro interno." });
  }
});

aplicacaoExpress.get("/api/admin/logs", exigirChaveDeAdministrador, async (requisicao, resposta) => {
  try {
    const {
      tipo,
      regiaoSlug,
      cidadeSlug,
      parceiroId,
      conversationId,
      since,
      until,
      limit
    } = requisicao.query;

    let limite = Number(limit || 50);
    if (!Number.isFinite(limite) || limite <= 0) limite = 50;
    if (limite > 200) limite = 200;

    let regiaoId = null;
    let cidadeId = null;

    if (regiaoSlug) {
      const { data: regiao, error: erroReg } = await supabase
        .from("regioes")
        .select("id, slug")
        .eq("slug", String(regiaoSlug))
        .single();
      if (erroReg) {
        console.error("[/api/admin/logs] Erro ao buscar região:", erroReg);
        return resposta.status(500).json({ error: "Erro ao buscar região." });
      }
      if (!regiao) return resposta.status(404).json({ error: "Região não encontrada." });
      regiaoId = regiao.id;
    }

    if (cidadeSlug && regiaoId) {
      const { data: cidade, error: erroCid } = await supabase
        .from("cidades")
        .select("id, slug, regiao_id")
        .eq("slug", String(cidadeSlug))
        .eq("regiao_id", regiaoId)
        .single();
      if (erroCid) {
        console.error("[/api/admin/logs] Erro ao buscar cidade:", erroCid);
        return resposta.status(500).json({ error: "Erro ao buscar cidade." });
      }
      if (!cidade) return resposta.status(404).json({ error: "Cidade não encontrada nesta região." });
      cidadeId = cidade.id;
    }

    let consulta = supabase
      .from("eventos_analytics")
      .select("id, created_at, regiao_id, cidade_id, parceiro_id, conversation_id, tipo_evento, payload")
      .order("created_at", { ascending: false })
      .limit(limite);

    if (tipo) consulta = consulta.eq("tipo_evento", String(tipo));
    if (regiaoId) consulta = consulta.eq("regiao_id", regiaoId);
    if (cidadeId) consulta = consulta.eq("cidade_id", cidadeId);
    if (parceiroId) consulta = consulta.eq("parceiro_id", String(parceiroId));
    if (conversationId) consulta = consulta.eq("conversation_id", String(conversationId));
    if (since) consulta = consulta.gte("created_at", String(since));
    if (until) consulta = consulta.lte("created_at", String(until));

    const { data, error } = await consulta;
    if (error) {
      console.error("[/api/admin/logs] Erro Supabase:", error);
      return resposta.status(500).json({ error: "Erro ao consultar logs." });
    }

    return resposta.json({ data });
  } catch (erro) {
    console.error("[/api/admin/logs] Erro inesperado:", erro);
    return resposta.status(500).json({ error: "Erro interno." });
  }
});

// ------------------------ INICIAR SERVIDOR ----------------------------------
aplicacaoExpress.listen(portaDoServidor, () => {
  console.log(`✅ BEPIT Nexus (Orquestrador v3.3 REST) rodando em http://localhost:${portaDoServidor}`);
});
