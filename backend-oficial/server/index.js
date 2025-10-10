// ============================================================================
// BEPIT Nexus - Servidor (Express) — Orquestrador Lógico v4.0
// - Paginação Inteligente (1ª página: até 3 opções aleatórias do banco)
// - Fluxo de Refinamento ("mais opções" → pergunta de critérios → nova busca)
// - Prioridade para carne/picanha (inclui "piconha"): churrascaria + restaurante
// - Busca tolerante via RPC + pós-processamento (excludeIds / isInitialSearch)
// - Mantém: /api/admin/*, /api/auth/login, health, diag, feedback
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

  // Termos úteis p/ ranking
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
async function analisarIntencaoDoUsuario(textoDoUsuario) {
  if (forcarBuscaParceiro(textoDoUsuario)) return "busca_parceiro";

  // Reduzido (fallback): se não bateu heurística, pergunta ao modelo
  const prompt = `Classifique a frase do usuário em 'busca_parceiro' ou 'pergunta_geral'. Responda só com a string.\nFrase: "${textoDoUsuario}"`;
  try {
    const saida = await geminiGerarTexto(prompt);
    const txt = (saida || "").trim().toLowerCase();
    if (txt === "busca_parceiro" || txt === "pergunta_geral") return txt;
  } catch {}
  return "pergunta_geral";
}

async function gerarRespostaComParceiros(pergunta, historicoContents, parceiros, regiaoNome = "") {
  const historicoTexto = historicoParaTextoSimples(historicoContents);
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

async function gerarRespostaGeral(pergunta, historicoContents, regiao) {
  const historicoTexto = historicoParaTextoSimples(historicoContents);
  const nomeRegiao = regiao?.nome || "Região dos Lagos";
  const prompt = [
    `Você é o BEPIT, um concierge amigável e especialista na região de ${nomeRegiao}.`,
    "Se não houver resultados de parceiros, admita e ofereça ajuda em outros tópicos — sem fingir que tem resultados.",
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
async function ferramentaBuscarParceirosOuDicas({ cidadesAtivas, argumentosDaFerramenta, textoOriginal, isInitialSearch = false, excludeIds = [] }) {
  const categoriaProcurada = (argumentosDaFerramenta?.category || "").trim();
  const cidadeProcurada = (argumentosDaFerramenta?.city || "").trim();
  const listaDeTermos = Array.isArray(argumentosDaFerramenta?.terms) ? argumentosDaFerramenta.terms : [];

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

  // Mapa macro → categorias
  const MAPA_CESTA_PARA_CATEGORIAS_DB = {
    comida: ["churrascaria","restaurante","pizzaria","lanchonete","frutos do mar","sushi","padaria","cafeteria","bistrô","bistro","hamburgueria","pizza"],
    bebidas: ["bar","pub","cervejaria","wine bar","balada","boteco"],
    passeios: ["passeio","barco","lancha","escuna","trilha","buggy","quadriciclo","city tour","catamarã","catamara","mergulho","snorkel","gruta","ilha","tour"],
    praias: ["praia","praias","bandeira azul","orla"],
    hospedagem: ["pousada","hotel","hostel","apart","flat","resort","hospedagem"],
    transporte: ["transfer","transporte","aluguel de carro","locadora","taxi","ônibus","onibus","rodoviária","rodoviaria"]
  };

  // ------------- PRIORIZAÇÃO INTELIGENTE -------------
  // Base inicial
  let categoriasAProcurar = [];
  if (categoriaProcurada) categoriasAProcurar.push(normalizarTexto(categoriaProcurada));

  // Macro "comida" com sinais de carne → prioriza churrascaria+restaurante
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

  // Termo “inteligente”
  let termoDeBusca = null;
  if (sinaisCarne) termoDeBusca = "picanha";
  else if (sinaisVista) termoDeBusca = "vista";
  else {
    const termosConhecidos = ["pizza","peixe","rodizio","frutos do mar","moqueca","hamburguer","sushi","bistrô","bistro","barato","família","romântico","vista"];
    const achou = termosConhecidos.find(k => textoN.includes(normalizarTexto(k)));
    if (achou) termoDeBusca = achou;
  }
  if (!termoDeBusca && categoriasAProcurar.length > 0) termoDeBusca = categoriasAProcurar[0];

  // Execução de buscas
  const agregados = [];
  const vistos = new Set();
  for (const cat of categoriasAProcurar) {
    const r = await buscarParceirosTolerante({
      cidadeSlug,
      categoria: cat,
      term: termoDeBusca,
      limit: 8,
      isInitialSearch,
      excludeIds
    });
    if (r.ok && Array.isArray(r.items)) {
      for (const it of r.items) {
        if (it?.id && !vistos.has(it.id)) {
          vistos.add(it.id);
          agregados.push(it);
        }
      }
    }
    if (isInitialSearch && agregados.length >= 3) break;
    if (!isInitialSearch && agregados.length >= 8) break;
  }

  agregados.sort((a, b) => (a.tipo === "DICA" ? 1 : 0) - (b.tipo === "DICA" ? 1 : 0));
  const limitados = isInitialSearch ? agregados.slice(0, 3) : agregados.slice(0, 8);

  try {
    await supabase.from("eventos_analytics").insert({
      tipo_evento: "partner_query",
      payload: {
        termos: listaDeTermos,
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

async function lidarComNovaBusca({ textoDoUsuario, historicoGemini, regiao, cidadesAtivas, idDaConversa, isInitialSearch = true, excludeIds = [] }) {
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

    const { data: regiao, error: erroRegiao } = await supabase.from("regioes").select("id, nome, slug, ativo").eq("slug", slugDaRegiao).single();
    if (erroRegiao || !regiao) return res.status(404).json({ error: "Região não encontrada." });
    if (regiao.ativo === false) return res.status(403).json({ error: "Região desativada." });

    const { data: cidades, error: erroCidades } = await supabase.from("cidades").select("id, nome, slug, lat, lng, ativo").eq("regiao_id", regiao.id);
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
          topico_atual: null,
          aguardando_refinamento: false
        });
      } catch (e) {
        return res.status(500).json({ error: "Erro ao criar conversa.", internal: e });
      }
    }

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

    // --- INÍCIO DO NOVO FLUXO DE REFINAMENTO ---
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
    // --- FIM DO NOVO FLUXO DE REFINAMENTO ---

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

    // --- DETECÇÃO "MAIS OPÇÕES" / REFINAMENTO ---
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

    // Intenção + busca
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
          isInitialSearch: true,   // 1ª página → 3 aleatórios
          excludeIds: []           // nada a excluir na 1ª página
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
