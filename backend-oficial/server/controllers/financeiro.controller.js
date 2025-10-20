// /backend-oficial/server/controllers/financeiro.controller.js
import * as svc from "../../services/financeiro.service.js"; // <- fora de /server

export async function listPartnersFinance(req, res) {
  try {
    const { q, status } = req.query;
    const data = await svc.listPartnersFinance({ q, status });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}

export async function getPartnerFinanceSheet(req, res) {
  try {
    const { id } = req.params;
    const data = await svc.getPartnerFinanceSheet(id);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}

export async function createInvoice(req, res) {
  try {
    const payload = req.body;
    const data = await svc.createInvoice(payload);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}

export async function registerPayment(req, res) {
  try {
    const payload = req.body;
    const data = await svc.registerPayment(payload);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}

export async function dashboardSnapshot(_req, res) {
  try {
    const data = await svc.dashboardSnapshot();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}
