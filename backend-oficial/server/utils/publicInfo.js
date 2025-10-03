// server/utils/publicInfo.js
// ============================================================================
// Utilitários de informações públicas (sem chaves): Clima/Temperatura via Open-Meteo
// - Usa lat/lng das cidades do seu banco quando disponíveis.
// - Se não tiver lat/lng no banco, usa um fallback interno.
// - Retorna temperatura atual em °C e sensação térmica quando disponível.
// ============================================================================

import { supabase } from "../lib/supabaseClient.js";

const FALLBACK_COORDS = {
  "cabo-frio": { lat: -22.8894, lng: -42.0286 },
  "arraial-do-cabo": { lat: -22.9661, lng: -42.0271 },
  "buzios": { lat: -22.7469, lng: -41.8817 },
  "búzios": { lat: -22.7469, lng: -41.8817 },
  "sao-pedro-da-aldeia": { lat: -22.8427, lng: -42.1026 },
  "são-pedro-da-aldeia": { lat: -22.8427, lng: -42.1026 }
};

function normSlug(s) {
  return String(s || "").trim().toLowerCase();
}

/**
 * Tenta obter lat/lng da cidade pelo slug dentro de uma região, senão usa fallback.
 */
export async function getCoordsForCitySlug(regiaoSlug, cidadeSlug) {
  const rSlug = normSlug(regiaoSlug);
  const cSlug = normSlug(cidadeSlug);

  try {
    // Busca a região
    const { data: regiao } = await supabase
      .from("regioes")
      .select("id, slug")
      .eq("slug", rSlug)
      .single();

    if (regiao?.id) {
      // Busca cidade dessa região
      const { data: cidade } = await supabase
        .from("cidades")
        .select("id, nome, slug, lat, lng")
        .eq("regiao_id", regiao.id)
        .eq("slug", cSlug)
        .single();

      if (cidade?.lat != null && cidade?.lng != null) {
        return { lat: Number(cidade.lat), lng: Number(cidade.lng), source: "db" };
      }
    }
  } catch {
    /* segue para fallback */
  }

  // Fallback por slug conhecido
  if (FALLBACK_COORDS[cSlug]) {
    const { lat, lng } = FALLBACK_COORDS[cSlug];
    return { lat, lng, source: "fallback" };
  }

  // Fallback genérico: Cabo Frio
  return { lat: -22.8894, lng: -42.0286, source: "default" };
}

/**
 * Busca clima atual via Open-Meteo (sem necessidade de API key).
 * Docs: https://open-meteo.com/en/docs
 */
export async function getCurrentWeatherByCoords(lat, lng) {
  const base = "https://api.open-meteo.com/v1/forecast";
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    current: "temperature_2m,apparent_temperature,wind_speed_10m,relative_humidity_2m"
  });

  const url = `${base}?${params.toString()}`;
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`[weather] HTTP ${resp.status} ${resp.statusText} ${text}`);
  }

  const json = await resp.json();
  const cur = json?.current || {};
  return {
    temperature_c: typeof cur.temperature_2m === "number" ? cur.temperature_2m : null,
    feels_like_c: typeof cur.apparent_temperature === "number" ? cur.apparent_temperature : null,
    humidity: typeof cur.relative_humidity_2m === "number" ? cur.relative_humidity_2m : null,
    wind_speed: typeof cur.wind_speed_10m === "number" ? cur.wind_speed_10m : null,
    raw: cur
  };
}
