// /backend-oficial/server/controllers/uploads.controller.js
import * as svc from "../../services/storage.service.js"; // sobe 2 níveis até /services

export async function uploadFoto(req, res) {
  try {
    const { id } = req.params;              // partner_id
    const { base64, filename } = req.body;  // base64 (sem prefixo data:), nome original
    const data = await svc.uploadPartnerMedia({
      partnerId: id,
      kind: "foto",
      base64,
      filename,
    });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}

export async function uploadCardapio(req, res) {
  try {
    const { id } = req.params;
    const { base64, filename } = req.body;
    const data = await svc.uploadPartnerMedia({
      partnerId: id,
      kind: "cardapio",
      base64,
      filename,
    });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}

export async function listarMidias(req, res) {
  try {
    const { id } = req.params;
    const data = await svc.listarMidias(id);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}

export async function removerMidia(req, res) {
  try {
    const { id } = req.params;
    const { storageKey } = req.body;
    const data = await svc.removerMidia({ partnerId: id, storageKey });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}
