// /backend-oficial/server/routes/uploads.routes.js
import { Router } from "express";
// ⚠️ IMPORT CORRETO: sobe 1 nível, entra em controllers
import * as ctrl from "../controllers/uploads.controller.js";

const r = Router();

// Uploads (parceiro)
r.post("/partner/:id/foto", ctrl.uploadFoto);
r.post("/partner/:id/cardapio", ctrl.uploadCardapio);

// Admin/Parceiro: listar & remover mídia
r.get("/partner/:id/list", ctrl.listarMidias);
r.delete("/partner/:id/remove", ctrl.removerMidia);

export default r;
