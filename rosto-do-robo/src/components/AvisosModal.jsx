// src/components/AvisosModal.jsx
import React, { useEffect, useMemo, useState } from "react";

export default function AvisosModal({ open, onClose, regionSlug, theme }) {
  const [loading, setLoading] = useState(false);
  const [avisos, setAvisos] = useState([]); // estrutura: [{ cidade: "Cabo Frio", titulo, texto, created_at }, ...]
  const [erro, setErro] = useState("");
  const [abaAtiva, setAbaAtiva] = useState("Geral");

  const border = theme?.inputBg || "#e5e7eb";
  const fg = theme?.text || "#222";
  const bg = theme?.background || "#fff";
  const headerBg = theme?.headerBg || "#f8f8f8";

  useEffect(() => {
    if (!open) return;

    let cancelado = false;
    async function carregar() {
      setLoading(true);
      setErro("");
      try {
        // endpoint do backend v4.0 que você criará (GET /api/avisos/:slug)
        const resp = await fetch(`/api/avisos/${encodeURIComponent(regionSlug)}`, {
          method: "GET",
          headers: { "Content-Type": "application/json" }
        });
        if (!resp.ok) {
          throw new Error(`Falha HTTP ${resp.status}`);
        }
        const data = await resp.json();
        if (!cancelado) {
          // supondo data = { items: [ { cidade: "Cabo Frio", titulo, texto, created_at }, ... ] }
          setAvisos(Array.isArray(data?.items) ? data.items : []);
        }
      } catch (e) {
        if (!cancelado) {
          setErro(e?.message || "Falha ao carregar avisos.");
        }
      } finally {
        if (!cancelado) setLoading(false);
      }
    }

    carregar();
    return () => {
      cancelado = true;
    };
  }, [open, regionSlug]);

  // cria abas dinâmicas por cidade; sempre inclui "Geral"
  const abas = useMemo(() => {
    const cidades = new Set(["Geral"]);
    for (const a of avisos) {
      if (a?.cidade && String(a.cidade).trim()) cidades.add(a.cidade);
    }
    return Array.from(cidades);
  }, [avisos]);

  const avisosDaAba = useMemo(() => {
    if (abaAtiva === "Geral") {
      return avisos.filter((a) => !a?.cidade || !String(a.cidade).trim());
    }
    return avisos.filter((a) => String(a?.cidade || "").trim() === abaAtiva);
  }, [abaAtiva, avisos]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "grid",
        placeItems: "center",
        zIndex: 1000
      }}
    >
      <div
        style={{
          width: "min(920px, 95vw)",
          maxHeight: "85vh",
          borderRadius: 14,
          overflow: "hidden",
          background: bg,
          color: fg,
          border: `1px solid ${border}`,
          display: "grid",
          gridTemplateRows: "auto auto 1fr"
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: 14,
            background: headerBg,
            borderBottom: `1px solid ${border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 18 }}>
            ⚠️ Avisos da Região
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: `1px solid ${border}`,
              color: fg,
              padding: "6px 10px",
              borderRadius: 10,
              cursor: "pointer",
              fontWeight: 600
            }}
          >
            Fechar
          </button>
        </div>

        {/* Abas */}
        <div
          style={{
            padding: "10px 12px",
            borderBottom: `1px solid ${border}`,
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            background: bg
          }}
        >
          {abas.map((nome) => {
            const ativa = abaAtiva === nome;
            return (
              <button
                key={nome}
                onClick={() => setAbaAtiva(nome)}
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  border: `1px solid ${ativa ? "#3b82f6" : border}`,
                  background: ativa ? "#3b82f6" : "transparent",
                  color: ativa ? "#fff" : fg,
                  cursor: "pointer",
                  fontWeight: 600
                }}
              >
                {nome}
              </button>
            );
          })}
        </div>

        {/* Conteúdo */}
        <div
          style={{
            overflowY: "auto",
            padding: 16,
            display: "grid",
            gap: 12
          }}
        >
          {loading && <div>Carregando avisos…</div>}
          {erro && !loading && (
            <div style={{ color: "#b91c1c" }}>{erro}</div>
          )}
          {!loading && !erro && avisosDaAba.length === 0 && (
            <div style={{ opacity: 0.7 }}>Nenhum aviso para esta aba.</div>
          )}
          {!loading &&
            !erro &&
            avisosDaAba.map((a, i) => (
              <div
                key={`${a?.id || i}-${a?.titulo || "aviso"}`}
                style={{
                  border: `1px solid ${border}`,
                  borderRadius: 12,
                  padding: 12,
                  background: theme?.assistantBubble || "#f6f7fb"
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 6 }}>
                  {a?.titulo || "Aviso"}
                </div>
                {a?.cidade && (
                  <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
                    Cidade: {a.cidade}
                  </div>
                )}
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                  {a?.texto || "—"}
                </div>
                {a?.created_at && (
                  <div style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>
                    Publicado em: {new Date(a.created_at).toLocaleString()}
                  </div>
                )}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
