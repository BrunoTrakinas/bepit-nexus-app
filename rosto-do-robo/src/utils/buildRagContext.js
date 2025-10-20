// /frontend/src/utils/buildRagContext.js
import { ragSearch } from "../services/api.rag.js";

/**
 * Busca evidências semânticas e monta um "contexto" sucinto para o LLM.
 * - query: pergunta do usuário
 * - partnerId: se você já souber qual parceiro (senão, passa null e busca global)
 * - k: quantas evidências
 */
export async function buildRagContext({ query, partnerId = null, k = 6 }) {
  try {
    const results = await ragSearch({ query, partnerId, k });
    if (!Array.isArray(results) || results.length === 0) return { context: "", evidences: [] };

    // Dedup ingênuo e top-K já vem do backend; aqui só organiza o texto:
    const bullets = results.map((r, i) => `• ${r.chunk}`); // sem metadados pra prompt ficar leve
    const context = bullets.join("\n");

    return { context, evidences: results };
  } catch (e) {
    // Falhou a busca? Sem drama: segue sem contexto.
    console.warn("[RAG] buildRagContext falhou:", e?.message || e);
    return { context: "", evidences: [] };
  }
}
