// ============================================================================
// BEPIT Nexus - Servidor (Express) — Orquestrador Lógico v3.2
// - Stack/Imports: ESM, Supabase, GoogleGenerativeAI
// - v3.2 (polimento final):
//   FIX 1: photoLinks -> extrai fotosDosParceiros do parceirosSugeridos
//   FIX 2: refatoração switch com função auxiliar lidarComNovaBusca(...)
//   FIX 3: seleção de parceiro por índice/nome (encontrarParceiroNaLista(...))
//   FIX 4: remoção da rota /api/conversation/preference (frontend sem botões)
//   FIX 5: prompts mais tolerantes a typos/abreviações e regra de pedir esclarecimentos
// - REMOVIDO: Function Calling, loop while, tools em generateContent,
//             construirInstrucaoDeSistema, rota /api/conversation/preference
// - MANTIDO: ferramentas RAG/rota/preferência (uso interno), histórico, admin, feedback, CORS, RAW_MODE
// ============================================================================

import "dotenv/config";

import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { supabase } from "../lib/supabaseClient.js";

// ============================== CONFIGURAÇÃO BÁSICA =========================
const aplicacaoExpress = express();
const portaDoServidor = process.env.PORT || 3002;

aplicacaoExpress.use(express.json({ limit: "1mb" }));

// --------------------------------- CORS ------------------------------------
function origemPermitida(origem) {
  if (!origem) return true; // curl/Postman
  try {
    const url = new URL(origem);
    if (url.hostname === "localhost") return true;
    if (url.host === "bepitnexus.netlify.app") return true;
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
    credentials: true
  })
);
aplicacaoExpress.options("*", cors());

// ------------------------------- GEMINI -------------------------------------
const clienteGemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const modeloPreferidoGemini = (process.env.GEMINI_MODEL || "").trim();
const candidatosDeModeloGemini = [
  modeloPreferidoGemini || null,
  "gemini-1.5-pro-latest",
  "gemini-1.5-flash-latest",
  "gemini-1.5-pro",
  "gemini-pro"
].filter(Boolean);

let modeloGeminiEmUso = null;

async function obterModeloGemini() {
  if (modeloGeminiEmUso) return clienteGemini.getGenerativeModel({ model: modeloGeminiEmUso });
  let ultimoErro = null;
  for (const nomeModelo of candidatosDeModeloGemini) {
    try {
      const testeModelo = clienteGemini.getGenerativeModel({ model: nomeModelo });
      await testeModelo.generateContent({ contents: [{ role: "user", parts: [{ text: "ok" }] }] });
      modeloGeminiEmUso = nomeModelo;
      console.log(`[GEMINI] Modelo selecionado: ${nomeModelo}`);
      return testeModelo;
    } catch (erro) {
      ultimoErro = erro;
      console.warn(`[GEMINI] Falha ao usar modelo ${nomeModelo}: ${erro?.message || erro}`);
    }
  }
  throw ultimoErro || new Error("Nenhum modelo Gemini disponível no momento.");
}

const modoCruSemRegrasAtivo = process.env.RAW_MODE === "1";

// ------------------------------ FUNÇÕES AUXILIARES --------------------------
function normalizarTexto(texto) {
  return String(texto || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

async function obterClimaLatest({ cidadeId, tipoDado = null }) {
  try {
    let q = supabase
      .from("vw_dados_climaticos_latest")
      .select("cidade_id, cidade_nome, tipo_dado, ts, dados, fonte, tipo, payload, updated_at, created_at")
      .eq("cidade_id", cidadeId)
      .order("ts", { ascending: false })
      .limit(20);

    if (tipoDado) q = q.eq("tipo_dado", tipoDado);

    const { data, error } = await q;
    if (error) return null;

    // Se veio lista, pegamos o primeiro (mais recente)
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;

    // “dados” é o principal; “payload” pode existir também
    const dados = row.dados || row.payload || {};
    return {
      cidade_id: row.cidade_id,
      cidade_nome: row.cidade_nome,
      tipo_dado: row.tipo_dado,
      ts: row.ts || row.updated_at || row.created_at,
      fonte: row.fonte || null,
      dados
    };
  } catch {
    return null;
  }
}

// ============================ ZONAS / AUTORIDADE ============================

// Serviços privados (monetizáveis) => BD obrigatório (não pode inventar)
const CATEGORIAS_PRIVADAS = [
  "restaurante", "pizzaria", "hamburguer", "hambúrguer", "churrasco", "picanha",
  "bar", "barzinho", "pub", "cervejaria",
  "show", "shows", "musica ao vivo", "música ao vivo", "balada", "boate",
  "passeio", "passeios", "barco", "barco-táxi", "barco taxi", "escuna", "lancha", "mergulho", "trilha guiada",
  "transfer", "táxi", "taxi", "uber", "aluguel", "buggy", "quadriciclo",
  "hospedagem", "hotel", "pousada", "airbnb", "hostel",
  "lavanderia"
];

// Tópicos públicos/factuais => IA pode responder, MAS sem inventar promo e sem “chutar números”
const TOPICOS_PUBLICOS = [
  "historia", "história", "curiosidade", "cultura",
  "como chegar", "rota", "distancia", "distância", "mapa", "como ir",
  "clima", "tempo", "chuva", "vento", "previsao", "previsão", "temperatura", "onda", "mar",
  "emergencia", "emergência", "hospital", "upa", "pronto socorro", "delegacia",
  "prefeitura", "rodoviaria", "rodoviária", "aeroporto", "shopping"
];

const KEYWORDS_PROMO = ["desconto", "cupom", "%", "grátis", "gratis", "brinde", "promo", "promoção", "promocao", "fale que foi indicado", "indicado pelo bepit"];

function perguntaEhSobreClima(texto) {
  const t = normalizarTexto(texto);
  return ["clima","tempo","chuva","vento","temperatura","mar","onda","agua","água"].some(k => t.includes(k));
}

function textoTemAlgumTermo(textoNormalizado, lista) {
  return lista.some((t) => textoNormalizado.includes(normalizarTexto(t)));
}

function isTopicoPublico(textoDoUsuario) {
  const t = normalizarTexto(textoDoUsuario);
  return textoTemAlgumTermo(t, TOPICOS_PUBLICOS);
}

function isServicoPrivado(textoDoUsuario, entidades) {
  const t = normalizarTexto(textoDoUsuario);
  const cat = normalizarTexto(entidades?.category || "");
  if (cat && textoTemAlgumTermo(cat, CATEGORIAS_PRIVADAS)) return true;
  return textoTemAlgumTermo(t, CATEGORIAS_PRIVADAS);
}
function limparNomesForaDoBD(texto, parceirosSugeridos) {
  const nomesPermitidos = new Set(
    (Array.isArray(parceirosSugeridos) ? parceirosSugeridos : [])
      .map(p => normalizarTexto(p?.nome || ""))
      .filter(Boolean)
  );

  // Se não tem parceiros, não pode citar estabelecimentos como “indicação”
  if (nomesPermitidos.size === 0) return texto;

  // Heurística simples: remove linhas que citem nomes muito específicos que não estejam na lista.
  // (Não é perfeito, mas reduz MUITO risco.)
  const linhas = String(texto || "").split("\n");
  const filtradas = linhas.filter(l => {
    const ln = normalizarTexto(l);
    // se a linha menciona "restaurante|bar|pousada|hotel|café" e traz um nome, mas nenhum nome permitido aparece, remove.
    const falaDeLugar = ["restaurante","bar","pousada","hotel","cafe","cafeteria","pizzaria"].some(k => ln.includes(k));
    if (!falaDeLugar) return true;
    const mencionaPermitido = Array.from(nomesPermitidos).some(n => n && ln.includes(n));
    return mencionaPermitido;
  });

  const out = filtradas.join("\n").trim();
  return out || "Eu só posso indicar parceiros cadastrados. Me diga a cidade e o tipo de lugar, que eu busco na lista oficial.";
}

// Resolve cidade por matching determinístico na lista de cidades da região
function resolverCidadeMencionada(textoDoUsuario, entidades, cidadesAtivas) {
  const cidadeTexto = (entidades?.city || "").trim();
  const tentativa = cidadeTexto || textoDoUsuario;

  const t = normalizarTexto(tentativa);
  const achada = (cidadesAtivas || []).find(
    (c) => t.includes(normalizarTexto(c.nome)) || t.includes(normalizarTexto(c.slug))
  );
  return achada || null;
}

function listarCidadesVizinhas(cidadeBase, cidadesAtivas, limite = 3) {
  try {
    if (!cidadeBase || typeof cidadeBase.lat !== "number" || typeof cidadeBase.lng !== "number") return [];
    const base = { lat: Number(cidadeBase.lat), lng: Number(cidadeBase.lng) };

    const outras = (cidadesAtivas || [])
      .filter((c) => c.id !== cidadeBase.id && typeof c.lat === "number" && typeof c.lng === "number")
      .map((c) => ({
        ...c,
        km: calcularDistanciaHaversineEmKm(base, { lat: Number(c.lat), lng: Number(c.lng) })
      }))
      .sort((a, b) => a.km - b.km);

    return outras.slice(0, limite);
  } catch {
    return [];
  }
}

// Anti-alucinação comercial
function respostaTemPromocaoInventada(texto, promocoesFornecidas) {
  const t = String(texto || "").toLowerCase();
  const citaPromo = KEYWORDS_PROMO.some((k) => t.includes(k));
  if (!citaPromo) return false;
  return !(Array.isArray(promocoesFornecidas) && promocoesFornecidas.length > 0);
}

function removerTrechosDePromocao(texto) {
  const linhas = String(texto || "").split("\n");
  const filtradas = linhas.filter((l) => {
    const t = l.toLowerCase();
    return !KEYWORDS_PROMO.some((k) => t.includes(k));
  });
  return filtradas.join("\n").trim() || "Certo — me diga a cidade e o tipo de lugar/serviço que você quer.";
}

function respostaSemParceiro({ entidades, cidade, cidadesAtivas, regiaoNome }) {
  const cat = entidades?.category ? String(entidades.category) : "esse tipo de serviço";
  const nomeCidade = cidade?.nome || entidades?.city || "essa cidade";
  const vizinhas = cidade ? listarCidadesVizinhas(cidade, cidadesAtivas, 3) : [];

  const sugestaoVizinhas = vizinhas.length
    ? `Se topar, posso procurar em cidades bem próximas: ${vizinhas.map((v) => v.nome).join(", ")}.`
    : `Se você me disser a cidade exata, eu tento buscar em cidades próximas também.`;

  return [
    `No momento eu **não tenho parceiros cadastrados** para **${cat}** em **${nomeCidade}** (${regiaoNome || "sua região"}).`,
    sugestaoVizinhas
  ].join("\n");
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

// Coordenadas de fallback
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

// Histórico da conversa (mantido)
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

// ------------------------------ FERRAMENTAS (MANTER) ------------------------
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
      const descNormalizada = normalizarTexto(parc.descricao || "");
      const beneficioNormalizado = normalizarTexto(parc.beneficio_bepit || "");

return termosNormalizados.some((termo) =>
  nomeNormalizado.includes(termo) ||
  categoriaNormalizada.includes(termo) ||
  descNormalizada.includes(termo) ||
  beneficioNormalizado.includes(termo) ||
  listaDeTags.includes(termo)
);

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
// HEALTHCHECK
// ============================================================================
aplicacaoExpress.get("/health", (req, res) => {
  res.status(200).json({ ok: true, message: "Servidor BEPIT Nexus online", port: String(portaDoServidor) });
});

// ============================================================================
// v3.2 — CÉREBROS, INTENÇÃO E HELPERS
// ============================================================================
async function analisarIntencaoDoUsuario(textoDoUsuario) {
  const prompt = `Sua única tarefa é analisar a frase do usuário e classificá-la em uma das seguintes categorias: 'busca_parceiro', 'follow_up_parceiro', 'pergunta_geral', 'mudanca_contexto', 'small_talk'. Responda apenas com a string da categoria.
Frase: "${textoDoUsuario}"`;

  const modelo = await obterModeloGemini();
  const resp = await modelo.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
  const text = (resp?.response?.text() || "").trim().toLowerCase();
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

  const modelo = await obterModeloGemini();
  const resp = await modelo.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
  const raw = (resp?.response?.text() || "").trim();
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
  const historicoTexto = historicoParaTextoSimples(historicoContents);
  const contextoParceiros = JSON.stringify(parceiros ?? [], null, 2);

  // (Compatível agora): promoções ainda não existem como tabela no teu schema atual.
  // Se você já criar partner_promotions depois, a gente liga aqui.
  const promocoes = []; // por enquanto vazio

  const prompt = [
    "Você é o BEPIT, um concierge especialista.",
    "REGRAS CRÍTICAS (obrigatórias):",
    "1) Você só pode indicar estabelecimentos/serviços que estão listados em [Contexto de Parceiros].",
    "2) Você NUNCA pode inventar descontos, cupons, brindes, promoções ou benefícios.",
    "   Nunca diga 'fale que foi indicado pelo BEPIT' ou qualquer porcentagem.",
    "3) Se o pedido for ambíguo (cidade, tipo, horário, orçamento, crianças, romântico etc.), faça 1-2 perguntas curtas de esclarecimento.",
    "4) Não misture cidades. Se sugerir outra cidade, deixe claro que é próxima e pergunte se o usuário topa.",
    "",
    `[Contexto de Parceiros]: ${contextoParceiros}`,
    `[Histórico da Conversa]:\n${historicoTexto}`,
    `[Região]: ${regiaoNome}`,
    `[Pergunta do Usuário]: "${pergunta}"`
  ].join("\n");

  const modelo = await obterModeloGemini();
  const resp = await modelo.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });

  let texto = (resp?.response?.text() || "").trim();

  // filtro final anti-promo inventada
  if (respostaTemPromocaoInventada(texto, promocoes)) {
    texto = removerTrechosDePromocao(texto);
  }

  return texto;
}


async function gerarRespostaGeral(pergunta, historicoContents, regiao) {
  const historicoTexto = historicoParaTextoSimples(historicoContents);
  const nomeRegiao = regiao?.nome || "sua região";

  const prompt = [
    `Você é o BEPIT, um concierge amigável e conhecedor da região de ${nomeRegiao}.`,
    "Você pode responder perguntas públicas e informativas (história, como chegar, orientações gerais, clima/vento) de forma útil.",
    "REGRAS CRÍTICAS:",
    "1) Você NÃO pode inventar descontos, cupons, promoções ou benefícios. Nunca cite porcentagens.",
    "2) Você NÃO pode afirmar parceria com estabelecimentos que não foram fornecidos pelo sistema.",
    "3) Se o usuário pedir indicação de serviços privados (restaurante/passeio/bar/transfer etc.) e estiver genérico, peça cidade e preferência.",
    "4) Se não tiver dado objetivo (ex: praia cheia agora), não chute: explique a limitação e peça mais contexto.",
    "",
    `[Histórico da Conversa]:\n${historicoTexto}`,
    `[Pergunta do Usuário]: "${pergunta}"`
  ].join("\n");

  const modelo = await obterModeloGemini();
  const resp = await modelo.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });

  let texto = (resp?.response?.text() || "").trim();

  if (respostaTemPromocaoInventada(texto, [])) {
    texto = removerTrechosDePromocao(texto);
  }

  return texto;
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
function detectarConsultaDeCardapio(texto) {
  const t = normalizarTexto(texto);
  return ["cardapio","cardápio","prato","tem ","serve ","opcao","opção","no menu","menu"].some(k => t.includes(normalizarTexto(k)));
}

function normalizarEntidadesDeComida(entidades, textoDoUsuario) {
  const t = normalizarTexto(textoDoUsuario);

  // lista de pratos/itens que NÃO devem virar "category"
  const itensDeCardapio = ["picanha", "hamburguer", "hambúrguer", "pizza", "sushi", "rodizio", "rodízio", "churrasco"];

  const cat = normalizarTexto(entidades?.category || "");
  const ehItem = itensDeCardapio.some(x => cat === normalizarTexto(x));

  // Se o usuário falou de cardápio/prato e a "category" veio como item → converte
  if (detectarConsultaDeCardapio(textoDoUsuario) || ehItem) {
    const termos = Array.isArray(entidades?.terms) ? entidades.terms : [];
    const novosTermos = [...termos];

    // coloca a category original como termo (ex: picanha)
    if (entidades?.category) novosTermos.push(entidades.category);

    return {
      ...entidades,
      category: "restaurante",
      terms: Array.from(new Set(novosTermos.map(s => String(s).trim()).filter(Boolean)))
    };
  }

  return entidades;
}

async function lidarComNovaBusca({ textoDoUsuario, historicoGemini, regiao, cidadesAtivas, idDaConversa }) {
  const entidadesBrutas = await extrairEntidadesDaBusca(textoDoUsuario);
  const entidades = normalizarEntidadesDeComida(entidadesBrutas, textoDoUsuario);

  const topicoPublico = isTopicoPublico(textoDoUsuario);
  const servicoPrivado = isServicoPrivado(textoDoUsuario, entidades);

  // resolve cidade com base no texto + entidades + lista de cidades
  const cidadeResolvida = resolverCidadeMencionada(textoDoUsuario, entidades, cidadesAtivas);
  
  // 🌦️ CLIMA: sempre por dado do Supabase (sem IA chutar)
if (perguntaEhSobreClima(textoDoUsuario)) {
  if (!cidadeResolvida) {
    return {
      respostaFinal: "Você quer saber o clima de qual cidade? (ex: Cabo Frio, Arraial, Búzios…) ",
      parceirosSugeridos: []
    };
  }

  // Você pode usar tipo_dado para separar: "AR", "AGUA", "VENTO", etc.
  // Como seu schema usa tipo_dado text (e tem UNIQUE), aqui dá pra manter null e pegar o último geral.
  const clima = await obterClimaLatest({ cidadeId: cidadeResolvida.id, tipoDado: null });

  if (!clima) {
    return {
      respostaFinal: `Ainda não tenho um registro atualizado de clima para ${cidadeResolvida.nome} agora. Tenta de novo em alguns minutos ou me diz se quer AR, VENTO ou ÁGUA do mar.`,
      parceirosSugeridos: []
    };
  }

  // Segurança: nunca inventa campo. Só mostra o que existir no JSON.
  const d = clima.dados || {};
  const linhas = [];
  linhas.push(`Clima (dados reais) — ${cidadeResolvida.nome}`);
  if (clima.ts) linhas.push(`Atualizado: ${new Date(clima.ts).toLocaleString()}`);

  // tenta mapear alguns campos comuns, mas SEM assumir
  const pick = (obj, keys) => {
    for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
    return null;
  };

  const temp = pick(d, ["temp", "temperature", "temperatura", "air_temp", "temp_c"]);
  const vento = pick(d, ["wind", "wind_speed", "vento", "vento_kmh", "wind_kmh"]);
  const agua = pick(d, ["water_temp", "sea_temp", "temperatura_agua", "temp_agua"]);

  if (temp !== null) linhas.push(`🌡️ Temperatura: ${temp}`);
  if (vento !== null) linhas.push(`💨 Vento: ${vento}`);
  if (agua !== null) linhas.push(`🌊 Água do mar: ${agua}`);

  if (linhas.length <= 2) {
    return {
      respostaFinal: `Tenho um registro para ${cidadeResolvida.nome}, mas ele veio sem campos de temperatura/vento/água no JSON. Me diga se seu CRON salva como AR/VENTO/AGUA (tipo_dado), que eu ajusto o filtro.`,
      parceirosSugeridos: []
    };
  }

  // IA só “explica” o dado (sem inventar)
  const respostaFinal = await gerarRespostaGeral(
    `Explique de forma amigável e curta, sem inventar nada além do que está aqui:\n${linhas.join("\n")}`,
    historicoGemini,
    regiao
  );

  return { respostaFinal, parceirosSugeridos: [] };
}


  // Se for público e NÃO for privado, segue geral
  if (topicoPublico && !servicoPrivado) {
    const respostaFinal = await gerarRespostaGeral(textoDoUsuario, historicoGemini, regiao);
    return { respostaFinal, parceirosSugeridos: [] };
  }
  // ✅ PATCH 2 — se for serviço privado e não tem cidade, pergunta antes de buscar
if (servicoPrivado && !cidadeResolvida && !(entidades?.city || "").trim()) {
  return {
    respostaFinal: "Beleza — em qual cidade da Região dos Lagos você quer? (Cabo Frio, Arraial, Búzios, São Pedro…)",
    parceirosSugeridos: []
  };
}
  // força city para a resolvida (para não “buscar tudo” quando o Gemini erra cidade)
  const entidadesParaBusca = {
    ...entidades,
    city: cidadeResolvida?.nome || entidades?.city || null
  };

  const resultadoBusca = await ferramentaBuscarParceirosOuDicas({
    regiao,
    cidadesAtivas,
    argumentosDaFerramenta: entidadesParaBusca
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
  }

  // Se é serviço privado e NÃO achou parceiro: NÃO deixa a IA “inventar” em resposta geral
  if (servicoPrivado) {
    const respostaFinal = respostaSemParceiro({
      entidades,
      cidade: cidadeResolvida,
      cidadesAtivas,
      regiaoNome: regiao?.nome
    });
    return { respostaFinal, parceirosSugeridos: [] };
  }

  // Se não é claramente privado, pode responder geral
  const respostaFinal = await gerarRespostaGeral(textoDoUsuario, historicoGemini, regiao);
  return { respostaFinal, parceirosSugeridos: [] };
}


// ============================================================================
// ROTA DE CHAT (ORQUESTRADOR LÓGICO v3.2)
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
    if (erroCidades) return resposta.status(500).json({ error: "Erro ao carregar cidades." });
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
      } catch { /* não falha o fluxo */ }
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

    if (modoCruSemRegrasAtivo) {
      const modelo = await obterModeloGemini();
      const historicoGemini = await construirHistoricoParaGemini(idDaConversa, 12);

      const respostaGemini = await modelo.generateContent({
        contents: [...historicoGemini, { role: "user", parts: [{ text: textoDoUsuario }] }]
      });
      const textoLivre = (respostaGemini?.response?.text?.() || "").trim() || "…";

      let idDaInteracao = null;
      try {
        const { data: novaInteracao } = await supabase
          .from("interacoes")
          .insert({
            regiao_id: regiao.id,
            conversation_id: idDaConversa,
            pergunta_usuario: textoDoUsuario,
            resposta_ia: textoLivre,
            parceiros_sugeridos: []
          })
          .select("id").single();
        idDaInteracao = novaInteracao?.id || null;
      } catch { /* segue */ }

      const fotosDosParceiros = [];
      return resposta.status(200).json({
        reply: textoLivre,
        interactionId: idDaInteracao,
        photoLinks: fotosDosParceiros,
        conversationId: idDaConversa
      });
    }

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

      let idDaInteracaoSalvaSel = null;
      try {
        const { data: novaInteracaoSel } = await supabase
          .from("interacoes")
          .insert({
            regiao_id: regiao.id,
            conversation_id: idDaConversa,
            pergunta_usuario: textoDoUsuario,
            resposta_ia: respostaCurta,
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
        reply: respostaCurta,
        interactionId: idDaInteracaoSalvaSel,
        photoLinks: fotosDosParceiros,
        conversationId: idDaConversa,
        intent: "follow_up_parceiro",
        partners: [parceiroSelecionado]
      });
    }

    // ✅ À prova de erro: não depende do "intent" do Gemini.
// A única exceção continua sendo: se o usuário escolher um parceiro da lista, tratamos acima (já existe no teu código).

let respostaFinal = "";
let parceirosSugeridos = [];

const resultado = await lidarComNovaBusca({
  textoDoUsuario,
  historicoGemini,
  regiao,
  cidadesAtivas,
  idDaConversa
});

respostaFinal = resultado.respostaFinal;
parceirosSugeridos = resultado.parceirosSugeridos;

// Mantém um "intent" apenas informativo (não usado para decidir fluxo)
const intent = "orquestrado";


    if (!respostaFinal) {
      respostaFinal = "Posso ajudar com roteiros, transporte, passeios, praias e onde comer. O que você gostaria de saber?";
    }

    let idDaInteracaoSalva = null;
    try {
      const { data: novaInteracao, error: erroDeInsert } = await supabase
        .from("interacoes")
        .insert({
          regiao_id: regiao.id,
          conversation_id: idDaConversa,
          pergunta_usuario: textoDoUsuario,
          resposta_ia: respostaFinal,
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
      reply: respostaFinal,
      interactionId: idDaInteracaoSalva,
      photoLinks: fotosDosParceiros,
      conversationId: idDaConversa,
      intent,
      partners: parceirosSugeridos
    });
  } catch (erro) {
    console.error("[/api/chat/:slugDaRegiao] Erro:", erro);
    return resposta.status(500).json({ error: "Erro interno no servidor do BEPIT." });
  }
});

// ============================================================================
// FEEDBACK (MANTIDO)
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
// ADMIN (mantido)
// ============================================================================
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
  if (!chave || chave !== process.env.ADMIN_API_KEY) {
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
        return cidade ? info.cidade_id === cidade.id : listaDeIdsDeCidades.includes(info.cidade_id);
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
  console.log(`✅ BEPIT Nexus (Orquestrador v3.2) rodando em http://localhost:${portaDoServidor}`);
});