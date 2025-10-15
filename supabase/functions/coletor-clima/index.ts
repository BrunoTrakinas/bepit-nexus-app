/// <reference lib="deno.ns" />
/// <reference lib="deno.window" />
// supabase/functions/coletor-clima/index.ts
// ============================================================================
// BEPIT Nexus — Edge Function "coletor-clima"
// Robô de coleta e persistência de dados climáticos e marítimos
// Execução: sob demanda ou via scheduler do Supabase
//
// Missão 1 (sempre): OpenWeather One Call 3.0 -> clima_atual + previsao_diaria
// Missão 2 (janela 03:00–05:00 UTC): Stormglass -> dados_mare + temperatura_agua (CIDADES VIP)
// ============================================================================

/**
 * Requisitos de ambiente:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 * - OPENWEATHERMAP_API_KEY
 * - STORMGLASS_API_KEY
 *
 * Observação:
 * - Esta função usa upsert na tabela `dados_climaticos` com onConflict "cidade_id,tipo_dado".
 *   Estrutura esperada: { cidade_id: number, tipo_dado: string, dados: jsonb, data_hora_consulta: timestamptz }
 */

// Import para Deno via esm.sh (modo compatível com Deno)
// Se preferir JSR em produção, pode trocar para: `import { createClient } from "jsr:@supabase/supabase-js@2";`
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=denonext";

// ---------------------------------- CONSTANTES ----------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OPENWEATHERMAP_API_KEY = Deno.env.get("OPENWEATHERMAP_API_KEY") ?? "";
const STORMGLASS_API_KEY = Deno.env.get("STORMGLASS_API_KEY") ?? "";

// 10 cidades do escopo (IDs devem bater com a sua tabela "cidades")
const TODAS_AS_CIDADES = [
  { id: 1, nome: "Cabo Frio", lat: -22.8794, lon: -42.0188 },
  { id: 2, nome: "Arraial do Cabo", lat: -22.9661, lon: -42.0278 },
  { id: 3, nome: "Armação dos Búzios", lat: -22.7472, lon: -41.8817 },
  { id: 4, nome: "Rio das Ostras", lat: -22.5269, lon: -41.945 },
  { id: 5, nome: "São Pedro da Aldeia", lat: -22.8394, lon: -42.1014 },
  { id: 6, nome: "Araruama", lat: -22.9028, lon: -42.3431 },
  { id: 7, nome: "Iguaba Grande", lat: -22.8458, lon: -42.2289 },
  { id: 8, nome: "Saquarema", lat: -22.9219, lon: -42.5097 },
  { id: 9, nome: "Barra de São João", lat: -22.6108, lon: -41.995 },
  { id: 10, nome: "Unamar", lat: -22.6586, lon: -41.9961 },
] as const;

// Cidades VIP para dados de marés/temperatura da água (Stormglass)
const CIDADES_VIP_NOMES = new Set(["Arraial do Cabo", "Cabo Frio", "Armação dos Búzios"]);

// ---------------------------------- CLIENTES ----------------------------------

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------- HELPERS -----------------------------------

function agoraISO(): string {
  return new Date().toISOString();
}

function isStormglassWindowUTC(): boolean {
  // Executa apenas entre 03:00 e 04:59 UTC
  const hour = new Date().getUTCHours();
  return hour >= 3 && hour < 5;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Upsert único na tabela "dados_climaticos"
async function upsertDadoClimatico(
  cidade_id: number,
  tipo_dado: "clima_atual" | "previsao_diaria" | "dados_mare" | "temperatura_agua",
  dados: unknown,
) {
  const payload = {
    cidade_id,
    tipo_dado,
    dados,
    data_hora_consulta: agoraISO(),
  };

  const { error } = await supabase
    .from("dados_climaticos")
    .upsert(payload, { onConflict: "cidade_id,tipo_dado" });

  if (error) throw error;
}

// ----------------------- MISSÃO 1: OPENWEATHER (sempre) ----------------------

async function coletarOpenWeatherParaCidade(cidade: typeof TODAS_AS_CIDADES[number]) {
  const { id, lat, lon, nome } = cidade;
  const url = new URL("https://api.openweathermap.org/data/3.0/onecall");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("appid", OPENWEATHERMAP_API_KEY);
  url.searchParams.set("units", "metric");
  url.searchParams.set("lang", "pt_br");
  url.searchParams.set("exclude", "minutely,hourly,alerts"); // pegamos 'current' e 'daily'

  console.log(`[OWM] Iniciando coleta para ${nome} (${lat},${lon}) -> ${url.toString()}`);

  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`[OWM] Falha para ${nome}: ${resp.status} ${resp.statusText} ${txt}`);
  }
  const json = await resp.json();

  // Estrutura esperada: { current: {...}, daily: [...] }
  const current = json?.current ?? null;
  const daily = Array.isArray(json?.daily) ? json.daily : null;

  if (!current || !daily) {
    throw new Error(`[OWM] Resposta inesperada para ${nome}: campos 'current' ou 'daily' ausentes.`);
  }

  // Persistir
  await upsertDadoClimatico(id, "clima_atual", current);
  await upsertDadoClimatico(id, "previsao_diaria", daily);

  console.log(`[OWM] Sucesso ao salvar registros de ${nome}: clima_atual + previsao_diaria.`);
}

// -------------------- MISSÃO 2: STORMGLASS (janela horário) ------------------

/**
 * Observação importante:
 * - A API Stormglass possui endpoints distintos para TIDE e WEATHER.
 * - Para robustez e compatibilidade, realizamos DUAS chamadas:
 *    1) tide extremes: /v2/tide/extremes/point
 *    2) waterTemperature: /v2/weather/point?params=waterTemperature
 * - Ambas as respostas são salvas separadamente como `dados_mare` e `temperatura_agua`.
 */
async function coletarStormglassParaCidadeVIP(cidade: typeof TODAS_AS_CIDADES[number]) {
  const { id, lat, lon, nome } = cidade;

  const headers = { Authorization: STORMGLASS_API_KEY };

  // --- TIDE (maré) ---
  const now = new Date();
  const startISO = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).toISOString();
  const endISO = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59)).toISOString();

  const tideURL = new URL("https://api.stormglass.io/v2/tide/extremes/point");
  tideURL.searchParams.set("lat", String(lat));
  tideURL.searchParams.set("lng", String(lon));
  tideURL.searchParams.set("start", startISO);
  tideURL.searchParams.set("end", endISO);

  console.log(`[SG] Coleta de maré para ${nome} -> ${tideURL.toString()}`);

  const r = await fetch(tideURL, { headers });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`[SG] Falha (tide) para ${nome}: ${r.status} ${r.statusText} ${txt}`);
  }
  const tideJson = await r.json();
  await upsertDadoClimatico(id, "dados_mare", tideJson);
  console.log(`[SG] Sucesso ao salvar dados_mare de ${nome}.`);

  // --- WATER TEMPERATURE (temperatura da água) ---
  const weatherURL = new URL("https://api.stormglass.io/v2/weather/point");
  weatherURL.searchParams.set("lat", String(lat));
  weatherURL.searchParams.set("lng", String(lon));
  weatherURL.searchParams.set("params", "waterTemperature");
  weatherURL.searchParams.set("source", "noaa");

  console.log(`[SG] Coleta de waterTemperature para ${nome} -> ${weatherURL.toString()}`);

  const r2 = await fetch(weatherURL, { headers });
  if (!r2.ok) {
    const txt = await r2.text().catch(() => "");
    throw new Error(`[SG] Falha (waterTemperature) para ${nome}: ${r2.status} ${r2.statusText} ${txt}`);
  }
  const waterJson = await r2.json();
  await upsertDadoClimatico(id, "temperatura_agua", waterJson);
  console.log(`[SG] Sucesso ao salvar temperatura_agua de ${nome}.`);
}

// --------------------------------- HANDLER -----------------------------------

// Nas Edge Functions, use o Deno.serve global
Deno.serve(async (req: Request) => {
  const runId = crypto.randomUUID();
  const startedAt = new Date();

  const headersBase: HeadersInit = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: headersBase });
  }

  // Valida secrets mínimas
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(
      JSON.stringify({ error: "Ambiente incompleto: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes." }),
      { status: 500, headers: headersBase },
    );
  }
  if (!OPENWEATHERMAP_API_KEY) {
    return new Response(
      JSON.stringify({ error: "Ambiente incompleto: OPENWEATHERMAP_API_KEY ausente." }),
      { status: 500, headers: headersBase },
    );
  }

  console.log(`[RUN ${runId}] Início do coletor-clima @ ${startedAt.toISOString()}`);

  // -------------------- Missão 1: OpenWeather (sempre) --------------------
  console.log(`[RUN ${runId}] [Missão 1] OpenWeather — início`);
  const promOpenWeather = Promise.allSettled(
    TODAS_AS_CIDADES.map(async (c) => {
      try {
        await coletarOpenWeatherParaCidade(c);
        return { ok: true, cidade: c.nome };
      } catch (err) {
        console.error(`[RUN ${runId}] [Missão 1] ERRO em ${c.nome}:`, err);
        return { ok: false, cidade: c.nome, error: String((err as Error)?.message ?? err) };
      } finally {
        // pequeno espalhamento para não bombardear a API em rajada
        await sleep(120);
      }
    }),
  ).then((results) => {
    const resumo = {
      sucesso: results.filter((r) => r.status === "fulfilled" && (r.value as any).ok).length,
      falhas:
        results.filter((r) => r.status === "fulfilled" && !(r.value as any).ok).length +
        results.filter((r) => r.status === "rejected").length,
      detalhes: results.map((r) =>
        r.status === "fulfilled" ? r.value : { ok: false, error: String(r.reason) }
      ),
    };
    console.log(`[RUN ${runId}] [Missão 1] OpenWeather — fim`, resumo);
    return resumo;
  });

  // -------------------- Missão 2: Stormglass (janela) ---------------------
  const deveExecutarStormglass = !!STORMGLASS_API_KEY && isStormglassWindowUTC();
  let promStormglass: Promise<unknown> | null = null;

  if (deveExecutarStormglass) {
    console.log(`[RUN ${runId}] [Missão 2] Stormglass — início (janela válida UTC 03–05)`);
    const cidadesVIP = TODAS_AS_CIDADES.filter((c) => CIDADES_VIP_NOMES.has(c.nome));
    promStormglass = Promise.allSettled(
      cidadesVIP.map(async (c) => {
        try {
          await coletarStormglassParaCidadeVIP(c);
          return { ok: true, cidade: c.nome };
        } catch (err) {
          console.error(`[RUN ${runId}] [Missão 2] ERRO em ${c.nome}:`, err);
          return { ok: false, cidade: c.nome, error: String((err as Error)?.message ?? err) };
        } finally {
          await sleep(120);
        }
      }),
    ).then((results) => {
      const resumo = {
        sucesso: results.filter((r) => r.status === "fulfilled" && (r.value as any).ok).length,
        falhas:
          results.filter((r) => r.status === "fulfilled" && !(r.value as any).ok).length +
          results.filter((r) => r.status === "rejected").length,
        detalhes: results.map((r) =>
          r.status === "fulfilled" ? r.value : { ok: false, error: String(r.reason) }
        ),
      };
      console.log(`[RUN ${runId}] [Missão 2] Stormglass — fim`, resumo);
      return resumo;
    });
  } else {
    console.log(`[RUN ${runId}] [Missão 2] Stormglass — pulada (sem chave ou fora da janela 03–05 UTC).`);
  }

  // Executa as missões em paralelo (Stormglass pode ser nula)
  const [owmResumo, sgResumo] = await Promise.all([
    promOpenWeather,
    promStormglass ?? Promise.resolve({ pulada: true }),
  ]);

  const finishedAt = new Date();
  console.log(`[RUN ${runId}] Coletor finalizado @ ${finishedAt.toISOString()}`);

  return new Response(
    JSON.stringify({
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      missaoOpenWeather: owmResumo,
      missaoStormglass: sgResumo,
    }),
    { headers: headersBase },
  );
});
