// ============================================================================
// BEPIT Nexus - Utilitário de Busca de Parceiros (v4.1 - Simplificado)
// ----------------------------------------------------------------------------
// Diretrizes implementadas:
// - (T1) Remoção TOTAL do "limite dinâmico"
// - (T2) isInitialSearch=true  => retorna até 3 itens ALEATÓRIOS
//        isInitialSearch=false => retorna até 5 itens por RELEVÂNCIA (se houver) ou rating→nome
// - Fonte exclusiva: banco (RPC Supabase). Nada de inventar.
// - Compatível com excludeIds e cidade via slug (RPC cidade_id_by_slug).
// ============================================================================

import { supabase } from "../../lib/supabaseClient.js";

// --------------------------- Normalização de termos -------------------------
export function normalizeTerm(valor) {
  if (!valor) return "";
  let out = String(valor).toLowerCase();
  out = out.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  out = out.replace(/\s+/g, " ").trim();

  const FIX = new Map([
    ["piconha", "picanha"],
    ["hamburquer", "hamburguer"],
    ["hamburgueria", "hamburgueria"],
    ["rodisio", "rodizio"],
    ["rodízio", "rodizio"],
    ["pitza", "pizza"],
    ["piza", "pizza"],
    ["moqueca", "moqueca"],
    ["bistro", "bistrô"],
    ["bistrô", "bistrô"],
    ["frutos  do  mar", "frutos do mar"],
    ["beira  mar", "beira mar"],
    ["vista  para  o  mar", "vista para o mar"],
    ["reveion", "reveillon"],
    ["reveillon", "reveillon"],
  ]);

  out = out
    .split(" ")
    .map((w) => FIX.get(w) || w)
    .join(" ");

  return out;
}

// --------------------------- Resolução de cidade ----------------------------
export async function getCidadeIdBySlug(cidadeSlug) {
  if (!cidadeSlug) return null;
  const { data, error } = await supabase.rpc("cidade_id_by_slug", { p_slug: cidadeSlug });
  if (error) {
    console.error("[getCidadeIdBySlug] RPC error:", error);
    return null;
  }
  return data ?? null;
}

// --------------------------- Utilitário local -------------------------------
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// --------------------------- Busca tolerante (RPC) --------------------------
/**
 * Busca parceiros com tolerância e limites FIXOS.
 *
 * @param {Object} options
 * @param {string=} options.cidadeId         - UUID da cidade (opcional se cidadeSlug for fornecido)
 * @param {string=} options.cidadeSlug       - Slug da cidade (ex.: 'cabo-frio')
 * @param {string}  options.categoria        - Categoria normalizada (ex.: 'restaurante', 'churrascaria')
 * @param {string=} options.term             - Termo opcional para refinar (ex.: 'picanha', 'vista')
 * @param {boolean=} options.isInitialSearch - Se é a 1ª página (default: false)
 * @param {string[]=} options.excludeIds     - IDs já exibidos para evitar repetição
 *
 * @returns {Promise<{ok: boolean, items?: any[], error?: string}>}
 */
export async function buscarParceirosTolerante({
  cidadeId,
  cidadeSlug,
  categoria,
  term,
  isInitialSearch = false,
  excludeIds = []
}) {
  console.log("\n==================== INICIANDO BUSCA TOLERANTE (v4.1-simplificada) ====================");
  try {
    const categoriaNorm = (categoria || "").toLowerCase().trim();
    if (!categoriaNorm) {
      console.log("[DEBUG] Busca falhou: Categoria ausente.");
      console.log("====================================================================================\n");
      return { ok: false, error: "Categoria ausente." };
    }

    // Resolve cidade (UUID)
    let cidadeUUID = cidadeId || null;
    if (!cidadeUUID && cidadeSlug) {
      console.log(`[DEBUG] Buscando UUID para a cidade com slug: "${cidadeSlug}"`);
      cidadeUUID = await getCidadeIdBySlug(cidadeSlug);
      if (!cidadeUUID) {
        console.log(`[DEBUG] Busca falhou: Cidade não encontrada para o slug: ${cidadeSlug}`);
        console.log("====================================================================================\n");
        return { ok: false, error: `Cidade não encontrada para slug: ${cidadeSlug}` };
      }
      console.log(`[DEBUG] UUID da cidade encontrado: ${cidadeUUID}`);
    }

    if (!cidadeUUID) {
      console.log("[DEBUG] Busca falhou: cidadeId ou cidadeSlug obrigatório não resolvido.");
      console.log("====================================================================================\n");
      return { ok: false, error: "cidadeId ou cidadeSlug obrigatório." };
    }

    const termNorm = normalizeTerm(term || "");

    // Limites FIXOS de coleta na RPC (pega um universo razoável para ordenar/embaralhar):
    const rpcLimit = isInitialSearch ? 30 : 50;

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
      console.log("====================================================================================\n");
      return { ok: false, error: "Falha na busca (RPC)." };
    }

    let items = Array.isArray(data) ? data : [];
    console.log(`[DEBUG] RPC retornou ${items.length} itens (antes de filtros).`);

    // Excluir já exibidos
    const excludeSet = new Set((excludeIds || []).filter(Boolean));
    if (excludeSet.size > 0) {
      items = items.filter((p) => p && p.id && !excludeSet.has(p.id));
      console.log(`[DEBUG] Após excludeIds, restaram ${items.length} itens.`);
    }

    if (isInitialSearch) {
      // (T2) Inicial: até 3 aleatórios
      shuffleInPlace(items);
      items = items.slice(0, 3);
      console.log(`[DEBUG] isInitialSearch: retornando ${items.length} aleatórios (limite fixo: 3).`);
    } else {
      // (T2) Refinamento: até 5 por RELEVÂNCIA (se houver 'score'), senão rating→nome
      const hasScore = items.length > 0 && typeof items[0]?.score === "number";
      items = items
        .sort((a, b) => {
          if (hasScore) {
            if (b.score !== a.score) return b.score - a.score;
          }
          const ar = typeof a.rating === "number" ? a.rating : -1;
          const br = typeof b.rating === "number" ? b.rating : -1;
          if (br !== ar) return br - ar;
          return (a.name || a.nome || "").localeCompare(b.name || b.nome || "");
        })
        .slice(0, 5);
      console.log(`[DEBUG] refinamento: retornando ${items.length} por relevância (limite fixo: 5).`);
    }

    console.log("==================== FIM DA BUSCA TOLERANTE (v4.1-simplificada) ====================\n");
    return { ok: true, items };
  } catch (err) {
    console.error("[DEBUG] !!! EXCEÇÃO buscarParceirosTolerante:", err);
    console.log("====================================================================================\n");
    return { ok: false, error: err?.message || "Erro inesperado." };
  }
}
