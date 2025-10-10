// server/utils/searchPartners.js
// ============================================================================
// Busca de parceiros tolerante a maiúsculas/acentos/typos (pg_trgm + unaccent).
// Depende das funções SQL no Supabase:
//   - public.search_parceiros(cidade_id uuid, categoria_norm text, p_term_norm text, p_limit int)
//   - public.cidade_id_by_slug(slug text)
// Requer extensões: unaccent, pg_trgm.
// Suporta: isInitialSearch (3 itens aleatórios), excludeIds (evita repetição)
// ============================================================================

import { supabase } from "../../lib/supabaseClient.js";

// -------------------- Normalizador com dicionário de typos -------------------
export function normalizeTerm(s) {
  if (!s) return "";
  let out = String(s).toLowerCase();
  out = out.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  out = out.replace(/\s+/g, " ").trim();

  const FIX = new Map([
    // ### HOSPEDAGEM ###
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
    ["suite", "flat"],
    ["resorte", "resort"],

    // ### ALIMENTAÇÃO ###
    ["piconha", "picanha"],
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
    ["churrascaria", "churrasco"],
    ["açai", "acai"],
    ["açaí", "acai"],
    ["self service", "self-service"],
    ["comida por kilo", "comida a quilo"],

    // ### SERVIÇOS ###
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

    // ### SHOWS/EVENTOS ###
    ["barsinho", "barzinho"],
    ["bar com musica", "bar"],
    ["musica ao vivo", "ao vivo"],
    ["shoppin", "shopping"],
    ["loja", "lojas"],
    ["rua dos biquinis", "rua dos biquinis"],
    ["praca da cidadania", "praca da liberdade"],
    ["show de rock", "rock"],
    ["pagode", "samba"],
    ["rodas de samba", "samba"],
    ["festa", "balada"],
    ["night", "balada"],
    ["pubi", "pub"],
    ["reveion", "reveillon"],
    ["ano novo", "reveillon"],

    // ### PASSEIOS ###
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
    ["pôr do sol", "por do sol"],
    ["rua das pedras", "rua das pedras"]
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
 *  - limit?: number (default 10; ignorado quando isInitialSearch=true)
 *  - isInitialSearch?: boolean (default false → 1ª página retorna 3 aleatórios)
 *  - excludeIds?: string[] (IDs já exibidos que não devem voltar)
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

    // Excluir IDs já exibidos
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
