import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";

// Helper: tema claro/escuro persistente
function useTheme() {
  useEffect(() => {
    const saved = localStorage.getItem("bepit_theme") || "light";
    document.documentElement.classList.toggle("dark", saved === "dark");
  }, []);
  const toggle = () => {
    const next = document.documentElement.classList.contains("dark") ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    localStorage.setItem("bepit_theme", next);
  };
  return { toggle };
}

export default function RegionSelection() {
  const navigate = useNavigate();
  const { toggle } = useTheme();

  const handleSelect = (slug, nome) => {
    localStorage.setItem("bepit_region", JSON.stringify({ slug, nome }));
    navigate("/chat");
  };

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100 flex items-center justify-center p-4">
      <div className="w-full max-w-3xl">
        {/* Header com logo e tema */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <img
              src="/bepit-logo.png"
              alt="BEPIT"
              className="h-10 w-auto"
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />
            <h1 className="text-2xl font-semibold">BEPIT • Selecione a Região</h1>
          </div>
          <button
            onClick={toggle}
            className="px-3 py-2 rounded-xl bg-neutral-200 hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700 transition"
            title="Alternar tema claro/escuro"
          >
            🌓
          </button>
        </div>

        {/* Cards de regiões (adicione mais se tiver) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <button
            onClick={() => handleSelect("regiao-dos-lagos", "Região dos Lagos")}
            className="text-left p-5 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:shadow-md transition"
          >
            <div className="flex items-center gap-3">
              <img
                src="/bepit-logo.png"
                alt=""
                className="h-8 w-8"
                onError={(e) => { e.currentTarget.style.display = "none"; }}
              />
              <div>
                <div className="text-lg font-medium">Região dos Lagos</div>
                <div className="text-sm opacity-70">Cabo Frio, Arraial, Búzios…</div>
              </div>
            </div>
          </button>

          {/* Exemplo de região futura */}
          {/* <button onClick={() => handleSelect("outra-regiao", "Outra Região")} className="...">Outra Região</button> */}
        </div>

        <p className="mt-6 text-sm opacity-70">
          Dica: você pode trocar de tema no botão 🌓 e voltar aqui a qualquer momento.
        </p>
      </div>
    </div>
  );
}
