// ============================================================================
// BEPIT Nexus - Servidor (Express) — Orquestrador Lógico v3.4 (REST Gemini)
// - Suporta GEMINI REST v1 (Google AI Studio) com seleção dinâmica de modelo
// - Guardrails externos em: server/utils/bepitGuardrails.js
// - Roteiros (1 a 20 dias) com separação por período e priorização de parceiros
// - Diferença clara entre "dica/passeio" e "restaurante/bar"
// - Menções de "benefício/desconto" somente quando houver beneficio_bepit
//
// Requisitos de ambiente (Render):
//   USE_GEMINI_REST=1
//   GEMINI_API_KEY=...          (chave do Google AI Studio / MakerSuite v1)
//   GEMINI_MODEL=gemini-2.5-flash  (ou outro disponível; com ou sem "models/")
//   SUPABASE_URL=...
//   SUPABASE_SERVICE_ROLE=...   (ou SUPABASE_SERVICE_KEY)
//   ADMIN_API_KEY=...           (para /api/admin/* e /api/auth/login por "key")
//   (opcionais)
//   ADMIN_USER=... / ADMIN_PASS=... (login alternativo por user/pass legado)
//
// Observações:
// - Não inventa nomes/endereços/benefícios. Só usa dados do banco.
// - Se não houver parceiro para um pedido específico, responde com fallback
//   neutro (sem alegar parceria), podendo citar que "não há indicação cadastrada".
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

// ============================== CONFIGURAÇÃO =================================
const aplicacaoExpress = express();
const portaDoServidor = process.env.PORT || 3002;
aplicacaoExpress.use(express.json({ limit: "2mb" }));

// --------------------------------- CORS --------------------------------------
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

// ============================== GEMINI (REST v1) =============================
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
  const todosComPrefixo = await listarModelosREST();         // ex.: ["models/gemini-2.5-flash", ...]
  const disponiveisSimples = todosComPrefixo.map(stripModelsPrefix); // ["gemini-2.5-flash", ...]

  const envModelo = (process.env.GEMINI_MODEL || "").trim();
  if (envModelo) {
    const alvo = stripModelsPrefix(envModelo);
    if (disponiveisSimples.includes(alvo)) return alvo;
    console.warn(`[GEMINI REST] Modelo em GEMINI_MODEL ("${envModelo}") indisponível. Disponíveis: ${disponiveisSimples.join(", ")}`);
  }

  const preferencia = [
    envModelo && stripModelsPrefix(envModelo),
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-2.0-flash-001",
    "gemini-2.0-flash-lite",
    "gemini-1.5-pro-002",
    "gemini-1.5-flash-002"
  ].filter(Boolean);

  for (const alvo of preferencia) {
    if (disponiveisSimples.includes(alvo)) return alvo;
  }

  const qualquerGemini = disponiveisSimples.find(n => /^gemini-/.test(n));
  if (qualquerGemini) return qualquerGemini;

  throw new Error("[GEMINI REST] Não foi possível selecionar um modelo v1.");
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

// ============================== HELPERS ======================================
function normalizarTexto(texto) {
  return String(texto || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function converterGrausParaRadianos(valorEmGraus) {
  return (valorEmGraus * Math.PI) / 180;
}

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

// ============================== BUSCAS / FERRAMENTAS =========================
async function ferramentaBuscarParceirosOuDicas({ cidadesAtivas, argumentosDaFerramenta }) {
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
  const itensLimitados = itens.slice(0, 20); // mantemos 20 (pode reduzir para 10 se quiser mais velocidade)

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

// Filtros auxiliares por categoria/semântica para planejamento
const CATS_PASSEIO = ["passeio", "atração", "atracao", "tour", "barco", "lancha", "trilha", "praia", "mergulho", "buggy"];
const CATS_RESTAURANTE = ["restaurante", "pizzaria", "churrascaria", "bistrô", "bistro", "bar", "cafeteria", "sushi", "peixe", "frutos do mar"];
const CATS_HOSPEDAGEM = ["hotel", "pousada", "hostel", "resort", "hospedagem"];

// Função para filtrar parceiros por grupos semânticos
function filtrarPorGrupoSemantico(parceiros, grupo) {
  const arr = Array.isArray(parceiros) ? parceiros : [];
  const alvo = grupo === "passeio" ? CATS_PASSEIO : grupo === "restaurante" ? CATS_RESTAURANTE : CATS_HOSPEDAGEM;
  return arr.filter(p => {
    const c = normalizarTexto(p?.categoria || "");
    const n = normalizarTexto(p?.nome || "");
    const d = normalizarTexto(p?.descricao || "");
    const tags = Array.isArray(p?.tags) ? p.tags.map(t => normalizarTexto(String(t))) : [];
    const hitCategoria = alvo.some(k => c.includes(k));
    const hitNome = alvo.some(k => n.includes(k));
    const hitDesc = alvo.some(k => d.includes(k));
    const hitTag = alvo.some(k => tags.includes(k) || tags.some(t => t.includes(k)));
    return hitCategoria || hitNome || hitDesc || hitTag;
  });
}

// ============================== SAÚDE / DIAGNÓSTICOS =========================
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

// *** CORRIGIDO: usar "aplicacaoExpress" (não "app") ***
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

// ============================== PROMPTS / INTENÇÕES ==========================
// Detecta: busca_parceiro, follow_up_parceiro, pergunta_geral, mudanca_contexto,
// small_talk, planejamento_viagem, pergunta_diurna, pergunta_noturna, desconto_beneficio
async function analisarIntencaoDoUsuario(textoDoUsuario) {
  const prompt = `Classifique a frase do usuário em UMA das categorias:
- busca_parceiro
- follow_up_parceiro
- pergunta_geral
- mudanca_contexto
- small_talk
- planejamento_viagem
- pergunta_diurna
- pergunta_noturna
- desconto_beneficio

Responda apenas com a string da categoria.
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
    "pergunta_diurna",
    "pergunta_noturna",
    "desconto_beneficio"
  ]);
  return classes.has(text) ? text : "pergunta_geral";
}

async function extrairEntidadesDaBusca(texto) {
  const prompt = `Extraia entidades no formato JSON estrito (sem comentários).
Campos: {"category": string|null, "city": string|null, "terms": string[], "startDate": string|null, "endDate": string|null, "nights": number|null}
- "category": restaurante, passeio, hotel, bar, pizzaria, etc.
- "city": cidade citada se houver.
- "terms": adjetivos/filtros (ex.: "peixe", "crianças", "romântico").
- "startDate": data inicial (AAAA-MM-DD) se houver.
- "endDate": data final (AAAA-MM-DD) se houver.
- "nights": quantidade aproximada de noites, se dedutível.
Responda SOMENTE o JSON.
Frase: "${texto}"`;
  try {
    const bruto = await geminiGerarTexto(prompt);
    const parsed = JSON.parse(bruto);
    const category = typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim() : null;
    const city = typeof parsed.city === "string" && parsed.city.trim() ? parsed.city.trim() : null;
    const terms = Array.isArray(parsed.terms) ? parsed.terms.filter(t => typeof t === "string" && t.trim()).map(t => t.trim()) : [];
    const startDate = typeof parsed.startDate === "string" && parsed.startDate.trim() ? parsed.startDate.trim() : null;
    const endDate = typeof parsed.endDate === "string" && parsed.endDate.trim() ? parsed.endDate.trim() : null;
    const nights = Number.isFinite(parsed.nights) ? parsed.nights : null;
    return { category, city, terms, startDate, endDate, nights };
  } catch {
    return { category: null, city: null, terms: [], startDate: null, endDate: null, nights: null };
  }
}

async function gerarRespostaComParceiros(pergunta, historicoContents, parceiros, regiaoNome = "") {
  const historicoTexto = historicoParaTextoSimples(historicoContents);
  const contextoParceiros = JSON.stringify(parceiros ?? [], null, 2);
  const prompt = [
    "Você é o BEPIT, um concierge especialista.",
    "Responda à pergunta do usuário baseando-se EXCLUSIVAMENTE no [Contexto] de parceiros cadastrados.",
    "Evite linguagem de parceria/benefício — use tom de 'indicação' neutra.",
    "Se o usuário pedir endereço/contato/benefício, informe somente se estiver no contexto.",
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
    "Dê dicas úteis sem inventar nomes/endereços/benefícios.",
    "Não use linguagem de parceria.",
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

    // Seleção por número (1º, 2º, etc.)
    const matchNumero = texto.match(/\b(\d{1,2})(?:º|o|a|\.|°)?\b/);
    if (matchNumero) {
      const idx = Number(matchNumero[1]);
      if (Number.isFinite(idx) && idx >= 1 && idx <= listaDeParceiros.length) {
        return listaDeParceiros[idx - 1];
      }
    }

    // Ordinais
    const ordinais = ["primeiro", "segundo", "terceiro", "quarto", "quinto", "sexto", "sétimo", "setimo", "oitavo"];
    for (let i = 0; i < ordinais.length; i++) {
      if (texto.includes(ordinais[i])) {
        const pos = i + 1;
        if (pos >= 1 && pos <= listaDeParceiros.length) {
          return listaDeParceiros[pos - 1];
        }
      }
    }

    // Por nome (match parcial tolerante)
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

// ============================== PLANEJAMENTO / ROTEIROS ======================
function calcularDiasEntreDatasISO(inicioISO, fimISO) {
  try {
    const d1 = new Date(inicioISO + "T00:00:00");
    const d2 = new Date(fimISO + "T00:00:00");
    const diff = Math.max(1, Math.round((d2 - d1) / (1000 * 60 * 60 * 24)) + 1);
    return Math.min(20, Math.max(1, diff)); // limite 1–20 dias
  } catch {
    return null;
  }
}

function montarItinerario(dias, parceirosPasseio, parceirosRestaurante, parceiroHospedagem) {
  const roteiro = [];
  const passeios = [...parceirosPasseio];
  const restaurantes = [...parceirosRestaurante];

  for (let dia = 1; dia <= dias; dia++) {
    const manha = passeios[(dia - 1) % Math.max(1, passeios.length)] || null;
    const tarde = passeios[(dia) % Math.max(1, passeios.length)] || null;
    const noite = restaurantes[(dia - 1) % Math.max(1, restaurantes.length)] || null;

    roteiro.push({
      dia,
      hospedagem: dia === 1 && parceiroHospedagem ? parceiroHospedagem : null,
      manha: manha,
      tarde: tarde,
      noite: noite
    });
  }
  return roteiro;
}

function formatarItinerarioParaTexto(roteiro) {
  const linhas = [];
  for (const dia of roteiro) {
    linhas.push(`Dia ${dia.dia}:`);
    if (dia.hospedagem) {
      linhas.push(`  Hospedagem sugerida: ${dia.hospedagem.nome}${dia.hospedagem.endereco ? ` — ${dia.hospedagem.endereco}` : ""}`);
    }
    if (dia.manha) {
      linhas.push(`  Manhã (passeio): ${dia.manha.nome}${dia.manha.endereco ? ` — ${dia.manha.endereco}` : ""}`);
    }
    if (dia.tarde) {
      linhas.push(`  Tarde (passeio): ${dia.tarde.nome}${dia.tarde.endereco ? ` — ${dia.tarde.endereco}` : ""}`);
    }
    if (dia.noite) {
      const hasBeneficio = dia.noite.beneficio_bepit && String(dia.noite.beneficio_bepit).trim();
      linhas.push(`  Noite (refeição/bares): ${dia.noite.nome}${dia.noite.endereco ? ` — ${dia.noite.endereco}` : ""}${hasBeneficio ? ` (benefício: ${dia.noite.beneficio_bepit})` : ""}`);
    }
  }
  return linhas.join("\n");
}

async function lidarComPlanejamentoViagem({ textoDoUsuario, historicoGemini, regiao, cidadesAtivas, idDaConversa }) {
  // Extrai datas e termos
  const entidades = await extrairEntidadesDaBusca(textoDoUsuario);
  const dias = entidades.startDate && entidades.endDate
    ? calcularDiasEntreDatasISO(entidades.startDate, entidades.endDate)
    : (entidades.nights && entidades.nights >= 1 && entidades.nights <= 20 ? entidades.nights : 3);

  // Busca ampla de parceiros
  const resultado = await ferramentaBuscarParceirosOuDicas({
    cidadesAtivas,
    argumentosDaFerramenta: { category: null, city: entidades.city || null, terms: entidades.terms || [] }
  });

  const todos = Array.isArray(resultado?.items) ? resultado.items : [];

  // Separa por grupos
  const parceirosPasseio = filtrarPorGrupoSemantico(todos, "passeio");
  const parceirosRestaurante = filtrarPorGrupoSemantico(todos, "restaurante");
  const parceirosHospedagem = filtrarPorGrupoSemantico(todos, "hospedagem");

  // Seleciona 1 hospedagem (quando houver)
  const parceiroHospedagem = parceirosHospedagem[0] || null;

  // Se não há passeios nem restaurantes, devolve fallback seguro
  if (parceirosPasseio.length === 0 && parceirosRestaurante.length === 0) {
    const respostaModelo = await gerarRespostaGeral(textoDoUsuario, historicoGemini, regiao);
    const respostaFinal = finalizeAssistantResponse({
      modelResponseText: respostaModelo,
      foundPartnersList: [],
      mode: "general"
    });
    return { respostaFinal, parceirosSugeridos: [] };
  }

  // Monta roteiro (manhã/tarde = passeios; noite = restaurantes)
  const roteiro = montarItinerario(dias, parceirosPasseio, parceirosRestaurante, parceiroHospedagem);
  const textoItinerario = formatarItinerarioParaTexto(roteiro);

  // Resposta final: instruímos a IA a não inventar nada, e embutimos o roteiro já montado
  const prompt = [
    "Você é o BEPIT, um concierge especialista.",
    "Monte um roteiro enxuto e objetivo, sem inventar nomes/endereços/benefícios.",
    "Use os parceiros indicados abaixo, priorizando-os; se um campo (endereço/contato) não existir, não invente.",
    "Manhã e tarde: somente passeios/atrações. Noite: restaurantes/bares/eventos.",
    "",
    BEPIT_SYSTEM_PROMPT_APPENDIX,
    "",
    "[Roteiro Sugerido]:",
    textoItinerario
  ].join("\n");

  const respostaModelo = await geminiGerarTexto(prompt);
  const parceirosDoRoteiro = [
    ...roteiro.flatMap(r => [r.hospedagem, r.manha, r.tarde, r.noite].filter(Boolean))
  ];

  const respostaFinal = finalizeAssistantResponse({
    modelResponseText: respostaModelo,
    foundPartnersList: parceirosDoRoteiro,
    mode: "partners"
  });

  // Atualiza conversa
  try {
    await supabase
      .from("conversas")
      .update({ parceiros_sugeridos: parceirosDoRoteiro, parceiro_em_foco: null, topico_atual: "planejamento" })
      .eq("id", idDaConversa);
  } catch {}

  return { respostaFinal, parceirosSugeridos: parceirosDoRoteiro };
}

async function lidarComNovaBusca({ textoDoUsuario, historicoGemini, regiao, cidadesAtivas, idDaConversa }) {
  const entidades = await extrairEntidadesDaBusca(textoDoUsuario);

  const resultadoBusca = await ferramentaBuscarParceirosOuDicas({
    cidadesAtivas,
    argumentosDaFerramenta: entidades
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
        .update({ parceiros_sugeridos: parceirosSugeridos, parceiro_em_foco: null, topico_atual: entidades?.category || null })
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

// ============================== ROTA DE CHAT =================================
aplicacaoExpress.post("/api/chat/:slugDaRegiao", async (requisicao, resposta) => {
  try {
    const { slugDaRegiao } = requisicao.params;
    let { message: textoDoUsuario, conversationId: idDaConversa } = requisicao.body || {};

    if (!textoDoUsuario || typeof textoDoUsuario !== "string" || !textoDoUsuario.trim()) {
      return resposta.status(400).json({ error: "O campo 'message' é obrigatório e deve ser uma string não vazia." });
    }
    textoDoUsuario = textoDoUsuario.trim();

    // Região e cidades
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

    // Cria conversa se necessário
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

    // Carrega conversa e histórico
    let conversaAtual = null;
    try {
      const { data: conv } = await supabase
        .from("conversas")
        .select("id, parceiro_em_foco, preferencia_indicacao, topico_atual, parceiros_sugeridos")
        .eq("id", idDaConversa)
        .maybeSingle();
      conversaAtual = conv || null;
    } catch {}

    const historicoGemini = await construirHistoricoParaGemini(idDaConversa, 12);

    // Seleção direta por "1º/2º" ou nome dentre os últimos sugeridos
    const candidatosDaConversa = Array.isArray(conversaAtual?.parceiros_sugeridos) ? conversaAtual.parceiros_sugeridos : [];
    const parceiroSelecionado = encontrarParceiroNaLista(textoDoUsuario, candidatosDaConversa);
    if (parceiroSelecionado) {
      try {
        await supabase
          .from("conversas")
          .update({ parceiro_em_foco: parceiroSelecionado, parceiros_sugeridos: candidatosDaConversa })
          .eq("id", idDaConversa);
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
      case "planejamento_viagem": {
        const resultado = await lidarComPlanejamentoViagem({
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

      case "pergunta_diurna": {
        // Foque apenas em passeios/atrações
        const entidades = await extrairEntidadesDaBusca(textoDoUsuario);
        const r = await ferramentaBuscarParceirosOuDicas({
          cidadesAtivas,
          argumentosDaFerramenta: { category: null, city: entidades.city || null, terms: entidades.terms || [] }
        });
        const todos = r.items || [];
        const apenasPasseio = filtrarPorGrupoSemantico(todos, "passeio");
        if (apenasPasseio.length === 0) {
          const fallback = buildNoPartnerFallback("passeios/atrações", entidades.city || regiao.nome);
          respostaFinal = fallback.text;
          parceirosSugeridos = [];
          break;
        }
        const respostaModelo = await gerarRespostaComParceiros(textoDoUsuario, historicoGemini, apenasPasseio, regiao?.nome);
        respostaFinal = finalizeAssistantResponse({ modelResponseText: respostaModelo, foundPartnersList: apenasPasseio, mode: "partners" });
        parceirosSugeridos = apenasPasseio;
        break;
      }

      case "pergunta_noturna": {
        // Foque apenas em restaurantes/bares/eventos
        const entidades = await extrairEntidadesDaBusca(textoDoUsuario);
        const r = await ferramentaBuscarParceirosOuDicas({
          cidadesAtivas,
          argumentosDaFerramenta: { category: null, city: entidades.city || null, terms: entidades.terms || [] }
        });
        const todos = r.items || [];
        const apenasNoite = filtrarPorGrupoSemantico(todos, "restaurante");
        if (apenasNoite.length === 0) {
          const fallback = buildNoPartnerFallback("opções noturnas (restaurantes/bares/eventos)", entidades.city || regiao.nome);
          respostaFinal = fallback.text;
          parceirosSugeridos = [];
          break;
        }
        const respostaModelo = await gerarRespostaComParceiros(textoDoUsuario, historicoGemini, apenasNoite, regiao?.nome);
        respostaFinal = finalizeAssistantResponse({ modelResponseText: respostaModelo, foundPartnersList: apenasNoite, mode: "partners" });
        parceirosSugeridos = apenasNoite;
        break;
      }

      case "desconto_beneficio": {
        // Somente locais com beneficio_bepit preenchido
        const entidades = await extrairEntidadesDaBusca(textoDoUsuario);
        const r = await ferramentaBuscarParceirosOuDicas({
          cidadesAtivas,
          argumentosDaFerramenta: { category: entidades.category || "restaurante", city: entidades.city || null, terms: entidades.terms || [] }
        });
        const comBeneficio = (r.items || []).filter(p => p.beneficio_bepit && String(p.beneficio_bepit).trim());
        if (comBeneficio.length === 0) {
          const texto = "Não tenho benefícios ativos cadastrados para este pedido específico. Se quiser, posso indicar boas opções sem benefício.";
          respostaFinal = texto;
          parceirosSugeridos = [];
          break;
        }
        const respostaModelo = await gerarRespostaComParceiros(textoDoUsuario, historicoGemini, comBeneficio, regiao?.nome);
        respostaFinal = finalizeAssistantResponse({ modelResponseText: respostaModelo, foundPartnersList: comBeneficio, mode: "partners" });
        parceirosSugeridos = comBeneficio;
        break;
      }

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
          const respostaModelo = await gerarRespostaComParceiros(textoDoUsuario, historicoGemini, [parceiroEmFoco], regiao?.nome);
          respostaFinal = finalizeAssistantResponse({ modelResponseText: respostaModelo, foundPartnersList: [parceiroEmFoco], mode: "partners" });
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
        const respostaModelo = await gerarRespostaGeral(textoDoUsuario, historicoGemini, regiao);
        respostaFinal = finalizeAssistantResponse({ modelResponseText: respostaModelo, foundPartnersList: [], mode: "general" });
        try {
          await supabase.from("conversas").update({ parceiro_em_foco: null }).eq("id", idDaConversa);
        } catch {}
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
    return resposta.status(500).json({ error: "Erro interno no servidor do BEPIT.", internal: { message: String(erro?.message || erro) } });
  }
});

// ============================== FEEDBACK =====================================
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
    } catch {}
    resposta.json({ success: true });
  } catch (erro) {
    console.error("[/api/feedback] Erro:", erro);
    resposta.status(500).json({ error: "Erro interno." });
  }
});

// ============================== AUTH + ADMIN =================================
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

// ------------------------ INICIAR SERVIDOR -----------------------------------
aplicacaoExpress.listen(portaDoServidor, () => {
  console.log(`✅ BEPIT Nexus (Orquestrador v3.4 REST) rodando em http://localhost:${portaDoServidor}`);
});
