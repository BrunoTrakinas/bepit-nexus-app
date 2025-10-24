// services/clima.db.service.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function normCidade(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

// Helpers para extrair do JSON (OpenWeather "current", "hourly", "daily")
function kToC(x) { return typeof x === "number" ? (x - 273.15) : null; }

function pickCurrent(json) {
  if (!json || typeof json !== "object") return null;
  const cur = json.current || json.now || json.atual || null;
  if (!cur) return null;

  // OpenWeather: current.temp (K) e wind_speed (m/s)
  const tempK = cur.temp ?? cur.temperature ?? null;
  const wind = cur.wind_speed ?? cur.wind_kmh ?? null;
  const weather = Array.isArray(cur.weather) && cur.weather[0] ? cur.weather[0] : null;

  return {
    captured_at: cur.dt ? new Date(cur.dt * 1000).toISOString() : json.captured_at || null,
    temp_c: tempK != null ? (tempK > 80 ? tempK : kToC(tempK)) : null, // se já vier em °C (>80K => Kelvin)
    wind_kmh: typeof wind === "number" ? (wind > 40 ? wind : wind * 3.6) : null,
    code: weather?.main || null,
    desc: weather?.description || null,
    raw: cur,
  };
}

function pickDaily(json) {
  if (!json || typeof json !== "object") return null;
  const daily = json.daily || json.previsao_diaria || null;
  if (!Array.isArray(daily) || daily.length === 0) return null;

  const norm = daily.map((d) => {
    const dateIso = d.dt ? new Date(d.dt * 1000).toISOString().slice(0, 10) : (d.date || null);
    const tMin = d.temp?.min ?? d.tmin ?? null;
    const tMax = d.temp?.max ?? d.tmax ?? null;
    const w = Array.isArray(d.weather) && d.weather[0] ? d.weather[0] : null;
    const toC = (v) => (v != null ? (v > 80 ? v - 273.15 : v) : null);

    return {
      date: dateIso,
      tmin_c: toC(tMin),
      tmax_c: toC(tMax),
      code: w?.main || null,
      desc: w?.description || null,
      raw: d,
    };
  });

  return { list: norm };
}

// -------------------- Consultas ao DB --------------------

async function getLastRowByCidade(table, cidade, whereExtra = "", orderCols = ["captured_at", "fetched_at"]) {
  // Tentamos ordenar por captured_at DESC, se não existir cai no next.
  const like = `%${cidade}%`;
  let sel = supabase
    .from(table)
    .select("*")
    .ilike("cidade", like)
    .limit(1);

  // Tentamos ordem por colunas comuns
  for (const col of orderCols) {
    const { data, error } = await sel.order(col, { ascending: false });
    if (!error && Array.isArray(data) && data.length === 1) return data[0];
  }

  // Fallback: sem order explícito
  const { data } = await supabase.from(table).select("*").ilike("cidade", like).limit(1);
  return Array.isArray(data) && data[0] ? data[0] : null;
}

async function getLastForecastRow(table, cidade) {
  const like = `%${cidade}%`;
  // Preferimos registros com daily (8d). Se tiver coluna tipo/escopo, melhor ainda.
  // 1) por coluna "tipo"/"escopo"
  let q = supabase.from(table).select("*").ilike("cidade", like).limit(1);
  const candidates = [
    { col: "tipo", val: "8d" },
    { col: "tipo", val: "daily" },
    { col: "escopo", val: "8d" },
    { col: "escopo", val: "daily" },
  ];

  for (const c of candidates) {
    const { data, error } = await q.eq(c.col, c.val).order("captured_at", { ascending: false });
    if (!error && Array.isArray(data) && data.length > 0) return data[0];
  }

  // 2) Sem coluna de tipo: pega a última linha que contenha daily no json
  const { data } = await supabase
    .from(table)
    .select("*")
    .ilike("cidade", like)
    .order("captured_at", { ascending: false })
    .limit(10);
  if (Array.isArray(data)) {
    for (const row of data) {
      const payload = row.payload || row.raw || row.dados || row.data || null;
      if (payload?.daily && Array.isArray(payload.daily)) return row;
    }
  }
  return null;
}

// -------------------- API pública (usada pelas rotas) --------------------

export async function getClimaAtualFromDB(cidade) {
  const row = await getLastRowByCidade("dados_climaticos", normCidade(cidade));
  if (!row) return null;

  const payload = row.payload || row.raw || row.dados || row.data || null;
  const cur = pickCurrent(payload) || {
    captured_at: row.captured_at || row.data_ref || row.fetched_at || null,
    temp_c: row.temp_c ?? null,
    wind_kmh: row.wind_kmh ?? null,
    code: row.weather_code ?? null,
    desc: row.weather_desc ?? null,
    raw: payload || row,
  };

  return {
    fonte: row.fonte || "openweather",
    captured_at: cur.captured_at,
    temp_c: cur.temp_c,
    wind_kmh: cur.wind_kmh,
    code: cur.code,
    desc: cur.desc,
    raw: cur.raw,
  };
}

export async function getPrevisao8dFromDB(cidade) {
  const row = await getLastForecastRow("dados_climaticos", normCidade(cidade));
  if (!row) return null;
  const payload = row.payload || row.raw || row.dados || row.data || null;
  const daily = pickDaily(payload);
  if (!daily) return null;

  return {
    fonte: row.fonte || "openweather",
    captured_at: row.captured_at || row.data_ref || row.fetched_at || null,
    daily: daily.list,
    raw: payload,
  };
}

export async function getResumoHojeFromDB(cidade) {
  const [now, f8] = await Promise.all([
    getClimaAtualFromDB(cidade),
    getPrevisao8dFromDB(cidade),
  ]);
  if (!now && !f8) return null;

  // tenta achar o "hoje" na previsão
  const today = new Date().toISOString().slice(0, 10);
  let hoje = null;
  if (f8?.daily?.length) {
    hoje = f8.daily.find((d) => d.date === today) || null;
  }

  return {
    fonte: now?.fonte || f8?.fonte || "openweather",
    captured_at: now?.captured_at || f8?.captured_at || null,
    agora: now || null,
    hoje: hoje || null,
  };
}
