// server/utils/searchPartners.js
// ============================================================================
// Busca de parceiros tolerante a maiúsculas/acentos/typos (pg_trgm + unaccent).
// Depende das funções SQL criadas no Supabase:
//   - public.search_parceiros(cidade_id uuid, categoria_norm text, p_term_norm text, p_limit int)
//   - public.cidade_id_by_slug(slug text) (opcional; usamos aqui para resolver o id da cidade)
// Requer extensões: unaccent, pg_trgm.
// ============================================================================

import { supabase } from "../../lib/supabaseClient.js";

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
 * Chama a função SQL de busca tolerante.
 * - cidadeId OU cidadeSlug (pelo menos um)
 * - categoria (minúsculas: 'churrascaria', 'restaurante'...)
 * - term (livre; 'piconha' ~ 'picanha')
 * - limit (default 10)
 *
 * Retorna { ok: true, items: [...] } ou { ok: false, error }
 */
// Arquivo: server/utils/searchPartners.js
// FUNÇÃO COM LOGS DE DEPURAÇÃO - SUBSTITUA A ORIGINAL

export async function buscarParceirosTolerante({
  cidadeId,
  cidadeSlug,
  categoria,
  term,
  limit = 10,
}) {
  console.log("\n==================== INICIANDO BUSCA TOLERANTE ====================");
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

    const params = {
      p_cidade_id: cidadeUUID,
      p_categoria_norm: categoriaNorm,
      p_term_norm: termNorm,
      p_limit: limit,
    };

    console.log("[DEBUG] Parâmetros enviados para a função RPC 'search_parceiros':", params);

    const { data, error } = await supabase.rpc("search_parceiros", params);

    if (error) {
      console.error("[DEBUG] !!! ERRO RETORNADO PELA CHAMADA RPC:", error);
      console.log("====================================================================\n");
      return { ok: false, error: "Falha na busca (RPC)." };
    }

    console.log("[DEBUG] Dados retornados pela chamada RPC:", data);
    console.log(`[DEBUG] Total de itens retornados: ${Array.isArray(data) ? data.length : 0}`);
    console.log("==================== FIM DA BUSCA TOLERANTE ====================\n");

    return { ok: true, items: Array.isArray(data) ? data : [] };
  } catch (err) {
    console.error("[DEBUG] !!! EXCEÇÃO INESPERADA na função buscarParceirosTolerante:", err);
    console.log("====================================================================\n");
    return { ok: false, error: err?.message || "Erro inesperado." };
  }
}
