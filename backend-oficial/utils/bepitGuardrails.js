// backend-oficial/utils/bepitGuardrails.js
// ============================================================================
// BEPIT Guardrails - Travas de veracidade e pós-processamento de respostas
// Objetivo: impedir promoções e endereços inventados quando não houver parceiro
// cadastrado no banco. NÃO altera sua arquitetura — é utilitário puro.
// ============================================================================

/**
 * Texto de regras para anexar ao seu prompt do sistema (opcional, mas recomendado).
 * Você pode simplesmente concatenar este texto ao final do seu prompt atual.
 */
export const BEPIT_SYSTEM_PROMPT_APPENDIX = `
REGRAS DE VERACIDADE (OBRIGATÓRIAS)
1) Parceiros e benefícios: só cite nome, endereço e benefícios que existam no meu banco (tabelas: partners, deals). Se não houver registro, responda SEM mencionar endereço específico, SEM citar promoção/desconto e SEM inventar condições.
2) Proibições: é proibido inventar “10% de desconto”, “cortesia”, endereço, telefone ou horário que não existam no meu banco.
3) Quando não houver parceiro na categoria/cidade: ofereça ajuda para “procurar opções públicas” de forma genérica, SEM nomes e SEM endereços, ou sugira categorias (“pizzaria no centro / no canal”) sem citar locais concretos.
4) Em caso de dúvida: responda “Não tenho isso cadastrado ainda. Posso buscar opções públicas?”.
5) Nunca afirme parcerias, filiações, cupons ou condições comerciais sem ID de parceiro e ID de benefício do meu banco.
`;

/**
 * Constrói um texto padrão quando não houver parceiros cadastrados
 * para a categoria e a cidade informadas.
 */
export function buildNoPartnerFallback(category, city) {
  const safeCategory = (category || "a categoria escolhida").toString();
  const safeCity = (city || "sua cidade").toString();

  return (
    `Para ${safeCategory} em ${safeCity}, ainda não tenho parceiros cadastrados.\n` +
    `Posso te sugerir **opções públicas de forma genérica** (sem benefícios ou endereços) ` +
    `ou, se preferir, posso **buscar e cadastrar parceiros confiáveis** para você aproveitar vantagens no BEPIT.`
  );
}

/**
 * Remove ou neutraliza trechos de resposta do modelo que podem induzir a erro,
 * como promoções e endereços não respaldados pelo banco.
 *
 * @param {Object} params
 * @param {string} params.text - Texto de saída do modelo.
 * @param {Array<Object>} params.matchedPartners - Lista de parceiros realmente carregados do banco para esta resposta. Ex.: [{ id, name, address, benefits: [{ id, label }] }]
 * @returns {string} Texto sanitizado, seguro para exibir ao usuário final.
 */
export function sanitizeAssistantText({ text, matchedPartners = [] }) {
  if (!text || typeof text !== "string") return text || "";

  // Normaliza a lista de parceiros válidos desta resposta
  const validPartnerNames = new Set(
    matchedPartners
      .map((partner) => (partner && partner.nome ? partner.nome.toLowerCase().trim() : (partner && partner.name ? partner.name.toLowerCase().trim() : "")))
      .filter(Boolean)
  );

  const partnersHaveBenefits =
    matchedPartners.some((partner) => {
      const benefits = partner?.benefits || partner?.beneficio_bepit || null;
      if (Array.isArray(benefits)) return benefits.length > 0;
      if (typeof benefits === "string") return benefits.trim().length > 0;
      return false;
    }) || false;

  // Padrões básicos (endereços e promoções)
  const addressPattern = /\b(rua|r\.|av\.?|avenida|estrada|rod\.|praça|pc\.|travessa|tv\.)\s+[^\n,]+(\d{1,6})?/i;
  const promoPattern = /\b(\d{1,2}\s?%|por cento|cortesia|grátis|gratuito|free|cupom|desconto)\b/gi;

  // 1) Se há termos de benefício na resposta e NÃO há benefícios no banco, eliminamos trechos de promoção
  if (promoPattern.test(text) && !partnersHaveBenefits) {
    text = text.replace(promoPattern, "").replace(/\s{2,}/g, " ");
    // Remove frases curtas que podem ficar soltas depois da remoção
    text = text.replace(/\b(de\s+(desconto|cortesia|gratuito|grátis|free))\b/gi, "").trim();
  }

  // 2) Remover linhas com endereços quando não houver parceiro válido associado
  const lines = text.split("\n");
  const sanitizedLines = [];
  for (let index = 0; index < lines.length; index++) {
    const currentLine = lines[index];
    const previousLine = index > 0 ? lines[index - 1] : "";

    const currentLooksLikeAddress = addressPattern.test(currentLine);
    if (!currentLooksLikeAddress) {
      sanitizedLines.push(currentLine);
      continue;
    }

    // Tenta associar o endereço a um parceiro válido usando o nome destacado na linha atual ou anterior
    const boldNameRegex = /(\*\*?)([^*\n]{3,80}?)(\*\*?)/; // **Nome** ou *Nome*
    const currentNameMatch = currentLine.match(boldNameRegex);
    const previousNameMatch = previousLine.match(boldNameRegex);

    const currentName = currentNameMatch ? currentNameMatch[2].toLowerCase().trim() : "";
    const previousName = previousNameMatch ? previousNameMatch[2].toLowerCase().trim() : "";

    const isCurrentValid = currentName && validPartnerNames.has(currentName);
    const isPreviousValid = previousName && validPartnerNames.has(previousName);

    if (isCurrentValid || isPreviousValid) {
      sanitizedLines.push(currentLine); // Endereço associado a parceiro validado — mantém
    } else {
      // Endereço sem parceiro validado — descarta a linha de endereço
    }
  }
  let sanitizedText = sanitizedLines.join("\n");

  // 3) Tornar genérico qualquer nome destacado que não esteja na lista de parceiros válidos
  // Ex.: "**Pizzaria Forno D'Oro**" -> "**Opção de estabelecimento**" (se não for parceiro validado)
  sanitizedText = sanitizedText.replace(
    /(\*\*?)([^*\n]{3,80}?)(\*\*?)(?=\s*:|\s*\n|$)/g,
    (fullMatch, openMark, capturedName, closeMark) => {
      const normalized = (capturedName || "").toLowerCase().trim();
      if (!normalized) return fullMatch;
      if (validPartnerNames.has(normalized)) return fullMatch; // parceiro válido, mantém
      return `${openMark}Opção de estabelecimento${closeMark}`;
    }
  );

  // 4) Se ainda restarem termos de promoção sem respaldo, adiciona uma nota branda
  if (/\b(\d{1,2}\s?%|por cento|cortesia|grátis|gratuito|free|cupom|desconto)\b/i.test(sanitizedText) && !partnersHaveBenefits) {
    sanitizedText += `\n\n_Notas: benefícios específicos ainda não estão cadastrados para esta busca._`;
  }

  return sanitizedText;
}

/**
 * Função de alto nível para aplicar a sanitização e devolver o texto final.
 * Use esta função no seu handler de chat, passando a resposta do modelo e
 * a lista de parceiros realmente encontrados no banco.
 *
 * @param {Object} params
 * @param {string} params.modelResponseText - Texto bruto vindo do modelo.
 * @param {Array<Object>} params.foundPartnersList - Parceiros usados na resposta (vindos do seu banco).
 * @returns {string} Texto final pronto para retornar ao frontend.
 */
export function finalizeAssistantResponse({ modelResponseText, foundPartnersList = [] }) {
  return sanitizeAssistantText({
    text: modelResponseText,
    matchedPartners: Array.isArray(foundPartnersList) ? foundPartnersList : [],
  });
}
