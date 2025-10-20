// supabase/functions/coletor-clima/index.ts
// ============================================================================
// BEPIT Nexus — Edge Function: coletor-clima (versão normalizada)
// Missões:
//   1) CLIMA (OpenWeather One Call 3.0) para 10 cidades -> salvar:
//        - tipo_dado = 'clima_atual'       (CANÔNICO resumido)
//        - tipo_dado = 'previsao_diaria'   (CANÔNICO resumido)
//   2) DADOS MARÍTIMOS (Stormglass) para 3 cidades VIP (janela 03:00–04:59 UTC):
//        - tipo_dado = 'dados_mare'        (CANÔNICO resumido)
//        - tipo_dado = 'temperatura_agua'  (valor canônico)
// Observações:
// - Execução robusta (try/catch por cidade) sem travar a função.
// - Chamadas em paralelo por missão (Promise.all).
// - Upsert com onConflict (cidade_id, tipo_dado) -> sempre sobrescreve o snapshot.
// - Variáveis de ambiente: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   OPENWEATHER_API_KEY, STORMGLASS_API_KEY
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ------------------------------- ENV VARS -----------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENWEATHER_API_KEY = Deno.env.get("OPENWEATHER_API_KEY") ?? "";
const STORMGLASS_API_KEY = Deno.env.get("STORMGLASS_API_KEY") ?? "";

// ------------------------------- SUPABASE -----------------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ------------------------------- DADOS --------------------------------------
type Cidade = { id: string; nome: string; lat: number; lon: number };

const CIDADES: Cidade[] = [
  { id: "c61e66ef-0fd0-4b34-a8ec-1d05bcb108d0", nome: "Cabo Frio", lat: -22.8794, lon: -42.0188 },
  { id: "775e92f6-2390-4f40-a00a-ccc4763484c4", nome: "Arraial do Cabo", lat: -22.9661, lon: -42.0278 },
  { id: "e18f4c59-5d9f-4a83-aa4a-6751089503ba", nome: "Armação dos Búzios", lat: -22.7472, lon: -41.8817 },
  { id: "6d4d7723-d6d5-457b-bde1-32f14e28838a", nome: "Rio das Ostras", lat: -22.5269, lon: -41.945 },
  { id: "c9b5f701-2e2b-417a-87d3-702af0d5354a", nome: "São Pedro da Aldeia", lat: -22.8394, lon: -42.1014 },
  { id: "47845dd2-1d9b-4dc6-a1f3-667e6d823fa7", nome: "Araruama", lat: -22.9028, lon: -42.3431 },
  { id: "0f1d5c64-a72a-4786-af6b-1cebd959140d", nome: "Iguaba Grande", lat: -22.8458, lon: -42.2289 },
  { id: "c3152e55-8eeb-450d-8423-c06f65573118", nome: "Saquarema", lat: -22.9219, lon: -42.5097 },
  { id: "66e81cf0-7fc1-4073-8d06-34d46c27b061", nome: "Barra de São João", lat: -22.6108, lon: -41.995 },
  { id: "bc8caab2-866f-4cd8-b22a-b7da4724677c", nome: "Unamar", lat: -22.6586, lon: -41.9961 },
];

const VIP_NOMES = new Set<string>(["Arraial do Cabo", "Cabo Frio", "Armação dos Búzios"]);

// ------------------------------- HELPERS ------------------------------------
function nowISO(): string {
  return new Date().toISOString();
}

// retry leve com backoff para chamadas externas
async function fetchJSON(url: string, init?: RequestInit, retries = 2): Promise<any> {
  let lastErr: unknown = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { ...init, cf: { cacheTtl: 0 } as any });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${await r.text().catch(() => "")}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((res) => setTimeout(res, 400 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

// ---------------------- TRANSFORMADORES CANÔNICOS ---------------------------
// Obs.: Padronizamos unidades e chaves para facilitar consumo no chat/UI.

function canonicalClimaAtual(lat: number, lon: number, current: any) {
  return {
    fonte: "openweather",
    capturado_em: nowISO(),
    lat,
    lon,
    clima_atual: {
      temp_c: Number(current?.temp ?? 0),
      vento_kmh: Math.round(Number(current?.wind_speed ?? 0) * 3.6),
      chuva_mm: Number(current?.rain?.["1h"] ?? 0),
      umidade_pct: Number(current?.humidity ?? 0),
      pressao_hpa: Number(current?.pressure ?? 0),
      nublado_pct: Number(current?.clouds ?? 0),
      descricao: String(current?.weather?.[0]?.description ?? ""),
      icon: String(current?.weather?.[0]?.icon ?? ""),
    },
  };
}

function canonicalPrevisaoDiaria(daily: any[]) {
  const top5 = Array.isArray(daily) ? daily.slice(0, 5) : [];
  return top5.map((d) => ({
    data: new Date(Number(d?.dt ?? 0) * 1000).toISOString().slice(0, 10),
    min_c: Number(d?.temp?.min ?? 0),
    max_c: Number(d?.temp?.max ?? 0),
    chuva_mm: Number(d?.rain ?? 0),
    nublado_pct: Number(d?.clouds ?? 0),
    descricao: String(d?.weather?.[0]?.description ?? ""),
    icon: String(d?.weather?.[0]?.icon ?? ""),
  }));
}

function canonicalTemperaturaAgua(lat: number, lon: number, weatherJson: any) {
  const horas = Array.isArray(weatherJson?.hours) ? weatherJson.hours : [];
  const h = horas.find((x: any) => x?.waterTemperature?.sg !== undefined);
  return {
    fonte: "stormglass",
    capturado_em: nowISO(),
    lat,
    lon,
    temperatura_agua_c: h ? Number(h.waterTemperature.sg) : null,
  };
}

function canonicalMare(lat: number, lon: number, tideJson: any) {
  const data = Array.isArray(tideJson?.data) ? tideJson.data : [];
  // A API de maré do Stormglass geralmente retorna um array com { time, tide }
  const pontos = data
    .filter((p: any) => p?.time && (p?.tide !== undefined || p?.sg !== undefined))
    .map((p: any) => {
      const altura = p?.tide ?? p?.sg ?? 0;
      return {
        hora: String(p.time),
        altura_m: Number(altura),
      };
    });
  return {
    fonte: "stormglass",
    capturado_em: nowISO(),
    lat,
    lon,
    dados_mare: pontos,
  };
}

// ------------------------------- UPSERTS ------------------------------------
async function upsertRow(cidade: Cidade, tipo_dado: string, payload: unknown) {
  const row = {
    cidade_id: cidade.id,
    tipo_dado,
    dados: payload,
    data_hora_consulta: nowISO(),
  };
  const { error } = await supabase.from("dados_climaticos").upsert(row, { onConflict: "cidade_id,tipo_dado" });
  if (error) throw error;
}

// ------------------------------- COLETORES ----------------------------------
/**
 * OpenWeather One Call 3.0
 * https://api.openweathermap.org/data/3.0/onecall
 * Parâmetros: units=metric, lang=pt_br, exclude=minutely,hourly,alerts
 */
async function coletarClimaParaCidade(cidade: Cidade) {
  const url = new URL("https://api.openweathermap.org/data/3.0/onecall");
  url.searchParams.set("lat", String(cidade.lat));
  url.searchParams.set("lon", String(cidade.lon));
  url.searchParams.set("appid", OPENWEATHER_API_KEY);
  url.searchParams.set("units", "metric");
  url.searchParams.set("lang", "pt_br");
  url.searchParams.set("exclude", "minutely,hourly,alerts");

  const json = await fetchJSON(url.toString(), { method: "GET" });

  const current = json?.current ?? null;
  const daily = Array.isArray(json?.daily) ? json.daily : null;

  if (current) {
    const payloadAtual = canonicalClimaAtual(cidade.lat, cidade.lon, current);
    await upsertRow(cidade, "clima_atual", payloadAtual);
  }
  if (daily) {
    const payloadDiaria = {
      fonte: "openweather",
      capturado_em: nowISO(),
      lat: cidade.lat,
      lon: cidade.lon,
      previsao_diaria: canonicalPrevisaoDiaria(daily),
    };
    await upsertRow(cidade, "previsao_diaria", payloadDiaria);
  }
}

/**
 * Stormglass — água e maré
 * Docs:
 *  - Weather point (waterTemperature): https://docs.stormglass.io/#/weather
 *  - Tide sea-level point (tide):     https://docs.stormglass.io/#/tide
 */
async function coletarMarParaCidadeVIP(cidade: Cidade) {
  const headers = { Authorization: STORMGLASS_API_KEY };

  // Temperatura da água (weather/point)
  const weatherURL = new URL("https://api.stormglass.io/v2/weather/point");
  weatherURL.searchParams.set("lat", String(cidade.lat));
  weatherURL.searchParams.set("lng", String(cidade.lon));
  weatherURL.searchParams.set("params", "waterTemperature");

  // Maré (tide/sea-level/point) com janela de 48h
  const start = new Date();
  const end = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const tideURL = new URL("https://api.stormglass.io/v2/tide/sea-level/point");
  tideURL.searchParams.set("lat", String(cidade.lat));
  tideURL.searchParams.set("lng", String(cidade.lon));
  tideURL.searchParams.set("start", start.toISOString());
  tideURL.searchParams.set("end", end.toISOString());

  const [weatherJson, tideJson] = await Promise.all([
    fetchJSON(weatherURL.toString(), { headers }),
    fetchJSON(tideURL.toString(), { headers }),
  ]);

  // Temperatura da água (canônico)
  const payloadAgua = canonicalTemperaturaAgua(cidade.lat, cidade.lon, weatherJson);
  await upsertRow(cidade, "temperatura_agua", payloadAgua);

  // Maré (canônico)
  const payloadMare = canonicalMare(cidade.lat, cidade.lon, tideJson);
  await upsertRow(cidade, "dados_mare", payloadMare);
}

function deveExecutarMissaoMaritimaAgoraUTC(): boolean {
  const h = new Date().getUTCHours();
  return h >= 3 && h < 5; // 03:00–04:59 UTC
}

// ------------------------------- MISSÕES ------------------------------------
async function missaoClima(): Promise<{ ok: boolean; coletadas: number }> {
  console.log("[COLETOR] Iniciando Missão 1 — Clima (OpenWeather)...");
  const resultados = await Promise.allSettled(
    CIDADES.map(async (cidade) => {
      try {
        await coletarClimaParaCidade(cidade);
        console.log(`[COLETOR] [OK] Clima → ${cidade.nome}`);
        return true;
      } catch (e) {
        console.error(`[COLETOR] [FALHA] Clima → ${cidade.nome}:`, e);
        return false;
      }
    }),
  );
  const okCount = resultados.filter((r) => r.status === "fulfilled" && r.value === true).length;
  console.log(`[COLETOR] Missão 1 finalizada. Cidades coletadas: ${okCount}/${CIDADES.length}.`);
  return { ok: true, coletadas: okCount };
}

async function missaoMaritima(): Promise<{ ok: boolean; coletadas: number; skipped: boolean }> {
  if (!deveExecutarMissaoMaritimaAgoraUTC()) {
    console.log("[COLETOR] Missão 2 — Dados Marítimos pulada (fora da janela 03:00–04:59 UTC).");
    return { ok: true, coletadas: 0, skipped: true };
  }
  console.log("[COLETOR] Iniciando Missão 2 — Dados Marítimos (Stormglass)...");
  const cidadesVIP = CIDADES.filter((c) => VIP_NOMES.has(c.nome));

  const resultados = await Promise.allSettled(
    cidadesVIP.map(async (cidade) => {
      try {
        await coletarMarParaCidadeVIP(cidade);
        console.log(`[COLETOR] [OK] Marítimo → ${cidade.nome}`);
        return true;
      } catch (e) {
        console.error(`[COLETOR] [FALHA] Marítimo → ${cidade.nome}:`, e);
        return false;
      }
    }),
  );
  const okCount = resultados.filter((r) => r.status === "fulfilled" && r.value === true).length;
  console.log(`[COLETOR] Missão 2 finalizada. Cidades VIP coletadas: ${okCount}/${cidadesVIP.length}.`);
  return { ok: true, coletadas: okCount, skipped: false };
}

// ------------------------------- HANDLER ------------------------------------
serve(async (_req) => {
  const startedAt = nowISO();

  // Verificações rápidas de env
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const msg = "[COLETOR] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não configuradas.";
    console.error(msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (!OPENWEATHER_API_KEY) {
    const msg = "[COLETOR] OPENWEATHER_API_KEY não configurada.";
    console.error(msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (!STORMGLASS_API_KEY) {
    console.warn("[COLETOR] STORMGLASS_API_KEY não configurada. Missão 2 pode falhar/pular.");
  }

  console.log(`[COLETOR] Execução iniciada em ${startedAt}.`);

  const [r1, r2] = await Promise.allSettled([missaoClima(), missaoMaritima()]);

  const result = {
    ok: true,
    startedAt,
    finishedAt: nowISO(),
    clima: r1.status === "fulfilled" ? r1.value : { ok: false, error: String(r1.reason) },
    maritimo: r2.status === "fulfilled" ? r2.value : { ok: false, error: String(r2.reason) },
  };

  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
});
