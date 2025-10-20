// server/adminRoutes.js
// Rotas administrativas do BEPIT
// - CRUD: Regiões, Cidades, Parceiros, Dicas, Avisos
// - Métricas (resumo) e Logs
// - Checagem de endereço único (Cidade + Rua + Número)

import express from "express";
import { createClient } from "@supabase/supabase-js";
import { requireAdminKey } from "./adminAuth.js";

// ---------- Supabase client (service role) ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const router = express.Router();

// ---------- Helpers ----------
function ok(res, data) {
  return res.json(data ?? { ok: true });
}
function bad(res, msg, code = 400) {
  return res.status(code).json({ error: msg });
}
async function logEvent(tipo, mensagem, contexto) {
  // grava em admin_logs (se existir)
  const { error } = await supabase.from("admin_logs").insert({
    tipo,
    mensagem,
    contexto,
  });
  if (error) console.error("[admin_logs] falha:", error.message);
}

// Normalizador simples (minúsculas e trim). Obs: o banco já tem colunas _norm.
function normalize(str) {
  return String(str || "").trim().toLowerCase();
}

// ---------- Protege todas as rotas abaixo ----------
router.use(requireAdminKey);

// ============================================================================
// REGIÕES
// ============================================================================
router.get("/regioes", async (_req, res) => {
  const { data, error } = await supabase
    .from("regioes")
    .select("id, nome")
    .order("nome", { ascending: true });
  if (error) return bad(res, error.message, 500);
  return ok(res, { regioes: data });
});

router.post("/regioes", async (req, res) => {
  const nome = (req.body?.nome || "").trim();
  if (!nome) return bad(res, "Informe o nome da Região.");
  const { data, error } = await supabase.from("regioes").insert({ nome }).select().single();
  if (error) return bad(res, error.message, 500);
  await logEvent("cadastro", "Região criada", { id: data.id, nome });
  return ok(res, data);
});

// ============================================================================
// CIDADES
// ============================================================================
router.get("/cidades", async (req, res) => {
  const regiaoId = req.query?.regiaoId || null;
  let q = supabase.from("cidades").select("id, nome, regiao_id").order("nome", { ascending: true });
  if (regiaoId) q = q.eq("regiao_id", regiaoId);
  const { data, error } = await q;
  if (error) return bad(res, error.message, 500);
  return ok(res, { cidades: data });
});

router.post("/cidades", async (req, res) => {
  const nome = (req.body?.nome || "").trim();
  const regiaoId = req.body?.regiaoId || null;
  if (!nome || !regiaoId) return bad(res, "Informe Cidade e Região.");
  const { data, error } = await supabase
    .from("cidades")
    .insert({ nome, regiao_id: regiaoId })
    .select()
    .single();
  if (error) return bad(res, error.message, 500);
  await logEvent("cadastro", "Cidade criada", { id: data.id, nome, regiaoId });
  return ok(res, data);
});

// ============================================================================
// PARCEIROS
//  - Regra de unicidade: (cidade_id, endereco_logradouro_norm, endereco_numero_norm)
// ============================================================================
router.get("/parceiros", async (req, res) => {
  const nome = (req.query?.nome || "").trim();
  const cidadeId = req.query?.cidadeId || null;
  const limit = Number(req.query?.limit || 50);

  let q = supabase
    .from("parceiros")
    .select("id, nome, cidade_id, endereco_logradouro, endereco_numero, bairro, cep, descricao, categoria, referencias, contato")
    .order("nome", { ascending: true })
    .limit(limit);

  if (nome) q = q.ilike("nome", `%${nome}%`);
  if (cidadeId) q = q.eq("cidade_id", cidadeId);

  const { data, error } = await q;
  if (error) return bad(res, error.message, 500);
  return ok(res, { parceiros: data });
});

router.get("/parceiros/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("parceiros")
    .select("*")
    .eq("id", req.params.id)
    .single();
  if (error) return bad(res, error.message, 500);
  return ok(res, data);
});

router.post("/parceiros", async (req, res) => {
  const {
    nome, cidadeId, logradouro, numero,
    bairro = null, cep = null, descricao = null,
    categoria = null, referencias = null, contato = null,
  } = req.body || {};

  if (!nome || !cidadeId || !logradouro || !numero) {
    return bad(res, "Preencha: Nome, Cidade, Rua/Avenida e Número.");
  }

  // Checagem prévia: existe parceiro no MESMO endereço?
  const logNorm = normalize(logradouro);
  const numNorm = normalize(numero);

  const { data: dup, error: errDup } = await supabase
    .from("parceiros")
    .select("id")
    .eq("cidade_id", cidadeId)
    .eq("endereco_logradouro_norm", logNorm)
    .eq("endereco_numero_norm", numNorm)
    .limit(1);
  if (errDup) return bad(res, errDup.message, 500);
  if (dup && dup.length) {
    return bad(res, "Já existe parceiro cadastrado nesse endereço (mesma Cidade + Rua + Número).");
  }

  const { data, error } = await supabase
    .from("parceiros")
    .insert({
      nome,
      cidade_id: cidadeId,
      endereco_logradouro: logradouro,
      endereco_numero: numero,
      bairro,
      cep,
      descricao,
      categoria,
      referencias,
      contato,
    })
    .select()
    .single();

  if (error) {
    // Se vier do UNIQUE do banco, repassa a msg leiga
    if (String(error.message || "").includes("parceiros_uq_endereco_completo")) {
      return bad(res, "Já existe parceiro cadastrado nesse endereço.");
    }
    return bad(res, error.message, 500);
  }

  await logEvent("cadastro", "Parceiro criado", { id: data.id, nome });
  return ok(res, data);
});

router.patch("/parceiros/:id", async (req, res) => {
  const id = req.params.id;
  const patch = req.body || {};

  // Se mudar endereço/cidade, validar a unicidade
  const cidadeId = patch.cidadeId ?? patch.cidade_id;
  const logradouro = patch.logradouro ?? patch.endereco_logradouro;
  const numero = patch.numero ?? patch.endereco_numero;

  if (cidadeId && logradouro && numero) {
    const logNorm = normalize(logradouro);
    const numNorm = normalize(numero);

    const { data: dup, error: errDup } = await supabase
      .from("parceiros")
      .select("id")
      .eq("cidade_id", cidadeId)
      .eq("endereco_logradouro_norm", logNorm)
      .eq("endereco_numero_norm", numNorm)
      .neq("id", id)
      .limit(1);
    if (errDup) return bad(res, errDup.message, 500);
    if (dup && dup.length) {
      return bad(res, "Já existe parceiro cadastrado nesse endereço (mesma Cidade + Rua + Número).");
    }
  }

  const body = {
    ...(patch.nome !== undefined ? { nome: patch.nome } : {}),
    ...(cidadeId !== undefined ? { cidade_id: cidadeId } : {}),
    ...(logradouro !== undefined ? { endereco_logradouro: logradouro } : {}),
    ...(numero !== undefined ? { endereco_numero: numero } : {}),
    ...(patch.bairro !== undefined ? { bairro: patch.bairro } : {}),
    ...(patch.cep !== undefined ? { cep: patch.cep } : {}),
    ...(patch.descricao !== undefined ? { descricao: patch.descricao } : {}),
    ...(patch.categoria !== undefined ? { categoria: patch.categoria } : {}),
    ...(patch.referencias !== undefined ? { referencias: patch.referencias } : {}),
    ...(patch.contato !== undefined ? { contato: patch.contato } : {}),
  };

  const { data, error } = await supabase
    .from("parceiros")
    .update(body)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    if (String(error.message || "").includes("parceiros_uq_endereco_completo")) {
      return bad(res, "Já existe parceiro cadastrado nesse endereço.");
    }
    return bad(res, error.message, 500);
  }

  await logEvent("cadastro", "Parceiro atualizado", { id });
  return ok(res, data);
});

router.delete("/parceiros/:id", async (req, res) => {
  const { error } = await supabase.from("parceiros").delete().eq("id", req.params.id);
  if (error) return bad(res, error.message, 500);
  await logEvent("cadastro", "Parceiro excluído", { id: req.params.id });
  return ok(res, { ok: true });
});

// ============================================================================
// DICAS
// ============================================================================
router.get("/dicas", async (req, res) => {
  const cidadeId = req.query?.cidadeId || null;
  const titulo = (req.query?.titulo || "").trim();
  const limit = Number(req.query?.limit || 50);

  let q = supabase
    .from("dicas")
    .select("id, cidade_id, titulo, conteudo, categoria, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cidadeId) q = q.eq("cidade_id", cidadeId);
  if (titulo) q = q.ilike("titulo", `%${titulo}%`);

  const { data, error } = await q;
  if (error) return bad(res, error.message, 500);
  return ok(res, { dicas: data });
});

router.get("/dicas/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("dicas")
    .select("*")
    .eq("id", req.params.id)
    .single();
  if (error) return bad(res, error.message, 500);
  return ok(res, data);
});

router.post("/dicas", async (req, res) => {
  const { cidadeId, titulo, conteudo, categoria = null } = req.body || {};
  if (!cidadeId || !titulo || !conteudo) return bad(res, "Informe Cidade, Título e Conteúdo.");

  const { data, error } = await supabase
    .from("dicas")
    .insert({ cidade_id: cidadeId, titulo, conteudo, categoria })
    .select()
    .single();

  if (error) return bad(res, error.message, 500);
  await logEvent("publicacao", "Dica criada", { id: data.id, titulo });
  return ok(res, data);
});

router.patch("/dicas/:id", async (req, res) => {
  const id = req.params.id;
  const patch = req.body || {};
  const body = {
    ...(patch.cidadeId !== undefined ? { cidade_id: patch.cidadeId } : {}),
    ...(patch.titulo !== undefined ? { titulo: patch.titulo } : {}),
    ...(patch.conteudo !== undefined ? { conteudo: patch.conteudo } : {}),
    ...(patch.categoria !== undefined ? { categoria: patch.categoria } : {}),
  };
  const { data, error } = await supabase
    .from("dicas")
    .update(body)
    .eq("id", id)
    .select()
    .single();

  if (error) return bad(res, error.message, 500);
  await logEvent("publicacao", "Dica atualizada", { id });
  return ok(res, data);
});

router.delete("/dicas/:id", async (req, res) => {
  const { error } = await supabase.from("dicas").delete().eq("id", req.params.id);
  if (error) return bad(res, error.message, 500);
  await logEvent("publicacao", "Dica excluída", { id: req.params.id });
  return ok(res, { ok: true });
});

// ============================================================================
// AVISOS (avisos_publicos)
// - Permite publicar por cidades (uuid[]) OU por regiao_id
// ============================================================================
router.get("/avisos", async (req, res) => {
  const cidadeId = req.query?.cidadeId || null;
  const regiaoId = req.query?.regiaoId || null;
  const limit = Number(req.query?.limit || 50);

  let q = supabase
    .from("avisos_publicos")
    .select("id, titulo, mensagem, regiao_id, cidades, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cidadeId) q = q.contains("cidades", [cidadeId]); // uuid[] contém
  if (regiaoId) q = q.eq("regiao_id", regiaoId);

  const { data, error } = await q;
  if (error) return bad(res, error.message, 500);
  return ok(res, { avisos: data });
});

router.post("/avisos", async (req, res) => {
  const { titulo, mensagem, cidadeIds = [], regiaoId = null } = req.body || {};
  if (!titulo || !mensagem) return bad(res, "Informe Título e Mensagem.");
  if (!Array.isArray(cidadeIds)) return bad(res, "cidadeIds deve ser um array.");

  const body = {
    titulo,
    mensagem,
    regiao_id: regiaoId,
    cidades: cidadeIds.length ? cidadeIds : null, // uuid[] ou null
  };

  const { data, error } = await supabase.from("avisos_publicos").insert(body).select().single();
  if (error) return bad(res, error.message, 500);
  await logEvent("publicacao", "Aviso publicado", { id: data.id, titulo, regiaoId, cidadeIds });
  return ok(res, data);
});

router.delete("/avisos/:id", async (req, res) => {
  const { error } = await supabase.from("avisos_publicos").delete().eq("id", req.params.id);
  if (error) return bad(res, error.message, 500);
  await logEvent("publicacao", "Aviso excluído", { id: req.params.id });
  return ok(res, { ok: true });
});

// ============================================================================
// MÉTRICAS (resumo simples)
// ============================================================================
router.get("/metrics/summary", async (_req, res) => {
  // Exemplos simples (ajuste conforme suas tabelas reais de métricas)
  const [mConversas, mParceiros] = await Promise.all([
    supabase.from("conversas").select("id", { count: "exact", head: true }),
    supabase.from("parceiros").select("id", { count: "exact", head: true }),
  ]);

  const payload = {
    openweather: { calls: "—", cost: "—" },
    stormglass: { calls: "—", cost: "—" },
    gemini: { calls: "—", cost: "—" },
    upstash:     { ops: "—", errors: "—" },
    supabase:    { queries: "—", errors: "—" },
    conversas:   { today: "—", noAnswer: "—", total: mConversas.count ?? "—" },
    parceiros:   { total: mParceiros.count ?? "—" },
  };

  return ok(res, payload);
});
