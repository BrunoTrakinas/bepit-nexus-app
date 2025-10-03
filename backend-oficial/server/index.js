// ============================================================================
// BEPIT Nexus - Servidor (Express) — Orquestrador Lógico v3.5 (REST Gemini)
// - Anti-alucinação e priorização de parceiros
// - Novas intenções: planejamento_viagem (1-20 dias) e pedido_beneficio
// - DIFERENCIAÇÃO GASTRONOMIA x PASSEIO: perguntas sobre comer => só restaurantes/bars/etc.
// - Admin completo: POST/GET/PUT parceiros, regiões, cidades, métricas e logs
// ============================================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { supabase } from "../lib/supabaseClient.js";
import {
  finalizeAssistantResponse,
  buildNoPartnerFallback,
  BEPIT_SYSTEM_PROMPT_APPENDIX
} from "../utils/bepitGuardrails.js";

// ============================== CONFIGURAÇÃO BÁSICA =========================
const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json({ limit: "2mb" }));

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

app.use(
  cors({
    origin: (origin, cb) =>
      origemPermitida(origin) ? cb(null, true) : cb(new Error("CORS: origem não permitida.")),
    credentials: true,
    allowedHeaders: ["Content-Type", "x-admin-key", "authorization"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  })
);
app.options("*", cors());

// ============================================================================
// GEMINI (REST v1)
// ============================================================================

const usarGeminiREST = String(process.env.USE_GEMINI_REST || "") === "1";
const chaveGemini = process.env.GEMINI_API_KEY || "";

function stripModelsPrefix(id) {
  return String(id || "").replace(/^models\//, "");
}

async function listarModelosREST() {
  if (!chaveGemini) throw new Error("[GEMINI REST] GEMINI_API_KEY não definida.");
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
  const todosComPrefixo = await listarModelosREST(); // ex: ["models/gemini-2.5-flash", ...]
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

  for (const alvo of preferencia) if (disponiveisSimples.includes(alvo)) return alvo;

  const qualquerGemini = disponiveisSimples.find(n => /^gemini-/.test(n));
  if (qualquerGemini) return qualquerGemini;

  throw new Error("[GEMINI REST] Não foi possível selecionar um modelo v1.");
}

async function gerarConteudoComREST(modelo, texto) {
  if (!chaveGemini) throw new Error("[GEMINI REST] GEMINI_API_KEY não definida.");
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
// *** DIFERENCIAÇÃO GASTRONOMIA x PASSEIO ***
// ============================================================================

const FOOD_KEYWORDS = [
  "comer", "almoçar", "almocar", "jantar", "almoço", "almoco", "peixe", "picanha",
  "rodizio", "rodízio", "pizza", "sushi", "japa", "massas", "hamburger", "hamburguer",
  "restaurante", "onde almoçar", "onde jantar", "onde comer", "onde almocar"
];

const FOOD_CATEGORIES = [
  "restaurante", "restaurantes", "pizzaria", "churrascaria", "peixaria", "sushi",
  "japonês", "japones", "bistrô", "bistro", "hamburgueria", "gastronomia",
  "massas", "italiano", "frutos do mar", "mariscos", "rodízio", "rodizio", "churras"
];

const TOUR_KEYWORDS = [
  "praia", "trilha", "passeio", "ilha", "boat", "lancha", "gruta", "mirante", "mergulho"
];

function isFoodQuery(text) {
  const s = normalizarTexto(text || "");
  return FOOD_KEYWORDS.some(k => s.includes(normalizarTexto(k)));
}

function isTourQuery(text) {
  const s = normalizarTexto(text || "");
  return TOUR_KEYWORDS.some(k => s.includes(normalizarTexto(k)));
}

function isFoodCategory(cat) {
  const c = normalizarTexto(cat || "");
  if (!c) return false;
  return FOOD_CATEGORIES.some(k => c.includes(normalizarTexto(k)));
}

function isTourCategory(cat) {
  const c = normalizarTexto(cat || "");
  if (!c) return false;
  return ["praia", "trilha", "passeio", "mergulho", "boat", "lancha", "gruta", "ilha"].some(k => c.includes(k));
}

// ============================================================================
// FERRAMENTAS (busca parceiros; distancia; preferências)
// ============================================================================

async function ferramentaBuscarParceirosOuDicas({ cidadesAtivas, argumentosDaFerramenta, strictFoodMode = false }) {
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

  // Filtro semântico por termos
  if (listaDeTermos.length > 0) {
    const termosNormalizados = listaDeTermos.map((termo) => normalizarTexto(termo));
    itens = itens.filter((parc) => {
      const nomeNormalizado = normalizarTexto(parc.nome);
      const categoriaNormalizada = normalizarTexto(parc.categoria || "");
      const listaDeTags = Array.isArray(parc.tags) ? parc.tags.map((x) => normalizarTexto(String(x))) : [];
      return termosNormalizados.some((termo) => nomeNormalizado.includes(termo) || categoriaNormalizada.includes(termo) || listaDeTags.includes(termo));
    });
  }

  // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
  // FILTRO ESTRITO DE GASTRONOMIA: quando é pergunta de comida, removemos
  // tudo que não for categoria de alimentação e também removemos DICA.
  // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
  if (strictFoodMode) {
    itens = itens.filter(p =>
      p.tipo !== "DICA" &&
      isFoodCategory(p.categoria || "")
    );
  }

  // Ordena priorizando PARCEIRO sobre DICA
  itens.sort((a, b) => (a.tipo === "DICA" ? 1 : 0) - (b.tipo === "DICA" ? 1 : 0));
  const itensLimitados = itens.slice(0, 20); // aumenta para roteiros

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
      cidade_id: p.cidade_id,
      tags: Array.isArray(p.tags) ? p.tags : []
    }))
  };
}

async function ferramentaObterRotaOuDistanciaAproximada({ argumentosDaFerramenta, cidadesAtivas }) {
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
// HEALTHCHECKS E DIAGNÓSTICO
// ============================================================================

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
    res.json({ ok: true, sample: data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_error", internal: e });
  }
});

app.get("/api/diag/gemini", async (_req, res) => {
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

// ============================================================================
// CÉREBRO / PROMPTS E EXTRAÇÕES
// ============================================================================

async function analisarIntencaoDoUsuario(textoDoUsuario) {
  const prompt = `Classifique a frase do usuário em UMA categoria:
- 'busca_parceiro' (buscar lugares/estabelecimentos)
- 'follow_up_parceiro' (continuação sobre item sugerido)
- 'pergunta_geral' (curiosidades, clima, "o que fazer")
- 'mudanca_contexto' (troca de assunto)
- 'small_talk' (saudação/bate-papo)
- 'planejamento_viagem' (roteiro, X dias, dia a dia)
- 'pedido_beneficio' (desconto, bônus, benefício, parceria, vantagem)
Responda apenas a string.
Frase: "${textoDoUsuario}"`;
  const saida = await geminiGerarTexto(prompt);
  const text = (saida || "").trim().toLowerCase();
  const classes = new Set([
    "busca_parceiro",
    "follow_up_parceiro",
    "pergunta_geral",
    "mudanca_contexto",
    "small_talk",
    "planejamento_viagem",
    "pedido_beneficio"
  ]);
  return classes.has(text) ? text : "pergunta_geral";
}

async function extrairEntidadesDaBusca(texto) {
  const prompt = `Extraia entidades de busca para parceiros no formato JSON estrito (sem comentários).
Campos: {"category": string|null, "city": string|null, "terms": string[]}
- "category" deve ser algo como restaurante, passeio, hotel, bar, transfer, mergulho, pizzaria, etc.
- "city" se houver menção explícita.
- "terms" são adjetivos/necessidades: ["barato", "crianças", "vista para o mar", "pet friendly", etc]
Seja flexível com erros de digitação e abreviações.
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

// --------- NOVAS EXTRAÇÕES (DIAS/ROTEIRO e BENEFÍCIO) -----------------------

function extrairDiasDaFrase(t) {
  const s = normalizarTexto(String(t || ""));
  const m = s.match(/(\d{1,2})\s*(dias?|d|noites?)/);
  const n = m ? Number(m[1]) : null;
  if (!n || n < 1) return null;
  return Math.min(n, 20);
}

async function extrairParametrosRoteiro(texto) {
  const prompt = `Extraia JSON {"city": string|null, "interests": string[]}
- "city": cidade mencionada (Búzios, Cabo Frio, Arraial do Cabo), se houver.
- "interests": palavras soltas (praias, barco, gastronomia, família, casais, mergulho, trilha, compras, balada, etc.)
Responda apenas o JSON.
Frase: "${texto}"`;
  try {
    const bruto = await geminiGerarTexto(prompt);
    const parsed = JSON.parse(bruto);
    const city = typeof parsed.city === "string" && parsed.city.trim() ? parsed.city.trim() : null;
    const interests = Array.isArray(parsed.interests) ? parsed.interests.filter(x => typeof x === "string" && x.trim()).map(x => x.trim()) : [];
    const days = extrairDiasDaFrase(texto);
    return { city, interests, days };
  } catch {
    return { city: null, interests: [], days: extrairDiasDaFrase(texto) };
  }
}

async function extrairPedidoBeneficio(texto) {
  const prompt = `Extraia JSON {"city": string|null, "category": string|null}
- "city": cidade citada ou nula
- "category": restaurante, bar, passeio, hotel etc. ou nula
Responda apenas o JSON.
Frase: "${texto}"`;
  try {
    const bruto = await geminiGerarTexto(prompt);
    const parsed = JSON.parse(bruto);
    const city = typeof parsed.city === "string" && parsed.city.trim() ? parsed.city.trim() : null;
    const category = typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim() : null;
    return { city, category };
  } catch {
    return { city: null, category: null };
  }
}

// ------------------- GUARDRAILS DE RESPOSTA (PROMPTS) -----------------------

async function gerarRespostaComParceiros(pergunta, historicoContents, parceiros, regiaoNome = "") {
  const historicoTexto = historicoParaTextoSimples(historicoContents);
  const contextoParceiros = JSON.stringify(parceiros ?? [], null, 2);
  const prompt = [
    "Você é o BEPIT, um concierge especialista.",
    "Responda baseando-se EXCLUSIVAMENTE no [Contexto] de parceiros cadastrados (nomes, endereço, descrição, benefício).",
    "Se o usuário perguntar por 'benefício/desconto', mencione somente o que existir no campo 'beneficio_bepit'. Se não houver, deixe claro que no momento não há benefício cadastrado.",
    "Não invente nomes, endereços ou promoções. Não use linguagem de parceria/venda; use tom de 'indicação'.",
    "SE a pergunta for sobre COMER/ALMOÇAR/JANTAR, liste APENAS itens de gastronomia (restaurantes, pizzarias, churrascarias, sushi etc.). NUNCA liste praias, trilhas, passeios ou 'DICA' nesse caso.",
    "Se a pergunta comparar ('todos servem peixe?'), analise cada item e responda objetivamente, sem repetir a lista inteira sem análise.",
    "",
    BEPIT_SYSTEM_PROMPT_APPENDIX,
    "",
    `[Contexto]: ${contextoParceiros}`,
    `[Histórico]:\n${historicoTexto}`,
    `[Região]: ${regiaoNome}`,
    `[Pergunta]: "${pergunta}"`
  ].join("\n");
  return await geminiGerarTexto(prompt);
}

async function gerarRespostaGeral(pergunta, historicoContents, regiao) {
  const historicoTexto = historicoParaTextoSimples(historicoContents);
  const nomeRegiao = regiao?.nome || "Região dos Lagos";
  const prompt = [
    `Você é o BEPIT, um concierge amigável da região de ${nomeRegiao}.`,
    "Dê dicas úteis sem inventar nomes/endereços. Evite linguagem de parceria.",
    "",
    BEPIT_SYSTEM_PROMPT_APPENDIX,
    "",
    `[Histórico]:\n${historicoTexto}`,
    `[Pergunta]: "${pergunta}"`
  ].join("\n");
  return await geminiGerarTexto(prompt);
}

// ============================================================================
// AJUDANTES DE BENEFÍCIO E ROTEIRO
// ============================================================================

function parceiroTemBeneficio(p) {
  const b = (p?.beneficio_bepit || "").trim();
  return Boolean(b);
}

function filtrarParceirosComBeneficio(parceiros, { category = null } = {}) {
  let base = (parceiros || []).filter(parceiroTemBeneficio);
  if (category) {
    const catN = normalizarTexto(category);
    base = base.filter(p => normalizarTexto(p.categoria || "").includes(catN));
  }
  return base;
}

function agruparParceiros(parceiros) {
  const out = {
    restaurantes: [],
    bares: [],
    hospedagem: [],
    passeios: [],
    aluguel_carro: [],
    outros: []
  };
  for (const p of parceiros || []) {
    const cat = normalizarTexto(p?.categoria || "");
    if (cat.includes("hotel") || cat.includes("pousada") || cat.includes("hosped")) {
      out.hospedagem.push(p);
    } else if (cat.includes("bar")) {
      out.bares.push(p);
    } else if (cat.includes("rest") || cat.includes("pizz") || cat.includes("churr") || cat.includes("sushi") || cat.includes("hamburg")) {
      out.restaurantes.push(p);
    } else if (cat.includes("passeio") || cat.includes("boat") || cat.includes("lancha") || cat.includes("trilha") || cat.includes("mergulho") || cat.includes("praia")) {
      out.passeios.push(p);
    } else if (cat.includes("carro") || cat.includes("aluguel") || cat.includes("locadora")) {
      out.aluguel_carro.push(p);
    } else {
      out.outros.push(p);
    }
  }
  return out;
}

function ordenarPorBeneficioPrimeiro(arr) {
  return [...(arr || [])].sort((a, b) => {
    const A = parceiroTemBeneficio(a) ? 0 : 1;
    const B = parceiroTemBeneficio(b) ? 0 : 1;
    return A - B;
  });
}

function pickCycling(list, i) {
  if (!list?.length) return null;
  return list[i % list.length];
}

function montarItinerario(dias, parceiros, interesses = []) {
  const g = agruparParceiros(parceiros);
  const R = ordenarPorBeneficioPrimeiro(g.restaurantes);
  const B = ordenarPorBeneficioPrimeiro(g.bares);
  const H = ordenarPorBeneficioPrimeiro(g.hospedagem);
  const P = ordenarPorBeneficioPrimeiro(g.passeios);
  const C = ordenarPorBeneficioPrimeiro(g.aluguel_carro);

  const plano = [];
  for (let d = 0; d < dias; d++) {
    const manha = pickCycling(P, d) || pickCycling(g.outros, d);
    const tarde = pickCycling(P, d + 1) || pickCycling(g.outros, d + 1);
    const noiteRest = pickCycling(R, d) || pickCycling(R, d + 1);
    const noiteBar = pickCycling(B, d) || null;

    const hospedagemDia1 = d === 0 ? (H[0] || null) : null;
    const carroDia1 = d === 0 ? (C[0] || null) : null;

    plano.push({
      dia: d + 1,
      manha: manha ? { tipo: "passeio", ...manha } : null,
      tarde: tarde ? { tipo: "passeio", ...tarde } : null,
      noite: [noiteRest, noiteBar].filter(Boolean).map(x => ({ tipo: "gastronomia", ...x })),
      hospedagem: hospedagemDia1,
      aluguel: carroDia1
    });
  }
  return plano;
}

async function gerarRoteiroViagem(pergunta, historicoContents, regiaoNome, dias, plano) {
  const historicoTexto = historicoParaTextoSimples(historicoContents);
  const contextoPlano = JSON.stringify(plano ?? [], null, 2);
  const prompt = [
    "Você é o BEPIT, concierge especialista em roteiros na Região dos Lagos.",
    `Monte um roteiro claro, para ${dias} dia(s), com blocos Manhã / Tarde / Noite.`,
    "Use SOMENTE os itens do [Plano] (parceiros e dicas cadastradas). Priorize os que têm benefício, mas não prometa nada além do campo 'beneficio_bepit'.",
    "Não invente nomes ou endereços. Se faltar algo, admita e ofereça buscar mais opções com o seu perfil.",
    "Tom neutro de 'indicação' (sem linguagem de parceria/venda).",
    "",
    BEPIT_SYSTEM_PROMPT_APPENDIX,
    "",
    `[Plano]: ${contextoPlano}`,
    `[Histórico]:\n${historicoTexto}`,
    `[Região]: ${regiaoNome}`,
    `[Pergunta]: "${pergunta}"`
  ].join("\n");
  return await geminiGerarTexto(prompt);
}

// ============================================================================
// FLUXOS DE ALTO NÍVEL
// ============================================================================

async function lidarComNovaBusca({ textoDoUsuario, historicoGemini, regiao, cidadesAtivas, idDaConversa }) {
  const entidades = await extrairEntidadesDaBusca(textoDoUsuario);

  // >>> heurística: se pergunta é de comida e não veio category, força "restaurante" e ativa strictFoodMode
  const foodIntent = isFoodQuery(textoDoUsuario) && !isTourQuery(textoDoUsuario);
  const categoryFinal = entidades.category || (foodIntent ? "restaurante" : "");
  const strictFoodMode = foodIntent || isFoodCategory(entidades.category || "");

  const resultadoBusca = await ferramentaBuscarParceirosOuDicas({
    cidadesAtivas,
    argumentosDaFerramenta: { ...entidades, category: categoryFinal },
    strictFoodMode
  });

  if (resultadoBusca?.ok && (resultadoBusca?.count || 0) > 0) {
    const parceirosSugeridos = resultadoBusca.items || [];
    const respostaModelo = await gerarRespostaComParceiros(textoDoUsuario, historicoGemini, parceirosSugeridos, regiao?.nome);
    const respostaFinal = finalizeAssistantResponse({
      modelResponseText: respostaModelo,
      foundPartnersList: parceirosSugeridos,
      mode: "partners"
    });

    try {
      await supabase
        .from("conversas")
        .update({ parceiros_sugeridos: parceirosSugeridos, parceiro_em_foco: null, topico_atual: entidades?.category || (foodIntent ? "restaurante" : null) })
        .eq("id", idDaConversa);
    } catch {}

    return { respostaFinal, parceirosSugeridos };
  } else {
    const respostaModelo = await gerarRespostaGeral(textoDoUsuario, historicoGemini, regiao);
    const respostaFinal = finalizeAssistantResponse({
      modelResponseText: respostaModelo,
      foundPartnersList: [],
      mode: "general"
    });
    return { respostaFinal, parceirosSugeridos: [] };
  }
}

async function lidarComPedidoBeneficio({ textoDoUsuario, historicoGemini, regiao, cidadesAtivas, idDaConversa }) {
  const { city, category } = await extrairPedidoBeneficio(textoDoUsuario);

  const foodIntent = isFoodQuery(textoDoUsuario) || isFoodCategory(category || "");
  const categoryFinal = category || (foodIntent ? "restaurante" : "");

  const resultadoBusca = await ferramentaBuscarParceirosOuDicas({
    cidadesAtivas,
    argumentosDaFerramenta: { category: categoryFinal || "", city: city || "", terms: [] },
    strictFoodMode: foodIntent
  });

  let parceiros = resultadoBusca?.items || [];
  parceiros = filtrarParceirosComBeneficio(parceiros, { category: categoryFinal || "" });

  const respostaModelo = await gerarRespostaComParceiros(
    textoDoUsuario,
    historicoGemini,
    parceiros,
    regiao?.nome
  );

  const respostaFinal = finalizeAssistantResponse({
    modelResponseText: respostaModelo,
    foundPartnersList: parceiros,
    mode: "partners",
    meta: { benefitsOnly: true }
  });

  try {
    await supabase
      .from("conversas")
      .update({
        parceiros_sugeridos: parceiros,
        parceiro_em_foco: null,
        topico_atual: "beneficios"
      })
      .eq("id", idDaConversa);
  } catch {}

  return { respostaFinal, parceirosSugeridos: parceiros };
}

async function lidarComPlanejamentoViagem({ textoDoUsuario, historicoGemini, regiao, cidadesAtivas, idDaConversa }) {
  const { city, interests, days } = await extrairParametrosRoteiro(textoDoUsuario);
  const dias = days || 4;

  const resultadoBusca = await ferramentaBuscarParceirosOuDicas({
    cidadesAtivas,
    argumentosDaFerramenta: { category: "", city: city || "", terms: interests || [] }
  });
  let parceiros = resultadoBusca?.items || [];

  const plano = montarItinerario(dias, parceiros, interests);

  const respostaModelo = await gerarRoteiroViagem(
    textoDoUsuario,
    historicoGemini,
    regiao?.nome || "Região dos Lagos",
    dias,
    plano
  );

  const respostaFinal = finalizeAssistantResponse({
    modelResponseText: respostaModelo,
    foundPartnersList: parceiros,
    mode: "partners",
    meta: { itinerary: true, days: dias }
  });

  try {
    await supabase
      .from("conversas")
      .update({
        parceiros_sugeridos: parceiros,
        parceiro_em_foco: null,
        topico_atual: "roteiro"
      })
      .eq("id", idDaConversa);
  } catch {}

  const fotos = plano.flatMap(dia => {
    const blocos = [];
    if (dia.manha?.fotos_parceiros) blocos.push(...dia.manha.fotos_parceiros);
    if (dia.tarde?.fotos_parceiros) blocos.push(...dia.tarde.fotos_parceiros);
    for (const n of (dia.noite || [])) {
      if (n?.fotos_parceiros) blocos.push(...n.fotos_parceiros);
    }
    if (dia.hospedagem?.fotos_parceiros) blocos.push(...dia.hospedagem.fotos_parceiros);
    return blocos;
  }).filter(Boolean);

  return { respostaFinal, parceirosSugeridos: parceiros, fotos };
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

// ============================================================================
// ROTA DE CHAT
// ============================================================================

app.post("/api/chat/:slugDaRegiao", async (req, res) => {
  try {
    const { slugDaRegiao } = req.params;
    let { message: textoDoUsuario, conversationId } = req.body || {};

    if (!textoDoUsuario || typeof textoDoUsuario !== "string" || !textoDoUsuario.trim()) {
      return res.status(400).json({ error: "O campo 'message' é obrigatório e deve ser uma string não vazia." });
    }
    textoDoUsuario = textoDoUsuario.trim();

    const { data: regiao, error: erroRegiao } = await supabase
      .from("regioes")
      .select("id, nome, slug, ativo")
      .eq("slug", slugDaRegiao)
      .single();
    if (erroRegiao || !regiao) return res.status(404).json({ error: "Região não encontrada." });
    if (regiao.ativo === false) return res.status(403).json({ error: "Região desativada." });

    const { data: cidades, error: erroCidades } = await supabase
      .from("cidades")
      .select("id, nome, slug, lat, lng, ativo")
      .eq("regiao_id", regiao.id);
    if (erroCidades) return res.status(500).json({ error: "Erro ao carregar cidades.", internal: erroCidades });
    const cidadesAtivas = (cidades || []).filter(c => c.ativo !== false);

    if (!conversationId || typeof conversationId !== "string" || !conversationId.trim()) {
      conversationId = randomUUID();
      try {
        await supabase.from("conversas").insert({
          id: conversationId,
          regiao_id: regiao.id,
          parceiro_em_foco: null,
          parceiros_sugeridos: [],
          ultima_pergunta_usuario: null,
          ultima_resposta_ia: null,
          preferencia_indicacao: null,
          topico_atual: null
        });
      } catch (e) {
        return res.status(500).json({ error: "Erro ao criar conversa.", internal: e });
      }
    }

    let conversaAtual = null;
    try {
      const { data: conv } = await supabase
        .from("conversas")
        .select("id, parceiro_em_foco, preferencia_indicacao, topico_atual, parceiros_sugeridos")
        .eq("id", conversationId)
        .maybeSingle();
      conversaAtual = conv || null;
    } catch {}

    const historicoGemini = await construirHistoricoParaGemini(conversationId, 12);

    // Seleção direta por "1º/2º" ou nome
    const candidatosDaConversa = Array.isArray(conversaAtual?.parceiros_sugeridos) ? conversaAtual.parceiros_sugeridos : [];
    const parceiroSelecionado = encontrarParceiroNaLista(textoDoUsuario, candidatosDaConversa);
    if (parceiroSelecionado) {
      try {
        await supabase
          .from("conversas")
          .update({ parceiro_em_foco: parceiroSelecionado, parceiros_sugeridos: candidatosDaConversa })
          .eq("id", conversationId);
      } catch {}

      const respostaModelo = await gerarRespostaComParceiros(
        textoDoUsuario,
        historicoGemini,
        [parceiroSelecionado],
        regiao?.nome
      );
      const respostaCurtaSegura = finalizeAssistantResponse({
        modelResponseText: respostaModelo,
        foundPartnersList: [parceiroSelecionado],
        mode: "partners"
      });

      let interactionId = null;
      try {
        const { data: nova } = await supabase
          .from("interacoes")
          .insert({
            regiao_id: regiao.id,
            conversation_id: conversationId,
            pergunta_usuario: textoDoUsuario,
            resposta_ia: respostaCurtaSegura,
            parceiros_sugeridos: [parceiroSelecionado]
          })
          .select("id")
          .single();
        interactionId = nova?.id || null;
      } catch (e) {
        console.warn("[INTERACOES] Falha ao salvar (seleção):", e?.message || e);
      }

      const fotos = [parceiroSelecionado].flatMap(p => p?.fotos_parceiros || []).filter(Boolean);
      return res.status(200).json({
        reply: respostaCurtaSegura,
        interactionId,
        photoLinks: fotos,
        conversationId,
        intent: "follow_up_parceiro",
        partners: [parceiroSelecionado]
      });
    }

    // Intenção
    const intent = await analisarIntencaoDoUsuario(textoDoUsuario);
    let respostaFinal = "";
    let parceirosSugeridos = [];
    let fotosExtras = [];

    switch (intent) {
      case "busca_parceiro": {
        const r = await lidarComNovaBusca({
          textoDoUsuario,
          historicoGemini,
          regiao,
          cidadesAtivas,
          idDaConversa: conversationId
        });
        respostaFinal = r.respostaFinal;
        parceirosSugeridos = r.parceirosSugeridos;
        break;
      }
      case "pedido_beneficio": {
        const r = await lidarComPedidoBeneficio({
          textoDoUsuario,
          historicoGemini,
          regiao,
          cidadesAtivas,
          idDaConversa: conversationId
        });
        respostaFinal = r.respostaFinal;
        parceirosSugeridos = r.parceirosSugeridos;
        break;
      }
      case "planejamento_viagem": {
        const r = await lidarComPlanejamentoViagem({
          textoDoUsuario,
          historicoGemini,
          regiao,
          cidadesAtivas,
          idDaConversa: conversationId
        });
        respostaFinal = r.respostaFinal;
        parceirosSugeridos = r.parceirosSugeridos;
        fotosExtras = Array.isArray(r.fotos) ? r.fotos : [];
        break;
      }
      case "follow_up_parceiro": {
        const parceiroEmFoco = conversaAtual?.parceiro_em_foco || null;
        if (parceiroEmFoco) {
          const respostaModelo = await gerarRespostaComParceiros(textoDoUsuario, historicoGemini, [parceiroEmFoco], regiao?.nome);
          respostaFinal = finalizeAssistantResponse({ modelResponseText: respostaModelo, foundPartnersList: [parceiroEmFoco], mode: "partners" });
          parceirosSugeridos = [parceiroEmFoco];
        } else {
          const r = await lidarComNovaBusca({
            textoDoUsuario,
            historicoGemini,
            regiao,
            cidadesAtivas,
            idDaConversa: conversationId
          });
          respostaFinal = r.respostaFinal;
          parceirosSugeridos = r.parceirosSugeridos;
        }
        break;
      }
      case "pergunta_geral":
      case "mudanca_contexto": {
        const respostaModelo = await gerarRespostaGeral(textoDoUsuario, historicoGemini, regiao);
        respostaFinal = finalizeAssistantResponse({ modelResponseText: respostaModelo, foundPartnersList: [], mode: "general" });
        try { await supabase.from("conversas").update({ parceiro_em_foco: null }).eq("id", conversationId); } catch {}
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

    let interactionId = null;
    try {
      const { data: nova, error: errIns } = await supabase
        .from("interacoes")
        .insert({
          regiao_id: regiao.id,
          conversation_id: conversationId,
          pergunta_usuario: textoDoUsuario,
          resposta_ia: respostaFinal,
          parceiros_sugeridos: parceirosSugeridos
        })
        .select("id")
        .single();
      if (errIns) throw errIns;
      interactionId = nova?.id || null;
    } catch (erro) {
      console.warn("[INTERACOES] Falha ao salvar interação:", erro?.message || erro);
    }

    const fotosDosParceiros = (parceirosSugeridos || []).flatMap(p => p?.fotos_parceiros || []).filter(Boolean);
    const photoLinks = [...fotosDosParceiros, ...fotosExtras].slice(0, 24);

    return res.status(200).json({
      reply: respostaFinal,
      interactionId,
      photoLinks,
      conversationId,
      intent,
      partners: parceirosSugeridos
    });
  } catch (erro) {
    console.error("[/api/chat/:slugDaRegiao] Erro:", erro);
    return res.status(500).json({ error: "Erro interno no servidor do BEPIT.", internal: { message: String(erro?.message || erro) } });
  }
});

// ============================================================================
// FEEDBACK
// ============================================================================

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
    } catch {}

    res.json({ success: true });
  } catch (erro) {
    console.error("[/api/feedback] Erro:", erro);
    res.status(500).json({ error: "Erro interno." });
  }
});

// ============================================================================
// AUTH (login por chave) + ADMIN (rotas protegidas)
// ============================================================================

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
  } catch (erro) {
    console.error("[/api/auth/login] Erro:", erro);
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/admin/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const usuarioValido = username && username === process.env.ADMIN_USER;
    const senhaValida = password && password === process.env.ADMIN_PASS;
    if (!usuarioValido || !senhaValida) return res.status(401).json({ error: "Credenciais inválidas." });
    return res.json({ ok: true, adminKey: process.env.ADMIN_API_KEY });
  } catch (erro) {
    console.error("[/api/admin/login] Erro:", erro);
    return res.status(500).json({ error: "Erro interno." });
  }
});

function exigirChaveDeAdministrador(req, res, next) {
  const chave = req.headers["x-admin-key"];
  if (!chave || chave !== (process.env.ADMIN_API_KEY || "")) {
    return res.status(401).json({ error: "Chave administrativa inválida ou ausente." });
  }
  next();
}

// --------------------- ADMIN: Parceiros (POST/GET/PUT) ----------------------

app.post("/api/admin/parceiros", exigirChaveDeAdministrador, async (req, res) => {
  try {
    const corpo = req.body || {};
    const { regiaoSlug, cidadeSlug, ...restante } = corpo;

    const { data: regiao, error: erroReg } = await supabase
      .from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (erroReg || !regiao) return res.status(400).json({ error: "regiaoSlug inválido." });

    const { data: cidade, error: erroCid } = await supabase
      .from("cidades").select("id").eq("regiao_id", regiao.id).eq("slug", cidadeSlug).single();
    if (erroCid || !cidade) return res.status(400).json({ error: "cidadeSlug inválido." });

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
      return res.status(500).json({ error: "Erro ao criar parceiro/dica." });
    }

    return res.status(200).json({ ok: true, data });
  } catch (erro) {
    console.error("[/api/admin/parceiros] Erro:", erro);
    return res.status(500).json({ error: "Erro interno." });
  }
});

app.get("/api/admin/parceiros/:regiaoSlug/:cidadeSlug", exigirChaveDeAdministrador, async (req, res) => {
  try {
    const { regiaoSlug, cidadeSlug } = req.params;

    const { data: regiao, error: erroReg } = await supabase.from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (erroReg || !regiao) return res.status(400).json({ error: "regiaoSlug inválido." });

    const { data: cidade, error: erroCid } = await supabase
      .from("cidades").select("id").eq("regiao_id", regiao.id).eq("slug", cidadeSlug).single();
    if (erroCid || !cidade) return res.status(400).json({ error: "cidadeSlug inválido." });

    const { data, error } = await supabase.from("parceiros").select("*").eq("cidade_id", cidade.id).order("nome");
    if (error) {
      console.error("[/api/admin/parceiros list] Erro:", error);
      return res.status(500).json({ error: "Erro ao listar parceiros/dicas." });
    }

    return res.status(200).json({ data });
  } catch (erro) {
    console.error("[/api/admin/parceiros list] Erro:", erro);
    return res.status(500).json({ error: "Erro interno." });
  }
});

// Atualização de parceiro por ID (usado pelo painel Admin)
app.put("/api/admin/parceiros/:id", exigirChaveDeAdministrador, async (req, res) => {
  try {
    const id = req.params.id;
    const body = req.body || {};

    const camposPermitidos = {
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
      .update(camposPermitidos)
      .eq("id", id)
      .select("*")
      .single();

    if (error) {
      console.error("[/api/admin/parceiros PUT] Erro:", error);
      return res.status(500).json({ error: "Erro ao atualizar parceiro." });
    }

    return res.json({ ok: true, data });
  } catch (erro) {
    console.error("[/api/admin/parceiros PUT] Erro:", erro);
    return res.status(500).json({ error: "Erro interno." });
  }
});

// --------------------- ADMIN: Regiões e Cidades -----------------------------

app.post("/api/admin/regioes", exigirChaveDeAdministrador, async (req, res) => {
  try {
    const { nome, slug, ativo = true } = req.body || {};
    if (!nome || !slug) return res.status(400).json({ error: "Campos 'nome' e 'slug' são obrigatórios." });

    const { data, error } = await supabase.from("regioes").insert({ nome, slug, ativo: Boolean(ativo) }).select("*").single();
    if (error) {
      console.error("[/api/admin/regioes] Insert Erro:", error);
      return res.status(500).json({ error: "Erro ao criar região." });
    }

    res.json({ ok: true, data });
  } catch (erro) {
    console.error("[/api/admin/regioes] Erro:", erro);
    res.status(500).json({ error: "Erro interno." });
  }
});

app.post("/api/admin/cidades", exigirChaveDeAdministrador, async (req, res) => {
  try {
    const { regiaoSlug, nome, slug, ativo = true, lat = null, lng = null } = req.body || {};
    if (!regiaoSlug || !nome || !slug) return res.status(400).json({ error: "Campos 'regiaoSlug', 'nome' e 'slug' são obrigatórios." });

    const { data: regiao, error: erroReg } = await supabase.from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (erroReg || !regiao) return res.status(400).json({ error: "regiaoSlug inválido." });

    const { data, error } = await supabase
      .from("cidades")
      .insert({ regiao_id: regiao.id, nome, slug, ativo: Boolean(ativo), lat: lat === null ? null : Number(lat), lng: lng === null ? null : Number(lng) })
      .select("*")
      .single();
    if (error) {
      console.error("[/api/admin/cidades] Insert Erro:", error);
      return res.status(500).json({ error: "Erro ao criar cidade." });
    }

    res.json({ ok: true, data });
  } catch (erro) {
    console.error("[/api/admin/cidades] Erro:", erro);
    res.status(500).json({ error: "Erro interno." });
  }
});

// --------------------- ADMIN: Métricas e Logs -------------------------------

app.get("/api/admin/metrics/summary", exigirChaveDeAdministrador, async (req, res) => {
  try {
    const { regiaoSlug, cidadeSlug } = req.query;
    if (!regiaoSlug) return res.status(400).json({ error: "O parâmetro 'regiaoSlug' é obrigatório." });

    const { data: regiao, error: erroReg } = await supabase
      .from("regioes")
      .select("id, nome, slug")
      .eq("slug", regiaoSlug)
      .single();
    if (erroReg || !regiao) return res.status(404).json({ error: "Região não encontrada." });

    const { data: cidades, error: erroCid } = await supabase
      .from("cidades")
      .select("id, nome, slug")
      .eq("regiao_id", regiao.id);
    if (erroCid) return res.status(500).json({ error: "Erro ao carregar cidades." });

    let cidade = null;
    let listaDeIdsDeCidades = (cidades || []).map((c) => c.id);
    if (cidadeSlug) {
      cidade = (cidades || []).find((c) => c.slug === cidadeSlug) || null;
      if (!cidade) return res.status(404).json({ error: "Cidade não encontrada nesta região." });
      listaDeIdsDeCidades = [cidade.id];
    }

    const { data: parceirosAtivos, error: erroParc } = await supabase
      .from("parceiros")
      .select("id")
      .eq("ativo", true)
      .in("cidade_id", listaDeIdsDeCidades);
    if (erroParc) return res.status(500).json({ error: "Erro ao contar parceiros." });

    const { data: buscas, error: erroBus } = await supabase
      .from("buscas_texto")
      .select("id, cidade_id, regiao_id")
      .eq("regiao_id", regiao.id);
    if (erroBus) return res.status(500).json({ error: "Erro ao contar buscas." });
    const totalDeBuscas = (buscas || []).filter((b) => (cidade ? b.cidade_id === cidade.id : true)).length;

    const { data: interacoes, error: erroInt } = await supabase
      .from("interacoes")
      .select("id, regiao_id")
      .eq("regiao_id", regiao.id);
    if (erroInt) return res.status(500).json({ error: "Erro ao contar interações." });
    const totalDeInteracoes = (interacoes || []).length;

    const { data: registrosDeViews, error: erroViews } = await supabase
      .from("parceiro_views")
      .select("parceiro_id, views_total, last_view_at")
      .order("views_total", { ascending: false })
      .limit(50);
    if (erroViews) return res.status(500).json({ error: "Erro ao ler views." });

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

    return res.json({
      regiao: { id: regiao.id, nome: regiao.nome, slug: regiao.slug },
      cidade: cidade ? { id: cidade.id, nome: cidade.nome, slug: cidade.slug } : null,
      total_parceiros_ativos: (parceirosAtivos || []).length,
      total_buscas: totalDeBuscas,
      total_interacoes: totalDeInteracoes,
      top5_parceiros_por_views: topCincoPorViews
    });
  } catch (erro) {
    console.error("[/api/admin/metrics/summary] Erro:", erro);
    res.status(500).json({ error: "Erro interno." });
  }
});

app.get("/api/admin/logs", exigirChaveDeAdministrador, async (req, res) => {
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
    } = req.query;

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
        return res.status(500).json({ error: "Erro ao buscar região." });
      }
      if (!regiao) return res.status(404).json({ error: "Região não encontrada." });
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
        return res.status(500).json({ error: "Erro ao buscar cidade." });
      }
      if (!cidade) return res.status(404).json({ error: "Cidade não encontrada nesta região." });
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
      return res.status(500).json({ error: "Erro ao consultar logs." });
    }

    return res.json({ data });
  } catch (erro) {
    console.error("[/api/admin/logs] Erro inesperado:", erro);
    return res.status(500).json({ error: "Erro interno." });
  }
});

// ------------------------ INICIAR SERVIDOR ----------------------------------

app.listen(PORT, () => {
  console.log(`✅ BEPIT Nexus (Orquestrador v3.5 REST) rodando em http://localhost:${PORT}`);
});
