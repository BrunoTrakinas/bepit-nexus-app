// /backend-oficial/services/rag.service.js
// ============================================================================
// RAG Híbrido (768d): Indexação + Busca (vetorial + textual) com fallbacks
// - Embedding: Google "gemini-embedding-001" (v1beta) com outputDimensionality=768
// - Coluna alvo: public.parceiros.embedding_768 (vector(768))
// - RPCs v2 (devem usar embedding_768 + cosine):
//   parceiros_vector_search_v2(...) e parceiros_text_search_v2(...)
// Obs: usa SUPABASE_SERVICE_ROLE_KEY (apenas backend).
// v2.4 — correções de sintaxe, return prematuro, e bônus semânticos
// ============================================================================

import { createClient } from "@supabase/supabase-js";

// ---- Fetch Polyfill (Node.js < 18) --------------------------------------------
// Garante que 'fetch' exista em runtime sem alterar a lógica do BEPIT.
// Não muda comportamento em Node >= 18. Em Node < 18 usa 'node-fetch' sob demanda.
if (typeof fetch !== "function") {
  globalThis.fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
}
// -------------------------------------------------------------------------------

// ---------------------------- Env & Clients ---------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("[RAG] SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente(s). RAG depende do service role.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------- Parâmetros de ranking -------------------------
const WEIGHTS = {
  vector: 0.85,
  text: 0.15,
  catMatch: 0.35,        // bônus por categoria coincidente (exata)
  termHit: 0.15,         // bônus por termo encontrado (nome/descrição)
  termHitMaxBonus: 0.45, // teto dos bônus por termos (ex.: 3 hits x 0.15)
  cityMatch: 0.10,       // bônus por cidade coincidindo
  catFilterBonus: 0.10,  // bônus leve extra se filtro de categoria bateu
};

// “Gating”: se achar pelo menos 1 item “relevante”, mostra só os relevantes.
const RELEVANCE_GATE = {
  minScore: 0.18,
  requireAny: true,
};

// ---------------------------- ALIASES de categorias -------------------------
// Normaliza rótulos que os turistas escrevem → categorias do seu banco.
const CATEGORY_ALIASES = {
  // bar / noite
  "barzinho": "bar",
  "birosca": "bar",
  "biroska": "bar",
  // comida
  "picanha": "churrascaria",
  "massas": "italiano",
  "podrão": "lanchonete",
  "podrao": "lanchonete",
  "dogão": "lanchonete",
  "dogao": "lanchonete",
  "cocada": "quiosque", // normalmente em praia/quiosque
  "caldirada": "frutos do mar", // normalizado abaixo (caldeirada)
  "caldeirada": "frutos do mar",
  "anchova": "frutos do mar",
  "corvina": "frutos do mar",
  "corniva": "frutos do mar", // erro comum
  // bebida
  "deposito_bebbida": "deposito_bebidas", // typo frequente → normaliza
  "deposito_bebidas": "deposito_bebidas",
  // transporte
  "aluguel_de_carro": "locadora_veiculos",
  "motorista": "transporte",
  "taxi barco": "barco",
  "barco taxi": "barco",
  "táxi barco": "barco",
  "táxi-barco": "barco",
  // esporte aquático
  "jetsky": "esportes aquáticos",
  "jetski": "esportes aquáticos",
  // hospedagem
  "hospedagem": "hotel", // guarda-chuva; não filtramos exato (ver UMBRELLA_CATS)
  // utilidade
  "servico_utilidade": "servico_utilidade",
  "serviço utilidade": "servico_utilidade",
  // praia/estrutura
  "barraca": "quiosque",
  "praça": "passeios",
  "praca": "passeios",
  "canal": "passeios",
  "canal(local)": "passeios",
  // imobiliário / temporada
  "imóveis": "casa temporada",
  "imoveis": "casa temporada",
  "veraneio": "casa temporada",
  // “japonês” ambiguidades
  "japonês (comida)": "sushi",
  "japones (comida)": "sushi",
  "japonês": "sushi",
  "japones": "sushi",
  "japones(ilha)": "praia",     // Ilha do Japonês (ponto local)
  "japonês (ilha)": "praia",    // idem
  // barco
  "barco": "barco",
  "lancha": "barco",
};

// ---------------------------- Taxonomia EXPANDIDA ---------------------------
// Sinônimos/vocabulário comum de turista — tudo normalizado antes da comparação.
// Chaves devem refletir *categorias canônicas* do seu banco quando possível.
const TAXONOMY = {
  // ---- COMIDA / GASTRONOMIA ----
  "pizzaria": [
    "pizza", "pizzaria", "massa", "forno a lenha", "bordas recheadas", "rodízio de pizza", "rodizio de pizza"
  ],
  "restaurante": [
    "restaurante", "comida", "almoço", "almoco", "jantar", "cardápio", "prato executivo",
    "self service", "self-service", "quilo", "delivery", "marmita", "à la carte", "a la carte",
    "comida caseira", "caseira", "menu do dia", "promoção do dia", "massas"
  ],
  "italiano": [
    "italiano", "massas", "massa fresca", "nhoque", "lasanha", "spaghetti", "fetuccine", "risoto"
  ],
  "churrascaria": [
    "churrasco", "picanha", "rodizio", "rodízio", "costela", "carnes", "espeto corrido", "parrilla"
  ],
  "frutos do mar": [
    "peixe", "frutos do mar", "camarão", "lula", "polvo", "moqueca", "caldeirada", "caldirada", "ostra",
    "anchova", "corvina", "corniva"
  ],
  "sushi": [
    "sushi", "sashimi", "japonês", "japonesa", "temaki", "yakisoba", "uramaki", "hot roll"
  ],
  "hamburgueria": [
    "hambúrguer", "hamburguer", "burger", "smash", "artesanal", "combo", "batata frita", "podrão", "podrao", "dogão", "dogao"
  ],
  "lanchonete": [
    "lanche", "sanduíche", "sanduiche", "x-tudo", "pastel", "misto quente", "dogão", "dogao", "fast food"
  ],
  "bistrô": [
    "bistrô", "bistro", "cozinha autoral", "menu degustação", "vinhos"
  ],
  "cafeteria": [
    "cafeteria", "café", "espresso", "cappuccino", "latte", "mocha", "padaria", "pão na chapa", "pão de queijo", "croissant"
  ],
  "padaria": [
    "padaria", "pães", "bolo", "salgados", "pão francês", "pão doce", "fatia de bolo"
  ],
  "sorveteria": [
    "sorvete", "gelato", "picolé", "milk-shake", "milkshake", "taça"
  ],
  "açai": [
    "açaí", "acai", "tapioca", "crepioca", "creperia"
  ],
  "vegano": [
    "vegano", "vegetariano", "sem carne", "sem glúten", "sem lactose", "gluten free", "lactose free", "saudável", "saudavel"
  ],

  // ---- BEBIDAS / NOITE ----
  "bar": [
    "bar", "bares", "barzinho", "birosca", "biroska", "boteco", "pub", "chope", "chopp", "cervejaria", "choperia",
    "drinks", "caipirinha", "coquetel", "drink autoral", "balada", "lounge",
    "wine bar", "adega", "música ao vivo", "musica ao vivo", "happy hour", "pagode", "samba"
  ],
  "deposito_bebidas": [
    "depósito de bebidas", "deposito de bebidas", "bebidas 24h", "bebidas", "gelo", "carvão", "carvao"
  ],

  // ---- PASSEIOS / ATIVIDADES ----
  "barco": [
    "passeio de barco", "barco", "taxi barco", "barco taxi", "táxi barco", "lancha", "escuna", "catamarã", "catamara",
    "volta ilha", "ilha", "gruta", "gruta azul", "paradas para banho", "praias", "pôr do sol", "por do sol"
  ],
  "trilha": [
    "trilha", "trilha leve", "mirante", "nascer do sol", "sunrise", "por do sol", "pôr do sol",
    "quadriciclo", "buggy", "city tour", "tour", "ecoturismo", "praça", "canal", "canal itajuru"
  ],
  "mergulho": [
    "mergulho", "batismo", "snorkel", "snorkeling", "cilindro", "neoprene", "visibilidade"
  ],
  "esportes aquáticos": [
    "stand up paddle", "sup", "caiaque", "kayak", "windsurf", "kitesurf", "kite", "surf", "aula de surf", "wakeboard",
    "jetski", "jetsky"
  ],

  // ---- PRAIA / ESTRUTURA ----
  "praia": [
    "praia", "praias", "orla", "bandeira azul", "faixa de areia", "mar calmo", "mar forte",
    "quiosque", "quiosques", "aluguel de cadeira", "aluguel de guarda-sol", "guarda sol", "sombrinha",
    "praia para criança", "praia família", "pet friendly", "ilha do japonês", "japones ilha", "ilha japones"
  ],
  "quiosque": [
    "quiosque", "barraca", "cocada", "porção", "porcoes", "caipirinha", "cerveja", "tira-gosto", "tira gosto"
  ],

  // ---- HOSPEDAGEM ----
  "pousada": [
    "pousada", "café da manhã", "cafe da manha", "piscina", "quartos", "suite", "suíte", "estacionamento", "pet friendly"
  ],
  "hotel": [
    "hotel", "resort", "hospedagem", "hostel", "albergue", "flat", "apart hotel", "apart-hotel",
    "beira mar", "beira-mar", "pé na areia", "pe na areia", "vista para o mar", "hidromassagem", "spa"
  ],
  "casa temporada": [
    "casa temporada", "temporada", "aluguel por temporada", "kitnet", "apartamento temporada", "imóveis", "imoveis", "veraneio"
  ],

  // ---- TRANSPORTE ----
  "transporte": [
    "transporte", "transfer", "van", "uber", "táxi", "taxi", "motorista particular", "carona", "ônibus", "onibus",
    "rodoviária", "rodoviaria", "bicicleta", "bike", "patinete"
  ],
  "locadora_veiculos": [
    "aluguel de carro", "locadora", "rent a car", "carro", "diária", "diaria", "franquia", "seguro"
  ],

  // ---- SERVIÇOS PÚBLICOS / EMERGÊNCIA ----
  "servico_utilidade": [
    "serviço público", "servicos publicos", "banco", "caixa eletrônico", "caixa 24 horas", "24h",
    "farmácia", "farmacia", "hospital", "upa", "emergência", "emergencia",
    "delegacia", "polícia", "policia", "guarda municipal", "capitania dos portos", "bombeiros", "samu",
    "lavanderia", "loja de conveniência", "conveniencia", "mercado", "supermercado",
    "hortifruti", "açougue", "acougue", "shopping", "feira", "artesanato", "souvenir", "lembrancinha", "lavanderia"
  ],
};

// Categorias guarda-chuva → não filtrar exato no SQL, deixar o ranking decidir.
const UMBRELLA_CATS = new Set([
  "comida", "bebidas", "passeios", "praias", "hospedagem", "transporte", "serviço público", "servico publico",
  "utilidade", "servico_utilidade"
]);

// ---------------------------- Utils -----------------------------------------
function normalize(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function mapAliasCategory(cat) {
  if (!cat) return null;
  const n = normalize(cat || "");
  return CATEGORY_ALIASES[n] ? CATEGORY_ALIASES[n] : n;
}

function safeJoinTexts(chunks = [], maxLen = 8000) {
  const parts = [];
  for (const c of chunks) {
    const t = (c?.text ?? "").toString();
    if (t) parts.push(t);
  }
  const raw = parts.join("\n\n").trim();
  if (!raw) return null;
  return raw.slice(0, maxLen);
}

function ensureArrayFloat(x) {
  if (!Array.isArray(x)) return [];
  return x.map((v) => (typeof v === "number" ? v : Number(v))).filter((n) => Number.isFinite(n));
}

// ------------------------- Embedding (forçar 768) ---------------------------
async function embedText768(text) {
  if (!GEMINI_API_KEY) {
    throw new Error("[Embeddings] GEMINI_API_KEY não definido.");
  }
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent" +
    `?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const body = {
    model: "models/gemini-embedding-001",
    content: { parts: [{ text: String(text || "") }] },
    taskType: "RETRIEVAL_DOCUMENT",
    outputDimensionality: 768,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`[Gemini Embeddings] HTTP ${resp.status} ${resp.statusText}: ${txt}`);
  }

  const data = await resp.json();
  const vec =
    data?.embedding?.values ||
    data?.embedding?.value ||
    (Array.isArray(data?.embedding) ? data.embedding : null);

  const arr = ensureArrayFloat(vec);
  if (arr.length !== 768) throw new Error(`Embedding dimension mismatch: got ${arr.length}, expected 768`);
  return arr;
}

// ------------------------- INDEXAÇÃO (salvar 768) ---------------------------
export async function indexPartnerText(partnerId, chunks = []) {
  if (!partnerId) throw new Error("partnerId é obrigatório.");

  // 1) base de texto
  let baseText = safeJoinTexts(chunks);
  if (!baseText) {
    const { data: p, error: perr } = await supabase
      .from("parceiros")
      .select("id, nome, descricao")
      .eq("id", partnerId)
      .maybeSingle();
    if (perr) throw perr;
    if (!p) throw new Error("Parceiro não encontrado.");
    const nome = p?.nome ? `Nome: ${p.nome}` : "";
    const desc = p?.descricao ? `\n\nDescrição: ${p.descricao}` : "";
    baseText = (nome + desc).trim();
    if (!baseText) throw new Error("Sem conteúdo para indexar.");
  }

  // 2) embedding 768
  const embedding = await embedText768(baseText);

  // 3) grava
  const { error: uerr } = await supabase
    .from("parceiros")
    .update({ embedding_768: embedding })
    .eq("id", partnerId);
  if (uerr) throw uerr;

  return { ok: true, partnerId, savedColumn: "embedding_768", dims: embedding.length, usedChunks: chunks.length || 0 };
}

// --------------------------- Sinais genéricos --------------------------------
function extractSignals(q, hintedCategory = null) {
  const qn = normalize(q || "");
  const terms = new Set();
  const wantedCategories = new Set();

  // 0) normalizar “categoria sugerida” via aliases (se veio do caller)
  let hinted = mapAliasCategory(hintedCategory);

  // 1) se não for guarda-chuva, adicionar
  if (hinted && !UMBRELLA_CATS.has(hinted)) {
    wantedCategories.add(hinted);
  }

  // 2) varre TAXONOMY e também ALIASES a partir do texto da query
  for (const [cat, syns] of Object.entries(TAXONOMY)) {
    const catN = normalize(cat);
    const list = Array.isArray(syns) ? syns : [];
    const hit = list.some((kw) => qn.includes(normalize(kw))) || qn.includes(catN);

    // Também verifica termos que mapeariam para esse cat via alias
    const aliasHit = Object.entries(CATEGORY_ALIASES).some(([alias, canonical]) => {
      return canonical === catN && qn.includes(normalize(alias));
    });

    if (hit || aliasHit) {
      wantedCategories.add(catN);
      for (const kw of list) terms.add(normalize(kw));
      terms.add(catN);
    }
  }

  // 3) fallback leve: palavras “maiores” para ajudar
  const rawWords = qn.split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of rawWords) {
    if (w.length >= 4) terms.add(w);
  }

  // 4) reforços diretos por termos específicos da sua lista
  const directReinforce = [
    "barzinho", "birosca", "biroska", "picanha", "caldirada", "caldeirada", "anchova", "corvina", "corniva",
    "barraca", "motorista", "aluguel_de_carro", "jetski", "jetsky", "lancha", "massas",
    "podrão", "podrao", "dogão", "dogao", "cocada", "praça", "tailandesa", "canal", "pousada",
    "imóveis", "imoveis", "veraneio", "quiosque", "deposito_bebbida", "deposito_bebidas", "lavanderia",
    "servico_utilidade", "hospedagem", "taxi barco", "barco taxi", "japones(ilha)"
  ];
  for (const t of directReinforce) {
    if (qn.includes(normalize(t))) {
      terms.add(normalize(t));
      const mapped = mapAliasCategory(t);
      if (mapped && !UMBRELLA_CATS.has(mapped)) wantedCategories.add(mapped);
    }
  }

  return {
    terms: Array.from(terms),
    wantedCategories: Array.from(wantedCategories),
  };
}

function computeAffinity(item, signals) {
  const cat = normalize(item.categoria || item.category || "");
  const nome = normalize(item.nome || item.name || "");
  const desc = normalize(item.descricao || item.description || "");

  let bonus = 0;
  let hits = 0;

  if (signals.wantedCategories.length > 0 && signals.wantedCategories.includes(cat)) {
    bonus += WEIGHTS.catMatch;
  }

  if (signals.terms.length > 0) {
    for (const t of signals.terms) {
      if (!t) continue;
      if (nome.includes(t) || desc.includes(t)) hits++;
    }
    const termBonus = Math.min(hits * WEIGHTS.termHit, WEIGHTS.termHitMaxBonus);
    bonus += termBonus;
  }

  return { bonus, hits };
}

// --------------------------- BUSCA HÍBRIDA ----------------------------------
export async function hybridSearch({ q, cidade_id, categoria, limit = 10, debug = false }) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 30));
  const filtroCidadeOriginal = cidade_id || null;
  let filtroCidade = filtroCidadeOriginal;

  // normaliza categoria entrada via alias
  let filtroCategoria = mapAliasCategory((categoria || "").trim() || null);
  if (filtroCategoria && UMBRELLA_CATS.has(filtroCategoria)) {
    // categorias guarda-chuva: não filtre exato no SQL
    filtroCategoria = null;
  }

  const signals = extractSignals(q, filtroCategoria);

  const meta = {
    input: { q, cidade_id: filtroCidade, categoria: filtroCategoria, limit: safeLimit },
    steps: {
      vector_v2: { tried: false, count: 0, error: null, scope: "full" },
      text_v2: { tried: false, count: 0, error: null, scope: "full" },
      backoff_no_cat: { tried: false, count: 0, error: null },
      backoff_no_city: { tried: false, count: 0, error: null },
      text_rpc_fallback: { tried: false, count: 0, error: null },
      table_fallback: { tried: false, count: 0, error: null },
    },
    signals,
  };

  async function runVector(qVec, { filtroCidade, filtroCategoria, label = "vector_v2" }) {
    meta.steps[label].tried = true;
    const { data: vrows, error } = await supabase.rpc("parceiros_vector_search_v2", {
      query_embedding: qVec,
      match_count: safeLimit * 3,
      filtro_cidade_id: filtroCidade,
      filtro_categoria: filtroCategoria,
    });
    if (error) throw error;
    const rows = Array.isArray(vrows) ? vrows : [];
    meta.steps[label].count = rows.length;
    return rows;
  }

  async function runText({ filtroCidade, filtroCategoria, label = "text_v2" }) {
    meta.steps[label].tried = true;
    const { data: trows, error } = await supabase.rpc("parceiros_text_search_v2", {
      q_ilike: q ? `%${q}%` : "%",
      filtro_cidade_id: filtroCidade,
      filtro_categoria: filtroCategoria,
      fetch_count: safeLimit * 3,
    });
    if (error) throw error;
    const rows = Array.isArray(trows) ? trows : [];
    meta.steps[label].count = rows.length;
    return rows;
  }

  let vectorRows = [];
  let textRows = [];

  try {
    if (q && GEMINI_API_KEY) {
      const qVec = await embedText768(q);
      try {
        vectorRows = await runVector(qVec, { filtroCidade, filtroCategoria, label: "vector_v2" });
      } catch (e) {
        meta.steps.vector_v2.error = String(e?.message || e);
        vectorRows = [];
      }
    }

    try {
      textRows = await runText({ filtroCidade, filtroCategoria, label: "text_v2" });
    } catch (e) {
      meta.steps.text_v2.error = String(e?.message || e);
      textRows = [];
    }

    // backoff: sem categoria
    if (vectorRows.length === 0 && textRows.length === 0 && filtroCategoria) {
      meta.steps.backoff_no_cat.tried = true;
      const noCat = null;
      if (q && GEMINI_API_KEY) {
        try {
          const qVec = await embedText768(q);
          const rows = await runVector(qVec, { filtroCidade, filtroCategoria: noCat, label: "vector_v2" });
          vectorRows = rows;
        } catch {}
      }
      try {
        const rows = await runText({ filtroCidade, filtroCategoria: noCat, label: "text_v2" });
        textRows = rows;
      } catch {}
      meta.steps.backoff_no_cat.count = (vectorRows?.length || 0) + (textRows?.length || 0);
    }

    // backoff: sem cidade
    if (vectorRows.length === 0 && textRows.length === 0 && filtroCidade) {
      meta.steps.backoff_no_city.tried = true;
      filtroCidade = null;
      if (q && GEMINI_API_KEY) {
        try {
          const qVec = await embedText768(q);
          const rows = await runVector(qVec, { filtroCidade: null, filtroCategoria, label: "vector_v2" });
          vectorRows = rows;
        } catch {}
      }
      try {
        const rows = await runText({ filtroCidade: null, filtroCategoria, label: "text_v2" });
        textRows = rows;
      } catch {}
      meta.steps.backoff_no_city.count = (vectorRows?.length || 0) + (textRows?.length || 0);
    }
  } catch {
    // segue para fallbacks legados
  }

  // fallbacks legados
  if ((!textRows || textRows.length === 0) && q) {
    try {
      meta.steps.text_rpc_fallback.tried = true;
      const { data: trows2, error: terr2 } = await supabase.rpc("search_parceiros", {
        p_cidade_id: filtroCidade,
        p_categoria_norm: filtroCategoria || null,
        p_term_norm: (q || "").toLowerCase().trim() || null,
        p_limit: safeLimit * 3,
      });
      if (terr2) throw terr2;
      textRows = (Array.isArray(trows2) ? trows2 : []).map((r) => ({
        ...r,
        text_score: typeof r.text_score === "number" ? r.text_score : 0.5,
      }));
      meta.steps.text_rpc_fallback.count = textRows.length;
    } catch (e) {
      meta.steps.text_rpc_fallback.error = String(e?.message || e);
    }
  }

  if ((!textRows || textRows.length === 0) && q) {
    try {
      meta.steps.table_fallback.tried = true;
      const { data: rowsTbl } = await supabase
        .from("parceiros")
        .select("id, nome, descricao, cidade_id, categoria")
        .or(`nome.ilike.%${q}%,descricao.ilike.%${q}%`)
        .limit(safeLimit * 3);
      const asArray = Array.isArray(rowsTbl) ? rowsTbl : [];
      textRows = asArray.map((r) => ({ ...r, text_score: 0.4 }));
      meta.steps.table_fallback.count = textRows.length;
    } catch (e) {
      meta.steps.table_fallback.error = String(e?.message || e);
    }
  }

  // ----------------------- Merge + re-rank com sinais genéricos -------------
  const mapById = new Map();

  for (const r of vectorRows) {
    const id = r.id ?? r.parceiro_id ?? r.partner_id;
    if (!id) continue;
    const vScore = typeof r.similarity === "number" ? r.similarity : typeof r.score === "number" ? r.score : 0;
    mapById.set(id, { ...r, score_vector: vScore, score_text: 0 });
  }
  for (const r of textRows) {
    const id = r.id ?? r.parceiro_id ?? r.partner_id;
    if (!id) continue;
    const tScore = typeof r.text_score === "number" ? r.text_score : typeof r.score === "number" ? r.score : 0;
    if (!mapById.has(id)) mapById.set(id, { ...r, score_vector: 0, score_text: tScore });
    else {
      const prev = mapById.get(id);
      mapById.set(id, { ...prev, score_text: Math.max(prev.score_text || 0, tScore) });
    }
  }

  const qNorm = (q || "").toLowerCase();

  // Intenções comuns
  const mentionsPizza = /\b(pizza|pizzaria)\b/.test(qNorm);
  const mentionsSushi = /\b(sushi|japon[eê]s)\b/.test(qNorm);
  const mentionsCarne = /\b(picanha|churrasco|carne)\b/.test(qNorm);

  // Bônus de re-rank por correspondência de categoria/termo
  const BONUS = {
    pizzaCatExact: 0.25,
    pizzaWord: 0.20,
    sushiCatExact: 0.25,
    sushiWord: 0.20,
    carneCatExact: 0.20,
    carneWord: 0.15,
  };

  const merged = Array.from(mapById.values()).map((r) => {
    let score_final = WEIGHTS.vector * (r.score_vector || 0) + WEIGHTS.text * (r.score_text || 0);

    // Bônus por filtros “duros” aplicados
    if (filtroCidade && (r.cidade_id === filtroCidade || r.cidade === filtroCidade)) score_final += WEIGHTS.cityMatch;
    const catFilter = (r.categoria || r.category || "").toLowerCase();
    if (filtroCategoria && catFilter === filtroCategoria) score_final += WEIGHTS.catFilterBonus;

    const cat = (r.categoria || r.category || "").toLowerCase();
    const nome = (r.nome || r.name || "").toLowerCase();
    const desc = (r.descricao || r.description || "").toLowerCase();

    // Pizza
    if (mentionsPizza) {
      if (cat === "pizzaria") score_final += BONUS.pizzaCatExact;
      if (nome.includes("pizza") || desc.includes("pizza")) score_final += BONUS.pizzaWord;
    }
    // Sushi / Japonês
    if (mentionsSushi) {
      if (["sushi", "japonesa", "japones", "japonês"].includes(cat)) score_final += BONUS.sushiCatExact;
      if (nome.includes("sushi") || nome.includes("japon") || desc.includes("sushi") || desc.includes("japon")) {
        score_final += BONUS.sushiWord;
      }
    }
    // Carne / Churrasco
    if (mentionsCarne) {
      if (["churrascaria", "carne"].includes(cat)) score_final += BONUS.carneCatExact;
      if (nome.includes("picanha") || nome.includes("churras") || desc.includes("picanha") || desc.includes("churras")) {
        score_final += BONUS.carneWord;
      }
    }

    // Afinidade genérica com sinais (categoria/termos)
    const aff = computeAffinity(r, signals);
    score_final += aff.bonus;

    return { ...r, score_final };
  });

  const rankedAll =
    merged.length === 0
      ? (textRows || []).sort((a, b) => {
          const at = typeof a.text_score === "number" ? a.text_score : 0;
          const bt = typeof b.text_score === "number" ? b.text_score : 0;
          if (bt !== at) return bt - at;
          return (a.nome || a.name || "").localeCompare(b.nome || b.name || "");
        })
      : merged.sort((a, b) => b.score_final - a.score_final);

  // Preferência: se a intenção for pizza e existirem itens coerentes, mostre só eles
  let preferred = rankedAll;
  if (mentionsPizza) {
    const keep = rankedAll.filter((r) => {
      const cat = (r.categoria || r.category || "").toLowerCase();
      const nome = (r.nome || r.name || "").toLowerCase();
      const desc = (r.descricao || r.description || "").toLowerCase();
      return cat === "pizzaria" || nome.includes("pizza") || desc.includes("pizza");
    });
    if (keep.length > 0) preferred = keep;
  }

  // ----------------------- Gating genérico ----------------------------------
  let finalList = preferred;
  if (RELEVANCE_GATE.requireAny) {
    const relevant = preferred.filter((r) => {
      const aff = computeAffinity(r, signals);
      return aff.bonus >= RELEVANCE_GATE.minScore;
    });
    if (relevant.length > 0) finalList = relevant;
  }

  const items = finalList.slice(0, safeLimit);
  return debug ? { items, meta } : items;
}

// -------------------------- Stubs e utilidades ------------------------------
export async function searchSimilar(query, { partnerId, k }) {
  console.log(`[RAG] searchSimilar (stub compat): q="${query}", partnerId=${partnerId}, k=${k}`);
  return { results: [] };
}

// (Des)indexação e batch -----------------------------------------------------
export async function indexPartnerById(partnerId, { reactivate = false } = {}) {
  const { data: parceiro, error: errLoad } = await supabase
    .from("parceiros")
    .select("id, nome, descricao, categoria, ativo")
    .eq("id", partnerId)
    .single();
  if (errLoad || !parceiro) throw new Error("Parceiro não encontrado para indexação.");

  const baseText = [parceiro.nome || "", parceiro.categoria ? `Categoria: ${parceiro.categoria}` : "", parceiro.descricao || ""]
    .filter(Boolean)
    .join("\n");

  const vec = await embedText768(baseText);

  const patch = { embedding_768: vec };
  if (reactivate) patch.ativo = true;

  const { error: errUp } = await supabase.from("parceiros").update(patch).eq("id", partnerId);
  if (errUp) throw errUp;
  return { ok: true, partnerId, dims: vec.length };
}

export async function pausePartnerIndex(partnerId, { motivo } = {}) {
  const { error } = await supabase
    .from("parceiros")
    .update({ ativo: false, embedding_768: null, bloqueado: true, bloqueado_motivo: motivo || "bloqueado pelo admin" })
    .eq("id", partnerId);
  if (error) throw error;
  return { ok: true, partnerId };
}

export async function reactivatePartnerIndex(partnerId) {
  const r = await indexPartnerById(partnerId, { reactivate: true });
  await supabase.from("parceiros").update({ bloqueado: false, bloqueado_motivo: null }).eq("id", partnerId);
  return r;
}

export async function forgetPartnerForever(partnerId) {
  const { error } = await supabase.from("parceiros").delete().eq("id", partnerId);
  if (error) throw error;
  return { ok: true, partnerId };
}

export async function bulkIndexPartners({ cidade_id = null, categoria = null, onlyMissing = true, limit = 500 }) {
  let qb = supabase
    .from("parceiros")
    .select("id, nome, descricao, categoria, ativo, bloqueado, embedding_768", { count: "exact" })
    .limit(Math.max(1, Math.min(limit, 2000)));

  qb = qb.eq("ativo", true).or("bloqueado.is.null,bloqueado.is.false");
  if (cidade_id) qb = qb.eq("cidade_id", cidade_id);
  if (categoria) qb = qb.eq("categoria", mapAliasCategory(categoria));
  if (onlyMissing) qb = qb.is("embedding_768", null);

  const { data: rows, error, count } = await qb;
  if (error) throw error;

  const ids = (rows || []).map((r) => r.id);
  let ok = 0,
    fail = 0;
  const errors = [];

  for (const pid of ids) {
    try {
      await indexPartnerText(pid, []);
      ok++;
    } catch (e) {
      fail++;
      errors.push({ id: pid, error: String(e?.message || e) });
    }
  }

  return { total_candidates: count ?? ids.length, processed: ids.length, ok, fail, errors };
}
