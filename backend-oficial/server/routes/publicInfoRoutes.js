// server/routes/publicInfoRoutes.js
// ============================================================================
// Rotas públicas de informação (clima). Minimalista e segura.
// Exemplo de uso no frontend:
//   GET /api/public/weather?regiao=regiao-dos-lagos&cidade=cabo-frio
// ============================================================================

import express from "express";
import { getCoordsForCitySlug, getCurrentWeatherByCoords } from "../utils/publicInfo.js";

export function buildPublicInfoRouter() {
  const router = express.Router();

  // GET /api/public/weather?regiao=regiao-dos-lagos&cidade=cabo-frio
  router.get("/weather", async (req, res) => {
    try {
      const regiaoSlug = String(req.query.regiao || "regiao-dos-lagos");
      const cidadeSlug = String(req.query.cidade || "cabo-frio");

      const coords = await getCoordsForCitySlug(regiaoSlug, cidadeSlug);
      const clima = await getCurrentWeatherByCoords(coords.lat, coords.lng);

      return res.json({
        ok: true,
        regiao: regiaoSlug,
        cidade: cidadeSlug,
        coords,
        weather: clima
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: "weather_failed",
        message: String(e?.message || e)
      });
    }
  });

  return router;
}
