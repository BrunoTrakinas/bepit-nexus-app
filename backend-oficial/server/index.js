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
  buildNoPartnerFallback,
  BEPIT_SYSTEM_PROMPT_APPENDIX
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

// ============================== HELPERS =====================================
function normalizarTexto(texto) {
  return String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
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

function forcarBuscaParceiro(texto) {
  const t = normalizarTexto(texto);
  for (const lista of Object.values(PALAVRAS_CHAVE)) {
    if (lista.some(p => t.includes(p))) return true;
  }
  return false;
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
// Retorna "busca_parceiro" se bater palavra-chave; caso contrário, "pergunta_geral".
async function analisarIntencaoDoUsuario(textoDoUsuario) {
  return forcarBuscaParceiro(textoDoUsuario) ? "busca_parceiro" : "pergunta_geral";
}

async function gerarRespostaComParceiros(pergunta, historicoContents, parceiros, regiaoNome = "") {
  const historicoTexto = historicoParaTextoSimplesWrapper(historicoContents);
  const contextoParceiros = JSON.stringify(parceiros ?? [], null, 2);
  const prompt = [
    "Você é um assistente de consulta de dados. Sua única função é apresentar os resultados encontrados de forma clara e objetiva.",
    "Apresente os estabelecimentos do [Contexto] em formato de lista. Use os dados fornecidos e nada mais.",
    "Comece a resposta diretamente com 'Claro, encontrei estas opções para você:' ou frase similar e apresente a lista.",
    "DEPOIS da lista completa, faça UMA pergunta curta para oferecer mais ajuda (ex.: 'Quer que eu refine por preço ou estilo?').",
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

// (T3) Prompt blindado (Regra de Ouro inquebrável) — NUNCA inventar estabelecimentos.
async function gerarRespostaGeral(pergunta, historicoContents, regiao) {
  const historicoTexto = historicoParaTextoSimplesWrapper(historicoContents);
  const nomeRegiao = regiao?.nome || "Região dos Lagos";

  const prompt = [
    `Você é o BEPIT, um concierge amigável e especialista na região de ${nomeRegiao}.`,
    "Sua principal função é responder perguntas gerais sobre a região (história, geografia, dicas de segurança, etc.).",
    "**REGRA DE OURO INQUEBRÁVEL:** Você é **ESTRITAMENTE PROIBIDO** de inventar ou sugerir nomes de estabelecimentos comerciais (restaurantes, hotéis, passeios, lojas, etc.) que não foram fornecidos a você em uma lista de [Contexto].",
    "Se o usuário pedir uma sugestão de estabelecimento e você não tiver uma lista de [Contexto], sua ÚNICA resposta permitida é dizer que não encontrou um parceiro cadastrado para aquela solicitação específica e perguntar se pode ajudar com outra coisa.",
    "NUNCA finja que tem resultados. NUNCA use seu conhecimento geral para sugerir um nome comercial.",
    "",
    BEPIT_SYSTEM_PROMPT_APPENDIX,
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

      const respostaModelo = await gerarRespostaComParceiros(textoDoUsuario, historicoGemini, [parceiroSelecionado], regiao?.nome);
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
