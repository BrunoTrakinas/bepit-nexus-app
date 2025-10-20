// /backend-oficial/server/controllers/rag.controller.js
import * as svc from "../../services/rag.service.js";

export async function indexPartner(req, res) {
  try {
    const { partnerId } = req.params;
    const { chunks = [] } = req.body || {};
    const data = await svc.indexPartnerText(partnerId, chunks);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}

export async function performHybridSearch(req, res) {
  try {
    const q = String(req.query.q ?? "");
    const cidade_id = req.query.cidade_id ? String(req.query.cidade_id) : null;
    const categoria = req.query.categoria ? String(req.query.categoria) : null;
    const limit = Math.min(parseInt(String(req.query.limit ?? "10"), 10) || 10, 30);
    const debug = String(req.query.debug || "") === "1";

    if (!q) {
      return res.status(400).json({ ok: false, error: "Parâmetro 'q' (query) é obrigatório." });
    }

    const out = await svc.hybridSearch({ q, cidade_id, categoria, limit, debug });
    const items = Array.isArray(out?.items) ? out.items : out;
    const meta = out?.meta;

    res.json({ ok: true, count: items.length, items, ...(debug ? { debug: meta } : {}) });
  } catch (e) {
    console.error("Erro no controller de busca híbrida:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
}

/**
 * Indexa em lote todos os parceiros (ou por filtro).
 * Body (opcional): { cidade_id?: string, categoria?: string, onlyMissing?: boolean, limit?: number }
 */
export async function indexAllPartners(req, res) {
  try {
    const cidade_id = req.body?.cidade_id ? String(req.body.cidade_id) : null;
    const categoria = req.body?.categoria ? String(req.body.categoria) : null;
    const onlyMissing = req.body?.onlyMissing !== false; // default true
    const limit = Math.min(parseInt(String(req.body?.limit ?? "500"), 10) || 500, 2000);

    const summary = await svc.bulkIndexPartners({ cidade_id, categoria, onlyMissing, limit });
    res.json({ ok: true, ...summary });
  } catch (e) {
    console.error("Erro no indexAllPartners:", e);
    res.status(500).json({ ok: false, error: e?.message || "indexAllPartners falhou" });
  }
}
