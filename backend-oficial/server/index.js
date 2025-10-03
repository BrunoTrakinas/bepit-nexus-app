// ============================================================================
// BEPIT Nexus - Servidor (Express) — Orquestrador Lógico v3.4 (REST Gemini)
// - Corrige: IA ignorando banco; praia aparecendo em "restaurantes"
// - Inclui: heurística local p/ intenção, filtro de categorias "cesta"
// - Mantém: todas as rotas Admin existentes (login/chave, parceiros, regiões,
//           cidades, métricas, logs) e guardrails externos.
// - Requisitos de ambiente (Render):
//   USE_GEMINI_REST=1
//   GEMINI_API_KEY=... (Google AI Studio / MakerSuite, v1)
//   SUPABASE_URL=...
//   SUPABASE_SERVICE_ROLE=...  (ou SUPABASE_SERVICE_KEY)
//   ADMIN_API_KEY=...          (para /api/admin/* e /api/auth/login)
//   (opcionais)
//   GEMINI_MODEL=gemini-2.5-flash (ou 2.5-pro, etc.; com ou sem "models/")
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
  const todosComPrefixo = await listarModelosREST(); // ["models/gemini-2.5-flash", ...]
  const disponiveis = todosComPrefixo.map(stripModelsPrefix); // ["gemini-2.5-flash", ...]

  const envModelo = (process.env.GEMINI_MODEL || "").trim();
  if (envModelo) {
    const alvo = stripModelsPrefix(envModelo);
    if (disponiveis.includes(alvo)) return alvo;
    console.warn(`[GEMINI REST] GEMINI_MODEL "${envModelo}" indisponível. Disponíveis: ${disponiveis.join(", ")}`);
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
function converterGrausParaRadianos(g) { return (g * Math.PI) / 180; }
function calcularDistanciaHaversineEmKm(a, b) {
  const R = 6371;
  const dLat = converterGrausParaRadianos(b.lat - a.lat);
  const dLng = converterGrausParaRadianos(b.lng - a.lng);
  const lat1 = converterGrausParaRadianos(a.lat);
  const lat2 = converterGrausParaRadianos(b.lat);
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

function obterCoordenadasPorCidadeOuTexto(texto, cidades) {
  const chave = normalizarTexto(texto);
  const candidato = (cidades || []).find(c => normalizarTexto(c.nome) === chave || normalizarTexto(c.slug) === chave);
  if (candidato && typeof candidato.lat === "number" && typeof candidato.lng === "number") {
    return { lat: candidato.lat, lng: candidato.lng, fonte: "db" };
  }
  if (coordenadasFallback[chave]) return { ...coordenadasFallback[chave], fonte: "fallback" };
  return null;
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
// Força "busca_parceiro" quando a pergunta tem palavras-chave de categorias.
const PALAVRAS_CHAVE = {
  comida: [
    "restaurante","restaurantes","almoço","almoco","jantar","comer","comida","picanha",
    "pizza","pizzaria","peixe","frutos do mar","moqueca","rodizio","rodízio","churrascaria","lanchonete","burger","hamburguer","hambúrguer","bistrô","bistro"
  ],
  hospedagem: ["pousada","pousadas","hotel","hotéis","hospedagem","hostel","airbnb"],
  bebidas: ["bar","bares","chopp","chope","drinks","pub","boteco"],
  passeios: ["passeio","passeios","barco","lancha","escuna","trilha","trilhas","tour","buggy","quadriciclo","city tour","catamarã","catamara","mergulho","snorkel","gruta","ilha"],
  praias: ["praia","praias","faixa de areia","bandeira azul","mar calmo","mar forte"],
  transporte: ["transfer","transporte","alugar carro","aluguel de carro","uber","taxi","ônibus","onibus","rodoviária","rodoviaria"]
};

function forcarBuscaParceiro(texto) {
  const t = normalizarTexto(texto);
  for (const lista of Object.values(PALAVRAS_CHAVE)) {
    if (lista.some(p => t.includes(p))) return true;
  }
  return false;
}

// Identifica "cestas de categoria" a partir do texto do usuário
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

// Mapa de cesta → categorias aceitas no campo "categoria" da tabela parceiros
const MAPA_CESTA_PARA_CATEGORIAS_DB = {
  comida: [
    "restaurante","pizzaria","churrascaria","lanchonete","frutos do mar","sushi","padaria","cafeteria","bistrô","bistro","hamburgueria","pizza"
  ],
  bebidas: [
    "bar","pub","cervejaria","wine bar","balada","boteco"
  ],
  passeios: [
    "passeio","passeios","barco","lancha","escuna","trilha","buggy","quadriciclo","city tour","catamarã","catamara","mergulho","snorkel","gruta","ilha","tour"
  ],
  praias: [
    "praia","praias","bandeira azul","orla"
  ],
  hospedagem: [
    "pousada","hotel","hostel","apart","flat","resort","hospedagem"
  ],
  transporte: [
    "transfer","transporte","aluguel de carro","locadora","taxi","ônibus","onibus","rodoviária","rodoviaria"
  ]
};

// ============================== FERRAMENTAS =================================
async function ferramentaBuscarParceirosOuDicas({ cidadesAtivas, argumentosDaFerramenta, textoOriginal }) {
  const categoriaProcurada = (argumentosDaFerramenta?.category || "").trim();
  const cidadeProcurada = (argumentosDaFerramenta?.city || "").trim();
  const listaDeTermos = Array.isArray(argumentosDaFerramenta?.terms) ? argumentosDaFerramenta.terms : [];

  const cestaInferida = inferirCestaCategoria(textoOriginal || "");
  const categoriasPermitidas = cestaInferida ? MAPA_CESTA_PARA_CATEGORIAS_DB[cestaInferida] : null;

  // Filtra por cidades ativas da região
  const cidadesValidas = (cidadesAtivas || []);
  let idsCidade = cidadesValidas.map(c => c.id);
  if (cidadeProcurada) {
    const alvo = cidadesValidas.find(
      c => normalizarTexto(c.nome) === normalizarTexto(cidadeProcurada) || normalizarTexto(c.slug) === normalizarTexto(cidadeProcurada)
    );
    if (alvo) idsCidade = [alvo.id];
  }

  // Base da query
  let q = supabase
    .from("parceiros")
    .select("id, tipo, nome, categoria, descricao, endereco, contato, beneficio_bepit, faixa_preco, fotos_parceiros, cidade_id, tags, ativo")
    .eq("ativo", true)
    .in("cidade_id", idsCidade);

  // Se o usuário digitou uma categoria explícita, aplica um ilike nessa categoria
  if (categoriaProcurada) q = q.ilike("categoria", `%${categoriaProcurada}%`);

  const { data: base, error } = await q;
  if (error) throw error;
  let itens = Array.isArray(base) ? base : [];

  // Se a pergunta claramente é sobre "comida", "passeios", "praias", etc., restringe às categorias mapeadas.
  if (categoriasPermitidas && categoriasPermitidas.length > 0) {
    const setPermitidas = new Set(categoriasPermitidas.map(normalizarTexto));
    itens = itens.filter(p => setPermitidas.has(normalizarTexto(p.categoria || "")));
  }

  // Se vieram termos (ex.: "peixe", "rodízio"), filtra por nome/categoria/tags
  if (listaDeTermos.length > 0) {
    const termosNorm = listaDeTermos.map(t => normalizarTexto(t));
    itens = itens.filter(p => {
      const nomeN = normalizarTexto(p.nome || "");
      const catN = normalizarTexto(p.categoria || "");
      const tags = Array.isArray(p.tags) ? p.tags.map(x => normalizarTexto(String(x))) : [];
      return termosNorm.some(t => nomeN.includes(t) || catN.includes(t) || tags.includes(t));
    });
  }

  // Ordena PARCEIRO antes de DICA (restaura ordem esperada)
  itens.sort((a, b) => (a.tipo === "DICA" ? 1 : 0) - (b.tipo === "DICA" ? 1 : 0));
  const limitados = itens.slice(0, 8);

  // Log leve de analytics (não bloqueante)
  try {
    await supabase.from("eventos_analytics").insert({
      tipo_evento: "partner_query",
      payload: {
        termos: listaDeTermos,
        categoriaProcurada,
        cestaInferida,
        categoriasAplicadas: categoriasPermitidas || null,
        cidadeProcurada,
        total_base: (base || []).length,
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

async function ferramentaObterRotaOuDistanciaAproximada({ argumentosDaFerramenta, cidadesAtivas }) {
  const origem = String(argumentosDaFerramenta?.origin || "").trim();
  const destino = String(argumentosDaFerramenta?.destination || "").trim();
  if (!origem || !destino) return { ok: false, error: "Os campos 'origin' e 'destination' são obrigatórios." };

  const coordO = obterCoordenadasPorCidadeOuTexto(origem, cidadesAtivas);
  const coordD = obterCoordenadasPorCidadeOuTexto(destino, cidadesAtivas) || obterCoordenadasPorCidadeOuTexto("cabo frio", cidadesAtivas);
  if (!coordO || !coordD) return { ok: false, error: "Coordenadas não disponíveis." };

  const kmLinha = calcularDistanciaHaversineEmKm(coordO, coordD);
  const kmEst = Math.round(kmLinha * 1.2);
  const hMin = Math.round(kmEst / 70);
  const hMax = Math.round(kmEst / 55);

  return {
    ok: true,
    origin: origem,
    destination: destino,
    km_estimated: kmEst,
    hours_range: [hMin, hMax],
    notes: [
      "Estimativa por aproximação (linha reta + 20%). Use Waze/Maps para trânsito em tempo real.",
      "Em alta temporada, sair cedo reduz filas na Via Lagos (RJ-124)."
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
    const { error } = await supabase.from("conversas").update({ preferencia_indicacao: preferencia, topico_atual: topico || null }).eq("id", idDaConversa);
    if (error) throw error;
    return { ok: true, saved: { preference: preferencia, topic: topico || null } };
  } catch (erro) {
    return { ok: false, error: erro?.message || String(erro) };
  }
}

// ============================== HEALTH/DIAG =================================
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

// ============================== PROMPTS =====================================
async function analisarIntencaoDoUsuario(textoDoUsuario) {
  // Heurística primeiro: se bater palavras-chave, força busca_parceiro.
  if (forcarBuscaParceiro(textoDoUsuario)) return "busca_parceiro";

  const prompt = `Sua única tarefa é analisar a frase do usuário e classificá-la em uma das seguintes categorias: 'busca_parceiro', 'follow_up_parceiro', 'pergunta_geral', 'mudanca_contexto', 'small_talk'. Responda apenas com a string da categoria.
Frase: "${textoDoUsuario}"`;
  const saida = await geminiGerarTexto(prompt);
  const text = (saida || "").trim().toLowerCase();
  const classes = new Set(["busca_parceiro", "follow_up_parceiro", "pergunta_geral", "mudanca_contexto", "small_talk"]);
  return classes.has(text) ? text : "pergunta_geral";
}

async function extrairEntidadesDaBusca(texto) {
  // Pede ajuda ao modelo…
  const prompt = `Extraia entidades de busca para parceiros no formato JSON estrito (sem comentários).
Campos: {"category": string|null, "city": string|null, "terms": string[]}
- "category" (restaurante, passeio, hotel, bar, transfer, mergulho, pizzaria, etc.)
- "city" se houver menção
- "terms" (adjetivos/necessidades, ex.: "peixe", "rodízio", "vista para o mar")
Seja flexível com erros comuns. Responda só o JSON.
Frase: "${texto}"`;
  let modelParsed = { category: null, city: null, terms: [] };
  try {
    const bruto = await geminiGerarTexto(prompt);
    const parsed = JSON.parse(bruto);
    modelParsed = {
      category: typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim() : null,
      city: typeof parsed.city === "string" && parsed.city.trim() ? parsed.city.trim() : null,
      terms: Array.isArray(parsed.terms) ? parsed.terms.filter(t => typeof t === "string" && t.trim()).map(t => t.trim()) : []
    };
  } catch { /* segue com fallback */ }

  // …e reforça com heurística local (cesta)
  const cesta = inferirCestaCategoria(texto || "");
  // Se o modelo não sugeriu "category", usa a cesta como category "macro".
  const category = modelParsed.category || cesta || null;

  return { category, city: modelParsed.city, terms: modelParsed.terms };
}

async function gerarRespostaComParceiros(pergunta, historicoContents, parceiros, regiaoNome = "") {
  const historicoTexto = historicoParaTextoSimples(historicoContents);
  const contextoParceiros = JSON.stringify(parceiros ?? [], null, 2);
  const prompt = [
    "Você é o BEPIT, um concierge especialista.",
    "Responda à pergunta do usuário baseando-se EXCLUSIVAMENTE no [Contexto] de parceiros cadastrados.",
    "Evite linguagem de parceria/benefício — use tom neutro (indicação). Nunca invente promoções, endereços ou benefícios.",
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
    "Dê dicas úteis sem inventar nomes/endereços. Não use linguagem de parceria.",
    "Se a pergunta pedir coisas específicas (restaurante, bar, hotel, passeio, praia), priorize perguntar preferências ou redirecionar para resultados cadastrados.",
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

async function lidarComNovaBusca({ textoDoUsuario, historicoGemini, regiao, cidadesAtivas, idDaConversa }) {
  const entidades = await extrairEntidadesDaBusca(textoDoUsuario);

  const resultadoBusca = await ferramentaBuscarParceirosOuDicas({
    cidadesAtivas,
    argumentosDaFerramenta: entidades,
    textoOriginal: textoDoUsuario
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
    // Sem parceiros — resposta geral (sem inventar) + fallback amigável
    const respostaModelo = await gerarRespostaGeral(textoDoUsuario, historicoGemini, regiao);
    const respostaFinal = finalizeAssistantResponse({
      modelResponseText: respostaModelo,
      foundPartnersList: [],
      mode: "general"
    });
    return { respostaFinal, parceirosSugeridos: [] };
  }
}

// ============================== CHAT ROUTE ==================================
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
    const candidatos = Array.isArray(conversaAtual?.parceiros_sugeridos) ? conversaAtual.parceiros_sugeridos : [];
    const parceiroSelecionado = encontrarParceiroNaLista(textoDoUsuario, candidatos);
    if (parceiroSelecionado) {
      try {
        await supabase.from("conversas").update({ parceiro_em_foco: parceiroSelecionado, parceiros_sugeridos: candidatos }).eq("id", conversationId);
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

    // Intenção
    const intent = await analisarIntencaoDoUsuario(textoDoUsuario);
    let respostaFinal = "";
    let parceirosSugeridos = [];

    switch (intent) {
      case "busca_parceiro": {
        const r = await lidarComNovaBusca({ textoDoUsuario, historicoGemini, regiao, cidadesAtivas, idDaConversa: conversationId });
        respostaFinal = r.respostaFinal;
        parceirosSugeridos = r.parceirosSugeridos;
        break;
      }
      case "follow_up_parceiro": {
        const p = conversaAtual?.parceiro_em_foco || null;
        if (p) {
          const respostaModelo = await gerarRespostaComParceiros(textoDoUsuario, historicoGemini, [p], regiao?.nome);
          respostaFinal = finalizeAssistantResponse({ modelResponseText: respostaModelo, foundPartnersList: [p], mode: "partners" });
          parceirosSugeridos = [p];
        } else {
          const r = await lidarComNovaBusca({ textoDoUsuario, historicoGemini, regiao, cidadesAtivas, idDaConversa: conversationId });
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

// ============================== FEEDBACK ====================================
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

// ============================== AUTH + ADMIN ================================
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

aplicacaoExpress.post("/api/admin/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const uOK = username && username === process.env.ADMIN_USER;
    const pOK = password && password === process.env.ADMIN_PASS;
    if (!uOK || !pOK) return res.status(401).json({ error: "Credenciais inválidas." });
    return res.json({ ok: true, adminKey: process.env.ADMIN_API_KEY });
  } catch (erro) {
    console.error("[/api/admin/login] Erro:", erro);
    return res.status(500).json({ error: "Erro interno." });
  }
});

function exigirChaveDeAdministrador(req, res, next) {
  const chave = req.headers["x-admin-key"];
  if (!chave || chave !== (process.env.ADMIN_API_KEY || "")) return res.status(401).json({ error: "Chave administrativa inválida ou ausente." });
  next();
}

aplicacaoExpress.post("/api/admin/parceiros", exigirChaveDeAdministrador, async (req, res) => {
  try {
    const { regiaoSlug, cidadeSlug, ...rest } = req.body || {};
    const { data: regiao, error: eReg } = await supabase.from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (eReg || !regiao) return res.status(400).json({ error: "regiaoSlug inválido." });

    const { data: cidade, error: eCid } = await supabase.from("cidades").select("id").eq("regiao_id", regiao.id).eq("slug", cidadeSlug).single();
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
    if (error) return res.status(500).json({ error: "Erro ao criar parceiro/dica." });

    return res.status(200).json({ ok: true, data });
  } catch (erro) {
    console.error("[/api/admin/parceiros] Erro:", erro);
    return res.status(500).json({ error: "Erro interno." });
  }
});

aplicacaoExpress.get("/api/admin/parceiros/:regiaoSlug/:cidadeSlug", exigirChaveDeAdministrador, async (req, res) => {
  try {
    const { regiaoSlug, cidadeSlug } = req.params;
    const { data: regiao, error: eReg } = await supabase.from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (eReg || !regiao) return res.status(400).json({ error: "regiaoSlug inválido." });

    const { data: cidade, error: eCid } = await supabase.from("cidades").select("id").eq("regiao_id", regiao.id).eq("slug", cidadeSlug).single();
    if (eCid || !cidade) return res.status(400).json({ error: "cidadeSlug inválido." });

    const { data, error } = await supabase.from("parceiros").select("*").eq("cidade_id", cidade.id).order("nome");
    if (error) return res.status(500).json({ error: "Erro ao listar parceiros/dicas." });

    return res.status(200).json({ data });
  } catch (erro) {
    console.error("[/api/admin/parceiros list] Erro:", erro);
    return res.status(500).json({ error: "Erro interno." });
  }
});

aplicacaoExpress.post("/api/admin/regioes", exigirChaveDeAdministrador, async (req, res) => {
  try {
    const { nome, slug, ativo = true } = req.body || {};
    if (!nome || !slug) return res.status(400).json({ error: "Campos 'nome' e 'slug' são obrigatórios." });

    const { data, error } = await supabase.from("regioes").insert({ nome, slug, ativo: Boolean(ativo) }).select("*").single();
    if (error) return res.status(500).json({ error: "Erro ao criar região." });

    res.json({ ok: true, data });
  } catch (erro) {
    console.error("[/api/admin/regioes] Erro:", erro);
    res.status(500).json({ error: "Erro interno." });
  }
});

aplicacaoExpress.post("/api/admin/cidades", exigirChaveDeAdministrador, async (req, res) => {
  try {
    const { regiaoSlug, nome, slug, ativo = true, lat = null, lng = null } = req.body || {};
    if (!regiaoSlug || !nome || !slug) return res.status(400).json({ error: "Campos 'regiaoSlug', 'nome' e 'slug' são obrigatórios." });

    const { data: regiao, error: eReg } = await supabase.from("regioes").select("id").eq("slug", regiaoSlug).single();
    if (eReg || !regiao) return res.status(400).json({ error: "regiaoSlug inválido." });

    const { data, error } = await supabase
      .from("cidades")
      .insert({ regiao_id: regiao.id, nome, slug, ativo: Boolean(ativo), lat: lat === null ? null : Number(lat), lng: lng === null ? null : Number(lng) })
      .select("*")
      .single();
    if (error) return res.status(500).json({ error: "Erro ao criar cidade." });

    res.json({ ok: true, data });
  } catch (erro) {
    console.error("[/api/admin/cidades] Erro:", erro);
    res.status(500).json({ error: "Erro interno." });
  }
});

// ============================== START =======================================
aplicacaoExpress.listen(portaDoServidor, () => {
  console.log(`✅ BEPIT Nexus (Orquestrador v3.4 REST) rodando em http://localhost:${portaDoServidor}`);
});
