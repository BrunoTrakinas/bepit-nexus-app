// /backend-oficial/services/rag.service.js
// v2.7 — Cache Buster (Força o deploy no Render)
// Contém TODAS as 3 correções: Fallback, Gating de Nome, e Umbrella.

import { createClient } from "@supabase/supabase-js";

// ---- Fetch Polyfill (Node.js < 18) ----
if (typeof fetch !== "function") {
  globalThis.fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
}

// ---------------------------- Env & Clients ---------------------------------
console.log("[RAG] Carregando rag.service.js v2.7 (Cache Buster)..."); // NOVO

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
  vector: 0.85, text: 0.15, catMatch: 0.35, termHit: 0.15, 
  termHitMaxBonus: 0.45, cityMatch: 0.10, catFilterBonus: 0.10,
};
const RELEVANCE_GATE = { minScore: 0.18, requireAny: true };

// ---------------------------- ALIASES de categorias -------------------------
// (Baseado no [cite: 10-11] - Aliases mantidos)
const CATEGORY_ALIASES = {
  "barzinho": "bar", "birosca": "bar", "biroska": "bar", "picanha": "churrascaria", "massas": "italiano",
  "podrão": "lanchonete", "podrao": "lanchonete", "dogão": "lanchonete", "dogao": "lanchonete",
  "cocada": "quiosque", "caldirada": "frutos do mar", "caldeirada": "frutos do mar", "anchova": "frutos do mar",
  "corvina": "frutos do mar", "corniva": "frutos do mar", "deposito_bebbida": "deposito_bebidas",
  "deposito_bebidas": "deposito_bebidas", "aluguel_de_carro": "locadora_veiculos", "motorista": "transporte",
  "taxi barco": "barco", "barco taxi": "barco", "táxi barco": "barco", "táxi-barco": "barco",
  "jetsky": "esportes aquáticos", "jetski": "esportes aquáticos", "hospedagem": "hotel",
  "servico_utilidade": "servico_utilidade", "serviço utilidade": "servico_utilidade", "barraca": "quiosque",
  "praça": "passeios", "praca": "passeios", "canal": "passeios", "canal(local)": "passeios",
  "imóveis": "casa temporada", "imoveis": "casa temporada", "veraneio": "casa temporada",
  "japonês (comida)": "sushi", "japones (comida)": "sushi", "japonês": "sushi", "japones": "sushi",
  "japones(ilha)": "praia", "japonês (ilha)": "praia", "barco": "barco", "lancha": "barco",
};

// ---------------------------- Taxonomia EXPANDIDA ---------------------------
// (Baseado no [cite: 12-14] - Taxonomia mantida)
const TAXONOMY = {
  "pizzaria": ["pizza","pizzaria","massa","forno a lenha","bordas recheadas","rodízio de pizza","rodizio de pizza"],
  "restaurante": ["restaurante","comida","almoço","almoco","jantar","cardápio","prato executivo","self service","self-service","quilo","delivery","marmita","à la carte","a la carte","comida caseira","caseira","menu do dia","promoção do dia","massas"],
  "italiano": ["italiano","massas","massa fresca","nhoque","lasanha","spaghetti","fetuccine","risoto"],
  "churrascaria": ["churrasco","picanha","rodizio","rodízio","costela","carnes","espeto corrido","parrilla"],
  "frutos do mar": ["peixe","frutos do mar","camarão","lula","polvo","moqueca","caldeirada","caldirada","ostra","anchova","corvina","corniva"],
  "sushi": ["sushi","sashimi","japonês","japonesa","temaki","yakisoba","uramaki","hot roll"],
  "hamburgueria": ["hambúrguer","hamburguer","burger","smash","artesanal","combo","batata frita","podrão","podrao","dogão","dogao"],
  "lanchonete": ["lanche","sanduíche","sanduiche","x-tudo","pastel","misto quente","dogão","dogao","fast food"],
  "bistrô": ["bistrô","bistro","cozinha autoral","menu degustação","vinhos"],
  "cafeteria": ["cafeteria","café","espresso","cappuccino","latte","mocha","padaria","pão na chapa","pão de queijo","croissant"],
  "padaria": ["padaria","pães","bolo","salgados","pão francês","pão doce","fatia de bolo"],
  "sorveteria": ["sorvete","gelato","picolé","milk-shake","milkshake","taça"],
  "açai": ["açaí","acai","tapioca","crepioca","creperia"],
  "vegano": ["vegano","vegetariano","sem carne","sem glúten","sem lactose","gluten free","lactose free","saudável","saudavel"],
  "bar": ["bar","bares","barzinho","birosca","biroska","boteco","pub","chope","chopp","cervejaria","choperia","drinks","caipirinha","coquetel","drink autoral","balada","lounge","wine bar","adega","música ao vivo","musica ao vivo","happy hour","pagode","samba"],
  "deposito_bebidas": ["depósito de bebidas","deposito de bebidas","bebidas 24h","bebidas","gelo","carvão","carvao"],
  "barco": ["passeio de barco","barco","taxi barco","barco taxi","táxi barco","lancha","escuna","catamarã","catamara","volta ilha","ilha","gruta","gruta azul","paradas para banho","praias","pôr do sol","por do sol"],
  "trilha": ["trilha","trilha leve","mirante","nascer do sol","sunrise","por do sol","pôr do sol","quadriciclo","buggy","city tour","tour","ecoturismo","praça","canal","canal itajuru"],
  "mergulho": ["mergulho","batismo","snorkel","snorkeling","cilindro","neoprene","visibilidade"],
  "esportes aquáticos": ["stand up paddle","sup","caiaque","kayak","windsurf","kitesurf","kite","surf","aula de surf","wakeboard","jetski","jetsky"],
  "praia": ["praia","praias","orla","bandeira azul","faixa de areia","mar calmo","mar forte","quiosque","quiosques","aluguel de cadeira","aluguel de guarda-sol","guarda sol","sombrinha","praia para criança","praia família","pet friendly","ilha do japonês","japones ilha","ilha japones"],
  "quiosque": ["quiosque","barraca","cocada","porção","porcoes","caipirinha","cerveja","tira-gosto","tira gosto"],
  "pousada": ["pousada","café da manhã","cafe da manha","piscina","quartos","suite","suíte","estacionamento","pet friendly"],
  "hotel": ["hotel","resort","hospedagem","hostel","albergue","flat","apart hotel","apart-hotel","beira mar","beira-mar","pé na areia","pe na areia","vista para o mar","hidromassagem","spa"],
  "casa temporada": ["casa temporada","temporada","aluguel por temporada","kitnet","apartamento temporada","imóveis","imoveis","veraneio"],
  "transporte": ["transporte","transfer","van","uber","táxi","taxi","motorista particular","carona","ônibus","onibus","rodoviária","rodoviaria","bicicleta","bike","patinete"],
  "locadora_veiculos": ["aluguel de carro","locadora","rent a car","carro","diária","diaria","franquia","seguro"],
  "servico_utilidade": ["serviço público","servicos publicos","banco","caixa eletrônico","caixa 24 horas","24h","farmácia","farmacia","hospital","upa","emergência","emergencia","delegacia","polícia","policia","guarda municipal","capitania dos portos","bombeiros","samu","lavanderia","loja de conveniência","conveniencia","mercado","supermercado","hortifruti","açougue","acougue","shopping","feira","artesanato","souvenir","lembrancinha","lavanderia"],
};

// Categorias guarda-chuva
const UMBRELLA_CATS = new Set(["comida","bebidas","passeios","hospedagem","transporte","serviço público","servico publico","utilidade","servico_utilidade"]);

// ---------------------------- Utils -----------------------------------------
function normalize(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
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
// (Baseado no [cite: 33-39] - embedText768 mantido)
async function embedText768(text) {
  if (!GEMINI_API_KEY) throw new Error("[Embeddings] GEMINI_API_KEY não definido.");
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent" +
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
  const vec = data?.embedding?.values || data?.embedding?.value || (Array.isArray(data?.embedding) ? data.embedding : null);
  const arr = ensureArrayFloat(vec);
  if (arr.length !== 768) throw new Error(`Embedding dimension mismatch: got ${arr.length}, expected 768`);
  return arr;
}

// ------------------------- INDEXAÇÃO (salvar 768) ---------------------------
// (Baseado no [cite: 40-45] - indexPartnerText mantido)
export async function indexPartnerText(partnerId, chunks = []) {
  if (!partnerId) throw new Error("partnerId é obrigatório.");
  let baseText = safeJoinTexts(chunks);
  if (!baseText) {
    const { data: p, error: perr } = await supabase.from("parceiros").select("id, nome, descricao").eq("id", partnerId).maybeSingle();
    if (perr) throw perr;
    if (!p) throw new Error("Parceiro não encontrado.");
    const nome = p?.nome ? `Nome: ${p.nome}` : "";
    const desc = p?.descricao ? `\n\nDescrição: ${p.descricao}` : "";
    baseText = (nome + desc).trim();
    if (!baseText) throw new Error("Sem conteúdo para indexar.");
  }
  const embedding = await embedText768(baseText);
  const { error: uerr } = await supabase.from("parceiros").update({ embedding_768: embedding }).eq("id", partnerId);
  if (uerr) throw uerr;
  return { ok: true, partnerId, savedColumn: "embedding_768", dims: embedding.length, usedChunks: chunks.length || 0 };
}

// --------------------------- Sinais genéricos --------------------------------
// (Baseado no [cite: 46-62] - extractSignals e computeAffinity mantidos)
function extractSignals(q, hintedCategory = null) {
  const qn = normalize(q || "");
  const terms = new Set();
  const wantedCategories = new Set();
  let hinted = mapAliasCategory(hintedCategory);
  if (hinted && !UMBRELLA_CATS.has(hinted)) wantedCategories.add(hinted);
  for (const [cat, syns] of Object.entries(TAXONOMY)) {
    const catN = normalize(cat);
    const list = Array.isArray(syns) ? syns : [];
    const hit = list.some((kw) => qn.includes(normalize(kw))) || qn.includes(catN);
    const aliasHit = Object.entries(CATEGORY_ALIASES).some(([alias, canonical]) => canonical === catN && qn.includes(normalize(alias)));
    if (hit || aliasHit) {
      wantedCategories.add(catN);
      for (const kw of list) terms.add(normalize(kw));
      terms.add(catN);
    }
  }
  const rawWords = qn.split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of rawWords) if (w.length >= 4) terms.add(w);
  const directReinforce = [
    "barzinho","birosca","biroska","picanha","caldirada","caldeirada","anchova","corvina","corniva",
    "barraca","motorista","aluguel_de_carro","jetski","jetsky","lancha","massas",
    "podrão","podrao","dogão","dogao","cocada","praça","tailandesa","canal","pousada",
    "imóveis","imoveis","veraneio","quiosque","deposito_bebbida","deposito_bebidas","lavanderia",
    "servico_utilidade","hospedagem","taxi barco","barco taxi","japones(ilha)"
  ];
  for (const t of directReinforce) {
    if (qn.includes(normalize(t))) {
      terms.add(normalize(t));
      const mapped = mapAliasCategory(t);
      if (mapped && !UMBRELLA_CATS.has(mapped)) wantedCategories.add(mapped);
    }
  }
  return { terms: Array.from(terms), wantedCategories: Array.from(wantedCategories) };
}
function computeAffinity(item, signals) {
  const cat = normalize(item.categoria || item.category || "");
  const nome = normalize(item.nome || item.name || "");
  const desc = normalize(item.descricao || item.description || "");
  let bonus = 0;
  let hits = 0;
  if (signals.wantedCategories.length > 0 && signals.wantedCategories.includes(cat)) bonus += WEIGHTS.catMatch;
  if (signals.terms.length > 0) {
    for (const t of signals.terms) {
      if (!t) continue;
      if (nome.includes(t) || desc.includes(t)) hits++;
    }
    bonus += Math.min(hits * WEIGHTS.termHit, WEIGHTS.termHitMaxBonus);
  }
  return { bonus, hits };
}

// --------------------------- BUSCA HÍBRIDA (v2.7) ----------------------------------
export async function hybridSearch({ q, cidade_id, categoria, limit = 10, debug = false }) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 30));
  const filtroCidadeOriginal = cidade_id || null;
  let filtroCidade = filtroCidadeOriginal;

  let filtroCategoria = mapAliasCategory((categoria || "").trim() || null);
  
  // ==========================================================
  // CORREÇÃO 1: Desativar a lógica do UMBRELLA_CATS que apaga o filtro
  // ==========================================================
  // if (filtroCategoria && UMBRELLA_CATS.has(filtroCategoria)) filtroCategoria = null; // (BUG DESATIVADO)
  // ==========================================================

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
  try { // (Lógica de busca original [cite: 433-448])
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
  } catch { /* segue para fallbacks legados */ }

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
        text_score: Number.isFinite(r.text_score) ? r.text_score : 0.5,
      }));
      meta.steps.text_rpc_fallback.count = textRows.length;
    } catch (e) {
      meta.steps.text_rpc_fallback.error = String(e?.message || e);
    }
  }

  // ==========================================================
  // CORREÇÃO 2: Forçar o filtro de categoria no table_fallback
  // (Isso cura o "Pizzaria -> Localiza")
  // ==========================================================
  if ((!textRows || textRows.length === 0) && q) {
    try {
      console.log("[RAG v2.7] EXECUTANDO TABLE_FALLBACK CORRIGIDO!");
      meta.steps.table_fallback.tried = true;
      
      let query = supabase
        .from("parceiros")
        .select("id, nome, descricao, cidade_id, categoria")
        .or(`nome.ilike.%${q}%,descricao.ilike.%${q}%`); // Busca pelo texto
        
      // CORREÇÃO: Força o filtro de categoria se ele existir
      if (filtroCategoria) {
        query = query.eq('categoria', filtroCategoria);
      }
      // CORREÇÃO: Força o filtro de cidade se ele existir (e não foi removido pelo backoff)
      if (filtroCidade) {
        query = query.eq('cidade_id', filtroCidade);
      }

      const { data: rowsTbl } = await query.limit(safeLimit * 3);
      
      const asArray = Array.isArray(rowsTbl) ? rowsTbl : [];
      textRows = asArray.map((r) => ({ ...r, text_score: 0.4 }));
      meta.steps.table_fallback.count = textRows.length;
    } catch (e) {
      meta.steps.table_fallback.error = String(e?.message || e);
    }
  }
  // ==========================================================
  // FIM DA CORREÇÃO 2
  // ==========================================================


  // ----------------------- Merge + re-rank com sinais genéricos -------------
  // (Baseado no [cite: 457-470] - Lógica de Merge/Bônus mantida)
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
  const qNorm = String(q || "").toLowerCase();
  const mentionsPizza = /\b(pizza|pizzaria)\b/.test(qNorm);
  const mentionsSushi = /\b(sushi|japon[eê]s)\b/.test(qNorm);
  const mentionsCarne = /\b(picanha|churrasco|carne)\b/.test(qNorm);
  const BONUS = {
    pizzaCatExact: 0.25, pizzaWord: 0.20, sushiCatExact: 0.25,
    sushiWord: 0.20, carneCatExact: 0.20, carneWord: 0.15,
  };
  const W_VECTOR = WEIGHTS.vector;
  const W_TEXT   = WEIGHTS.text;
  const merged = Array.from(mapById.values()).map((r) => {
    let score_final = W_VECTOR * (r.score_vector || 0) + W_TEXT * (r.score_text || 0);
    if (filtroCidade && (r.cidade_id === filtroCidade || r.cidade === filtroCidade)) score_final += WEIGHTS.cityMatch;
    if (filtroCategoria && (r.categoria === filtroCategoria || r.category === filtroCategoria)) score_final += WEIGHTS.catFilterBonus;
    const cat  = String(r.categoria || r.category || "").toLowerCase();
    const nome = String(r.nome || r.name || "").toLowerCase();
    const desc = String(r.descricao || r.description || "").toLowerCase();
    if (mentionsPizza) {
      if (cat === "pizzaria") score_final += BONUS.pizzaCatExact;
      if (nome.includes("pizza") || desc.includes("pizza")) score_final += BONUS.pizzaWord;
    }
    if (mentionsSushi) {
      if (["sushi","japonesa","japones","japonês"].includes(cat)) score_final += BONUS.sushiCatExact;
      if (nome.includes("sushi") || nome.includes("japon") || desc.includes("sushi") || desc.includes("japon")) score_final += BONUS.sushiWord;
    }
    if (mentionsCarne) {
      if (["churrascaria","carne"].includes(cat)) score_final += BONUS.carneCatExact;
      if (nome.includes("picanha") || nome.includes("churras") || desc.includes("picanha") || desc.includes("churras")) score_final += BONUS.carneWord;
    }
    return { ...r, score_final };
  });

  // ==========================================================
  // CORREÇÃO 3: Bloco de Gating de Nome Exato
  // (Cura o "Barco Pérola Negra -> Bar do Pôr do Sol")
  // ==========================================================
  
  // Ordenação principal
  const rankedAll =
    merged.length === 0
      ? (textRows || []).sort((a, b) => {
          const at = typeof a.text_score === "number" ? a.text_score : 0;
          const bt = typeof b.text_score === "number" ? b.text_score : 0;
          if (bt !== at) return bt - at;
          return (String(a.nome || a.name || "")).localeCompare(String(b.nome || b.name || ""));
        })
      : merged.sort((a, b) => b.score_final - a.score_final);

  // Gating de Nome Exato (Corrige "Barco Pérola Negra")
  let exactNameMatchList = rankedAll; // Começa com a lista completa
  if (q && q.length > 5) { 
    const qNorm = normalize(q || ""); 
    
    const exactMatches = rankedAll.filter(r => {
      const nomeNorm = normalize(r.nome || r.name || ""); 
      return qNorm.includes(nomeNorm) || nomeNorm.includes(qNorm);
    });

    if (exactMatches.length > 0) {
      console.log(`[RAG] Gating de Nome Exato ativado. Query "${qNorm}" filtrou ${exactMatches.length} itens.`);
      exactNameMatchList = exactMatches; // Lista é substituída
    }
  }
  // ==========================================================
  // FIM DA CORREÇÃO 3
  // ==========================================================


  // Foco: pizza → só pizza se houver
  let preferredOnly = exactNameMatchList; // <-- CORRIGIDO (usa a nova lista)
  if (mentionsPizza) {
    const keep = exactNameMatchList.filter((r) => { // <-- CORRIGIDO (usa a nova lista)
      const cat  = String(r.categoria || r.category || "").toLowerCase();
      const nome = String(r.nome || r.name || "").toLowerCase();
      const desc = String(r.descricao || r.description || "").toLowerCase();
      return cat === "pizzaria" || nome.includes("pizza") || desc.includes("pizza");
    });
    if (keep.length > 0) preferredOnly = keep;
  }

  // ----------------------- Gating genérico ----------------------------------
  // (Baseado no [cite: 474-476] - Gating genérico mantido)
  let finalList = preferredOnly; 
  if (RELEVANCE_GATE.requireAny) {
    const relevant = preferredOnly.filter((r) => {
      const aff = computeAffinity(r, signals);
      return aff.bonus >= RELEVANCE_GATE.minScore;
    });
    if (relevant.length > 0) finalList = relevant;
  }

  const items = finalList.slice(0, safeLimit);
  return debug ?
  { items, meta } : items;
}

// -------------------------- Stubs e utilidades ------------------------------
// (Baseado no [cite: 477-495] - Funções de indexação mantidas)
export async function searchSimilar(query, { partnerId, k }) {
  console.log(`[RAG] searchSimilar (stub compat): q="${query}", partnerId=${partnerId}, k=${k}`);
  return { results: [] };
}
export async function indexPartnerById(partnerId, { reactivate = false } = {}) {
  const { data: parceiro, error: errLoad } = await supabase.from("parceiros").select("id, nome, descricao, categoria, ativo").eq("id", partnerId).single();
  if (errLoad || !parceiro) throw new Error("Parceiro não encontrado para indexação.");
  const baseText = [parceiro.nome || "", parceiro.categoria ? `Categoria: ${parceiro.categoria}` : "", parceiro.descricao || ""].filter(Boolean).join("\n");
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
  let ok = 0, fail = 0;
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