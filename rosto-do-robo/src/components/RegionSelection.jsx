// src/components/RegionSelection.jsx
import React from "react";
import { useNavigate } from "react-router-dom";

const regioes = [
  { nome: "Região dos Lagos", slug: "regiao-dos-lagos" }
];

export default function RegionSelection({ theme }) {
  const colors = theme || { background: "#fff", text: "#222" };
  const navigate = useNavigate();

  function selecionarRegiao(regiao) {
    try {
      // salva slug e nome no localStorage
      localStorage.setItem(
        "bepit.regiao",
        JSON.stringify({ slug: regiao.slug, nome: regiao.nome })
      );
    } catch {}
    // redireciona para a tela de chat sem slug na URL
    navigate("/chat");
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        textAlign: "center",
        padding: "20px",
        backgroundColor: colors.background,
        color: colors.text
      }}
    >
      <img
        src="/bepit-logo.png"
        alt="Logo BEPIT Nexus"
        style={{ width: "150px", marginBottom: "40px" }}
      />

      <h1
        style={{
          marginBottom: "10px",
          fontSize: "2.5rem",
          fontWeight: "700"
        }}
      >
        Bem-vindo ao BEPIT Nexus
      </h1>
      <p
        style={{
          marginBottom: "40px",
          fontSize: "1.25rem",
          color: "#555"
        }}
      >
        Selecione sua região para começar
      </p>

      <div style={{ display: "grid", gap: 14 }}>
        {regioes.map((regiao) => (
          <button
            key={regiao.slug}
            onClick={() => selecionarRegiao(regiao)}
            style={{
              padding: "15px 30px",
              fontSize: "18px",
              borderRadius: "8px",
              border: `1px solid #ddd`,
              background: "#f0f0f0",
              color: "#222",
              cursor: "pointer",
              fontWeight: 600
            }}
          >
            {regiao.nome}
          </button>
        ))}
      </div>
    </div>
  );
}
