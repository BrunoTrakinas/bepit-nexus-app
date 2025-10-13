// @ts-nocheck


import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Cidade = {
  id: string | number;
  nome: string;
  lat: number | null;
  lng: number | null;
  ativo?: boolean;
};

type OWMOneCall = {
  current?: Record<string, unknown>;
  daily?: unknown[];
};

const VIP_COASTAL = [
  "arraial do cabo",
  "cabo frio",
  "armação dos búzios",
  "armaçao dos búzios",
  "armação de búzios",
  "búzios",
  "buzios",
];

/** Util */
const toSlug = (s: string) =>
  String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

serve(async (req) => {
  const runId = crypto.randomUUID();

  try {
    // ---------------- ENV ----------------
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const OWM_KEY = Deno.env.get("OPENWEATHER_API_KEY") ?? "";
    const SG_KEY = Deno.env.get("STORMGLASS_API_KEY") ?? "";

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes.");
    }
    if (!OWM_KEY) {
      throw new Error("OPENWEATHER_API_KEY ausente.");
    }

    // -------------- SUPABASE --------------
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
      global: { headers: { "x-run-id": runId } },
    });

    // Lista de cidades ativas
    const { data: cidades, error: cidadesErr } = await supabase
      .from("cidades")
      .select("id, nome, lat, lng, ativo")
      .eq("ativo", true);

    if (cidadesErr) throw cidadesErr;

    const lista: Cidade[] = Array.isArray(cidades) ? cidades : [];
    if (lista.length === 0) {
      throw new Error("Nenhuma cidade ativa encontrada.");
    }

    // -------------- ESTATÍSTICAS --------------
    const summary = {
      runId,
      totalCidades: lista.length,
      processadasOWM: 0,
      processadasSG_tide: 0,
      processadasSG_water: 0,
      puladasSemCoord: [] as Array<{ id: Cidade["id"]; nome: string }>,
      erros: [] as Array<{ cidade?: string; etapa: string; motivo: string }>,
    };

    // -------------- LOOP PRINCIPAL --------------
    for (const cidade of lista) {
      const { id, nome } = cidade;

      // Robustez: coordenadas válidas?
      const lat = typeof cidade.lat === "number" ? cidade.lat : Number(cidade.lat);
      const lng = typeof cidade.lng === "number" ? cidade.lng : Number(cidade.lng);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        console.warn(`[clima:${runId}] Pulando cidade sem coordenadas válidas: ${nome} (id=${id})`);
        summary.puladasSemCoord.push({ id, nome });
        continue;
      }

      // ---------- OpenWeather (todas as cidades) ----------
      try {
        const url =
          `https://api.openweathermap.org/data/3.0/onecall` +
          `?lat=${encodeURIComponent(lat)}` +
          `&lon=${encodeURIComponent(lng)}` +
          `&units=metric&lang=pt_br&appid=${encodeURIComponent(OWM_KEY)}`;

        const resp = await fetch(url);
        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(`OpenWeather falhou (${resp.status}): ${txt.slice(0, 200)}`);
        }
        const json: OWMOneCall = await resp.json();

        const current = json?.current ?? {};
        const daily = Array.isArray(json?.daily) ? json.daily : [];

        // upsert clima_atual
        const up1 = await supabase
          .from("dados_climaticos")
          .upsert(
            {
              cidade_id: id,
              tipo_dado: "clima_atual",
              dados: current,
              data_hora_consulta: new Date().toISOString(),
            },
            { onConflict: "cidade_id,tipo_dado" }
          )
          .select("cidade_id");

        if (up1.error) throw up1.error;

        // upsert previsao_diaria
        const up2 = await supabase
          .from("dados_climaticos")
          .upsert(
            {
              cidade_id: id,
              tipo_dado: "previsao_diaria",
              dados: daily,
              data_hora_consulta: new Date().toISOString(),
            },
            { onConflict: "cidade_id,tipo_dado" }
          )
          .select("cidade_id");

        if (up2.error) throw up2.error;

        summary.processadasOWM += 1;
      } catch (e) {
        console.error(`[clima:${runId}] Erro OWM em "${nome}":`, e?.message || e);
        summary.erros.push({ cidade: nome, etapa: "openweather", motivo: String(e?.message || e) });
        // Continua para Stormglass (se VIP), apesar do erro do OWM
      }

      // ---------- Stormglass (apenas VIP / madrugada) ----------
      const horaUTC = new Date().getUTCHours();
      const isMadrugada = horaUTC < 4;
      const nomeSlug = toSlug(nome);

      const isVIP = VIP_COASTAL.some((vip) => nomeSlug.includes(vip));
      if (!isVIP || !isMadrugada) continue;

      if (!SG_KEY) {
        console.warn(`[clima:${runId}] STORMGLASS_API_KEY ausente — pulando Stormglass para "${nome}".`);
        continue;
      }

      const start = Math.floor(Date.now() / 1000);
      const end = start + 24 * 3600;

      // Marés
      try {
        const tideUrl =
          `https://api.stormglass.io/v2/tide/extremes/point` +
          `?lat=${encodeURIComponent(lat)}` +
          `&lng=${encodeURIComponent(lng)}` +
          `&start=${start}&end=${end}`;

        const tideResp = await fetch(tideUrl, { headers: { Authorization: SG_KEY } });
        if (!tideResp.ok) {
          const b = await tideResp.text();
          throw new Error(`Stormglass/tide falhou (${tideResp.status}): ${b.slice(0, 200)}`);
        }
        const tideJson = await tideResp.json();

        const upTide = await supabase
          .from("dados_climaticos")
          .upsert(
            {
              cidade_id: id,
              tipo_dado: "dados_mare",
              dados: tideJson,
              data_hora_consulta: new Date().toISOString(),
            },
            { onConflict: "cidade_id,tipo_dado" }
          )
          .select("cidade_id");

        if (upTide.error) throw upTide.error;

        summary.processadasSG_tide += 1;
      } catch (e) {
        console.error(`[clima:${runId}] Erro Stormglass/marés em "${nome}":`, e?.message || e);
        summary.erros.push({ cidade: nome, etapa: "stormglass_tide", motivo: String(e?.message || e) });
      }

      // Temperatura da água
      try {
        const wtUrl =
          `https://api.stormglass.io/v2/weather/point` +
          `?lat=${encodeURIComponent(lat)}` +
          `&lng=${encodeURIComponent(lng)}` +
          `&params=waterTemperature&source=sg&start=${start}&end=${end}`;

        const wtResp = await fetch(wtUrl, { headers: { Authorization: SG_KEY } });
        if (!wtResp.ok) {
          const b = await wtResp.text();
          throw new Error(`Stormglass/waterTemperature falhou (${wtResp.status}): ${b.slice(0, 200)}`);
        }
        const wtJson = await wtResp.json();

        const upWT = await supabase
          .from("dados_climaticos")
          .upsert(
            {
              cidade_id: id,
              tipo_dado: "temperatura_agua",
              dados: wtJson,
              data_hora_consulta: new Date().toISOString(),
            },
            { onConflict: "cidade_id,tipo_dado" }
          )
          .select("cidade_id");

        if (upWT.error) throw upWT.error;

        summary.processadasSG_water += 1;
      } catch (e) {
        console.error(`[clima:${runId}] Erro Stormglass/água em "${nome}":`, e?.message || e);
        summary.erros.push({ cidade: nome, etapa: "stormglass_water", motivo: String(e?.message || e) });
      }
    }

    // ---------------- RESPOSTA ----------------
    const payload = {
      ok: true,
      runId,
      totalCidades: summary.totalCidades,
      processadasOWM: summary.processadasOWM,
      processadasSG_tide: summary.processadasSG_tide,
      processadasSG_water: summary.processadasSG_water,
      puladasSemCoord: summary.puladasSemCoord.length,
      erros: summary.erros.length,
      detalhesErros: summary.erros.slice(0, 10), // corta para resposta ficar leve
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    console.error(`[clima:${runId}] ERRO FATAL:`, error);
    return new Response(
      JSON.stringify({
        ok: false,
        runId,
        motivo: (error && (error.message || String(error))) || "Erro desconhecido",
      }),
      { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }
});
