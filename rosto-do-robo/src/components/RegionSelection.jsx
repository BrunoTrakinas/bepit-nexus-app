import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

export default function RegionSelection() {
  const navigate = useNavigate();

  // Se já existir região salva, envia direto ao chat
  useEffect(() => {
    const raw = localStorage.getItem("bepit:region");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.slug && parsed?.name) {
        navigate("/chat", { replace: true });
      }
    } catch {
      // storage inválido -> ignora e permanece na seleção
    }
  }, [navigate]);

  function handleSelectRegion(slug, name) {
    const region = { slug, name };
    localStorage.setItem("bepit:region", JSON.stringify(region));
    navigate("/chat");
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#f6f7fb" }}>
      <div style={{ maxWidth: 720, width: "100%", background: "#fff", borderRadius: 16, padding: 24, boxShadow: "0 10px 30px rgba(0,0,0,0.08)" }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Escolha a região</h1>
        <p style={{ marginTop: 8, color: "#666" }}>
          Selecione a região para começarmos a te ajudar no planejamento.
        </p>

        <div style={{ marginTop: 24, display: "grid", gap: 12 }}>
          <button
            onClick={() => handleSelectRegion("regiao-dos-lagos", "Região dos Lagos")}
            style={{
              padding: "14px 16px",
              borderRadius: 12,
              border: "1px solid #e5e7eb",
              background: "#0ea5e9",
              color: "#fff",
              fontSize: 16,
              cursor: "pointer"
            }}
          >
            Região dos Lagos
          </button>

          {/* Adicione mais botões conforme novas regiões forem habilitadas */}
        </div>
      </div>
    </div>
  );
}
