// src/pages/EscolhaRegiao.jsx
import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { useNavigate } from "react-router-dom";

export default function EscolhaRegiao() {
  const navigate = useNavigate();
  const [regioes, setRegioes] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  useEffect(() => {
    async function carregar() {
      try {
        setCarregando(true);
        setErro("");

        // busca regiões ATIVAS, ordenadas por nome
        const { data, error } = await supabase
          .from("regioes")
          .select("id, nome, slug, ativo")
          .eq("ativo", true)
          .order("nome", { ascending: true });

        if (error) throw error;
        setRegioes(Array.isArray(data) ? data : []);
      } catch (e) {
        console.error(e);
        setErro("Não foi possível carregar as regiões. Tente novamente.");
      } finally {
        setCarregando(false);
      }
    }
    carregar();
  }, []);

  function abrirChat(slug) {
    // navega para a sua rota de chat; ajuste se o seu path for diferente
    navigate(`/chat/${slug}`);
  }

  if (carregando) {
    return <div style={{ padding: 24 }}>Carregando regiões…</div>;
  }
  if (erro) {
    return <div style={{ padding: 24, color: "red" }}>{erro}</div>;
  }
  if (regioes.length === 0) {
    return <div style={{ padding: 24 }}>Nenhuma região ativa no momento.</div>;
  }

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        {/* sua logo aqui */}
        <img
          src="/logo.png"
          alt="BEPIT Nexus"
          style={{ height: 64, marginBottom: 12 }}
        />
        <h1 style={{ margin: 0 }}>Escolha a região</h1>
        <p style={{ marginTop: 8, color: "#555" }}>
          Toque na região que deseja explorar.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 16
        }}
      >
        {regioes.map((r) => (
          <button
            key={r.id}
            onClick={() => abrirChat(r.slug)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: 120,
              border: "1px solid #e5e7eb",
              borderRadius: 12,
              background: "white",
              cursor: "pointer",
              fontSize: 18,
              fontWeight: 600,
              boxShadow: "0 1px 2px rgba(0,0,0,0.06)"
            }}
          >
            {r.nome}
          </button>
        ))}
      </div>
    </div>
  );
}
