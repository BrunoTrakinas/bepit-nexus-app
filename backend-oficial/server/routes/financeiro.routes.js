// /backend-oficial/server/routes/financeiro.routes.js
import { Router } from "express";
import * as ctrl from "../controllers/financeiro.controller.js"; // sobe 1 nível

const r = Router();

r.get("/partners", ctrl.listPartnersFinance);       // filtros: q, status=vencido|a_vencer|ok
r.get("/partner/:id", ctrl.getPartnerFinanceSheet);
r.post("/invoice", ctrl.createInvoice);
r.post("/payment", ctrl.registerPayment);
r.get("/dash", ctrl.dashboardSnapshot);

export default r;
