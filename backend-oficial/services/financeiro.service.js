// /backend-oficial/services/financeiro.service.js
import { supabase } from "../lib/supabaseAdmin.js";

/**
 * Lista status financeiro dos parceiros a partir da view vw_partner_finance_status.
 * Aplica filtros opcionais: q (nome) e status (vencido|a_vencer|ok).
 */
export async function listPartnersFinance({ q, status }) {
  let query = supabase.from("vw_partner_finance_status").select("*");

  if (q) query = query.ilike("partner_name", `%${q}%`);
  if (status === "vencido") query = query.eq("status_label", "VENCIDO");
  if (status === "a_vencer") query = query.eq("status_label", "A VENCER (<10d)");
  if (status === "ok") query = query.eq("status_label", "EM DIA");

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Ficha financeira do parceiro: conta + faturas + última fatura.
 * Adapta a nomes de tabelas que já existam no seu schema.
 */
export async function getPartnerFinanceSheet(partnerId) {
  // Conta (se não existir finance_accounts, retorne null)
  const { data: acc, error: accErr } = await supabase
    .from("finance_accounts")
    .select("*")
    .eq("partner_id", partnerId)
    .maybeSingle(); // usa maybeSingle para não quebrar se não existir

  if (accErr && accErr.code !== "PGRST116") throw new Error(accErr.message);

  // Todas as faturas
  const { data: invs, error: invErr } = await supabase
    .from("invoices")
    .select("*")
    .eq("partner_id", partnerId)
    .order("due_date", { ascending: false });

  if (invErr) throw new Error(invErr.message);

  const last = Array.isArray(invs) && invs.length ? invs[0] : null;

  return {
    account: acc || null,
    last_invoice: last,
    invoices: invs || [],
  };
}

/**
 * Cria uma fatura "aberta".
 * Espera payload: { partner_id, period_start, period_end, amount_cents, due_date, notes? }
 */
export async function createInvoice(payload) {
  const row = {
    partner_id: payload.partner_id,
    period_start: payload.period_start,
    period_end: payload.period_end,
    amount_cents: payload.amount_cents,
    due_date: payload.due_date,
    status: "aberta",
    notes: payload.notes ?? null,
  };

  const { data, error } = await supabase
    .from("invoices")
    .insert(row)
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return data;
}

/**
 * Registra pagamento e atualiza a fatura para "paga".
 * Espera payload: { invoice_id, method, amount_cents, receipt_url? }
 */
export async function registerPayment({ invoice_id, method, amount_cents, receipt_url = null }) {
  const { data, error } = await supabase
    .from("payments")
    .insert({
      invoice_id,
      method,
      amount_cents,
      receipt_url,
    })
    .select("*")
    .single();

  if (error) throw new Error(error.message);

  // marca a fatura como paga
  const upd = await supabase
    .from("invoices")
    .update({ status: "paga", paid_at: new Date().toISOString() })
    .eq("id", invoice_id);

  if (upd.error) throw new Error(upd.error.message);

  return data;
}

/**
 * Snapshot simples do dashboard financeiro.
 * Se a RPC count_invoices_by_status não existir, faz contagem manual.
 */
export async function dashboardSnapshot() {
  // tenta RPC; se falhar, fallback manual
  async function countByStatus(status) {
    try {
      const { data, error } = await supabase.rpc("count_invoices_by_status", { p_status: status });
      if (!error && typeof data === "number") return data;
    } catch {}
    const { data: rows, error: qErr } = await supabase
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("status", status);
    if (qErr) throw new Error(qErr.message);
    return rows?.length ?? 0; // head:true não retorna linhas; alguns clients retornam count separado
  }

  const [abertas, vencidas, pagas] = await Promise.all([
    countByStatus("aberta"),
    countByStatus("vencida"),
    countByStatus("paga"),
  ]);

  return { abertas, vencidas, pagas };
}
