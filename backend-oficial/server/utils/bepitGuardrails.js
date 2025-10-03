// backend-oficial/server/utils/bepitGuardrails.js
// ============================================================================
// Guardrails do BEPIT — sanitização e pós-processamento das respostas do modelo
// - Proíbe termos de "parceria/benefício/convênio" e promoções inventadas
// - Não cria endereço quando não existe no banco
// - Remove cabeçalhos genéricos e numeração "1- 2- ..." que o modelo inventa
// - Reescreve a resposta com base somente nos parceiros encontrados (quando houver)
// ============================================================================

function limparPromocoesETermosProibidos(text) {
  if (!text) return "";
  let t = String(text);

  // Remoção de promessas de promoção/benefício e linguagem de parceria
  const padroesBanidos = [
    /com\s+o\s+bepit[^,.!?]*?(desconto|brinde|benef[ií]cio|cortesia)/gi,
    /(desconto|brinde|benef[ií]cio|cortesia)\s+(exclusivo|especial)/gi,
    /(parceria|parceiro\s+oficial|conv[eê]nio)/gi,
    /(ganha|ganhar[aã]?)\s+(uma|um)\s+(por[cç][aã]o|brinde|cortesia)/gi,
    /na compra de[^,.!?]+/gi
  ];
  padroesBanidos.forEach((rx) => (t = t.replace(rx, "")));

  // Trocar "parceiro" por "indicação" (tom neutro)
  t = t.replace(/\bparceir[oa]s?\b/gi, "indicação");
  t = t.replace(/\bparceria\b/gi, "indicação");

  // Remover duplicações de espaços e pontuação
  t = t.replace(/[ \t]+/g, " ").replace(/\s+\n/g, "\n").trim();

  return t;
}

function removerNumeracaoEHeadersGenericos(text) {
  if (!text) return "";
  let t = String(text);

  // Remove cabeçalhos genéricos que o modelo insiste em criar
  t = t.replace(/^#+\s*\*?\s*op[cç][aã]o\s+de\s+estabelecimento\s*\*?$/gim, "");
  t = t.replace(/^#+\s*(dicas?|sugest[oõ]es?)\s*$/gim, "");

  // Remove numeração forçada "1- Nome", "2 - Nome", "**1- Nome**"
  t = t
    .replace(/^\s*\*?\*?\s*\d{1,2}\s*[-.)]\s*/gim, "• ")
    .replace(/^\s*\d{1,2}\s*[°º]\s*/gim, "• ");

  // Colapsar múltiplas linhas vazias
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

function montarListaSeguraDeParceiros(foundPartnersList) {
  const arr = Array.isArray(foundPartnersList) ? foundPartnersList : [];
  if (!arr.length) return "";

  const linhas = arr.map((p) => {
    const nome = p?.nome ? `**${p.nome}**` : "Indicação";
    const cat = p?.categoria ? ` · ${p.categoria}` : "";
    const desc = p?.descricao ? ` — ${p.descricao}` : "";
    const end = p?.endereco ? `\n   • Endereço: ${p.endereco}` : "";
    const contato = p?.contato ? `\n   • Contato: ${p.contato}` : "";
    const preco = p?.faixa_preco ? `\n   • Faixa de preço: ${p.faixa_preco}` : "";
    const beneficio = ""; // nunca incluir benefício para não induzir promo inventada
    return `• ${nome}${cat}${desc}${end}${contato}${preco}${beneficio}`;
  });

  return linhas.join("\n");
}

/**
 * Pós-processa a resposta do modelo garantindo:
 * - Modo "partners": reescreve com base SÓ na lista de parceiros encontrada
 * - Modo "general": mantém o texto, mas limpa termos proibidos e numeração
 */
export function finalizeAssistantResponse({ modelResponseText, foundPartnersList, mode }) {
  const safeList = Array.isArray(foundPartnersList) ? foundPartnersList : [];
  const base = String(modelResponseText || "");

  if (mode === "partners" && safeList.length > 0) {
    const bloco = montarListaSeguraDeParceiros(safeList);
    // Mensagem curta e objetiva, sem prometer benefícios e sem inventar endereço
    let resposta = `Aqui vão algumas **indicações confiáveis**:\n\n${bloco}\n\nSe quiser, eu te ajudo a escolher conforme seu estilo (família, casal, orçamento, etc.).`;
    resposta = limparPromocoesETermosProibidos(resposta);
    resposta = removerNumeracaoEHeadersGenericos(resposta);
    return resposta;
  }

  // Modo general: preservar a fala do modelo, mas sanear
  let texto = limparPromocoesETermosProibidos(base);
  texto = removerNumeracaoEHeadersGenericos(texto);
  return texto;
}

/**
 * Quando não houver parceiros, retornar um fallback neutro e honesto.
 */
export function buildNoPartnerFallback() {
  return "Ainda não tenho indicações cadastradas para esse pedido específico. Posso sugerir regiões e tipos de lugares populares e, se quiser, posso cadastrar novas indicações assim que você me disser seu estilo (ex.: mais econômico, familiar, perto da praia).";
}

/**
 * Instruções auxiliares que reforçam a política dentro do prompt.
 */
export const BEPIT_SYSTEM_PROMPT_APPENDIX = `
- NÃO invente nomes de estabelecimentos, endereços, promoções, descontos ou “benefícios”.
- NÃO use os termos “parceiro”, “parceria”, “benefício”, “convênio”, “desconto”, “cortesia”.
- Use linguagem neutra: “indicação”, “opção”, “sugestão”.
- Quando houver lista de estabelecimentos, use bullets “•” e evite “1-, 2-”.
- Só mencione endereço/contato se vierem do contexto. Caso contrário, diga que não tenho o endereço cadastrado.
`.trim();
