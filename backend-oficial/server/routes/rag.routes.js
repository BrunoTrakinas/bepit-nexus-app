// /backend-oficial/server/routes/rag.routes.js
import { Router } from "express";
import * as ctrl from "../controllers/rag.controller.js";

const r = Router();

/** Indexa textos/embedding de um parceiro específico */
r.post("/index/:partnerId", ctrl.indexPartner);

/** Indexa TODO mundo (ou por filtro) */
r.post("/index-all", ctrl.indexAllPartners);

/** Busca semântica híbrida (GET) */
r.get("/search", ctrl.performHybridSearch);

export default r;
