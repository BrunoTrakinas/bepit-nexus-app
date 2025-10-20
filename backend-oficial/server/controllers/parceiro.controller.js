// /backend-oficial/server/controllers/parceiro.controller.js
// IMPORTA do local correto (lib está fora de /server):
import { supabase } from "../../lib/supabaseClient.js";

/** Ping simples para monitoramento do módulo parceiro */
export const ping = async (_req, res) => {
  res.json({ ok: true, service: "parceiro", now: new Date().toISOString() });
};

/**
 * Busca tolerante com fallback:
 *  1) tenta OR em (nome, descricao, tags)
 *  2) se "tags" não existir, tenta (nome, descricao)
 * Retorna campos disponíveis (sem forçar colunas que podem não existir).
 */
export async function searchParceiros(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(parseInt(req.query.limit || "8", 10), 20);
    if (!q) return res.json({ ok: true, data: [] });

    const termo = `%${q}%`;

    // Tentativa 1: nome|descricao|tags
    let data = null;
    let error = null;

    try {
      const r1 = await supabase
        .from("parceiros")
        .select("*") // não força colunas; evita "column does not exist"
        .or(`nome.ilike.${termo},descricao.ilike.${termo},tags.ilike.${termo}`)
        .limit(limit);
      data = r1.data;
      error = r1.error;
    } catch (e) {
      error = e;
    }

    // Se deu erro (ex.: coluna "tags" não existe), tenta sem "tags"
    if (error) {
      const r2 = await supabase
        .from("parceiros")
        .select("*")
        .or(`nome.ilike.${termo},descricao.ilike.${termo}`)
        .limit(limit);
      data = r2.data;
      error = r2.error;
    }

    if (error) throw error;

    const arr = Array.isArray(data) ? data : [];

    // Normaliza sem assumir colunas que podem não existir
    const normalized = arr.map((p) => ({
      id: p.id,
      nome: p.nome,
      categoria: p.categoria ?? null,
      descricao: p.descricao ?? null,
      faixa_preco: p.faixa_preco ?? null,
      endereco: p.endereco ?? null,
      bairro: p.bairro ?? p.regiao_bairro ?? null,
      tags: p.tags ?? null,
      ativo: p.ativo ?? null,
    }));

    res.json({ ok: true, data: normalized });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "searchParceiros falhou" });
  }
}
