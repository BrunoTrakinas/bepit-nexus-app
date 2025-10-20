// /routes/search.js
import express from "express";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const W_VECTOR = 0.7;
const W_TEXT = 0.3;

async function embedQuery(q) {
  const resp = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedText?key=" +
      process.env.GEMINI_API_KEY,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-004", input: q }),
    }
  );
  if (!resp.ok) throw new Error(await resp.text());
  const data = await resp.json();
  return data?.embedding?.value || data?.data?.[0]?.embedding;
}

router.get("/", async (req, res) => {
  try {
    const q = String(req.query.q ?? "");
    const cidade_id = req.query.cidade_id ? String(req.query.cidade_id) : null; // UUID
    const categoria = req.query.categoria ? String(req.query.categoria) : null;
    const limit = Math.min(parseInt(String(req.query.limit ?? "10"), 10) || 10, 30);

    const qVec = q ? await embedQuery(q) : null;

    let vectorRows = [];
    if (qVec) {
      const { data: vrows, error: verr } = await supabase.rpc("parceiros_vector_search_v2", {
        query_embedding: qVec,
        match_count: limit * 3,
        filtro_cidade_id: cidade_id,
        filtro_categoria: categoria,
      });
      if (verr) throw verr;
      vectorRows = vrows ?? [];
    }

    const { data: textRows, error: terr } = await supabase.rpc("parceiros_text_search_v2", {
      q_ilike: `%${q}%`,
      filtro_cidade_id: cidade_id,
      filtro_categoria: categoria,
      fetch_count: limit * 3,
    });
    if (terr) throw terr;

    const map = new Map();
    for (const r of vectorRows) {
      map.set(r.id, { ...r, score_vector: r.similarity || 0, score_text: 0 });
    }
    for (const r of textRows) {
      if (!map.has(r.id)) map.set(r.id, { ...r, score_vector: 0, score_text: r.text_score || 0 });
      else {
        const prev = map.get(r.id);
        map.set(r.id, { ...prev, score_text: Math.max(prev.score_text || 0, r.text_score || 0) });
      }
    }

    const ranked = Array.from(map.values())
      .map((r) => ({
        ...r,
        score_final: W_VECTOR * (r.score_vector || 0) + W_TEXT * (r.score_text || 0),
      }))
      .map((r) => (cidade_id && r.cidade_id === cidade_id ? { ...r, score_final: r.score_final + 0.1 } : r))
      .map((r) => (categoria && r.categoria === categoria ? { ...r, score_final: r.score_final + 0.1 } : r))
      .sort((a, b) => b.score_final - a.score_final)
      .slice(0, limit);

    res.json({ ok: true, count: ranked.length, items: ranked });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

export default router;
