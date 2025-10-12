// ============================================================================
// BEPIT Nexus - Utilitário de Busca de Parceiros (v4.1)
// ----------------------------------------------------------------------------
// Objetivo:
// - Realizar buscas tolerantes a acentos/maiúsculas/typos sobre a base de
//   parceiros e dicas (RPC no Supabase).
// - Respeitar "limite dinâmico" solicitado pelo usuário (ex.: "me dê 5
//   restaurantes") na 1ª página e também em buscas de refinamento.
// - Evitar repetição de itens já exibidos (excludeIds).
//
// Dependências no Supabase (lado SQL):
// - Função RPC:   public.search_parceiros(p_cidade_id uuid,
//                                         p_categoria_norm text,
//                                         p_term_norm text,
//                                         p_limit int)
// - Função RPC:   public.cidade_id_by_slug(p_slug text) -> uuid
// - Extensões:    unaccent, pg_trgm
//
// Notas:
// - Este módulo não formata a resposta final ao usuário. Apenas retorna a
//   lista "crua" de itens (id, nome, categoria, etc) para o orquestrador.
// - A paginação “inteligente” da primeira página pega um universo maior via
//   RPC, embaralha e recorta para o limite solicitado.
// ============================================================================

import { supabase } from "../../lib/supabaseClient.js";

// --------------------------- Normalização de termos -------------------------
/**
 * Normaliza um termo para busca:
 * - Lowercase
 * - Remoção de acentos (NFD)
 * - Colapsa espaços
 * - Corrige typos comuns via dicionário
 */
export function normalizeTerm(valor) {
  if (!valor) return "";
  let out = String(valor).toLowerCase();
  out = out.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  out = out.replace(/\s+/g, " ").trim();

  // Dicionário de correções (pode ser expandido conforme observações reais)
  const FIX = new Map([
    ["piconha", "picanha"],
    ["hamburquer", "hamburguer"],
    ["hamburgueria", "hamburgueria"], // identidade (mantida por clareza)
    ["rodisio", "rodizio"],
    ["rodízio", "rodizio"],
    ["pitza", "pizza"],
    ["piza", "pizza"],
    ["moqueca", "moqueca"],
    ["bistro", "bistrô"],   // Em alguns bancos está sem acento; manter coerência
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
/**
 * Retorna o UUID da cidade a partir do slug, usando RPC.
 * @param {string} cidadeSlug
 * @returns {Promise<string|null>}
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

// --------------------------- Utilitário local -------------------------------
/** Embaralha um array in-place (Fisher–Yates). */
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// --------------------------- Busca tolerante (RPC) --------------------------
/**
 * Busca parceiros com tolerância e paginação inteligente.
 *
 * @param {Object} options
 * @param {string=} options.cidadeId         - UUID da cidade (opcional se cidadeSlug for fornecido)
 * @param {string=} options.cidadeSlug       - Slug da cidade (ex.: 'cabo-frio')
 * @param {string}  options.categoria        - Categoria normalizada (ex.: 'restaurante', 'churrascaria')
 * @param {string=} options.term             - Termo opcional para refinar (ex.: 'picanha', 'vista')
 * @param {number=} options.limit            - Limite padrão (usado mais em refinamentos)
 * @param {boolean=} options.isInitialSearch - Se é a 1ª página (default: false)
 * @param {string[]=} options.excludeIds     - IDs já exibidos para evitar repetição
 * @param {number|null=} options.limiteDinamico - Limite solicitado pelo usuário (1..15)
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
    // Validação de categoria
    const categoriaNorm = (categoria || "").toLowerCase().trim();
    if (!categoriaNorm) {
      console.log("[DEBUG] Busca falhou: Categoria ausente.");
      console.log("====================================================================\n");
      return { ok: false, error: "Categoria ausente." };
    }

    // Resolve cidade (UUID) via slug, se necessário
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

    // Normaliza termo
    const termNorm = normalizeTerm(term || "");

    // ----------------------- Limites e estratégia ------------------------
    // Alvo da 1ª página: respeita pedido do usuário (1..15), senão fallback 3
    const alvoInicial = Math.max(1, Math.min(15, Number(limiteDinamico || 3)));

    // Limite da RPC:
    // - Na primeira página, pedimos mais itens para poder embaralhar e cortar.
    // - Em refinamentos, usamos o limite fornecido (limit) com teto de 50.
    const rpcLimit = isInitialSearch
      ? Math.max(8, alvoInicial * 4)
      : Math.max(1, Math.min(50, limit || 10));

    const params = {
      p_cidade_id: cidadeUUID,
      p_categoria_norm: categoriaNorm,
      p_term_norm: termNorm,
      p_limit: rpcLimit
    };

    console.log("[DEBUG] Parâmetros RPC search_parceiros:", params, "isInitialSearch=", isInitialSearch, "excludeIds=", excludeIds, "limiteDinamico=", limiteDinamico);

    // Chamada RPC
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
      items = items.filter((p) => p && p.id && !excludeSet.has(p.id));
      console.log(`[DEBUG] Após excludeIds, restaram ${items.length} itens.`);
    }

    // Ordenação/aleatoriedade e corte final conforme tipo de busca
    if (isInitialSearch) {
      shuffleInPlace(items);
      const finalLimit = alvoInicial; // usa o limite dinâmico pedido ou 3
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
