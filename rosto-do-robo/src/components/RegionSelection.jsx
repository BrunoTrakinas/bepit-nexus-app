// src/pages/RegionSelection.jsx
import React from "react";
import { useNavigate } from "react-router-dom";

/**
 * Tela simples de seleção de região.
 * Quando clicar, salva { slug, nome } no localStorage e redireciona para /chat.
 */
export default function RegionSelection() {
  const navigate = useNavigate();

  function selecionarRegiao({ slug, nome }) {
    try {
      localStorage.setItem(
        "bepit:region",
        JSON.stringify({ slug, nome, savedAt: Date.now() })
      );
    } catch {}
    navigate("/chat", { replace: true });
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background:
          "linear-gradient(180deg, rgba(242,245,250,1) 0%, rgba(255,255,255,1) 100%)",
      }}
    >
      <div
        style={{
          width: "min(720px, 92vw)",
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 16,
          padding: 24,
          boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>
          Selecione uma Região
        </h1>
        <p style={{ marginTop: 8, color: "#4b5563" }}>
          Escolha a região onde deseja usar o BEPIT.
        </p>

        <div style={{ display: "grid", gap: 12, marginTop: 20 }}>
          <button
            onClick={() =>
              selecionarRegiao({
                slug: "regiao-dos-lagos",
                nome: "Região dos Lagos",
              })
            }
            style={botaoEstilo}
          >
            Região dos Lagos
          </button>

          {/* Deixe exemplos preparados para expansão futura */}
          {/* <button
            onClick={() =>
              selecionarRegiao({ slug: "serra", nome: "Serra" })
            }
            style={botaoEstilo}
          >
            Serra (em breve)
          </button> */}
        </div>
      </div>
    </div>
  );
}

const botaoEstilo = {
  width: "100%",
  textAlign: "left",
  background: "#0ea5e9",
  color: "#fff",
  border: "none",
  padding: "14px 16px",
  borderRadius: 12,
  fontWeight: 700,
  cursor: "pointer",
  transition: "transform 120ms ease",
};
