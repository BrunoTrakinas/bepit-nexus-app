import { Router } from "express";
import { listarMidiasDoParceiro } from "../../services/storage.service.js";

const r = Router();

// GET /api/chat/partner/:id/media
r.get("/partner/:id/media", async (req, res) => {
  const { id } = req.params;
  try {
    const data = await listarMidiasDoParceiro(id);
    // data = { fotos: [{storageKey, signedUrl, tipo}], cardapio: [...] , total }
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default r;
