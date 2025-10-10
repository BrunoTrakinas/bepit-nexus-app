// server/utils/searchPartners.js
// ============================================================================
// Busca de parceiros tolerante a maiúsculas/acentos/typos (pg_trgm + unaccent).
// Depende das funções SQL no Supabase:
//   - public.search_parceiros(cidade_id uuid, categoria_norm text, p_term_norm text, p_limit int)
//   - public.cidade_id_by_slug(slug text)
// Requer extensões: unaccent, pg_trgm.
// ============================================================================

import { supabase } from "../../lib/supabaseClient.js"; // <-- corrigido (um nível acima)

// Normaliza o termo (minúsculo + sem acentos)
export function normalizeTerm(s) {
  if (!s) return "";
  let out = s.toLowerCase();
  out = out.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

/**
 * Resolve o UUID da cidade a partir do slug (via RPC no banco).
 * Retorna null se não encontrar.
 */
export async function getCidadeIdBySlug(cidadeSlug) {
  if (!cidadeSlug) return null;
  const { data, error } = await supabase.rpc("cidade_id_by_slug", { p_slug: cidadeSlug });
  if (error) {
    console.error("[getCidadeIdBySlug] RPC error:", error);
    return null;
  }
  return data ?? null;
}

/**
 * Embaralha um array (Fisher–Yates) — ajuda a dar variedade na 1ª busca.
 */
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Busca tolerante via RPC + pós-processamento:
 * - Filtra excludeIds no Node (garante que não repita nas próximas páginas/refinamentos)
 * - Se isInitialSearch = true: amplia o fetch (até 24), embaralha e retorna 3 aleatórios
 * - Senão: respeita o limit normal (default 5) e mantém a ordem retornada pela RPC
 *
 * @param {Object} opts
 *  - cidadeId?: string (uuid)
 *  - cidadeSlug?: string
 *  - categoria: string (ex.: 'churrascaria', 'restaurante' — minúsculas)
 *  - term?: string (termo livre, tolera typos)
 *  - limit?: number (default 10; ignorado quando isInitialSearch=true)
 *  - isInitialSearch?: boolean (default false)
 *  - excludeIds?: string[] (IDs para NÃO retornar)
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
  excludeIds = []
}) {
  console.log("\n==================== INICIANDO BUSCA TOLERANTE (v4.0) ====================");
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

    // Para isInitialSearch, buscamos mais (24) e depois reduzimos/aleatorizamos no Node.
    const rpcLimit = isInitialSearch ? 24 : Math.max(1, Math.min(50, limit || 10));

    const params = {
      p_cidade_id: cidadeUUID,
      p_categoria_norm: categoriaNorm,
      p_term_norm: termNorm,
      p_limit: rpcLimit
    };

    console.log("[DEBUG] Parâmetros RPC search_parceiros:", params, "isInitialSearch=", isInitialSearch, "excludeIds=", excludeIds);

    const { data, error } = await supabase.rpc("search_parceiros", params);
    if (error) {
      console.error("[DEBUG] !!! ERRO RPC search_parceiros:", error);
      console.log("====================================================================\n");
      return { ok: false, error: "Falha na busca (RPC)." };
    }

    let items = Array.isArray(data) ? data : [];
    console.log(`[DEBUG] RPC retornou ${items.length} itens (antes de filtros).`);

    // Excluir IDs já exibidos (se houver)
    const excludeSet = new Set((excludeIds || []).filter(Boolean));
    if (excludeSet.size > 0) {
      items = items.filter(p => p && p.id && !excludeSet.has(p.id));
      console.log(`[DEBUG] Após excludeIds, restaram ${items.length} itens.`);
    }

    // Primeira busca: embaralhar e pegar 3 (paginação inteligente inicial)
    if (isInitialSearch) {
      shuffleInPlace(items);
      items = items.slice(0, 3);
      console.log(`[DEBUG] isInitialSearch: retornando ${items.length} aleatórios.`);
    } else {
      // Refinamento/lista normal: respeita limit (default 5 ou o passado)
      const finalLimit = Math.max(1, Math.min(20, limit || 5));
      items = items.slice(0, finalLimit);
      console.log(`[DEBUG] busca refinada: retornando até ${finalLimit} itens (sobrou ${items.length}).`);
    }

    console.log("==================== FIM DA BUSCA TOLERANTE (v4.0) ====================\n");
    return { ok: true, items };
  } catch (err) {
    console.error("[DEBUG] !!! EXCEÇÃO buscarParceirosTolerante:", err);
    console.log("====================================================================\n");
    return { ok: false, error: err?.message || "Erro inesperado." };
  }
}
