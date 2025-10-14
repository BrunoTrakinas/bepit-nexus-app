// ============================================================================
// BEPIT Nexus - Servidor (Express)
// Orquestrador Lógico — Arquitetura "Session Ensurer + Classificador + Roteamento"
// v5.0 (stateful, robusto e com inteligência temporal / clima)
// ============================================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { supabase } from "../lib/supabaseClient.js";

import {
  finalizeAssistantResponse,
  buildNoPartnerFallback,
  BEPIT_SYSTEM_PROMPT_APPENDIX, // permanece disponível para partes herdadas
} from "./utils/bepitGuardrails.js";

import {
  buscarParceirosTolerante,
  normalizeTerm as normalizeSearchTerm,
} from "./utils/searchPartners.js";

// ============================== CONFIG BÁSICA ================================
const aplicacaoExpress = express();
const portaDoServidor = process.env.PORT || 3002;
aplicacaoExpress.use(express.json({ limit: "2mb" }));

// ------------------------------ CORS ----------------------------------------
// Lista de origens permitidas
const allowedOrigins = [
  "http://localhost:5173", // Para seu teste local (ajuste a porta se for diferente)
  "http://localhost:3000",
  "https://bepitnexus.netlify.app",
  "https://bepit-nexus.netlify.app",
];

const corsOptions = {
  origin: (origin, callback) => {
    // Permite requisições sem 'origin' (como Postman, apps mobile, etc.) E origens da nossa lista
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS: Origem não permitida por política de segurança."));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-admin-key", "authorization"],
};

// Aplica o middleware do CORS para TODAS as requisições
aplicacaoExpress.use(cors(corsOptions));
// Garante que as requisições OPTIONS pré-voo sejam tratadas corretamente
aplicacaoExpress.options("*", cors(corsOptions));

// ============================== GEMINI REST v1 ===============================
const usarGeminiREST = String(process.env.USE_GEMINI_REST || "") === "1";
const chaveGemini = process.env.GEMINI_API_KEY || "";

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
      `[GEMINI REST] GEMINI_MODEL "${envModelo}" indisponível. Disponíveis: ${disponiveis.join(
        ", "
      )}`
    );
  }

  const preferencia = [envModelo && stripModelsPrefix(envModelo), "gemini-1.5-flash-latest", "gemini-1.5-pro-latest"].filter(Boolean);
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

// ============================== HELPERS =====================================
function normalizarTexto(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Hora local "America/Sao_Paulo" no formato HH:mm */
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
    // Fallback simples (-03 fixo)
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
      if (it.pergunta_usuario)
        contents.push({ role: "user", parts: [{ text: it.pergunta_usuario }] });
      if (it.resposta_ia)
        contents.push({ role: "model", parts: [{ text: it.resposta_ia }] });
    }
    return contents;
  } catch (e) {
    console.warn("[HISTORICO] Falha ao carregar:", e?.message || e);
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

// -------------------------- SESSION ENSURER ---------------------------------
/**
 * Garante que exista uma conversa e descobre se é o primeiro turno.
 * Coloca em req.ctx: { conversationId, isFirstTurn }
 */
async function ensureConversation(req, supabaseClient) {
  const body = req.body || {};
  let conversationId = body.conversationId || body.threadId || body.sessionId || null;

  if (!conversationId || typeof conversationId !== "string" || conversationId.trim().length < 10) {
    conversationId = randomUUID();
    try {
      await supabaseClient.from("conversas").insert({
        id: conversationId,
        regiao_id: req.ctx?.regiao?.id || null,
        parceiro_em_foco: null,
        parceiros_sugeridos: [],
        ultima_pergunta_usuario: null,
        ultima_resposta_ia: null,
        preferencia_indicacao: null,
        topico_atual: null,
        aguardando_refinamento: false,
      });
    } catch (e) {
      // idempotente — se falhar por unique, seguimos
    }
  } else {
    // Garante existência
    try {
      const { data: existe } = await supabaseClient
        .from("conversas")
        .select("id")
        .eq("id", conversationId)
        .maybeSingle();
      if (!existe) {
        await supabaseClient.from("conversas").insert({
          id: conversationId,
          regiao_id: req.ctx?.regiao?.id || null,
          parceiro_em_foco: null,
          parceiros_sugeridos: [],
          ultima_pergunta_usuario: null,
          ultima_resposta_ia: null,
          preferencia_indicacao: null,
          topico_atual: null,
          aguardando_refinamento: false,
        });
      }
    } catch {}
  }

  // Conta interações
  let isFirstTurn = false;
  try {
    const { count } = await supabaseClient
      .from("interacoes")
      .select("*", { count: "exact", head: true })
      .eq("conversation_id", conversationId);
    isFirstTurn = (count || 0) === 0;
  } catch {
    // se falhar a contagem, assume que não é primeiro turno
    isFirstTurn = false;
  }

  req.ctx = Object.assign({}, req.ctx || {}, { conversationId, isFirstTurn });
  return { conversationId, isFirstTurn };
}

// ---------------------- CLASSIFICAÇÃO DETERMINÍSTICA ------------------------
function isSaudacao(texto) {
  const t = normalizarTexto(texto);
  const saudacoes = ["oi", "ola", "olá", "bom dia", "boa tarde", "boa noite", "e ai", "e aí", "tudo bem"];
  return saudacoes.includes(t);
}

function isWeatherQuestion(texto) {
  const t = normalizarTexto(texto);
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

/** 'future' (amanhã, semana que vem, sábado, próximos dias) | 'present' (default) */
function detectTemporalWindow(texto) {
  const t = normalizarTexto(texto);
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

/** Extrai cidade com base na lista de cidades ativas */
function extractCity(texto, cidadesAtivas) {
  const t = normalizarTexto(texto || "");
  const lista = Array.isArray(cidadesAtivas) ? cidadesAtivas : [];
  // apelidos comuns
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

  // 1) via apelidos
  const hitApelido = apelidos.find((a) => t.includes(a.key));
  if (hitApelido) {
    const alvo = lista.find((c) => normalizarTexto(c.nome) === normalizarTexto(hitApelido.nome));
    if (alvo) return alvo;
  }

  // 2) varredura direta por nome/slug
  for (const c of lista) {
    if (t.includes(normalizarTexto(c.nome)) || t.includes(normalizarTexto(c.slug))) {
      return c;
    }
  }

  return null;
}

function isRegionQuery(texto) {
  const t = normalizarTexto(texto);
  const mencionaRegiao =
    t.includes("regiao") ||
    t.includes("região") ||
    t.includes("regiao dos lagos") ||
    t.includes("região dos lagos");
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

# 3. MÓDULO DE RACIOCÍNIO: CONCIERGE DE CLIMA, MARÉS E ATIVIDADES CONTEXTUAIS
- Sua função é ser um "conselheiro" para o turista, conectando dados brutos a atividades práticas e contextuais.
- **REGRA DE OURO DE CONTEXTO:** Você DEVE usar a "HORA ATUAL" fornecida para dar sugestões apropriadas.

- **SE FOR DE MANHÃ (até 10:00):**
    - Se \`ondas\` e \`vento\` estiverem baixos, sua sugestão principal deve ser um **passeio de barco**. Ex: "O dia está simplesmente perfeito para um passeio de barco agora pela manhã!"

- **SE FOR "MEIO DO DIA" (das 10:01 às 14:00):**
    - Se \`ondas\` e \`vento\` estiverem baixos, você ainda pode sugerir passeio de barco, mas com um tom de "última chamada". Ex: "O tempo está ótimo para um passeio de barco! Se você ainda conseguir uma vaga em alguma embarcação, vale muito a pena!"
    - Se as condições do mar **não** estiverem boas para barco, sua sugestão alternativa deve ser o **Shopping Park Lagos**. Ex: "O mar está um pouco agitado para passeios agora, mas é uma ótima oportunidade para conhecer o Shopping Park Lagos em Cabo Frio."

- **SE FOR DE TARDE (das 14:01 às 17:00):**
    - **NUNCA MAIS** sugira passeio de barco.
    - Se o tempo estiver bom (sol/sem chuva), sua sugestão principal deve ser **curtir uma praia**. Ex: "A tarde está linda e o sol ainda está forte, perfeito para aproveitar a praia!"

- **SE FOR FIM DE TARDE / NOITE (a partir das 17:01):**
    - **NUNCA** sugira atividades de praia ou barco como algo a se fazer "agora".
    - Use a temperatura para contextualizar sugestões noturnas.
    - **EXEMPLO DE SUGESTÃO NOTURNA:** "A noite em Búzios está muito agradável, com cerca de 26°C. É uma temperatura perfeita para uma caminhada pela Rua das Pedras ou para explorar o polo gastronômico do bairro da Passagem em Cabo Frio."
    - Você pode, opcionalmente, mencionar como o dia esteve: "O mar esteve ótimo para mergulho hoje..." mas a sua sugestão de ação deve ser para a noite.

- **REGRAS ADICIONAIS (qualquer horário):**
    - Se a \`temperatura da água\` estiver agradável (>22°C), mencione que "o mar está ótimo para um mergulho".
    - Se o \`vento\` estiver moderado/alto (>5 m/s), mencione que "as condições estão favoráveis para esportes a vela, como windsurf ou kitesurf".
    - Se houver dados de maré, informe os horários e a dica sobre a pesca.

- **Regra para Resumo da Região:** Se você receber uma lista de dados climáticos para múltiplas cidades, sua tarefa é criar um resumo comparativo e conciso para o usuário. Comece com uma frase como "O tempo na Região dos Lagos está variado hoje!". Em seguida, resuma a condição de cada cidade. Ex: "Em Cabo Frio, o céu está com poucas nuvens e 25°C. Já em Búzios, está ensolarado com 26°C..."

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

// ============================== PARCEIROS ===================================
// Heurística de intenção já existente (mantida)
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

  // Cidade (heurística rápida)
  let cidade = null;
  if (tNorm.includes("cabo frio")) cidade = "Cabo Frio";
  else if (tNorm.includes("buzios") || tNorm.includes("búzios")) cidade = "Armação dos Búzios";
  else if (tNorm.includes("arraial")) cidade = "Arraial do Cabo";
  else if (tNorm.includes("sao pedro") || tNorm.includes("são pedro"))
    cidade = "São Pedro da Aldeia";

  // Termos úteis para ranking
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

  // Cesta macro
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

// ============================== LISTAGEM / RESPOSTAS ========================
async function analisarIntencaoDoUsuario(textoDoUsuario) {
  return forcarBuscaParceiro(textoDoUsuario) ? "busca_parceiro" : "pergunta_geral";
}

async function gerarRespostaDeListaParceiros(pergunta, historicoContents, parceiros) {
  // lista resumida numerada
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
  return await geminiGerarTexto(prompt);
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

  return await geminiGerarTexto(payload);
}

// --------------------- BUSCA / REFINO PARCEIROS (mantido) -------------------
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

  // Resolve cidade (slug) a partir da lista ativa
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

  // Priorização mínima
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

  // Termo opcional
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

  // Execução de buscas com limites FIXOS
  const agregados = [];
  const vistos = new Set();
  const alvoInicialFix = 3;
  const alvoRefinoFix = 5;

  for (const cat of categoriasAProcurar) {
    const r = await buscarParceirosTolerante({
      cidadeSlug,
      categoria: cat,
      term: termoDeBusca,
      isInitialSearch: isInitialSearch,
      excludeIds: Array.from(vistos),
    });

    if (r.ok && Array.isArray(r.items)) {
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
    } catch {}
    return { respostaFinal, parceirosSugeridos };
  } else {
    // Sem resultados → resposta geral (blindada por guardrails externos, se aplicável)
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

// ============================== ROTA PRINCIPAL ===============================
aplicacaoExpress.post("/api/chat/:slugDaRegiao", async (req, res) => {
  try {
    const { slugDaRegiao } = req.params;
    let { message: textoDoUsuario } = req.body || {};
    if (!textoDoUsuario || typeof textoDoUsuario !== "string" || !textoDoUsuario.trim()) {
      return res
        .status(400)
        .json({ error: "O campo 'message' é obrigatório e deve ser uma string não vazia." });
    }
    textoDoUsuario = textoDoUsuario.trim();

    // 1) Setup: região e cidades ativas
    const { data: regiao, error: erroRegiao } = await supabase
      .from("regioes")
      .select("id, nome, slug, ativo")
      .eq("slug", slugDaRegiao)
      .single();
    if (erroRegiao || !regiao) return res.status(404).json({ error: "Região não encontrada." });
    if (regiao.ativo === false) return res.status(403).json({ error: "Região desativada." });
    req.ctx = { regiao };

    const { data: cidades, error: erroCidades } = await supabase
      .from("cidades")
      .select("id, nome, slug, lat, lng, ativo")
      .eq("regiao_id", regiao.id);
    if (erroCidades)
      return res.status(500).json({ error: "Erro ao carregar cidades.", internal: erroCidades });
    const cidadesAtivas = (cidades || []).filter((c) => c.ativo !== false);

    // 2) Session Ensurer
    const { conversationId, isFirstTurn } = await ensureConversation(req, supabase);

    // 3) Saudação somente se for primeiro turno
    if (isSaudacao(textoDoUsuario) && isFirstTurn) {
      const nomeRegiao = regiao?.nome || "Região dos Lagos";
      const respostaSaudacao =
        `Olá! Seja bem-vindo(a) à ${nomeRegiao}! Eu sou o BEPIT, seu concierge de confiança. ` +
        `Minha missão é te conectar com os melhores e mais seguros parceiros da região, todos verificados pela nossa equipe. ` +
        `Como posso te ajudar a ter uma experiência incrível hoje?`;
      try {
        await supabase.from("interacoes").insert({
          regiao_id: regiao.id,
          conversation_id: conversationId,
          pergunta_usuario: textoDoUsuario,
          resposta_ia: respostaSaudacao,
          parceiros_sugeridos: [],
        });
      } catch {}
      return res.status(200).json({
        reply: respostaSaudacao,
        conversationId,
        intent: "saudacao_inicial",
        partners: [],
      });
    }

    // 4) Histórico (para IA)
    const historicoGemini = await construirHistoricoParaGemini(conversationId, 12);
    const horaLocalSP = getHoraLocalSP();

    // 5) Roteamento de Clima
    if (isWeatherQuestion(textoDoUsuario)) {
      const when = detectTemporalWindow(textoDoUsuario); // 'future' | 'present'
      const cidadeEscopo = extractCity(textoDoUsuario, cidadesAtivas);
      const escopoRegiao = isRegionQuery(textoDoUsuario) && !cidadeEscopo;

      const dadosIA = {
        when,
        escopo: escopoRegiao ? "regiao" : "cidade",
        cidade: cidadeEscopo ? { id: cidadeEscopo.id, nome: cidadeEscopo.nome } : null,
        resultados: [],
      };

      if (escopoRegiao) {
        // 3 cidades VIP: Arraial, Cabo Frio, Búzios — respeita janela temporal (presente/futuro)
        const tipoDadoRegiao = when === "future" ? "previsao_diaria" : "clima_atual";
        const nomesAlvo = ["Arraial do Cabo", "Cabo Frio", "Armação dos Búzios"];
        const mapaCidades = {};
        for (const n of nomesAlvo) {
          const achada = cidadesAtivas.find(
            (c) => normalizarTexto(c.nome) === normalizarTexto(n)
          );
          if (achada) mapaCidades[n] = achada.id;
        }

        for (const nomeCidade of nomesAlvo) {
          const cid = mapaCidades[nomeCidade];
          if (!cid) continue;
          const { data: climaRow } = await supabase
            .from("dados_climaticos")
            .select("cidade_id, tipo_dado, dados, data_hora_consulta")
            .eq("cidade_id", cid)
            .eq("tipo_dado", tipoDadoRegiao)
            .order("data_hora_consulta", { ascending: false })
            .limit(1);
          if (Array.isArray(climaRow) && climaRow.length > 0) {
            dadosIA.resultados.push({ cidade: nomeCidade, tipo: tipoDadoRegiao, registro: climaRow[0] });
          }
        }
      } else if (cidadeEscopo) {
        // Cidade específica: present -> clima_atual, future -> previsao_diaria
        const tipoDado = when === "future" ? "previsao_diaria" : "clima_atual";
        const { data: climaRows } = await supabase
          .from("dados_climaticos")
          .select("cidade_id, tipo_dado, dados, data_hora_consulta")
          .eq("cidade_id", cidadeEscopo.id)
          .eq("tipo_dado", tipoDado)
          .order("data_hora_consulta", { ascending: false })
          .limit(1);

        if (Array.isArray(climaRows) && climaRows.length > 0) {
          dadosIA.resultados.push({
            cidade: cidadeEscopo.nome,
            tipo: tipoDado,
            registro: climaRows[0],
          });
        }

        // Se for VIP, tenta dados de maré e temperatura água (últimos registros)
        if (CIDADES_VIP.includes(normalizarTexto(cidadeEscopo.nome))) {
          const { data: dMare } = await supabase
            .from("dados_climaticos")
            .select("cidade_id, tipo_dado, dados, data_hora_consulta")
            .eq("cidade_id", cidadeEscopo.id)
            .eq("tipo_dado", "dados_mare")
            .order("data_hora_consulta", { ascending: false })
            .limit(1);
          if (Array.isArray(dMare) && dMare.length > 0) {
            dadosIA.resultados.push({
              cidade: cidadeEscopo.nome,
              tipo: "dados_mare",
              registro: dMare[0],
            });
          }

          const { data: dAgua } = await supabase
            .from("dados_climaticos")
            .select("cidade_id, tipo_dado, dados, data_hora_consulta")
            .eq("cidade_id", cidadeEscopo.id)
            .eq("tipo_dado", "temperatura_agua")
            .order("data_hora_consulta", { ascending: false })
            .limit(1);
          if (Array.isArray(dAgua) && dAgua.length > 0) {
            dadosIA.resultados.push({
              cidade: cidadeEscopo.nome,
              tipo: "temperatura_agua",
              registro: dAgua[0],
            });
          }
        }
      }

      // Fallback explícito se nada foi encontrado
      if (!Array.isArray(dadosIA.resultados) || dadosIA.resultados.length === 0) {
        const msgFallback =
          "Dados de clima não encontrados para esta consulta. Posso tentar novamente em instantes.";
        try {
          await supabase.from("interacoes").insert({
            regiao_id: regiao.id,
            conversation_id: conversationId,
            pergunta_usuario: textoDoUsuario,
            resposta_ia: msgFallback,
            parceiros_sugeridos: [],
          });
        } catch {}
        return res.status(200).json({
          reply: msgFallback,
          conversationId,
          intent: "clima_sem_dados",
          partners: [],
        });
      }

      // Gera resposta IA com PROMPT v1.3 (hora local)
      const dadosJSON = JSON.stringify(dadosIA, null, 2);
      const respostaModelo = await gerarRespostaGeralPrompteada({
        pergunta: textoDoUsuario,
        historicoContents: historicoGemini,
        regiaoNome: regiao?.nome,
        dadosClimaOuMaresJSON: dadosJSON,
        horaLocalSP,
      });

      const respostaFinal = finalizeAssistantResponse({
        modelResponseText: respostaModelo,
        foundPartnersList: [],
        mode: "general",
      });

      // Persistência
      let interactionId = null;
      try {
        const { data: nova } = await supabase
          .from("interacoes")
          .insert({
            regiao_id: regiao.id,
            conversation_id: conversationId,
            pergunta_usuario: textoDoUsuario,
            resposta_ia: respostaFinal,
            parceiros_sugeridos: [],
          })
          .select("id")
          .single();
        interactionId = nova?.id || null;
      } catch {}

      return res.status(200).json({
        reply: respostaFinal,
        interactionId,
        conversationId,
        intent: "pergunta_clima",
        partners: [],
      });
    }

    // 6) Fallback: lógica de parceiros existente (determinística)
    const intent = await analisarIntencaoDoUsuario(textoDoUsuario);
    let respostaFinal = "";
    let parceirosSugeridos = [];

    switch (intent) {
      case "busca_parceiro": {
        const r = await lidarComNovaBusca({
          textoDoUsuario,
          historicoGemini,
          regiao,
          cidadesAtivas,
          idDaConversa: conversationId,
          isInitialSearch: true,
          excludeIds: [],
        });
        respostaFinal = r.respostaFinal;
        parceirosSugeridos = r.parceirosSugeridos;
        break;
      }
      case "pergunta_geral":
      default: {
        const respostaModelo = await gerarRespostaGeralPrompteada({
          pergunta: textoDoUsuario,
          historicoContents: historicoGemini,
          regiaoNome: regiao?.nome,
          dadosClimaOuMaresJSON: "{}",
          horaLocalSP,
        });
        respostaFinal = finalizeAssistantResponse({
          modelResponseText: respostaModelo,
          foundPartnersList: [],
          mode: "general",
        });
        try {
          await supabase.from("conversas").update({ parceiro_em_foco: null }).eq("id", conversationId);
        } catch {}
        break;
      }
    }

    if (!respostaFinal) {
      respostaFinal =
        "Posso ajudar com roteiros, transporte, passeios, praias e onde comer. O que você gostaria de saber?";
    }

    let interactionId = null;
    try {
      const { data: nova } = await supabase
        .from("interacoes")
        .insert({
          regiao_id: regiao.id,
          conversation_id: conversationId,
          pergunta_usuario: textoDoUsuario,
          resposta_ia: respostaFinal,
          parceiros_sugeridos: parceirosSugeridos,
        })
        .select("id")
        .single();
      interactionId = nova?.id || null;
    } catch {}

    const fotos = (parceirosSugeridos || [])
      .flatMap((p) => p?.fotos_parceiros || [])
      .filter(Boolean);

    return res.status(200).json({
      reply: respostaFinal,
      interactionId,
      photoLinks: fotos,
      conversationId,
      intent,
      partners: parceirosSugeridos,
    });
  } catch (erro) {
    console.error("[/api/chat/:slugDaRegiao] Erro:", erro);
    return res
      .status(500)
      .json({ error: "Erro interno no servidor do BEPIT.", internal: { message: String(erro?.message || erro) } });
  }
});

// ------------------------------ AVISOS PÚBLICOS -----------------------------
aplicacaoExpress.get("/api/avisos/:slugDaRegiao", async (req, res) => {
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

// ---------------------------------------------------------------------------
// HEALTHCHECKS BÁSICOS
aplicacaoExpress.get("/", (_req, res) => {
  res.status(200).send("BEPIT backend ativo ✅");
});

aplicacaoExpress.get("/ping", (_req, res) => {
  res.status(200).json({ pong: true, ts: Date.now() });
});

// ---------------------------------------------------------------------------
// STARTUP DO SERVIDOR (necessário no Render)
const host = "0.0.0.0";
aplicacaoExpress
  .listen(portaDoServidor, host, () => {
    console.log(`[BOOT] BEPIT ouvindo em http://${host}:${portaDoServidor}`);
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

// Export para testes (opcional)
export default aplicacaoExpress;
