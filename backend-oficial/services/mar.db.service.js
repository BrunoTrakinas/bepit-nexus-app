// services/mar.db.service.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function normCidade(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

async function getLastRow(table, cidade) {
  const like = `%${cidade}%`;
  // tenta por captured_at desc
  let q = supabase.from(table).select("*").ilike("cidade", like).order("captured_at", { ascending: false }).limit(1);
  let { data } = await q;
  if (Array.isArray(data) && data[0]) return data[0];

  // fallback por fetched_at
  q = supabase.from(table).select("*").ilike("cidade", like).order("fetched_at", { ascending: false }).limit(1);
  ({ data } = await q);
  if (Array.isArray(data) && data[0]) return data[0];

  // sem order
  ({ data } = await supabase.from(table).select("*").ilike("cidade", like).limit(1));
  if (Array.isArray(data) && data[0]) return data[0];

  return null;
}

async function getRowFromAnyTable(cidade) {
  // prioriza dados_maritimos; se não existir/estiver vazio, tenta dados_climaticos com fonte=stormglass
  let row = await getLastRow("dados_maritimos", cidade);
  if (row) return row;

  // tenta dados_climaticos com filtro por fonte
  const like = `%${cidade}%`;
  const { data } = await supabase
    .from("dados_climaticos")
    .select("*")
    .ilike("cidade", like)
    .eq("fonte", "stormglass")
    .order("captured_at", { ascending: false })
    .limit(1);
  if (Array.isArray(data) && data[0]) return data[0];

  return null;
}

function extractWaterTemp(row) {
  const payload = row.payload || row.raw || row.dados || row.data || null;
  const pWT = payload?.waterTemperature;
  // stormglass: { waterTemperature: { noaa, meto, sg }, time: ISO }
  const time = payload?.time || row.captured_at || row.data_ref || row.fetched_at || null;

  // média simples das fontes disponíveis
  const vals = [];
  if (typeof pWT?.noaa === "number") vals.push(pWT.noaa);
  if (typeof pWT?.meto === "number") vals.push(pWT.meto);
  if (typeof pWT?.sg === "number") vals.push(pWT.sg);
  const water_temp_c = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length) : (row.water_temp_c ?? null);

  return { time, water_temp_c, raw: payload || row };
}

function extractSeaLevel(row) {
  const payload = row.payload || row.raw || row.dados || row.data || null;
  // stormglass "tide" costuma vir com elevation (m) em séries separadas; aqui usamos um "snapshot"
  const time = payload?.time || row.captured_at || row.data_ref || row.fetched_at || null;
  const sl = payload?.sg ?? payload?.seaLevel ?? payload?.tide?.height ?? row.sea_level_m ?? null;
  return { time, sea_level_m: typeof sl === "number" ? sl : null, raw: payload || row };
}

export async function getTemperaturaAguaFromDB(cidade) {
  const row = await getRowFromAnyTable(normCidade(cidade));
  if (!row) return null;
  const { time, water_temp_c, raw } = extractWaterTemp(row);
  return {
    fonte: row.fonte || "stormglass",
    captured_at: time,
    water_temp_c,
    raw,
  };
}

export async function getMareFromDB(cidade) {
  const row = await getRowFromAnyTable(normCidade(cidade));
  if (!row) return null;
  const { time, sea_level_m, raw } = extractSeaLevel(row);
  return {
    fonte: row.fonte || "stormglass",
    captured_at: time,
    sea_level_m,
    raw,
  };
}
