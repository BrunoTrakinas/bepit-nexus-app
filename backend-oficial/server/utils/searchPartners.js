// server/utils/searchPartners.js
// ============================================================================
// Busca de parceiros tolerante a maiúsculas/acentos/typos (pg_trgm + unaccent).
// Depende das funções SQL no Supabase:
//   - public.search_parceiros(cidade_id uuid, categoria_norm text, p_term_norm text, p_limit int)
//   - public.cidade_id_by_slug(slug text)
// Requer extensões: unaccent, pg_trgm.
// ============================================================================

import { supabase } from "../../lib/supabaseClient.js";

// ---------------------------------------------------------------------------
// DICIONÁRIO DE TOLERÂNCIAS (normalizado: minúsculo + sem acento)
// Observação: normalizeTerm() abaixo já remove acentos/caixa; por isso
// TODAS as chaves deste mapa estão sem acentos.
// ---------------------------------------------------------------------------
const FIX = new Map([
  // === HOSPEDAGEM ===
  ["pousadinha", "pousada"],
  ["posada", "pousada"],
  ["pouzada", "pousada"],
  ["caza", "casa"],
  ["kasa", "casa"],
  ["kaza", "casa"],
  ["casinha", "casa"],
  ["cazinha", "casa"],
  ["casarao", "casa"],
  ["cazarao", "casa"],
  ["casa de temporada", "casa para temporada"],
  ["casa temporada", "casa para temporada"],
  ["casaparatemporada", "casa para temporada"],
  ["otel", "hotel"],
  ["hoteis", "hotel"],
  ["ostel", "hostel"],
  ["alojamiento", "alojamento"],
  ["canping", "camping"],
  ["campin", "camping"],
  ["chaleh", "chale"],
  ["chales", "chale"],
  ["suite", "flat"], // suite como tipo de flat/apto
  ["resorte", "resort"],

  // === ALIMENTAÇÃO ===
  ["piconha", "picanha"],
  ["piconia", "picanha"],
  ["piconia", "picanha"],
  ["picania", "picanha"],
  ["karn", "carne"],
  ["peixe frito", "peixe"],
  ["peixada", "peixe"],
  ["muqueca", "moqueca"],
  ["camaro", "camarao"],
  ["camaraum", "camarao"],
  ["carangueijo", "caranguejo"],
  ["siri na lata", "siri"],
  ["casquinha de siri", "casquinha"],
  ["pastel de camarao", "pastel"],
  ["pastel de carne", "pastel"],
  ["hamburquer", "hamburguer"],
  ["amburguer", "hamburguer"],
  ["burger", "hamburguer"],
  ["burguer", "hamburguer"],
  ["pitsa", "pizza"],
  ["pitza", "pizza"],
  ["rodisio", "rodizio"],
  ["rodizio de carne", "rodizio"],
  ["rodizio de pizza", "rodizio"],
  ["petiscos", "petisco"],
  ["macarrao", "massas"],
  ["macarronada", "massas"],
  ["comida japonesa", "cozinha japonesa"],
  ["sushi", "cozinha japonesa"],
  ["sashimi", "cozinha japonesa"],
  ["temaki", "cozinha japonesa"],
  ["suchi", "cozinha japonesa"],
  ["esfira", "esfiha"],
  ["esfirra", "esfiha"],
  ["acarage", "acaraje"],
  ["costelinha", "costela"],
  ["churras", "churrasco"],
  ["churrascaria", "churrasco"], // usuário às vezes escreve o gênero pelo tipo
  ["acai", "acai"],
  ["self service", "self-service"],
  ["comida por kilo", "comida a quilo"],

  // === SERVIÇOS ===
  ["aluguel de carros", "aluguel de carro"],
  ["aluga carro", "aluguel de carro"],
  ["aluga moto", "aluguel de moto"],
  ["jet ski", "aluguel de jet ski"],
  ["jetski", "aluguel de jet ski"],
  ["lancha", "aluguel de lancha"],
  ["barco", "aluguel de barco"],
  ["arcondicionado", "aluguel de ar condicionado"],
  ["motorista", "motorista particular"],
  ["guia turistico", "guia de turismo"],
  ["fotografo de passeio", "fotografo"],
  ["agencia de turismo", "agencia de viagens"],
  ["traslado", "transfer"],
  ["prancha de surf", "aluguel de prancha"],
  ["aula de surfe", "aula de surf"],
  ["kite surf", "aula de kitesurf"],
  ["kitesurf", "aula de kitesurf"],
  ["standup paddle", "aula de stand up paddle"],
  ["stand-up-paddle", "aula de stand up paddle"],
  ["sup", "aula de stand up paddle"],
  ["farmassia", "farmacia"],
  ["remedio", "farmacia"],
  ["supermercado", "mercado"],
  ["panificadora", "padaria"],

  // === SHOWS/EVENTOS ===
  ["barsinho", "barzinho"],
  ["bar com musica", "bar"],
  ["musica ao vivo", "ao vivo"],
  ["shoppin", "shopping"],
  ["loja", "lojas"],
  ["rua dos biquinis", "rua dos biquinis"],
  ["praca da cidadania", "praca da liberdade"], // conforme solicitado
  ["show de rock", "rock"],
  ["pagode", "samba"],
  ["rodas de samba", "samba"],
  ["festa", "balada"],
  ["night", "balada"],
  ["pubi", "pub"],
  ["reveion", "reveillon"],
  ["ano novo", "reveillon"],

  // === PASSEIOS/LOCAIS ===
  ["passeio de barco", "barco"],
  ["trilias", "trilha"],
  ["buggy", "bugre"],
  ["bug", "bugre"],
  ["praia", "praias"],
  ["forte sao mateus", "forte"],
  ["praia dos anjos", "anjos"],
  ["praia do forno", "do forno"],
  ["praia do farol", "farol"],
  ["prainhas", "prainhas do atalaia"],
  ["pontal do atalaia", "prainhas do atalaia"],
  ["geriba", "geriba"],
  ["feradurinha", "ferradura"],
  ["busios", "buzios"],
  ["arraial do cabo", "arraial"],
  ["cabo frio", "cabo frio"],
  ["rio das ostras", "rio das ostras"],
  ["sao pedro", "sao pedro da aldeia"],
  ["joao fernandes", "joao fernandes"],
  ["ilha do japones", "japones"],
  ["mergulio", "mergulho"],
  ["snorkeling", "snorkel"],
  ["pordosol", "por do sol"],
  ["por do sol", "por do sol"],
  ["rua das pedras", "rua das pedras"],
]);

// Normaliza o termo (minúsculo + sem acentos) e aplica o dicionário FIX
export function normalizeTerm(input) {
  if (!input) return "";
  // 1) normalização básica
  let out = String(input).toLowerCase();
  out = out.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // remove acentos
  out = out.replace(/\s+/g, " ").trim();

  // 2) substituições exatas por palavra/frase (na ordem decrescente de tamanho
  //    para priorizar frases maiores — evita "quebrar" composições)
  //    Obs.: como já normalizamos (sem acentos/caixa), as chaves de FIX estão
  //    nesse mesmo formato e casam direto.
  const entries = Array.from(FIX.entries()).sort(
    // maior chave primeiro (frases > palavras); desempate alfabético estável
    (a, b) => b[0].length - a[0].length || (a[0] > b[0] ? 1 : -1)
  );

  for (const [from, to] of entries) {
    // substitui apenas quando encontra token/frase inteira
    // - se for frase com espaços, aplica substituição direta
    // - se for palavra, usa bordas (\b) para evitar trocar substrings
    if (from.includes(" ")) {
      const re = new RegExp(`\\b${escapeRegExp(from)}\\b`, "g");
      out = out.replace(re, to);
    } else {
      const re = new RegExp(`\\b${escapeRegExp(from)}\\b`, "g");
      out = out.replace(re, to);
    }
  }

  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

/** Embaralha um array (Fisher–Yates) — ajuda a dar variedade na 1ª busca. */
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Busca tolerante via RPC + pós-processamento:
 * - Aplica normalizeTerm (com dicionário FIX).
 * - Filtra excludeIds no Node (para não repetir nas próximas páginas/refinos).
 * - Se isInitialSearch = true: busca 24, embaralha e retorna 3 aleatórios.
 * - Senão: respeita limit (default 5) e mantém a ordem da RPC (relevância).
 *
 * @param {Object} opts
 *  - cidadeId?: string (uuid)
 *  - cidadeSlug?: string
 *  - categoria: string (ex.: 'churrascaria', 'restaurante' — minúsculas)
 *  - term?: string (termo livre; tolera typos)
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

    if (isInitialSearch) {
      shuffleInPlace(items);
      items = items.slice(0, 3);
      console.log(`[DEBUG] isInitialSearch: retornando ${items.length} aleatórios.`);
    } else {
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
