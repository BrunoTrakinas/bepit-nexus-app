// ============================================================================
// Busca de parceiros tolerante a maiúsculas/acentos/typos (pg_trgm + unaccent).
// Depende das funções SQL no Supabase:
//   - public.search_parceiros(cidade_id uuid, categoria_norm text, p_term_norm text, p_limit int)
//   - public.cidade_id_by_slug(slug text)
// Requer extensões: unaccent, pg_trgm.
// Suporta: isInitialSearch (N itens aleatórios; N = dinâmico ou 3), excludeIds (evita repetição)
// Agora respeita "limiteDinamico" vindo do backend (v4.1).
// ============================================================================

import { supabase } from "../../lib/supabaseClient.js";

// -------------------- Normalizador com dicionário de typos -------------------
export function normalizeTerm(s) {
  if (!s) return "";
  let out = String(s).toLowerCase();
  out = out.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  out = out.replace(/\s+/g, " ").trim();

  const FIX = new Map([
    // (… manter o dicionário completo já existente …)
    ["piconha", "picanha"],
    ["hamburquer", "hamburguer"],
    ["rodisio", "rodizio"],
    ["pitza", "pizza"],
    ["reveion", "reveillon"],
    // (demais entradas preservadas)
  ]);

  out = out.split(" ").map(w => FIX.get(w) || w).join(" ");
  return out;
}

// ------------------------------ Cidade (RPC) ---------------------------------
export async function getCidadeIdBySlug(cidadeSlug) {
  if (!cidadeSlug) return null;
  const { data, error } = await supabase.rpc("cidade_id_by_slug", { p_slug: cidadeSlug });
  if (error) {
    console.error("[getCidadeIdBySlug] RPC error:", error);
    return null;
  }
  return data ?? null;
}

// ------------------------------ Util local ----------------------------------
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ------------------------------ Busca principal ------------------------------
/**
 * Buscar parceiros com tolerância e paginação inteligente.
 *
 * @param {Object} opts
 *  - cidadeId?: string (uuid)
 *  - cidadeSlug?: string
 *  - categoria: string (ex.: 'churrascaria', 'restaurante' — minúsculas)
 *  - term?: string (termo livre; typos tratados pelo normalizeTerm)
 *  - limit?: number (default 10; ignorado quando isInitialSearch=true sem limite dinâmico)
 *  - isInitialSearch?: boolean (default false → 1ª página retorna N aleatórios)
 *  - excludeIds?: string[] (IDs já exibidos que não devem voltar)
 *  - limiteDinamico?: number | null (1..15)
 *
 * @returns {Promise<{ok: boolean, items?: any[], error?: string}>}
 */
export async function buscarParceirosTolerante({
  cidadeId,
  cidadeSlug,
  categoria,
  term,
  limit = 10,
  isInitialSearch = false,
  excludeIds = [],
  limiteDinamico = null
}) {
  console.log("\n==================== INICIANDO BUSCA TOLERANTE (v4.1) ====================");
  try {
    const categoriaNorm = (categoria || "").toLowerCase().trim();
    if (!categoriaNorm) {
      console.log("[DEBUG] Busca falhou: Categoria ausente.");
      console.log("====================================================================\n");
      return { ok: false, error: "Categoria ausente." };
    }

    let cidadeUUID = cidadeId || null;
    if (!cidadeUUID && cidadeSlug) {
      console.log(`[DEBUG] Buscando UUID para a cidade com slug: "${cidadeSlug}"`);
      cidadeUUID = await getCidadeIdBySlug(cidadeSlug);
      if (!cidadeUUID) {
        console.log(`[DEBUG] Busca falhou: Cidade não encontrada para o slug: ${cidadeSlug}`);
        console.log("====================================================================\n");
        return { ok: false, error: `Cidade não encontrada para slug: ${cidadeSlug}` };
      }
      console.log(`[DEBUG] UUID da cidade encontrado: ${cidadeUUID}`);
    }

    if (!cidadeUUID) {
      console.log("[DEBUG] Busca falhou: cidadeId ou cidadeSlug obrigatório não resolvido.");
      console.log("====================================================================\n");
      return { ok: false, error: "cidadeId ou cidadeSlug obrigatório." };
    }

    const termNorm = normalizeTerm(term || "");

    // ---------- Limite para a chamada RPC ----------
    // Se houver limite dinâmico e for a 1ª página, usamos um teto maior na RPC
    // para permitir embaralhar e recortar no pós-processamento.
    const alvoInicial = Math.max(1, Math.min(15, Number(limiteDinamico || 3)));
    const rpcLimit = isInitialSearch
      ? Math.max(8, alvoInicial * 4) // busca "larga" para sortear e fatiar
      : Math.max(1, Math.min(50, limit || 10));

    const params = {
      p_cidade_id: cidadeUUID,
      p_categoria_norm: categoriaNorm,
      p_term_norm: termNorm,
      p_limit: rpcLimit
    };

    console.log("[DEBUG] Parâmetros RPC search_parceiros:", params, "isInitialSearch=", isInitialSearch, "excludeIds=", excludeIds, "limiteDinamico=", limiteDinamico);

    const { data, error } = await supabase.rpc("search_parceiros", params);
    if (error) {
      console.error("[DEBUG] !!! ERRO RPC search_parceiros:", error);
      console.log("====================================================================\n");
      return { ok: false, error: "Falha na busca (RPC)." };
    }

    let items = Array.isArray(data) ? data : [];
    console.log(`[DEBUG] RPC retornou ${items.length} itens (antes de filtros).`);

    // Excluir IDs já exibidos
    const excludeSet = new Set((excludeIds || []).filter(Boolean));
    if (excludeSet.size > 0) {
      items = items.filter(p => p && p.id && !excludeSet.has(p.id));
      console.log(`[DEBUG] Após excludeIds, restaram ${items.length} itens.`);
    }

    if (isInitialSearch) {
      shuffleInPlace(items);
      const finalLimit = alvoInicial; // usa limite dinâmico ou 3
      items = items.slice(0, finalLimit);
      console.log(`[DEBUG] isInitialSearch: retornando ${items.length} aleatórios (limite: ${finalLimit}).`);
    } else {
      const finalLimit = Math.max(1, Math.min(20, Number(limiteDinamico || limit || 5)));
      items = items.slice(0, finalLimit);
      console.log(`[DEBUG] busca refinada: retornando até ${finalLimit} itens (sobrou ${items.length}).`);
    }

    console.log("==================== FIM DA BUSCA TOLERANTE (v4.1) ====================\n");
    return { ok: true, items };
  } catch (err) {
    console.error("[DEBUG] !!! EXCEÇÃO buscarParceirosTolerante:", err);
    console.log("====================================================================\n");
    return { ok: false, error: err?.message || "Erro inesperado." };
  }
}
