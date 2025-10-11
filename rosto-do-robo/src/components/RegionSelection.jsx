import React from "react";
import { useNavigate } from "react-router-dom";

/**
 * RegionSelection.jsx
 * - Tela de escolha de região
 * - Centraliza LOGO (bepit-logo.png), "Bepit Nexus", subtítulo e lista de regiões
 * - Ao selecionar, salva { slug, name } em localStorage e redireciona para /chat
 */
export default function RegionSelection() {
  const navigate = useNavigate();

  // Ajuste/expanda aqui suas regiões reais
  const regioes = [
    { slug: "regiao-dos-lagos", name: "Região dos Lagos" },
    // { slug: "outra-regiao", name: "Outra Região" },
  ];

  function onSelectRegion(region) {
    try {
      localStorage.setItem("bepit_region", JSON.stringify(region));
    } catch {}
    navigate("/chat");
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-950 px-4">
      <div className="w-full max-w-lg text-center">
        {/* LOGO centralizada — 500% do tamanho base */}
        <div className="flex justify-center mb-4">
          <img
            src="/bepit-logo.png"
            alt="BEPIT"
            className="w-40 h-40 md:w-48 md:h-48 lg:w-52 lg:h-52"
            style={{ transform: "scale(5)", transformOrigin: "center" }}
          />
        </div>

        {/* Título principal */}
        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-slate-800 dark:text-slate-100 mb-2">
          Bepit Nexus
        </h1>

        {/* Subtítulo */}
        <p className="text-lg md:text-xl text-slate-600 dark:text-slate-300 mb-6">
          Escolha sua Região
        </p>

        {/* Lista de regiões (vertical, centralizada) */}
        <div className="space-y-3">
          {regioes.map((r) => (
            <button
              key={r.slug}
              onClick={() => onSelectRegion(r)}
              className="w-full py-4 rounded-2xl bg-white dark:bg-slate-800 shadow hover:shadow-md transition
                         border border-slate-200 dark:border-slate-700 text-lg font-medium
                         text-slate-800 dark:text-slate-100"
            >
              {r.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
