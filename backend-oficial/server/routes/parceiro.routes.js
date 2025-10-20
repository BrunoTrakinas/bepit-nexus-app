// /backend-oficial/server/routes/parceiro.routes.js
import { Router } from "express";
import * as ctrl from "../controllers/parceiro.controller.js";

const r = Router();

// Healthcheck do router
r.get("/_ping", (req, res) => res.json({ ok: true, scope: "parceiro.routes" }));

// Busca tolerante por parceiros (nome/descrição/tags)
r.get("/search", ctrl.searchParceiros);

export default r;
