// ============================================================================
// BEPIT Nexus - Servidor (Express) — Orquestrador Lógico v4.0
// - Base: sua v3.5 otimizada (mantido).
// - Novidades:
//   * Paginação Inteligente: 1ª busca = 3 aleatórios relevantes (sem repetir depois)
//   * Fluxo de Refinamento: "outras opções"/"mais" => pergunta critérios + nova busca sem repetir
// - Rotas e guardrails preservados.
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
import { buscarParceirosTolerante, normalizeTerm as normalizeSearchTerm } from "./utils/searchPartners.js";

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
    "gemini-1.5-pro-latest",
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

function historicoParaTextoSimples(contents) {
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

// ============================== HEURÍSTICA DE INTENÇÃO ======================
const PALAVRAS_CHAVE = {
  comida: ["restaurante", "restaurantes", "almoço", "almoco", "jantar", "comer", "comida", "picanha", "piconha", "carne", "churrasco", "churrascaria", "pizza", "pizzaria", "peixe", "frutos do mar", "moqueca", "rodizio", "rodízio", "lanchonete", "burger", "hamburguer", "hambúrguer", "bistrô", "bistro"],
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

function inferirCestaCategoria(texto) {
  const t = normalizarTexto(texto);
  if (PALAVRAS_CHAVE.comida.some(p => t.includes(p))) return "comida";
  if (PALAVRAS_CHAVE.hospedagem.some(p => t.includes(p))) return "hospedagem";
  if (PALAVRAS_CHAVE.bebidas.some(p => t.includes(p))) return "bebidas";
  if (PALAVRAS_CHAVE.passeios.some(p => t.includes(p))) return "passeios";
  if (PALAVRAS_CHAVE.praias.some(p => t.includes(p))) return "praias";
  if (PALAVRAS_CHAVE.transporte.some(p => t.includes(p))) return "transporte";
  return null;
}

const MAPA_CESTA_PARA_CATEGORIAS_DB = {
  comida: ["restaurante", "pizzaria", "churrascaria", "lanchonete", "frutos do mar", "sushi", "padaria", "cafeteria", "bistrô", "bistro", "hamburgueria", "pizza"],
  bebidas: ["bar", "pub", "cervejaria", "wine bar", "balada", "boteco"],
  passeios: ["passeio", "passeios", "barco", "lancha", "escuna", "trilha", "buggy", "quadriciclo", "city tour", "catamarã", "catamara", "mergulho", "snorkel", "gruta", "ilha", "tour"],
  praias: ["praia", "praias", "bandeira azul", "orla"],
  hospedagem: ["pousada", "hotel", "hostel", "apart", "flat", "resort", "hospedagem"],
  transporte: ["transfer", "transporte", "aluguel de carro", "locadora", "taxi", "ônibus", "onibus", "rodoviária", "rodoviaria"]
};

// ============================== FERRAMENTAS E PROMPTS =======================

// Extrator simples (sem IA) para cidade/cesta; mantido.
async function extrairEntidadesDaBusca(texto) {
  const cesta = inferirCestaCategoria(texto || "");
  const categoria = cesta || null;

  let cidade = null;
  const textoNorm = normalizarTexto(texto || "");
  if (textoNorm.includes("cabo frio")) cidade = "Cabo Frio";
  else if (textoNorm.includes("buzios")) cidade = "Búzios";
  else if (textoNorm.includes("arraial")) cidade = "Arraial do Cabo";

  return { category: categoria, city: cidade, terms: [] };
}

// ============================== FERRAMENTA DE BUSCA (versão com reforço p/ picanha + logs) =======================
async function ferramentaBuscarParceirosOuDicas({ cidadesAtivas, argumentosDaFerramenta, textoOriginal, isInitialSearch = true, excludeIds = [] }) {
  const categoriaProcurada = (argumentosDaFerramenta?.category || "").trim();
  const cidadeProcurada = (argumentosDaFerramenta?.city || "").trim();
  const listaDeTermos = Array.isArray(argumentosDaFerramenta?.terms) ? argumentosDaFerramenta.terms : [];

  // 1) Cesta inferida pelas palavras-chave
  const cestaInferida = inferirCestaCategoria(textoOriginal || "");

  // 2) Resolve cidade (slug)
  const cidadesValidas = Array.isArray(cidadesAtivas) ? cidadesAtivas : [];
  let cidadeSlug = "";
  if (cidadeProcurada) {
    const alvo = cidadesValidas.find(
      c => normalizarTexto(c.nome) === normalizarTexto(cidadeProcurada) ||
           normalizarTexto(c.slug) === normalizarTexto(cidadeProcurada)
    );
    cidadeSlug = alvo?.slug || "";
  }
  if (!cidadeSlug && cidadesValidas.length > 0) {
    cidadeSlug = cidadesValidas[0].slug; // fallback: 1ª cidade ativa da região
  }

  // 3) Monta lista de categorias baseadas na cesta + explícita
  const categoriasBaseDaCesta = cestaInferida ? (MAPA_CESTA_PARA_CATEGORIAS_DB[cestaInferida] || []) : [];
  const categoriasAProcurar = [];
  if (categoriaProcurada) categoriasAProcurar.push(normalizarTexto(categoriaProcurada));
  for (const cat of categoriasBaseDaCesta) {
    const cn = normalizarTexto(cat);
    if (!categoriasAProcurar.includes(cn)) categoriasAProcurar.push(cn);
  }
  // Heurística suave: se “comida” e nada explícito, partimos de “restaurante”
  if (categoriasAProcurar.length === 0 && cestaInferida === "comida") categoriasAProcurar.push("restaurante");

  // 4) **Reforço específico para picanha** (ou typo piconha):
  //    Sempre incluir “churrascaria” e “restaurante” entre as categorias quando detectar “picanha/piconha”
  const textoN = normalizarTexto(textoOriginal || "");
  const querPicanha = textoN.includes("picanha") || textoN.includes("piconha");
  if (querPicanha) {
    for (const fixa of ["churrascaria", "restaurante"]) {
      if (!categoriasAProcurar.includes(fixa)) categoriasAProcurar.push(fixa);
    }
  }

  // 5) LOGS de depuração da busca (apenas console)
  console.log("[BUSCA] cidadeSlug=", cidadeSlug, "| categoriasAProcurar=", categoriasAProcurar, "| querPicanha=", querPicanha, "| termos=", listaDeTermos);

  // 6) Termo “inteligente” por categoria (prioriza palavra específica no texto)
  const resultados = [];
  for (const cat of categoriasAProcurar) {
    let termoDeBusca = null;

    // prioridade 1: palavras de COMIDA presentes no texto (inclui picanha/piconha)
    termoDeBusca = PALAVRAS_CHAVE.comida.find(p => textoN.includes(p)) || null;
    // prioridade 2: se nada, usa a própria categoria
    if (!termoDeBusca) termoDeBusca = cat;

    // Chama a busca tolerante (com paginação inicial aleatória e exclusão de IDs quando aplicável)
    const r = await buscarParceirosTolerante({
      cidadeSlug,
      categoria: cat,
      term: termoDeBusca,
      limit: 24,
      isInitialSearch: Boolean(isInitialSearch),
      excludeIds: Array.isArray(excludeIds) ? excludeIds : []
    });

    console.log(`[BUSCA] categoria='${cat}' termo='${termoDeBusca}' -> ok=${r.ok} itens=${Array.isArray(r.items) ? r.items.length : 0}`);

    if (r.ok && r.items.length > 0) {
      for (const it of r.items) resultados.push(it);
    }
  }

  // 7) Dedup por id
  const mapaResultados = new Map(resultados.map(p => [p.id, p]));
  let acumulado = Array.from(mapaResultados.values());

  // 8) Ordena PARCEIRO antes de DICA e limita
  acumulado.sort((a, b) => (a.tipo === "DICA" ? 1 : 0) - (b.tipo === "DICA" ? 1 : 0));
  const limitados = acumulado.slice(0, 8);

  // 9) Analytics leve
  try {
    await supabase.from("eventos_analytics").insert({
      tipo_evento: "partner_query",
      payload: {
        termos: listaDeTermos,
        categoriaProcurada,
        cestaInferida,
        categoriasAplicadas: categoriasAProcurar,
        cidadeProcurada,
        cidadeSlug,
        total_filtrado: limitados.length
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

// PROMPTS (mantidos, com instruções de listar parceiros)
async function gerarRespostaComParceiros(pergunta, historicoContents, parceiros, regiaoNome = "") {
  const historicoTexto = historicoParaTextoSimples(historicoContents);
  const contextoParceiros = JSON.stringify(parceiros ?? [], null, 2);
  const prompt = [
    "Você é um assistente de consulta de dados. Sua única função é apresentar os resultados encontrados de forma clara e objetiva.",
    "Apresente os estabelecimentos do [Contexto] em formato de lista. Use os dados fornecidos e nada mais.",
    "Comece a resposta diretamente com 'Claro, encontrei estas opções para você:' ou uma frase similar e apresente a lista.",
    "DEPOIS de apresentar a lista completa, você PODE fazer uma pergunta curta para oferecer mais ajuda, como 'Alguma delas te interessou mais?' ou 'Posso ajudar com mais detalhes sobre alguma delas?'.",
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
    `Você é o BEPIT, um concierge amigável e especialista na região de ${nomeRegiao}.`,
    "Sua principal função é responder perguntas gerais sobre a região ou, se não souber a resposta, admitir honestamente.",
    "Se a pergunta for sobre indicações específicas (restaurante, hotel, passeio) e você foi chamado sem uma lista de contexto, significa que não foram encontrados resultados. Neste caso, informe ao usuário que você não possui cadastros para aquela solicitação específica, mas que pode ajudar com outras coisas.",
    "NUNCA finja que tem resultados fazendo perguntas para refinar uma busca que já falhou.",
    "",
    BEPIT_SYSTEM_PROMPT_APPENDIX,
    "",
    `[Histórico]:\n${historicoTexto}`,
    `[Pergunta]: "${pergunta}"`
  ].join("\n");
  return await geminiGerarTexto(prompt);
}

async function analisarIntencaoDoUsuario(textoDoUsuario) {
  if (forcarBuscaParceiro(textoDoUsuario)) return "busca_parceiro";

  const prompt = `Sua única tarefa é analisar a frase do usuário e classificá-la em uma das seguintes categorias: 'busca_parceiro', 'pergunta_geral'. Responda apenas com a string da categoria. Frase: "${textoDoUsuario}"`;
  const saida = await geminiGerarTexto(prompt);
  const text = (saida || "").trim().toLowerCase();

  const classes = new Set(["busca_parceiro", "pergunta_geral"]);
  const r = classes.has(text) ? text : "pergunta_geral";

  if (r !== "busca_parceiro" && forcarBuscaParceiro(textoDoUsuario)) {
    return "busca_parceiro";
  }
  return r;
}

function encontrarParceiroNaLista(textoDoUsuario, listaDeParceiros) {
  try {
    const texto = normalizarTexto(textoDoUsuario);
    if (!Array.isArray(listaDeParceiros) || listaDeParceeiros.length === 0) return null;
  } catch {}
  try {
    const texto = normalizarTexto(textoDoUsuario);
    if (!Array.isArray(listaDeParceiros) || listaDeParceiros.length === 0) return null;

    const matchNumero = texto.match(/\b(\d{1,2})(?:º|o|a|\.|°)?\b/);
    if (matchNumero) {
      const idx = Number(matchNumero[1]);
      if (Number.isFinite(idx) && idx >= 1 && idx <= listaDeParceiros.length) return listaDeParceiros[idx - 1];
    }

    const ordinais = ["primeiro", "segundo", "terceiro", "quarto", "quinto", "sexto", "sétimo", "setimo", "oitavo"];
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

// ====== NOVO FLUXO: chamada de busca com paginação inteligente/refinamento ====
async function lidarComNovaBusca({
  textoDoUsuario,
  historicoGemini,
  regiao,
  cidadesAtivas,
  idDaConversa,
  isInitialSearch = false,
  excludeIds = []
}) {
  const entidades = await extrairEntidadesDaBusca(textoDoUsuario);

  const resultadoBusca = await ferramentaBuscarParceirosOuDicas({
    cidadesAtivas,
    argumentosDaFerramenta: entidades,
    textoOriginal: textoDoUsuario,
    isInitialSearch: true,
  excludeIds: []
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

// ------------------------------ CHAT ----------------------------------------
aplicacaoExpress.post("/api/chat/:slugDaRegiao", async (req, res) => {
  try {
    const { slugDaRegiao } = req.params;
    let { message: textoDoUsuario, conversationId } = req.body || {};
    if (!textoDoUsuario || typeof textoDoUsuario !== "string" || !textoDoUsuario.trim()) {
      return res.status(400).json({ error: "O campo 'message' é obrigatório e deve ser uma string não vazia." });
    }
    textoDoUsuario = textoDoUsuario.trim();

    const { data: regiao, error: erroRegiao } = await supabase.from("regioes").select("id, nome, slug, ativo").eq("slug", slugDaRegiao).single();
    if (erroRegiao || !regiao) return res.status(404).json({ error: "Região não encontrada." });
    if (regiao.ativo === false) return res.status(403).json({ error: "Região desativada." });

    const { data: cidades, error: erroCidades } = await supabase.from("cidades").select("id, nome, slug, lat, lng, ativo").eq("regiao_id", regiao.id);
    if (erroCidades) return res.status(500).json({ error: "Erro ao carregar cidades.", internal: erroCidades });
    const cidadesAtivas = (cidades || []).filter(c => c.ativo !== false);

    if (!conversationId || typeof conversationId !== "string" || !conversationId.trim()) {
      conversationId = randomUUID();
      try {
        await supabase.from("conversas").insert({ id: conversationId, regiao_id: regiao.id });
      } catch (e) {
        return res.status(500).json({ error: "Erro ao criar conversa.", internal: e });
      }
    }

    let conversaAtual = null;
    try {
      const { data: conv } = await supabase
        .from("conversas")
        .select("id, parceiro_em_foco, parceiros_sugeridos, aguardando_refinamento")
        .eq("id", conversationId)
        .maybeSingle();
      conversaAtual = conv || null;
    } catch {}

    const historicoGemini = await construirHistoricoParaGemini(conversationId, 12);

    // ================= INÍCIO: NOVO FLUXO DE REFINAMENTO ===================
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

      try {
        await supabase.from("conversas").update({ aguardando_refinamento: false }).eq("id", conversationId);
      } catch {}

      const fotos = (r.parceirosSugeridos || []).flatMap(p => p?.fotos_parceiros || []).filter(Boolean);
      return res.status(200).json({
        reply: r.respostaFinal,
        photoLinks: fotos,
        conversationId,
        partners: r.parceirosSugeridos
      });
    }
    // ================== FIM: NOVO FLUXO DE REFINAMENTO =====================

    // Seleção direta por "1º/2º" ou nome
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
        const { data: nova } = await supabase.from("interacoes").insert({
          regiao_id: regiao.id,
          conversation_id: conversationId,
          pergunta_usuario: textoDoUsuario,
          resposta_ia: respostaCurtaSegura,
          parceiros_sugeridos: [parceiroSelecionado]
        }).select("id").single();
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

    // ↓↓↓ NOVO: detecção de pedido por "mais/outras opções"
    const palavrasDeRefinamento = ["outras opções", "outras", "mais opções", "mais", "não gostei", "nao gostei", "outra sugestão", "outra sugestao"];
    const pediuRefinamento = palavrasDeRefinamento.some(p => normalizarTexto(textoDoUsuario).includes(p));
    if (pediuRefinamento && Array.isArray(conversaAtual?.parceiros_sugeridos) && conversaAtual.parceiros_sugeridos.length > 0) {
      const perguntaRefinamento = "Ok! Para te ajudar a encontrar a opção ideal, o que você procura? (Ex.: mais barato, ambiente família, vista para o mar, rodízio, etc.)";
      try {
        await supabase.from("conversas").update({ aguardando_refinamento: true }).eq("id", conversationId);
        await supabase.from("interacoes").insert({
          regiao_id: regiao.id,
          conversation_id: conversationId,
          pergunta_usuario: textoDoUsuario,
          resposta_ia: perguntaRefinamento
        });
      } catch (e) {
        console.warn("[REFINAMENTO] Falha ao registrar estado:", e?.message || e);
      }
      return res.status(200).json({ reply: perguntaRefinamento, conversationId });
    }

    // Intenção
    const intent = await analisarIntencaoDoUsuario(textoDoUsuario);
    let respostaFinal = "";
    let parceirosSugeridos = [];

    switch (intent) {
      case "busca_parceiro": {
        // PRIMEIRA BUSCA: paginação inteligente (3 aleatórios)
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
    return res.status(200).json({
      reply: respostaFinal,
      interactionId,
      photoLinks: fotos,
      conversationId,
      intent,
      partners: parceirosSugeridos
    });

  } catch (erro) {
    console.error("[/api/chat/:slugDaRegiao] Erro:", erro);
    return res.status(500).json({ error: "Erro interno no servidor do BEPIT.", internal: { message: String(erro?.message || erro) } });
  }
});

// ------------------------------ FEEDBACK ------------------------------------
aplicacaoExpress.post("/api/feedback", async (req, res) => {
  try {
    const { interactionId, feedback } = req.body || {};
    if (!interactionId || typeof interactionId !== "string") return res.status(400).json({ error: "interactionId é obrigatório (uuid)." });
    if (!feedback || typeof feedback !== "string" || !feedback.trim()) return res.status(400).json({ error: "feedback é obrigatório (string não vazia)." });

    const { error } = await supabase.from("interacoes").update({ feedback_usuario: feedback }).eq("id", interactionId);
    if (error) return res.status(500).json({ error: "Erro ao registrar feedback." });

    try { await supabase.from("eventos_analytics").insert({ tipo_evento: "feedback", payload: { interactionId, feedback } }); } catch {}
    res.json({ success: true });
  } catch (erro) {
    console.error("[/api/feedback] Erro:", erro);
    res.status(500).json({ error: "Erro interno." });
  }
});

// ------------------------------ HEALTH/DIAG ---------------------------------
aplicacaoExpress.get("/health", (_req, res) => res.status(200).json({ ok: true, message: "Servidor BEPIT Nexus online", port: String(portaDoServidor) }));
aplicacaoExpress.get("/api/health", (_req, res) => res.status(200).json({ ok: true, scope: "api", message: "BEPIT Nexus API ok", port: String(portaDoServidor) }));
aplicacaoExpress.get("/api/health/db", async (_req, res) => {
  try {
    const { data, error } = await supabase.from("regioes").select("id").limit(1);
    if (error) throw error;
    res.json({ ok: true, sample: data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_error", internal: e });
  }
});
aplicacaoExpress.get("/api/diag/gemini", async (_req, res) => {
  try {
    if (!usarGeminiREST) return res.status(200).json({ ok: false, modo: "SDK", info: "USE_GEMINI_REST não está ativo." });
    const modelos = await listarModelosREST();
    let escolhido = null; let ping = null;
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

// ------------------------------ ADMIN ---------------------------------------
function exigirChaveDeAdministrador(req, res, next) {
  const chave = req.headers["x-admin-key"];
  if (!chave || chave !== (process.env.ADMIN_API_KEY || "")) return res.status(401).json({ error: "Chave administrativa inválida ou ausente." });
  next();
}

aplicacaoExpress.post("/api/auth/login", async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key || typeof key !== "string") return res.status(400).json({ error: "missing_key" });
    const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";
    if (ADMIN_API_KEY && key === ADMIN_API_KEY) return res.status(200).json({ ok: true });
    return res.status(401).json({ error: "invalid_key" });
  } catch (erro) {
    console.error("[/api/auth/login] Erro:", erro);
    return res.status(500).json({ error: "server_error" });
  }
});

aplicacaoExpress.post("/api/admin/parceiros", exigirChaveDeAdministrador, async (req, res) => {
  try {
    const { regiaoSlug, cidadeSlug, ...rest } = req.body || {};
    const { data: regiao } = await supabase.from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (!regiao) return res.status(400).json({ error: "regiaoSlug inválido." });

    const { data: cidade } = await supabase.from("cidades").select("id").eq("regiao_id", regiao.id).eq("slug", cidadeSlug).single();
    if (!cidade) return res.status(400).json({ error: "cidadeSlug inválido." });

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
    if (error) throw error;
    return res.status(201).json({ ok: true, data });
  } catch (erro) {
    console.error("[/api/admin/parceiros POST] Erro:", erro);
    return res.status(500).json({ error: "Erro interno." });
  }
});

aplicacaoExpress.get("/api/admin/parceiros/:regiaoSlug/:cidadeSlug", exigirChaveDeAdministrador, async (req, res) => {
  try {
    const { regiaoSlug, cidadeSlug } = req.params;
    const { data: regiao } = await supabase.from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (!regiao) return res.status(400).json({ error: "regiaoSlug inválido." });

    const { data: cidade } = await supabase.from("cidades").select("id").eq("regiao_id", regiao.id).eq("slug", cidadeSlug).single();
    if (!cidade) return res.status(400).json({ error: "cidadeSlug inválido." });

    const { data, error } = await supabase.from("parceiros").select("*").eq("cidade_id", cidade.id).order("nome");
    if (error) throw error;
    return res.status(200).json({ data });
  } catch (erro) {
    console.error("[/api/admin/parceiros GET] Erro:", erro);
    return res.status(500).json({ error: "Erro interno." });
  }
});

// ============================== START =======================================
aplicacaoExpress.listen(portaDoServidor, () => {
  console.log(`✅ BEPIT Nexus (Orquestrador v4.0) rodando em http://localhost:${portaDoServidor}`);
});
