// ============================================================================
// BEPIT Nexus - Servidor (Express) — Orquestrador Lógico v4.1 (Diretiva Simplificada)
// - (T1) Removido "limite dinâmico" por completo (extração e uso)
// - (T2) Busca padronizada: inicial = máx 3 aleatórios; refinamento = máx 5 por relevância
// - (T3) Muralha anti-alucinação nos prompts (Regra de Ouro inquebrável na resposta geral)
// - (T4) Fluxo de intenção determinístico: busca → se 0, cai em resposta geral blindada
// - Mantém: /api/admin/* (não incluído aqui), /api/auth/login (não incluído aqui), health, diag, feedback
// ============================================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { supabase } from "../lib/supabaseClient.js";

import {
  finalizeAssistantResponse,
  buildNoPartnerFallback
  // BEPIT_SYSTEM_PROMPT_APPENDIX  // (substituído pelo PROMPT_MESTRE_BEPIT_V13)
} from "./utils/bepitGuardrails.js";

import {
  buscarParceirosTolerante,
  normalizeTerm as normalizeSearchTerm
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
  "https://bepit-nexus.netlify.app"
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
  allowedHeaders: ["Content-Type", "x-admin-key", "authorization"]
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
  const url = `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(chaveGemini)}`;
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    const texto = await resp.text().catch(() => "");
    throw new Error(`[GEMINI REST] Falha ao listar modelos: ${resp.status} ${resp.statusText} ${texto}`);
  }
  const json = await resp.json();
  const items = Array.isArray(json.models) ? json.models : [];
  return items.map(m => String(m.name || "")).filter(Boolean);
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
    "gemini-1.5-flash-latest",
    "gemini-1.5-pro-latest"
  ].filter(Boolean);
  for (const alvo of preferencia) if (disponiveis.includes(alvo)) return alvo;

  const qualquer = disponiveis.find(n => /^gemini-/.test(n));
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

// ============================== PROMPT MESTRE (v1.3) ========================
// Substitui o prompt de sistema anterior por esta versão avançada.
const PROMPT_MESTRE_BEPIT_V13 = `
# 1. IDENTIDADE E MISSÃO
- Você é o BEPIT, um concierge de turismo especialista, amigável e confiável na Região dos Lagos.
- Sua missão é fornecer informações precisas baseadas EXCLUSIVAMENTE nos dados fornecidos.

# 2. DIRETRIZES GERAIS
- Seja proativo, amigável e honesto.
- Priorize sempre os parceiros cadastrados.

# 3. MÓDULO DE RACIOCÍNIO: CONCIERGE DE CLIMA, MARÉS E ATIVIDADES
- Sua função é ser um "conselheiro" para o turista, conectando dados brutos a atividades práticas e contextuais.
- REGRA DE OURO DE CONTEXTO: Você DEVE usar a "HORA ATUAL" fornecida para dar sugestões apropriadas.

- SE FOR DE MANHÃ (até 10:00):
  - Se ondas e vento estiverem baixos, a sugestão principal deve ser um passeio de barco. Ex: "O dia está simplesmente perfeito para um passeio de barco agora pela manhã!"

- SE FOR "MEIO DO DIA" (das 10:01 às 14:00):
  - Se ondas e vento estiverem baixos, pode sugerir passeio de barco, com tom de "última chamada". Ex: "O tempo está ótimo para um passeio de barco! Se você ainda conseguir uma vaga em alguma embarcação, vale muito a pena!"
  - Se as condições do mar não estiverem boas para barco, a sugestão alternativa é o Shopping Park Lagos (Cabo Frio).

- SE FOR DE TARDE (das 14:01 às 17:00):
  - NUNCA mais sugira passeio de barco.
  - Se o tempo estiver bom (sol/sem chuva), sugestão principal: curtir uma praia.

- SE FOR FIM DE TARDE / NOITE (a partir das 17:01):
  - NUNCA sugira praia ou barco.
  - Use a temperatura para contextualizar sugestões noturnas.
  - Ex: "A noite está muito agradável, com cerca de 26°C. É uma temperatura perfeita para uma caminhada pela Rua das Pedras em Búzios, ou para explorar o polo gastronômico do bairro da Passagem em Cabo Frio."

- REGRAS ADICIONAIS (qualquer horário):
  - Se a temperatura da água > 22°C, mencione que "o mar está ótimo para um mergulho".
  - Se o vento > 5 m/s, mencione que "as condições estão favoráveis para esportes a vela, como windsurf ou kitesurf".
  - Se houver dados de maré, informe os horários relevantes e a dica sobre pesca nos períodos de mudança de maré.

# 4. DADOS CONTEXTUAIS
- HORA ATUAL: [será preenchida abaixo]
- [OUTROS DADOS...]

# 5. TAREFA FINAL
Com base em todas as suas regras e nos dados contextuais (especialmente a HORA ATUAL), formule a melhor, mais útil e mais contextual resposta.
`.trim();

// ============================== HELPERS =====================================
function normalizarTexto(texto) {
  return String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

// Saudação (já existente em versões anteriores)
function isSaudacao(texto) {
  const t = normalizarTexto(texto);
  const saudacoes = ["oi", "ola", "olá", "bom dia", "boa tarde", "boa noite", "e aí", "tudo bem"];
  return saudacoes.includes(t);
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
    console.warn("[HISTORICO] Falha ao carregar:", e?.message || e);
    return [];
  }
}

function historicoParaTextoSimplesWrapper(hc) {
  try {
    return (hc || [])
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

// ============================== HEURÍSTICA DE INTENÇÃO ======================
const PALAVRAS_CHAVE = {
  comida: ["restaurante", "restaurantes", "almoço", "almoco", "jantar", "comer", "comida", "picanha", "piconha", "carne", "churrasco", "pizza", "pizzaria", "peixe", "frutos do mar", "moqueca", "rodizio", "rodízio", "lanchonete", "burger", "hamburguer", "hambúrguer", "bistrô", "bistro"],
  hospedagem: ["pousada", "pousadas", "hotel", "hotéis", "hospedagem", "hostel", "airbnb"],
  bebidas: ["bar", "bares", "chopp", "chope", "drinks", "pub", "boteco"],
  passeios: ["passeio", "passeios", "barco", "lancha", "escuna", "trilha", "trilhas", "tour", "buggy", "quadriciclo", "city tour", "catamarã", "catamara", "mergulho", "snorkel", "gruta", "ilha"],
  praias: ["praia", "praias", "faixa de areia", "bandeira azul", "mar calmo", "mar forte"],
  transporte: ["transfer", "transporte", "alugar carro", "aluguel de carro", "uber", "taxi", "ônibus", "onibus", "rodoviária", "rodoviaria"]
};

// ——— NOVO: gatilhos para clima/mar/marés (Alteração 1) ———
const CLIMA_GATILHOS = [
  "clima", "tempo", "vento", "ventos",
  "maré", "mare", "marés", "mares", "ondulação", "ondas",
  "água", "agua", "chuva", "chuvas",
  // Palavras novas exigidas:
  "temperatura", "graus", "calor", "frio", "chovendo"
];

function forcarBuscaParceiro(texto) {
  const t = normalizarTexto(texto);
  for (const lista of Object.values(PALAVRAS_CHAVE)) {
    if (lista.some(p => t.includes(p))) return true;
  }
  return false;
}

function pedeClima(texto) {
  const t = normalizarTexto(texto);
  return CLIMA_GATILHOS.some(p => t.includes(p));
}

// -------- ENTIDADES (cidade + termos) COM SINAIS DE "CARNE/PICANHA" --------
async function extrairEntidadesDaBusca(texto) {
  const tNorm = normalizarTexto(texto || "");

  // Cidade
  let cidade = null;
  if (tNorm.includes("cabo frio")) cidade = "Cabo Frio";
  else if (tNorm.includes("buzios") || tNorm.includes("búzios")) cidade = "Búzios";
  else if (tNorm.includes("arraial")) cidade = "Arraial do Cabo";
  else if (tNorm.includes("sao pedro") || tNorm.includes("são pedro")) cidade = "São Pedro da Aldeia";

  // Termos úteis para ranking
  const DIC_TERMS = [
    "picanha","piconha","carne","churrasco","rodizio","rodízio","fraldinha","costela",
    "barato","barata","familia","família","romantico","romântico","vista","vista para o mar","rodizio",
    "pizza","peixe","frutos do mar","moqueca","hamburguer","hambúrguer","sushi","japonesa","bistrô","bistro"
  ];
  const terms = [];
  for (const w of DIC_TERMS) if (tNorm.includes(normalizarTexto(w))) terms.push(w);

  // Cesta macro
  let category = null;
  if (["restaurante","comer","comida","picanha","piconha","carne","churrasco","rodizio","rodízio","pizza","pizzaria","peixe","frutos do mar","hamburguer","hambúrguer","bistrô","bistro","sushi","japonesa"].some(k => tNorm.includes(k))) {
    category = "comida";
  } else if (["pousada","hotel","hostel","hospedagem","airbnb","apart","flat","resort"].some(k => tNorm.includes(k))) {
    category = "hospedagem";
  } else if (["bar","bares","chopp","chope","drinks","pub","boteco"].some(k => tNorm.includes(k))) {
    category = "bebidas";
  } else if (["passeio","barco","lancha","escuna","trilha","buggy","quadriciclo","mergulho","snorkel","tour"].some(k => tNorm.includes(k))) {
    category = "passeios";
  } else if (["praia","praias","bandeira azul","orla"].some(k => tNorm.includes(k))) {
    category = "praias";
  } else if (["transfer","transporte","aluguel de carro","locadora","uber","taxi","ônibus","onibus"].some(k => tNorm.includes(k))) {
    category = "transporte";
  }

  return { category, city: cidade, terms };
}

// ============================== PROMPTS =====================================

// (T4) Intenção determinística: sem LLM para classificar.
async function analisarIntencaoDoUsuario(textoDoUsuario) {
  return forcarBuscaParceiro(textoDoUsuario) ? "busca_parceiro" : "pergunta_geral";
}

// Lista resumida (TAREFA anterior) — deixa mais simples e direta
async function gerarRespostaComParceiros(pergunta, historicoContents, parceiros, regiaoNome = "") {
  const contextoParceiros = JSON.stringify(parceiros ?? [], null, 2);
  const prompt = [
    PROMPT_MESTRE_BEPIT_V13,
    "",
    "Você é um assistente de consulta. Sua única função é apresentar os resultados de uma busca em uma lista numerada.",
    "Para cada estabelecimento no [Contexto], crie um item na lista com o NOME em negrito, seguido por um traço e a DESCRIÇÃO.",
    "NÃO inclua endereço, contato ou qualquer outra informação. Apenas NOME e DESCRIÇÃO.",
    "A lista deve ser clara e objetiva.",
    "Após a lista, finalize com a pergunta: 'Alguma dessas opções te interessou? Me diga o número ou o nome para ver mais detalhes.'",
    "",
    `[Contexto]: ${contextoParceiros}`,
    `[Pergunta do Usuário]: "${pergunta}"`
  ].join("\n");
  return await geminiGerarTexto(prompt);
}

// Nova função para detalhar um parceiro específico
async function gerarDetalhesDoParceiro(pergunta, historicoContents, parceiro, regiaoNome = "") {
  const historicoTexto = historicoParaTextoSimplesWrapper(historicoContents);
  const contextoParceiro = JSON.stringify(parceiro ?? {}, null, 2);
  const prompt = [
    PROMPT_MESTRE_BEPIT_V13,
    "",
    "Você é um assistente de consulta. Sua única função é apresentar todos os detalhes do estabelecimento fornecido no [Contexto] de forma organizada e completa.",
    "Apresente as informações usando títulos claros para cada dado (ex: 'Endereço:', 'Contato:', 'Faixa de Preço:').",
    "Se o parceiro tiver um 'beneficio_bepit', destaque-o.",
    "Ao final, inclua a seguinte nota de rodapé OBRIGATORIAMENTE: 'Observação: os preços e horários podem sofrer alterações. Recomendamos entrar em contato com o estabelecimento para confirmar.'",
    "Se o usuário perguntar por cardápio ou fotos, e essa informação estiver no [Contexto], apresente-a.",
    "",
    `[Contexto]: ${contextoParceiro}`,
    `[Histórico]:\n${historicoTexto}`,
    `[Pergunta do Usuário]: "${pergunta}"`
  ].join("\n");
  return await geminiGerarTexto(prompt);
}

// (T3) Prompt blindado (Regra de Ouro inquebrável) — NUNCA inventar estabelecimentos.
// Adicionada saudação + uso do PROMPT_MESTRE_BEPIT_V13
async function gerarRespostaGeral(pergunta, historicoContents, regiao) {
  // Saudação com mensagem de boas-vindas estratégica
  if (isSaudacao(pergunta)) {
    const nomeRegiao = regiao?.nome || "Região dos Lagos";
    const respostaSaudacao = `Olá! Seja bem-vindo(a) à ${nomeRegiao}! Eu sou o BEPIT, seu concierge de confiança. Minha missão é te conectar com os melhores e mais seguros parceiros da região, todos verificados por nossa equipe. Aqui você encontra passeios organizados, restaurantes de qualidade e serviços testados. Nada de ciladas. Como posso te ajudar a ter uma experiência incrível hoje?`;
    return respostaSaudacao;
  }

  const historicoTexto = historicoParaTextoSimplesWrapper(historicoContents);
  const nomeRegiao = regiao?.nome || "Região dos Lagos";

  const prompt = [
    PROMPT_MESTRE_BEPIT_V13,
    "",
    `Você é o BEPIT, um concierge amigável e especialista na região de ${nomeRegiao}.`,
    "Sua principal função é responder perguntas gerais sobre a região (história, geografia, dicas de segurança, etc.).",
    "**REGRA DE OURO INQUEBRÁVEL:** Você é **ESTRITAMENTE PROIBIDO** de inventar ou sugerir nomes de estabelecimentos comerciais (restaurantes, hotéis, passeios, lojas, etc.) que não foram fornecidos a você em uma lista de [Contexto].",
    "Se o usuário pedir uma sugestão de estabelecimento e você não tiver uma lista de [Contexto], sua ÚNICA resposta permitida é dizer que não encontrou um parceiro cadastrado para aquela solicitação específica e perguntar se pode ajudar com outra coisa.",
    "NUNCA finja que tem resultados. NUNCA use seu conhecimento geral para sugerir um nome comercial.",
    "",
    `[Histórico]:\n${historicoTexto}`,
    `[Pergunta]: "${pergunta}"`
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
      if (Number.isFinite(idx) && idx >= 1 && idx <= listaDeParceiros.length) return listaDeParceiros[idx - 1];
    }

    const ordinais = ["primeiro","segundo","terceiro","quarto","quinto","sexto","sétimo","setimo","oitavo"];
    for (let i = 0; i < ordinais.length; i++) {
      if (texto.includes(ordinais[i])) {
        const pos = i + 1;
        if (pos >= 1 && pos <= listaDeParceiros.length) return listaDeParceiros[pos - 1];
      }
    }

    for (const p of listaDeParceiros) {
      const nome = normalizarTexto(p?.nome || "");
      if (nome && texto.includes(nome)) return p;
      const tokens = (nome || "").split(/\s+/).filter(Boolean);
      const acertos = tokens.filter(t => texto.includes(t)).length;
      if (acertos >= Math.max(1, Math.ceil(tokens.length * 0.6))) return p;
    }
    return null;
  } catch {
    return null;
  }
}

// ============================== BUSCA / REFINO ==============================
// (T1) Removido por completo o parâmetro/uso de limite dinâmico
async function ferramentaBuscarParceirosOuDicas({
  cidadesAtivas,
  argumentosDaFerramenta,
  textoOriginal,
  isInitialSearch = false,
  excludeIds = []
}) {
  const categoriaProcurada = (argumentosDaFerramenta?.category || "").trim();
  const cidadeProcurada = (argumentosDaFerramenta?.city || "").trim();

  const textoN = normalizarTexto(textoOriginal || "");
  const sinaisCarne = ["picanha","piconha","carne","churrasco","rodizio","rodízio"].some(s => textoN.includes(s));
  const sinaisVista = ["vista","vista para o mar","beira mar","orla"].some(s => textoN.includes(s));

  // Resolve cidade (slug) a partir da lista ativa
  const cidadesValidas = Array.isArray(cidadesAtivas) ? cidadesAtivas : [];
  let cidadeSlug = "";
  if (cidadeProcurada) {
    const alvo = cidadesValidas.find(
      c => normalizarTexto(c.nome) === normalizarTexto(cidadeProcurada) || normalizarTexto(c.slug) === normalizarTexto(cidadeProcurada)
    );
    cidadeSlug = alvo?.slug || "";
  }
  if (!cidadeSlug && cidadesValidas.length > 0) cidadeSlug = cidadesValidas[0].slug;

  // Mapa macro → categorias DB
  const MAPA_CESTA_PARA_CATEGORIAS_DB = {
    comida: ["churrascaria","restaurante","pizzaria","lanchonete","frutos do mar","sushi","padaria","cafeteria","bistrô","bistro","hamburgueria","pizza"],
    bebidas: ["bar","pub","cervejaria","wine bar","balada","boteco"],
    passeios: ["passeio","barco","lancha","escuna","trilha","buggy","quadriciclo","city tour","catamarã","catamara","mergulho","snorkel","gruta","ilha","tour"],
    praias: ["praia","praias","bandeira azul","orla"],
    hospedagem: ["pousada","hotel","hostel","apart","flat","resort","hospedagem"],
    transporte: ["transfer","transporte","aluguel de carro","locadora","taxi","ônibus","onibus","rodoviária","rodoviaria"]
  };

  // Priorização mínima: “carne/picanha” → churrascaria + restaurante
  let categoriasAProcurar = [];
  if (categoriaProcurada) categoriasAProcurar.push(normalizarTexto(categoriaProcurada));

  if (categoriaProcurada === "comida" || (!categoriaProcurada && MAPA_CESTA_PARA_CATEGORIAS_DB.comida)) {
    if (sinaisCarne) {
      categoriasAProcurar = ["churrascaria","restaurante"];
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

  // Termo opcional para RPC
  let termoDeBusca = null;
  if (sinaisCarne) termoDeBusca = "picanha";
  else if (sinaisVista) termoDeBusca = "vista";
  else {
    const termosConhecidos = ["pizza","peixe","rodizio","frutos do mar","moqueca","hamburguer","sushi","bistrô","bistro","barato","família","romântico","vista"];
    const achou = termosConhecidos.find(k => textoN.includes(normalizarTexto(k)));
    if (achou) termoDeBusca = achou;
  }
  if (!termoDeBusca && categoriasAProcurar.length > 0) termoDeBusca = categoriasAProcurar[0];

  // Execução de buscas com limites FIXOS:
  // - inicial: coleta até 3 (aleatórios)
  // - refinamento: coleta até 5 (por relevância)
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
      excludeIds: Array.from(vistos) // evita repetir dentro do loop também
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

  // Seleção final fixa
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
        cidadeSlug
      }
    });
  } catch {}

  return {
    ok: true,
    count: limitados.length,
    items: limitados.map(p => ({
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

async function lidarComNovaBusca({
  textoDoUsuario,
  historicoGemini,
  regiao,
  cidadesAtivas,
  idDaConversa,
  isInitialSearch = true,
  excludeIds = []
}) {
  const entidades = await extrairEntidadesDaBusca(textoDoUsuario);

  const resultadoBusca = await ferramentaBuscarParceirosOuDicas({
    cidadesAtivas,
    argumentosDaFerramenta: entidades,
    textoOriginal: textoDoUsuario,
    isInitialSearch,
    excludeIds
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
      await supabase.from("conversas").update({
        parceiros_sugeridos: parceirosSugeridos,
        parceiro_em_foco: null,
        topico_atual: entidades?.category || null
      }).eq("id", idDaConversa);
    } catch {}
    return { respostaFinal, parceirosSugeridos };
  } else {
    // (T4) Sem resultados → cai em resposta geral BLINDADA
    const respostaModelo = await gerarRespostaGeral(textoDoUsuario, historicoGemini, regiao);
    const respostaFinal = finalizeAssistantResponse({
      modelResponseText: respostaModelo,
      foundPartnersList: [],
      mode: "general"
    });
    return { respostaFinal, parceirosSugeridos: [] };
  }
}

// ============================== ROTAS =======================================
aplicacaoExpress.post("/api/chat/:slugDaRegiao", async (req, res) => {
  try {
    const { slugDaRegiao } = req.params;
    let { message: textoDoUsuario, conversationId } = req.body || {};
    if (!textoDoUsuario || typeof textoDoUsuario !== "string" || !textoDoUsuario.trim()) {
      return res.status(400).json({ error: "O campo 'message' é obrigatório e deve ser uma string não vazia." });
    }
    textoDoUsuario = textoDoUsuario.trim();

    // Resolve região
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

    // ==================== CORREÇÃO CRÍTICA (memória) ====================
    console.log(`[RAIO-X] Recebido do frontend: conversationId = ${conversationId}`);
    if (!conversationId || typeof conversationId !== "string" || conversationId.trim().length < 10) {
      console.log("[RAIO-X] conversationId inválido ou ausente. Gerando um novo.");
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
          topico_atual: null,
          aguardando_refinamento: false
        });
        console.log(`[RAIO-X] Nova conversa criada no DB com ID: ${conversationId}`);
      } catch (e) {
        return res.status(500).json({ error: "Erro ao criar nova conversa.", internal: e });
      }
    } else {
      console.log(`[RAIO-X] Reutilizando conversationId existente: ${conversationId}`);
      // Garante existência no DB (idempotente)
      try {
        const { data: existe } = await supabase
          .from("conversas")
          .select("id")
          .eq("id", conversationId)
          .maybeSingle();
        if (!existe) {
          await supabase.from("conversas").insert({
            id: conversationId,
            regiao_id: regiao.id,
            parceiro_em_foco: null,
            parceiros_sugeridos: [],
            ultima_pergunta_usuario: null,
            ultima_resposta_ia: null,
            preferencia_indicacao: null,
            topico_atual: null,
            aguardando_refinamento: false
          });
          console.log(`[RAIO-X] conversationId informado não existia. Criado agora: ${conversationId}`);
        }
      } catch (e) {
        console.warn("[RAIO-X] Não foi possível validar/garantir a conversa:", e?.message || e);
      }
    }
    // ====================================================================

    // Carrega estado atual da conversa
    let conversaAtual = null;
    try {
      const { data: conv } = await supabase
        .from("conversas")
        .select("id, parceiro_em_foco, preferencia_indicacao, topico_atual, parceiros_sugeridos, aguardando_refinamento")
        .eq("id", conversationId)
        .maybeSingle();
      conversaAtual = conv || null;
    } catch {}

    const historicoGemini = await construirHistoricoParaGemini(conversationId, 12);

    // ==================== NOVO BLOCO: Pedidos de Mídia (antes da seleção) ===
    const textoN = normalizarTexto(textoDoUsuario);
    const pediuFotos = ["foto","fotos","imagens","imagem","ver fotos","mostrar fotos"].some(k => textoN.includes(k));
    const pediuCardapio = ["cardapio","cardápio","menu","preço","preços","tabela de preços"].some(k => textoN.includes(k));

    if ((pediuFotos || pediuCardapio)) {
      if (conversaAtual?.parceiro_em_foco) {
        const foco = conversaAtual.parceiro_em_foco || {};
        const fotos = (foco.fotos_parceiros || []).filter(Boolean);
        const cardapios = foco.links_cardapio_precos || null;

        if (pediuFotos && fotos.length > 0) {
          return res.status(200).json({
            reply: "Claro! Separei algumas fotos do local para você dar uma olhada.",
            photoLinks: fotos,
            conversationId
          });
        }
        if (pediuCardapio && cardapios) {
          return res.status(200).json({
            reply: "Aqui está o cardápio/tabela de preços que tenho cadastrado para este parceiro:",
            menuLinks: cardapios,
            conversationId
          });
        }
        return res.status(200).json({
          reply: "Eu tentei, mas não encontrei essas mídias para este parceiro. Quer que eu verifique outras opções?",
          conversationId
        });
      } else {
        return res.status(200).json({
          reply: "Claro! Mas para eu poder te mostrar, preciso saber: de qual estabelecimento você gostaria de ver as fotos ou o cardápio?",
          conversationId
        });
      }
    }

    // ==================== NOVO BLOCO: Clima (Alteração 1) ====================
    if (pedeClima(textoDoUsuario)) {
      try {
        // Para simplificar, usa a primeira cidade ativa da região
        const cidadeAlvo = cidadesAtivas?.[0] || null;
        if (!cidadeAlvo) {
          return res.status(200).json({
            reply: "Não consegui identificar uma cidade ativa nesta região para consultar os dados climáticos.",
            conversationId
          });
        }

        // Busca os registros mais recentes por tipo_dado
        async function pegar(tipo) {
          const { data, error } = await supabase
            .from("dados_climaticos")
            .select("cidade_id, tipo_dado, dados, data_hora_consulta")
            .eq("cidade_id", cidadeAlvo.id)
            .eq("tipo_dado", tipo)
            .order("data_hora_consulta", { ascending: false, nullsFirst: false })
            .limit(1);
          if (error) throw error;
          return Array.isArray(data) && data.length ? data[0] : null;
        }

        const climaAtual = await pegar("clima_atual");
        const previsao = await pegar("previsao_diaria");
        const mare = await pegar("dados_mare");
        const tempAgua = await pegar("temperatura_agua");

        const agora = new Date();
        const horaAtual = agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

        const contexto = {
          cidade: { id: cidadeAlvo.id, nome: cidadeAlvo.nome, slug: cidadeAlvo.slug },
          clima_atual: climaAtual?.dados ?? null,
          previsao_diaria: previsao?.dados ?? null,
          dados_mare: mare?.dados ?? null,
          temperatura_agua: tempAgua?.dados ?? null
        };

        const promptClima = [
          PROMPT_MESTRE_BEPIT_V13,
          "",
          `HORA ATUAL: ${horaAtual}`,
          `[DADOS DA CIDADE]: ${JSON.stringify(contexto, null, 2)}`,
          `[PERGUNTA DO USUÁRIO]: "${textoDoUsuario}"`,
          "",
          "Com base nas regras, no horário e nos dados acima, gere a melhor resposta possível (natural, útil e contextual)."
        ].join("\n");

        const respostaModelo = await geminiGerarTexto(promptClima);
        const respostaFinal = finalizeAssistantResponse({
          modelResponseText: respostaModelo,
          foundPartnersList: [],
          mode: "general"
        });

        try {
          await supabase.from("interacoes").insert({
            regiao_id: regiao.id,
            conversation_id: conversationId,
            pergunta_usuario: textoDoUsuario,
            resposta_ia: respostaFinal,
            parceiros_sugeridos: []
          });
        } catch {}

        return res.status(200).json({
          reply: respostaFinal,
          conversationId,
          intent: "clima"
        });
      } catch (e) {
        console.warn("[CLIMA] Falha ao montar resposta climática:", e?.message || e);
        // Cai para o fluxo normal se der algo errado
      }
    }

    // ----- REFINO EM ANDAMENTO -----
    if (conversaAtual?.aguardando_refinamento) {
      const criteriosDeBusca = textoDoUsuario;
      const parceirosJaSugeridos = Array.isArray(conversaAtual.parceiros_sugeridos)
        ? conversaAtual.parceiros_sugeridos.map(p => p.id).filter(Boolean)
        : [];

      const r = await lidarComNovaBusca({
        textoDoUsuario: criteriosDeBusca,
        historicoGemini,
        regiao,
        cidadesAtivas,
        idDaConversa: conversationId,
        isInitialSearch: false,
        excludeIds: parceirosJaSugeridos
      });

      await supabase.from("conversas").update({ aguardando_refinamento: false }).eq("id", conversationId);

      const fotos = (r.parceirosSugeridos || []).flatMap(p => p?.fotos_parceiros || []).filter(Boolean);
      return res.status(200).json({ reply: r.respostaFinal, photoLinks: fotos, conversationId, partners: r.parceirosSugeridos });
    }

    // ----- SELEÇÃO DIRETA (ordinal / nome) -----
    const candidatos = Array.isArray(conversaAtual?.parceiros_sugeridos) ? conversaAtual.parceiros_sugeridos : [];
    const parceiroSelecionado = encontrarParceiroNaLista(textoDoUsuario, candidatos);
    if (parceiroSelecionado) {
      try {
        await supabase.from("conversas").update({ parceiro_em_foco: parceiroSelecionado }).eq("id", conversationId);
      } catch {}

      const respostaModelo = await gerarDetalhesDoParceiro(textoDoUsuario, historicoGemini, parceiroSelecionado, regiao?.nome);
      let respostaFinal = respostaModelo;

      // Fluxo de mídia interativa (Tarefa anterior)
      if (Array.isArray(parceiroSelecionado.fotos_parceiros) && parceiroSelecionado.fotos_parceiros.length > 0) {
        respostaFinal += `\n\nEu também tenho algumas fotos do local. Gostaria de ver?`;
      }
      if (parceiroSelecionado.links_cardapio_precos && Object.keys(parceiroSelecionado.links_cardapio_precos).length > 0) {
        respostaFinal += `\n\nPosso te mostrar o cardápio ou a tabela de preços. Você quer dar uma olhada?`;
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
        reply: respostaFinal,
        interactionId,
        photoLinks: fotos,
        conversationId,
        intent: "follow_up_parceiro",
        partners: [parceiroSelecionado]
      });
    }

    // ----- DETECÇÃO "MAIS OPÇÕES" / REFINAMENTO -----
    const palavrasDeRefinamento = ["outras opções","mais","nao gostei","não gostei","outra sugestao","outra sugestão","outras"];
    const pediuRefinamento = palavrasDeRefinamento.some(p => normalizarTexto(textoDoUsuario).includes(p));

    if (pediuRefinamento && Array.isArray(conversaAtual?.parceiros_sugeridos) && conversaAtual.parceiros_sugeridos.length > 0) {
      await supabase.from("conversas").update({ aguardando_refinamento: true }).eq("id", conversationId);

      const perguntaRefinamento = "Ok! Para te ajudar a encontrar a opção ideal, o que você procura? (ex.: mais barato, ambiente para família, rodízio, vista para o mar, etc.)";

      try {
        await supabase.from("interacoes").insert({
          regiao_id: regiao.id,
          conversation_id: conversationId,
          pergunta_usuario: textoDoUsuario,
          resposta_ia: perguntaRefinamento
        });
      } catch {}

      return res.status(200).json({ reply: perguntaRefinamento, conversationId });
    }

    // ----- INTENÇÃO + BUSCA (determinística) -----
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
          excludeIds: []
        });
        respostaFinal = r.respostaFinal;
        parceirosSugeridos = r.parceirosSugeridos;
        break;
      }
      case "pergunta_geral": {
        const respostaModelo = await gerarRespostaGeral(textoDoUsuario, historicoGemini, regiao);
        respostaFinal = finalizeAssistantResponse({ modelResponseText: respostaModelo, foundPartnersList: [], mode: "general" });
        try { await supabase.from("conversas").update({ parceiro_em_foco: null }).eq("id", conversationId); } catch {}
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
    } catch (e) {
      console.warn("[INTERACOES] Falha ao salvar:", e?.message || e);
    }

    const fotos = (parceirosSugeridos || []).flatMap(p => p?.fotos_parceiros || []).filter(Boolean);
    return res.status(200).json({ reply: respostaFinal, interactionId, photoLinks: fotos, conversationId, intent, partners: parceirosSugeridos });

  } catch (erro) {
    console.error("[/api/chat/:slugDaRegiao] Erro:", erro);
    return res.status(500).json({ error: "Erro interno no servidor do BEPIT.", internal: { message: String(erro?.message || erro) } });
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
      .select(`
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
      `)
      .eq("regiao_id", regiao.id)
      .eq("ativo", true)
      .order("periodo_inicio", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false, nullsFirst: false });

    if (erroAvisos) throw erroAvisos;

    const normalized = (avisos || []).map(a => ({
      id: a.id,
      regiao_id: a.regiao_id,
      cidade_id: a.cidade_id,
      cidade_nome: a?.cidades?.nome || null,
      titulo: a.titulo,
      descricao: a.descricao,
      periodo_inicio: a.periodo_inicio,
      periodo_fim: a.periodo_fim,
      ativo: a.ativo === true,
      created_at: a.created_at
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
