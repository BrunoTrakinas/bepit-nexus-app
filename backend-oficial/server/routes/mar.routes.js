import { Router } from "express";
import { supabase } from "../../lib/supabaseAdmin.js"

const r = Router();

async function resolveCidadeIdByName(name) {
  if (!name) return null;
  try {
    const { data: hasCidades } = await supabase.rpc("pg_table_exists", {
      p_schema: "public",
      p_table: "cidades",
    }).catch(() => ({ data: false }));

    if (!hasCidades) return null;

    const { data: row } = await supabase
      .from("cidades")
      .select("id, nome")
      .ilike("nome", name)
      .limit(1)
      .maybeSingle();

    return row?.id ?? null;
  } catch {
    return null;
  }
}

async function getLatestByCity({ cidade, tipo, hoursWindow }) {
  const sinceIso = new Date(Date.now() - hoursWindow * 3600 * 1000).toISOString();

  const cidade_id = await resolveCidadeIdByName(cidade);

  const base = supabase
    .from("dados_climaticos")
    .select("id, ts, cidade_id, cidade_nome, tipo_dado, dados, payload")
    .eq("tipo_dado", tipo)
    .gte("ts", sinceIso)
    .order("ts", { ascending: false })
    .limit(1);

  let q;
  if (cidade_id) {
    q = base.or(`cidade_id.eq.${cidade_id},cidade_nome.ilike.%${cidade}%`);
  } else {
    q = base.ilike("cidade_nome", `%${cidade}%`);
  }

  const { data, error } = await q;
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return { found: false };

  const payload = row.dados ?? row.payload ?? null;
  return { found: true, row: { ...row, payload } };
}

// GET /api/mar/agua?cidade=Cabo%20Frio
r.get("/agua", async (req, res) => {
  try {
    const cidade = String(req.query.cidade || "").trim();
    if (!cidade) {
      return res.status(400).json({ ok: false, error: "Parâmetro 'cidade' é obrigatório" });
    }

    const out = await getLatestByCity({
      cidade,
      tipo: "water_temp",
      hoursWindow: 48, // janela maior para água
    });

    if (!out.found) {
      return res.json({ ok: true, cidade, found: false, message: "Sem dado de água no cache" });
    }

    return res.json({
      ok: true,
      cidade,
      found: true,
      ts: out.row.ts,
      data: out.row.payload,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// GET /api/mar/mare?cidade=Cabo%20Frio
r.get("/mare", async (req, res) => {
  try {
    const cidade = String(req.query.cidade || "").trim();
    if (!cidade) {
      return res.status(400).json({ ok: false, error: "Parâmetro 'cidade' é obrigatório" });
    }

    const out = await getLatestByCity({
      cidade,
      tipo: "tide",
      hoursWindow: 48,
    });

    if (!out.found) {
      return res.json({ ok: true, cidade, found: false, message: "Sem dado de maré no cache" });
    }

    return res.json({
      ok: true,
      cidade,
      found: true,
      ts: out.row.ts,
      data: out.row.payload,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

export default r;
