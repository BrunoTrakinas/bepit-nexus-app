// /backend-oficial/services/rag.service.js
// ============================================================================
// RAG Híbrido (768d): Indexação + Busca (vetorial + textual) com fallbacks
// - Embedding: Google "gemini-embedding-001" (v1beta) com outputDimensionality=768
// - Coluna alvo: public.parceiros.embedding_768 (vector(768))
// - RPCs v2 (devem usar embedding_768 + cosine):
//   parceiros_vector_search_v2(...) e parceiros_text_search_v2(...)
// Obs: usa SUPABASE_SERVICE_ROLE_KEY (apenas backend).
// ============================================================================

import { createClient } from "@supabase/supabase-js";

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

// Pesos de re-rank
const W_VECTOR = 0.85;
const W_TEXT = 0.15;

// ---------------------------- Utils -----------------------------------------
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

// --------------------------- BUSCA HÍBRIDA ----------------------------------
export async function hybridSearch({ q, cidade_id, categoria, limit = 10, debug = false }) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 30));
  const filtroCidade = cidade_id || null;
  const filtroCategoria = (categoria || "").trim() || null;

  const meta = {
    input: { q, cidade_id: filtroCidade, categoria: filtroCategoria, limit: safeLimit },
    steps: {
      vector_v2: { tried: false, count: 0, error: null },
      text_v2: { tried: false, count: 0, error: null },
      text_rpc_fallback: { tried: false, count: 0, error: null },
      table_fallback: { tried: false, count: 0, error: null },
    },
  };

  let vectorRows = [];
  let textRows = [];

  // 1) Vetorial via RPC
  try {
    if (q && GEMINI_API_KEY) {
      meta.steps.vector_v2.tried = true;
      const qVec = await embedText768(q);
      const { data: vrows, error: verr } = await supabase.rpc("parceiros_vector_search_v2", {
        query_embedding: qVec,
        match_count: safeLimit * 3,
        filtro_cidade_id: filtroCidade,
        filtro_categoria: filtroCategoria,
      });
      if (verr) throw verr;
      vectorRows = Array.isArray(vrows) ? vrows : [];
      meta.steps.vector_v2.count = vectorRows.length;
    }
  } catch (e) {
    meta.steps.vector_v2.error = String(e?.message || e);
    vectorRows = [];
  }

  // 2) Textual via RPC
  try {
    meta.steps.text_v2.tried = true;
    const { data: trows, error: terr } = await supabase.rpc("parceiros_text_search_v2", {
      q_ilike: q ? `%${q}%` : "%",
      filtro_cidade_id: filtroCidade,
      filtro_categoria: filtroCategoria,
      fetch_count: safeLimit * 3,
    });
    if (terr) throw terr;
    textRows = Array.isArray(trows) ? trows : [];
    meta.steps.text_v2.count = textRows.length;
  } catch (e) {
    meta.steps.text_v2.error = String(e?.message || e);
    textRows = [];
  }

  // 2b) Fallback textual (RPC antiga), se necessário
  if ((!textRows || textRows.length === 0) && q) {
    try {
      meta.steps.text_rpc_fallback.tried = true;
      const { data: trows2, error: terr2 } = await supabase.rpc("search_parceiros", {
        p_cidade_id: filtroCidade,
        p_categoria_norm: (filtroCategoria || "") || null,
        p_term_norm: (q || "").toLowerCase().trim() || null,
        p_limit: safeLimit * 3,
      });
      if (terr2) throw terr2;
      const asArray = Array.isArray(trows2) ? trows2 : [];
      textRows = asArray.map((r) => ({ ...r, text_score: typeof r.text_score === "number" ? r.text_score : 0.5 }));
      meta.steps.text_rpc_fallback.count = textRows.length;
    } catch (e) {
      meta.steps.text_rpc_fallback.error = String(e?.message || e);
    }
  }

  // 2c) Fallback final: tabela direta
  if ((!textRows || textRows.length === 0) && q) {
    try {
      meta.steps.table_fallback.tried = true;
      const { data: rowsTbl, error: tblErr } = await supabase
        .from("parceiros")
        .select("id, nome, descricao, cidade_id, categoria")
        .or(`nome.ilike.%${q}%,descricao.ilike.%${q}%`)
        .limit(safeLimit * 3);
      if (tblErr) throw tblErr;
      const asArray = Array.isArray(rowsTbl) ? rowsTbl : [];
      textRows = asArray.map((r) => ({ ...r, text_score: 0.4 }));
      meta.steps.table_fallback.count = textRows.length;
    } catch (e) {
      meta.steps.table_fallback.error = String(e?.message || e);
    }
  }

  // 3) Merge + re-rank
  const map = new Map();

  for (const r of vectorRows) {
    const id = r.id ?? r.parceiro_id ?? r.partner_id;
    if (!id) continue;
    const vScore = typeof r.similarity === "number" ? r.similarity : typeof r.score === "number" ? r.score : 0;
    map.set(id, { ...r, score_vector: vScore, score_text: 0 });
  }

  for (const r of textRows) {
    const id = r.id ?? r.parceiro_id ?? r.partner_id;
    if (!id) continue;
    const tScore = typeof r.text_score === "number" ? r.text_score : typeof r.score === "number" ? r.score : 0;
    if (!map.has(id)) {
      map.set(id, { ...r, score_vector: 0, score_text: tScore });
    } else {
      const prev = map.get(id);
      map.set(id, { ...prev, score_text: Math.max(prev.score_text || 0, tScore) });
    }
  }

  const merged = Array.from(map.values()).map((r) => {
    let score_final = W_VECTOR * (r.score_vector || 0) + W_TEXT * (r.score_text || 0);
    if (filtroCidade && (r.cidade_id === filtroCidade || r.cidade === filtroCidade)) score_final += 0.1;
    if (filtroCategoria && (r.categoria === filtroCategoria || r.category === filtroCategoria)) score_final += 0.1;
    return { ...r, score_final };
  });

  if (merged.length === 0) {
    const sortedFallback = (textRows || []).sort((a, b) => {
      const at = typeof a.text_score === "number" ? a.text_score : 0;
      const bt = typeof b.text_score === "number" ? b.text_score : 0;
      if (bt !== at) return bt - at;
      return (a.nome || a.name || "").localeCompare(b.nome || b.name || "");
    });
    const items = sortedFallback.slice(0, safeLimit);
    return debug ? { items, meta } : items;
  }

  const ranked = merged.sort((a, b) => b.score_final - a.score_final).slice(0, safeLimit);
  return debug ? { items: ranked, meta } : ranked;
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
  if (categoria) qb = qb.eq("categoria", categoria);
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
